import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {checkStopRepair} from '../src/stop-repair.js';
import {runStopLane} from '../src/stop-lane.js';
import {recordRulebookCheck} from '../src/rulebook-check.js';
import {mutateSessionState} from '../src/session-state.js';
import {loadSessionState} from '../src/session-state.js';
import {runTaskStep} from '../src/prompt-task.js';
import {storeReceipt} from '../src/receipt-store.js';
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
test('audit2 delivered receipt excludes explanatory prose but a requested revision checks prose again',async()=>sandbox(async()=>{
 const sid='delivered';await seed(sid,'approved-copy');
 const turns:TranscriptTurn[]=[{role:'user',content:'passt'},{role:'assistant',content:'Kurze Endkopie.'}];
 assert.equal(await checkStopRepair(payload(sid),turns),null);
 turns.push({role:'user',content:'Danke, erklär bitte den zweiten Absatz'},{role:'assistant',content:'Erklärung '.repeat(600)});
 assert.equal(await checkStopRepair(payload(sid),turns),null);
 // Explicit regions remain enforceable even after delivery.
 turns.push({role:'assistant',content:'> '+'x'.repeat(2001)});
 assert.equal((await checkStopRepair(payload(sid),turns))?.action,'request');
 await runTaskStep({sessionId:sid,prompt:'mach den zweiten Absatz persönlicher',snapshot:await loadSessionState(sid),mode:'generic',candidates:[],surface:'fixture'});
 await storeReceipt(sid,{artifact_sha256:'new',channel:'discord-dm',limit:2000,unit_applied:'max(codepoints,utf16)',receipt:'sha256:new'},undefined);
 turns.push({role:'user',content:'mach den zweiten Absatz persönlicher'},{role:'assistant',content:'Überarbeitete Kopie '.repeat(400)});
 assert.equal((await checkStopRepair(payload(sid),turns))?.action,'request');
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
test('audit2 Codex receipt delivery excludes later explanatory prose while explicit copy still counts',async()=>sandbox(async()=>{
 for(const quoted of [true,false]){
  const sid='codex-delivery-'+quoted;await seed(sid,'approved-copy');
  const p={...payload(sid),bastra_client:'codex'};
  const turns:TranscriptTurn[]=[{role:'user',content:'passt'},{role:'assistant',content:'Kurze Endkopie.'}];
  assert.equal(await checkStopRepair(p,turns),null);
  turns.push({role:'user',content:'Erkläre bitte die Entscheidung'},{role:'assistant',content:'Erklärung '.repeat(600)});
  assert.equal(await checkStopRepair(p,turns),null);
  turns.push({role:'assistant',content:quoted?'> '+'x'.repeat(2500):fence(2500)});
  assert.equal((await checkStopRepair(p,turns))?.action,'observed');
 }
 const sid='codex-delivery-revision';await seed(sid,'approved-copy');
 const p={...payload(sid),bastra_client:'codex'};
 const turns:TranscriptTurn[]=[{role:'user',content:'passt'},{role:'assistant',content:'Kurze Endkopie.'}];
 assert.equal(await checkStopRepair(p,turns),null);
 await runTaskStep({sessionId:sid,prompt:'mach den zweiten Absatz persönlicher',snapshot:await loadSessionState(sid),mode:'generic',candidates:[],surface:'fixture'});
 await storeReceipt(sid,{artifact_sha256:'new',channel:'discord-dm',limit:2000,unit_applied:'max(codepoints,utf16)',receipt:'sha256:new'},undefined);
 turns.push({role:'user',content:'mach den zweiten Absatz persönlicher'},{role:'assistant',content:'Überarbeitete Kopie '.repeat(400)});
 assert.equal((await checkStopRepair(p,turns))?.action,'observed');
}));
