import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase } from "../src/app-database.js";
import { appRecordDatabasePath, readAppRecord } from "../src/app-record-store.js";
import { draftId, draftFingerprint, listDrafts, upsertDraft, transactDrafts, updateRetrievedDrafts, type Draft } from "../src/draft-store.js";

async function isolated(run: (path:string,now:number,row:Draft)=>Promise<void>):Promise<void> {
  const root=await mkdtemp(join(tmpdir(),"draft-db-")),path=join(root,"drafts.json"),previous=process.env.BASTRA_DRAFTS_PATH;
  process.env.BASTRA_DRAFTS_PATH=path;
  const now=Date.now(),quote="The synthetic staging deployment uses an isolated database",fp=draftFingerprint(quote);
  const row:Draft={id:draftId("legacy",0,fp),fp,quote,kind:"typed",situation:{before:[],after:[],reads:[],lits:[]},evidence:[{session_id:"legacy",turn:0,ts:now}],created:now,last_touched:now,surfaced:[],state:"open"};
  try{await run(path,now,row);}finally{if(previous===undefined)delete process.env.BASTRA_DRAFTS_PATH;else process.env.BASTRA_DRAFTS_PATH=previous;}
}

test("draft migration preserves legacy bytes and unknown metadata, then reads SQLite",()=>isolated(async(path,now,row)=>{
  const raw=JSON.stringify({version:1,extension:{keep:true},rows:[row]});await writeFile(path,raw);
  assert.deepEqual(JSON.parse(JSON.stringify(await listDrafts(now))),[row]);
  assert.equal(await readFile(path+".pre-db","utf8"),raw);
  await assert.rejects(readFile(path),{code:"ENOENT"});
  await upsertDraft({...row,context:"An additional retained context"},now);
  assert.deepEqual(JSON.parse(readAppRecord("drafts",path)).extension,{keep:true});
}));

test("malformed and future legacy draft documents remain unadopted",()=>isolated(async(path,now,row)=>{
  for(const raw of ["{truncated",JSON.stringify({}),JSON.stringify({version:99,items:["future"]})]){
    await writeFile(path,raw);assert.deepEqual(await listDrafts(now),[]);
    await assert.rejects(upsertDraft(row,now),/original file preserved/);
    assert.equal(await readFile(path,"utf8"),raw);
    await assert.rejects(readFile(path+".pre-db"),{code:"ENOENT"});
  }
}));

test("best-effort draft mutations do not wait for another SQLite writer or book a display",()=>isolated(async(path,now,row)=>{
  await upsertDraft(row,now);
  const before=readAppRecord("drafts",path),holder=openAppDatabase({path:appRecordDatabasePath(path)});
  holder.sqlite.exec("BEGIN IMMEDIATE");
  try{
    const started=performance.now();
    const result=await transactDrafts(async rows=>{rows[0].context="must not persist";return true;},now,true,true);
    await updateRetrievedDrafts([],[{id:row.id,session_id:"blocked",novel:["synthetic"]}],now,true);
    assert.equal(result,undefined);
    assert.ok(performance.now()-started<200,"best-effort response must not inherit the 10s DB timeout");
  }finally{holder.sqlite.exec("ROLLBACK");holder.close();}
  assert.equal(readAppRecord("drafts",path),before);
  assert.deepEqual((await listDrafts(now))[0].surfaced,[]);
}));
