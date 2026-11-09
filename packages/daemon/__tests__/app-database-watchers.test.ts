import "./tasks-opt-in.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { TaskRuntime } from "../src/task-runtime.js";
import { transactTaskStore } from "../src/task-store.js";
import { readAppRecord } from "../src/app-record-store.js";
import { draftFingerprint, draftId, upsertDraft, listDrafts, draftSearchSnapshot, startDraftSearchCache, type Draft } from "../src/draft-store.js";

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test("task and draft watchers see external DB commits without a read-refresh loop",async t=>{
  const root=await mkdtemp(join(tmpdir(),"app-db-watch-")),path=join(root,"tasks.json"),draftPath=join(root,"drafts.json");
  const previous=process.env.BASTRA_DRAFTS_PATH;process.env.BASTRA_DRAFTS_PATH=draftPath;
  const now=Date.now(),quote="Synthetic watcher fixture uses a separate deployment database",fp=draftFingerprint(quote);
  const row:Draft={id:draftId("watcher",0,fp),fp,quote,kind:"typed",situation:{before:[],after:[],reads:[],lits:[]},evidence:[{session_id:"watcher",turn:0,ts:now}],created:now,last_touched:now,surfaced:[],state:"open"};
  let runtime:TaskRuntime|undefined,stop:(()=>void)|undefined,queries=0;
  const prepare=DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype,"prepare",function(this:DatabaseSync,sql:string){if(sql.startsWith("SELECT value FROM app_records"))queries++;return prepare.call(this,sql);});
  try{
    await transactTaskStore(path,undefined,store=>{store.controls.muted=true;});await upsertDraft(row,now);
    runtime=new TaskRuntime({path,authPath:join(root,"auth.json")});await runtime.ready;stop=startDraftSearchCache();
    await delay(100);
    const childCode=`import {transactTaskStore} from ${JSON.stringify(new URL("../src/task-store.ts",import.meta.url).href)};import {upsertDraft} from ${JSON.stringify(new URL("../src/draft-store.ts",import.meta.url).href)};await transactTaskStore(${JSON.stringify(path)},undefined,s=>{s.controls.muted=false});await upsertDraft(${JSON.stringify({...row,context:"external commit"})},${now});`;
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",childCode],{stdio:["ignore","ignore","pipe"]});let errors="";
      child.stderr.on("data",data=>{errors+=data;});child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(new Error(errors)));
    });
    const until=Date.now()+2000;
    while(Date.now()<until&&(runtime.snapshot.controls.muted||draftSearchSnapshot(now).rows[0]?.context!=="external commit"))await delay(10);
    assert.equal(runtime.snapshot.controls.muted,false,"external task commit must wake the runtime");
    assert.equal(draftSearchSnapshot(now).rows[0]?.context,"external commit");
    await delay(100);const beforeQueries=queries,beforeReads=runtime.reads;
    readAppRecord("tasks",path);await listDrafts(now);await delay(250);
    assert.ok(runtime.reads-beforeReads<5,"read-only opens must not wake the task watcher repeatedly");
    assert.ok(queries-beforeQueries<20,"draft refresh must not create an endless DB/WAL read loop");
  }finally{stop?.();runtime?.stop();if(previous===undefined)delete process.env.BASTRA_DRAFTS_PATH;else process.env.BASTRA_DRAFTS_PATH=previous;}
});
