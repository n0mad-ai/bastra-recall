import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,stat,rm,readdir} from "node:fs/promises";
import {isSystemInjectedTurn} from "../src/system-turn.js";
import {parseTranscriptFile} from "../src/stop-transcript.js";
import fs from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {captureTypedDrafts} from "../src/draft-capture.js";
import {harvestCandidates} from "../src/session-harvest.js";
import {listDrafts,expireDrafts,draftFingerprint,draftId,DRAFT_MAX_BYTES,upsertDraft,type Draft} from "../src/draft-store.js";

const now=1_800_000_000_000;
const day=24*60*60*1000;
const task="Please update the deployment script because staging uses its own isolated database.";
const u=(content:string)=>({role:"user",content});
function row(i:number,quote=String.fromCodePoint(0x4e00+i).repeat(30)):Draft {
 const fp=draftFingerprint(quote);return {id:draftId("seed",i,fp),fp,kind:"typed",quote,situation:{before:[],after:[],reads:[],lits:[]},evidence:[{session_id:"seed",turn:i,ts:now}],created:now,last_touched:now,surfaced:[],state:"open"};
}
async function isolated(fn:(path:string,dir:string)=>Promise<void>) {
 const dir=await mkdtemp(join(tmpdir(),"bastra-b1-fixes-"));const path=join(dir,"drafts.json");const previous=process.env.BASTRA_DRAFTS_PATH;process.env.BASTRA_DRAFTS_PATH=path;
 try{await fn(path,dir)}finally{if(previous===undefined)delete process.env.BASTRA_DRAFTS_PATH;else process.env.BASTRA_DRAFTS_PATH=previous;await rm(dir,{recursive:true,force:true});}
}

test("B1 fixes: a merged shape replaces typed and typed never replaces a shape",()=>isolated(async()=>{
 const turns=[u(task),{role:"assistant",content:"Working on it."},u("Please update the deployment script since staging uses its own isolated database.")];
 await captureTypedDrafts(turns,{session_id:"shape"},now,harvestCandidates(turns,0,Infinity));
 let rows=await listDrafts(now);assert.equal(rows.length,1);assert.equal(rows[0].kind,"restated");assert.equal(rows[0].evidence.length,2);
 await captureTypedDrafts([u(task)],{session_id:"typed"},now+1,[]);
 assert.equal((await listDrafts(now+1))[0].kind,"restated");
}));

for(const byteLimit of [false,true])test(`B1 fixes: ${byteLimit?"byte":"row"} eviction preserves confirmed rows and tombstones first`,()=>isolated(async(path)=>{
 const rejected={...row(0),state:"rejected" as const,last_touched:now-20*day,created:now-20*day,evidence:[{session_id:"seed",turn:0,ts:now-20*day}]};
 const confirmed={...row(1),last_touched:now-10*day,created:now-10*day,evidence:Array.from({length:3},(_,i)=>({session_id:`proof-${i}`,turn:1,ts:now-10*day}))};
 const promoted={...row(2),state:"promoted" as const,last_touched:now-day,created:now-day,evidence:[{session_id:"seed",turn:2,ts:now-day}]};
 await writeFile(path,JSON.stringify({version:1,rows:[rejected,confirmed,promoted]}));
 const turns=Array.from({length:600},(_,i)=>u(String.fromCodePoint(0x5000+i).repeat(byteLimit?590:30)));
 await captureTypedDrafts(turns,{session_id:"flood",...(byteLimit?{client:"会".repeat(50)}:{})},now,[]);
 const kept=await listDrafts(now);assert.ok(kept.some(d=>d.id===rejected.id));assert.ok(kept.some(d=>d.id===confirmed.id));assert.ok(kept.some(d=>d.id===promoted.id));
 assert.ok(kept.length<=500);assert.ok((await stat(path)).size<=DRAFT_MAX_BYTES);if(byteLimit)assert.ok(kept.length<500);
 await captureTypedDrafts([u(rejected.quote)],{session_id:"again"},now+1,[]);
 assert.equal((await listDrafts(now+1)).find(d=>d.fp===rejected.fp)?.state,"rejected");
}));

