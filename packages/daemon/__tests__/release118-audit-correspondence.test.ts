/** Cross-audit regressions: user authority and complete-round copy accounting. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordRulebookCheck,beginRulebookRound} from '../src/rulebook-check.js';
import {runStopLane} from '../src/stop-lane.js';
import {checkStopRepair} from '../src/stop-repair.js';
import {decideTask,taskSignals} from '../src/prompt-classify.js';
import {runTaskStep} from '../src/prompt-task.js';
import {loadSessionState,mutateSessionState} from '../src/session-state.js';
import {storeReceipt} from '../src/receipt-store.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const catalog:KernelCandidates={entries:[{id:'copy-rule',title:'Fixture',group:'explicit',rulebook:'on-demand',applies_when:'Correspondence',body:'Fixture',revision:'r1',updated:null,stale_status:'unknown',validator,rule_categories:['correspondence']}],omitted:0};
const payload=(sid:string)=>({session_id:sid,bastra_client:'claude-code',hook_event_name:'Stop'});
async function sandbox(fn:()=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'audit-correspondence-'));const old=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=dir;try{await fn();}finally{if(old===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=old;await rm(dir,{recursive:true,force:true});}}
const step=async(sid:string,prompt:string)=>runTaskStep({sessionId:sid,prompt,snapshot:await loadSessionState(sid),mode:'generic',candidates:[],surface:'fixture'});
const stop=(sid:string,content:string)=>checkStopRepair({...payload(sid),transcript:[{role:'assistant',content}]});
async function draft(sid:string){await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'draft-for-review'},catalog);}
async function approved(sid:string){await mutateSessionState(sid,s=>{s.activeTask={id:'approved-copy@1',kind:'approved-copy',since:1,generation:0,approvalSource:'user-turn'};s.activeConventions=[{id:'copy-rule',revision:'r1',setAt:1,validator}];});await recordRulebookCheck(sid,{applicable:['copy-rule']},catalog);await storeReceipt(sid,{artifact_sha256:'h',channel:'discord-dm',limit:2000,unit_applied:'max(codepoints,utf16)',receipt:'sha256:x'},undefined);}
test('audit1: refusal and questions never grant approval, even after an actual draft',async()=>sandbox(async()=>{
 for(const [i,prompt] of ['nicht freigegeben','noch nicht freigegeben, bitte kuerzen','ist das freigegeben?','not approved copy yet','approved copy?','nicht ok, mach die englische Fassung','ok, ist das die englische Fassung?','ok, nicht die englische Fassung','ok, do not translate yet'].entries()){
 const sid='refusal-'+i;await draft(sid);await stop(sid,'```\nKurzer Vorschlag.\n```');await step(sid,prompt);assert.notEqual((await loadSessionState(sid)).activeTask?.kind,'approved-copy',prompt);
 }
}));
test('audit2: clear owner approval recovers an active draft with unavailable evidence',async()=>sandbox(async()=>{
 await draft('unseen');await step('unseen','ja');assert.equal((await loadSessionState('unseen')).activeTask?.kind,'approved-copy');
 await stop('unseen','```\nKurzer Vorschlag.\n```');await step('unseen','passt');assert.equal((await loadSessionState('unseen')).activeTask?.approvalSource,'user-turn');
 await draft('compound');await stop('compound','```\nKurzer Vorschlag.\n```');await step('compound','ok, mach die englische Fassung');assert.equal((await loadSessionState('compound')).activeTask?.kind,'approved-copy');
}));
test('audit2: earlier assistant copy survives tools, system messages and the short closing text, with and without task',async()=>sandbox(async()=>{
 for(const task of [false,true]){const sid='all-text-'+task;if(task)await approved(sid);else await recordRulebookCheck(sid,{applicable:['copy-rule']},catalog);
 assert.equal((await checkStopRepair(payload(sid),[{role:'user',content:'passt'},{role:'assistant',content:'```\n'+'x'.repeat(5000)+'\n```'},{role:'assistant',content:'',tools:['Bash']},{role:'tool',content:'ok'},{role:'system',content:'injected'},{role:'assistant',content:'Fertig.'}]))?.action,'request',sid);
 }
}));
test('audit2: a genuine new user boundary excludes old assistant text; injected user text does not',async()=>sandbox(async()=>{
 await recordRulebookCheck('boundary',{applicable:['copy-rule']},catalog);
 assert.equal(await checkStopRepair(payload('boundary'),[{role:'assistant',content:'x'.repeat(5000)},{role:'user',content:'Neue Frage'},{role:'assistant',content:'Kurz.'}]),null);
 assert.equal((await checkStopRepair(payload('boundary'),[{role:'assistant',content:'```\n'+'x'.repeat(5000)+'\n```'},{role:'user',content:'<system-reminder>Hook</system-reminder>',isMeta:true},{role:'assistant',content:'Kurz.'}]))?.action,'request');
}));
test('audit3: model draft retains the exact index131 zero-repair priority (documented prose limitation)',async()=>sandbox(async()=>{
 const text=await readFile(new URL('./fixtures/release118-draft-index131.txt',import.meta.url),'utf8');await draft('real');for(let i=0;i<3;i++)assert.equal(await stop('real',text),null);
}));
test('audit4: draft quotes of the incoming original never count, fences still do',async()=>sandbox(async()=>{
 await draft('quote');assert.equal(await stop('quote',Array.from({length:40},()=>'> Interesting, listen, about that idea of routines and skills.').join('\n')+'\n\n```\nKurzer Vorschlag.\n```'),null);
 assert.equal((await stop('quote','> Original\n```\n'+'x'.repeat(2001)+'\n```'))?.action,'request');
}));
test('audit5: validated copy followed by an ordinary question ends copy task and avoids prose repairs',async()=>sandbox(async()=>{
 await approved('followup');assert.equal(await stop('followup','```\nKurze geprüfte Kopie.\n```'),null);
 await runTaskStep({sessionId:'followup',prompt:'Wie ist eigentlich der Unterschied zwischen Routinen und Skills in deinem Plan?',snapshot:await loadSessionState('followup'),mode:'generic',candidates:[{id:'other-topic',type:'project-fact'}],surface:'fixture'});assert.equal((await loadSessionState('followup')).activeTask?.kind,'none');
 await beginRulebookRound(payload('followup'),catalog);assert.equal((await recordRulebookCheck('followup',{applicable:[],not_applicable:[{category:'correspondence',reason:'Technical question without message composition'}]},catalog)).ok,true);
 assert.equal(await stop('followup','Erklaerung '.repeat(300)),null);
}));

test('audit2: observed progress blocks approval; worker output leaves main evidence unavailable',async()=>sandbox(async()=>{
 for (const [sid,text,agent] of [['progress','Fertig.',undefined],['child','```\nKurzer Entwurf.\n```','worker']] as const) {
  await draft(sid);await checkStopRepair({...payload(sid),agent_id:agent,transcript:[{role:'assistant',content:text}]});await step(sid,'ja');assert.equal((await loadSessionState(sid)).activeTask?.kind,agent?'approved-copy':'draft-for-review',sid);
 }
}));

test('audit1: real worker Stop cannot create a main review task with draft evidence',async()=>sandbox(async()=>{
 await recordRulebookCheck('worker-lane',{applicable:['copy-rule']},catalog);
 await runStopLane({...payload('worker-lane'),agent_id:'worker',stop_hook_active:true,transcript:[{role:'assistant',content:'Deutscher Entwurf zur Freigabe:\n\n```\nKurzer Entwurf.\n```'}]},'http://127.0.0.1:1');
 await step('worker-lane','ja');assert.notEqual((await loadSessionState('worker-lane')).activeTask?.kind,'approved-copy');assert.equal((await loadSessionState('worker-lane')).activeTask,undefined);
}));

test('audit2: unknown draft evidence permits clear approval; observed non-draft does not',()=>{
 const ctx={current:'draft-for-review' as const,questionOpen:false,mode:'trivial' as const,hitActive:false};
 assert.equal(decideTask(taskSignals('ja'),ctx).next,'approved-copy');assert.equal(decideTask(taskSignals('ja'),{...ctx,draftPresented:false}).next,null);assert.equal(decideTask(taskSignals('passt'),{...ctx,draftPresented:true}).next,'approved-copy');
});
test('audit1: complete positive copy clauses remain extensible through the runtime lexicon',async()=>sandbox(async()=>{
 await draft('fr-unknown');await step('fr-unknown','ok, donne la version française');assert.equal((await loadSessionState('fr-unknown')).activeTask?.kind,'approved-copy','sentence-opening approval does not need a complete-clause vocabulary');
 const dir=join(process.env.BASTRA_HOOK_STATE_DIR!,'lexicon');await mkdir(dir);await writeFile(join(dir,'target-copy-request.txt'),'donne la version française\n');await writeFile(join(dir,'task-approval.txt'),'oui\n');
 const old=process.env.BASTRA_LEXICON_DIR;process.env.BASTRA_LEXICON_DIR=dir;
 try{await draft('fr');await step('fr','oui, donne la version française');assert.equal((await loadSessionState('fr')).activeTask?.kind,'approved-copy');
 await draft('fr-no');await step('fr-no','non, donne la version française');assert.equal((await loadSessionState('fr-no')).activeTask?.kind,'draft-for-review');}
 finally{if(old===undefined)delete process.env.BASTRA_LEXICON_DIR;else process.env.BASTRA_LEXICON_DIR=old;}
}));
test('audit2: separate messages stay separate; only new offending output consumes another repair attempt',async()=>sandbox(async()=>{
 await recordRulebookCheck('separate',{applicable:['copy-rule']},catalog);
 assert.equal(await checkStopRepair(payload('separate'),[{role:'assistant',content:'x'.repeat(1100)},{role:'assistant',content:'y'.repeat(1100)}]),null);
 await recordRulebookCheck('historical',{applicable:['copy-rule']},catalog);
 const turns=[{role:'assistant',content:'```\n'+'x'.repeat(5000)+'\n```'},{role:'user',source:'agent',content:'A harness handback'},{role:'assistant',content:'```\nCorrected short text.\n```'}];
 assert.equal((await checkStopRepair({...payload('historical'),stop_hook_active:true},turns))?.action,'request');
 turns.push({role:'assistant',content:'```\nCorrected after the repair request.\n```'});
 assert.equal(await checkStopRepair({...payload('historical'),stop_hook_active:true},turns),null);
 for(const action of ['request','exhausted']) {
  turns.push({role:'assistant',content:'```\n'+'x'.repeat(5000)+'\n```'});
  assert.equal((await checkStopRepair({...payload('historical'),stop_hook_active:true},turns))?.action,action);
 }
 assert.equal(await checkStopRepair({...payload('historical'),stop_hook_active:true},turns),null);
}));
test('audit3: the remaining model-draft prose bypass is explicit; fenced copy is still strict',async()=>sandbox(async()=>{
 await recordRulebookCheck('plain',{applicable:['copy-rule']},catalog);assert.equal((await stop('plain','x'.repeat(2001)))?.action,'request');
 await draft('model-plain');assert.equal(await stop('model-plain','x'.repeat(2001)),null);
 assert.equal((await stop('model-plain','```\n'+'x'.repeat(2001)+'\n```'))?.action,'request');
}));

test('audit1: full approval prefix accepts a whole positive mail clause, never negated or interrogative tails',async()=>sandbox(async()=>{
 for (const [i,prompt] of ['approved copy, per Mail antworten','freigegeben, per Mail antworten','approved copy, reply by email'].entries()) {
  const sid='mail-positive-'+i;await draft(sid);await stop(sid,'```\nKurzer Entwurf.\n```');await step(sid,prompt);assert.equal((await loadSessionState(sid)).activeTask?.kind,'approved-copy',prompt);
 }
 for (const [i,prompt] of ['not approved copy, per Mail antworten','approved copy, nicht per Mail antworten','approved copy, do not reply by email','approved copy, reply by email?','per Mail antworten'].entries()) {
  const sid='mail-negative-'+i;await draft(sid);await stop(sid,'```\nKurzer Entwurf.\n```');await step(sid,prompt);assert.equal((await loadSessionState(sid)).activeTask?.kind,'draft-for-review',prompt);
 }
}));
for (const prompt of ['mach die englische Fassung','give me the English version']) test('audit1 direct target-language request: '+prompt,async()=>sandbox(async()=>{
 const sid='direct-target';await draft(sid);await stop(sid,'```\nKurzer tatsächlich präsentierter Entwurf.\n```');
 await step(sid,prompt);assert.equal((await loadSessionState(sid)).activeTask?.kind,'approved-copy',prompt);
}));
test('audit1 real index131: model draft → exact unfenced reply → passt preserves approval',async()=>sandbox(async()=>{
 const text=await readFile(new URL('./fixtures/release118-draft-index131.txt',import.meta.url),'utf8');
 assert.ok(!text.includes('```'));assert.ok(text.includes('**Antwortvorschlag**'));
 await draft('real-approval');for(let i=0;i<3;i++)assert.equal(await stop('real-approval',text),null);
 await step('real-approval','passt');assert.equal((await loadSessionState('real-approval')).activeTask?.kind,'approved-copy');assert.equal((await loadSessionState('real-approval')).activeTask?.approvalSource,'user-turn');
}));
test('audit1 real index131: worker copy of the exact draft and ordinary progress headings do not approve main',async()=>sandbox(async()=>{
 const text=await readFile(new URL('./fixtures/release118-draft-index131.txt',import.meta.url),'utf8');
 await draft('real-worker');await checkStopRepair({...payload('real-worker'),agent_id:'worker',transcript:[{role:'assistant',content:text}]});await step('real-worker','passt');assert.equal((await loadSessionState('real-worker')).activeTask?.kind,'approved-copy');
 for(const [i,content] of ['**Status**\n\nFertig.','# Progress\n\nWorking.','**Deutscher Entwurf fehlt**\n\nFertig.'].entries()) {const sid='progress-heading-'+i;await draft(sid);await stop(sid,content);await step(sid,'passt');assert.equal((await loadSessionState(sid)).activeTask?.kind,content.startsWith('Ich schreibe')?'approved-copy':'draft-for-review',content);}
}));

test('audit1 review captions: complete Markdown headings need no colon, mentions and missing bodies do not attest output',async()=>sandbox(async()=>{
 for(const [i,heading] of ['**Deutscher Entwurf**','__Deutscher Entwurf__','## Deutscher Entwurf','## Deutscher Entwurf ##','Deutscher Entwurf:','**Deutscher Entwurf:**'].entries()) {
  const sid='review-caption-'+i;await draft(sid);await stop(sid,heading+'\n\nHallo Alex, bitte prüfe die Frage.');await step(sid,'passt');assert.equal((await loadSessionState(sid)).activeTask?.kind,'approved-copy',heading);
 }
 for(const [i,content] of ['Ich schreibe einen Deutschen Entwurf.\n\nFertig.','**Deutscher Entwurf**','## Deutscher Entwurf fehlt\n\nFertig.'].entries()) {
  const sid='no-review-caption-'+i;await draft(sid);await stop(sid,content);await step(sid,'passt');assert.equal((await loadSessionState(sid)).activeTask?.kind,content.startsWith('Ich schreibe')?'approved-copy':'draft-for-review',content);
 }
}));
