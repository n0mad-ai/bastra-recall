import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {checkStopRepair} from '../src/stop-repair.js';
import {runStopLane} from '../src/stop-lane.js';
import {recordRulebookCheck,beginRulebookRound} from '../src/rulebook-check.js';
import {mutateSessionState} from '../src/session-state.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
import type {TranscriptTurn} from '../src/stop-transcript.js';

const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const catalog:KernelCandidates={entries:[{id:'copy-rule',title:'Copy',group:'explicit',rulebook:'on-demand',applies_when:'Copy',body:'Copy',revision:'r1',updated:null,stale_status:'unknown',validator}],omitted:0};
const payload=(sid:string)=>({session_id:sid,hook_event_name:'Stop',bastra_client:'claude-code',stop_hook_active:true});
const fence=(n:number)=>'```\n'+'x'.repeat(n)+'\n```';
async function sandbox(fn:()=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'repair-audit2-'));
 const values={BASTRA_HOOK_STATE_DIR:dir,BASTRA_TELEMETRY:'0',BASTRA_STOP_SAME_TURN:'1'};
 const old=new Map(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 try{await fn();}finally{for(const[k,v]of old){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(dir,{recursive:true,force:true});}
}
async function seed(sid:string,kind?:'draft-for-review'|'approved-copy'){
 if(kind)await mutateSessionState(sid,s=>{s.activeTask={id:kind+'@1',kind,since:1,generation:0};s.activeConventions=[{id:'copy-rule',revision:'r1',setAt:1,validator}];if(kind==='approved-copy')s.receipts=[{taskId:kind+'@1',generation:0,hash:'h',receipt:'sha256:h',channel:'discord-dm',limit:2000,unit:'max(codepoints,utf16)',at:1}];});
 await recordRulebookCheck(sid,{applicable:['copy-rule']},catalog);
}

for(const kind of [undefined,'draft-for-review','approved-copy'] as const)test('audit2 repair only measures output after its request: '+kind,async()=>sandbox(async()=>{
 const sid='heal-'+kind;await seed(sid,kind);
 const turns:TranscriptTurn[]=[{role:'user',content:'Antwort bitte'},{role:'assistant',content:fence(5000)}];
 assert.equal((await checkStopRepair(payload(sid),turns))?.action,'request');
 turns.push({role:'user',content:'Stop hook feedback: repair',isMeta:true},{role:'assistant',content:fence(1800)});
 assert.equal(await checkStopRepair(payload(sid),turns),null);
 assert.equal(await checkStopRepair(payload(sid),turns),null);
 turns.push({role:'assistant',content:fence(5000)});
 assert.equal((await checkStopRepair(payload(sid),turns))?.action,'request','new oversize still consumes second attempt');
}));
test('audit2 long intermediate prose is a report; intermediate fences remain copy',async()=>sandbox(async()=>{
 for(const explicit of [false,true]){
  const sid='intermediate-'+explicit;await seed(sid);
  const turns:TranscriptTurn[]=[{role:'user',content:'Prüfe das'},{role:'assistant',content:explicit?fence(5000):'Bericht '.repeat(800)},{role:'assistant',content:'',tools:['Bash']},{role:'tool',content:'ok'},{role:'assistant',content:'Fertig.'}];
  assert.equal((await checkStopRepair(payload(sid),turns))?.action??null,explicit?'request':null);
 }
}));
for(const boundary of [[{type:'image',source:{type:'base64',media_type:'image/png',data:'AA'}}],'<command-name>/foo</command-name>\n<command-message>foo</command-message>'])test('audit2 actual image/slash user turn ends measurement window: '+typeof boundary,async()=>sandbox(async()=>{
 const sid='boundary';await seed(sid);
 const transcript=[{role:'user',content:'a'},{role:'assistant',content:fence(5000)},{role:'user',content:boundary},{role:'assistant',content:'Kurz.'}];
 assert.equal(await checkStopRepair({...payload(sid),transcript}),null);
}));
test('audit2 runStopLane repair can heal on the real hook-active followup',async()=>sandbox(async()=>{
 const sid='lane-heal';await seed(sid);
 const transcript=[{role:'user',content:'Antwort'},{role:'assistant',content:fence(5000)}];
 assert.match(await runStopLane({...payload(sid),transcript},'http://127.0.0.1:1'),/copy-repair/);
 transcript.push({role:'assistant',content:fence(1800)});
 assert.equal(await runStopLane({...payload(sid),transcript},'http://127.0.0.1:1'),'{}');
}));
test('reported stages alone control prose; old delivery and repairProse never override a report',async()=>sandbox(async()=>{
 const sid='reported-stages';await seed(sid,'approved-copy');
 await mutateSessionState(sid,s=>{s.repairWindows={main:{scope:'old',length:0,tail:'old',delivered:s.activeTask!.id+':0'}};});
 assert.equal((await checkStopRepair(payload(sid),[{role:'assistant',content:'x'.repeat(2500)}]))?.action,'request');
 await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'draft-for-review'},catalog);
 assert.equal(await checkStopRepair(payload(sid),[{role:'assistant',content:'y'.repeat(2500)}]),null);
 await recordRulebookCheck(sid,{applicable:['copy-rule'],task:'none'},catalog);
 assert.equal(await checkStopRepair(payload(sid),[{role:'assistant',content:'z'.repeat(2500)}]),null);
 assert.equal((await checkStopRepair(payload(sid),[{role:'assistant',content:'> '+'z'.repeat(2500)}]))?.action,'request');
}));
test('audit2 tool metadata does not revive the already repaired copy',async()=>sandbox(async()=>{
 const sid='tools-after-repair';await seed(sid);
 const turns:TranscriptTurn[]=[{role:'assistant',content:fence(5000)}];
 assert.equal((await checkStopRepair(payload(sid),turns))?.action,'request');
 turns[0].tools=['validate_artifact'];turns[0].commands=['echo checked'];
 turns.push({role:'assistant',content:fence(1800)});
 assert.equal(await checkStopRepair(payload(sid),turns),null);
}));
test('audit2 Codex observes each round once and never mistakes corrected text for a new violation',async()=>sandbox(async()=>{
 const sid='codex';await seed(sid);
 const turns:TranscriptTurn[]=[{role:'user',content:'Antwort'},{role:'assistant',content:fence(5000)}];
 const p={...payload(sid),bastra_client:'codex'};
 assert.equal((await checkStopRepair(p,turns))?.action,'observed');
 turns.push({role:'assistant',content:fence(1800)});
 assert.equal(await checkStopRepair(p,turns),null);
}));
test('audit2 legacy task without rulebook state can heal after a repair',async()=>sandbox(async()=>{
 const sid='legacy-without-rulebook';await seed(sid,'approved-copy');
 await mutateSessionState(sid,s=>{delete s.rulebookCheck;});
 const turns:TranscriptTurn[]=[{role:'user',content:'passt'},{role:'assistant',content:'Kurze Endkopie.'}];
 assert.equal(await checkStopRepair(payload(sid),turns),null);
 turns.push({role:'assistant',content:'> '+'x'.repeat(2500)});
 assert.equal((await checkStopRepair(payload(sid),turns))?.action,'request');
 turns.push({role:'assistant',content:'> '+'x'.repeat(1800)});
 assert.equal(await checkStopRepair(payload(sid),turns),null);
}));
test('Codex observes approved prose and structural blocks independently of any delivery marker',async()=>sandbox(async()=>{
 const sid='codex-stages';await seed(sid,'approved-copy');
 const p={...payload(sid),bastra_client:'codex'};
 assert.equal(await checkStopRepair(p,[{role:'assistant',content:'Short copy.'}]),null);
 assert.equal((await checkStopRepair(p,[{role:'assistant',content:'x'.repeat(2500)}]))?.action,'observed');
}));
for(const kind of [undefined,'translate-only','draft-for-review'] as const)for(const shape of ['prose','fence','quote'] as const)test('structural measurement '+kind+' '+shape,async()=>sandbox(async()=>{
 const sid='structural';await seed(sid);
 if(kind)await recordRulebookCheck(sid,{applicable:['copy-rule'],task:kind},catalog);
 const text=shape==='prose'?'x'.repeat(2500):shape==='fence'?fence(2500):'> '+'x'.repeat(2500);
 assert.equal((await checkStopRepair(payload(sid),[{role:'assistant',content:text}]))?.action??null,shape==='prose'?null:'request');
}));

