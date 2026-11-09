import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mutateSettings } from "../src/settings-file.js";

async function probe(root:string,envOverride?:string) {
  const result=join(root,`result-${envOverride??"stored"}.json`);
  const source=(file:string)=>pathToFileURL(resolve("packages/daemon/src",file)).href;
  const code=`import os from 'node:os';import {syncBuiltinESMExports}from'node:module';import{writeFileSync}from'node:fs';
    os.homedir=()=>${JSON.stringify(root)};syncBuiltinESMExports();
    const {ALL_TOOL_DEFS}=await import(${JSON.stringify(source("tool-defs.ts"))});
    const {Telemetry}=await import(${JSON.stringify(source("telemetry.ts"))});
    writeFileSync(${JSON.stringify(result)},JSON.stringify({tasks:ALL_TOOL_DEFS.some(t=>t.name==='task_create'),telemetry:new Telemetry({logDir:${JSON.stringify(join(root,"logs"))}}).isEnabled()}));`;
  const env:NodeJS.ProcessEnv={...process.env,BASTRA_DB_PATH:join(root,".bastra","recall.db")};delete env.BASTRA_TASKS;delete env.BASTRA_TELEMETRY;delete env.NEXUS_TELEMETRY;
  if(envOverride!==undefined)env.BASTRA_TASKS=envOverride;
  const outcome=await new Promise<{code:number|null;stderr:string}>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd:process.cwd(),env});let stderr="";child.stderr.on("data",b=>stderr+=b);child.on("error",reject);child.on("close",code=>resolve({code,stderr}));});
  assert.equal(outcome.code,0,outcome.stderr);return JSON.parse(await readFile(result,"utf8"));
}
test("fresh processes register persisted opt-in tools before static imports; env wins and default stays off",async()=>{
  const root=await mkdtemp(join(tmpdir(),"runtime-settings-")),path=join(root,".bastra","cli-settings.json");
  assert.equal((await probe(root)).tasks,false);
  await assert.rejects(stat(join(root,".bastra","recall.db")),{code:"ENOENT"},"passive import never creates a database");
  await mutateSettings(path,s=>({...s,tasks:{enabled:true},telemetry:{enabled:false}}));
  assert.deepEqual(await probe(root),{tasks:true,telemetry:false});
  assert.equal((await probe(root,"0")).tasks,false);
});
