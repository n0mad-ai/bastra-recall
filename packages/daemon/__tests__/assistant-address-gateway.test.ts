import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assistantGatewayHandler } from "../src/assistant-address-gateway.js";
import { patchAssistantHosts } from "../src/assistant-address-files.js";

test("#1332: named gateway serves only UI, rejects rebinding/foreign origins, and reloads name", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-gateway-")); t.after(() => rm(dir, {recursive:true,force:true}));
  const settingsPath=join(dir,"settings.json"), hostsPath=join(dir,"hosts");
  await writeFile(settingsPath, JSON.stringify({ui:{enabled:true},assistant:{name:"jarvis"}}));
  await writeFile(hostsPath, patchAssistantHosts("127.0.0.1 localhost\n","jarvis",String(process.getuid?.()??0)));
  const seen: Array<{url?:string;origin?:string;host?:string}> = [];
  const backend=createServer((q,r)=>{seen.push({url:q.url,origin:q.headers.origin,host:q.headers.host});q.resume();r.end("ui-ok");});
  await new Promise<void>(r=>backend.listen(0,"127.0.0.1",r));
  t.after(()=>new Promise<void>(r=>backend.close(()=>r())));
  const daemonUrl=`http://127.0.0.1:${(backend.address() as any).port}`;
  const gateway=createServer(assistantGatewayHandler({settingsPath,hostsPath,daemonUrl}));
  await new Promise<void>(r=>gateway.listen(0,"127.0.0.1",r));
  t.after(()=>new Promise<void>(r=>gateway.close(()=>r())));
  const port=(gateway.address() as any).port;
  const call=(path:string,host=`jarvis.localhost:${port}`,origin?:string,method="GET",type="application/json")=>new Promise<{status:number;body:string;location?:string}>((resolve,reject)=>{
    const q=request({hostname:"127.0.0.1",port,path,method,headers:{Host:host,...(origin?{Origin:origin}:{}),"Content-Type":type}},r=>{let body="";r.on("data",c=>body+=c);r.on("end",()=>resolve({status:r.statusCode!,body,location:r.headers.location}));});q.on("error",reject);q.end(method==="POST"?"{}":undefined);
  });
  assert.equal((await call("/")).location,"/ui/");
  assert.equal((await call("/ui/")).body,"ui-ok");
  assert.equal((await call("/ui/",`jarvis:${port}`)).status,200);
  assert.equal((await call("/ui/",`jarvis.:${port}`)).status,200);
  assert.equal((await call("/ui/",`jarvis.localhost.:${port}`)).status,200);
  assert.equal((await call("/ui/annotate",`jarvis.:${port}`,`http://jarvis.:${port}`,"POST")).status,200);
  assert.equal((await call("/ui/",`jarvis..:${port}`)).status,403);
  assert.equal((await call("/ui/annotate",`jarvis.:${port}`,`http://evil.example.:${port}`,"POST")).status,403);
  assert.equal((await call("/ui/",`evil.example:${port}`)).status,403);
  for(const path of ["/hook/recall","/api/v1/mcp","/api/v1/save_memory","/health","/ui/../hook/recall"]) assert.equal((await call(path)).status,404,path);
  const before=seen.length;
  assert.equal((await call("/ui/annotate",undefined,"https://evil.example","POST")).status,403);
  assert.equal((await call("/ui/annotate",undefined,undefined,"POST","text/plain")).status,415);
  assert.equal(seen.length,before);
  assert.equal((await call("/ui/annotate",undefined,`http://jarvis.localhost:${port}`,"POST")).status,200);
  assert.equal(seen.at(-1)?.origin,daemonUrl);
  assert.equal(seen.at(-1)?.host,new URL(daemonUrl).host);
  await writeFile(settingsPath, JSON.stringify({ui:{enabled:true},assistant:{name:"ruby"}}));
  assert.equal((await call("/ui/")).status,403);
  assert.equal((await call("/ui/",`ruby.localhost:${port}`)).status,200);
});

