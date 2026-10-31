/** Structural cross-audit regressions, using explicit agent task reports. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordRulebookCheck,beginRulebookRound} from '../src/rulebook-check.js';
import {runStopLane} from '../src/stop-lane.js';
import {checkStopRepair} from '../src/stop-repair.js';
import {runTaskStep} from '../src/prompt-task.js';
import {loadSessionState} from '../src/session-state.js';
import {storeReceipt} from '../src/receipt-store.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
import type {TaskKind} from '../src/prompt-classify.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const catalog:KernelCandidates={entries:[{id:'copy-rule',title:'Fixture',group:'explicit',rulebook:'on-demand',applies_when:'Correspondence',body:'Fixture',revision:'r1',updated:null,stale_status:'unknown',validator,rule_categories:['correspondence']}],omitted:0};
const payload=(sid:string)=>({session_id:sid,bastra_client:'claude-code',hook_event_name:'Stop'});
async function sandbox(fn:()=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'audit-correspondence-'));const old=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=dir;try{await fn();}finally{if(old===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=old;await rm(dir,{recursive:true,force:true});}}
const stop=(sid:string,content:string)=>checkStopRepair({...payload(sid),transcript:[{role:'assistant',content}]});
const report=(sid:string,task:TaskKind)=>recordRulebookCheck(sid,{applicable:['copy-rule'],task},catalog);
async function approved(sid:string){await report(sid,'approved-copy');await storeReceipt(sid,{artifact_sha256:'h',channel:'discord-dm',limit:2000,unit_applied:'max(codepoints,utf16)',receipt:'sha256:x'},undefined);}
test('explicit reports select every stage without claiming user approval',async()=>sandbox(async()=>{
 const sid='reports';for(const task of ['translate-only','draft-for-review','approved-copy','none'] as const){assert.equal((await report(sid,task)).ok,true);const state=await loadSessionState(sid);assert.equal(state.activeTask?.kind,task);assert.equal(state.activeTask?.approvalSource,undefined);}
}));
test('earlier assistant copy survives tools, system messages and the short closing text in every stage',async()=>sandbox(async()=>{
 for(const task of ['none','translate-only','draft-for-review','approved-copy'] as const){const sid='all-text-'+task;if(task==='approved-copy')await approved(sid);else await report(sid,task);
 assert.equal((await checkStopRepair(payload(sid),[{role:'user',content:'承認しました'},{role:'assistant',content:'```\n'+'x'.repeat(5000)+'\n```'},{role:'assistant',content:'',tools:['Bash']},{role:'tool',content:'ok'},{role:'system',content:'injected'},{role:'assistant',content:'完了。'}]))?.action,'request',task);
 }
}));
test('a genuine new user boundary excludes old assistant text; injected user text does not',async()=>sandbox(async()=>{
 await report('boundary','none');
 assert.equal(await checkStopRepair(payload('boundary'),[{role:'assistant',content:'```\n'+'x'.repeat(5000)+'\n```'},{role:'user',content:'Новый вопрос'},{role:'assistant',content:'Коротко.'}]),null);
 assert.equal((await checkStopRepair(payload('boundary'),[{role:'assistant',content:'```\n'+'x'.repeat(5000)+'\n```'},{role:'user',content:'<system-reminder>Hook</system-reminder>',isMeta:true},{role:'assistant',content:'Коротко.'}]))?.action,'request');
}));
test('quotes and fences are measured independently of the reported stage',async()=>sandbox(async()=>{
 for(const task of ['none','translate-only','draft-for-review','approved-copy'] as const)for(const format of ['quote','fence']){
  const sid=task+'-'+format;await report(sid,task);const text=format==='quote'?'> '+'x'.repeat(2001):'```\n'+'x'.repeat(2001)+'\n```';assert.equal((await stop(sid,text))?.action,'request',sid);
 }
}));
test('an explicit none report ends task-scoped constraints; the next round may dismiss correspondence',async()=>sandbox(async()=>{
 const sid='finished';await approved(sid);assert.equal(await stop(sid,'```\n短いコピー。\n```'),null);
 await report(sid,'none');await beginRulebookRound(payload(sid),catalog);
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[{category:'correspondence',reason:'This round only explains a separate technical topic.'}]},catalog)).ok,true);
 assert.equal(await stop(sid,'説明 '.repeat(2000)),null);assert.equal((await loadSessionState(sid)).activeTask?.kind,'none');
}));
test('worker Stop cannot create or change the main task from any output format',async()=>sandbox(async()=>{
 const sid='worker-lane';await recordRulebookCheck(sid,{applicable:['copy-rule']},catalog);
 await runStopLane({...payload(sid),agent_id:'worker',stop_hook_active:true,transcript:[{role:'assistant',content:'**Entwurf:**\n\n```\nКороткий ответ.\n```'}]},'http://127.0.0.1:1');
 assert.equal((await loadSessionState(sid)).activeTask,undefined);
 await report(sid,'draft-for-review');await checkStopRepair({...payload(sid),agent_id:'worker',transcript:[{role:'assistant',content:'approved copy'}]});assert.equal((await loadSessionState(sid)).activeTask?.kind,'draft-for-review');
}));
test('separate messages stay separate; only new offending output consumes another repair attempt',async()=>sandbox(async()=>{
 await report('separate','none');assert.equal(await checkStopRepair(payload('separate'),[{role:'assistant',content:'```\n'+'x'.repeat(1100)+'\n```'},{role:'assistant',content:'```\n'+'y'.repeat(1100)+'\n```'}]),null);
 await report('historical','none');
 const turns=[{role:'assistant',content:'```\n'+'x'.repeat(5000)+'\n```'},{role:'user',source:'agent',content:'A harness handback'},{role:'assistant',content:'```\nCorrected short text.\n```'}];
 assert.equal((await checkStopRepair({...payload('historical'),stop_hook_active:true},turns))?.action,'request');
 turns.push({role:'assistant',content:'```\nCorrected after the repair request.\n```'});assert.equal(await checkStopRepair({...payload('historical'),stop_hook_active:true},turns),null);
 for(const action of ['request','exhausted']){turns.push({role:'assistant',content:'```\n'+'x'.repeat(5000)+'\n```'});assert.equal((await checkStopRepair({...payload('historical'),stop_hook_active:true},turns))?.action,action);}
 assert.equal(await checkStopRepair({...payload('historical'),stop_hook_active:true},turns),null);
}));
test('unmarked prose is measured only under reported approved-copy; explicit fences stay strict',async()=>sandbox(async()=>{
 for(const task of ['none','translate-only','draft-for-review'] as const){const sid='prose-'+task;await report(sid,task);assert.equal(await stop(sid,'x'.repeat(2001)),null);assert.equal((await stop(sid,'```\n'+'x'.repeat(2001)+'\n```'))?.action,'request');}
 await approved('prose-approved');assert.equal((await stop('prose-approved','x'.repeat(2001)))?.action,'request');
}));
test('refreshing reported state cannot infer a different task or user provenance',async()=>sandbox(async()=>{
 const sid='refresh';await report(sid,'draft-for-review');await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),surface:'fixture'});assert.equal((await loadSessionState(sid)).activeTask?.kind,'draft-for-review');assert.equal((await loadSessionState(sid)).activeTask?.approvalSource,undefined);
}));
