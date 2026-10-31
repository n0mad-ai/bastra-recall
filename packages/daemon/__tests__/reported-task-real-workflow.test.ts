import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordRulebookCheck} from '../src/rulebook-check.js';
import {runStopLane} from '../src/stop-lane.js';
import {validateArtifactHandler} from '../src/validate-artifact-handler.js';
import {callerSessionStore} from '../src/caller-session.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const catalog:KernelCandidates={entries:[{id:'copy-rule',title:'Synthetic rule',group:'explicit',rulebook:'on-demand',applies_when:'Synthetic',body:'Synthetic',revision:'r1',updated:null,stale_status:'unknown',validator}],omitted:0};
async function isolated(fn:()=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'reported-real-'));const keys=['BASTRA_HOOK_STATE_DIR','BASTRA_TELEMETRY','BASTRA_STOP_SAME_TURN'];const before=keys.map(k=>process.env[k]);Object.assign(process.env,{BASTRA_HOOK_STATE_DIR:dir,BASTRA_TELEMETRY:'0',BASTRA_STOP_SAME_TURN:'1'});try{await fn();}finally{keys.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];});await rm(dir,{recursive:true,force:true});}}
const stop=(sid:string,prompt:string,body:string)=>runStopLane({session_id:sid,hook_event_name:'Stop',bastra_client:'claude-code',stop_hook_active:true,transcript:[{role:'user',content:prompt},{role:'assistant',content:body}]},'http://127.0.0.1:1',{kernel:async()=>catalog});
for(const [language,prompt,copy] of [['ru','Обработай этот текст.','Спасибо за сообщение. '],['ja','この文章を扱ってください。','ご連絡ありがとうございます。']] as const)test('reported stages and actual index131 acceptance are independent of user wording: '+language,async()=>isolated(async()=>{
 const exact=await readFile(new URL('./fixtures/release118-draft-index131.txt',import.meta.url),'utf8');
 for(const task of ['translate-only','draft-for-review'] as const){
  const sid=language+'-'+task;assert.equal((await recordRulebookCheck(sid,{applicable:['copy-rule'],task},catalog)).ok,true);
  const result=await stop(sid,prompt,exact);assert.doesNotMatch(result,/copy-repair/,'actual translation plus German draft has zero repairs');
 }
 const sid=language+'-copy';await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'approved-copy'},catalog);
 const result=await callerSessionStore.run(sid,()=>validateArtifactHandler({text:Array.from({length:4},()=>copy.repeat(80)).join("\n\n"),channel:'discord-dm',normalize:'none'}));
 assert.deepEqual(result.errors,[]);assert.ok(result.receipt);assert.equal(result.receipt_stored,true);
 assert.doesNotMatch(await stop(sid,prompt,result.rendered),/copy-repair/,'validated copy blocks have zero repairs');
 const bad=language+'-oversize';await recordRulebookCheck(bad,{applicable:['copy-rule'],task:'draft-for-review'},catalog);
 const repair=await stop(bad,prompt,'```\n'+'x'.repeat(2001)+'\n```');assert.match(repair,/copy-repair/);assert.match(repair,/1\/2/,'one repair for one oversized fence');
}));
test('unreported ordinary prose is never measured; quotes are checked even in translation',async()=>isolated(async()=>{
 const sid='ordinary';await recordRulebookCheck(sid,{applicable:['copy-rule']},catalog);
 assert.doesNotMatch(await stop(sid,'合成の入力','x'.repeat(5000)),/copy-repair/);
 await recordRulebookCheck('quote',{applicable:['copy-rule'],task:'translate-only'},catalog);
 assert.match(await stop('quote','Синтетический ввод','> '+'x'.repeat(2001)),/copy-repair/);
}));
