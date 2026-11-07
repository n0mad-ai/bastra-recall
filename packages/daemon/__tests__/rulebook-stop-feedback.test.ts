import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runStopLane} from '../src/stop-lane.js';
import {recordRulebookCheck} from '../src/rulebook-check.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const catalog:KernelCandidates={entries:[{id:'invented-rule',title:'Invented',group:'explicit',revision:'r1',updated:null,stale_status:'unknown',body:'Invented',rulebook:'on-demand',applies_when:'Invented'}],omitted:0};
test('#1370 Claude Stop forwards non-error rulebook feedback once; Codex retains block',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rulebook-stop-feedback-'));
 const prior=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=dir;
 try{
  for(const client of ['claude-code','codex']){
   const p={session_id:'feedback-'+client,hook_event_name:'Stop',bastra_client:client,bastra_codex_version:'0.162.1',transcript:[]};
   const first=JSON.parse(await runStopLane(p,'http://127.0.0.1:1',{kernel:async()=>catalog}));
   if(client==='claude-code'){
    assert.equal(first.decision,undefined,'ordinary rulebook guidance must not produce a hook error');
    assert.equal(first.hookSpecificOutput?.hookEventName,'Stop');
    assert.match(first.hookSpecificOutput?.additionalContext,/rulebook_check/);
   }else{assert.equal(first.decision,'block');assert.match(first.reason,/rulebook_check/);}
   const continued=JSON.parse(await runStopLane({...p,stop_hook_active:true},'http://127.0.0.1:1',{kernel:async()=>catalog}));
   assert.doesNotMatch(JSON.stringify(continued),/rulebook_check/,'continuation remains bounded');
   await recordRulebookCheck(p.session_id,{applicable:[]},catalog);
   const checked=JSON.parse(await runStopLane(p,'http://127.0.0.1:1',{kernel:async()=>catalog}));
   assert.doesNotMatch(JSON.stringify(checked),/rulebook_check/,'a receipt still discharges the request');
  }
 }finally{if(prior===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=prior;await rm(dir,{recursive:true,force:true});}
});
