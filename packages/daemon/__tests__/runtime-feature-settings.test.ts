import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, mkdir, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mutateSettings } from "../src/settings-file.js";

async function probe(root:string,envOverride?:string, dbPath=join(root,".bastra","recall.db")) {
  const result=join(root,`result-${envOverride??"stored"}.json`);
  const source=(file:string)=>pathToFileURL(resolve("packages/daemon/src",file)).href;
  const code=`import os from 'node:os';import {syncBuiltinESMExports}from'node:module';import{writeFileSync}from'node:fs';
    os.homedir=()=>${JSON.stringify(root)};syncBuiltinESMExports();
    const {ALL_TOOL_DEFS}=await import(${JSON.stringify(source("tool-defs.ts"))});
    const {Telemetry}=await import(${JSON.stringify(source("telemetry.ts"))});
    writeFileSync(${JSON.stringify(result)},JSON.stringify({tasks:ALL_TOOL_DEFS.some(t=>t.name==='task_create'),telemetry:new Telemetry({logDir:${JSON.stringify(join(root,"logs"))}}).isEnabled()}));`;
  const env:NodeJS.ProcessEnv={...process.env,BASTRA_DB_PATH:dbPath};delete env.BASTRA_TASKS;delete env.BASTRA_TELEMETRY;delete env.NEXUS_TELEMETRY;
  if(envOverride!==undefined)env.BASTRA_TASKS=envOverride;
  const outcome=await new Promise<{code:number|null;stderr:string}>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd:process.cwd(),env});let stderr="";child.stderr.on("data",b=>stderr+=b);child.on("error",reject);child.on("close",code=>resolve({code,stderr}));});
  assert.equal(outcome.code,0,outcome.stderr);return JSON.parse(await readFile(result,"utf8"));
}
test("fresh processes register persisted opt-in tools before static imports; env wins and tasks default on",async()=>{
  const root=await mkdtemp(join(tmpdir(),"runtime-settings-")),path=join(root,".bastra","cli-settings.json");
  assert.equal((await probe(root)).tasks,true);
  await assert.rejects(stat(join(root,".bastra","recall.db")),{code:"ENOENT"},"passive import never creates a database");
  await mutateSettings(path,s=>({...s,tasks:{enabled:true},telemetry:{enabled:false}}));
  assert.deepEqual(await probe(root),{tasks:true,telemetry:false});
  assert.equal((await probe(root,"0")).tasks,false);
});

// Each probe is a fresh thin-client process. Fixtures never use real app storage.
async function legacyRoot(text?: string) {
  const root=await mkdtemp(join(tmpdir(),"tasks-default-")),data=join(root,".bastra"),path=join(data,"cli-settings.json");
  await mkdir(data);
  if(text!==undefined)await writeFile(path,text);
  return {root,data,path,db:join(data,"recall.db")};
}
function record(dbPath:string,key:string,text:unknown) {
  const db=new DatabaseSync(dbPath);
  try {db.exec("CREATE TABLE app_records(namespace TEXT,key TEXT,value TEXT)");if(text!==undefined)db.prepare("INSERT INTO app_records VALUES('settings',?,?)").run(key,JSON.stringify({text}));}finally{db.close();}
}
test("#1289 genuinely missing settings and valid records without tasks default on; legacy opt-out remains read-only",async()=>{
  for(const text of [undefined,'{}','{"telemetry":{"enabled":false}}','{"tasks":{"enabled":false}}','{"tasks":{"enabled":true}}']) {
    const f=await legacyRoot(text),before=await readdir(f.data);
    assert.equal((await probe(f.root)).tasks,text?.includes('"enabled":false')&&text.includes('"tasks"')?false:true);
    assert.deepEqual(await readdir(f.data),before,"passive legacy read neither imports nor creates storage");
    if(text!==undefined)assert.equal(await readFile(f.path,"utf8"),text);
  }
  const missing=await legacyRoot('{"tasks":{"enabled":false}}');record(missing.db,missing.path,undefined);
  const originalDB=await readFile(missing.db);
  assert.equal((await probe(missing.root)).tasks,false,"missing DB record permits read-only legacy opt-out");
  assert.deepEqual(await readFile(missing.db),originalDB,"legacy fallback never imports into an existing DB");
  assert.equal(await readFile(missing.path,"utf8"),'{"tasks":{"enabled":false}}');
  const f=await legacyRoot('{"tasks":{"enabled":false}}');
  record(f.db,f.path,'{}');
  assert.equal((await probe(f.root)).tasks,true,"authoritative DB without tasks does not revive legacy opt-out");
  const before=await readFile(f.db);
  assert.equal((await probe(f.root)).tasks,true);assert.deepEqual(await readFile(f.db),before);
});
test("#1289 failed/deleted/invalid settings close tasks; explicit environment still wins",async()=>{
  for(const text of ['', '{', 'null', '[]', 'true', '42', '"settings"','{"tasks":null}','{"tasks":{"enabled":"false"}}']) {
    const f=await legacyRoot(text);
    assert.equal((await probe(f.root)).tasks,false,`legacy ${text}`);
    assert.equal((await probe(f.root,'1')).tasks,true);
    const dbf=await legacyRoot();record(dbf.db,dbf.path,text);
    assert.equal((await probe(dbf.root)).tasks,false,`DB ${text}`);
  }
  for(const text of [null,17]) {
    const f=await legacyRoot('{"tasks":{"enabled":true}}');record(f.db,f.path,text);
    assert.equal((await probe(f.root)).tasks,false,"invalid authoritative envelope cannot use legacy");
    assert.equal((await probe(f.root,'1')).tasks,true);
  }
  const f=await legacyRoot('{"tasks":{"enabled":true}}');await writeFile(f.db,'not SQLite');
  assert.equal((await probe(f.root)).tasks,false);assert.equal((await probe(f.root,'1')).tasks,true);
  const unreadable=await legacyRoot();await mkdir(unreadable.path);
  assert.equal((await probe(unreadable.root)).tasks,false,"non-file legacy settings remain closed");
  assert.equal((await probe(unreadable.root,undefined,join(unreadable.path,'unavailable.db'))).tasks,false,"bad database parent is not absence");
});

test("#1289 existing persisted DB opt-out survives default change; explicit env overrides it",async()=>{
  const f=await legacyRoot('{"tasks":{"enabled":true}}');
  record(f.db,f.path,'{"tasks":{"enabled":false}}');
  const before=await readFile(f.db),legacy=await readFile(f.path,"utf8");
  assert.equal((await probe(f.root)).tasks,false);
  assert.equal((await probe(f.root,'1')).tasks,true);
  assert.equal((await probe(f.root,'0')).tasks,false);
  assert.deepEqual(await readFile(f.db),before);
  assert.equal(await readFile(f.path,"utf8"),legacy);
  assert.deepEqual((await readdir(f.data)).sort(),['cli-settings.json','recall.db']);
});
