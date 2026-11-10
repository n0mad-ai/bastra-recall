import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginRulebookRound, resetRulebookContext } from '../src/rulebook-check.js';
import { withExecutedVaultWrite, currentExecutedVaultWrites } from '../src/executed-vault-write.js';
import { dropSuggestionsAfterExecutedSave, evaluateHeuristics, type SaveSuggestion } from '../src/stop-heuristics.js';
import { Vault, SearchIndex } from '@bastra-recall/core';
import { Telemetry } from '../src/telemetry.js';
import { runStopLane } from '../src/stop-lane.js';
import { normalizeTurns } from '../src/stop-transcript.js';
import { createServer } from 'node:http';
import { dispatchApiSurface } from '../src/http-api-surface.js';
import { readAppRecord } from '../src/app-record-store.js';

test('#1376 executed writes bind session, actor, context, round and completion order', async t => {
 const root=await mkdtemp(join(tmpdir(),'bastra-executed-write-'));
 const old=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=root;
 t.after(async()=>{if(old===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=old;await rm(root,{recursive:true,force:true});});
 const p={session_id:'invented-executed-write',bastra_client:'codex',agent_id:'worker'};
 await beginRulebookRound(p,{entries:[],unconfirmedLegacy:0,catalogHash:'fixture'} as never);
 const ctx={ccSessionId:p.session_id,agentId:p.agent_id};
 const decision={heuristic:'architecture-decision',title:'fixture',type:'decision',body:'fixture'} as SaveSuggestion;
 const before=Date.now()-100;
 await withExecutedVaultWrite('save_memory',ctx,async()=>({id:'saved',file_path:'/fixture/saved.md',created:true}));
 const writes=await currentExecutedVaultWrites(p);assert.equal(writes.length,1);
 assert.equal(writes[0].id,'saved');assert.ok(writes[0].sequence>0);
 assert.deepEqual(dropSuggestionsAfterExecutedSave([{role:'user',content:'2',at:before}],[decision],writes),[]);
 assert.deepEqual(dropSuggestionsAfterExecutedSave([{role:'user',content:'2',at:writes[0].at+1}],[decision],writes),[decision]);
 assert.deepEqual(dropSuggestionsAfterExecutedSave([{role:'user',content:'2'}],[decision],writes),[decision]);
 assert.deepEqual(await currentExecutedVaultWrites({...p,agent_id:'other'}),[]);
 assert.deepEqual(await currentExecutedVaultWrites({...p,session_id:'other'}),[]);
 await withExecutedVaultWrite('edit_memory',ctx,async()=>({id:'held',hold:true}));
 await assert.rejects(withExecutedVaultWrite('save_memory',ctx,async()=>{throw Error('failed');}));
 await withExecutedVaultWrite('functions.exec',ctx,async()=>({id:'fake',file_path:'/fake',created:true}));
 await withExecutedVaultWrite('save_memory',{ccSessionId:p.session_id},async()=>({id:'unattributed',file_path:'/fake',created:true}));
 assert.equal((await currentExecutedVaultWrites(p)).length,1);
 await withExecutedVaultWrite('save_memory',ctx,async()=>({id:'transport-wins',file_path:'/fixture',created:true}),{session_id:'foreign-body-session',agent_id:'foreign-body-actor'});
 assert.equal((await currentExecutedVaultWrites(p)).at(-1)?.id,'transport-wins');
 assert.deepEqual(await currentExecutedVaultWrites({...p,session_id:'foreign-body-session',agent_id:'foreign-body-actor'}),[]);
 await beginRulebookRound(p,{entries:[],unconfirmedLegacy:0,catalogHash:'fixture'} as never);
 assert.deepEqual(await currentExecutedVaultWrites(p),[]);
 await withExecutedVaultWrite('edit_memory',ctx,async()=>({id:'edited',file_path:'/fixture',operations:['append']}));
 assert.equal((await currentExecutedVaultWrites(p)).length,1);
 await resetRulebookContext(p.session_id);assert.deepEqual(await currentExecutedVaultWrites(p),[]);
 // An in-flight old execution must not be booked in a new context.
 await withExecutedVaultWrite('save_memory',ctx,async()=>{await resetRulebookContext(p.session_id);return {id:'late',file_path:'/fixture',created:true};});
 assert.deepEqual(await currentExecutedVaultWrites(p),[]);
 const broken=join(root,'not-a-directory');await writeFile(broken,'fixture');
 const result={id:'successful-despite-ledger-failure',file_path:'/fixture',created:true};
 try{
  assert.equal(await withExecutedVaultWrite('save_memory',ctx,async()=>{process.env.BASTRA_HOOK_STATE_DIR=broken;return result;}),result,'failed receipt booking preserves actual success');
  assert.equal(await withExecutedVaultWrite('save_memory',ctx,async()=>result),result,'unreadable state does not prevent execution');
 }finally{process.env.BASTRA_HOOK_STATE_DIR=root;}
});

test('#1376 productive dispatcher executes nested saves; source strings and failed writes do not count',async t=>{
 const root=await mkdtemp(join(tmpdir(),'bastra-executed-dispatch-'));
 const names=['BASTRA_HOOK_STATE_DIR','BASTRA_PENDING_SUGGESTIONS_PATH','BASTRA_LOG_PATH'];
 const old=names.map(n=>process.env[n]);names.forEach((n,i)=>process.env[n]=join(root,String(i)));
 const vault=new Vault(join(root,'vault'));await vault.init();const search=new SearchIndex(vault);search.start();
 t.after(async()=>{search.stop();await vault.stop();names.forEach((n,i)=>{if(old[i]===undefined)delete process.env[n];else process.env[n]=old[i];});await rm(root,{recursive:true,force:true});});
 const p={session_id:'invented-http-execution',agent_id:'worker',bastra_client:'codex'};
 await beginRulebookRound(p,{entries:[],unconfirmedLegacy:0,catalogHash:'fixture'} as never);
 const ctx={toolDeps:{vault,search,vaultPath:join(root,'vault'),telemetry:new Telemetry()},documentWriteEnabled:false};
 const server=createServer((req,res)=>{dispatchApiSurface(req,res,req.method??'',req.url??'',{...ctx,vault,server:{apiToken:'invented-test-token',corsAllow:[],loopbackSkip:false} as never});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const api=async(tool:string,body:Record<string,unknown>)=>{
  const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1/${tool}`,{method:'POST',headers:{authorization:'Bearer invented-test-token','content-type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;
 };
 const timestamp=new Date(Date.now()-1000).toISOString();
 const transcript=[{timestamp,type:'response_item',payload:{type:'message',role:'assistant',content:'Which architecture?\n1. Polling\n2. Queue'}},{timestamp,type:'response_item',payload:{type:'message',role:'user',content:'2'}},{timestamp,type:'response_item',payload:{type:'custom_tool_call',name:'exec',input:'const neverRun = "tools.save_memory({id: \\\"fake\\\"})";'}}];
 const normalized=normalizeTurns(transcript);assert.equal(normalized.find(t=>t.role==='user')?.at,Date.parse(timestamp));
 const stop=()=>runStopLane({...p,hook_event_name:'Stop',transcript},'http://127.0.0.1:1');
 assert.deepEqual(await currentExecutedVaultWrites(p),[]);
 const suggestions=evaluateHeuristics(normalized);assert.equal(suggestions.length,1);
 assert.deepEqual(dropSuggestionsAfterExecutedSave(normalized,suggestions,await currentExecutedVaultWrites(p)),suggestions,'nonexecuted source string cannot clear a suggestion');
 await assert.rejects(api('save_memory',{session_id:p.session_id,agent_id:p.agent_id,title:'invalid'}));
 assert.deepEqual(await currentExecutedVaultWrites(p),[]);
 const saved=await api('save_memory',{session_id:p.session_id,agent_id:p.agent_id,id:'invented-nested',title:'Erfundene Architektur',summary:'Erfundene Entscheidung für den Regressionstest',body:'Für das erfundene Projekt gilt die Warteschlange.',type:'decision',scope:'fixture',topic_path:['fixture'],tags:['fixture'],recall_when:['Erfundene Architektur prüfen']}) as {id:string};
 assert.equal(saved.id,'invented-nested');assert.equal((await currentExecutedVaultWrites(p)).length,1);
 assert.equal((vault.get(saved.id)!.fm as unknown as Record<string,unknown>).session_id,undefined);
 assert.equal((vault.get(saved.id)!.fm as unknown as Record<string,unknown>).agent_id,undefined);
 assert.equal(await stop(),'{}');
 assert.throws(()=>readAppRecord('pending-suggestions',process.env.BASTRA_PENDING_SUGGESTIONS_PATH!),{code:'ENOENT'});
 await api('edit_memory',{session_id:p.session_id,agent_id:p.agent_id,id:saved.id,append:'Erfundener Zusatz.'});
 assert.equal((await currentExecutedVaultWrites(p)).length,2);
 assert.equal(await stop(),'{}');
 assert.deepEqual(await currentExecutedVaultWrites({...p,agent_id:'other'}),[]);
});

test('#1376 current custom exec output timestamps cannot turn aggregate output into a save',()=>{
 const after=5000;
 const rows=normalizeTurns([
  {timestamp:new Date(1000).toISOString(),type:'response_item',payload:{type:'message',role:'assistant',content:'Which?\n1. A\n2. B'}},
  {timestamp:new Date(after).toISOString(),type:'response_item',payload:{type:'message',role:'user',content:'2'}},
  {timestamp:new Date(after+1).toISOString(),type:'response_item',payload:{type:'custom_tool_call',call_id:'opaque',name:'exec',input:'if(false) await tools.save_memory({id:"not-run"});'}},
  {timestamp:new Date(after+2).toISOString(),type:'response_item',payload:{type:'custom_tool_call_output',call_id:'opaque',output:JSON.stringify({id:'not-run',file_path:'/fake'})}},
 ]);
 const suggestions=evaluateHeuristics(rows);assert.equal(suggestions.length,1);
 assert.equal(rows.at(-1)?.at,after+2);
 assert.deepEqual(dropSuggestionsAfterExecutedSave(rows,suggestions,[{at:after-1}]),suggestions,'new choice after completed save remains work');
 assert.deepEqual(dropSuggestionsAfterExecutedSave(rows,suggestions,[{at:after}]),suggestions,'equal time does not establish execution order');
 assert.deepEqual(dropSuggestionsAfterExecutedSave(rows,suggestions,[{at:after+1}]),[],'actual receipt after choice clears covered work');
});
