import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer,request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import ts from "typescript";
import { ensureAssistantAddressRuntime } from "../src/assistant-address.js";

async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),"assistant-runtime-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,"source");await mkdir(source);
 for(const name of ["assistant-address-bootstrap","assistant-address-gateway","assistant-address-name","assistant-address-files","http-auth"]){
  const text=await readFile(new URL(`../src/${name}.ts`,import.meta.url),"utf8");await writeFile(join(source,name+".js"),ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
 }
 const o={runtimeDir:join(root,"runtime"),runtimeSourceDir:source,runtimeNode:process.execPath,home:root,uid:String(process.getuid?.()??501),username:"fixture",settingsPath:join(root,"settings"),hostsPath:join(root,"hosts"),helperPath:join(root,"helper"),firefoxRoot:join(root,"firefox"),daemonUrl:"http://127.0.0.1:9"};
 await writeFile(o.settingsPath,JSON.stringify({ui:{enabled:true},assistant:{name:"jarvis"}}));await writeFile(o.hostsPath,"");return o;
}
async function call(port:number,host="127.0.0.1",path="/ui/"){return new Promise<{status:number;body:string}>((resolve,reject)=>{const q=request({host,port,path,headers:{Host:`jarvis.localhost:${port}`,Connection:"close"}},r=>{let body="";r.on("data",c=>body+=c);r.on("end",()=>resolve({status:r.statusCode!,body}));});q.on("error",reject);q.setTimeout(8000,()=>q.destroy(Error("fixture timeout")));q.end();});}
async function accepted(t:test.TestContext,o:Awaited<ReturnType<typeof fixture>>,host="127.0.0.1",port=0,env:Record<string,string>={}){
 const children:ReturnType<typeof spawn>[]=[],sockets:any[]=[];
 const server=createNetServer({pauseOnConnect:true},socket=>{sockets.push(socket);const child=spawn("/bin/sh",[join(o.runtimeDir,"launch.sh")],{stdio:[socket,socket,"pipe"],env:{...process.env,BASTRA_ASSISTANT_ADDRESS_PROTOCOL:"2",...env}});child.stderr?.resume();children.push(child);child.on("exit",()=>socket.destroy());});
 await new Promise<void>(r=>server.listen(port,host,r));t.after(async()=>{for(const child of children)child.kill();for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));});return (server.address()as any).port as number;
}
async function listening(t:test.TestContext,o:Awaited<ReturnType<typeof fixture>>,port=0){
 const server=createNetServer();await new Promise<void>(r=>server.listen(port,"127.0.0.1",r));port=(server.address()as any).port;
 const child=spawn("/bin/sh",[join(o.runtimeDir,"launch.sh")],{stdio:[(server as any)._handle.fd,"ignore","pipe"],env:{...process.env,BASTRA_ASSISTANT_ADDRESS_LISTEN:"1",BASTRA_ASSISTANT_ADDRESS_PROTOCOL:"2"},detached:true});child.stderr?.resume();t.after(()=>{try{process.kill(-child.pid!);}catch{}});await new Promise<void>(r=>server.close(()=>r()));return {child,port};
}
test("final helper review: pinned bootstrap returns 503 for missing node, deleted version or mixed protocol",async t=>{
 const o=await fixture(t);await ensureAssistantAddressRuntime(o);
 const state=JSON.parse(await readFile(join(o.runtimeDir,"current.json"),"utf8"));assert.equal(state.protocol,2);assert.match(state.version,/^[a-f0-9]{64}$/);
 const port=await accepted(t,o);
 for(const kind of ["missing-node","missing-version","mixed-protocol"]){
  await ensureAssistantAddressRuntime({...o,runtimeNode:kind==="missing-node"?join(o.home,"missing-node"):process.execPath});
  if(kind==="missing-version")await rm(join(o.runtimeDir,"versions",state.version),{recursive:true,force:true});
  if(kind==="mixed-protocol")await writeFile(join(o.runtimeDir,"versions",state.version,"assistant-address-gateway.js"),"export const ASSISTANT_SOCKET_PROTOCOL=1;\n");
  const r=await call(port);assert.equal(r.status,503,kind);assert.match(r.body,/bastra address setup --yes/i);
 }
});
test("final helper review: a broken Wait=true runtime drains several waiting requests without restart",async t=>{
 const o=await fixture(t);await ensureAssistantAddressRuntime(o);const state=JSON.parse(await readFile(join(o.runtimeDir,"current.json"),"utf8"));await rm(join(o.runtimeDir,"versions",state.version),{recursive:true,force:true});
 const {child,port}=await listening(t,o);for(let i=0;i<3;i++){assert.equal((await call(port)).status,503);assert.equal(child.exitCode,null);}
});
test("final helper review: persistent compatibility helper retires on version/endpoint change and starts fresh",async t=>{
 const o=await fixture(t),backend=createServer((_q,r)=>r.end("old-backend")),fresh=createServer((_q,r)=>r.end("fresh-backend"));
 for(const server of [backend,fresh]){await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));}
 const first={...o,daemonUrl:`http://127.0.0.1:${(backend.address()as any).port}`};await ensureAssistantAddressRuntime(first);const original=JSON.parse(await readFile(join(o.runtimeDir,"current.json"),"utf8"));
 const {child,port}=await listening(t,o);assert.equal((await call(port)).body,"old-backend");const exited=once(child,"exit");
 await writeFile(join(o.runtimeSourceDir,"assistant-address-gateway.js"),(await readFile(join(o.runtimeSourceDir,"assistant-address-gateway.js"),"utf8"))+"\n// new installed version\n");await ensureAssistantAddressRuntime({...o,daemonUrl:`http://127.0.0.1:${(fresh.address()as any).port}`});
 assert.notEqual(JSON.parse(await readFile(join(o.runtimeDir,"current.json"),"utf8")).version,original.version);
 await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error("helper did not retire")),3000).unref())]);
 const next=await listening(t,o,port);assert.equal((await call(next.port)).body,"fresh-backend");
});

