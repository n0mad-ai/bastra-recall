import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,mkdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {setupAssistantAddress,removeAssistantAddress,assistantAddressStatus} from "../src/assistant-address.js";
import {setAssistantName} from "../src/assistant-address-settings.js";
import {patchAssistantHosts} from "../src/assistant-address-files.js";
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),"address-diagnostics-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const o={settingsPath:join(root,"settings"),hostsPath:join(root,"hosts"),helperPath:join(root,"helper"),runtimeDir:join(root,"runtime"),firefoxRoot:join(root,"firefox"),home:root,uid:"501",username:"fixture",platform:"darwin"as const,systemConsent:true,ensureRuntime:async()=>{},runAdmin:async(p:any)=>{await writeFile(o.hostsPath,p.hostsAfter);if(p.helperAfter===null)await rm(o.helperPath,{force:true});else await writeFile(o.helperPath,p.helperAfter);}};
 await writeFile(o.hostsPath,"127.0.0.1 localhost\n");await setAssistantName("Jarvis",o.settingsPath);return o;
}
test("#1332 P2: corrupt pending intent yields a concrete repair command instead of a Doctor loop",async t=>{
 const o=await fixture(t);await mkdir(o.runtimeDir);for(const raw of ["{broken","null","{}",JSON.stringify({id:"00000000-0000-0000-0000-000000000000"})]){
 await writeFile(join(o.runtimeDir,"pending-admin.json"),raw);
 const s=await assistantAddressStatus(o);assert.match(s.repair??"",/bastra address setup jarvis/);assert.match(s.repair??"",/pending-admin\.json.*\.backup/i);assert.equal(s.ready,false);
 }
});
test("#1332 P2: pending recovery blocked by Firefox remains diagnosable",async t=>{
 const o=await fixture(t);await mkdir(join(o.firefoxRoot,"profile"),{recursive:true});await writeFile(join(o.firefoxRoot,"profiles.ini"),"[Profile0]\nIsRelative=1\nPath=profile\n");let plan:any;
 await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{plan=p;throw Error("timeout");}}));await writeFile(o.hostsPath,plan.hostsAfter);await writeFile(o.helperPath,plan.helperAfter);
 const s=await assistantAddressStatus({...o,firefoxRunning:async()=>true});assert.match(s.repair??"",/Firefox.*schließen/);assert.match(s.repair??"",/bastra address setup jarvis/);
});
test("#1332 P2: modified hosts during pending recovery has a concrete repair command",async t=>{
 const o=await fixture(t);let plan:any;await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{plan=p;throw Error("timeout");}}));await writeFile(o.hostsPath,patchAssistantHosts("","jarvis","501").replace("127.0.0.1 jarvis","10.0.0.1 jarvis"));await writeFile(o.helperPath,plan.helperAfter);
 const s=await assistantAddressStatus(o);assert.match(s.repair??"",/hosts.*sichern/i);assert.match(s.repair??"",/bastra address setup jarvis/);
});
test("#1332 P2: confirmed admin cancellation clears intent and reports no change",async t=>{
 const o=await fixture(t),before=await readFile(o.hostsPath,"utf8");
 await assert.rejects(setupAssistantAddress({...o,runAdmin:async p=>{await p.onSettled?.(false);throw Error("User canceled (-128)");}}),/abgebrochen.*nichts geändert/i);
 assert.equal(await readFile(o.hostsPath,"utf8"),before);await assert.rejects(readFile(join(o.runtimeDir,"pending-admin.json")),{code:"ENOENT"});
});
test("#1332 P2: failed remove after service stop reports partial state even if files are unchanged",async t=>{
 const o=await fixture(t);await setupAssistantAddress(o);let loaded=true;
 const isolated={...o,helperLoaded:async()=>loaded};await assert.rejects(removeAssistantAddress({...isolated,runAdmin:async p=>{loaded=false;await p.onSettled?.(false);throw Error("hosts write failed");}}),/teilweise|gestoppt|Teilzustand/i);
 const s=await assistantAddressStatus(isolated);assert.equal((s as any).partial,true);assert.match(s.repair??"",/bastra address setup jarvis/);assert.match(s.error??"",/gestoppt|Teilzustand/i);
});
test("#1332 P2: CLI cancellation exits nonzero using only injected admin IO",async t=>{
 const {cmdAddress}=await import("../src/cli/address-cmd.js"),{parseArgs}=await import("../src/cli/commands.js");
 assert.ok(cmdAddress.length>=2,"isolated options must exist before the CLI is invoked");
 const o=await fixture(t),output=t.mock.method(process.stderr,"write",()=>true);
 const rc=await cmdAddress(parseArgs(["address","setup","Jarvis","--yes"]),{...o,runAdmin:async p=>{await p.onSettled?.(false);throw Error("User canceled (-128)");}});
 assert.equal(rc,1);assert.match(output.mock.calls.map(c=>String(c.arguments[0])).join(""),/abgebrochen.*nichts geändert/i);
});
