import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runPromptLane} from '../src/prompt-lane.js';
import {formatReflexBlock} from '../src/prompt-format.js';
import type {KernelEntry} from '../src/rulebook-catalog.js';
import {loadSessionState} from '../src/session-state.js';
test('round notice shares the 10k budget; omitted reflexes never book must-load',async()=>{
 const root=await mkdtemp(join(tmpdir(),'prompt-budget-'));process.env.BASTRA_HOOK_STATE_DIR=join(root,'state');process.env.BASTRA_PROMPT_HOOK_MODE='all';
 const hits=Array.from({length:28},(_,i)=>({id:`huge-reflex-${i}`,title:'Invented',summary:'a'.repeat(220),type:'workflow',scope:'all-projects',matched_phrase:'fixture'}));
 const entries:KernelEntry[]=Array.from({length:45},(_,i)=>({id:`correspondence-rule-${i}`,title:"Invented",group:"explicit",revision:null,updated:null,stale_status:"unknown",body:"",rulebook:"on-demand",rule_categories:["correspondence"]}));
 assert.ok(formatReflexBlock(hits,null).length<10000);
 const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({hits:req.url==='/hook/reflex'?hits:[]}));});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const sid='shared-budget',port=(server.address() as {port:number}).port;
  const out=JSON.parse(await runPromptLane({session_id:sid,hook_event_name:'UserPromptSubmit',prompt:'Bitte prüfe den erfundenen Fehler im Code.'},null,`http://127.0.0.1:${port}`,undefined,()=>['fixture'],{kernel:async()=>({entries,omitted:0})}));
  const ctx=out.hookSpecificOutput?.additionalContext??'';assert.ok(ctx.length<=10000);assert.match(ctx,/category/);
  assert.ok(!ctx.includes('huge-reflex-0'));assert.equal((await loadSessionState(sid)).pendingMustLoad?.length??0,0);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
