import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Vault,saveMemory,parseMemory} from '@bastra-recall/core';
import {serve} from './fixtures/rulebook-phase5/probe.js';
import {beginRulebookRound,recordRulebookCheck,rulebookBoundary,RulebookCheckArgs,recordRulebookLoad,roundCorrespondence} from '../src/rulebook-check.js';
import {cachedRulebookCatalog} from '../src/rulebook-catalog.js';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {editMemoryHandler} from '../src/edit-memory-handler.js';
import {checkStopRepair} from '../src/stop-repair.js';
import {indexedConventionSource} from '../src/convention-source.js';
import {loadSessionState} from '../src/session-state.js';
const validator={tool:'validate_artifact',channel:'fixture-copy',limit:12,unit:'utf16'} as const;
let root:string,vault:Vault,live:Awaited<ReturnType<typeof serve>>;
before(async()=>{root=await mkdtemp(join(tmpdir(),'correspondence-round-'));process.env.BASTRA_HOOK_STATE_DIR=join(root,'state');process.env.BASTRA_LOG_PATH=join(root,'logs');process.env.BASTRA_TELEMETRY='on';vault=new Vault(join(root,'vault'));await vault.init();
 for(const id of ['copy-rule','correspondence-rule','coding-rule']){const m=await saveMemory(vault.root,{id,title:'Invented rule',summary:'Invented scope',body:'Invented body',type:'workflow',scope:'all-projects',write_origin:'user-directed',rulebook:'on-demand',applies_when:'For invented output',tags:['fixture'],topic_path:['fixture'],recall_when:['invented-trigger'],...(id==='copy-rule'?{validator}:{}),...(id==='correspondence-rule'?{rule_categories:['correspondence' as const]}:{})});await vault.reindexFile(m.file_path);}
 live=await serve(vault);
});
after(async()=>{await live.close();await vault.stop();await rm(root,{recursive:true,force:true});});
const catalog=()=>cachedRulebookCatalog(vault,{project:null,active:[]});
const begin=async(sid:string,client='claude-code')=>beginRulebookRound({session_id:sid,bastra_client:client,bastra_codex_version:'0.162.1'},await catalog());
const check=(sid:string,input:object)=>live.post('/api/v1/rulebook_check',{session_id:sid,...input},sid);
const skip=(id:string)=>({id,reason:'This round only explains an unrelated technical topic.'});
const stop=(sid:string,text='short',client='claude-code',active=false)=>live.post('/hook/stop',{payload:{session_id:sid,bastra_client:client,bastra_codex_version:'0.162.1',hook_event_name:'Stop',stop_hook_active:active,transcript:[{role:'assistant',content:text}]}});
async function events(sid:string){const out:any[]=[];for(const name of await readdir(join(root,'logs')).catch(()=>[]))if(name.startsWith('events-'))for(const line of (await readFile(join(root,'logs',name),'utf8')).trim().split('\n').filter(Boolean)){const row=JSON.parse(line);if(row.session_id===sid)out.push(row);}return out;}
test('every structural correspondence ID needs a current-round declaration; empty check and unrelated load cannot discharge it',async()=>{
 const sid='missing';assert.match(await begin(sid),/copy-rule/);
 await live.post('/api/v1/load_memory',{id:'coding-rule',session_id:sid},sid);assert.equal((await check(sid,{applicable:[]})).ok,true);
 const first=await stop(sid);assert.equal(first.decision,'block');assert.match(first.reason,/copy-rule/);assert.match(first.reason,/correspondence-rule/);
 assert.notEqual((await stop(sid,'short','claude-code',true)).decision,'block');assert.match(await begin(sid),/unchecked|ungeprüft/);
});
test('one honest check resolves all correspondence IDs without a Stop block on harmless output',async()=>{
 const sid='honest';await begin(sid);assert.equal((await check(sid,{applicable:[],not_applicable:[skip('copy-rule'),skip('correspondence-rule')]})).ok,true);
 assert.notEqual((await stop(sid,'```ts\n'+ 'code'.repeat(30)+'\n```')).decision,'block');assert.doesNotMatch(JSON.stringify(await stop(sid,'prose'.repeat(30))),/copy-repair/);assert.doesNotMatch(await begin(sid),/unchecked|ungeprüft|violations|Verstoß/);
});
test('applicable declaration without task enforces oversized copy, bounds repairs, and never infers approval',async()=>{
 const sid='no-task';await begin(sid);assert.equal((await check(sid,{applicable:['copy-rule'],not_applicable:[skip('correspondence-rule')]})).ok,true);
 assert.equal((await loadSessionState(sid)).activeTask,undefined);
 for(const attempt of [1,2]){const out=await stop(sid,'x'.repeat(30),'claude-code',attempt===2);assert.match(JSON.stringify(out),new RegExp(`copy-repair.*${attempt}/2`));}
 assert.doesNotMatch(JSON.stringify(await stop(sid,'x'.repeat(30),'claude-code',true)),/copy-repair/);
 assert.equal((await events(sid)).filter(e=>e.kind==='non_conformance'&&e.reason==='repair_exhausted').length,1);
 assert.doesNotMatch(JSON.stringify(await stop(sid,'x'.repeat(30),'claude-code',true)),/copy-repair/);assert.equal((await loadSessionState(sid)).activeTask,undefined);
});
test('full load also declares applicability; empty checks cannot erase it or dismiss it later in the round',async()=>{
 const sid='load-declares';await begin(sid);await live.post('/api/v1/load_memory',{id:'copy-rule',session_id:sid},sid);
 assert.equal((await check(sid,{applicable:[],not_applicable:[skip('correspondence-rule')]})).ok,true);
 assert.equal((await check(sid,{applicable:[],not_applicable:[skip('copy-rule')]})).ok,false);
 assert.match(JSON.stringify(await stop(sid,'x'.repeat(30))),/copy-repair/);
});
test('round-only applicability expires, while an active task remains protected',async()=>{
 const sid='new-round';await begin(sid);await check(sid,{applicable:['copy-rule'],not_applicable:[skip('correspondence-rule')]});
 assert.doesNotMatch(JSON.stringify(await stop(sid,'valid')),/copy-repair/);
 await begin(sid);assert.equal((await check(sid,{applicable:[],not_applicable:[skip('copy-rule'),skip('correspondence-rule')]})).ok,true);
 assert.doesNotMatch(JSON.stringify(await stop(sid,'An unrelated translation or explanation'.repeat(10))),/copy-repair/);
 const active='active-across-rounds';await begin(active);await check(active,{applicable:['copy-rule'],task:'draft-for-review',not_applicable:[skip('correspondence-rule')]});
 await begin(active);assert.equal((await check(active,{applicable:[],not_applicable:[skip('copy-rule')]})).ok,false);
 await check(active,{applicable:['copy-rule'],not_applicable:[skip('correspondence-rule')]});
 assert.match(JSON.stringify(await stop(active,'x'.repeat(30))),/copy-repair/);
});
test('Codex observes oversized declared copy once without same-turn repair and reports the violation on the next prompt',async()=>{
 const sid='codex-observe';await begin(sid,'codex');await check(sid,{applicable:['copy-rule'],not_applicable:[skip('correspondence-rule')]});
 const out=await stop(sid,'x'.repeat(30),'codex');assert.notEqual(out.decision,'block');assert.doesNotMatch(JSON.stringify(out),/copy-repair/);
 await stop(sid,'x'.repeat(30),'codex',true);
 assert.equal((await events(sid)).filter(e=>e.kind==='non_conformance'&&e.reason==='copy_oversize_codex').length,1);
 assert.match(await begin(sid,'codex'),/violation|Verstoß/);
});

