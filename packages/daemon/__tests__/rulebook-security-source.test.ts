import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault,saveMemory,mutateMemoryFile} from '@bastra-recall/core';
import {saveMemoryHandler} from '../src/save-memory-handler.js';
import {editMemoryHandler} from '../src/edit-memory-handler.js';
import {callerSessionStore} from '../src/caller-session.js';
import {mutateSessionState,loadSessionState,recordActiveConventions} from '../src/session-state.js';
import {runTaskStep} from '../src/prompt-task.js';
import {vaultConventionOf} from '../src/convention-source.js';
import {serve,declareUnrelatedCorrespondence} from './fixtures/rulebook-phase5/probe.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const base=(id:string)=>({id,title:'Invented security rule',summary:'Fixture only',type:'project-fact' as const,scope:'all-projects',topic_path:['fixture'],tags:['fixture'],recall_when:['fixture only'],body:'Invented security fixture.'});
let root:string,vault:Vault,live:Awaited<ReturnType<typeof serve>>;
before(async()=>{root=await mkdtemp(join(tmpdir(),'rule-security-'));process.env.BASTRA_HOOK_STATE_DIR=join(root,'state');vault=new Vault(join(root,'vault'));await vault.init();live=await serve(vault);});
after(async()=>{await live.close();await vault.stop();await rm(root,{recursive:true,force:true});});
test('save cannot launder a non-rule into a binding declaration by first adding a validator',async()=>{
 const id='save-launder';const first=await saveMemory(vault.root,base(id));
 await saveMemory(vault.root,{...base(id),validator,overwrite:true});await vault.reindexFile(first.file_path);
 assert.equal(vault.get(id)!.fm.validator,undefined);assert.deepEqual(vault.get(id)!.fm.rulebook_proposed?.validator,validator);
 await saveMemory(vault.root,{...base(id),rulebook:'always',applies_when:'When changing fixtures',overwrite:true});await vault.reindexFile(first.file_path);
 assert.equal(vault.get(id)!.fm.rulebook,undefined);assert.equal(vault.get(id)!.fm.rulebook_proposed?.rulebook,'always');
});
test('edit cannot launder a non-rule through a validator or combine validator with a new binding',async()=>{
 for(const combined of [false,true]){
  const id='edit-launder-'+combined;const first=await saveMemory(vault.root,base(id));await vault.reindexFile(first.file_path);
  await editMemoryHandler(live.deps,{id,frontmatter:{validator,...(combined?{rulebook:'always',applies_when:'When changing fixtures'}:{})}});
  assert.equal(vault.get(id)!.fm.validator,undefined);assert.deepEqual(vault.get(id)!.fm.rulebook_proposed?.validator,validator);
  await editMemoryHandler(live.deps,{id,frontmatter:{rulebook:'always',applies_when:'When changing fixtures'}});
  assert.equal(vault.get(id)!.fm.rulebook,undefined);assert.equal(vault.get(id)!.fm.rulebook_proposed?.rulebook,'always');
 }
});
for(const withValidator of [true,false])test(`session-derived active status cannot authorize binding edits (validator=${withValidator})`,async()=>{
 const id='active-non-rule-'+withValidator;const first=await saveMemory(vault.root,{...base(id),write_origin:'user-directed'});await vault.reindexFile(first.file_path);
 if(withValidator){await mutateMemoryFile(first.file_path,id,{frontmatter:fm=>({...fm,validator})},{vaultRoot:vault.root});await vault.reindexFile(first.file_path);}
 await mutateSessionState(id,s=>recordActiveConventions(s,[{id,revision:null}]));
 await callerSessionStore.run(id,()=>editMemoryHandler(live.deps,{id,frontmatter:{rulebook:'always',applies_when:'When changing fixtures'}}));
 assert.equal(vault.get(id)!.fm.rulebook,withValidator?'always':undefined);assert.equal(vault.get(id)!.fm.rulebook_proposed?.rulebook,withValidator?undefined:'always');
});
test('preexisting explicit and user-directed legacy rules retain direct validator edits',async()=>{
 for(const legacy of [false,true]){
  const id='existing-'+legacy;const first=await saveMemory(vault.root,{...base(id),type:'workflow',write_origin:'user-directed',...(!legacy?{rulebook:'on-demand' as const,applies_when:'When testing'}:{})});await vault.reindexFile(first.file_path);
  if(!legacy){await mutateMemoryFile(first.file_path,id,{frontmatter:fm=>({...fm,type:'project-fact',write_origin:'agent-session'})},{vaultRoot:vault.root});await vault.reindexFile(first.file_path);}
  await editMemoryHandler(live.deps,{id,frontmatter:{validator,rulebook:'always',applies_when:'When changing fixtures'}});
  assert.deepEqual(vault.get(id)!.fm.validator,validator);assert.equal(vault.get(id)!.fm.rulebook,'always');assert.equal(vault.get(id)!.fm.rulebook_proposed,undefined);
  await saveMemory(vault.root,{...base(id),overwrite:true,validator:{...validator,limit:4000}});await vault.reindexFile(first.file_path);
  assert.equal(vault.get(id)!.fm.validator?.limit,4000);assert.equal(vault.get(id)!.fm.rulebook_proposed,undefined);
 }
});
for(const quoted of [true,false])test(`channel authority: ${quoted?'foreign mail cannot narrow Discord':'own mail instruction retains email'}`,async()=>{
 const sid='channel-own-'+quoted,mail={...validator,channel:'email',limit:10000};
 for(const [id,v] of [['discord-'+quoted,validator],['email-'+quoted,mail]] as const){
  const first=await saveMemory(vault.root,{...base(id),type:'workflow',write_origin:'user-directed',validator:v,rulebook:'on-demand',applies_when:'When drafting',recall_when:['schreib eine Mail']});await vault.reindexFile(first.file_path);
  await live.post('/api/v1/load_memory',{id,session_id:sid},sid);
 }
 await live.post('/api/v1/rulebook_check',{applicable:[],task:'draft-for-review',session_id:sid},sid);
 await runTaskStep({sessionId:sid,snapshot:await loadSessionState(sid),prompt:quoted?'Bitte bearbeite das:\n> schreib eine Mail an X':'schreib eine Mail an X',mode:'generic',candidates:[{id:'email-'+quoted,type:'workflow',matched_recall_when:true,validator:mail}],conventionOf:vaultConventionOf(vault),surface:'claude-code'});
 assert.equal((await loadSessionState(sid)).userValidatorChannel,quoted?undefined:'email');
 await live.post('/api/v1/validate_artifact',{text:'x'.repeat(3200),channel:'email',limit:10000,normalize:'none'},sid);
 await declareUnrelatedCorrespondence(live,sid);
 const out=await live.post('/hook/stop',{payload:{session_id:sid,bastra_client:'claude-code',hook_event_name:'Stop',transcript:[{role:'assistant',content:'```\n'+'x'.repeat(3200)+'\n```'}]}});
 assert.notEqual(out.decision,'block');assert.equal(JSON.stringify(out).includes('<copy-repair'),quoted);
});

