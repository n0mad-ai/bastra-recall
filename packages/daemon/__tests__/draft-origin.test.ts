import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureTypedDrafts} from '../src/draft-capture.js';
import {normalizeTurns} from '../src/stop-transcript.js';
import {listDrafts,upsertDraft,draftId,draftFingerprint} from '../src/draft-store.js';
let root:string;
before(async()=>{root=await mkdtemp(join(tmpdir(),'draft-origin-'));process.env.BASTRA_DRAFTS_PATH=join(root,'drafts.json');});
after(async()=>{await rm(root,{recursive:true,force:true});});
const exact='<hook_prompt hook_run_id="stop:20:…">[cmux agent message] from Bastra Recall … Danke. Gegenprüfung d28299e9 läuft (Opus). Bitte bis zum Ergebnis nicht pushen…';
const injected=[exact,'[cmux agent message] from claude\nBitte den Fehler beheben und später melden.','<agent-message from="claude">Bitte den Fehler beheben und später melden.</agent-message>','<hook_prompt>Continue working on the previous task.</hook_prompt>','<system-reminder>Remember to finish the previous task.</system-reminder>','<local-command-stdout>This is a long enough tool result to capture incorrectly.</local-command-stdout>'];
test('exact #1338 payload and Claude agent-message are never owner drafts',async()=>{
 const rows=injected.map(content=>({type:'user',message:{role:'user',content}}));
 rows.push({type:'user',message:{role:'user',content:'Das ist meine eigene Anweisung. Bitte repariere den Fehler.'}});
 const turns=normalizeTurns(rows);const result=await captureTypedDrafts(turns,{session_id:'origin'},Date.now(),[]);
 assert.equal(result.count,1);assert.equal((await listDrafts()).length,1);
});
test('source metadata survives direct turns and Codex rollout parsing',async()=>{
 for(const wrapper of [false,true])for(const metadata of [{stop_hook_active:true},{isMeta:true},{source:'hook'},{origin:'tool'},{source:'unknown'}]){
 const message={role:'user',content:'Continue the previous task until everything is done.',...metadata};
 const turns=normalizeTurns([wrapper?{type:'response_item',payload:{type:'message',...message}}:message]);
 const result=await captureTypedDrafts(turns,{session_id:`metadata-${wrapper}-${JSON.stringify(metadata)}`},Date.now(),[]);assert.equal(result.count,0);
 }
});
test('cleanup rejects polluted drafts once and retains their evidence',async()=>{
 const {rejectInjectedDrafts}=await import('../src/draft-store.js');
 const {storedDrafts}=await import('../src/draft-store.js');
 const now=Date.now();
 for(const [i,quote] of injected.entries()){
  const fp=draftFingerprint(quote);await upsertDraft({id:draftId('old',i,fp),fp,kind:'typed',quote,evidence:[{session_id:'old',turn:i,ts:now}],created:now,last_touched:now,state:'open',surfaced:[],situation:{before:[],after:[],reads:[],lits:[]}},now);
 }
 assert.equal(await rejectInjectedDrafts(now),injected.length);
 const rows=await storedDrafts(now);assert.equal(rows.length,injected.length+1);
 assert.equal(rows.filter(r=>r.state==='rejected').length,injected.length);
 assert.ok(rows.every(r=>r.evidence.length===1));
 assert.equal(await rejectInjectedDrafts(now+1),0);
 assert.equal((await listDrafts(now)).filter(r=>r.state==='open').length,1);
});

test('cleanup retains aged polluted and unrelated rows rather than expiring them',async()=>{
 const {rejectInjectedDrafts,storedDrafts}=await import('../src/draft-store.js');
 const path=process.env.BASTRA_DRAFTS_PATH!,now=Date.now(),old=now-10*24*60*60*1000;
 const doc=JSON.parse(await readFile(path,'utf8'));
 const fp=draftFingerprint(exact+' older');
 doc.rows.push({...doc.rows[0],id:draftId('aged',0,fp),fp,quote:exact+' older',state:'open',created:old,last_touched:old,evidence:[{session_id:'aged',turn:0,ts:old}],surfaced:[]});
 const owner=doc.rows.find((r:any)=>r.state==='open');owner.created=old;owner.last_touched=old;
 await writeFile(path,JSON.stringify(doc));
 assert.equal(await rejectInjectedDrafts(now),1);
 const rows=await storedDrafts(now);assert.equal(rows.length,doc.rows.length);
 assert.equal(rows.find(r=>r.id===draftId('aged',0,fp))?.state,'rejected');
 assert.equal(await rejectInjectedDrafts(now+1),0);
});

test('mixed owner prose retains only its own prefix before a hook or cmux band',async()=>{
 const {normalizeOwnerTurn}=await import('../src/stop-transcript.js');
 const own='Meine eigene Anweisung steht vor dem fremden Block.';
 for(const band of [exact,'[cmux agent message] from reviewer\nFremder Text folgt hier.']){
  assert.equal(normalizeOwnerTurn({role:'user',content:own+'\n'+band}).content,own);
 }
 const claude=normalizeTurns([{type:'user',stop_hook_active:true,message:{role:'user',content:'Continue the previous task without stopping before completion.'}}]);
 assert.equal(claude[0].role,'system-injected');
});