test("B1 fixes: secret-only changes share the redacted fingerprint, ID and tombstone",()=>isolated(async(path)=>{
 const quote=(value:string)=>`Please inspect https://fixture:${value}@example.invalid/health because staging uses its own isolated database.`;
 await captureTypedDrafts([u(quote("alpha"))],{session_id:"first"},now,[]);
 await captureTypedDrafts([u(quote("bravo"))],{session_id:"second"},now+1,[]);
 const rows=await listDrafts(now+1);assert.equal(rows.length,1);assert.equal(rows[0].evidence.length,2);
 assert.equal(rows[0].fp,draftFingerprint(rows[0].quote));assert.equal(rows[0].id,draftId("first",0,rows[0].fp));
 rows[0].state="rejected";await upsertDraft(rows[0],now+1);
 await captureTypedDrafts([u(quote("charlie"))],{session_id:"third"},now+2,[]);
 assert.equal((await listDrafts(now+2)).length,1);assert.equal((await listDrafts(now+2))[0].state,"rejected");
 assert.doesNotMatch(await readFile(path,"utf8"),/fixture:alpha|fixture:bravo|fixture:charlie/);
}));

test("B1 fixes: session capture writes once and idle cleanup never rewrites",(t)=>isolated(async(path,dir)=>{
 const rename=fs.rename;
 const spy=t.mock.method(fs,"rename",(...args:Parameters<typeof rename>)=>rename(...args));
 syncBuiltinESMExports();
 try{
 const turns=Array.from({length:40},(_,i)=>u(String.fromCodePoint(0x6000+i).repeat(30)));
 await captureTypedDrafts(turns,{session_id:"batch"},now,[]);
 assert.equal(spy.mock.callCount(),1);
 const before=await stat(path);await expireDrafts({now:now+1});const after=await stat(path);
 assert.equal(spy.mock.callCount(),1);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
 await captureTypedDrafts(turns,{session_id:"batch"},now+1,[]);
 assert.equal(spy.mock.callCount(),1,"an unchanged replay does not write either");
 assert.deepEqual(await readdir(dir),["drafts.json"]);
 }finally{spy.mock.restore();syncBuiltinESMExports();}
}));

test("B1 fixes: telemetry counts only retained new rows and appended evidence, with bounded IDs",()=>isolated(async()=>{
 const turns=Array.from({length:600},(_,i)=>u(String.fromCodePoint(0x7000+i).repeat(30)));
 const result=await captureTypedDrafts(turns,{session_id:"counts"},now,[]);
 const kept=await listDrafts(now);assert.equal(result.count,kept.length);assert.ok(result.ids.length<=20);
 assert.equal(result.ids.length+result.omitted,kept.length);assert.ok(result.ids.every(id=>kept.some(row=>row.id===id)));
 const more=await captureTypedDrafts([turns[599],turns[599]],{session_id:"evidence"},now+1,[]);
 assert.equal(more.count,0);assert.equal(more.appended,2);
}));


test("B1 fixes: observed Codex harness forms are structural injected turns, complete observed blocks",()=>isolated(async()=>{
 const messages=["# AGENTS.md instructions for /work/fixture\n\nKeep generated outputs outside this directory.","<turn_aborted>\nThe previous operation was interrupted.\n</turn_aborted>"];
 for(const content of messages){assert.equal(isSystemInjectedTurn(content),true);const turns=parseTranscriptFile(JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:content}]}}));assert.equal(turns[0].role,"system-injected");await captureTypedDrafts(turns,{session_id:"harness"},now,[]);}
 assert.deepEqual(await listDrafts(now),[]);
 assert.equal(isSystemInjectedTurn("Please explain # AGENTS.md instructions for this directory."),false);
 assert.equal(isSystemInjectedTurn("What does <turn_aborted> mean in the transcript?"),false);
}));
