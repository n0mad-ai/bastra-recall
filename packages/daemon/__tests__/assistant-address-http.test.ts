import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault,SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { settingsFilePath } from "../src/settings.js";

test("#1332: actual settings route preserves local CSRF and performs no system change without consent",async t=>{
 assert.ok(process.env.BASTRA_TEST_RUN_ROOT,"requires isolated test profile");
 const root=await mkdtemp(join(tmpdir(),"assistant-http-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const settingsPath=settingsFilePath();await mkdir(join(settingsPath,".."),{recursive:true});await writeFile(settingsPath,JSON.stringify({ui:{enabled:true}}));
 const hostsPath=join(root,"hosts"),helperPath=join(root,"helper.plist"),runtimeDir=join(root,"runtime"),firefoxRoot=join(root,"firefox");await writeFile(hostsPath,"127.0.0.1 localhost\n");await mkdir(firefoxRoot);
 const vaultDir=join(root,"vault");await mkdir(vaultDir);const vault=new Vault(vaultDir);await vault.init();const search=new SearchIndex(vault);search.start();
 let admins=0;
 const handle=await startHttpServer({port:0,vault,search,telemetry:new Telemetry(),version:"test",toolDeps:{vault,search,telemetry:new Telemetry(),vaultPath:vaultDir},documentWriteEnabled:false,embedding:{on:false,providerId:null,source:"none"},assistantAddress:{port:0,settingsPath,hostsPath,helperPath,runtimeDir,firefoxRoot,home:root,uid:String(process.getuid?.()??0),username:"fixture",platform:"darwin",ensureRuntime:async()=>{},openBrowser:async()=>{},runAdmin:async plan=>{admins++;await writeFile(hostsPath,plan.hostsAfter);if(plan.helperAfter)await writeFile(helperPath,plan.helperAfter);}}});
 t.after(async()=>{await handle.close();search.stop();await vault.stop?.();});const base=`http://127.0.0.1:${handle.port}`;
 const post=(path:string,body:unknown,origin=base)=>fetch(base+path,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
 assert.equal((await post("/ui/assistant-address",{name:"jarvis"},"https://evil.example")).status,403);
 const saved=await post("/ui/assistant-address",{name:"Jarvis"});assert.equal(saved.status,200);assert.equal((await saved.json()as any).name,"jarvis");assert.equal(admins,0);
 assert.equal((await post("/ui/assistant-address/setup",{systemConsent:false})).status,409);assert.equal(admins,0);
 const setup=await post("/ui/assistant-address/setup",{systemConsent:true});assert.equal(setup.status,200,await setup.text());assert.equal(admins,1);
 assert.match(await readFile(hostsPath,"utf8"),/jarvis/);
 assert.equal((await post("/ui/assistant-address",{name:"ruby"})).status,409);
 assert.equal((await post("/ui/assistant-address",{name:"ruby",systemConsent:true})).status,200);
 assert.doesNotMatch(await readFile(hostsPath,"utf8"),/jarvis/);
});
