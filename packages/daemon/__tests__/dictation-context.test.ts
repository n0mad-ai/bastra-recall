/** Dictated/pasted text never decides workflow state. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runTaskStep} from '../src/prompt-task.js';
import {splitQuoted} from '../src/prompt-classify.js';
for(const [i,text]of ['Schon wieder fragst du nach.','Hallo, kannst du morgen kommen?','Hello, can you come tomorrow?','Bonjour, peux-tu venir demain ?','Hola, ¿puedes venir mañana?','明日来られますか？'].entries())test(`pasted dictation ${i}: structural quotes, no task`,async()=>{
 assert.equal(splitQuoted(`<pasted_content>${text}</pasted_content>`).quoted,true);
 assert.equal(await runTaskStep({sessionId:'unreported-'+i,snapshot:{shown:{}},surface:'claude-code'}),null);
});
