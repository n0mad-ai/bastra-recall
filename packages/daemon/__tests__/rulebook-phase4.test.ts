/** Phase 4 parity: deterministic delivery/boundaries, explicit model judgement.
 * These fixtures simulate semantic reports; they do not prove LLM judgement. */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGateLane} from '../src/gate-lane.js';
import {runPromptLane} from '../src/prompt-lane.js';
import {runStopLane} from '../src/stop-lane.js';
import {recordRulebookCheck, RulebookCheckArgs} from '../src/rulebook-check.js';
import {loadSessionState} from '../src/session-state.js';
import {renderRuleKernel} from '../src/rule-kernel.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const validator={tool:'validate_artifact',channel:'discord',limit:2000,unit:'codepoints'} as const;
const catalog:KernelCandidates={entries:[{id:'messages',title:'Message rule',group:'explicit',rulebook:'on-demand',applies_when:'When incoming correspondence is pasted or a reply is prepared',body:'Translate, draft for review, approve copy; validate before delivery.',revision:'r1',updated:null,stale_status:'unknown',validator}, {id:'issues',title:'Issue rule',group:'explicit',rulebook:'on-demand',applies_when:'When changing GitHub issues or pull requests',body:'Use the agreed labels and milestone.',revision:'r2',updated:null,stale_status:'unknown'}],omitted:0};
const deps={reflexPool:()=>[],kernel:async()=>catalog};
let dir:string;const previous=process.env.BASTRA_HOOK_STATE_DIR;
before(async()=>{dir=await mkdtemp(join(tmpdir(),'phase4-'));process.env.BASTRA_HOOK_STATE_DIR=dir;process.env.BASTRA_TELEMETRY='off';});
after(async()=>{if(previous===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=previous;await rm(dir,{recursive:true,force:true});});
const p=(sid:string)=>({session_id:sid,bastra_client:'claude-code',hook_event_name:'PreToolUse'});
const report=async(sid:string,task:string,ids=['messages'])=>recordRulebookCheck(sid,RulebookCheckArgs.parse({applicable:ids,task}),catalog);
test('A/B describes both old lanes independently of wording',()=>{const text=renderRuleKernel(catalog,{trigger:"startup"});assert.match(JSON.stringify(text),/messages/);assert.match(JSON.stringify(text),/issues/);});
for(const [lang,incoming] of Object.entries({de:'Kannst du morgen kommen?',en:'Could you come tomorrow?',ja:'明日来られますか。',ru:'Вы можете прийти завтра?',es:'¿Puedes venir mañana?'}))test(`parity ${lang}: pasted text, review and GitHub writes`,async()=>{
 const sid=`p4-${lang}`,common=p(sid);
 const prompt=JSON.parse(await runPromptLane({...common,hook_event_name:'UserPromptSubmit',prompt:incoming},null,'http://127.0.0.1:1',undefined,()=>[],{kernel:deps.kernel}));
 assert.match(prompt.hookSpecificOutput.additionalContext,/rulebook_check/);
 const stop={...common,hook_event_name:'Stop',transcript:[{role:'user',content:incoming},{role:'assistant',content:'Review text'}]};
 assert.equal(JSON.parse(await runStopLane(stop,'http://127.0.0.1:1',{kernel:deps.kernel})).decision,'block');
 await report(sid,'draft-for-review');
 assert.notEqual(JSON.parse(await runStopLane(stop,'http://127.0.0.1:1',{kernel:deps.kernel})).decision,'block');
 let state=await loadSessionState(sid);assert.equal(state.activeTask?.kind,'draft-for-review');assert.deepEqual(state.activeConventions?.[0]?.validator,validator);
 await report(sid,'approved-copy');state=await loadSessionState(sid);assert.equal(state.activeTask?.kind,'approved-copy');
 for(const command of ['gh issue create --title fixture','gh pr edit 42 --title fixture']){
  const action={...p(sid+command),tool_name:'Bash',tool_input:{command}};
  assert.equal(JSON.parse(await runGateLane(action,deps)).hookSpecificOutput.permissionDecision,'deny');
  await recordRulebookCheck(action.session_id,{applicable:['issues']},catalog);
  assert.notEqual(JSON.parse(await runGateLane(action,deps)).hookSpecificOutput?.permissionDecision,'deny');
 }
});
test('task report clears only task rules, expires receipts and cannot leak from a worker',async()=>{
 await report('end','draft-for-review');await report('end','none',[]);
 assert.equal((await loadSessionState('end')).activeTask?.kind,'none');assert.equal((await loadSessionState('end')).activeConventions,undefined);
 const worker=await recordRulebookCheck('worker',RulebookCheckArgs.parse({applicable:['messages'],task:'draft-for-review',agent_id:'child'}),catalog);
 assert.equal(worker.ok,false);assert.equal((await loadSessionState('worker')).activeTask,undefined);
});
test('old convention wordlists and GitHub query are retired',async()=>{
 const lexicon=await readFile(new URL('../src/lexicon.ts',import.meta.url),'utf8');
 assert.doesNotMatch(lexicon,/ASSISTANT_REVIEW_CUES|DEFAULT_CORRESPONDENCE_CUES_BY_LANGUAGE|TASK_TECHNICAL_OBJECTS_BY_LANGUAGE/);
 const bash=await readFile(new URL('../src/bash-pre-lane.ts',import.meta.url),'utf8');assert.doesNotMatch(bash,/githubConventionGate/);
});
test('same task report retains receipts; changed rule metadata or task removes them',async()=>{
 const {storeReceipt}=await import('../src/receipt-store.js');
 const {validateCopyBlocks}=await import('@bastra-recall/core');
 const sid='receipt-parity';await report(sid,'approved-copy');
 const result=validateCopyBlocks({text:'Invented text',channel:'discord-dm',normalize:'none'});
 assert.ok(result.receipt);assert.equal(await storeReceipt(sid,{...result,receipt:result.receipt!},undefined),'stored');
 await report(sid,'approved-copy');assert.equal((await loadSessionState(sid)).receipts?.length,1);
 const changed={...catalog,entries:catalog.entries.map(e=>({...e,revision:'changed'}))};
 await recordRulebookCheck(sid,{applicable:['messages'],task:'approved-copy'},changed);
 assert.equal((await loadSessionState(sid)).receipts,undefined);
 const before=(await loadSessionState(sid)).activeTask;
 await recordRulebookCheck(sid,{applicable:[]},catalog);
 assert.deepEqual((await loadSessionState(sid)).activeTask,before,'omitting task preserves its state');
});
test('known worker transport cannot mutate main task by omitting its argument ID',async()=>{
 const {parseMemory}=await import('@bastra-recall/core');
 const {dispatchApi}=await import('../src/http-api-routes.js');
 const memory=parseMemory('---\nid: transport-rule\ntitle: Transport rule\nsummary: Fixture\ntype: workflow\nscope: all-projects\nwrite_origin: user-directed\ntags: []\ntopic_path: [fixture]\nrecall_when: [fixture]\n---\nFixture body','',0);
 const vault={list:()=>[memory],get:()=>memory,on:()=>()=>{}};
 const deps={toolDeps:{vault} as unknown as import('../src/tool-deps.js').ToolDeps,documentWriteEnabled:false,ccSessionId:'known-worker',agentId:'worker'};
 const out=await dispatchApi('rulebook_check',{applicable:['transport-rule'],task:'draft-for-review'},deps) as {ok:boolean};
 assert.equal(out.ok,false);assert.equal((await loadSessionState('known-worker')).activeTask,undefined);
});
test('task activation never silently drops rules at the existing session capacity',async()=>{
 const {mutateSessionState}=await import('../src/session-state.js');
 await mutateSessionState('capacity',s=>{s.activeConventions=Array.from({length:20},(_,i)=>({id:`standing-${i}`,revision:'s1',setAt:1}));});
 const result=await recordRulebookCheck('capacity',{applicable:['messages'],task:'draft-for-review'},catalog);
 assert.equal(result.ok,false);assert.equal((await loadSessionState('capacity')).activeTask,undefined);
 assert.equal((await loadSessionState('capacity')).activeConventions?.length,20);
});