test("#1332: the real unprivileged inetd entry serves an inherited accepted socket",async t=>{
 const {createServer:netServer}=await import("node:net"),{spawn}=await import("node:child_process"),{fileURLToPath}=await import("node:url");
 const dir=await mkdtemp(join(tmpdir(),"assistant-inetd-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const settingsPath=join(dir,"settings"),hostsPath=join(dir,"hosts");await writeFile(settingsPath,JSON.stringify({ui:{enabled:true},assistant:{name:"jarvis"}}));await writeFile(hostsPath,"");
 const backend=createServer((q,r)=>r.end("inherited-ui"));await new Promise<void>(r=>backend.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>backend.close(()=>r())));
 const children:any[]=[],sockets:any[]=[];let stderr="";
 const server=netServer({pauseOnConnect:true},socket=>{sockets.push(socket);const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../src/assistant-address-gateway.ts",import.meta.url)),"--assistant-address-inetd","--settings-path",settingsPath,"--hosts-path",hostsPath,"--daemon-url",`http://127.0.0.1:${(backend.address()as any).port}`],{stdio:[socket,socket,"pipe"]});children.push(child);child.stderr.on("data",c=>stderr+=c);child.on("exit",()=>socket.destroy());});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(async()=>{for(const c of children)c.kill();for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));});
 const port=(server.address()as any).port;
 const response=await new Promise<{status:number;body:string}>((resolve,reject)=>{const q=request({host:"127.0.0.1",port,path:"/ui/",headers:{Host:`jarvis.localhost:${port}`,Connection:"close"}},r=>{let body="";r.on("data",c=>body+=c);r.on("end",()=>resolve({status:r.statusCode!,body}));});q.setTimeout(10000,()=>q.destroy(new Error(`inherited socket timeout: ${stderr}`)));q.on("error",reject);q.end();});
 assert.equal(response.status,200,stderr);assert.equal(response.body,"inherited-ui");
});

test("release F: a managed socket helper prevents the daemon binding a competing listener",async t=>{
 const {createAssistantAddressListener}=await import("../src/assistant-address-gateway.js");const dir=await mkdtemp(join(tmpdir(),"assistant-managed-listener-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const settingsPath=join(dir,"settings"),helperPath=join(dir,"helper"),hostsPath=join(dir,"hosts");await writeFile(settingsPath,JSON.stringify({ui:{enabled:true},assistant:{name:"jarvis"}}));await writeFile(helperPath,'<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>501</string>');
 const listener=createAssistantAddressListener({settingsPath,hostsPath,daemonUrl:"http://127.0.0.1:9",owner:"501",helperPath} as any,0);t.after(()=>listener.close());
 const result=await listener.refresh();assert.equal(result.ready,false);assert.equal(result.port,undefined);
});

test("release F: one unprivileged child accepts multiple connections on inherited listening fd",async t=>{
 const {createServer:netServer}=await import("node:net"),{spawn}=await import("node:child_process"),{fileURLToPath}=await import("node:url");
 const dir=await mkdtemp(join(tmpdir(),"assistant-listening-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const settingsPath=join(dir,"settings"),hostsPath=join(dir,"hosts");await writeFile(settingsPath,JSON.stringify({ui:{enabled:true},assistant:{name:"jarvis"}}));await writeFile(hostsPath,"");
 const backend=createServer((q,r)=>r.end("persistent-ui"));await new Promise<void>(r=>backend.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>backend.close(()=>r())));
 const socket=netServer();await new Promise<void>(r=>socket.listen(0,"127.0.0.1",r));const port=(socket.address()as any).port,fd=(socket as any)._handle.fd;
 const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../src/assistant-address-gateway.ts",import.meta.url)),"--assistant-address-inetd","--settings-path",settingsPath,"--hosts-path",hostsPath,"--daemon-url",`http://127.0.0.1:${(backend.address()as any).port}`],{env:{...process.env,BASTRA_ASSISTANT_ADDRESS_LISTEN:"1"},stdio:[fd,"ignore","pipe"]});let stderr="";child.stderr.on("data",c=>stderr+=c);t.after(()=>child.kill());await new Promise<void>(r=>socket.close(()=>r()));
 for(let i=0;i<3;i++){
  const reply=await new Promise<string>((resolve,reject)=>{const q=request({host:"127.0.0.1",port,path:"/ui/",headers:{Host:`jarvis.localhost:${port}`,Connection:"close"}},r=>{let text="";r.on("data",c=>text+=c);r.on("end",()=>resolve(text));});q.setTimeout(10000,()=>q.destroy(Error(stderr||"listener timeout")));q.on("error",reject);q.end();});
  assert.equal(reply,"persistent-ui");assert.equal(child.exitCode,null,stderr);
 }
});
