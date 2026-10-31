import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {Vault,saveMemory,mutateMemoryFile} from '@bastra-recall/core';
import {serve} from './fixtures/rulebook-phase5/probe.js';
import {recordRulebookLoad,recordRulebookCheck} from '../src/rulebook-check.js';
import {runTaskStep} from '../src/prompt-task.js';
import {runStopLane} from '../src/stop-lane.js';
import {loadSessionState,bumpTaskGeneration,clearShown} from '../src/session-state.js';
import {editMemoryHandler} from '../src/edit-memory-handler.js';
import {saveMemoryHandler} from '../src/save-memory-handler.js';
import {archiveMemoryHandler} from '../src/tool-handlers.js';
const dc={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const mail={...dc,channel:'email',limit:10000};
let root:string,vault:Vault,live:Awaited<ReturnType<typeof serve>>;
before(async()=>{root=await mkdtemp(join(tmpdir(),'p5-fix2-'));process.env.BASTRA_HOOK_STATE_DIR=join(root,'state');vault=new Vault(join(root,'vault'));await vault.init();live=await serve(vault);});
after(async()=>{await live.close();await vault.stop();await rm(root,{recursive:true,force:true});});
const catalog={entries:[],omitted:0};
const load=(sid:string,id:string,v:typeof dc|typeof mail)=>recordRulebookLoad(sid,id,null,{revision:'r1',validator:v,rulebookMetadata:{rulebook:'on-demand',applies_when:'Fixture'}});
const step=async(sid:string,prompt:string,email=false)=>runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),prompt,mode:'generic',candidates:email?[{id:'mail',type:'workflow',matched_recall_when:true,validator:mail}]:[],surface:'claude-code'});
const stop=async(sid:string)=>JSON.stringify(JSON.parse(await runStopLane({session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:'x'.repeat(3200)}]},live.url))).includes('<copy-repair');
test('S1: unrelated user turn removes an earlier channel before a new task',async()=>{
 const sid='S1';await load(sid,'dc',dc);await load(sid,'mail',mail);
 await step(sid,'Max hat mir per Mail geschrieben: Kannst du morgen kommen?',true);
 await step(sid,'Danke, erledigt. Neues Thema.');await step(sid,'Schreib Lisa auf Discord, dass ich später komme');
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);await live.post('/api/v1/validate_artifact',{text:'x'.repeat(3200),channel:'email',limit:10000,normalize:'none'},sid);assert.equal(await stop(sid),true);
});
test('S1c: compact/generation and clear remove the user channel',async()=>{
 const sid='S1c';await load(sid,'mail',mail);await step(sid,'Bitte antworte per Mail',true);
 await bumpTaskGeneration(sid);await clearShown(sid);await load(sid,'dc',dc);
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 assert.equal(await stop(sid),true);assert.equal((await loadSessionState(sid)).userValidatorChannel,undefined);
});
test('S2: an unloaded selected channel cannot filter out a loaded validator',async()=>{
 const sid='S2';await load(sid,'dc',dc);await step(sid,'Bitte antworte per Mail',true);
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);assert.equal(await stop(sid),true);
});
const input=(id:string)=>({id,title:'Invented validation rule',summary:'When drafting invented messages',type:'workflow' as const,scope:'all-projects',tags:['fixture'],topic_path:['fixture'],recall_when:['fixture'],write_origin:'user-directed' as const,rulebook:'on-demand' as const,applies_when:'When drafting invented messages',validator:dc,body:'Validate the invented copy.'});
async function fixture(id:string){const saved=await saveMemory(vault.root,input(id));await vault.reindexFile(saved.file_path);const sid=id;
 await live.post('/api/v1/load_memory',{id,session_id:sid},sid);assert.equal((await live.post('/api/v1/rulebook_check',{applicable:[id],task:'draft-for-review',session_id:sid},sid)).ok,true);return sid;}
