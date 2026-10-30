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