test("final helper review: fresh-code handoff actually imports the installed helper module",async t=>{
 const mod=await import("../src/cli/update.js");assert.equal(typeof (mod as any).refreshAddressFromInstalledRuntime,"function");const o=await fixture(t),marker=join(o.home,"fresh-marker");
 await writeFile(join(o.runtimeSourceDir,"package.json"),'{"type":"module"}');await writeFile(join(o.runtimeSourceDir,"assistant-address.js"),`import {writeFile} from 'node:fs/promises';export async function refreshAssistantAddressRuntime(){await writeFile(${JSON.stringify(marker)},'new code');}`);
 await (mod as any).refreshAddressFromInstalledRuntime({node:process.execPath,script:join(o.runtimeSourceDir,"index.js"),version:"new"});assert.equal(await readFile(marker,"utf8"),"new code");
});

test("final helper review: both loopback families serve the same guarded UI and IPv6 cannot be rebound",async t=>{
 const o=await fixture(t),backend=createServer((_q,r)=>r.end("owned-ui"));await new Promise<void>(r=>backend.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>backend.close(()=>r())));
 await ensureAssistantAddressRuntime({...o,daemonUrl:`http://127.0.0.1:${(backend.address()as any).port}`});const port=await accepted(t,o);await accepted(t,o,"::1",port);
 assert.equal((await call(port)).body,"owned-ui");assert.equal((await call(port,"::1")).body,"owned-ui");
 const competitor=createNetServer();await new Promise<void>((resolve,reject)=>{competitor.once("error",(error:NodeJS.ErrnoException)=>{if(error.code==="EADDRINUSE")resolve();else reject(error);});competitor.listen(port,"::1",()=>{competitor.close();reject(Error("IPv6 was not reserved"));});});
});
test("final helper review: publishing a new bound port preserves the installed code version",async t=>{
 const {publishAssistantAddressEndpoint}=await import("../src/assistant-address.js");const o=await fixture(t);await ensureAssistantAddressRuntime(o);const path=join(o.runtimeDir,"current.json"),before=JSON.parse(await readFile(path,"utf8")),launcher=await readFile(join(o.runtimeDir,"launch.sh"),"utf8");
 await publishAssistantAddressEndpoint({...o,daemonUrl:"http://127.0.0.1:23456"});const after=JSON.parse(await readFile(path,"utf8"));assert.equal(after.version,before.version);assert.equal(after.daemonUrl,"http://127.0.0.1:23456");assert.notEqual(after.generation,before.generation);assert.equal(await readFile(join(o.runtimeDir,"launch.sh"),"utf8"),launcher);
});

