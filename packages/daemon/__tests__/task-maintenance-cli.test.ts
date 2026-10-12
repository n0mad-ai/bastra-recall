import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,realpath} from "node:fs/promises";
import {tmpdir,hostname} from "node:os";
import {join} from "node:path";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {fileURLToPath} from "node:url";
import {mintTaskCredential} from "../src/task-auth.js";
import {callTaskCrud} from "../src/task-service.js";
import {readTaskStore} from "../src/task-store.js";
import {readApprovalRegistry} from "../src/task-approval-keys.js";
const cli=fileURLToPath(new URL("../dist/cli.js",import.meta.url));
const py=`import os,pty,subprocess,select,time,sys
m,s=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=s,stdout=s,stderr=s,start_new_session=True,preexec_fn=lambda: __import__('fcntl').ioctl(s,__import__('termios').TIOCSCTTY,0))
os.close(s);out=b'';sent=set();deadline=time.time()+20
while p.poll() is None and time.time()<deadline:
 if select.select([m],[],[],0.1)[0]:
  try:out+=os.read(m,65536)
  except OSError:break
 for label,reply in [('Owner-Aufgaben-Token (verborgen): '.encode(),os.environ['SYNTHETIC_OWNER'].encode()+b'\\n'),(b'Backup wiederherstellen?',b'\\n' if os.environ['CASE']=='decline' else b'yes\\n'),(b'Auch unbekannte Sperre privat sichern?',b'yes\\n'),(b'Dieses lokale Ziel',b'\\n' if os.environ['CASE']=='target-decline' else b'yes\\n'),(b'Ziel entfernen?',b'yes\\n')]:
  if label in out and label not in sent:os.write(m,reply);sent.add(label)
if p.poll() is None:p.kill()
p.wait()
try:
 drain=time.time()+1
 while time.time()<drain and select.select([m],[],[],0.05)[0]:
  chunk=os.read(m,65536)
  if not chunk:break
  out+=chunk
except OSError:pass
os.close(m);sys.stdout.buffer.write(out);sys.stdout.write('\\nCLI_EXIT='+str(p.returncode)+'\\n')
`;
test("real owner CLI recover --lock refuses live owner, repairs unknown owner, and reports No honestly",async()=>{
 const root=await mkdtemp(join(tmpdir(),"task-recovery-cli-")),ctx={path:join(root,"tasks.json"),authPath:join(root,"task-auth.json")};
 const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]}),auth=`Bearer ${owner.token}`;
 const t=await callTaskCrud(ctx,auth,"task_create",{idempotency_key:"fixture",original_request:"Demo",goal:"Demo",resolution_condition:"Owner",timezone:"Europe/Madrid",scope:{kind:"personal",name:"fixture"},owner_domains:["personal"],arm:true,schedule:{kind:"instant",at:Date.now()+600000}}) as any;await callTaskCrud(ctx,auth,"task_snooze",{id:t.id,expected_revision:t.expected_revision,until:Date.now()+700000});
 const run=async(mode:string,args=["recover","--lock"])=>{const p=spawn("python3",["-c",py,process.execPath,cli,"tasks",...args],{env:{...process.env,BASTRA_TASKS_PATH:ctx.path,SYNTHETIC_OWNER:owner.token,CASE:mode},stdio:["ignore","pipe","pipe"]});let output="",errors="";p.stdout.on("data",c=>{output+=c;});p.stderr.on("data",c=>{errors+=c;});const [code]=await once(p,"exit");assert.equal(code,0,errors);assert.ok(!output.includes(owner.token));assert.ok(!output.includes("unknown option"));return output;};
 await writeFile(ctx.path,"broken");const live=JSON.stringify({pid:process.pid,host:hostname(),token:"live"});await writeFile(ctx.path+".lock",live,{mode:0o600});const denied=await run("live");assert.match(denied,/Aufgabenspeicher gesperrt/);assert.match(denied,/CLI_EXIT=1/);assert.equal(await readFile(ctx.path+".lock","utf8"),live);assert.equal(await readFile(ctx.path,"utf8"),"broken");
 await writeFile(ctx.path+".lock","unknown interrupted owner");const repaired=await run("unknown");assert.match(repaired,/Älteres Backup/);assert.match(repaired,/Änderungen seit dem Backup können fehlen/);assert.match(repaired,/CLI_EXIT=0/);assert.equal((await readTaskStore(ctx.path)).tasks[0].armed,false);assert.equal((await readTaskStore(ctx.path)).controls.execution_stopped,true);
 const bytes=await readFile(ctx.path,"utf8"),declined=await run("decline");assert.match(declined,/Nicht bestätigt. Nichts geändert/);assert.match(declined,/CLI_EXIT=1/);assert.equal(await readFile(ctx.path,"utf8"),bytes);
 const work=await realpath(await mkdtemp(join(tmpdir(),"task-cli-work-")));await writeFile(join(work,"artifact.txt"),"old\n");await writeFile(join(work,"second.txt"),"second\n");const args=["targets","register","artifact","--root",work,"--path","artifact.txt","--domain","personal"];
 const no=await run("target-decline",args);assert.match(no,/Nicht bestätigt. Nichts geändert/);assert.match(no,/WARNUNG/);assert.ok(no.includes(join(work,"artifact.txt")));
 const syntax=await run("syntax",["targets","register","artifact"]);assert.match(syntax,/Syntax: bastra tasks targets/);assert.ok(!syntax.includes("--after"));
 const missing=await run("missing",[...args.slice(0,4),join(work,"missing"),...args.slice(5)]);assert.match(missing,/Wurzel oder Zieldatei fehlt/);assert.ok(!missing.includes("Daemon oder Zugang"));
 assert.match(await run("register",args),/Ziel artifact registriert/);assert.match(await run("update",["targets","update","artifact","--root",work,"--path","second.txt","--domain","personal"]),/Ziel artifact geändert/);assert.match(await run("remove",["targets","remove","artifact"]),/Ziel entfernt/);
 const registry=await readApprovalRegistry(join(root,"task-approval-keys.json"));assert.equal(registry?.targets.length,0);assert.equal(registry?.protected_boundary,false);
});
