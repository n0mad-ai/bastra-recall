import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault,saveMemory} from '@bastra-recall/core';
import {serve} from './fixtures/rulebook-phase5/probe.js';
import {beginRulebookRound,recordRulebookCheck,recordRulebookLoad,RulebookCheckArgs} from '../src/rulebook-check.js';
import {cachedRulebookCatalog} from '../src/rulebook-catalog.js';
import {mutateSessionState,recordActiveConventions,loadSessionState} from '../src/session-state.js';
import {checkStopRepair} from '../src/stop-repair.js';
const validator={tool:'validate_artifact',channel:'fixture-copy',limit:12,unit:'utf16'} as const;
let root:string,vault:Vault,live:Awaited<ReturnType<typeof serve>>;
before(async()=>{root=await mkdtemp(join(tmpdir(),'dismissal-'));process.env.BASTRA_HOOK_STATE_DIR=join(root,'state');vault=new Vault(join(root,'vault'));await vault.init();
for(let i=0;i<45;i++){const m=await saveMemory(vault.root,{id:`rule-${i}`,title:'Invented correspondence',summary:'Invented scope',body:'Invented body',type:'workflow',scope:'all-projects',write_origin:'user-directed',rulebook:'on-demand',applies_when:'Invented output',rule_categories:['correspondence'],tags:['fixture'],topic_path:['fixture'],recall_when:['fixture'],...(i===0?{validator}:{})});await vault.reindexFile(m.file_path);}live=await serve(vault);});
after(async()=>{await live.close();await vault.stop();await rm(root,{recursive:true,force:true});});
const catalog=()=>cachedRulebookCatalog(vault,{project:null,active:[]});
const skip={id:'rule-0',reason:'This round explains an unrelated technical topic.'};
for(const kind of ['draft-for-review','approved-copy','loaded'] as const)test(`new round may dismiss inherited ${kind} validator; current-round loads stay protected`,async()=>{
 const sid=kind,c=await catalog();await beginRulebookRound({session_id:sid},c);
 if(kind==='loaded'){await mutateSessionState(sid,s=>{s.activeTask={id:sid,kind:'draft-for-review',since:Date.now(),generation:0};});await recordRulebookLoad(sid,'rule-0',null,{revision:'r1',validator,rulebookMetadata:{rulebook:'on-demand'}});}
 else await mutateSessionState(sid,s=>{s.activeTask={id:sid,kind,since:Date.now(),generation:0,...(kind==='approved-copy'?{approvalSource:'user-turn' as const}:{})};recordActiveConventions(s,[{id:'rule-0',revision:'r1',scope:'task',validator}]);});
 await beginRulebookRound({session_id:sid},c);
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[skip]},c)).ok,true);
 assert.equal(await checkStopRepair({session_id:sid,bastra_client:'claude-code'},[{role:'assistant',content:'```\n'+'x'.repeat(30)+'\n```'}]),null);
 await recordRulebookLoad(sid,'rule-0',null,{revision:'r1',validator});
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[skip]},c)).ok,false);
 assert.ok(JSON.parse((await loadSessionState(sid)).rulebookCheck!).unchecked>0);
 assert.equal((await checkStopRepair({session_id:sid,bastra_client:'claude-code'},[{role:'assistant',content:'```\n'+'x'.repeat(30)+'\n```'}]))?.action,'request');
});
test('category declaration covers every unprotected ID in one check',async()=>{
 const sid='category',c=await catalog();const note=await beginRulebookRound({session_id:sid},c);
 assert.match(note,/category/);
 const input=RulebookCheckArgs.parse({applicable:[],not_applicable:[{category:'correspondence',reason:'This technical round does not prepare correspondence.'}]});
 assert.equal((await recordRulebookCheck(sid,input,c)).ok,true);
 const next=await beginRulebookRound({session_id:sid},c);assert.ok(next.includes('rule-44'));assert.ok(next.includes('rule-0'));
});
test('category declaration never dismisses a loaded ID',async()=>{
 const sid='category-protected',c=await catalog();await beginRulebookRound({session_id:sid},c);await recordRulebookLoad(sid,'rule-0',null,{revision:'r1',validator});
 const input=RulebookCheckArgs.parse({applicable:[],not_applicable:[{category:'correspondence',reason:'This technical round does not prepare correspondence.'}]});
 assert.equal((await recordRulebookCheck(sid,input,c)).ok,true);
 const a=JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors[0];assert.equal(a.roundDismissed.length,44);assert.equal(a.roundApplied[0].id,'rule-0');
});

test('Codex respects a new-round dismissal but observes a current-round loaded validator',async()=>{
 const sid='codex-active',c=await catalog();await beginRulebookRound({session_id:sid,bastra_client:'codex',bastra_codex_version:'0.162.1'},c);
 await mutateSessionState(sid,s=>{s.activeTask={id:sid,kind:'approved-copy',approvalSource:'user-turn',since:Date.now(),generation:0};recordActiveConventions(s,[{id:'rule-0',revision:'r1',scope:'task',validator}]);});
 await beginRulebookRound({session_id:sid,bastra_client:'codex',bastra_codex_version:'0.162.1'},c);
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[skip]},c)).ok,true);
 assert.equal(await checkStopRepair({session_id:sid,bastra_client:'codex',bastra_codex_version:'0.162.1'},[{role:'assistant',content:'x'.repeat(30)}]),null);
 await recordRulebookLoad(sid,'rule-0',null,{revision:'r1',validator});
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[skip]},c)).ok,false);
 assert.equal((await checkStopRepair({session_id:sid,bastra_client:'codex',bastra_codex_version:'0.162.1'},[{role:'assistant',content:'x'.repeat(30)}]))?.action,'observed');
 const notice=await beginRulebookRound({session_id:sid},c);assert.match(notice,/dismissal ignored/);assert.ok(notice.includes('rule-0'));
});
