import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runPromptLane} from '../src/prompt-lane.js';
import {beginRulebookRound, recordRulebookCheck, recordRulebookLoad} from '../src/rulebook-check.js';
import {loadSessionState} from '../src/session-state.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';

const catalog:KernelCandidates={entries:[{id:'fixture-rule',title:'Fixture',group:'explicit',revision:'r1',updated:null,stale_status:'unknown',body:'Fixture',rulebook:'on-demand',applies_when:'Fixture'}],omitted:0};

test('#1376 injected prompt notifications preserve the checked round and loaded evidence', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'prompt-rulebook-origin-'));
 const previous=process.env.BASTRA_HOOK_STATE_DIR;
 process.env.BASTRA_HOOK_STATE_DIR=dir;
 try{
  const session_id='fixture-origin';
  await beginRulebookRound({session_id,bastra_client:'claude-code'},catalog);
  await recordRulebookCheck(session_id,{applicable:['fixture-rule']},catalog);
  await recordRulebookLoad(session_id,'fixture-rule',null,{revision:'r1',rulebookMetadata:{rulebook:'on-demand'}});
  const before=(await loadSessionState(session_id)).rulebookCheck;
  for(const prompt of [
   '<task-notification id="fixture">Agent finished</task-notification>',
   '<teammate-message teammate_id="fixture">Done</teammate-message>',
   '<environment_context>Workspace context</environment_context>',
   '<system-reminder>Background completion</system-reminder>',
  ]){
   let catalogs=0;
   const out=await runPromptLane({session_id,hook_event_name:'UserPromptSubmit',prompt},null,'http://127.0.0.1:1',undefined,undefined,{kernel:async()=>{catalogs++;return catalog;}});
   assert.equal((await loadSessionState(session_id)).rulebookCheck,before,'notification must not expire the owner round check or evidence');
   assert.equal(catalogs,0,'injected prompts do not start a rulebook catalog lookup');
   assert.equal(out,'{}','no additional rulebook work is presented');
  }
  const round=JSON.parse(before!).round;
  await runPromptLane({session_id,hook_event_name:'UserPromptSubmit',prompt:'/help'},null,'http://127.0.0.1:1',undefined,undefined,{kernel:async()=>catalog});
  assert.equal(JSON.parse((await loadSessionState(session_id)).rulebookCheck!).round,round+1,'a real owner prompt still starts a round');
  await runPromptLane({session_id,hook_event_name:'UserPromptSubmit',prompt:''},null,'http://127.0.0.1:1',undefined,undefined,{kernel:async()=>catalog});
  assert.equal(JSON.parse((await loadSessionState(session_id)).rulebookCheck!).round,round+2,'an image-only owner prompt retains the existing round reset');
 }finally{
  if(previous===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=previous;
  await rm(dir,{recursive:true,force:true});
 }
});
