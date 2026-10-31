import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalizeTurns} from '../src/stop-transcript.js';
import {harvestCandidates} from '../src/session-harvest.js';
import {optionPicks,askAnswers} from '../src/stop-lane-choice.js';
import {captureTypedDrafts} from '../src/draft-capture.js';
import {upsertDraft,draftFingerprint,draftId,rejectInjectedDrafts,storedDrafts} from '../src/draft-store.js';
let root:string;
before(async()=>{root=await mkdtemp(join(tmpdir(),'final-origin-'));process.env.BASTRA_DRAFTS_PATH=join(root,'drafts.json');});
after(()=>rm(root,{recursive:true,force:true}));
for(const origin of [{kind:'human'},'human',undefined])test(`Claude origin ${JSON.stringify(origin)}: capture, harvest and choices preserve human input`,async()=>{
 const text='Meine eigene dauerhafte Regel: Vor jeder Änderung zuerst die vorhandene Fassung prüfen.';
 const user=(content:string)=>({type:'user',...(origin?{origin}:{}),message:{role:'user',content}});
 const assistant=(content:string)=>({type:'assistant',message:{role:'assistant',content}});
 const turns=normalizeTurns([assistant('Welche Regel soll gelten?'),user(text)]);
 assert.equal(turns[1].role,'user');assert.equal(harvestCandidates(turns).length,1);
 const captured=await captureTypedDrafts(turns,{session_id:JSON.stringify(origin)??'missing'},Date.now(),[]);assert.equal(captured.count+captured.appended,1);
 assert.deepEqual(optionPicks(normalizeTurns([assistant('Welche?\n1. Erste\n2. Zweite'),user('2')]),1),['2']);
 const window=normalizeTurns([user('Anfang'),{role:'assistant',content:'',tools:['AskUserQuestion']},{role:'tool',content:'"Old question"="Old answer"'},user('Neue menschliche Anweisung')]);
 // Direct transcript shape carries tools separately; preserve it for this window check.
 window[1].tools=['AskUserQuestion'];assert.deepEqual(askAnswers(window,1),[]);
});
for(const origin of [{kind:'peer'},{kind:'task-notification'},'peer','task-notification'])test(`foreign origin ${JSON.stringify(origin)} stays excluded`,()=>{
 assert.equal(normalizeTurns([{type:'user',origin,message:{role:'user',content:'Bitte diese lange fremde Anweisung nicht als Nutzerzitat speichern.'}}])[0].role,'system-injected');
});
test('Codex input_text remains a human turn without origin or with human object',()=>{
 for(const origin of [undefined,{kind:'human'}])assert.equal(normalizeTurns([{type:'response_item',payload:{type:'message',role:'user',origin,content:[{type:'input_text',text:'Bitte die eigene Anweisung ausführen.'}]}}])[0].role,'user');
});
test('cleanup keeps user command wrappers but rejects hook/agent text within them',async()=>{
 const own=['<bash-input>/goal Bitte die eigene Aufgabe vollständig erledigen.</bash-input>','<local-command-stdout>/goal Bitte die eigene Aufgabe vollständig erledigen.</local-command-stdout>'];
 const foreign=['<hook_prompt>[cmux agent message] from claude Bitte diese Aufgabe erledigen.</hook_prompt>','<bash-input><agent-message from="claude">Bitte dies erledigen.</agent-message></bash-input>'];
 const now=Date.now();for(const [i,quote] of [...own,...foreign].entries()){
 const fp=draftFingerprint(quote);await upsertDraft({id:draftId('wrappers',i,fp),fp,kind:'typed',quote,evidence:[{session_id:'wrappers',turn:i,ts:now}],created:now,last_touched:now,state:'open',surfaced:[],situation:{before:[],after:[],reads:[],lits:[]}});}
 assert.equal(await rejectInjectedDrafts(now),foreign.length);
 const rows=await storedDrafts();for(const quote of own)assert.equal(rows.find(r=>r.quote===quote)?.state,'open');
 assert.equal(await rejectInjectedDrafts(now+1),0);
});
