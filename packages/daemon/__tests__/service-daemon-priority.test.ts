import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { managedAutostartInstalled, managedAutostartPlistPath } from "../src/autostart-service.js";
import { waitForForwarderPort, SERVICE_PORT_RETRY_MAX_MS } from "../src/daemon-port-wait.js";
import { SERVICE_WAIT_MS } from "../src/forwarder-daemon-client.js";
import { daemonOriginLines, configuredState } from "../src/cli/daemon-origin-note.js";
import type { DaemonProbe } from "../src/cli/helpers.js";

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>Promise<boolean>,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await pause(25);}throw new Error("fixture deadline");}
async function freePort(){const s=createNetServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));assert.notEqual(port,6723);return port;}
const script=resolve("packages/daemon/dist/index.js");
const memory = '---\nid: fixture-copper-valve\ntitle: Invented copper valve rule\ntype: project-fact\nscope: fixture\ntopic_path: [fixture, valves]\ntags: [fixture]\nsummary: Invented copper valves are calibrated every Friday.\nrecall_when: [invented copper valve]\n---\nInvented copper valves are calibrated every Friday.\n';
const managedXml='<plist><dict><key>EnvironmentVariables</key><dict><key>BASTRA_AUTOSTART_MANAGED</key><string>1</string></dict></dict></plist>';
async function fixture(work:(dir:string,env:NodeJS.ProcessEnv,port:number)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"bastra-service-priority-")),home=join(dir,"home"),vault=join(dir,"vault");await mkdir(home);await mkdir(vault);await writeFile(join(vault,"note.md"),memory);const port=await freePort();
 const env: NodeJS.ProcessEnv={...process.env,HOME:home,USERPROFILE:home,BASTRA_VAULT_PATH:vault,BASTRA_HTTP_PORT:String(port),BASTRA_DAEMON_URL:`http://127.0.0.1:${port}`,BASTRA_EMBEDDING_PROVIDER:"none",BASTRA_TELEMETRY:"off",BASTRA_UPDATE_CHECK:"off",BASTRA_SESSION_HARVEST:"0",BASTRA_DAEMON_IDLE_SHUTDOWN_MS:"1000",BASTRA_HARVEST_QUEUE_PATH:join(home,".bastra/queue.json"),BASTRA_DRAFTS_PATH:join(home,".bastra/drafts.json"),BASTRA_PENDING_SUGGESTIONS_PATH:join(home,".bastra/relay.json"),BASTRA_VAULT_ROOTS_PATH:join(home,".bastra/roots.json"),BASTRA_HOST_PROFILE_PATH:join(home,".bastra/host.json")};
 delete env.BASTRA_DAEMON_STARTED_BY;delete env.BASTRA_AUTOSTART_MANAGED;delete env.INVOCATION_ID;
 try{await work(dir,env,port);}finally{
  // Detached fallback daemons use a fixture-only short idle timer. Poll health
  // (which is not activity), then remove the fixture only once its port is free.
  await until(async()=>{try{const r=await fetch(env.BASTRA_DAEMON_URL+"/health",{signal:AbortSignal.timeout(200)});return !r.ok;}catch{return true;}},15000);
  await rm(dir,{recursive:true,force:true});
 }
}
function daemon(env:NodeJS.ProcessEnv){const child=spawn(process.execPath,[script],{env,stdio:["ignore","pipe","pipe"]});let error="";child.stderr!.on("data",b=>error+=b);return {child,error:()=>error};}
async function stop(child:ChildProcess){if(child.exitCode===null&&child.signalCode===null){child.kill("SIGTERM");await once(child,"exit");}}
async function health(env:NodeJS.ProcessEnv){try{const r=await fetch(env.BASTRA_DAEMON_URL+"/health",{signal:AbortSignal.timeout(200)});return r.ok?await r.json() as {started_by?:string}:null;}catch{return null;}}
async function plist(env:NodeJS.ProcessEnv){const file=managedAutostartPlistPath(env.HOME);await mkdir(join(env.HOME!,"Library/LaunchAgents"),{recursive:true});await writeFile(file,managedXml);}
function worker(env:NodeJS.ProcessEnv,platform:NodeJS.Platform,wait?:number,disabled=false){
 const child=spawn(process.execPath,["--import","tsx",resolve("packages/daemon/__tests__/fixtures/service-forwarder-worker.mts"),platform,wait===undefined?"":String(wait),disabled?"disabled":""],{env,stdio:["ignore","pipe","pipe"]});let out="",error="";child.stdout!.on("data",b=>out+=b);child.stderr!.on("data",b=>error+=b);
 const result=once(child,"exit").then(([code])=>{assert.equal(code,0,error);return {value:JSON.parse(out) as {ready:boolean;ms:number;starter?:string;toolSucceeded?:boolean;plistOpens?:number},error};});return {child,result};
}