for(const kind of [undefined,'draft-for-review'] as const)test('round budget renews for six rounds despite stale task attempts: '+kind,async()=>sandbox(async()=>{
 const sid='six-rounds-'+kind;await seed(sid,kind);
 await mutateSessionState(sid,s=>{s.repairAttempts={taskId:s.activeTask?.id??'old',generation:0,count:3};});
 for(let round=0;round<6;round++){
  await beginRulebookRound(payload(sid),catalog);
  await recordRulebookCheck(sid,{applicable:['copy-rule'],...(kind?{task:kind}:{})},catalog);
  const turns:TranscriptTurn[]=[{role:'user',content:'Round '+round},{role:'assistant',content:fence(2500)}];
  for(let attempt=1;attempt<=3;attempt++){
   const result=await checkStopRepair(payload(sid),turns);
   assert.equal(result?.action,attempt<=2?'request':'exhausted');
   if(result?.action==='request')assert.equal(result.attempt,attempt);
   await recordRulebookCheck(sid,{applicable:['copy-rule'],...(kind?{task:kind}:{})},catalog);
   turns.push({role:'assistant',content:fence(2500)});
  }
  assert.equal(await checkStopRepair(payload(sid),turns),null);
 }
}));

test('repair messages distinguish overlength from missing receipt and identify the rule',async()=>sandbox(async()=>{
 for(const overlength of [true,false]){
  const sid='cause-'+overlength;await seed(sid,'approved-copy');
  if(!overlength)await mutateSessionState(sid,s=>{delete s.receipts;});
  const out=JSON.parse(await runStopLane({...payload(sid),transcript:[{role:'assistant',content:overlength?fence(2500):'Short copy'}]},'http://127.0.0.1:1'));
  assert.match(out.hookSpecificOutput.additionalContext,overlength?/exceeds the rule limit/:/without validated receipt/);
  assert.match(out.hookSpecificOutput.additionalContext,/Rules: copy-rule/);
  assert.match(out.systemMessage,/copy-rule/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext,overlength?/without validated receipt/:/exceeds the rule limit/);
 }
}));
