import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runTaskStep} from '../src/prompt-task.js';
import {loadSessionState} from '../src/session-state.js';
let root:string;
before(async()=>{root=await mkdtemp(join(tmpdir(),'dictation-'));process.env.BASTRA_HOOK_STATE_DIR=join(root,'state');});
after(async()=>{await rm(root,{recursive:true,force:true});});
for(const [i,text] of ['Schon wieder fragst du nach. Setze meine Anweisung jetzt um und repariere den Fehler.','Hallo, kannst du morgen kommen?','Hello, can you come tomorrow?','Bonjour, peux-tu venir demain ?','Hola, ¿puedes venir mañana?','明日来られますか？'].entries())test(`pasted dictation/message ${i}: neutral context, no approval`,async()=>{
 const sid=`paste-${i}`;const out=await runTaskStep({sessionId:sid,prompt:`<pasted_content>${text}</pasted_content>`,snapshot:await loadSessionState(sid),mode:'generic',candidates:[],surface:'claude-code'});
 assert.doesNotMatch(out??'',/task unclear|ask the user|choice/i);
 assert.match(out??'',/rulebook_check/);assert.match(out??'',/own instruction/);
 assert.equal((await loadSessionState(sid)).activeTask,undefined);
});
