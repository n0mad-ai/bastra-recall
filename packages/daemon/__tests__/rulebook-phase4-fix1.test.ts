import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runBashPreLane} from '../src/bash-pre-lane.js';
import {recordRulebookCheck,beginRulebookRound,recordRulebookLoad} from '../src/rulebook-check.js';
import {loadSessionState,mutateSessionState} from '../src/session-state.js';
import {checkStopRepair} from '../src/stop-repair.js';
import {formatActiveConventionsBlock} from '../src/prompt-format.js';
import {FrontmatterSchema} from '@bastra-recall/core';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const catalog:KernelCandidates={entries:[{id:'issue-rule',title:'Issue rule',group:'explicit',rulebook:'on-demand',body:'Milestone labels; English first then Deutsch',applies_when:'When writing issues',revision:'r1',updated:null,stale_status:'unknown'}],omitted:0};
let root:string,base:string;const previous=process.env.BASTRA_HOOK_STATE_DIR;
const server=createServer((q,r)=>{q.resume();r.setHeader('Content-Type','application/json');r.end(JSON.stringify(q.url==='/hook/recall'?{score_kind:'rrf',hits:[{id:'issue-rule',title:'Issue rule',type:'workflow',scope:'all-projects',summary:catalog.entries[0].body,write_origin:'user-directed',revision:'r1',score:150,matched_recall_when:true,anchor_strength:'strong'}]}:{hits:[]}));});
before(async()=>{root=await mkdtemp(join(tmpdir(),'phase4-fix1-'));process.env.BASTRA_HOOK_STATE_DIR=root;process.env.BASTRA_TELEMETRY='off';await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
after(async()=>{await new Promise<void>(r=>server.close(()=>r()));if(previous===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=previous;await rm(root,{recursive:true,force:true});});
const payload=(sid:string,command='gh issue create --title fixture')=>({session_id:sid,bastra_client:'claude-code',hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command}});
const denied=(s:string)=>JSON.parse(s).hookSpecificOutput?.permissionDecision==='deny';
test('A2/B2: empty round checks do not discharge concrete GitHub IDs, even in one session',async()=>{
 const sid='same-round';await recordRulebookCheck(sid,{applicable:[]},catalog);
 const first=await runBashPreLane(payload(sid),base);assert.equal(denied(first),true);assert.match(first,/issue-rule/);assert.match(first,/MUST-LOAD/);
 await recordRulebookCheck(sid,{applicable:[]},catalog);
 assert.equal(denied(await runBashPreLane(payload(sid,'gh pr create --title fixture'),base)),true);
 assert.equal(denied(await runBashPreLane(payload(sid),base)),false,'bounded at two denials');
 await recordRulebookLoad(sid,'issue-rule',null);
 assert.equal(denied(await runBashPreLane(payload(sid,'gh pr edit 1 --title fixture'),base)),false);
});
test('D1: model report cannot attest user approval; rendering requires user-turn provenance',async()=>{
 await recordRulebookCheck('approval',{applicable:['issue-rule'],task:'approved-copy'},catalog);
 assert.notEqual((await loadSessionState('approval')).activeTask?.kind,'approved-copy');
 const text=formatActiveConventionsBlock({task:'approved-copy',generation:0,conventions:[],changed:[],unclear:false});
 assert.doesNotMatch(text!,/the user approved/);
});
test('C1-C3/D2: review task keeps loaded-validator repair despite rejected none report',async()=>{
 const sid='copy';await mutateSessionState(sid,s=>{s.loadedConventions=[{id:'message-rule',revision:'r',loadedAt:1,validator} as never];s.activeConventions=[{id:'message-rule',revision:'r',setAt:1,validator}];});
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 await recordRulebookCheck(sid,{applicable:[],task:'none'},catalog);
 const p={session_id:sid,hook_event_name:'Stop',transcript:[{role:'user',content:'ok'},{role:'assistant',content:'```\n'+'x'.repeat(3000)+'\n```'}]};
 assert.equal((await checkStopRepair(p))?.action,'request');
});
test('F: task notice is absent for a catalog without task category or validator',async()=>{
 assert.doesNotMatch(await beginRulebookRound(payload('notice'),catalog),/Aufgabenstatus|Report correspondence/);
});
test('additive fixed categories survive frontmatter parsing without natural-language inference',()=>{
 const fm=FrontmatterSchema.parse({id:'category-rule',title:'Rule',type:'workflow',scope:'all-projects',summary:'Fixture',created:'2026-10-30',updated:'2026-10-30',tags:['fixture'],topic_path:['fixture'],recall_when:['fixture'],rule_categories:['github-issues-prs']});
 assert.deepEqual((fm as any).rule_categories,['github-issues-prs']);
});
test('D: unsupported Codex versions still receive concrete advisory GitHub conventions',async()=>{
 const p={...payload('advice'),bastra_client:'codex',bastra_codex_version:'0.1'};
 const out=await runBashPreLane(p,base);assert.match(out,/Relevant conventions \(host cannot gate\)/);assert.match(out,/issue-rule/);
});
test('exact justified exceptions are audited as visible violations; empty checks and applicable IDs are insufficient',async()=>{
 const sid='waiver';assert.equal(denied(await runBashPreLane(payload(sid),base)),true);
 await recordRulebookCheck(sid,{applicable:['issue-rule']},catalog);
 assert.equal(denied(await runBashPreLane(payload(sid),base)),true);
 const out=await recordRulebookCheck(sid,{applicable:[],not_applicable:[{id:'issue-rule',reason:'This isolated fixture uses a different repository policy.'}]},catalog);
 assert.equal(out.ok,true);
 const note=await beginRulebookRound(payload(sid),catalog);assert.match(note,/ungeprüft|unchecked/);
 await recordRulebookCheck(sid,{applicable:[]},catalog);
 assert.equal(denied(await runBashPreLane(payload(sid),base)),false,'only the exact explicit exception discharges this revision');
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[{id:'unrelated',reason:'Not applicable'}]},catalog)).ok,false);
});
test('fixed category lookup is index-only, independent of query words, scope- and privacy-filtered',async()=>{
 const {parseMemory}=await import('@bastra-recall/core');
 const {indexedActionConventions}=await import('../src/action-conventions.js');
 const make=(id:string,extra='')=>parseMemory(`---\nid: ${id}\ntitle: 発行\ntype: workflow\nsummary: 規則\nscope: all-projects\nwrite_origin: user-directed\nrule_categories: [github-issues-prs]\n${extra}tags: [fixture]\ntopic_path: [fixture]\nrecall_when: [無関係]\n---\n本文`,'/unreadable/'+id,0);
 const items=[make('category-rule'),make('private-rule','sensitivity: private\n'),make('obsolete-rule','obsolete: true\n')];
 const vault={list:()=>items,get:(id:string)=>items.find(m=>m.fm.id===id)};
 assert.deepEqual((await indexedActionConventions(vault,null,'github-issues-prs')).hits.map(h=>h.id),['category-rule']);
});
test('new category saves roundtrip; overwrite/category-removal edits stay proposals',async t=>{
 const {saveMemory,Vault,SearchIndex}=await import('@bastra-recall/core');
 const {Telemetry}=await import('../src/telemetry.js');
 const {editMemoryHandler}=await import('../src/edit-memory-handler.js');
 const dir=await mkdtemp(join(tmpdir(),'category-save-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const input={id:'categorized',title:'Invented rule',type:'workflow' as const,summary:'Fixture',scope:'all-projects',tags:['fixture'],topic_path:['fixture'],recall_when:['fixture'],write_origin:'user-directed' as const,rule_categories:['github-issues-prs' as const],body:'Fixture body'};
 await saveMemory(dir,input);const vault=new Vault(dir);await vault.init();t.after(()=>vault.stop());
 assert.deepEqual(vault.get(input.id)?.fm.rule_categories,['github-issues-prs']);
 const search=new SearchIndex(vault);search.start();t.after(()=>search.stop());
 await editMemoryHandler({vault,search,telemetry:new Telemetry(),vaultPath:dir} as import('../src/tool-deps.js').ToolDeps,{id:input.id,frontmatter:{rule_categories:[]}});
 const {readFile}=await import('node:fs/promises');const {parseMemory}=await import('@bastra-recall/core');
 const file=vault.get(input.id)!.filePath;const changed=parseMemory(await readFile(file,'utf8'),file,0);
 assert.deepEqual(changed.fm.rule_categories,['github-issues-prs']);assert.deepEqual(changed.fm.rulebook_proposed?.rule_categories,[]);
});
test('full load → foreign message → quoted approval → ok → oversized copy keeps repair and trustworthy provenance',async t=>{
 const {Vault,SearchIndex,saveMemory}=await import('@bastra-recall/core');const {Telemetry}=await import('../src/telemetry.js');
 const {loadMemoryHandler}=await import('../src/load-memory-handler.js');const {runTaskStep}=await import('../src/prompt-task.js');const {runStopLane}=await import('../src/stop-lane.js');
 const dir=await mkdtemp(join(tmpdir(),'loaded-validator-'));const sid='real-loaded-copy';
 await saveMemory(dir,{id:'loaded-message',title:'Message convention',summary:'Validate channel copy',type:'workflow',scope:'all-projects',write_origin:'user-directed',tags:['fixture'],topic_path:['fixture'],recall_when:['fixture'],body:'Validate the final copy',validator});
 const vault=new Vault(dir);await vault.init();const search=new SearchIndex(vault);search.start();t.after(async()=>{search.stop();await vault.stop();await rm(dir,{recursive:true,force:true});});
 await loadMemoryHandler({vault,search,telemetry:new Telemetry(),vaultPath:dir},{id:'loaded-message'},{sessionId:sid,agentId:null});
 assert.deepEqual((await loadSessionState(sid)).loadedConventions?.find(c=>c.id==='loaded-message')?.validator,validator);
 const step=async(prompt:string)=>runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),prompt,mode:'generic',candidates:[],surface:'claude-code'});
 const stop=(copy:string)=>{const p={...payload(sid),hook_event_name:'Stop',transcript:[{role:'user',content:'契約書を送ってください。'},{role:'assistant',content:copy}]};return runStopLane(p,base);};
 await step('> An incoming message');
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 assert.match(await stop('```\nDraft text\n```'),/validate_artifact/);
 await step('> approved, send it');assert.notEqual((await loadSessionState(sid)).activeTask?.kind,'approved-copy');
 await step('ok');assert.notEqual((await loadSessionState(sid)).activeTask?.kind,'approved-copy','an open quoted-text question is not approved by a bare ok');
 await step('freigegeben');const state=await loadSessionState(sid);assert.equal(state.activeTask?.kind,'approved-copy');assert.equal(state.activeTask?.approvalSource,'user-turn');
 const shown=await step('ok');assert.match(shown!,/the user approved/);
 await recordRulebookCheck(sid,{applicable:[],task:'none'},catalog);
 assert.match(await stop('```\n'+'x'.repeat(3000)+'\n```'),/validate_artifact/);
});
test('worker action obligations never inherit main loads',async()=>{
 const sid='action-worker';await recordRulebookLoad(sid,'issue-rule',null,{revision:'r1',rulebookMetadata:{rulebook:'on-demand',applies_when:'Fixture'}});
 assert.equal(denied(await runBashPreLane(payload(sid),base)),false);
 const p={...payload(sid),agent_id:'child'};const first=await runBashPreLane(p,base);assert.equal(denied(first),true);assert.match(first,/issue-rule/);
 await recordRulebookCheck(sid,{applicable:[],agent_id:'child'},catalog);assert.equal(denied(await runBashPreLane(p,base)),true);
 await recordRulebookLoad(sid,'issue-rule','child',{revision:'r1',rulebookMetadata:{rulebook:'on-demand',applies_when:'Fixture'}});
 assert.equal(denied(await runBashPreLane(p,base)),false);
});
test('C1-C3 exact sequence: bare incoming message then ok then long copy requires validation',async()=>{
 const sid='bare-ok-copy';await recordRulebookLoad(sid,'message-rule',null,{revision:'r',validator,rulebookMetadata:{rulebook:'on-demand',applies_when:'Incoming messages'}});
 const {runTaskStep}=await import('../src/prompt-task.js');
 await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),prompt:'> ¿Puedes enviar el contrato?',mode:'generic',candidates:[{id:'message-rule',type:'workflow',matched_recall_when:true,validator}],surface:'claude-code'});
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 const stop=(text:string)=>checkStopRepair({session_id:sid,hook_event_name:'Stop',transcript:[{role:'user',content:'¿Puedes enviar el contrato?'},{role:'assistant',content:'```\n'+text+'\n```'}]});
 assert.equal((await stop('An invented review draft'))?.action,'request');
 await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),prompt:'ok',mode:'trivial',candidates:[],surface:'claude-code'});
 assert.equal((await loadSessionState(sid)).activeTask?.kind,'approved-copy');
 assert.equal((await stop('x'.repeat(3000)))?.action,'request');
});
test('model tightening cannot remove validators or reset a running repair budget',async()=>{
 const sid='repair-model-cap';await recordRulebookLoad(sid,'message-rule',null,{revision:'r',validator,rulebookMetadata:{rulebook:'on-demand',applies_when:'Messages'}});
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 const p={session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:'```\n'+'x'.repeat(3000)+'\n```'}]};
 assert.equal((await checkStopRepair(p))?.action,'request');
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 assert.equal((await checkStopRepair(p))?.action,'request');
 await recordRulebookCheck(sid,{applicable:['issue-rule'],task:'draft-for-review'},catalog);
 assert.equal((await checkStopRepair(p))?.action,'exhausted');
 assert.equal(await checkStopRepair(p),null);
 assert.deepEqual((await loadSessionState(sid)).loadedConventions?.find(c=>c.id==='message-rule')?.validator,validator);
});
test('worker full-load attribution uses actual load_memory read, not a main receipt or self-report',async t=>{
 const {Vault,SearchIndex,saveMemory}=await import('@bastra-recall/core');const {Telemetry}=await import('../src/telemetry.js');
 const {loadMemoryHandler}=await import('../src/load-memory-handler.js');const {requireActionRules,rulebookBoundary}=await import('../src/rulebook-check.js');
 const dir=await mkdtemp(join(tmpdir(),'worker-real-load-'));await saveMemory(dir,{id:'issue-rule',title:'Issue rule',summary:'Fixture',type:'workflow',scope:'all-projects',write_origin:'user-directed',tags:['fixture'],topic_path:['fixture'],recall_when:['fixture'],body:'Fixture body'});
 const vault=new Vault(dir);await vault.init();const search=new SearchIndex(vault);search.start();t.after(async()=>{search.stop();await vault.stop();await rm(dir,{recursive:true,force:true});});
 const deps={vault,search,telemetry:new Telemetry(),vaultPath:dir},sid='worker-real-load',p={...payload(sid),agent_id:'worker'};
 const revision=vault.get('issue-rule')!.revision??null;await requireActionRules(p,[{id:'issue-rule',revision}]);
 assert.equal(denied((await rulebookBoundary(p,catalog,'action'))!),true);
 await loadMemoryHandler(deps,{id:'issue-rule',session_id:sid,agent_id:'worker'});
 await recordRulebookCheck(sid,{applicable:[],agent_id:'worker'},catalog);
 assert.equal(denied((await rulebookBoundary(p,catalog,'action'))!),false);
 const state=JSON.parse((await loadSessionState(sid)).rulebookCheck!);
 assert.equal(state.actors.find((a:any)=>a.key==='main')?.checked??false,false);
});
test('categorized GitHub action uses the actual index route even when legacy recall returns nothing',async t=>{
 const {parseMemory}=await import('@bastra-recall/core');const {dispatchLocalRoutes}=await import('../src/http-local-routes.js');
 const {Telemetry}=await import('../src/telemetry.js');
 const memory=parseMemory('---\nid: category-only\ntitle: 発行\nsummary: 規則\ntype: workflow\nscope: all-projects\nwrite_origin: user-directed\nrule_categories: [github-issues-prs]\ntags: [fixture]\ntopic_path: [fixture]\nrecall_when: [無関係]\n---\n本文','/unreadable/category',0);
 const vault={list:()=>[memory],get:()=>memory};const telemetry=new Telemetry();
 const backend=createServer((q,r)=>{
  if(q.url==='/hook/recall'){q.resume();r.end(JSON.stringify({hits:[]}));return;}
  const ctx={vault,telemetry,toolDeps:{vault,telemetry},healthPayload:()=>({})} as unknown as import('../src/http-local-routes.js').LocalRouteCtx;
  if(!dispatchLocalRoutes(q,r,q.method!,q.url!,Date.now(),ctx))r.end('{}');
 });
 await new Promise<void>(r=>backend.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>backend.close(()=>r())));
 const base=`http://127.0.0.1:${(backend.address() as {port:number}).port}`;
 await recordRulebookCheck('category-live',{applicable:[]},catalog);
 const out=await runBashPreLane(payload('category-live'),base);assert.equal(denied(out),true);assert.match(out,/category-only/);assert.match(out,/MUST-LOAD/);
});
test('fence labels alone never create a review task; an explicit model tightening enables repair',async()=>{
 const sid='other-fence';await recordRulebookLoad(sid,'message-rule',null,{revision:'r',validator,rulebookMetadata:{rulebook:'on-demand',applies_when:'Messages'}});
 assert.equal(await checkStopRepair({session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:'```typescript\nconst x = 1;\n```'}]}),null);
 assert.equal(await checkStopRepair({session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:'```discord-dm\nA copy-ready reply.\n```'}]}),null);
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 assert.equal((await checkStopRepair({session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:'```discord-dm\nA copy-ready reply.\n```'}]}))?.action,'request');
});
test('a model review report cannot replace a user translate-only task',async()=>{
 const sid='user-translate';const {runTaskStep}=await import('../src/prompt-task.js');
 await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),prompt:'nur übersetzen',mode:'generic',candidates:[{id:'message-rule',type:'workflow',matched_recall_when:true,validator}],surface:'claude-code'});
 assert.equal((await loadSessionState(sid)).activeTask?.kind,'translate-only');
 assert.equal((await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog)).ok,false);
 assert.equal((await loadSessionState(sid)).activeTask?.kind,'translate-only');
});
test('an unattributed action cannot inherit a main-thread full load',async()=>{
 const sid='unattributed-action';await recordRulebookLoad(sid,'issue-rule',null,{revision:'r1',rulebookMetadata:{rulebook:'on-demand',applies_when:'Fixture'}});
 const p={...payload(sid),bastra_client:undefined};
 assert.equal(denied(await runBashPreLane(p,base)),true);
});
test('structural repair respects the validator counting unit and a real matching receipt',async()=>{
 const sid='copy-count-unit',v={...validator,channel:'fixture-channel',limit:100,unit:'codepoints' as const};
 await recordRulebookLoad(sid,'count-rule',null,{revision:'r',validator:v,rulebookMetadata:{rulebook:'on-demand',applies_when:'Fixture'}});
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 const text='😀'.repeat(60),p={session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:'```\n'+text+'\n```'}]};
 assert.equal((await checkStopRepair(p))?.action,'request');
 const {validateArtifactHandler}=await import('../src/validate-artifact-handler.js');const {callerSessionStore}=await import('../src/caller-session.js');
 const result=await callerSessionStore.run(sid,()=>validateArtifactHandler({text,channel:v.channel,limit:v.limit,unit:v.unit,normalize:'none'}));
 assert.equal(result.receipt_stored,true);assert.equal(await checkStopRepair(p),null);
});
test('answer labels cannot bypass a second loaded channel contract',async()=>{
 const sid='copy-two-channels';for(const channel of ['channel-a','channel-b'])await recordRulebookLoad(sid,channel,null,{revision:'r',validator:{...validator,channel,limit:100},rulebookMetadata:{rulebook:'on-demand',applies_when:'Messages'}});
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 const text='A short copy.',p={session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:'```channel-a\n'+text+'\n```'}]};
 assert.equal((await checkStopRepair(p))?.action,'request');
 const {validateArtifactHandler}=await import('../src/validate-artifact-handler.js');const {callerSessionStore}=await import('../src/caller-session.js');
 assert.equal((await callerSessionStore.run(sid,()=>validateArtifactHandler({text,channel:'channel-a',limit:100,unit:'utf16',normalize:'none'}))).receipt_stored,true);
 assert.equal((await checkStopRepair(p))?.action,'request','channel label cannot select the rule');
 assert.equal((await callerSessionStore.run(sid,()=>validateArtifactHandler({text,channel:'channel-b',limit:100,unit:'utf16',normalize:'none'}))).receipt_stored,true);
 assert.equal(await checkStopRepair(p),null);
});
