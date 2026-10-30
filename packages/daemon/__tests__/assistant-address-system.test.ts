import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { renderAssistantSocketPlist, makeAddressAdminScript } from "../src/assistant-address-admin.js";
import { changeAssistantName, setupAssistantAddress, removeAssistantAddress } from "../src/assistant-address.js";
import { getAssistantName } from "../src/assistant-address-settings.js";

test("#1332: socket plist binds both loopbacks and drops to the installing user", () => {
 const xml=renderAssistantSocketPlist({uid:"501",username:"fixture",home:"/Users/fixture",launcher:"/Users/fixture/address/launch.sh"});
 assert.match(xml,/<key>UserName<\/key>\s*<string>fixture<\/string>/);
 assert.match(xml,/127\.0\.0\.1/);assert.match(xml,/::1/);assert.match(xml,/<string>80<\/string>/);
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
