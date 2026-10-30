import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {setupAssistantAddress,removeAssistantAddress,assistantAddressStatus} from "../src/assistant-address.js";
import {setAssistantName,getAssistantName} from "../src/assistant-address-settings.js";
import {withPathLock} from "../src/path-lock.js";
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),"assistant-recovery-"));t.after(()=>rm(root,{recursive:true,force:true}));const service={loaded:false};
 const o={settingsPath:join(root,"settings"),hostsPath:join(root,"hosts"),helperPath:join(root,"helper"),runtimeDir:join(root,"runtime"),firefoxRoot:join(root,"firefox"),home:root,uid:"501",username:"fixture",platform:"darwin"as const,systemConsent:true,helperLoaded:async()=>service.loaded,ensureRuntime:async()=>{},runAdmin:async(p:any)=>{await writeFile(o.hostsPath,p.hostsAfter);if(p.helperAfter===null)await rm(o.helperPath,{force:true});else await writeFile(o.helperPath,p.helperAfter);service.loaded=p.helperAfter!==null;await p.onSettled?.(true);}};
 await writeFile(o.hostsPath,"127.0.0.1 localhost\n");await setAssistantName("Jarvis",o.settingsPath);return {o,service};
}
async function stopAndFail(o:Awaited<ReturnType<typeof fixture>>["o"],service:{loaded:boolean}){
 await assert.rejects(removeAssistantAddress({...o,runAdmin:async p=>{service.loaded=false;await p.onSettled?.(false);throw Error("hosts write failed");}}));
}
test("#1332 P1: setup repairs a failed removal and remove can resume a terminal partial state",async t=>{
 const {o,service}=await fixture(t);await setupAssistantAddress(o);await stopAndFail(o,service);
 assert.equal((await assistantAddressStatus(o)).partial,true);await assert.rejects(setupAssistantAddress({...o,systemConsent:false}),/Systemfreigabe/);await setupAssistantAddress(o);assert.equal(service.loaded,true);assert.equal((await assistantAddressStatus(o)).pending,false);
 await stopAndFail(o,service);await removeAssistantAddress(o);assert.equal(await getAssistantName(o.settingsPath),null);assert.equal(service.loaded,false);
});
test("#1332 P2: cancellation of an already-unloaded service is unchanged, not partial",async t=>{
 const {o,service}=await fixture(t);await setupAssistantAddress(o);service.loaded=false;let before:unknown;
 await assert.rejects(removeAssistantAddress({...o,runAdmin:async p=>{before=JSON.parse(await readFile(join(o.runtimeDir,"pending-admin.json"),"utf8")).helperLoadedBefore;await p.onSettled?.(false);throw Error("User canceled (-128)");}}),/abgebrochen.*nichts geändert/i);
 assert.equal(before,false);assert.equal((await assistantAddressStatus(o)).partial,false);assert.equal((await assistantAddressStatus(o)).pending,false);
});
test("#1332 P2: failed setup bootstrap retains service drift instead of claiming nothing changed",async t=>{
 const {o,service}=await fixture(t);await setupAssistantAddress(o);
 await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{service.loaded=false;await p.onSettled?.(false);throw Error("bootstrap failed");}}),/teilweise|Teilzustand|gestoppt/i);
 assert.equal((await assistantAddressStatus(o)).partial,true);await setupAssistantAddress(o);assert.equal(service.loaded,true);
});
test("#1332 P2: unrelated pending errors never instruct deleting the hosts block",async t=>{
 const {o,service}=await fixture(t);let plan:any;
 await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{plan=p;throw Error("timeout");}}));
 let s=await assistantAddressStatus(o);assert.doesNotMatch(s.repair??"",/Block.*entfernen/i);assert.match(s.repair??"",/warten|später|Dialog/i);
 await writeFile(o.hostsPath,plan.hostsAfter);await writeFile(o.helperPath,plan.helperAfter);await setAssistantName("Ruby",o.settingsPath);
 s=await assistantAddressStatus(o);assert.doesNotMatch(s.repair??"",/Block.*entfernen/i);assert.match(s.repair??"",/Einstellung|Namen/i);
 service.loaded=true;await plan.onSettled(true);s=await assistantAddressStatus(o);assert.doesNotMatch(s.repair??"",/Block.*entfernen/i);await setupAssistantAddress({...o,name:"Ruby"});assert.equal((await assistantAddressStatus(o)).pending,false);assert.equal(await getAssistantName(o.settingsPath),"ruby");
});
test("#1332 P2: a held lifecycle lock returns wait/retry advice, never a hosts deletion",{timeout:15000},async t=>{
 const {o}=await fixture(t);await mkdir(join(o.settingsPath,".."),{recursive:true});let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const held=withPathLock(o.settingsPath+".assistant-address-operation",async()=>{entered();await gate;},{strictLocal:true});await ready;
 const status=assistantAddressStatus(o);setTimeout(release,100);const s=await status;await held;assert.doesNotMatch(s.repair??"",/Block.*entfernen/i);assert.match(s.repair??"",/warten|erneut|später/i);
});