const httpStop=async(sid:string)=>JSON.stringify(await live.post('/hook/stop',{payload:{session_id:sid,bastra_client:'claude-code',hook_event_name:'Stop',transcript:[{role:'assistant',content:'x'.repeat(3200)}]}})).includes('<copy-repair');
test('current indexed user limit applies at HTTP Stop without reading a blocked vault file',async t=>{
 const sid=await fixture('user-raise'),m=vault.get(sid)!;
 await mutateMemoryFile(m.filePath,sid,{frontmatter:fm=>({...fm,validator:{...dc,limit:4000}})},{vaultRoot:vault.root});
 await vault.reindexFile(m.filePath);
 await live.post('/api/v1/validate_artifact',{text:'x'.repeat(3200),channel:'discord-dm',limit:4000,normalize:'none'},sid);
 let reads=0;const original=fs.readFile;
 t.mock.method(fs,'readFile',(...args:any[])=>{if(args[0]===m.filePath){reads++;return new Promise(()=>{});}return (original as any)(...args);});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 assert.equal(await httpStop(sid),false);assert.equal(reads,0);
});
test('indexed user removal of the validator is effective at the next Stop',async()=>{
 const sid=await fixture('user-remove'),m=vault.get(sid)!;
 await mutateMemoryFile(m.filePath,sid,{frontmatter:fm=>{const next={...fm};delete next.validator;return next;}},{vaultRoot:vault.root});await vault.reindexFile(m.filePath);
 assert.equal(await httpStop(sid),false);
});
test('indexed user deletion of the rule removes its Stop obligation',async()=>{
 const sid=await fixture('user-delete'),path=vault.get(sid)!.filePath;await rm(path);vault.forgetFile(path);assert.equal(await httpStop(sid),false);
});
test('an unavailable source lookup is bounded and retains the last valid constraint',async()=>{
 const sid='slow-source';await load(sid,'dc',dc);await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 const start=Date.now();const out=await runStopLane({session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:'x'.repeat(3200)}]},live.url,{conventionOf:()=>new Promise(()=>{})});
 assert.ok(out.includes('<copy-repair'));assert.ok(Date.now()-start<1000);
});
test('agent edit changes the effective limit at the next indexed Stop without a proposal',async()=>{
 const sid=await fixture('agent-edit');
 await editMemoryHandler(live.deps,{id:sid,frontmatter:{validator:{...dc,limit:10000}},str_replace:{old_str:'Validate the invented copy.',new_str:'Use the updated copy rule.'}});
 assert.match(vault.get(sid)!.body,/Use the updated copy rule/);assert.equal(vault.get(sid)!.fm.validator!.limit,10000);assert.equal(vault.get(sid)!.fm.rulebook_proposed,undefined);
 await live.post('/api/v1/validate_artifact',{text:'x'.repeat(3200),channel:'discord-dm',limit:10000,normalize:'none'},sid);
 assert.equal(await httpStop(sid),false);
});
test('agent save removes the validator immediately and preserves write_origin provenance',async()=>{
 const sid=await fixture('agent-save');const {write_origin,...agentInput}=input(sid);
 await saveMemoryHandler(live.deps,{...agentInput,validator:null,overwrite:true});
 assert.equal(vault.get(sid)!.fm.validator,undefined);assert.equal(vault.get(sid)!.fm.rulebook_proposed,undefined);
 assert.equal(vault.get(sid)!.fm.write_origin,write_origin);assert.equal(await httpStop(sid),false);
});
test('agent archive removes the rule and its next Stop obligation',async()=>{
 const sid=await fixture('agent-archive');const result=await archiveMemoryHandler(live.deps,{id:sid});
 assert.ok(result.archived_to);assert.equal(vault.get(sid),undefined);assert.equal(await httpStop(sid),false);
});
test('agent overwrite makes a rule private without a proposal',async()=>{
 const sid=await fixture('agent-private');
 await saveMemoryHandler(live.deps,{...input(sid),sensitivity:'private',overwrite:true});
 assert.equal(vault.get(sid)!.fm.sensitivity,'private');
 assert.equal(vault.get(sid)!.fm.rulebook_proposed,undefined);assert.equal(await httpStop(sid),false);
});
test('agent edit channel and unit apply at the next Stop',async()=>{
 const sid=await fixture('agent-channel-unit');
 await editMemoryHandler(live.deps,{id:sid,frontmatter:{validator:{...dc,channel:'email',unit:'codepoints',limit:4000}}});
 assert.equal(vault.get(sid)!.fm.rulebook_proposed,undefined);
 await live.post('/api/v1/validate_artifact',{text:'x'.repeat(3200),channel:'email',unit:'codepoints',limit:4000,normalize:'none'},sid);
 assert.equal(await httpStop(sid),false);
 const state=await loadSessionState(sid);assert.deepEqual(state.loadedConventions?.find(c=>c.id===sid)?.validator,{...dc,channel:'email',unit:'codepoints',limit:4000});
});
test('agent supersession removes the predecessor Stop obligation without a proposal',async()=>{
 const sid=await fixture('agent-superseded');
 const result=await saveMemoryHandler(live.deps,{...input('replacement-rule'),recall_when:['replacement-only-scenario'],replaces:sid,validator:null});
 assert.equal(result.created,true);
 assert.equal(vault.get(sid)!.fm.superseded_by,'replacement-rule');
 assert.equal(vault.get(sid)!.fm.rulebook_proposed,undefined);assert.equal(await httpStop(sid),false);
});
