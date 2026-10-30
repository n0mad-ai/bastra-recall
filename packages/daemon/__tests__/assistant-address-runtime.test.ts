import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer,request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
async function call(port:number,host="127.0.0.1"){return new Promise<{status:number;body:string}>((resolve,reject)=>{const q=request({host,port,path:"/ui/",headers:{Host:`jarvis.localhost:${port}`,Connection:"close"}},r=>{let body="";r.on("data",c=>body+=c);r.on("end",()=>resolve({status:r.statusCode!,body}));});q.on("error",reject);q.setTimeout(8000,()=>q.destroy(Error("fixture timeout")));q.end();});}
async function accepted(t:test.TestContext,o:Awaited<ReturnType<typeof fixture>>,host="127.0.0.1",port=0){
 const children:ReturnType<typeof spawn>[]=[],sockets:any[]=[];
 const server=createNetServer({pauseOnConnect:true},socket=>{sockets.push(socket);const child=spawn("/bin/sh",[join(o.runtimeDir,"launch.sh")],{stdio:[socket,socket,"pipe"],env:{...process.env,BASTRA_ASSISTANT_ADDRESS_PROTOCOL:"2"}});child.stderr?.resume();children.push(child);child.on("exit",()=>socket.destroy());});
 await new Promise<void>(r=>server.listen(port,host,r));t.after(async()=>{for(const child of children)child.kill();for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));});return (server.address()as any).port as number;
}
async function listening(t:test.TestContext,o:Awaited<ReturnType<typeof fixture>>,port=0){
 const server=createNetServer();await new Promise<void>(r=>server.listen(port,"127.0.0.1",r));port=(server.address()as any).port;
 const child=spawn("/bin/sh",[join(o.runtimeDir,"launch.sh")],{stdio:[(server as any)._handle.fd,"ignore","pipe"],env:{...process.env,BASTRA_ASSISTANT_ADDRESS_LISTEN:"1",BASTRA_ASSISTANT_ADDRESS_PROTOCOL:"2"}});child.stderr?.resume();t.after(()=>child.kill());await new Promise<void>(r=>server.close(()=>r()));return {child,port};
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