test("#1332 follow-up: early Firefox refusal and admin cancellation preserve the original partial intent",async t=>{
 const {o,service}=await fixture(t);await setupAssistantAddress(o);await stopAndFail(o,service);const original=JSON.parse(await readFile(join(o.runtimeDir,"pending-admin.json"),"utf8"));
 await mkdir(join(o.firefoxRoot,"profile"),{recursive:true});await writeFile(join(o.firefoxRoot,"profiles.ini"),"[Profile0]\nIsRelative=1\nPath=profile\n");
 await assert.rejects(setupAssistantAddress({...o,firefoxRunning:async()=>true}),/Firefox/);
 assert.equal(JSON.parse(await readFile(join(o.runtimeDir,"pending-admin.json"),"utf8")).id,original.id);assert.equal((await assistantAddressStatus(o)).partial,true);assert.equal(service.loaded,false);
 await assert.rejects(setupAssistantAddress({...o,firefoxRunning:async()=>false,runAdmin:async p=>{await p.onSettled?.(false);throw Error("User canceled (-128)");}}),/abgebrochen/i);
 assert.equal(JSON.parse(await readFile(join(o.runtimeDir,"pending-admin.json"),"utf8")).id,original.id);assert.equal((await assistantAddressStatus(o)).partial,true);assert.equal(service.loaded,false);
 await assert.rejects(readFile(join(o.runtimeDir,`recovered-${original.id}.json`)),{code:"ENOENT"});
 await setupAssistantAddress({...o,firefoxRunning:async()=>false});assert.equal(service.loaded,true);assert.equal(JSON.parse(await readFile(join(o.runtimeDir,`recovered-${original.id}.json`),"utf8")).intent.id,original.id);
});
test("#1332 follow-up: same-name UI POST with consent actually restores a partial service",async t=>{
 const {createServer}=await import("node:http"),{handleAssistantAddressUi}=await import("../src/http-assistant-address.js"),{setUiEnabled}=await import("../src/settings.js");const {o,service}=await fixture(t);await setupAssistantAddress(o);await stopAndFail(o,service);await setUiEnabled(true,o.settingsPath);let port=0;
 const server=createServer((q,r)=>{if(q.url!=="/ui/assistant-address"){r.writeHead(404);r.end("{}");return;}void handleAssistantAddressUi(q,r,q.method??"",q.url,{...o,gatewayPort:port,openBrowser:async()=>{}},async()=>({}));});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));port=(server.address()as {port:number}).port;t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const r=await fetch(`http://127.0.0.1:${port}/ui/assistant-address`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Jarvis",systemConsent:true})});assert.equal(r.status,200,await r.text());assert.equal(service.loaded,true);assert.equal((await assistantAddressStatus({...o,gatewayPort:port})).partial,false);
});
test("#1332 follow-up: rename from partial leaves exactly one owned hosts block",async t=>{
 const {changeAssistantName}=await import("../src/assistant-address.js");const {o,service}=await fixture(t);await setupAssistantAddress(o);await stopAndFail(o,service);await changeAssistantName("Ruby",o);
 const hosts=await readFile(o.hostsPath,"utf8");assert.equal((hosts.match(/# bastra-recall assistant-address 501 begin/g)??[]).length,1);assert.doesNotMatch(hosts,/jarvis/);assert.match(hosts,/ruby ruby\.localhost/);assert.equal(service.loaded,true);
});
test("#1332 follow-up: legacy intent without helperLoadedBefore survives a cancelled recovery",async t=>{
 const {o,service}=await fixture(t);await setupAssistantAddress(o);await stopAndFail(o,service);const path=join(o.runtimeDir,"pending-admin.json"),old=JSON.parse(await readFile(path,"utf8"));delete old.helperLoadedBefore;await writeFile(path,JSON.stringify(old));assert.equal((await assistantAddressStatus(o)).partial,true);
 await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{await p.onSettled?.(false);throw Error("User canceled (-128)");}}));assert.equal((await assistantAddressStatus(o)).partial,true);assert.equal(JSON.parse(await readFile(path,"utf8")).id,old.id);await setupAssistantAddress(o);assert.equal(service.loaded,true);
});
test("#1332 follow-up: bootstrap failure distinguishes a previously unloaded service and changed files",async t=>{
 const {o,service}=await fixture(t);await setupAssistantAddress(o);service.loaded=false;
 await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{await p.onSettled?.(false);throw Error("bootstrap failed");}}),/weiterhin nicht geladen|bereits entladen/i);assert.equal((await assistantAddressStatus(o)).partial,false);
 await writeFile(o.helperPath,(await readFile(o.helperPath,"utf8"))+"<!-- old version -->");
 await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{await writeFile(o.helperPath,p.helperAfter!);await p.onSettled?.(false);throw Error("bootstrap failed");}}),/weiterhin nicht geladen/i);assert.equal((await assistantAddressStatus(o)).partial,true);
});
test("#1332 follow-up: full uninstall can clear a local partial intent when system cleanup is already done",async t=>{
 const {cmdUninstall,parseArgs}=await import("../src/cli/commands.js"),{ADAPTERS}=await import("../src/cli/registry.js");assert.ok(cmdUninstall.length>=2,"isolated address IO must exist before invoking full uninstall");assert.ok(process.env.BASTRA_TEST_RUN_ROOT);
 const {o,service}=await fixture(t);await setupAssistantAddress(o);await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{service.loaded=false;await p.onSettled?.(false);throw Error("bootstrap failed");}}));await rm(o.helperPath);await writeFile(o.hostsPath,"127.0.0.1 localhost\n");
 const {addressRemovalNeedsConsent}=await import("../src/assistant-address.js");assert.equal(await addressRemovalNeedsConsent(o),false);
 for(const adapter of Object.values(ADAPTERS))t.mock.method(adapter,"uninstall",async()=>({status:"not-present"as const,message:"fixture"}));t.mock.method(process.stdout,"write",()=>true);
 assert.equal(await cmdUninstall(parseArgs(["uninstall","all"]),{address:o,notify:async()=>{}}),0);assert.equal(await getAssistantName(o.settingsPath),null);
});

