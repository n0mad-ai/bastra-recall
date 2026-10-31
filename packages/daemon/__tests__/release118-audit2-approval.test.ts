import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {yes,no} from './fixtures/release118-approval-matrix.js';
import {taskSignals,decideTask} from '../src/prompt-classify.js';
import {recordRulebookCheck} from '../src/rulebook-check.js';
import {checkStopRepair} from '../src/stop-repair.js';
import {runTaskStep} from '../src/prompt-task.js';
import {loadSessionState,mutateSessionState} from '../src/session-state.js';
import {storeReceipt} from '../src/receipt-store.js';
import {hasReviewDraft} from '../src/stop-task.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const catalog:KernelCandidates={entries:[{id:'copy-rule',title:'Fixture',group:'explicit',rulebook:'on-demand',applies_when:'Correspondence',body:'Fixture',revision:'r1',updated:null,stale_status:'unknown',validator,rule_categories:['correspondence']}],omitted:0};
test('audit2 approval matrix: all 133 approvals and zero of 94 refusals',()=>{
 assert.equal(yes.length,133);assert.equal(no.length,94);
 const ctx={current:'draft-for-review' as const,draftPresented:true,questionOpen:false,mode:'trivial' as const,hitActive:false};
 const missed=yes.filter(p=>decideTask(taskSignals(p),ctx).next!=='approved-copy');
 const falsePositives=no.filter(p=>decideTask(taskSignals(p),ctx).next==='approved-copy');
 assert.deepEqual(falsePositives,[]);assert.deepEqual(missed,[]);
});
test('audit2 draft evidence: prose, captions, declaration order, missing transcript, questions, revision',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'audit2-approval-'));const old=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=dir;
 const step=async(sid:string,prompt:string)=>runTaskStep({sessionId:sid,prompt,snapshot:await loadSessionState(sid),mode:'generic',candidates:[],surface:'fixture'});
 const stop=async(sid:string,text?:string)=>checkStopRepair({session_id:sid,bastra_client:'claude-code',...(text?{transcript:[{role:'user',content:'Antworte Max'},{role:'assistant',content:text}]}:{})});
 try{
  for(const [i,text] of ['Hallo Max, danke für deine Nachricht. Viele Grüße, Daniel','**Entwurf:**\nHallo Max, danke für deine Nachricht.',undefined].entries()){
   const sid='prose-'+i;await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'draft-for-review'},catalog);await stop(sid,text);await step(sid,'passt');assert.equal((await loadSessionState(sid)).activeTask?.kind,'approved-copy',text);
  }
  const sid='question';await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'draft-for-review'},catalog);
  await stop(sid,'```\nHallo Max, danke für deine Nachricht.\n```');await step(sid,'kürzer bitte');
  assert.equal((await loadSessionState(sid)).activeTask?.draftPresented,false);
  await stop(sid,'Soll die Anrede per Du bleiben?');await step(sid,'ja');assert.equal((await loadSessionState(sid)).activeTask?.kind,'draft-for-review');
  await stop(sid,'Ich sehe erst nach:\n```bash\ngit status\n```');await step(sid,'ja');assert.equal((await loadSessionState(sid)).activeTask?.kind,'draft-for-review');
 }finally{if(old===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=old;await rm(dir,{recursive:true,force:true});}
});
test('audit2 acknowledgement survives a question without granting approval',()=>{
 const decision=decideTask(taskSignals('ok, und was ist mit dem dritten Absatz?'),{current:'draft-for-review',draftPresented:true,questionOpen:false,mode:'generic',hitActive:false,hitOther:true});
 assert.equal(decision.next,null);
 for(const prompt of ['Was meinst du?','Was hältst du davon?','What do you mean?','Was ist mit der Anrede?']) {
  assert.equal(decideTask(taskSignals(prompt),{current:'approved-copy',questionOpen:false,mode:'generic',hitActive:false,hitOther:false}).next,null,prompt);
 }
});
test('audit2 observed commands and clarification with polite suffix do not attest a draft',()=>{
 assert.equal(hasReviewDraft('```\nnpm test\n```'),false);
 assert.equal(hasReviewDraft('**Entwurf:**\n```bash\ngit status\n```'),false);
 assert.equal(hasReviewDraft('Entwurf:\n```\nnpm test\n```'),false);
 assert.equal(hasReviewDraft('Soll ich die Fassung auf Englisch liefern?\n\nDanke.'),false);
 assert.equal(hasReviewDraft('```\n'+'x'.repeat(200)+'\n```'),true);
 assert.equal(hasReviewDraft('```\nthanks for your help\n```'),true);
 assert.equal(hasReviewDraft('**Entwurf:**\nHallo Max'),true);
 assert.equal(hasReviewDraft('Hallo Max,\nkurz.\nGruss'),true);
 for(const text of ['Entwurf:\nSoll ich den dritten Absatz kürzen?','**Entwurf:**\nSoll ich den dritten Absatz kürzen?','## Draft\nShould I shorten the second paragraph?','**Antwortvorschlag**\nSoll ich per Du schreiben?']) assert.equal(hasReviewDraft(text),false,text);
 assert.equal(hasReviewDraft('**Entwurf:**\nHallo Max,\n\nkannst du mir den aktuellen Stand schicken?'),true);
});
test('audit2 scenario boundaries: same-turn off, declaration after output, final prose and revisions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'audit2-scenarios-'));const old=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=dir;
 const step=async(sid:string,prompt:string)=>runTaskStep({sessionId:sid,prompt,snapshot:await loadSessionState(sid),mode:'generic',candidates:[],surface:'fixture'});
 const stop=(sid:string,content:string,at?:number)=>checkStopRepair({session_id:sid,bastra_client:'claude-code'},[{role:'user',content:'Antworte Max',at:at?at-1000:undefined},{role:'assistant',content,at}]);
 const draft=async(sid:string)=>recordRulebookCheck(sid,{applicable:['copy-rule'],task:'draft-for-review'},catalog);
 try{
  await draft('off');const off=process.env.BASTRA_STOP_SAME_TURN;process.env.BASTRA_STOP_SAME_TURN='0';
  try{await stop('off','Hallo Max, danke für deine Nachricht.');}finally{if(off===undefined)delete process.env.BASTRA_STOP_SAME_TURN;else process.env.BASTRA_STOP_SAME_TURN=off;}
  await step('off','passt');assert.equal((await loadSessionState('off')).activeTask?.kind,'approved-copy');
  const prior=Date.now()-5000;await draft('before');await stop('before','Hallo Max, danke für deine Nachricht.',prior);await step('before','passt');assert.equal((await loadSessionState('before')).activeTask?.kind,'approved-copy');
  await draft('s10');assert.equal(await stop('s10','Hallo Max, '.repeat(500)),null);await step('s10','passt');assert.equal((await loadSessionState('s10')).activeTask?.kind,'approved-copy');assert.equal((await stop('s10','Hallo Max, '.repeat(500)))?.action,'request');
  await recordRulebookCheck('s10-user',{applicable:['copy-rule']},catalog);await step('s10-user','schreib Max einen Antwortentwurf');assert.equal((await loadSessionState('s10-user')).activeTask?.kind,'draft-for-review');assert.equal(await stop('s10-user','Hallo Max, '.repeat(500)),null);await step('s10-user','passt');assert.equal((await stop('s10-user','Hallo Max, '.repeat(500)))?.action,'request');
  for(const [i,prompt] of ['mach den zweiten Absatz persönlicher','zweiter absatz raus','zeig den text nochmal','noch mal bitte','make it friendlier','drop the second paragraph','kürzer','schreib es neu','antworte ihm nochmal'].entries()){
   const sid='revision-'+i;await draft(sid);await step(sid,'passt');
   await storeReceipt(sid,{artifact_sha256:'h',channel:'discord-dm',limit:2000,unit_applied:'max(codepoints,utf16)',receipt:'sha256:x'},undefined);
   await mutateSessionState(sid,s=>{s.repairWindows={main:{scope:'fixture',length:0,tail:'x',delivered:`${s.activeTask!.id}:${s.activeTask!.generation}`}};});
   await step(sid,prompt);const s=await loadSessionState(sid);assert.equal(s.activeTask?.kind,'approved-copy',prompt);assert.equal(s.repairWindows?.main?.delivered,undefined,prompt);assert.equal(s.receipts?.length??0,0,prompt);
   assert.equal((await stop(sid,'Hallo Max, '.repeat(500)))?.action,'request',prompt);
  }
 }finally{if(old===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=old;await rm(dir,{recursive:true,force:true});}
});
test('audit2 real prompt-to-stop: explaining a paragraph retains delivered receipt in both clients',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'audit2-explain-'));const old=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=dir;
 try{for(const client of ['claude-code','codex']){
  const sid='explain-'+client;
  await mutateSessionState(sid,s=>{s.activeTask={id:'copy',kind:'approved-copy',since:1,generation:0,approvalSource:'user-turn'};s.activeConventions=[{id:'copy-rule',revision:'r1',setAt:1,validator}];});
  await recordRulebookCheck(sid,{applicable:['copy-rule']},catalog);
  await storeReceipt(sid,{artifact_sha256:'h',channel:'discord-dm',limit:2000,unit_applied:'max(codepoints,utf16)',receipt:'sha256:x'},undefined);
  const first=[{role:'user',content:'English copy'},{role:'assistant',content:'Hi Max, thank you for the update.'}];
  const payload={session_id:sid,bastra_client:client};assert.equal(await checkStopRepair(payload,first),null);
  const prompt='Erklär den Absatz bitte';
  await runTaskStep({sessionId:sid,prompt,snapshot:await loadSessionState(sid),mode:'generic',candidates:[],surface:'fixture'});
  assert.equal((await loadSessionState(sid)).receipts?.length,1,client);
  assert.equal(await checkStopRepair(payload,[...first,{role:'user',content:prompt},{role:'assistant',content:'Erklärung '.repeat(600)}]),null,client);
 }}finally{if(old===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=old;await rm(dir,{recursive:true,force:true});}
});
