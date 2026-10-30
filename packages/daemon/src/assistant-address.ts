/** Assistant-address lifecycle. Defaults are real paths; tests supply isolated paths/IO. */
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile, execFileSync } from "node:child_process";
import { userInfo, homedir, hostname } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { withPathLock } from "./path-lock.js";
import { readSettings, settingsFilePath } from "./settings-file.js";
import { normalizeAssistantName, assistantUrls } from "./assistant-address-name.js";
import { patchAssistantHosts, managedAssistantHostsName, patchFirefoxUserJs, retiredFirefoxPreference } from "./assistant-address-files.js";
import { getAssistantName, setAssistantName } from "./assistant-address-settings.js";
import { renderAssistantSocketPlist, runMacAddressAdmin, shellQuote, type AddressAdminPlan } from "./assistant-address-admin.js";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";
import { stableNodeBin } from "./cli/autostart.js";

export interface AssistantAddressOptions {
 machineNames?:readonly string[];settingsPath?:string;hostsPath?:string;runtimeDir?:string;firefoxRoot?:string;helperPath?:string;uid?:string;username?:string;home?:string;platform?:NodeJS.Platform;daemonUrl?:string;systemConsent?:boolean;gatewayPort?:number;firefoxRunning?:()=>Promise<boolean>;openBrowser?:(url:string)=>Promise<void>;
 runAdmin?:(plan:AddressAdminPlan)=>Promise<void>;ensureRuntime?:()=>Promise<void>;
}
export function assistantAddressOptions(o:AssistantAddressOptions={}) {
 const home=o.home??homedir(),uid=o.uid??String(process.getuid?.()??0),platform=o.platform??process.platform;
 return {...o,home,uid,platform,username:o.username??userInfo().username,settingsPath:o.settingsPath??settingsFilePath(),runtimeDir:o.runtimeDir??join(home,".bastra","assistant-address"),
 hostsPath:o.hostsPath??(platform==="win32"?join(process.env.SystemRoot??"C:\\Windows","System32","drivers","etc","hosts"):"/etc/hosts"),
 helperPath:o.helperPath??`/Library/LaunchDaemons/ai.n0mad.bastra-recall.address.${uid}.plist`,
 firefoxRoot:o.firefoxRoot??(platform==="darwin"?join(home,"Library","Application Support","Firefox"):platform==="win32"?join(process.env.APPDATA??home,"Mozilla","Firefox"):join(home,".mozilla","firefox")),daemonUrl:o.daemonUrl??resolveDaemonEndpoint().baseUrl};
}
async function optional(path:string):Promise<string|null>{try{return await readFile(path,"utf8");}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}}
async function atomic(path:string,content:string){await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=`${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;await writeFile(temp,content,{mode:0o600,flag:"wx"});try{await rename(temp,path);}finally{await rm(temp,{force:true});}}
async function ownHelper(o:ReturnType<typeof assistantAddressOptions>){const text=await optional(o.helperPath);if(text!==null&&!text.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`))throw new Error("foreign assistant socket service — left unchanged");return text;}
async function state(o:ReturnType<typeof assistantAddressOptions>):Promise<{name?:string;firefoxFiles?:string[];firefoxOwnedPrefs?:Record<string,string[]>}|null>{const raw=await optional(join(o.runtimeDir,"state.json"));if(!raw)return null;try{return JSON.parse(raw);}catch{throw new Error("assistant address state is damaged");}}
function profileAllowed(path:string,root:string){const p=resolve(path),r=resolve(root);return p.startsWith(r+sep)&&p.endsWith(sep+"user.js");}
async function profileEdits(o:ReturnType<typeof assistantAddressOptions>,name:string|null){
 const previous=await state(o),files=new Set((previous?.firefoxFiles??[]).filter(p=>profileAllowed(p,o.firefoxRoot)));
 const ini=await optional(join(o.firefoxRoot,"profiles.ini"));
 if(ini)for(const section of ini.split(/^\[/m)){
  const path=/^Path=(.+)$/m.exec(section)?.[1]?.trim();if(!path)continue;
  const relative=/^IsRelative=1\s*$/m.test(section),file=join(relative?resolve(o.firefoxRoot,path):resolve(path),"user.js");
  if(profileAllowed(file,o.firefoxRoot))files.add(file);
 }
 const edits=[];for(const path of files){
  const before=await optional(path);edits.push({path,before,after:patchFirefoxUserJs(before??"",name,o.uid)});
  if(before && previous?.firefoxOwnedPrefs?.[path]?.includes(previous.name??"")){const prefs=join(dirname(path),"prefs.js"),persisted=await optional(prefs);if(persisted!==null){const after=retiredFirefoxPreference(persisted,before,name,o.uid,true);if(after!==persisted)edits.push({path:prefs,before:persisted,after});}}
 }return edits;
}
async function firefoxOwnership(o:ReturnType<typeof assistantAddressOptions>,name:string,profiles:Array<{path:string}>){
 const previous=await state(o),result:Record<string,string[]>={};
 for(const {path}of profiles.filter(p=>p.path.endsWith(sep+"user.js"))){
  const persisted=await optional(join(dirname(path),"prefs.js"))??"";
  const key=`browser.fixup.domainwhitelist.${name}`;
  const alreadyOwned=previous?.firefoxOwnedPrefs?.[path]?.includes(name);
  // A preference present before installation is user-owned, including false.
  if(alreadyOwned||!persisted.includes(key))result[path]=[name];
 }
 return result;
}
function machineNames(o:ReturnType<typeof assistantAddressOptions>):readonly string[]{
 if(o.machineNames)return o.machineNames;
 const names=[hostname()];if(o.platform==="darwin")try{names.push(execFileSync("/usr/sbin/scutil",["--get","LocalHostName"],{encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:1500}).trim());}catch{/* hostname remains reserved */}return names;
}
async function requireFirefoxClosed(o:ReturnType<typeof assistantAddressOptions>,edits:Array<{before:string|null;after:string}>){
 if(!edits.some(e=>e.before!==e.after))return;
 const running=o.firefoxRunning?await o.firefoxRunning():await new Promise<boolean>((resolve,reject)=>{
  if(o.platform!=="darwin"){resolve(false);return;}
  execFile("/usr/bin/pgrep",["-ix","firefox"],error=>{if(!error)resolve(true);else if((error as {code?:number|string}).code===1)resolve(false);else reject(new Error("Firefox-Status unbekannt; Firefox schließen und erneut versuchen."));});
 });
 if(running)throw new Error("Firefox vor der Einrichtung oder Änderung schließen, damit eigene Browser-Einträge sicher entfernt werden können.");
}
async function applyProfiles(edits:Array<{path:string;before:string|null;after:string}>){for(const e of edits)if(e.before!==e.after){await withPathLock(e.path,async()=>{if(await optional(e.path)!==e.before)throw new Error("Firefox preference changed during setup — retry");if(!e.after){if(e.before!==null)await rm(e.path);}else await atomic(e.path,e.after);});}}
async function restoreProfiles(edits:Array<{path:string;before:string|null;after:string}>){
 for(const e of [...edits].reverse())await withPathLock(e.path,async()=>{
  // Never undo a user's concurrent edit; restore only our exact output.
  if(await optional(e.path)!==e.after)return;
  if(e.before===null)await rm(e.path,{force:true});else await atomic(e.path,e.before);
 });
}
export async function ensureAssistantAddressRuntime(options:AssistantAddressOptions={}):Promise<void>{
 const o=assistantAddressOptions(options),source=dirname(fileURLToPath(import.meta.url));
 const files=["assistant-address-gateway.js","assistant-address-name.js","assistant-address-files.js","http-auth.js"];
 const contents=await Promise.all(files.map(async name=>[name,await readFile(join(source,name),"utf8")]as const));
 const digest=createHash("sha256").update(contents.map(([n,c])=>n+"\n"+c).join("\n")).digest("hex");
 const version=join(o.runtimeDir,"versions",digest);await mkdir(version,{recursive:true,mode:0o700});
 for(const [name,content]of contents)if(await optional(join(version,name))!==content)await atomic(join(version,name),content);
 await atomic(join(version,"package.json"),'{"type":"module"}\n');
 await atomic(join(o.runtimeDir,"managed"),`bastra-assistant-address:${o.uid}\n`);
 const command=[stableNodeBin(),join(version,"assistant-address-gateway.js"),"--assistant-address-inetd","--settings-path",o.settingsPath,"--hosts-path",o.hostsPath,"--daemon-url",o.daemonUrl].map(shellQuote).join(" ");
 await atomic(join(o.runtimeDir,"launch.sh"),`#!/bin/sh\nexec ${command}\n`);
}
export async function refreshAssistantAddressRuntime(options:AssistantAddressOptions={}):Promise<void>{const o=assistantAddressOptions(options);if(await optional(join(o.runtimeDir,"managed"))===`bastra-assistant-address:${o.uid}\n`)await ensureAssistantAddressRuntime(o);}
type ProfileEdit={path:string;before:string|null;after:string};
interface PendingAddress {id:string;plan:AddressAdminPlan;name:string|null;previousName:string|null;profiles:ProfileEdit[];desiredState:{version:number;name:string;firefoxFiles:string[];firefoxOwnedPrefs:Record<string,string[]>}|null;}
const pendingPath=(o:ReturnType<typeof assistantAddressOptions>)=>join(o.runtimeDir,"pending-admin.json");
const receiptPath=(o:ReturnType<typeof assistantAddressOptions>,id:string)=>join(o.runtimeDir,`admin-result-${id}.json`);
async function forgetPending(o:ReturnType<typeof assistantAddressOptions>,p:PendingAddress){await rm(pendingPath(o),{force:true});await rm(receiptPath(o,p.id),{force:true});}
/** Durable intent survives a lost osascript response and a daemon restart.
 * No root work is retried here: only exact observed system outputs are adopted. */
async function reconcileAssistantAddress(o:ReturnType<typeof assistantAddressOptions>):Promise<"none"|"completed"|"pending">{
 const raw=await optional(pendingPath(o));if(!raw)return "none";
 const p=JSON.parse(raw)as PendingAddress;
 if(!/^[a-f0-9-]{36}$/.test(p.id)||p.plan.hostsPath!==o.hostsPath||p.plan.helperPath!==o.helperPath||(p.name!==null&&p.name!==normalizeAssistantName(p.name))||!p.profiles.every(e=>profileAllowed(e.path,o.firefoxRoot)||profileAllowed(join(dirname(e.path),"user.js"),o.firefoxRoot)&&e.path.endsWith(sep+"prefs.js")))throw new Error("Adress-Abgleich beschädigt; bastra doctor prüfen, keine Systemänderung wiederholen.");
 const hosts=await optional(o.hostsPath),helper=await optional(o.helperPath),receipt=await optional(receiptPath(o,p.id));
 const observedDelta=p.plan.hostsAfter!==p.plan.hostsBefore||p.plan.helperAfter!==p.plan.helperBefore;
 const completedReceipt=receipt?JSON.parse(receipt).success===true:false;
 if((observedDelta||completedReceipt)&&hosts===p.plan.hostsAfter&&helper===p.plan.helperAfter&&managedAssistantHostsName(hosts??"",o.uid)===p.name){
  const current=await getAssistantName(o.settingsPath);if(current!==p.previousName&&current!==p.name)throw new Error("Einstellung während Systemfreigabe geändert; bastra doctor prüfen.");
  await requireFirefoxClosed(o,p.profiles);
  // Recovery is idempotent if the process died between individual user writes.
  const edits=[];for(const e of p.profiles){const actual=await optional(e.path);if(actual!==e.after&&!(actual===null&&e.after===""))edits.push(e);}
  await applyProfiles(edits);await setAssistantName(p.name,o.settingsPath);if(p.desiredState)await atomic(join(o.runtimeDir,"state.json"),JSON.stringify(p.desiredState)+"\n");else await rm(join(o.runtimeDir,"state.json"),{force:true});await forgetPending(o,p);if(p.name===null)await cleanupAddressRuntime(o);return "completed";
 }
 if(receipt&&JSON.parse(receipt).success===false&&hosts===p.plan.hostsBefore&&helper===p.plan.helperBefore){await forgetPending(o,p);return "none";}
 return "pending"; // A late privileged process may still finish. Keep its intent.
}
async function hasSystem(o:ReturnType<typeof assistantAddressOptions>){return !!(await state(o)||managedAssistantHostsName(await optional(o.hostsPath)??"",o.uid)||await ownHelper(o));}
async function changeAssistantNameUnlocked(value:string,options:AssistantAddressOptions={}):Promise<void>{
 const o=assistantAddressOptions(options),name=normalizeAssistantName(value,machineNames(o)),before=await getAssistantName(o.settingsPath);
 patchAssistantHosts(await optional(o.hostsPath)??"",name,o.uid); // check conflicts before saving
 if(before!==name&&await hasSystem(o)){if(!o.systemConsent)throw new Error("Systemänderung braucht Zustimmung (system consent); bastra address setup <name> --yes");await setupAssistantAddressUnlocked({...o,name} as AssistantAddressOptions & {name:string});return;}
 await setAssistantName(name,o.settingsPath);
}
async function setupAssistantAddressUnlocked(options:AssistantAddressOptions&{name?:string}={}){
 const o=assistantAddressOptions(options),name=normalizeAssistantName(options.name??await getAssistantName(o.settingsPath)??"",machineNames(o));
 if(!o.systemConsent)throw new Error("Systemeinrichtung braucht ausdrückliche Zustimmung (system consent)");
 if(o.platform!=="darwin")throw new Error("Automatische Systemeinrichtung ist nur auf macOS verfügbar; hosts/Port-80-Freigabe unter Windows/Linux durch den Administrator einrichten.");
 const hostsBefore=await optional(o.hostsPath);if(hostsBefore===null)throw new Error("hosts file missing");
 const hostsAfter=patchAssistantHosts(hostsBefore,name,o.uid),helperBefore=await ownHelper(o),profiles=await profileEdits(o,name);
 await requireFirefoxClosed(o,profiles);
 await(o.ensureRuntime??(()=>ensureAssistantAddressRuntime(o)))();
 const helperAfter=renderAssistantSocketPlist({uid:o.uid,username:o.username,home:o.home,launcher:join(o.runtimeDir,"launch.sh")});
 const plan:AddressAdminPlan={hostsPath:o.hostsPath,hostsBefore,hostsAfter,helperPath:o.helperPath,helperBefore,helperAfter,label:`ai.n0mad.bastra-recall.address.${o.uid}`};
 const previousName=await getAssistantName(o.settingsPath),firefoxOwnedPrefs=await firefoxOwnership(o,name,profiles);
 const pending:PendingAddress={id:randomUUID(),plan,name,previousName,profiles,desiredState:{version:2,name,firefoxOwnedPrefs,firefoxFiles:profiles.filter(p=>p.path.endsWith(sep+"user.js")).map(p=>p.path)}};
 await atomic(pendingPath(o),JSON.stringify(pending)+"\n");
 try{await(o.runAdmin??runMacAddressAdmin)({...plan,onSettled:async success=>atomic(receiptPath(o,pending.id),JSON.stringify({success})+"\n")});}
 catch{
  if(await reconcileAssistantAddress(o)==="completed")return {browserOpened:false,warning:"Admin-Rückmeldung fehlte; tatsächliche Systemeinrichtung geprüft und übernommen."};
  throw new Error("Systemeinrichtung nicht abschließend bestätigt, möglicherweise noch ausstehend. bastra address status prüft den tatsächlichen Zustand; Einrichtung nicht parallel wiederholen.");
 }
 try{
  await requireFirefoxClosed(o,profiles);await applyProfiles(profiles);await setAssistantName(name,o.settingsPath);
  await atomic(join(o.runtimeDir,"state.json"),JSON.stringify(pending.desiredState)+"\n");await forgetPending(o,pending);
 }catch(error){
  let rollbackError=false;
  try{await restoreProfiles(profiles);}catch{rollbackError=true;}
  try{await(o.runAdmin??runMacAddressAdmin)({...plan,hostsBefore:hostsAfter,hostsAfter:hostsBefore,helperBefore:helperAfter,helperAfter:helperBefore});}catch{rollbackError=true;}
  try{if(await getAssistantName(o.settingsPath)===name)await setAssistantName(previousName,o.settingsPath);}catch{rollbackError=true;}
  if(rollbackError)throw new Error("Einrichtung fehlgeschlagen; Rücknahme nicht vollständig bestätigt. bastra address status prüfen.");
  await forgetPending(o,pending);throw error;
 }
 let browserOpened=false;
 if(o.openBrowser){try{await o.openBrowser(`http://${name}/`);browserOpened=true;}catch{/* address remains valid; user can follow the displayed link */}}
 return {browserOpened};
}
async function cleanupAddressRuntime(o:ReturnType<typeof assistantAddressOptions>){
 if(await optional(join(o.runtimeDir,"managed"))===`bastra-assistant-address:${o.uid}\n`)await rm(o.runtimeDir,{recursive:true,force:true});else await rm(join(o.runtimeDir,"state.json"),{force:true});
}
async function removeAssistantAddressUnlocked(options:AssistantAddressOptions={}):Promise<void>{
 const o=assistantAddressOptions(options),hostsBefore=await optional(o.hostsPath)??"",helperBefore=await optional(o.helperPath),profiles=await profileEdits(o,null);
 await requireFirefoxClosed(o,profiles);
 const hostsAfter=patchAssistantHosts(hostsBefore,null,o.uid),ownedHelper=helperBefore?.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`)??false;
 let pending:PendingAddress|undefined;
 if(hostsAfter!==hostsBefore||ownedHelper){
  if(!o.systemConsent)throw new Error("Entfernen der Systemadresse braucht Zustimmung (system consent)");if(o.platform!=="darwin")throw new Error("Systemadresse durch den Administrator entfernen");
  const plan:AddressAdminPlan={hostsPath:o.hostsPath,hostsBefore,hostsAfter,helperPath:o.helperPath,helperBefore,helperAfter:ownedHelper?null:helperBefore,label:`ai.n0mad.bastra-recall.address.${o.uid}`};
  pending={id:randomUUID(),plan,name:null,previousName:await getAssistantName(o.settingsPath),profiles,desiredState:null};
  await atomic(pendingPath(o),JSON.stringify(pending)+"\n");const id=pending.id;
  try{await(o.runAdmin??runMacAddressAdmin)({...plan,onSettled:async success=>atomic(receiptPath(o,id),JSON.stringify({success})+"\n")});}
  catch{if(await reconcileAssistantAddress(o)==="completed")return;throw new Error("Entfernen nicht abschließend bestätigt; bastra address status prüft den tatsächlichen Zustand. Nicht parallel wiederholen.");}
 }
 await applyProfiles(profiles);await setAssistantName(null,o.settingsPath);if(pending)await forgetPending(o,pending);await cleanupAddressRuntime(o);
}
async function assistantAddressStatusUnlocked(options:AssistantAddressOptions={}){
 const o=assistantAddressOptions(options),name=await getAssistantName(o.settingsPath),enabled=(await readSettings(o.settingsPath)).ui?.enabled??false;
 let registered:string|null=null,error:string|undefined;try{registered=managedAssistantHostsName(await optional(o.hostsPath)??"",o.uid);}catch(e){error=(e as Error).message;}
 let listener=false;if(name&&enabled){try{const r=await fetch(`http://127.0.0.1:${o.gatewayPort??80}/.well-known/bastra-assistant-address`,{headers:{Host:`${name}.localhost:${o.gatewayPort??80}`},signal:AbortSignal.timeout(800)});const b=await r.json()as any;listener=r.ok&&b.service==="bastra-assistant-address"&&b.name===name;}catch{}}
 const repair=error?"hosts zuerst sichern (Backup). Den veränderten Block zwischen den eigenen bastra-recall assistant-address-Markierungen prüfen; eigene Anpassungen außerhalb des Blocks bewahren. Nur den vollständigen eigenen Block als Administrator entfernen, dann bastra address setup --yes erneut ausführen. Keine fremden Zeilen löschen.":undefined;
 return{repair,name,enabled,urls:name?assistantUrls(name):null,registeredName:registered,ready:listener,error,systemSetupSupported:o.platform==="darwin",firefoxProfiles:(await profileEdits(o,null)).filter(p=>p.path.endsWith(sep+"user.js")).length,bareNameNotice:"Einzelne Wörter können je nach Browser als Suche gelten. Adresse einmal öffnen; Firefox nach Einrichtung neu starten. <name>/ oder <name>.localhost bleibt die eindeutige Eingabe."};
}

export async function openAssistantAddress(url:string):Promise<void>{
 if(process.platform!=="darwin")return;
 await new Promise<void>((resolve,reject)=>{const c=spawn("/usr/bin/open",[url],{stdio:"ignore"});c.once("error",reject);c.once("exit",code=>code===0?resolve():reject(new Error("Browser konnte nicht geöffnet werden")));});
}
export async function hasManagedAssistantAddress(options:AssistantAddressOptions={}):Promise<boolean>{const o=assistantAddressOptions(options);if(await getAssistantName(o.settingsPath)||await state(o))return true;const hosts=await optional(o.hostsPath)??"";if(managedAssistantHostsName(hosts,o.uid))return true;return (await optional(o.helperPath))?.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`)??false;}
export async function addressRemovalNeedsConsent(options:AssistantAddressOptions={}):Promise<boolean>{const o=assistantAddressOptions(options);if(managedAssistantHostsName(await optional(o.hostsPath)??"",o.uid))return true;return (await optional(o.helperPath))?.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`)??false;}
export async function notifyAssistantAddressDaemon():Promise<void>{const base=resolveDaemonEndpoint().baseUrl;const u=new URL(base);if(!["127.0.0.1","localhost","[::1]"].includes(u.hostname))return;try{await fetch(`${base}/ui/assistant-address/refresh`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(1000)});}catch{/* saved configuration takes effect when daemon starts */}}

