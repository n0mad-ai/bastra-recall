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
 elif stage==4 and b'Demo-Daemon wieder bereit' in out:os.write(m,b'exit\\n');stage=5
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
 const guard=fileURLToPath(new URL("../../../scripts/test-env.mjs",import.meta.url)),demo=fileURLToPath(new URL("../../../tools/proactive-tasks-demo.mjs",import.meta.url));
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const child=spawn("python3",["-c",py,process.execPath,"--import",guard,demo],{env,stdio:["ignore","pipe","pipe"]});let output="",errors="";child.stdout.on("data",c=>{output+=c;});child.stderr.on("data",c=>{errors+=c;});const [code]=await once(child,"exit");assert.equal(code,0,errors);assert.match(output,/Nur Wegwerf-Daten/);assert.match(output,/Ziel demo registriert/);assert.match(output,/DEMO_EXIT=0/);assert.match(output,/Demo-Daemon wieder bereit/);assert.ok(!output.includes("Port 6723"));assert.ok(!output.includes("Dieser Ort ist gesperrt"));
});
