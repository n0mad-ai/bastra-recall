import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { renderAssistantSocketPlist, makeAddressAdminScript } from "../src/assistant-address-admin.js";
import { changeAssistantName, setupAssistantAddress, removeAssistantAddress } from "../src/assistant-address.js";
import { getAssistantName } from "../src/assistant-address-settings.js";

test("#1332: socket plist binds IPv4 loopback and drops to the installing user", () => {
 const xml=renderAssistantSocketPlist({uid:"501",username:"fixture",home:"/Users/fixture",launcher:"/Users/fixture/address/launch.sh"});
 assert.match(xml,/<key>UserName<\/key>\s*<string>fixture<\/string>/);
 assert.match(xml,/127\.0\.0\.1/);assert.doesNotMatch(xml,/<string>::<\/string>/);assert.match(xml,/<string>80<\/string>/);
 assert.match(xml,/<key>inetdCompatibility<\/key>/);assert.doesNotMatch(xml,/<string>root<\/string>/);
 assert.throws(()=>renderAssistantSocketPlist({uid:"0",username:"root",home:"/root",launcher:"/root/launch.sh"}));
});
test("#1332: admin plan is CAS guarded and preserves foreign hosts bytes in isolated execution",async t=>{
 const root=await mkdtemp(join(tmpdir(),"assistant-admin-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const hosts=join(root,"hosts"),helper=join(root,"address.plist"),ctl=join(root,"launchctl");
 await writeFile(hosts,"127.0.0.1 localhost\n");await writeFile(ctl,"#!/bin/sh\n[ \"$1\" = print ] && exit 1\nexit 0\n",{mode:0o755});
 const script=makeAddressAdminScript({hostsPath:hosts,hostsBefore:"127.0.0.1 localhost\n",hostsAfter:"127.0.0.1 localhost\n# added\n",helperPath:helper,helperBefore:null,helperAfter:"fixture plist",label:"ai.n0mad.bastra-recall.address.501",launchctl:ctl,rootOwnership:false});
 execFileSync("/bin/sh",["-n"],{input:script});
 await writeFile(hosts,"user changed hosts\n");
 assert.throws(()=>execFileSync("/bin/sh",["-c",script],{stdio:"pipe"}));
 assert.equal(await readFile(hosts,"utf8"),"user changed hosts\n");
 await writeFile(hosts,"127.0.0.1 localhost\n");execFileSync("/bin/sh",["-c",script],{stdio:"pipe"});
 assert.equal(await readFile(hosts,"utf8"),"127.0.0.1 localhost\n# added\n");
});
test("#1332: setup requires consent; rename and uninstall remove only owned hosts/prefs",async t=>{
 const root=await mkdtemp(join(tmpdir(),"assistant-lifecycle-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const settingsPath=join(root,"settings.json"),hostsPath=join(root,"hosts"),runtimeDir=join(root,"runtime"),firefoxRoot=join(root,"firefox"),helperPath=join(root,"helper.plist");
 await mkdir(join(firefoxRoot,"Profiles","default"),{recursive:true});
 await writeFile(join(firefoxRoot,"profiles.ini"),"[Profile0]\nIsRelative=1\nPath=Profiles/default\n");
 const userJs=join(firefoxRoot,"Profiles","default","user.js"),foreign='user_pref("unrelated.pref", true);\n';await writeFile(userJs,foreign);
 await writeFile(hostsPath,"127.0.0.1 localhost\n10.0.0.2 foreign\n");
 const before=await readFile(hostsPath,"utf8");let prompts=0;
 const opts={settingsPath,hostsPath,runtimeDir,firefoxRoot,helperPath,uid:"501",username:"fixture",home:root,platform:"darwin" as const,ensureRuntime:async()=>{},runAdmin:async (plan:any)=>{prompts++;await writeFile(hostsPath,plan.hostsAfter);if(plan.helperAfter===null)await rm(helperPath,{force:true});else await writeFile(helperPath,plan.helperAfter);}};
 await changeAssistantName("Jarvis",opts);
 await assert.rejects(setupAssistantAddress({...opts,systemConsent:false}),/consent|Zustimmung/i);
 assert.equal(prompts,0);assert.equal(await readFile(hostsPath,"utf8"),before);
 await setupAssistantAddress({...opts,systemConsent:true});
 assert.equal(prompts,1);assert.match(await readFile(userJs,"utf8"),/domainwhitelist\.jarvis/);
 await assert.rejects(changeAssistantName("Ruby",opts),/consent|Zustimmung/i);
 assert.equal(await getAssistantName(settingsPath),"jarvis");
 const prefsJs=join(firefoxRoot,"Profiles","default","prefs.js");
 await writeFile(prefsJs,'user_pref("unrelated.pref", true);\nuser_pref("browser.fixup.domainwhitelist.jarvis", true);\n');
 await changeAssistantName("Ruby",{...opts,systemConsent:true});
 assert.equal(await readFile(prefsJs,"utf8"),'user_pref("unrelated.pref", true);\n');
 assert.equal(await getAssistantName(settingsPath),"ruby");
 assert.doesNotMatch(await readFile(hostsPath,"utf8"),/jarvis/);assert.doesNotMatch(await readFile(userJs,"utf8"),/jarvis/);
 await removeAssistantAddress({...opts,systemConsent:true});
 assert.equal(await readFile(hostsPath,"utf8"),before);assert.equal(await readFile(userJs,"utf8"),foreign);assert.equal(await getAssistantName(settingsPath),null);
});

test("#1332: bootstrap failure leaves hosts unchanged and removes a newly staged helper",async t=>{
 const root=await mkdtemp(join(tmpdir(),"assistant-admin-fail-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const hosts=join(root,"hosts"),helper=join(root,"helper"),ctl=join(root,"ctl"),before="127.0.0.1 localhost\n";
 await writeFile(hosts,before);await writeFile(ctl,'#!/bin/sh\ncase "$1" in print|bootstrap) exit 1;; esac\nexit 0\n',{mode:0o755});
 const script=makeAddressAdminScript({hostsPath:hosts,hostsBefore:before,hostsAfter:before+"# new\n",helperPath:helper,helperBefore:null,helperAfter:"new helper",label:"fixture",launchctl:ctl,rootOwnership:false});
 assert.throws(()=>execFileSync("/bin/sh",["-c",script],{stdio:"pipe"}));assert.equal(await readFile(hosts,"utf8"),before);await assert.rejects(readFile(helper),{code:"ENOENT"});
});
test("#1332: a Firefox edit during admin consent rolls back system changes without clobbering the edit",async t=>{
 const root=await mkdtemp(join(tmpdir(),"assistant-rollback-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const firefoxRoot=join(root,"firefox"),profile=join(firefoxRoot,"profile"),settingsPath=join(root,"settings"),hostsPath=join(root,"hosts"),helperPath=join(root,"helper");
 await mkdir(profile,{recursive:true});await writeFile(join(firefoxRoot,"profiles.ini"),"[Profile0]\nIsRelative=1\nPath=profile\n");const pref=join(profile,"user.js");await writeFile(pref,'user_pref("foreign", true);\n');const before="127.0.0.1 localhost\n";await writeFile(hostsPath,before);let calls=0;
 const options={settingsPath,hostsPath,helperPath,firefoxRoot,runtimeDir:join(root,"runtime"),uid:"501",username:"fixture",home:root,platform:"darwin"as const,ensureRuntime:async()=>{},systemConsent:true,runAdmin:async(p:any)=>{calls++;await writeFile(hostsPath,p.hostsAfter);if(p.helperAfter===null)await rm(helperPath,{force:true});else await writeFile(helperPath,p.helperAfter);if(calls===1)await writeFile(pref,'user_pref("edited-during-consent", true);\n');}};
 await changeAssistantName("Jarvis",options);await assert.rejects(setupAssistantAddress(options),/changed|retry/i);
 assert.equal(await readFile(hostsPath,"utf8"),before);assert.equal(await readFile(pref,"utf8"),'user_pref("edited-during-consent", true);\n');assert.equal(calls,2);
});

test("#1332: another name change cannot race an outstanding admin consent",async t=>{
 const root=await mkdtemp(join(tmpdir(),"assistant-serial-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const settingsPath=join(root,"settings"),hostsPath=join(root,"hosts"),helperPath=join(root,"helper"),firefoxRoot=join(root,"firefox");await mkdir(firefoxRoot);await writeFile(hostsPath,"127.0.0.1 localhost\n");
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const options={settingsPath,hostsPath,helperPath,firefoxRoot,runtimeDir:join(root,"runtime"),uid:"501",username:"fixture",home:root,platform:"darwin"as const,ensureRuntime:async()=>{},runAdmin:async(p:any)=>{enter();await gate;await writeFile(hostsPath,p.hostsAfter);await writeFile(helperPath,p.helperAfter);}};
 await changeAssistantName("Jarvis",options);const first=setupAssistantAddress({...options,systemConsent:true});await entered;
 const second=changeAssistantName("Ruby",options).then(()=>"saved",()=>"rejected");
 await new Promise(r=>setTimeout(r,20));release();await first;
 assert.equal(await second,"rejected","name change must re-check consent after setup completes");assert.equal(await getAssistantName(settingsPath),"jarvis");
});

test("#1332: setup repairs an unchanged helper that is no longer loaded",async t=>{
 const root=await mkdtemp(join(tmpdir(),"assistant-repair-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const hosts=join(root,"hosts"),helper=join(root,"helper"),ctl=join(root,"ctl"),log=join(root,"calls");await writeFile(hosts,"original\n");await writeFile(helper,"same helper");
 await writeFile(ctl,`#!/bin/sh\necho "$1" >> '${log}'\n[ "$1" = print ] && exit 1\nexit 0\n`,{mode:0o755});
 const script=makeAddressAdminScript({hostsPath:hosts,hostsBefore:"original\n",hostsAfter:"original\n",helperPath:helper,helperBefore:"same helper",helperAfter:"same helper",label:"fixture",launchctl:ctl,rootOwnership:false});
 execFileSync("/bin/sh",["-c",script],{stdio:"pipe"});assert.match(await readFile(log,"utf8"),/bootstrap/);
});

test("#1332 review: admin failure after completed system writes reconciles settings and state",async t=>{
 const root=await mkdtemp(join(tmpdir(),"assistant-reconcile-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const settingsPath=join(root,"settings"),hostsPath=join(root,"hosts"),helperPath=join(root,"helper"),runtimeDir=join(root,"runtime");await writeFile(hostsPath,"127.0.0.1 localhost\n");
 const options={settingsPath,hostsPath,helperPath,runtimeDir,firefoxRoot:join(root,"firefox"),home:root,uid:"501",username:"fixture",platform:"darwin"as const,systemConsent:true,ensureRuntime:async()=>{},runAdmin:async(p:any)=>{await writeFile(hostsPath,p.hostsAfter);await writeFile(helperPath,p.helperAfter);throw new Error("admin timeout");}};
 await setupAssistantAddress({...options,name:"Ruby"});assert.equal(await getAssistantName(settingsPath),"ruby");assert.equal(JSON.parse(await readFile(join(runtimeDir,"state.json"),"utf8")).name,"ruby");
});
test("#1332 review: a late admin completion is reconciled when status is checked",async t=>{
 const {assistantAddressStatus}=await import("../src/assistant-address.js");
 const root=await mkdtemp(join(tmpdir(),"assistant-late-"));t.after(()=>rm(root,{recursive:true,force:true}));let plan:any;
 const settingsPath=join(root,"settings"),hostsPath=join(root,"hosts"),helperPath=join(root,"helper"),runtimeDir=join(root,"runtime");await writeFile(hostsPath,"127.0.0.1 localhost\n");
 const options={settingsPath,hostsPath,helperPath,runtimeDir,firefoxRoot:join(root,"firefox"),home:root,uid:"501",username:"fixture",platform:"darwin"as const,systemConsent:true,ensureRuntime:async()=>{},runAdmin:async(p:any)=>{plan=p;throw new Error("admin timeout");}};
 await assert.rejects(setupAssistantAddress({...options,name:"Ruby"}),/prüfen|pending|ausstehend/i);
 await writeFile(hostsPath,plan.hostsAfter);await writeFile(helperPath,plan.helperAfter);
 const status=await assistantAddressStatus(options);assert.equal(status.name,"ruby");assert.equal(JSON.parse(await readFile(join(runtimeDir,"state.json"),"utf8")).name,"ruby");
});
test("#1332 review: pre-existing user Firefox persisted whitelist is preserved",async t=>{
 const root=await mkdtemp(join(tmpdir(),"assistant-pref-owner-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const firefoxRoot=join(root,"firefox"),profile=join(firefoxRoot,"profile"),settingsPath=join(root,"settings"),hostsPath=join(root,"hosts"),helperPath=join(root,"helper");await mkdir(profile,{recursive:true});await writeFile(join(firefoxRoot,"profiles.ini"),"[Profile0]\nIsRelative=1\nPath=profile\n");const prefs=join(profile,"prefs.js"),original='user_pref("browser.fixup.domainwhitelist.jarvis", true);\n';await writeFile(prefs,original);await writeFile(hostsPath,"127.0.0.1 localhost\n");
 const options={settingsPath,hostsPath,helperPath,firefoxRoot,runtimeDir:join(root,"runtime"),uid:"501",username:"fixture",home:root,platform:"darwin"as const,ensureRuntime:async()=>{},systemConsent:true,runAdmin:async(p:any)=>{await writeFile(hostsPath,p.hostsAfter);if(p.helperAfter===null)await rm(helperPath,{force:true});else await writeFile(helperPath,p.helperAfter);}};
 await setupAssistantAddress({...options,name:"Jarvis"});await changeAssistantName("Ruby",options);assert.equal(await readFile(prefs,"utf8"),original);
});
test("#1332 review: Doctor status supplies a repair path for a modified owned hosts block",async t=>{
 const {assistantAddressStatus}=await import("../src/assistant-address.js"),{patchAssistantHosts}=await import("../src/assistant-address-files.js");const root=await mkdtemp(join(tmpdir(),"assistant-doctor-"));t.after(()=>rm(root,{recursive:true,force:true}));const hostsPath=join(root,"hosts");await writeFile(hostsPath,patchAssistantHosts("","jarvis","501").replace("127.0.0.1 jarvis","10.0.0.1 jarvis"));const status=await assistantAddressStatus({hostsPath,settingsPath:join(root,"settings"),runtimeDir:join(root,"runtime"),firefoxRoot:join(root,"firefox"),uid:"501"});assert.match((status as any).repair??"",/hosts.*(sichern|backup)/i);assert.match((status as any).repair??"",/bastra address setup/);
});

test("#1332 review: machine hostname cannot become the assistant alias",async t=>{
 const root=await mkdtemp(join(tmpdir(),"assistant-machine-"));t.after(()=>rm(root,{recursive:true,force:true}));const hostsPath=join(root,"hosts");await writeFile(hostsPath,"");await assert.rejects(changeAssistantName("Work-Mac",{hostsPath,settingsPath:join(root,"settings"),machineNames:["work-mac.local"]}));
});
test("#1332 review: timeout preserves the late native admin completion receipt",async()=>{
 const {runMacAddressAdmin}=await import("../src/assistant-address-admin.js"),{spawn}=await import("node:child_process");let done!:()=>void;const completion=new Promise<void>(r=>done=r);let completed=false;
 assert.ok(runMacAddressAdmin.length>=2,"native runner must accept isolated process IO before invocation");
 await assert.rejects(runMacAddressAdmin({hostsPath:"fixture",hostsBefore:"",hostsAfter:"",helperPath:"fixture",helperBefore:null,helperAfter:null,label:"fixture",onSettled:async success=>{completed=success;done();}},{timeoutMs:20,spawn:()=>spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),150)"],{stdio:"ignore"})}),/möglicherweise|noch/);
 await completion;assert.equal(completed,true,"late successful admin must be observed, never killed by the reporting timeout");
});

test("#1332 review: late removal is also reconciled without a second admin action",async t=>{
 const {assistantAddressStatus}=await import("../src/assistant-address.js");const root=await mkdtemp(join(tmpdir(),"assistant-remove-late-"));t.after(()=>rm(root,{recursive:true,force:true}));const settingsPath=join(root,"settings"),hostsPath=join(root,"hosts"),helperPath=join(root,"helper"),runtimeDir=join(root,"runtime");await writeFile(hostsPath,"127.0.0.1 localhost\n");let late:any;
 const options={settingsPath,hostsPath,helperPath,runtimeDir,firefoxRoot:join(root,"firefox"),home:root,uid:"501",username:"fixture",platform:"darwin"as const,systemConsent:true,ensureRuntime:async()=>{},runAdmin:async(p:any)=>{await writeFile(hostsPath,p.hostsAfter);await writeFile(helperPath,p.helperAfter);}};
 await setupAssistantAddress({...options,name:"Ruby"});await assert.rejects(removeAssistantAddress({...options,runAdmin:async p=>{late=p;throw new Error("timeout");}}));await writeFile(hostsPath,late.hostsAfter);await rm(helperPath);
 assert.equal((await assistantAddressStatus(options)).name,null);await assert.rejects(readFile(join(runtimeDir,"state.json")),{code:"ENOENT"});
});

test("#1332 review: unchanged repair waits for its admin receipt and blocks a second mutation",async t=>{
 const {assistantAddressStatus}=await import("../src/assistant-address.js");const root=await mkdtemp(join(tmpdir(),"assistant-repair-receipt-"));t.after(()=>rm(root,{recursive:true,force:true}));const settingsPath=join(root,"settings"),hostsPath=join(root,"hosts"),helperPath=join(root,"helper"),runtimeDir=join(root,"runtime");await writeFile(hostsPath,"127.0.0.1 localhost\n");
 const options={helperLoaded:async()=>false,settingsPath,hostsPath,helperPath,runtimeDir,firefoxRoot:join(root,"firefox"),home:root,uid:"501",username:"fixture",platform:"darwin"as const,systemConsent:true,ensureRuntime:async()=>{},runAdmin:async(p:any)=>{await writeFile(hostsPath,p.hostsAfter);await writeFile(helperPath,p.helperAfter);}};
 await setupAssistantAddress({...options,name:"Ruby"});let settled:((success:boolean)=>Promise<void>)|undefined;await assert.rejects(setupAssistantAddress({...options,runAdmin:async p=>{settled=p.onSettled;throw new Error("timeout");}}));assert.equal((await assistantAddressStatus(options)).pending,true);await assert.rejects(changeAssistantName("Jarvis",options),/ausstehend/);assert.ok(settled);await settled(false);assert.equal((await assistantAddressStatus(options)).pending,false);assert.equal(await getAssistantName(settingsPath),"ruby");
});

test("release B: large hosts never enter osascript argv and synchronous spawn errors settle once",async()=>{
 const {runMacAddressAdmin}=await import("../src/assistant-address-admin.js");let settled=0,argvSize=0;
 await assert.rejects(runMacAddressAdmin({hostsPath:"fixture",hostsBefore:"",hostsAfter:"# blocked\n".repeat(300000),helperPath:"fixture",helperBefore:null,helperAfter:null,label:"fixture",onSettled:async success=>{assert.equal(success,false);settled++;}},{spawn:(_cmd,args)=>{argvSize=args.join("").length;throw Object.assign(Error("spawn E2BIG"),{code:"E2BIG"});}}));
 assert.ok(argvSize<16000,"payload must be staged, never sent in argv");assert.equal(settled,1);
});

test("release B: staged multi-megabyte hosts execute with verified private payloads; tampering fails",async t=>{
 const {runMacAddressAdmin}=await import("../src/assistant-address-admin.js"),{spawn}=await import("node:child_process"),{statSync,writeFileSync}=await import("node:fs");
 const root=await mkdtemp(join(tmpdir(),"assistant-large-"));t.after(()=>rm(root,{recursive:true,force:true}));const hosts=join(root,"hosts"),ctl=join(root,"ctl"),before="localhost\n",after=before+"# blocked\n".repeat(300000);
 await writeFile(hosts,before);await writeFile(ctl,"#!/bin/sh\nexit 0\n",{mode:0o755});
 const plan={hostsPath:hosts,hostsBefore:before,hostsAfter:after,helperPath:join(root,"helper"),helperBefore:null,helperAfter:null,label:"fixture",rootOwnership:false,launchctl:ctl};
 for(const tamper of [true,false]){
  const run=runMacAddressAdmin(plan,{spawn:(_cmd,args)=>{
   assert.ok(args.join("").length<16000);const encoded=args[1]!.slice("do shell script ".length).split(" with administrator privileges")[0]!,script=JSON.parse(encoded);
   const path=/\/usr\/bin\/head -c \d+ '([^']+)'/.exec(script)![1]!;assert.equal(statSync(path).mode&0o777,0o600);assert.equal(statSync(join(path,"..")).mode&0o777,0o700);if(tamper)writeFileSync(path,"tampered");
   return spawn("/bin/sh",["-c",script],{stdio:["ignore","pipe","pipe"]});
  }});
  if(tamper){await assert.rejects(run);assert.equal(await readFile(hosts,"utf8"),before);}else{await run;assert.equal(await readFile(hosts,"utf8"),after);}
 }
});

test("release F: helper gets one listening socket and no user-writable stderr path",()=>{
 const xml=renderAssistantSocketPlist({uid:"501",username:"fixture",home:"/Users/fixture",launcher:"/Users/fixture/launch.sh"});
 assert.match(xml,/<key>Wait<\/key><true\/>/);assert.match(xml,/<key>StandardErrorPath<\/key><string>\/dev\/null<\/string>/);
 assert.equal((xml.match(/<key>SockNodeName<\/key>/g)??[]).length,1,"Wait=true receives one listener on stdio");
});

test("admin hardening: staged data rejects symlinks/FIFOs and reads at most the expected byte count",async t=>{
 const {createHash}=await import("node:crypto"),{symlink}=await import("node:fs/promises");const root=await mkdtemp(join(tmpdir(),"assistant-hardening-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const hosts=join(root,"hosts"),payload=join(root,"payload"),content="Grüße\n",before="before\n";
 const plan={hostsPath:hosts,hostsBefore:before,hostsAfter:content,helperPath:join(root,"helper"),helperBefore:null,helperAfter:null,label:"fixture",rootOwnership:false,launchctl:join(root,"unused-ctl")};
 const script=makeAddressAdminScript(plan,new Map([[createHash("sha256").update(content).digest("hex"),payload]]));
 assert.match(script,/\[ -f [^\n]+\] && \[ ! -L /,"type check must precede opening attacker-controlled data");
 assert.match(script,new RegExp(`head -c ${Buffer.byteLength(content)} `),"bounded read must use bytes, not JS string length");
 for(const kind of ["symlink","fifo","oversized"]){
  await writeFile(hosts,before);await rm(payload,{force:true});
  if(kind==="symlink")await symlink("/dev/zero",payload);
  else if(kind==="fifo")execFileSync("/usr/bin/mkfifo",[payload]);
  else await writeFile(payload,content+"Z".repeat(2000000));
  if(kind==="oversized"){execFileSync("/bin/sh",["-c",script],{timeout:2000,stdio:"pipe"});assert.equal(await readFile(hosts,"utf8"),content);}
  else{assert.throws(()=>execFileSync("/bin/sh",["-c",script],{timeout:1000,stdio:"pipe"}),(e:any)=>{assert.equal(e.signal,null,"must reject immediately instead of hanging");return true;});assert.equal(await readFile(hosts,"utf8"),before);}
 }
});

test("admin hardening: failed PID persistence is visible and keeps a timed-out process pending",async t=>{
 const {runMacAddressAdmin}=await import("../src/assistant-address-admin.js"),{spawn}=await import("node:child_process");let warning="",done!:()=>void;const completed=new Promise<void>(r=>done=r);
 t.mock.method(process.stderr,"write",(s:any)=>{warning+=String(s);return true;});
 await assert.rejects(runMacAddressAdmin({hostsPath:"fixture",hostsBefore:"",hostsAfter:"",helperPath:"fixture",helperBefore:null,helperAfter:null,label:"fixture",onStarted:async()=>{throw Error("disk write failed");},onSettled:async()=>done()},{timeoutMs:20,spawn:()=>spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),100)"],{stdio:"ignore"})}),/PID.*nicht gesichert/);
 assert.match(warning,/PID.*nicht gesichert/);await completed;
});
