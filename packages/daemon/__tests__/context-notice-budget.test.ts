/** #1371: delivered text budgets, lifecycle, transport and binding controls. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { beginRulebookRound, resetRulebookContext } from '../src/rulebook-check.js';
import { loadSessionState, mutateSessionState, clearShown, bumpTaskGeneration } from '../src/session-state.js';
import { runTaskStep } from '../src/prompt-task.js';
import { runPromptLane } from '../src/prompt-lane.js';
import { createLaneDelivery } from '../src/lane-delivery.js';
import type { KernelCandidates } from '../src/rulebook-catalog.js';
import { collectRulebookCatalog } from '../src/rulebook-catalog.js';
import { setPrimaryLanguage } from '../src/settings.js';
import { serverInstructions } from '../src/mcp-instructions.js';
import { ALL_TOOL_DEFS } from '../src/tool-defs.js';
const validator = { tool:'validate_artifact',channel:'fixture',limit:2000,unit:'utf16' } as const;
const catalog:KernelCandidates={entries:[{id:'fixture-rule',title:'Fixture',group:'explicit',revision:'r1',body:'Fixture rule body',updated:null,stale_status:'unknown',rulebook:'on-demand',validator}],omitted:0};
let root:string;
before(async()=>{root=await mkdtemp(join(tmpdir(),'notice-budget-'));Object.assign(process.env,{BASTRA_HOOK_STATE_DIR:join(root,'state'),BASTRA_SETTINGS_PATH:join(root,'settings.json'),BASTRA_TELEMETRY:'off'});});
after(()=>rm(root,{recursive:true,force:true}));
const payload=(sid:string,agent_id?:string)=>({session_id:sid,bastra_client:'claude-code',agent_id});
async function seed(sid:string){await mutateSessionState(sid,s=>{s.activeTask={id:'fixture-task',kind:'draft-for-review',since:1,generation:0};s.activeConventions=[{id:'fixture-rule',revision:'r1',validator,setAt:1}];});}
async function render(sid:string,maxChars?:number,surface='claude-code'){return runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),surface,maxChars});}
test('unchanged production prompt rounds stay inside per-surface budgets',async t=>{
 const sid='budget';await seed(sid);
 const texts:string[]=[];
 for(let i=0;i<2;i++)texts.push(JSON.parse(await runPromptLane({...payload(sid),hook_event_name:'UserPromptSubmit',prompt:'ok'},null,'http://127.0.0.1:1',undefined,()=>[],{kernel:async()=>catalog})).hookSpecificOutput.additionalContext);
 const split=(s:string)=>{const at=s.indexOf('<active-conventions');return [s.slice(0,at).trim(),s.slice(at).trim()];};
 const [fullProcedure,fullActive]=split(texts[0]);const [shortProcedure,shortActive]=split(texts[1]);
 assert.match(fullProcedure,/not_applicable/);assert.match(fullActive,/Conventions in force/);
 assert.match(shortProcedure,/unchanged|unverändert/);assert.match(shortActive,/Unchanged/);
 assert.ok(shortProcedure.length<=450,`procedure ${shortProcedure.length}>450`);
 assert.ok(shortActive.length<=350,`active ${shortActive.length}>350`);
 assert.ok(texts[1].length<texts[0].length-500);
 assert.match(shortActive,/fixture-rule revision=r1.*tool=validate_artifact channel=fixture limit=2000 unit=utf16/);
 t.diagnostic(JSON.stringify({method:'UTF16 characters / 4 estimated tokens',first:{procedure:fullProcedure.length,active:fullActive.length,total:texts[0].length},unchanged:{procedure:shortProcedure.length,active:shortActive.length,total:texts[1].length}}));
});
test('procedure rule binding changes force full delivery, including ids-only catalog',async()=>{
 const sid='bindings';await beginRulebookRound(payload(sid),catalog);assert.match(await beginRulebookRound(payload(sid),catalog),/unchanged|unverändert/);
 const changed={...catalog,entries:catalog.entries.map(e=>({...e,revision:'r2'}))};assert.match(await beginRulebookRound(payload(sid),changed),/not_applicable/);
 const memory={fm:{id:'fixture-rule',title:'Fixture',type:'meta-working',scope:'all-projects',rulebook:'on-demand',applies_when:'Fixture'},body:'old',revision:'r1'};
 const opts={active:[],project:null,mode:'ids' as const,floors:async()=>[]};
 const a=await collectRulebookCatalog({list:()=>[memory],get:()=>memory} as never,opts);
 const changedMemory={...memory,body:'new',revision:'r2'};
 const b=await collectRulebookCatalog({list:()=>[changedMemory],get:()=>changedMemory} as never,opts);
 assert.notEqual(a.entries[0].binding_hash,b.entries[0].binding_hash);assert.equal(a.entries[0].revision,null);
 const id='ids-only';await beginRulebookRound(payload(id),a);assert.match(await beginRulebookRound(payload(id),a),/unchanged|unverändert/);assert.doesNotMatch(await beginRulebookRound(payload(id),b),/unchanged|unverändert/);
});
for(const reset of ['reset','clear','compact'] as const)test(`${reset} restores both full notices without source callbacks`,async()=>{
 const sid=reset;await seed(sid);await beginRulebookRound(payload(sid),catalog);await render(sid);
 if(reset==='reset')await resetRulebookContext(sid);
 else {await clearShown(sid);if(reset==='compact')await bumpTaskGeneration(sid);}
 assert.match(await beginRulebookRound(payload(sid),catalog),/not_applicable/);
 assert.match(await render(sid)??'',/Conventions in force/);
});
test('active changes to revision, validator and task force full views',async()=>{
 const sid='active-changes';await seed(sid);await render(sid);assert.match(await render(sid)??'',/Unchanged/);
 for(const change of [(s:any)=>s.activeConventions[0].revision='r2',(s:any)=>s.activeConventions[0].validator.limit=1000,(s:any)=>s.activeTask.kind='translate-only']){
  await mutateSessionState(sid,change);assert.match(await render(sid)??'',/Conventions in force/);assert.match(await render(sid)??'',/Unchanged/);
 }
});
test('scopes isolate actor and surface; current round exceptions stay visible',async()=>{
 const sid='scopes';await seed(sid);await beginRulebookRound(payload(sid),catalog);
 assert.match(await beginRulebookRound(payload(sid,'worker'),catalog),/not_applicable/);
 await render(sid);assert.match(await render(sid,undefined,'codex')??'',/Conventions in force/);
 await mutateSessionState(sid,s=>{const x=JSON.parse(s.rulebookCheck!);x.exceptions=['fixture-exception'];x.blockedDismissals=['protected'];x.unchecked=2;s.rulebookCheck=JSON.stringify(x);});
 const notice=await beginRulebookRound(payload(sid),catalog);assert.match(notice,/fixture-exception/);assert.match(notice,/protected/);assert.match(notice,/2/);
});
test('budget-deferred full active view is never marked delivered',async()=>{
 const sid='deferred';await seed(sid);assert.equal(await render(sid,10),null);assert.match(await render(sid)??'',/Conventions in force/);
});
function transport(){const res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,writableFinished:false,writeHead(){},end(){}});return {res,delivery:createLaneDelivery(res as unknown as ServerResponse)};}
test('aborted and empty HTTP hook answers do not confirm either full notice',async()=>{
 for(const kind of ['abort','empty']){
  const sid=`transport-${kind}`;await seed(sid);const {res,delivery}=transport();
  await delivery.run(async()=>{await beginRulebookRound(payload(sid),catalog);await render(sid);});
  if(kind==='abort')res.emit('close');else {delivery.answer('{}');res.writableFinished=true;res.emit('finish');}
  await new Promise(r=>setImmediate(r));
  assert.match(await beginRulebookRound(payload(sid),catalog),/not_applicable/);assert.match(await render(sid)??'',/Conventions in force/);
 }
});
test('late delivery confirmation after reset cannot repopulate new context',async()=>{
 const sid='late';await seed(sid);const {res,delivery}=transport();
 let body='';await delivery.run(async()=>{body=JSON.stringify({hookSpecificOutput:{additionalContext:await beginRulebookRound(payload(sid),catalog)}});});
 await resetRulebookContext(sid);delivery.answer(body);res.writableFinished=true;res.emit('finish');await new Promise(r=>setImmediate(r));
 assert.match(await beginRulebookRound(payload(sid),catalog),/not_applicable/);
});
test('native MCP definitions do not duplicate central instructions (host projection outside repo)',()=>{
 for(const tool of ALL_TOOL_DEFS)assert.ok(!tool.description.includes(serverInstructions(false)));
 assert.ok(serverInstructions(true).length<=3000);
});

test('language change forces full procedure and actor scopes get their own active view',async()=>{
 const sid='language';await seed(sid);await setPrimaryLanguage('en');
 await beginRulebookRound(payload(sid),catalog);assert.match(await beginRulebookRound(payload(sid),catalog),/unchanged/);
 await setPrimaryLanguage('de');assert.match(await beginRulebookRound(payload(sid),catalog),/not_applicable/);
 await setPrimaryLanguage('en');await render(sid);
 assert.match(await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),surface:'claude-code',actorKey:'worker'})??'',/Conventions in force/);
});