test('legacy validator/category metadata is catalogued and full loads declare it without migration',async()=>{
 for(const [kind,metadata]of [['validator','validator: {tool: validate_artifact, channel: fixture-copy, limit: 12, unit: utf16}'],['category','rule_categories: [correspondence]']]){
  const id='legacy-'+kind,memory=parseMemory(`---\nid: ${id}\ntitle: Fixture\nsummary: Fixture\ntype: project-fact\nscope: all-projects\n${metadata}\n---\nFixture`,join(root,'never-open.md'),0);
  const current=await cachedRulebookCatalog({list:()=>[memory],get:()=>memory},{project:null,active:[],floors:async()=>[]});
  assert.equal(current.entries.length,1);assert.equal(memory.fm.rulebook,undefined);
  await recordRulebookLoad(id,id,undefined,indexedConventionSource(memory));
  assert.ok(roundCorrespondence(await loadSessionState(id)).rules.some(r=>r.id===id),'a full load must declare legacy '+kind+' metadata');
 }
});
test('adding a task report cannot reset a current-round repair budget',async()=>{
 const sid='budget-transition';await begin(sid);await check(sid,{applicable:['copy-rule'],not_applicable:[skip('correspondence-rule')]});
 assert.match(JSON.stringify(await stop(sid,'x'.repeat(30))),/1\/2/);
 await check(sid,{applicable:['copy-rule'],task:'draft-for-review'});
 assert.match(JSON.stringify(await stop(sid,'x'.repeat(30),'claude-code',true)),/2\/2/);
 assert.doesNotMatch(JSON.stringify(await stop(sid,'x'.repeat(30),'claude-code',true)),/copy-repair/);
 assert.equal((await events(sid)).filter(e=>e.reason==='repair_exhausted').length,1);
});
test('a later model check cannot replace a strict declared validator with a lax same-ID one',async()=>{
 const sid='model-weakening';await begin(sid);await check(sid,{applicable:['copy-rule'],not_applicable:[skip('correspondence-rule')]});
 const relaxed=await catalog();relaxed.entries=relaxed.entries.map(e=>e.id==='copy-rule'?{...e,validator:{...validator,limit:1000}}:e);
 assert.equal((await recordRulebookCheck(sid,{applicable:['copy-rule']},relaxed)).ok,true);
 assert.equal((await checkStopRepair({session_id:sid,bastra_client:'claude-code',hook_event_name:'Stop',transcript:[{role:'assistant',content:'x'.repeat(30)}]}))?.action,'request');
});

