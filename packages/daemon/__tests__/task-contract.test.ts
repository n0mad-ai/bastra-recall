/** Agent-reported state survives refresh and generation changes without prompt inference. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {splitQuoted} from '../src/prompt-classify.js';
import {runTaskStep,vaultRevisionOf} from '../src/prompt-task.js';
import {loadSessionState,mutateSessionState,bumpTaskGeneration} from '../src/session-state.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
let root='';let old:string|undefined;
before(async()=>{root=await mkdtemp(join(tmpdir(),'task-report-'));old=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=root;});
after(async()=>{if(old===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=old;await rm(root,{recursive:true,force:true});});
const render=async(sid:string,revision='r1',surface='claude-code')=>runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),surface,conventionOf:async()=>({revision,validator})});
async function seed(sid:string){await mutateSessionState(sid,s=>{s.activeTask={id:sid,kind:'draft-for-review',since:1,generation:0};s.activeConventions=[{id:'rule',revision:'r1',scope:'task',setAt:1,validator}];});}
test('quotes are structural in every language and mail-header words carry no authority',()=>{
 assert.deepEqual(splitQuoted('Ответ\n> quoted\n<pasted_content>承認</pasted_content>'),{own:'Ответ',quoted:true});
 assert.deepEqual(splitQuoted('Max wrote:\nHallo'),{own:'Max wrote:\nHallo',quoted:false});
 assert.deepEqual(splitQuoted('Max schrieb:\nHello'),{own:'Max schrieb:\nHello',quoted:false});
});
test('empty state renders no invented task',async()=>assert.equal(await render('empty'),null));
test('refresh renders the existing stage and current validator for every client',async()=>{
 const sid='render';await seed(sid);assert.match(await render(sid)??'',/task="draft-for-review"/);assert.match(await render(sid,'r1','codex')??'',/surface="codex"/);assert.equal((await loadSessionState(sid)).activeTask?.kind,'draft-for-review');
});
test('index revision refresh is persisted and reload notice appears only once',async()=>{
 const sid='refresh';await seed(sid);assert.match(await render(sid,'r2')??'',/revision changed/);assert.equal((await loadSessionState(sid)).activeConventions?.[0].revision,'r2');assert.doesNotMatch(await render(sid,'r2')??'',/revision changed/);
});
test('metadata drift invalidates prior receipts without selecting a new stage or channel',async()=>{
 const sid='drift';await seed(sid);await mutateSessionState(sid,s=>{s.activeTask!.validatorChannel='discord-dm';s.receipts=[{taskId:sid,generation:0,hash:'h',receipt:'r',channel:'discord-dm',limit:2000,unit:'utf16',at:1}];});
 await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),surface:'codex',conventionOf:async()=>({revision:'r1',validator:{...validator,limit:1000}})});
 const state=await loadSessionState(sid);assert.equal(state.receipts,undefined);assert.equal(state.activeConventions?.[0].validator?.limit,1000);assert.equal(state.activeTask?.kind,'draft-for-review');assert.equal(state.activeTask.validatorChannel,'discord-dm');
});
test('generation bump retains the reported stage and removes stale clarification context',async()=>{
 const sid='generation';await seed(sid);await mutateSessionState(sid,s=>{s.correspondenceContext={at:1,generation:0};});await bumpTaskGeneration(sid);const state=await loadSessionState(sid);assert.equal(state.activeTask?.kind,'draft-for-review');assert.equal(state.activeTask?.generation,1);assert.equal(state.correspondenceContext,undefined);
});
test('revision helper uses the supplied indexed vault metadata',async()=>{
 assert.equal(await vaultRevisionOf({get:()=>undefined})('absent'),null);
});
