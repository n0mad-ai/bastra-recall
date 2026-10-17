import "./tasks-opt-in.js";
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {fileURLToPath} from "node:url";
const py=`import os,pty,subprocess,select,time,sys
m,s=pty.openpty();p=subprocess.Popen(sys.argv[1:],stdin=s,stdout=s,stderr=s,start_new_session=True,preexec_fn=lambda: __import__('fcntl').ioctl(s,__import__('termios').TIOCSCTTY,0));os.close(s)
out=b'';stage=0;deadline=time.time()+25
while p.poll() is None and time.time()<deadline:
 if select.select([m],[],[],0.1)[0]:
  try:out+=os.read(m,65536)
  except OSError:break
 if stage==0 and b'bastra-demo> ' in out:os.write(m,b'bastra tasks setup-hooks\\n');stage=1
 elif stage==1 and 'Karten f'.encode() in out:os.write(m,b'bastra tasks targets register demo --root "$task_demo_root/work" --path artifact.txt --domain personal\\n');stage=2
 elif stage==2 and b'Dieses lokale Ziel' in out:os.write(m,b'yes\\n');stage=3
 elif stage==3 and b'Ziel demo registriert' in out:os.write(m,b'demo-restart\\n');stage=4
 elif stage==4 and b'Demo-Daemon wieder bereit; nur eigene Instanz' in out:os.write(m,b'demo-reconsider prepare\\n');stage=5
 elif stage==5 and b'Erfundene Dateien vorbereitet' in out:os.write(m,b'demo-reconsider simulate\\n');stage=6
 elif stage==6 and b'Keine automatische Umkehr' in out:os.write(m,b'demo-reconsider check\\n');stage=7
 elif stage==7 and b'Neubewertungskarte sichtbar im Standardbudget' in out:os.write(m,b'exit\\n');stage=8
if p.poll() is None:p.kill()
p.wait()
try:
 drain=time.time()+1
 while time.time()<drain and select.select([m],[],[],0.05)[0]:
  chunk=os.read(m,65536)
  if not chunk:break
  out+=chunk
except OSError:pass
os.close(m);sys.stdout.buffer.write(out);sys.stdout.write('\\nDEMO_EXIT='+str(p.returncode)+'\\n')
`;
test("documented isolated demo shell runs actual hook setup and guarded owner target CLI without manual registry editing",async()=>{
 const demo=fileURLToPath(new URL("../../../tools/proactive-tasks-demo.mjs",import.meta.url));
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const child=spawn("python3",["-c",py,process.execPath,demo],{env,stdio:["ignore","pipe","pipe"]});let output="",errors="";child.stdout.on("data",c=>{output+=c;});child.stderr.on("data",c=>{errors+=c;});const [code]=await once(child,"exit");assert.equal(code,0,errors);assert.match(output,/Nur Wegwerf-Daten/);assert.match(output,/Ziel demo registriert/);assert.match(output,/DEMO_EXIT=0/);assert.match(output,/Demo-Daemon wieder bereit/);assert.match(output,/Erfundene Dateien vorbereitet/);assert.match(output,/Keine automatische Umkehr/);assert.match(output,/Neubewertungskarte sichtbar im Standardbudget/);assert.ok(!output.includes("Port 6723"));assert.ok(!output.includes("Dieser Ort ist gesperrt"));
});

test("demo neutralizes inherited isolation/output paths and SIGHUP closes its daemon and disposable root",async()=>{
 const {mkdtemp,mkdir,readdir,access}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const trap=await mkdtemp(join(tmpdir(),"demo-env-trap-"));await mkdir(join(trap,"logs"));await mkdir(join(trap,"eval"));
 const script=`import os,pty,subprocess,select,time,sys,json,re,signal
m,s=pty.openpty();p=subprocess.Popen(sys.argv[1:],stdin=s,stdout=s,stderr=s,start_new_session=True,preexec_fn=lambda: __import__('fcntl').ioctl(s,__import__('termios').TIOCSCTTY,0));os.close(s);out=b'';deadline=time.time()+20
while b'bastra-demo> ' not in out and p.poll() is None and time.time()<deadline:
 if select.select([m],[],[],0.1)[0]:
  try:out+=os.read(m,65536)
  except OSError:break
text=out.decode(errors='replace');root=re.search(r'Eigener Demo-Ordner: ([^\\r\\n]+)',text);port=re.search(r'Port (\\d+)',text)
os.killpg(p.pid,signal.SIGHUP)
try:p.wait(timeout=10)
except subprocess.TimeoutExpired:p.kill();p.wait()
os.close(m);print(json.dumps({'root':root.group(1) if root else None,'port':int(port.group(1)) if port else None,'exit':p.returncode}))
`;
 const demo=fileURLToPath(new URL("../../../tools/proactive-tasks-demo.mjs",import.meta.url)),env:NodeJS.ProcessEnv={...process.env,BASTRA_TEST_RUN_ROOT:trap,BASTRA_TEST_KEEP_ENV:"1",BASTRA_LOG_PATH:join(trap,"logs"),BASTRA_EVAL_RUNS_DIR:join(trap,"eval")};delete env.NODE_TEST_CONTEXT;
 const p=spawn("python3",["-c",script,process.execPath,demo],{env,stdio:["ignore","pipe","pipe"]});let out="",errors="";p.stdout.on("data",c=>{out+=c;});p.stderr.on("data",c=>{errors+=c;});const [code]=await once(p,"exit");assert.equal(code,0,errors);const result=JSON.parse(out);assert.ok(result.root);assert.ok(result.port);await assert.rejects(access(result.root),JSON.stringify(result));assert.deepEqual(await readdir(join(trap,"logs")),[]);assert.deepEqual(await readdir(join(trap,"eval")),[]);await assert.rejects(fetch(`http://127.0.0.1:${result.port}/health`),JSON.stringify(result));
});