test('one check can explicitly dismiss a large correspondence category without Stop blocks or false violations',async t=>{
 const sid='many-rules',base=(await catalog()).entries[0],large={entries:Array.from({length:65},(_,i)=>({...base,id:'corr-'+i,rule_categories:['correspondence' as const],validator:undefined})),omitted:0};
 const p={session_id:sid,bastra_client:'claude-code'};await beginRulebookRound(p,large);
 const input=RulebookCheckArgs.parse({applicable:[],not_applicable:large.entries.map(e=>skip(e.id))});
 assert.equal((await recordRulebookCheck(sid,input,large)).ok,true);
 assert.notEqual(JSON.parse((await rulebookBoundary(p,large,'stop'))??'{}').decision,'block');
 assert.doesNotMatch(await beginRulebookRound(p,large),/unchecked|ungeprüft|violations|Verstoß/);
 t.diagnostic(JSON.stringify({rules:65,checks:1,stop_blocks:0,payload_bytes:Buffer.byteLength(JSON.stringify(input))}));
});
test('declared-but-unloaded validator refresh follows the index without reading its blocked file',async t=>{
 const sid='declared-index';await begin(sid);await check(sid,{applicable:['copy-rule'],not_applicable:[skip('correspondence-rule')]});
 assert.equal((await loadSessionState(sid)).loadedConventions,undefined);
 await editMemoryHandler(live.deps,{id:'copy-rule',frontmatter:{validator:{...validator,limit:50}}});
 const file=vault.get('copy-rule')!.filePath,original=fs.readFile;let reads=0;
 t.mock.method(fs,'readFile',(...args:any[])=>{if(args[0]===file){reads++;return new Promise(()=>{});}return (original as any)(...args);});syncBuiltinESMExports();
 try{const out=await stop(sid,'x'.repeat(30));assert.notEqual(out.decision,'block');assert.doesNotMatch(JSON.stringify(out),/copy-repair/);assert.equal(reads,0);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();await editMemoryHandler(live.deps,{id:'copy-rule',frontmatter:{validator}});}
});
