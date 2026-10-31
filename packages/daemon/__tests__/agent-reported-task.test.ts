import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordRulebookCheck,beginRulebookRound,rulebookBoundary} from '../src/rulebook-check.js';
import {loadSessionState,mutateSessionState} from '../src/session-state.js';
import {checkStopRepair} from '../src/stop-repair.js';
import {decodeActiveTask} from '../src/task-state.js';
import {formatActiveConventionsBlock} from '../src/prompt-format.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const catalog:KernelCandidates={entries:[{id:'copy-rule',title:'Rule',group:'explicit',rulebook:'on-demand',body:'Synthetic',applies_when:'Synthetic',revision:'r1',updated:null,stale_status:'unknown',validator,rule_categories:['correspondence']}],omitted:0};
async function isolated(fn:()=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'reported-task-'));const prior=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=dir;try{await fn();}finally{if(prior===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=prior;await rm(dir,{recursive:true,force:true});}}
test('all four agent reports may change stage, without claiming user approval',async()=>isolated(async()=>{
 const sid='stages';
 for(const task of ['translate-only','draft-for-review','approved-copy','draft-for-review','none'] as const){
  const out=await recordRulebookCheck(sid,{applicable:['copy-rule'],task},catalog);assert.equal(out.ok,true,task);
  const state=await loadSessionState(sid);assert.equal(state.activeTask?.kind,task);assert.equal(state.activeTask?.approvalSource,undefined);
 }
}));
test('legacy session task remains readable without draft presentation or inferred approval text',()=>{
 const task=decodeActiveTask({id:'legacy',kind:'approved-copy',since:1,generation:2,draftPresented:true,approvalSource:'user-turn',validatorChannel:'email'})!;
 assert.equal(task.kind,'approved-copy');assert.equal(task.generation,2);assert.equal('draftPresented' in task,false);
 const block=formatActiveConventionsBlock({task:task.kind,approvalSource:task.approvalSource,generation:2,conventions:[],changed:[],unclear:false})!;
 assert.doesNotMatch(block,/the user approved/);assert.match(block,/agent reports|agent-reported/);
});
test('each new round needs its own rule decision; ending a task releases only older task binding',async()=>isolated(async()=>{
 const sid='round';const p={session_id:sid,bastra_client:'claude-code',hook_event_name:'Stop'};
 await beginRulebookRound(p,catalog);await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'approved-copy'},catalog);
 await beginRulebookRound(p,catalog);
 assert.match((await rulebookBoundary(p,catalog,'stop'))??'',/decision.*block/);
 const out=await recordRulebookCheck(sid,{applicable:[],task:'none',not_applicable:[{id:'copy-rule',reason:'This round contains no copy artifact'}]},catalog);
 assert.equal(out.ok,true);assert.equal((await loadSessionState(sid)).activeTask?.kind,'none');
 assert.equal(await rulebookBoundary(p,catalog,'stop'),'{}');
 await beginRulebookRound(p,catalog);await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'approved-copy'},catalog);
 const invalid=await recordRulebookCheck(sid,{applicable:[],task:'none',not_applicable:[{id:'copy-rule',reason:'Try to dismiss a current declaration'}]},catalog);
 assert.equal(invalid.ok,false,'current-round obligations remain protected independently of stage');
}));
test('reports clear text-inferred legacy channel; workers cannot change the main stage',async()=>isolated(async()=>{
 const sid='legacy-channel';await mutateSessionState(sid,s=>{s.activeTask={id:'legacy',kind:'draft-for-review',since:1,generation:0,validatorChannel:'email'};s.userValidatorChannel='email';});
 await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'draft-for-review'},catalog);
 const state=await loadSessionState(sid);assert.equal(state.userValidatorChannel,undefined);assert.equal(state.activeTask?.validatorChannel,undefined);
 const out=await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'approved-copy',agent_id:'worker'},catalog);
 assert.equal(out.ok,false);assert.equal((await loadSessionState(sid)).activeTask?.kind,'draft-for-review');
}));

test('a worker reports its own validators but never inherits the main copy stage',async()=>isolated(async()=>{
 const sid='actor-stage';await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'approved-copy'},catalog);
 await recordRulebookCheck(sid,{applicable:['copy-rule'],agent_id:'worker'},catalog);
 const p={session_id:sid,bastra_client:'claude-code',agent_id:'worker'};
 assert.equal(await checkStopRepair(p,[{role:'assistant',content:'x'.repeat(5000)}]),null);
 assert.equal((await checkStopRepair(p,[{role:'assistant',content:'```\n'+'x'.repeat(2001)+'\n```'}]))?.action,'request');
}));
