import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runStopLane} from '../src/stop-lane.js';
import {recordRulebookCheck,recordRulebookLoad} from '../src/rulebook-check.js';
import {loadSessionState,mutateSessionState} from '../src/session-state.js';
import {runTaskStep} from '../src/prompt-task.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const strict={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const lax={...strict,channel:'email',limit:10000};
const catalog:KernelCandidates={entries:[['strict',strict],['lax',lax]].map(([id,validator])=>({id:id as string,title:'Invented rule',group:'explicit' as const,rulebook:'on-demand' as const,applies_when:'When drafting invented replies',body:'Fixture',revision:'r1',updated:null,stale_status:'unknown' as const,validator:validator as typeof strict})),omitted:0};
let root:string;const previous=process.env.BASTRA_HOOK_STATE_DIR;
before(async()=>{root=await mkdtemp(join(tmpdir(),'phase5-security-'));process.env.BASTRA_HOOK_STATE_DIR=root;});
after(async()=>{if(previous===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=previous;await rm(root,{recursive:true,force:true});});
const stop=async(sid:string,text='x'.repeat(3200))=>{const out=await runStopLane({session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:text}]},'http://127.0.0.1:1');return out.includes('<copy-repair')?{action:'request'}:null;};
async function receipt(sid:string,channel='email',limit=10000){await mutateSessionState(sid,s=>{s.receipts=[{taskId:s.activeTask!.id,generation:s.activeTask!.generation,hash:'a',receipt:'sha256:a',channel,limit,unit:'max(codepoints,utf16)',at:1}];});}
async function legacy(sid:string){
 await recordRulebookLoad(sid,'strict',null,{revision:'r1',validator:strict});
 await recordRulebookLoad(sid,'lax',null,{revision:'r1',validator:lax});
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 await receipt(sid);
}
test('security: all loaded constraints remain in force despite a later lax load',async()=>{
 await legacy('unbound');await recordRulebookLoad('unbound','late',null,{revision:'r2',validator:{...lax,limit:20000}});
 assert.equal((await stop('unbound'))?.action,'request');
});
test('security: a late strict load tightens an already running lax model task',async()=>{
 const sid='late-strict';await recordRulebookCheck(sid,{applicable:['lax'],task:'draft-for-review'},catalog);
 await recordRulebookLoad(sid,'strict',null,{revision:'r1',validator:strict});await receipt(sid);
 assert.equal((await stop(sid))?.action,'request');
});
test('security: model order cannot choose the lax rule or set a user channel',async()=>{
 for(const ids of [['lax','strict'],['strict','lax']]){
  const sid='order-'+ids.join('-');assert.equal((await recordRulebookCheck(sid,{applicable:ids,task:'draft-for-review'},catalog)).ok,true);
  await receipt(sid);assert.equal((await stop(sid))?.action,'request');
  assert.equal((await loadSessionState(sid)).userValidatorChannel,undefined);
 }
});
test('security: trusted current same-ID source can raise the effective limit',async()=>{
 const sid='same-id';await recordRulebookCheck(sid,{applicable:['strict'],task:'draft-for-review'},catalog);
 await recordRulebookLoad(sid,'strict',null,{revision:'r2',validator:{...strict,limit:10000}});
 await receipt(sid,'discord-dm');assert.equal(await stop(sid),null);
});
test('security: repeated model reports and source changes can only tighten',async()=>{
 const sid='monotonic';await recordRulebookCheck(sid,{applicable:['strict'],task:'draft-for-review'},catalog);
 const relaxed={...catalog,entries:catalog.entries.map(e=>({...e,validator:e.id==='strict'?{...strict,limit:10000}:e.validator,revision:'r2'}))};
 assert.equal((await recordRulebookCheck(sid,{applicable:['strict','lax'],task:'draft-for-review'},relaxed)).ok,true);
 await receipt(sid,'discord-dm');assert.equal((await stop(sid))?.action,'request');
});
test('security: an empty model task report retains all validators already loaded at task start',async()=>{
 const sid='empty-start';await mutateSessionState(sid,s=>{s.loadedConventions=[{id:'strict',revision:'r1',loadedAt:Date.now(),validator:strict}];});
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 await receipt(sid);assert.equal((await stop(sid))?.action,'request');
});
test('security: same-ID reload retains the smaller session limit',async()=>{
 const sid='legacy-reload';await legacy(sid);
 await recordRulebookLoad(sid,'strict',null,{revision:'r2',validator:{...strict,limit:10000}});
 await receipt(sid,'discord-dm');assert.equal((await stop(sid))?.action,'request');
});
test('security: trusted user source revision is current through approval',async()=>{
 const sid='user-snapshot';await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),prompt:'entwirf eine Antwort',mode:'generic',candidates:[{id:'strict',type:'workflow',matched_recall_when:true,validator:strict}],surface:'claude-code'});
 await recordRulebookLoad(sid,'strict',null,{revision:'r2',validator:{...strict,limit:10000}});
 await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),prompt:'ok',mode:'trivial',candidates:[],surface:'claude-code'});
 assert.equal((await loadSessionState(sid)).activeTask?.kind,'approved-copy');
 await receipt(sid,'discord-dm');assert.equal(await stop(sid),null);
});
test('security: a real user-turn email task remains bound to email despite Discord loads/model reports',async()=>{
 const sid='user-email';await legacy(sid);await mutateSessionState(sid,s=>{delete s.activeTask;});
 await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),prompt:'entwirf eine Antwort',mode:'generic',candidates:[{id:'lax',type:'workflow',matched_recall_when:true,validator:lax}],surface:'claude-code'});
 assert.equal((await loadSessionState(sid)).userValidatorChannel,'email');
 await recordRulebookLoad(sid,'strict',null,{revision:'r2',validator:strict});
 await recordRulebookCheck(sid,{applicable:['strict','lax'],task:'draft-for-review'},catalog);
 await receipt(sid);assert.equal(await stop(sid),null);
});
test('security: incomparable units both constrain model tasks, not just the smallest numeric limit',async()=>{
 const sid='units';const c={...catalog,entries:catalog.entries.map(e=>({...e,validator:{...strict,channel:'fixture',limit:e.id==='strict'?100:120,unit:e.id==='strict'?'codepoints' as const:'utf16' as const}}))};
 await recordRulebookCheck(sid,{applicable:['strict','lax'],task:'draft-for-review'},c);
 await receipt(sid,'fixture',100);assert.equal((await stop(sid,'😀'.repeat(80)))?.action,'request');
});