test("final helper review: retiring a helper drains an active request before exit",async t=>{
 const o=await fixture(t);let enter!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const backend=createServer((_q,r)=>{enter();void gate.then(()=>r.end("completed-before-retire"));});await new Promise<void>(r=>backend.listen(0,"127.0.0.1",r));t.after(()=>{release();return new Promise<void>(r=>backend.close(()=>r()));});
 await ensureAssistantAddressRuntime({...o,daemonUrl:`http://127.0.0.1:${(backend.address()as any).port}`});const {child,port}=await listening(t,o),exited=once(child,"exit"),response=call(port);await ready;
 await ensureAssistantAddressRuntime({...o,daemonUrl:"http://127.0.0.1:9"});await new Promise(r=>setTimeout(r,350));assert.equal(child.exitCode,null,"active forwarding must finish before retirement");release();assert.equal((await response).body,"completed-before-retire");await exited;
});

test("final helper review: update retires only the old owned listener that predates runtime watching",async t=>{
 const o=await fixture(t);o.runtimeDir=join(o.home,"runtime.[owned]");await ensureAssistantAddressRuntime(o);await writeFile(o.helperPath,`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`);
 const state=JSON.parse(await readFile(join(o.runtimeDir,"current.json"),"utf8")),command=`${process.execPath} ${join(o.runtimeDir,"versions",state.version,"assistant-address-gateway.js")} --assistant-address-inetd --settings-path fixture`;
 const retired:number[]=[];
 await ensureAssistantAddressRuntime({...o,runtimeProcesses:async()=>[{pid:12345,uid:Number(o.uid),command},{pid:12346,uid:Number(o.uid)+1,command},{pid:12347,uid:Number(o.uid),command:"node unrelated-server.js"},{pid:12348,uid:Number(o.uid),command:command.replace(o.runtimeDir,join(o.home,"other-runtime"))}],retireRuntime:(pid:number)=>{retired.push(pid);}} as any);
 assert.deepEqual(retired,[12345],"pre-watcher processes require one user-owned retirement after the new runtime is durable");
});

