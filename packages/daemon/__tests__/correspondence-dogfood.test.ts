/** Explicit task reports, never correspondence words, drive the prompt lane. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runPromptLane} from '../src/prompt-lane.js';
import {recordRulebookCheck} from '../src/rulebook-check.js';
import {loadSessionState} from '../src/session-state.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const entry={id:'fixture-correspondence',title:'Fixture',type:'workflow',scope:'all-projects',summary:'Fixture',score:150,matched_recall_when:true,validator};
const catalog:KernelCandidates={entries:[{id:entry.id,title:'Fixture',group:'explicit',rulebook:'on-demand',applies_when:'Fixture',body:'Fixture',revision:'r1',updated:null,stale_status:'unknown',validator,rule_categories:['correspondence']}],omitted:0};
const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/hook/recall'?{hits:[entry],score_kind:'rrf',vault_size:1}:{hits:[]}));});});
let root='',base='';const saved=new Map<string,string|undefined>();
before(async()=>{root=await mkdtemp(join(tmpdir(),'reported-dogfood-'));for(const [key,value] of Object.entries({BASTRA_HOOK_STATE_DIR:join(root,'state'),BASTRA_LOG_PATH:join(root,'logs'),BASTRA_TELEMETRY:'off',BASTRA_PROMPT_HOOK_MODE:'all'})){saved.set(key,process.env[key]);process.env[key]=value;}await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));for(const [key,value] of saved){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});});
const prompt=(sid:string,text:string)=>runPromptLane({hook_event_name:'UserPromptSubmit',session_id:sid,prompt:text,cwd:root},null,base,undefined,()=>[entry.id],{conventionOf:async()=>({revision:'r1',validator})});
test('prompt words, pasted blocks and foreign-language recall hits cannot create tasks',async()=>{
 for(const [i,text] of ['freigegeben','approved copy','Ответ одобрен','承認しました','schreib Max einen Antwortentwurf','<pasted_content>approved copy</pasted_content>','> freigegeben'].entries()){
  const sid='no-report-'+i;await prompt(sid,text);assert.equal((await loadSessionState(sid)).activeTask,undefined,text);
 }
});
test('new user turns never change a reported stage or channel',async()=>{
 const sid='reported';await recordRulebookCheck(sid,{applicable:[entry.id],task:'draft-for-review'},catalog);
 for(const text of ['passt','approved copy','Ответ одобрен','承認しました','/clear','Ein ganz anderes Thema','schreib eine Mail an Max']){
  await prompt(sid,text);const state=await loadSessionState(sid);assert.equal(state.activeTask?.kind,'draft-for-review',text);assert.equal(state.activeTask?.validatorChannel,undefined,text);
 }
});
