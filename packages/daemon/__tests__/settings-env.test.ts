import { test } from "node:test";
import assert from "node:assert/strict";
import { envSettingsSnapshot, applyEnvSettingChanges, envSettingSpecs } from "../src/settings-env.js";
import { applyDaemonSettingsEnv, daemonSpawnEnv } from "../src/daemon-spawn-env.js";
import { parseStoredSettings } from "../src/settings-registry.js";
const empty = () => parseStoredSettings({});
test("all twelve env settings expose runtime defaults and persist solely as daemon.env strings",()=> {
  const entries=envSettingsSnapshot(empty(),{},new Set());
  assert.equal(entries.length,12);
  assert.deepEqual(entries.map(e=>e.default).slice(0,10),["embeddinggemma","http://localhost:11434","10m",30,"all","shadow",8,"shadow",true,90]);
  assert.equal((entries.find(e=>e.key==="logs.retention") as {min:number}).min,30);
  assert.ok(entries.every(e=>e.effective===e.default&&e.restartRequired&&!e.readonly));
  let next=applyEnvSettingChanges(empty(),{"recall.floor":45,"saveNotice":false,"ollama.keepAlive":"-1"},{},new Set());
  next=parseStoredSettings(next);
  assert.deepEqual(next.daemon?.env,{BASTRA_RECALL_FLOOR:"45",BASTRA_SAVE_NOTICE:"0",BASTRA_OLLAMA_KEEP_ALIVE:"-1"});
  assert.equal((next as Record<string,unknown>).recall,undefined);
  for(const path of ["relative/logs","~/logs"])assert.equal(applyEnvSettingChanges(empty(),{"logs.path":path},{},new Set()).daemon?.env?.BASTRA_LOG_PATH,path,"runtime path remains raw without expansion");
  assert.equal(applyEnvSettingChanges(empty(),{"ollama.keepAlive":"+.5h30m"},{},new Set()).daemon?.env?.BASTRA_OLLAMA_KEEP_ALIVE,"+.5h30m");
  assert.equal(envSettingsSnapshot(next,{},new Set()).find(e=>e.key==="recall.floor")!.effective,30,"pending pin does not claim to be running");
  assert.equal(applyEnvSettingChanges(next,{"recall.floor":null},{},new Set()).daemon?.env?.BASTRA_RECALL_FLOOR,undefined);
});
test("bounds, types, unsafe URLs and unsupported modes are rejected before persistence",()=> {
  for(const changes of [{"recall.floor":101},{"recall.floor":1.5},{"hint.suppressAfter":31},{"logs.retention":7},{"logs.retention":366},{"hint.suppress":"live"},{"saveNotice":"false"},{"ollama.url":"file:///tmp/x"},{"ollama.url":"http://user:secret@localhost"},{"ollama.keepAlive":"forever"}])assert.throws(()=>applyEnvSettingChanges(empty(),changes,{},new Set()));
});
test("true service env is read-only even when identical to stored; applied pins remain editable after file edits",()=> {
  const current=applyEnvSettingChanges(empty(),{"recall.floor":40},{},new Set());
  const env={BASTRA_RECALL_FLOOR:"40"};
  assert.equal(envSettingsSnapshot(current,env,new Set()).find(e=>e.key==="recall.floor")!.readonly,true);
  assert.throws(()=>applyEnvSettingChanges(current,{"recall.floor":null},env,new Set()));
  const applied=new Set<string>();
  const running:NodeJS.ProcessEnv={};
  applyDaemonSettingsEnv(current.daemon!.env!,running,applied);
  const updated=applyEnvSettingChanges(current,{"recall.floor":50},running,applied);
  const entry=envSettingsSnapshot(updated,running,applied).find(e=>e.key==="recall.floor")!;
  assert.equal(entry.source,"daemon.env");
  const removed=envSettingsSnapshot(applyEnvSettingChanges(updated,{"recall.floor":null},running,applied),running,applied).find(e=>e.key==="recall.floor")!;
  assert.equal(removed.source,"daemon.env");assert.equal(removed.value,30);assert.equal(removed.effective,40);assert.equal(removed.isSet,false);
  const queued=envSettingsSnapshot(updated,{},new Set()).find(e=>e.key==="recall.floor")!;assert.equal(queued.source,"default");assert.equal(queued.value,50);assert.equal(queued.effective,30);
  assert.equal(entry.value,50);assert.equal(entry.effective,40);assert.equal(entry.readonly,false);assert.deepEqual(entry.envOverride,[]);
  applyDaemonSettingsEnv({BASTRA_RECALL_FLOOR:"70"},env,new Set());assert.equal(env.BASTRA_RECALL_FLOOR,"40");
});
test("forwarder carries explicit settings provenance, preserves pins-wins and supports every exposed key",()=> {
  const pins=Object.fromEntries(envSettingSpecs.map(s=>[s.envName,String(s.default)]));
  const {env,pinned}=daemonSpawnEnv({BASTRA_RECALL_FLOOR:"99"},pins);
  assert.equal(env.BASTRA_RECALL_FLOOR,"30");assert.equal(pinned.length,12);
  const applied=new Set<string>();applyDaemonSettingsEnv({},env,applied);
  assert.equal(applied.size,12);
  assert.ok(envSettingsSnapshot(empty(),env,applied).every(e=>!e.readonly));
});
test("effective projections preserve runtime normalization for external values",()=> {
  const rows=envSettingsSnapshot(empty(),{BASTRA_HINT_SUPPRESS:"live",BASTRA_HINT_SUPPRESS_AFTER:"-4",BASTRA_LOG_RETENTION_DAYS:"10",BASTRA_TRAINING_CAPTURE:"yes",BASTRA_SAVE_NOTICE:"OFF"},new Set());
  for(const [key,value]of [["hint.suppress","shadow"],["hint.suppressAfter",0],["logs.retention",30],["training.capture",true],["saveNotice",false]])assert.equal(rows.find(e=>e.key===key)!.effective,value);
});