test("runtime publication: a first-time launcher already serves UI at its atomic publication boundary",async t=>{
 const fs=(await import("node:fs/promises")).default,{syncBuiltinESMExports}=await import("node:module");const o=await fixture(t),backend=createServer((_q,r)=>r.end("first-publication-ui"));
 await new Promise<void>(r=>backend.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>backend.close(()=>r())));const port=await accepted(t,o),rename=fs.rename;let checked=false;
 t.mock.method(fs,"rename",async(from:any,to:any)=>{
  await rename(from,to);
  if(to===join(o.runtimeDir,"launch.sh")){checked=true;const response=await call(port);assert.equal(response.status,200,"new launcher must never be visible before its runtime state is usable");assert.equal(response.body,"first-publication-ui");}
 });
 syncBuiltinESMExports();
 try{await ensureAssistantAddressRuntime({...o,daemonUrl:`http://127.0.0.1:${(backend.address()as any).port}`});assert.equal(checked,true);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test("#1335: a connection burst starts at most 16 helpers and answers the rest with a clear overload page",{skip:!["/usr/bin/lockf","/usr/bin/flock"].some(p=>existsSync(p))?"no lockf/flock":false},async t=>{
 const o=await fixture(t);let held=0;const release:Array<()=>void>=[];
 const backend=createServer((_q,r)=>{held++;release.push(()=>r.end("burst-ui"));});await new Promise<void>(r=>backend.listen(0,"127.0.0.1",r));
 t.after(()=>{for(const done of release)done();return new Promise<void>(r=>backend.close(()=>r()));});
 await ensureAssistantAddressRuntime({...o,daemonUrl:`http://127.0.0.1:${(backend.address()as any).port}`});const port=await accepted(t,o);
 const results:Array<{status:number;body:string}>=[],pending=Array.from({length:20},()=>call(port).then(r=>{results.push(r);return r;}));
 for(const until=Date.now()+7000;Date.now()<until&&held+results.length<20;)await new Promise(r=>setTimeout(r,50));
 assert.equal(held,16,"at most 16 concurrent helpers may forward");
 assert.equal(results.length,4);for(const r of results){assert.equal(r.status,503);assert.match(r.body,/ausgelastet/);}
 for(const done of release.splice(0))done();
 const all=await Promise.all(pending);assert.equal(all.filter(r=>r.status===200&&r.body==="burst-ui").length,16);
 const after=call(port);for(const until=Date.now()+7000;Date.now()<until&&!release.length;)await new Promise(r=>setTimeout(r,50));
 release.splice(0).forEach(done=>done());assert.equal((await after).status,200,"slots are released when helpers exit");
});

test("#1335: idle and trickling clients cannot hold every helper slot",{skip:!["/usr/bin/lockf","/usr/bin/flock"].some(p=>existsSync(p))?"no lockf/flock":false},async t=>{
 const o=await fixture(t),backend=createServer((_q,r)=>r.end("slot-ui"));await new Promise<void>(r=>backend.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>backend.close(()=>r())));
 await ensureAssistantAddressRuntime({...o,daemonUrl:`http://127.0.0.1:${(backend.address()as any).port}`});
 const port=await accepted(t,o,"127.0.0.1",0,{BASTRA_ASSISTANT_ADDRESS_TEST_LIMITS:"1000,2500"});
 const {connect}=await import("node:net"),closed:Array<Promise<unknown>>=[],timers:NodeJS.Timeout[]=[];t.after(()=>timers.forEach(clearInterval));
 for(let i=0;i<16;i++){
  const s=connect(port,"127.0.0.1");s.on("error",()=>{});s.resume();t.after(()=>s.destroy());closed.push(new Promise(r=>s.on("close",r)));
  // Half send nothing; half complete one keep-alive request, then trickle the next headers forever.
  if(i%2)s.once("connect",()=>{s.write(`GET /ui/ HTTP/1.1\r\nHost: jarvis.localhost:${port}\r\n\r\nGET /ui/ HTTP/1.1\r\n`);timers.push(setInterval(()=>s.write("X-Slow: 1\r\n"),200));});
 }
 const start=Date.now();let status=0;
 while(Date.now()-start<9000&&status!==200){status=(await call(port).catch(()=>({status:0}))).status;if(status!==200)await new Promise(r=>setTimeout(r,200));}
 assert.equal(status,200,"the owner must get a slot once slow clients reach their deadline");
 // Below Node's 5 s keep-alive timeout: the trickling sockets end by the absolute lifetime.
 await Promise.all(closed);assert.ok(Date.now()-start<4500,"every slow connection is closed by its deadline");
});

test("#1335: a PID whose identity changed after inspection is never signalled",async t=>{
 const o=await fixture(t);o.runtimeDir=join(o.home,"runtime.[owned]");await ensureAssistantAddressRuntime(o);await writeFile(o.helperPath,`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`);
 const state=JSON.parse(await readFile(join(o.runtimeDir,"current.json"),"utf8")),command=`${process.execPath} ${join(o.runtimeDir,"versions",state.version,"assistant-address-gateway.js")} --assistant-address-inetd --settings-path fixture`;
 const uid=Number(o.uid),candidate={pid:12345,uid,command,started:"Sun Nov  8 10:00:00 2026"};
 for(const [now,expected] of [
  [{...candidate},[12345]],
  [{...candidate,command:"node unrelated-server.js"},[]],
  [{...candidate,uid:uid+1},[]],
  [{...candidate,started:"Sun Nov  8 10:00:01 2026"},[]],
  [null,[]],
 ] as const){
  const retired:number[]=[];
  await ensureAssistantAddressRuntime({...o,runtimeProcesses:async()=>[candidate],runtimeProcess:async()=>now,retireRuntime:(pid:number)=>{retired.push(pid);}} as any);
  assert.deepEqual(retired,expected,`identity at the signal boundary: ${JSON.stringify(now)}`);
 }
});


test("#1335: test limits cannot extend production helper deadlines",async t=>{
 const o=await fixture(t);await ensureAssistantAddressRuntime(o);
 const preload=join(o.home,"capture-timers.mjs"),record=join(o.home,"timer-delays");
 await writeFile(preload,`import {appendFileSync} from 'node:fs';const original=globalThis.setTimeout;globalThis.setTimeout=(fn,delay,...args)=>{appendFileSync(${JSON.stringify(record)},String(delay)+'\\n');return original(fn,delay,...args);};`);
 const port=await accepted(t,o,"127.0.0.1",0,{BASTRA_ASSISTANT_ADDRESS_TEST_LIMITS:"30000,600000",NODE_OPTIONS:`${process.env.NODE_OPTIONS??""} --import=${preload}`});
 const {connect}=await import("node:net"),socket=connect(port,"127.0.0.1");socket.on("error",()=>{});socket.resume();t.after(()=>socket.destroy());
 let delays:number[]=[];
 for(const until=Date.now()+5000;Date.now()<until;){try{delays=(await readFile(record,"utf8")).trim().split("\n").map(Number);}catch{}if(delays.length>=2)break;await new Promise(r=>setTimeout(r,25));}
 assert.deepEqual(delays.slice(0,2),[10000,230000],"test-only overrides must be capped at each production deadline");
});


async function legacyFixture(t:test.TestContext){
 const o=await fixture(t),version=join(o.runtimeDir,"versions","1".repeat(64));await mkdir(version,{recursive:true});
 for(const name of ["assistant-address-name.js","assistant-address-files.js","http-auth.js"])await writeFile(join(version,name),await readFile(join(o.runtimeSourceDir,name)));
 await writeFile(join(version,"package.json"),'{"type":"module"}');
 await writeFile(join(version,"assistant-address-gateway.js"),await readFile(new URL("../__fixtures__/assistant-address-v1/gateway.js",import.meta.url)));
 const q=(s:string)=>"'"+s.replaceAll("'","'\"'\"'")+"'";
 const launcher=`#!/bin/sh\nexec ${[process.execPath,join(version,"assistant-address-gateway.js"),"--assistant-address-inetd","--settings-path",o.settingsPath,"--hosts-path",o.hostsPath,"--daemon-url",o.daemonUrl].map(q).join(" ")}\n`;
 await writeFile(join(o.runtimeDir,"managed"),`bastra-assistant-address:${o.uid}\n`);await writeFile(join(o.runtimeDir,"launch.sh"),launcher);
 const helper=`<plist><dict><key>ProgramArguments</key><array><string>/bin/sh</string><string>${join(o.runtimeDir,"launch.sh")}</string></array><key>inetdCompatibility</key><dict><key>Wait</key><true/></dict><key>EnvironmentVariables</key><dict><key>BASTRA_ASSISTANT_ADDRESS_LISTEN</key><string>1</string><key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string></dict></dict></plist>\n`;
 await writeFile(o.helperPath,helper);return {o,launcher,helper};
}

test("#1335: first boot from a legacy updater migrates the Wait=true launcher without admin and repeats unchanged",async t=>{
 const {o,launcher,helper}=await legacyFixture(t),old=await listening(t,o);assert.equal((await call(old.port,"127.0.0.1","/.well-known/bastra-assistant-address")).status,200);
 const {Vault,SearchIndex}=await import("@bastra-recall/core"),{Telemetry}=await import("../src/telemetry.js"),{startHttpServer}=await import("../src/http.js");
 const vaultPath=join(o.home,"vault");await mkdir(vaultPath);const vault=new Vault(vaultPath);await vault.init();const search=new SearchIndex(vault);search.start();t.after(async()=>{search.stop();await vault.stop?.();});
 const retired:number[]=[];let admins=0;
 const address={...o,platform:"darwin" as const,port:0,runtimeProcesses:async()=>[],retireRuntime:(pid:number)=>{retired.push(pid);},runAdmin:async()=>{admins++;throw Error("no admin allowed");}};
 // Old updater fixture: new files are installed, but there is no call to the new updater's refresh hook.
 const handle=await startHttpServer({port:0,vault,search,telemetry:new Telemetry(),version:"new",toolDeps:{vault,search,telemetry:new Telemetry(),vaultPath},documentWriteEnabled:false,embedding:{on:false,providerId:null,source:"none"},assistantAddress:address});t.after(()=>handle.close());
 const path=join(o.runtimeDir,"current.json"),current=JSON.parse(await readFile(path,"utf8"));assert.equal(current.protocol,2);assert.equal(current.daemonUrl,`http://127.0.0.1:${handle.port}`);
 const migrated=await readFile(join(o.runtimeDir,"launch.sh"),"utf8");assert.match(migrated,/# Socket protocol 2/);assert.equal(await readFile(o.helperPath,"utf8"),helper);assert.equal(admins,0);
 const backup=JSON.parse(await readFile(join(o.runtimeDir,"protocol-1-backup.json"),"utf8"));assert.equal(backup.launcher,launcher);assert.equal(backup.current,null);
 old.child.kill();await once(old.child,"exit");const next=await listening(t,o);assert.equal((await call(next.port,"127.0.0.1","/.well-known/bastra-assistant-address")).status,200);
 const before=await readFile(path,"utf8"),{migrateAssistantAddressRuntime}=await import("../src/assistant-address.js");await migrateAssistantAddressRuntime({...address,daemonUrl:current.daemonUrl});assert.equal(await readFile(path,"utf8"),before);assert.equal(await readFile(join(o.runtimeDir,"launch.sh"),"utf8"),migrated);
 // Rollback only changes the launcher: its old pinned version and the untouched Wait=true job still work.
 await writeFile(join(o.runtimeDir,"launch.sh"),backup.launcher);process.kill(-next.child.pid!);await once(next.child,"exit");const rollback=await listening(t,o);assert.equal((await call(rollback.port,"127.0.0.1","/.well-known/bastra-assistant-address")).status,200);
});

test("#1335: interrupted migration leaves the legacy launcher usable and resumes with its original backup",async t=>{
 const {o,launcher}=await legacyFixture(t),fs=(await import("node:fs/promises")).default,{syncBuiltinESMExports}=await import("node:module"),rename=fs.rename;
 const {migrateAssistantAddressRuntime}=await import("../src/assistant-address.js");
 t.mock.method(fs,"rename",async(from:any,to:any)=>{if(to===join(o.runtimeDir,"launch.sh"))throw Error("interrupted before publication");return rename(from,to);});syncBuiltinESMExports();
 try{await assert.rejects(migrateAssistantAddressRuntime({...o,runtimeProcesses:async()=>[]}),/interrupted/);}finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.equal(await readFile(join(o.runtimeDir,"launch.sh"),"utf8"),launcher);const old=await listening(t,o);assert.equal((await call(old.port,"127.0.0.1","/.well-known/bastra-assistant-address")).status,200);
 const backup=await readFile(join(o.runtimeDir,"protocol-1-backup.json"),"utf8");await migrateAssistantAddressRuntime({...o,runtimeProcesses:async()=>[]});assert.equal(await readFile(join(o.runtimeDir,"protocol-1-backup.json"),"utf8"),backup);assert.match(await readFile(join(o.runtimeDir,"launch.sh"),"utf8"),/# Socket protocol 2/);
});


test("#1335: migration completion follows retirement and existing protocol-2 installs stay unchanged",async t=>{
 const {migrateAssistantAddressRuntime}=await import("../src/assistant-address.js"),late=await legacyFixture(t);let attempts=0;
 await assert.rejects(migrateAssistantAddressRuntime({...late.o,runtimeProcesses:async()=>{attempts++;throw Error("interrupted before retirement");}}),/interrupted before retirement/);
 assert.match(await readFile(join(late.o.runtimeDir,"launch.sh"),"utf8"),/# Socket protocol 2/);
 assert.equal(existsSync(join(late.o.runtimeDir,"protocol-2-migrated")),false);
 const usable=await listening(t,late.o);assert.equal((await call(usable.port,"127.0.0.1","/.well-known/bastra-assistant-address")).status,200);
 await migrateAssistantAddressRuntime({...late.o,runtimeProcesses:async()=>{attempts++;return [];}});assert.equal(attempts,2,"a published launcher must not skip unfinished retirement");assert.equal(await readFile(join(late.o.runtimeDir,"protocol-2-migrated"),"utf8"),"2\n");
 const modern=await fixture(t);await ensureAssistantAddressRuntime(modern);const path=join(modern.runtimeDir,"current.json"),before=await readFile(path,"utf8");
 await migrateAssistantAddressRuntime(modern);assert.equal(await readFile(path,"utf8"),before);assert.equal(existsSync(join(modern.runtimeDir,"protocol-1-backup.json")),false);assert.equal(existsSync(join(modern.runtimeDir,"protocol-2-migrated")),false);
});