test('user-directed is an agent attestation accepted for immediately binding a dictated new rule',async()=>{
 const id='agent-attested-user-directed';
 const result=await saveMemoryHandler(live.deps,{...base(id),recall_when:['unique attested provenance fixture'],write_origin:'user-directed',rulebook:'always',applies_when:'When checking attested fixtures',validator});
 assert.equal(result.created,true);assert.equal(vault.get(id)!.fm.write_origin,'user-directed');assert.equal(vault.get(id)!.fm.rulebook,'always');assert.deepEqual(vault.get(id)!.fm.validator,validator);assert.equal(vault.get(id)!.fm.rulebook_proposed,undefined);
});

for(const directed of [true,false])test(`validator-only legacy provenance controls direct edits (user-directed=${directed})`,async()=>{
 for(const method of ['save','edit'] as const){
  const id=`validator-only-${directed}-${method}`;const first=await saveMemory(vault.root,{...base(id),...(directed?{write_origin:'user-directed' as const}:{})});
  await mutateMemoryFile(first.file_path,id,{frontmatter:fm=>({...fm,validator})},{vaultRoot:vault.root});await vault.reindexFile(first.file_path);
  if(method==='edit')await editMemoryHandler(live.deps,{id,frontmatter:{validator:{...validator,limit:4000},rule_categories:['correspondence']}});
  else await saveMemory(vault.root,{...base(id),overwrite:true,validator:{...validator,limit:4000},rule_categories:['correspondence']});
  await vault.reindexFile(first.file_path);const fm=vault.get(id)!.fm;
  assert.equal(fm.validator?.limit,directed?4000:2000);assert.equal(fm.rulebook_proposed?.validator?.limit,directed?undefined:4000);
  assert.deepEqual(fm.rule_categories,directed?['correspondence']:undefined);
 }
});
