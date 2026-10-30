/** macOS system plan: launchd owns port 80; all request code runs as the user. */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, rm, lstat, open, readdir, rename } from "node:fs/promises";
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
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(i.home)}</string><key>BASTRA_ASSISTANT_ADDRESS_PROTOCOL</key><string>2</string><key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${i.uid}</string></dict>
<key>StandardErrorPath</key><string>/dev/null</string>
<key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>0</integer>
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
    ...(payloads ? [`[ -f ${q(payloads.get(digest(content))!)} ] && [ ! -L ${q(payloads.get(digest(content))!)} ] || { echo 'unsafe address payload' >&2; exit 1; }`, `/usr/bin/head -c ${Buffer.byteLength(content,"utf8")} ${q(payloads.get(digest(content))!)} > "$tmp"`, `[ "$(${hash} "$tmp" | /usr/bin/awk '{print $1}')" = ${q(digest(content))} ] || { echo 'address payload changed' >&2; exit 1; }`] : [`/usr/bin/printf %s ${q(content)} > "$tmp"`]),
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
/** Only ESRCH proves a recorded child is gone; unknown permissions/identity stay pending. */
export function addressAdminProcessAlive(pid:unknown):boolean|null {
  if(typeof pid!=="number"||!Number.isSafeInteger(pid)||pid<=0)return null;
  try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==="ESRCH"?false:null;}
}
/** Remove only private staging with a durable child PID proven dead after its grace period.
 * Unknown legacy directories and active dialogs are deliberately retained. */
export async function cleanupMacAddressAdminStaging(root=tmpdir(),now=Date.now()):Promise<void>{
  const uid=process.getuid?.();if(uid===undefined)return;
  for(const name of await readdir(root).catch(()=>[] as string[])){
    if(!/^bastra-address-admin-[a-zA-Z0-9]+$/.test(name))continue;
    const dir=join(root,name),metadata=join(dir,"process.json");
    try{
      const info=await lstat(dir);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid||(info.mode&0o777)!==0o700)continue;
      // O_NOFOLLOW rejects a swapped symlink; O_NONBLOCK prevents a swapped
      // FIFO from hanging cleanup. Validate and read the SAME open inode.
      const handle=await open(metadata,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      let p;
      try{
        const file=await handle.stat();if(!file.isFile()||file.uid!==uid||(file.mode&0o777)!==0o600||file.size>4096)continue;
        const bytes=Buffer.alloc(4097),read=await handle.read(bytes,0,bytes.length,0);
        if(read.bytesRead>4096)continue;
        p=JSON.parse(bytes.toString("utf8",0,read.bytesRead));
      }finally{await handle.close();}
      if(p.version!==1||!Number.isFinite(p.createdAt)||now-p.createdAt<=300000||addressAdminProcessAlive(p.adminPid)!==false)continue;
      await rm(dir,{recursive:true,force:true});
    }catch{/* missing, damaged, changed or inaccessible staging is never guessed safe */}
  }
}
export async function runMacAddressAdmin(plan: AddressAdminPlan, io?: {spawn?:(command:string,args:readonly string[],options:{stdio:["ignore","pipe","pipe"]})=>ChildProcess;timeoutMs?:number}): Promise<void> {
  io??={};
  let stage:string|undefined,finished=false;
  const settle=async(success:boolean)=>{if(finished)return;finished=true;try{await plan.onSettled?.(success);}finally{if(stage)await rm(stage,{recursive:true,force:true});}};
  try {
    await cleanupMacAddressAdminStaging();
    const createdAt=Date.now();
    stage=await mkdtemp(join(tmpdir(),"bastra-address-admin-"));
    await writeFile(join(stage,"process.json"),JSON.stringify({version:1,createdAt}),{mode:0o600,flag:"wx"});
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
      let pidUnsecured=false;
      const started=(async()=>{
        if(!child.pid){pidUnsecured=true;return;}
        try{
          const path=join(stage!,"process.next.json");
          await writeFile(path,JSON.stringify({version:1,createdAt,adminPid:child.pid}),{mode:0o600,flag:"wx"});await rename(path,join(stage!,"process.json"));
          await plan.onStarted?.(child.pid);
        }catch{pidUnsecured=true;process.stderr.write("Warnung: Admin-PID nicht gesichert; kein automatisches Freigeben ohne bestätigten Abschluss. bastra address status prüfen.\n");}
      })();
      const timer=setTimeout(()=>{reject(new Error(pidUnsecured?"Admin-PID nicht gesichert; Systemeinrichtung läuft möglicherweise noch. Dialogabschluss prüfen; bastra address status bleibt konservativ ausstehend.":"Systemeinrichtung läuft möglicherweise noch; bastra address status prüft und gleicht den tatsächlichen Zustand ab."));},io.timeoutMs??180000);
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
