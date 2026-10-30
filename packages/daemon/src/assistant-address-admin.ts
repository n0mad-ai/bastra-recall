/** macOS system plan: launchd owns port 80; all request code runs as the user. */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function renderAssistantSocketPlist(i: {uid:string;username:string;home:string;launcher:string}): string {
  if (!/^[1-9]\d*$/.test(i.uid) || !/^[a-zA-Z_][a-zA-Z0-9._-]*$/.test(i.username) || i.username === "root") throw new Error("assistant socket handler must run as a non-root user");
  const socket = (host: string, family: string) => `<dict><key>SockNodeName</key><string>${host}</string><key>SockServiceName</key><string>80</string><key>SockFamily</key><string>${family}</string><key>SockType</key><string>stream</string><key>SockProtocol</key><string>TCP</string></dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>ai.n0mad.bastra-recall.address.${i.uid}</string>
<key>UserName</key><string>${xml(i.username)}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(i.launcher)}</string></array>
<key>inetdCompatibility</key><dict><key>Wait</key><false/></dict>
<key>Sockets</key><dict><key>UI</key><array>${socket("127.0.0.1","IPv4")}${socket("::1","IPv6")}</array></dict>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(i.home)}</string><key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${i.uid}</string></dict>
<key>StandardErrorPath</key><string>${xml(i.home)}/.bastra/assistant-address.log</string>
<key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>1</integer>
</dict></plist>\n`;
}
export interface AddressAdminPlan { hostsPath:string;hostsBefore:string;hostsAfter:string;helperPath:string;helperBefore:string|null;helperAfter:string|null;label:string;launchctl?:string;rootOwnership?:boolean;onSettled?:(success:boolean)=>Promise<void>;onStarted?:(pid:number)=>Promise<void>; }
export function makeAddressAdminScript(p: AddressAdminPlan, payloads?: ReadonlyMap<string,string>): string {
  const q=shellQuote, hash=existsSync("/usr/bin/shasum")?"/usr/bin/shasum -a 256":"/usr/bin/sha256sum";
  const ctl=q(p.launchctl??"/bin/launchctl"), domain=q(`system/${p.label}`);
  const check=(path:string,before:string|null)=>before===null
    ? `if [ -e ${q(path)} ]; then echo 'address setup conflict: file appeared' >&2; exit 1; fi`
    : `[ "$(${hash} ${q(path)} | /usr/bin/awk '{print $1}')" = ${q(digest(before))} ] || { echo 'address setup conflict: file changed' >&2; exit 1; }`;
  const write=(path:string,content:string,mode:string)=>[
    `/bin/mkdir -p ${q(dirname(path))}`,
    `tmp=$(/usr/bin/mktemp ${q(path+".bastra.XXXXXX")})`,
    ...(payloads ? [`/bin/cp ${q(payloads.get(digest(content))!)} "$tmp"`, `[ "$(${hash} "$tmp" | /usr/bin/awk '{print $1}')" = ${q(digest(content))} ] || { echo 'address payload changed' >&2; exit 1; }`] : [`/usr/bin/printf %s ${q(content)} > "$tmp"`]),
    `/bin/chmod ${mode} "$tmp"`,
    ...(p.rootOwnership===false?[]:[`/usr/sbin/chown root:wheel "$tmp"`]),
    `/bin/mv "$tmp" ${q(path)}`,`tmp=''`,
  ].join("\n");
  const lines=["set -eu","umask 077","tmp=''",`trap 'if [ -n "$tmp" ]; then /bin/rm -f "$tmp"; fi' EXIT`,check(p.hostsPath,p.hostsBefore),check(p.helperPath,p.helperBefore)];
  if(p.helperAfter!==null && p.helperAfter!==p.helperBefore){
    lines.push(write(p.helperPath,p.helperAfter,"0644"),`if ${ctl} print ${domain} >/dev/null 2>&1; then ${ctl} bootout ${domain}; /bin/sleep 2; fi`);
    lines.push(`if ! ${ctl} bootstrap system ${q(p.helperPath)}; then`,p.helperBefore===null?`/bin/rm -f ${q(p.helperPath)}`:write(p.helperPath,p.helperBefore,"0644"),...(p.helperBefore===null?[]:[`${ctl} bootstrap system ${q(p.helperPath)} || true`]),`echo 'assistant socket bootstrap failed; hosts unchanged' >&2; exit 1; fi`);
  }
  if(p.helperAfter!==null && p.helperAfter===p.helperBefore) lines.push(`if ! ${ctl} print ${domain} >/dev/null 2>&1; then ${ctl} bootstrap system ${q(p.helperPath)} || { echo 'assistant socket bootstrap failed; hosts unchanged' >&2; exit 1; }; fi`);
  if(p.helperAfter===null && p.helperBefore!==null) lines.push(`if ${ctl} print ${domain} >/dev/null 2>&1; then ${ctl} bootout ${domain}; fi`);
  if(p.hostsAfter!==p.hostsBefore) lines.push(check(p.hostsPath,p.hostsBefore),write(p.hostsPath,p.hostsAfter,"0644"));
  if(p.helperAfter===null && p.helperBefore!==null) lines.push(`/bin/rm -f ${q(p.helperPath)}`);
  if(p.launchctl===undefined) lines.push("/usr/bin/dscacheutil -flushcache || true");
  return lines.join("\n")+"\n";
}
export async function runMacAddressAdmin(plan: AddressAdminPlan, io?: {spawn?:(command:string,args:readonly string[],options:{stdio:["ignore","pipe","pipe"]})=>ChildProcess;timeoutMs?:number}): Promise<void> {
  io??={};
  let stage:string|undefined,finished=false;
  const settle=async(success:boolean)=>{if(finished)return;finished=true;try{await plan.onSettled?.(success);}finally{if(stage)await rm(stage,{recursive:true,force:true});}};
  try {
    stage=await mkdtemp(join(tmpdir(),"bastra-address-admin-"));
    const payloads=new Map<string,string>();
    for(const content of [plan.hostsAfter,plan.helperBefore,plan.helperAfter]){
      if(content===null||payloads.has(digest(content)))continue;
      const path=join(stage,digest(content));await writeFile(path,content,{mode:0o600,flag:"wx"});payloads.set(digest(content),path);
    }
    const script=makeAddressAdminScript(plan,payloads);
    await new Promise<void>((resolve,reject)=>{
      let child:ChildProcess;
      try{child=(io.spawn??spawn)("/usr/bin/osascript",["-e",`do shell script ${JSON.stringify(script)} with administrator privileges with prompt "Bastra: lokalen Assistentennamen und Port 80 einrichten"`],{stdio:["ignore","pipe","pipe"]});}
      catch{void settle(false).then(()=>reject(new Error("Systemfreigabe konnte nicht gestartet werden.")),reject);return;}
      let stderr="";child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-8192);});child.stdout?.resume();
      const started=child.pid?Promise.resolve(plan.onStarted?.(child.pid)).catch(()=>{/* owner PID and deadline remain available */}):Promise.resolve();
      const timer=setTimeout(()=>{reject(new Error("Systemeinrichtung läuft möglicherweise noch; bastra address status prüft und gleicht den tatsächlichen Zustand ab."));},io.timeoutMs??180000);
      const complete=(success:boolean,message:string)=>{clearTimeout(timer);void started.then(()=>settle(success)).then(()=>success?resolve():reject(new Error(message)),()=>reject(new Error("Admin-Ergebnis nicht gespeichert; bastra address status prüfen.")));};
      child.once("error",()=>complete(false,"Systemfreigabe konnte nicht gestartet werden."));
      child.once("exit",code=>complete(code===0,/-128/.test(stderr)?"Systemeinrichtung abgebrochen, nichts geändert.":"Systemeinrichtung fehlgeschlagen; bastra address status prüfen."));
    });
  }catch(error){
    // A reporting timeout leaves the process and its staged payloads intact.
    if(!finished && !/möglicherweise/.test((error as Error).message))await settle(false);
    throw error;
  }
}