test("#758 managed service recognition is file-only, macOS-only and excludes foreign/corrupt XML",()=>fixture(async(_dir,env)=>{
 assert.equal(await managedAutostartInstalled({platform:"darwin",home:env.HOME}),false);await plist(env);assert.equal(await managedAutostartInstalled({platform:"darwin",home:env.HOME}),true);assert.equal(await managedAutostartInstalled({platform:"linux",home:env.HOME}),false);
 for(const text of ["{broken",'<plist><dict><key>Other</key><string>1</string></dict></plist>',`<!-- ${managedXml} -->`,managedXml.replace("EnvironmentVariables","Environment<!-- split -->Variables"),managedXml.replace("BASTRA_AUTOSTART_MANAGED","BASTRA_AUTO<!-- split -->START_MANAGED")]){await writeFile(managedAutostartPlistPath(env.HOME),text);assert.equal(await managedAutostartInstalled({platform:"darwin",home:env.HOME}),false);}
}));

test("#758 service arrives after 2 s: forwarder holds a real tool call and never spawns",()=>fixture(async(_dir,env)=>{
 await plist(env);const w=worker(env,"darwin");let service:ReturnType<typeof daemon>|undefined;
 try{await pause(2000);service=daemon({...env,BASTRA_AUTOSTART_MANAGED:"1",BASTRA_DAEMON_IDLE_SHUTDOWN_MS:"0"});const r=await w.result;assert.equal(r.value.ready,true);assert.equal(r.value.starter,"launchagent");assert.equal(r.value.toolSucceeded,true);assert.ok(r.value.ms>=1500&&r.value.ms<10000);assert.doesNotMatch(r.error,/spawning|falling back/);}
 finally{await stop(w.child);if(service)await stop(service.child);}
}));

test("#758 real MCP initializes before the service and holds a client call without an error", t => fixture(async (_dir,env) => {
 await plist(env);
 const client = new Client({name:"service-priority-fixture",version:"1"},{capabilities:{}});
 const transport = new StdioClientTransport({command:process.execPath,args:["--import",resolve("packages/daemon/__tests__/fixtures/service-forwarder-macos.mjs"),resolve("packages/daemon/dist/mcp-forwarder.js")],env:Object.fromEntries(Object.entries({...env,BASTRA_MCP_SESSION_CONTEXT:"0"}).filter((entry):entry is [string,string]=>typeof entry[1]==="string")),stderr:"pipe"});
 let error="", service:ReturnType<typeof daemon>|undefined;
 try {
  const started=performance.now();await client.connect(transport);const initialized=performance.now()-started;
  transport.stderr?.on("data",b=>error+=b);
  assert.ok(initialized<5000,"initialize must not await the ten-second service window");
  const callStarted=performance.now();const held=client.callTool({name:"load_memory",arguments:{id:"fixture-copper-valve"}});
  await pause(2000);service=daemon({...env,BASTRA_AUTOSTART_MANAGED:"1",BASTRA_DAEMON_IDLE_SHUTDOWN_MS:"0"});
  const response=await held;const callMs=performance.now()-callStarted;
  assert.ok(!response.isError);assert.match(JSON.stringify(response.content),/fixture-copper-valve/);assert.ok(callMs>=2000&&callMs<10000);assert.doesNotMatch(error,/spawning|falling back/);
  t.diagnostic(`MCP initialize ${initialized.toFixed(1)} ms; held call ${callMs.toFixed(1)} ms`);
 } finally {await client.close();if(service)await stop(service.child);}
}));

test("#758 broken installed service: real fallback starts after the full 10 s window",t=>fixture(async(_dir,env)=>{
 assert.equal(SERVICE_WAIT_MS,10000);await plist(env);const w=worker(env,"darwin");try{const r=await w.result;assert.equal(r.value.ready,true);assert.equal(r.value.starter,"forwarder");assert.equal(r.value.toolSucceeded,true);assert.ok(r.value.ms>=10000&&r.value.ms<18000);t.diagnostic(`fallback tool completed after ${r.value.ms.toFixed(1)} ms`);assert.equal((r.error.match(/managed service not healthy/g)||[]).length,1);}finally{await stop(w.child);}
}));

