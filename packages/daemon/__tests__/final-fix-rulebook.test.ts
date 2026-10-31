import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Vault,saveMemory} from '@bastra-recall/core';
import {serve} from './fixtures/rulebook-phase5/probe.js';
import {beginRulebookRound,recordRulebookLoad,recordRulebookCheck,roundCorrespondence} from '../src/rulebook-check.js';
import {cachedRulebookCatalog} from '../src/rulebook-catalog.js';
import {loadSessionState,mutateSessionState,recordActiveConventions} from '../src/session-state.js';
import {refreshStopValidators} from '../src/stop-validator-source.js';
import {checkStopRepair} from '../src/stop-repair.js';
import {setPrimaryLanguage} from '../src/settings.js';
const validator={tool:'validate_artifact',channel:'fixture-copy',limit:12,unit:'utf16'} as const;
let root:string,vault:Vault,live:Awaited<ReturnType<typeof serve>>;
before(async()=>{root=await mkdtemp(join(tmpdir(),'final-rules-'));process.env.BASTRA_HOOK_STATE_DIR=join(root,'state');vault=new Vault(join(root,'vault'));await vault.init();for(const id of ['copy','other']){const m=await saveMemory(vault.root,{id,title:'Invented rule',summary:'Invented scope',body:'Invented body',type:'workflow',scope:'all-projects',write_origin:'user-directed',rulebook:'on-demand',applies_when:'Invented scope',rule_categories:['correspondence'],...(id==='copy'?{validator}:{}),topic_path:['fixture'],tags:['fixture'],recall_when:['fixture']});await vault.reindexFile(m.file_path);}live=await serve(vault);});
after(async()=>{await live.close();await vault.stop();await rm(root,{recursive:true,force:true});});
const catalog=()=>cachedRulebookCatalog(vault,{project:null,active:[]});
const skip=(id:string)=>({id,reason:'This round only reports unrelated technical work.'});
const source={revision:'r1',validator,rulebookMetadata:{rulebook:'on-demand' as const}};
for(const reflex of [false,true])test(`later unrelated rounds can dismiss ${reflex?'reflex without task':'past load'}`,async()=>{
 const sid=`later-${reflex}`,c=await catalog();await beginRulebookRound({session_id:sid},c);
 if(reflex)await mutateSessionState(sid,s=>recordActiveConventions(s,[{id:'copy',revision:'r1',validator}]));else await recordRulebookLoad(sid,'copy',null,source);
 for(let i=0;i<3;i++){
 await beginRulebookRound({session_id:sid},c);
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[skip('copy'),skip('other')]},c)).ok,true);
 await refreshStopValidators(sid,async()=>source,Date.now()+1000);
 assert.equal(roundCorrespondence(await loadSessionState(sid)).rules.length,0);
 for(let stop=0;stop<3;stop++)assert.equal(await checkStopRepair({session_id:sid,bastra_client:'claude-code'},[{role:'assistant',content:'x'.repeat(3501)}]),null);
 }
});
test('protected ID is ignored while the remaining declarations count; notice is German',async()=>{
 const sid='partial',c=await catalog();await setPrimaryLanguage('de');await beginRulebookRound({session_id:sid},c);
 await mutateSessionState(sid,s=>{s.activeTask={id:sid,kind:'draft-for-review',since:Date.now(),generation:0};recordActiveConventions(s,[{id:'copy',revision:'r1',scope:'task',validator}]);});
 const result=await recordRulebookCheck(sid,{applicable:[],not_applicable:[skip('copy'),skip('other')]},c);assert.equal(result.ok,false);
 const state=await loadSessionState(sid),a=JSON.parse(state.rulebookCheck!).actors[0];assert.ok(a.roundDismissed.some((r:any)=>r.id==='other'));assert.equal(a.checked,true);assert.ok(a.roundDismissed.every((r:any)=>r.id!=='copy'));
 assert.equal((await checkStopRepair({session_id:sid,bastra_client:'claude-code'},[{role:'assistant',content:'x'.repeat(30)}]))?.action,'request');
 const note=await beginRulebookRound({session_id:sid},c);assert.doesNotMatch(note,/Rulebook dismissal ignored/);assert.match(note,/Abmeldung.*ignoriert/);await setPrimaryLanguage('en');
});