test("synchronous entry bootstrap precedes sibling import-time env reads for service/direct and forwarder starts",async t=> {
  const {mkdtemp,mkdir,writeFile,rm,access}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {spawnSync}=await import("node:child_process");
  const {fileURLToPath,pathToFileURL}=await import("node:url");
  const home=await mkdtemp(join(tmpdir(),"settings-env-boot-"));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,".bastra"));
  await writeFile(join(home,".bastra","cli-settings.json"),JSON.stringify({daemon:{env:{BASTRA_RECALL_FLOOR:"45",BASTRA_PROMPT_HOOK_MODE:"retrieval-only"}}}));
  const probe=join(home,"probe.mjs");
  await writeFile(probe,"export const atImport = process.env.BASTRA_RECALL_FLOOR;");
  const bootstrap=new URL("../src/daemon-settings-env.ts",import.meta.url).href;
  const provenance=new URL("../src/daemon-spawn-env.ts",import.meta.url).href;
  const script=`import ${JSON.stringify(bootstrap)};import {atImport} from ${JSON.stringify(pathToFileURL(probe).href)};import {appliedDaemonEnv} from ${JSON.stringify(provenance)};console.log(JSON.stringify({atImport,pins:[...appliedDaemonEnv]}));`;
  const run=(extra:NodeJS.ProcessEnv)=> {
    const env={...process.env,HOME:home,BASTRA_DB_PATH:join(home,"state.db"),...extra};
    const result=spawnSync(process.execPath,["--import",fileURLToPath(import.meta.resolve("tsx")),"--input-type=module","-e",script],{env,encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.trim())as{atImport:string;pins:string[]};
  };
  const direct=run({BASTRA_RECALL_FLOOR:undefined});assert.equal(direct.atImport,"45");assert.ok(direct.pins.includes("BASTRA_RECALL_FLOOR"));
  const service=run({BASTRA_RECALL_FLOOR:"60",BASTRA_AUTOSTART_MANAGED:"1"});assert.equal(service.atImport,"60");assert.ok(!service.pins.includes("BASTRA_RECALL_FLOOR"));
  await access(join(home,".bastra","cli-settings.json"));
  await assert.rejects(()=>access(join(home,"state.db")),"passive bootstrap never creates a database or migrates the legacy file");
  const forwarder=run({BASTRA_RECALL_FLOOR:"45",BASTRA_DAEMON_STARTED_BY:"forwarder",BASTRA_DAEMON_ENV_ORIGIN:"client+settings",BASTRA_DAEMON_ENV_PINS:'["BASTRA_RECALL_FLOOR"]'});assert.equal(forwarder.atImport,"45");assert.ok(forwarder.pins.includes("BASTRA_RECALL_FLOOR"));
  const {DatabaseSync}=await import("node:sqlite");
  const db=new DatabaseSync(join(home,"state.db"));
  try {
    db.exec("CREATE TABLE app_records(namespace TEXT,key TEXT,value TEXT)");
    const key=join(home,".bastra","cli-settings.json");
    db.prepare("INSERT INTO app_records VALUES('settings',?,?)").run(key,JSON.stringify({text:JSON.stringify({daemon:{env:{BASTRA_RECALL_FLOOR:"63"}}})}));
    assert.equal(run({BASTRA_RECALL_FLOOR:undefined}).atImport,"63","authoritative database wins over stale legacy");
    db.prepare("UPDATE app_records SET value=?").run(JSON.stringify({text:null}));
    assert.equal(run({BASTRA_RECALL_FLOOR:undefined}).atImport,undefined,"database tombstone cannot revive legacy pins");
  }finally{db.close();}
  await writeFile(join(home,"state.db"),"unavailable database");
  assert.equal(run({BASTRA_RECALL_FLOOR:undefined}).atImport,undefined,"database failure cannot revive legacy pins");
});