test("#758 no service: real client daemon starts immediately",t=>fixture(async(_dir,env)=>{
 const w=worker(env,"darwin");try{const r=await w.result;assert.equal(r.value.starter,"forwarder");assert.ok(r.value.ms<8000);t.diagnostic(`immediate-spawn tool completed after ${r.value.ms.toFixed(1)} ms`);assert.doesNotMatch(r.error,/falling back/);}finally{await stop(w.child);}
}));

test("#758 SPAWN=0 skips service waiting and spawning",()=>fixture(async(_dir,env)=>{
 await plist(env);const w=worker({...env,BASTRA_FORWARDER_SPAWN:"0"},"darwin",undefined,true);try{const r=await w.result;assert.equal(r.value.ready,false);assert.ok(r.value.ms<1000);assert.doesNotMatch(r.error,/spawning|falling back/);assert.equal(await health(env),null);}finally{await stop(w.child);}
}));

test("#758 healthy service skips the plist check entirely",()=>fixture(async(_dir,env)=>{
 await plist(env);const service=daemon({...env,BASTRA_AUTOSTART_MANAGED:"1",BASTRA_DAEMON_IDLE_SHUTDOWN_MS:"0"});let w:ReturnType<typeof worker>|undefined;
 try{await until(async()=>Boolean(await health(env)));w=worker(env,"darwin");const r=await w.result;assert.equal(r.value.starter,"launchagent");assert.equal(r.value.plistOpens,0);assert.doesNotMatch(r.error,/spawning|falling back/);}finally{if(w)await stop(w.child);await stop(service.child);}
}));

test("#758 outside macOS an installed plist does not delay real auto-spawn",()=>fixture(async(_dir,env)=>{
 await plist(env);const w=worker(env,"linux");try{const r=await w.result;assert.equal(r.value.starter,"forwarder");assert.ok(r.value.ms<8000);assert.doesNotMatch(r.error,/falling back/);}finally{await stop(w.child);}
}));

test("#758 two real daemons: service waits without storage, then replaces the idle forwarder",t=>fixture(async(dir,env)=>{
 const holder=daemon({...env,BASTRA_DAEMON_STARTED_BY:"forwarder",BASTRA_DAEMON_IDLE_SHUTDOWN_MS:"2500"});const serviceHome=join(dir,"service-home"),serviceVault=join(dir,"service-vault");await mkdir(serviceHome);await mkdir(serviceVault);await writeFile(join(serviceVault,"note.md"),memory);
 let service:ReturnType<typeof daemon>|undefined;
 try{await until(async()=>Boolean(await health(env)));service=daemon({...env,HOME:serviceHome,USERPROFILE:serviceHome,BASTRA_VAULT_PATH:serviceVault,BASTRA_AUTOSTART_MANAGED:"1",BASTRA_DAEMON_IDLE_SHUTDOWN_MS:"0"});await until(async()=>service!.error().includes("waiting for its idle exit"));assert.equal(service.child.exitCode,null);assert.deepEqual(await readdir(serviceHome),[]);assert.deepEqual(await readdir(serviceVault),["note.md"]);assert.doesNotMatch(service.error(),/vault loaded/);
 const takeoverStarted=performance.now();await until(async()=>(await health(env))?.started_by==="launchagent",10000);t.diagnostic(`service takeover after waiting ${(performance.now()-takeoverStarted).toFixed(1)} ms`);assert.equal(holder.child.exitCode,0);assert.match(holder.error(),/self-terminating/);assert.match(service.error(),/vault loaded: 1/);}
 finally{if(service)await stop(service.child);await stop(holder.child);}
}));

