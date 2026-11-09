import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase } from "../src/app-database.js";
import { appRecordDatabasePath, readAppRecord } from "../src/app-record-store.js";
import { writePendingSuggestion, writePendingFromHook, takePendingRelay } from "../src/pending-suggestions.js";

test("pending hooks defer a busy SQLite writer without consuming or losing suggestions",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pending-db-contention-")),path=join(root,"pending.json");
  const previous=process.env.BASTRA_PENDING_SUGGESTIONS_PATH;process.env.BASTRA_PENDING_SUGGESTIONS_PATH=path;
  let persisted=0;
  try{
    await writePendingSuggestion("existing relay row");
    const holder=openAppDatabase({path:appRecordDatabasePath(path)});
    holder.sqlite.exec("BEGIN IMMEDIATE");
    try{
      const started=performance.now();
      assert.deepEqual(await takePendingRelay(),{recency:[],trends:[]});
      await writePendingFromHook("deferred relay row",{onPersisted:()=>{persisted++;}});
      assert.ok(performance.now()-started<200,"hooks must not wait for the normal 10s SQLite timeout");
      assert.equal(persisted,0,"busy is not a durable write acknowledgement");
      assert.equal(JSON.parse(readAppRecord("pending-suggestions",path)).length,1);
    }finally{holder.sqlite.exec("ROLLBACK");holder.close();}
    const deadline=Date.now()+2000;
    while(persisted===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(persisted,1);
    const relay=await takePendingRelay();
    assert.deepEqual(relay.recency.map(row=>row.blocks),["existing relay row","deferred relay row"]);
  }finally{if(previous===undefined)delete process.env.BASTRA_PENDING_SUGGESTIONS_PATH;else process.env.BASTRA_PENDING_SUGGESTIONS_PATH=previous;}
});


test("legacy FIFO override is rejected without blocking its process",{skip:process.platform==="win32"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"app-state-fifo-")),path=join(root,"state.json");
  execFileSync("mkfifo",[path]);
  const module=new URL("../src/app-record-store.ts",import.meta.url).href;
  const code=`import {readAppRecord} from ${JSON.stringify(module)};try{readAppRecord('fixture',${JSON.stringify(path)});process.exit(3);}catch(error){if(error.code!=='EINVAL')throw error;}`;
  const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",code],{timeout:2000,encoding:"utf8"});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);
});
