/** The retired GitHub query now uses the general C/HTTP delivery contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLaneDelivery} from '../src/lane-delivery.js';
import {runGateLane} from '../src/gate-lane.js';
import {recordRulebookCheck} from '../src/rulebook-check.js';
import {loadSessionState} from '../src/session-state.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
test('GitHub action through C: a disconnected HTTP response restores its denial attempt',{timeout:10000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'github-rulebook-delivery-')),prior=process.env.BASTRA_HOOK_STATE_DIR;
 process.env.BASTRA_HOOK_STATE_DIR=root;
 const catalog:KernelCandidates={entries:[{id:'issue-rule',title:'Issue convention',rulebook:'on-demand',group:'explicit',applies_when:'When writing issues',body:'Invented rule',revision:'r1',updated:null,stale_status:'unknown'}],omitted:0};
 let produced!:()=>void,release!:()=>void,closed!:()=>void;
 const gone=new Promise<void>(r=>closed=r),ready=new Promise<void>(r=>produced=r),hold=new Promise<void>(r=>release=r);let delay=true;
 const server=createServer((q,r)=>{
  if(delay)r.once('close',closed);
  const delivery=createLaneDelivery(r);
  void delivery.run(async()=>{let raw='';for await(const c of q)raw+=c;
   const out=await runGateLane(JSON.parse(raw),{reflexPool:()=>[],kernel:async()=>catalog});
   if(delay){produced();await hold;}delivery.answer(out);
  });
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{release?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));if(prior===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=prior;await rm(root,{recursive:true,force:true});});
 const port=(server.address() as {port:number}).port,sid='issue-http';
 const payload={session_id:sid,bastra_client:'claude-code',hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'gh issue create --title fixture'}};
 const interrupted=request({host:'127.0.0.1',port,path:'/hook/gate',method:'POST'});interrupted.on('error',()=>{});interrupted.end(JSON.stringify(payload));
 await ready;interrupted.destroy();await gone;release();delay=false;
 for(let i=0;i<100;i++){if(JSON.parse((await loadSessionState(sid)).rulebookCheck??'{}').actors?.[0]?.denies===0)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors[0].denies,0);
 const get=async()=>{const r=await fetch(`http://127.0.0.1:${port}/hook/gate`,{method:'POST',body:JSON.stringify(payload)});return r.json() as Promise<any>;};
 assert.equal((await get()).hookSpecificOutput?.permissionDecision,'deny');
 await recordRulebookCheck(sid,{applicable:['issue-rule']},catalog);
 assert.notEqual((await get()).hookSpecificOutput?.permissionDecision,'deny');
});