test("#758 foreign listener keeps the old clean exit and never opens storage",()=>fixture(async(dir,env,port)=>{
 const listener=createServer((_req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true,"started_by":"unrelated"}');});await new Promise<void>(r=>listener.listen(port,"127.0.0.1",r));const service=daemon({...env,BASTRA_AUTOSTART_MANAGED:"1"});
 try{const [code]=await once(service.child,"exit");assert.equal(code,0);assert.doesNotMatch(service.error(),/waiting for/);assert.deepEqual(await readdir(join(dir,"vault")),["note.md"]);assert.deepEqual(await readdir(env.HOME!),[]);assert.doesNotMatch(service.error(),/vault loaded/);}finally{await stop(service.child);await new Promise<void>(r=>listener.close(()=>r()));}
}));

test("#758 SIGTERM interrupts the waiting service immediately without storage side effects",t=>fixture(async(dir,env)=>{
 const holder=daemon({...env,BASTRA_DAEMON_STARTED_BY:"forwarder",BASTRA_DAEMON_IDLE_SHUTDOWN_MS:"0"});let service:ReturnType<typeof daemon>|undefined;const home=join(dir,"waiting-home"),vault=join(dir,"waiting-vault");await mkdir(home);
 try{await until(async()=>Boolean(await health(env)));service=daemon({...env,HOME:home,USERPROFILE:home,BASTRA_VAULT_PATH:vault,BASTRA_AUTOSTART_MANAGED:"1"});await until(async()=>service!.error().includes("waiting for its idle exit"));const start=performance.now();const exit=once(service.child,"exit");service.child.kill("SIGTERM");const [,signal]=await exit;assert.equal(signal,"SIGTERM");t.diagnostic(`SIGTERM ended waiter after ${(performance.now()-start).toFixed(1)} ms`);assert.ok(performance.now()-start<500);assert.deepEqual(await readdir(home),[]);await assert.rejects(stat(vault),{code:"ENOENT"});assert.equal((await health(env))?.started_by,"forwarder");}
 finally{if(service)await stop(service.child);await stop(holder.child);}
}));

test("#758 a direct/service daemon already owning the port is not waited on",()=>fixture(async(dir,env)=>{
 const holder=daemon({...env,BASTRA_AUTOSTART_MANAGED:"1",BASTRA_DAEMON_IDLE_SHUTDOWN_MS:"0"});let other:ReturnType<typeof daemon>|undefined;
 try{await until(async()=>Boolean(await health(env)));other=daemon({...env,BASTRA_AUTOSTART_MANAGED:"1",BASTRA_VAULT_PATH:join(dir,"never-open")});const [code]=await once(other.child,"exit");assert.equal(code,0);assert.doesNotMatch(other.error(),/waiting for/);await assert.rejects(stat(join(dir,"never-open")),{code:"ENOENT"});}finally{if(other)await stop(other.child);await stop(holder.child);}
}));

test("#758 non-macOS healthy redirects retain their existing behavior",()=>fixture(async(_dir,env,port)=>{
 const listener=createServer((req,res)=>{req.resume();if(req.url==="/health"){res.writeHead(302,{location:"/ready"});res.end();}else{res.setHeader("content-type","application/json");res.end(JSON.stringify({ok:true,started_by:"direct"}));}});await new Promise<void>(r=>listener.listen(port,"127.0.0.1",r));const w=worker(env,"linux");
 try{const r=await w.result;assert.equal(r.value.ready,true);assert.equal(r.value.starter,"direct");assert.doesNotMatch(r.error,/spawning|falling back/);}finally{await stop(w.child);await new Promise<void>(r=>listener.close(()=>r()));}
}));

test("#758 short internal retry intervals also stop when the owner changes",()=>fixture(async(_dir,_env,port)=>{
 assert.equal(SERVICE_PORT_RETRY_MAX_MS,30000);let forwarder=true;const listener=createServer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({ok:true,started_by:forwarder?"forwarder":"direct"}));});await new Promise<void>(r=>listener.listen(port,"127.0.0.1",r));
 try{const wait=waitForForwarderPort(port,{retryMs:10,maxRetryMs:20,onWaiting:()=>{forwarder=false;}});assert.equal(await wait,false);}finally{await new Promise<void>(r=>listener.close(()=>r()));}
}));

test("#758 doctor explains a managed service behind a running client daemon",()=>{
 const probe={ok:true,detail:"fixture",endpoint:{} as DaemonProbe["endpoint"],startedBy:"forwarder",envOrigin:"client"} as DaemonProbe;
 assert.match(daemonOriginLines(probe,configuredState(undefined,{BASTRA_AUTOSTART_MANAGED:"1"})).join("\n"),/managed service is installed.*client daemon holds the port/);
 assert.doesNotMatch(daemonOriginLines(probe,configuredState({BASTRA_TRIGGER_EXPAND:"0"},null)).join("\n"),/managed service is installed/);
});