test("#1332 follow-up: a late failed retry restores its durable original partial snapshot",async t=>{
 const {o,service}=await fixture(t);await setupAssistantAddress(o);await stopAndFail(o,service);const path=join(o.runtimeDir,"pending-admin.json"),original=JSON.parse(await readFile(path,"utf8"));let late:any;
 await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{late=p;throw Error("timeout");}}));const retry=JSON.parse(await readFile(path,"utf8"));assert.notEqual(retry.id,original.id);assert.equal(retry.recoveryOf.intent.id,original.id);assert.equal((await assistantAddressStatus(o)).pending,true);
 await late.onSettled(false);assert.equal((await assistantAddressStatus(o)).partial,true);assert.equal(JSON.parse(await readFile(path,"utf8")).id,original.id);assert.equal(service.loaded,false);await setupAssistantAddress(o);assert.equal(service.loaded,true);
});

test("release B: an expired intent without a living admin process stops blocking setup",async t=>{
 const {o}=await fixture(t);await assert.rejects(setupAssistantAddress({...o,runAdmin:async()=>{throw Error("lost dialog");}}));
 const path=join(o.runtimeDir,"pending-admin.json"),p=JSON.parse(await readFile(path,"utf8"));p.createdAt=Date.now()-3600000;p.adminPid=2147483647;p.ownerPid=2147483647;await writeFile(path,JSON.stringify(p));
 assert.equal((await assistantAddressStatus(o)).pending,false);await setupAssistantAddress(o);assert.equal((await assistantAddressStatus(o)).pending,false);
});

test("release D: uninstall reports damaged address state instead of throwing",async t=>{
 const {cmdUninstall,parseArgs}=await import("../src/cli/commands.js");const {o}=await fixture(t);
 t.mock.method(process.stderr,"write",()=>true);await writeFile(o.hostsPath,"# bastra-recall assistant-address 501 broken\n");
 assert.equal(await cmdUninstall(parseArgs(["uninstall","all"]),{address:o}),1);
});