// A separate strict lock serializes UI/CLI lifecycles, including long admin prompts,
// without holding the settings-file lock or displacing a living process.
async function addressOperation<T>(options:AssistantAddressOptions,operation:()=>Promise<T>,allowPending=false):Promise<T>{
 const path=assistantAddressOptions(options).settingsPath+".assistant-address-operation";
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 return withPathLock(path,async assertOwnership=>{assertOwnership();if(await reconcileAssistantAddress(assistantAddressOptions(options))==="pending"&&!allowPending)throw new Error("Systemeinrichtung noch ausstehend; bastra address status und bastra doctor prüfen, nicht erneut starten.");const result=await operation();assertOwnership();return result;},{strictLocal:true});
}
export function changeAssistantName(value:string,options:AssistantAddressOptions={}):Promise<void>{return addressOperation(options,()=>changeAssistantNameUnlocked(value,options));}
export function setupAssistantAddress(options:AssistantAddressOptions&{name?:string}={}){return addressOperation(options,()=>setupAssistantAddressUnlocked(options));}
export function removeAssistantAddress(options:AssistantAddressOptions={}):Promise<void>{return addressOperation(options,()=>removeAssistantAddressUnlocked(options));}

export function assistantAddressStatus(options:AssistantAddressOptions={}){return addressOperation(options,async()=>{const o=assistantAddressOptions(options),s=await assistantAddressStatusUnlocked(o),pending=!!await optional(pendingPath(o));return {...s,pending,repair:pending?"Admin-Einrichtung noch nicht abschließend bestätigt. bastra address status später erneut prüfen. Bei unverändertem Zustand: laufenden macOS-Dialog beenden; keine zweite Einrichtung parallel starten. Bei manuell verändertem Systemzustand hosts sichern und bastra doctor zur Reparatur verwenden.":s.repair};},true);}
