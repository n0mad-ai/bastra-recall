import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { callTaskCrud } from "../src/task-service.js";
import { dispatchTaskHttp } from "../src/task-transport.js";
import { mintTaskCredential } from "../src/task-auth.js";
import { newOwnerKey, bytesHash, type ApprovalRegistry } from "../src/task-approval-keys.js";
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"task-sign-cli-")),ctx={path:join(root,"tasks.json"),authPath:join(root,"task-auth.json"),approvalRegistry:Promise.resolve(undefined as ApprovalRegistry|undefined)};
  const envelope=newOwnerKey("synthetic signing password"),privateFile=join(root,"owner-key.json");await writeFile(privateFile,JSON.stringify(envelope),{mode:0o600});await writeFile(join(root,"artifact.txt"),"old\n");
  const {realpath}=await import("node:fs/promises");const registry:ApprovalRegistry={schema_version:1,revision:1,protected_boundary:true,keys:[{id:"key",domain:"personal",public_key:envelope.public_key,fingerprint:bytesHash(envelope.public_key)}],targets:[{id:"artifact",root:await realpath(root),path:"artifact.txt",owner_domains:["personal"],sensitivity:"private",adapter:"local-artifact-v1"}]};ctx.approvalRegistry=Promise.resolve(registry);await writeFile(join(root,"task-approval-keys.json"),JSON.stringify(registry),{mode:0o600});
  const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]}),agent=await mintTaskCredential(ctx.authPath,{actor_id:"agent",role:"agent",domains:["personal"]});
  const task=await callTaskCrud(ctx,`Bearer ${owner.token}`,"task_create",{idempotency_key:"sign-cli",original_request:"Prepare",goal:"Prepare",resolution_condition:"Owner",timezone:"Europe/Madrid",scope:{kind:"personal",name:"fixture"},owner_domains:["personal"],arm:true,action_level:"prepare",schedule:{kind:"instant",at:Date.now()+600000}}) as any;
  const prepared=await callTaskCrud(ctx,`Bearer ${agent.token}`,"task_prepare",{id:task.id,expected_revision:task.expected_revision,target_id:"artifact",payload:"new\n"}) as any;
  const server=createServer((req,res)=>{if(!dispatchTaskHttp(req,res,req.method!,req.url!,ctx)){res.writeHead(404);res.end();}});server.listen(0,"127.0.0.1");await once(server,"listening");
  const env={...process.env,BASTRA_TASKS_PATH:ctx.path,BASTRA_DAEMON_URL:`http://127.0.0.1:${(server.address() as any).port}`,BASTRA_TASK_TOKEN:agent.token};
  return {root,ctx,owner,agent,prepared,privateFile,server,env};
}
const cli=fileURLToPath(new URL("../dist/cli.js",import.meta.url));
test("compiled signing CLI rejects no terminal and agent mode; private prompt has no stdin fallback",async()=>{
  const f=await fixture();const run=async(args:string[])=>{const child=spawn(process.execPath,[cli,"tasks",...args],{env:f.env,stdio:["ignore","pipe","pipe"]});let errors="";child.stderr.on("data",c=>{errors+=c;});const [code]=await once(child,"exit");return{code,errors};};
  try{assert.equal((await run(["approve",f.prepared.proposal.id,"personal",f.privateFile])).code,1);const agent=await run(["approve","agent",f.prepared.proposal.id,"personal",f.privateFile]);assert.equal(agent.code,1);assert.match(agent.errors,/forbidden/);}finally{await new Promise<void>(r=>f.server.close(()=>r()));}
});
test("real synthetic signing terminal: Enter declines, wrong passphrase is nonretryable, full binding precedes signing",async()=>{
  const f=await fixture();const py=`import os,pty,subprocess,select,time,sys
master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,preexec_fn=lambda: __import__('fcntl').ioctl(slave,__import__('termios').TIOCSCTTY,0))
os.close(slave)
out=b'';sent=set();deadline=time.time()+15
while p.poll() is None and time.time()<deadline:
 if select.select([master],[],[],0.1)[0]:
  try: out+=os.read(master,65536)
  except OSError: break
 for label,reply in [(b'Owner task token (hidden): ',os.environ['SYNTHETIC_OWNER'].encode()+b'\\n'),(b'Sign approve for these exact bytes and this binding?',b'\\n' if os.environ['CASE']=='decline' else b'yes\\n'),(b'Owner key passphrase (hidden): ',b'wrong password\\n')]:
  if label in out and label not in sent: os.write(master,reply);sent.add(label)
if p.poll() is None:p.kill()
p.wait()
try:
 drain=time.time()+1
 while time.time()<drain and select.select([master],[],[],0.05)[0]:
  chunk=os.read(master,65536)
  if not chunk:break
  out+=chunk
except OSError:pass
os.close(master)
sys.stdout.buffer.write(out)
sys.exit(0)
`;
  const run=async(mode:string)=>{const child=spawn("python3",["-c",py,process.execPath,cli,"tasks","approve",f.prepared.proposal.id,"personal",f.privateFile],{env:{...f.env,SYNTHETIC_OWNER:f.owner.token,CASE:mode},stdio:["ignore","pipe","pipe"]});let output="",errors="";child.stdout.on("data",c=>{output+=c;});child.stderr.on("data",c=>{errors+=c;});const [code]=await once(child,"exit");assert.equal(code,0,errors);return output;};
  try{
    const declined=await run("decline");assert.match(declined,/forbidden/);assert.match(declined,/task_revision/);assert.match(declined,/source_revisions/);assert.match(declined,/registry_hash/);assert.match(declined,/target_path/);assert.ok(!declined.includes(f.owner.token));
    const wrong=await run("wrong");assert.match(wrong,/key_unlock_failed/);assert.match(wrong,/"retryable":false/);assert.equal((await import("../src/task-store.js").then(m=>m.readTaskStore(f.ctx.path))).approvals.length,0);
    assert.ok(!(await readFile(f.ctx.path,"utf8")).includes(f.owner.token));
  }finally{await new Promise<void>(r=>f.server.close(()=>r()));}
});
test("owner key enrollment refuses silent replacement; explicit old-key rotation resets boundary and stops execution",async()=>{
 const f=await fixture();const replacement=join(f.root,"replacement.json");const py=`import os,pty,subprocess,select,time,sys,json
master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,preexec_fn=lambda: __import__('fcntl').ioctl(0,__import__('termios').TIOCSCTTY,0))
os.close(slave)
out=b'';sent=set();deadline=time.time()+15
pairs=[(b'Enroll owner-held approval key',b'yes\\n'),(b'Owner task token (hidden): ',os.environ['SYNTHETIC_OWNER'].encode()+b'\\n'),(b'Old key passphrase (hidden): ',b'synthetic signing password\\n'),(b'New owner-key passphrase',b'synthetic replacement password\\n'),(b'Repeat passphrase: ',b'synthetic replacement password\\n')]
while p.poll() is None and time.time()<deadline:
 if select.select([master],[],[],0.1)[0]:
  try:
   chunk=os.read(master,65536)
   if not chunk:break
   out+=chunk
  except OSError:break
 for label,reply in pairs:
  if label in out and label not in sent:os.write(master,reply);sent.add(label)
if p.poll() is None:p.kill()
p.wait()
try:
 drain=time.time()+1
 while time.time()<drain and select.select([master],[],[],0.05)[0]:
  chunk=os.read(master,65536)
  if not chunk:break
  out+=chunk
except OSError:pass
os.close(master)
sys.stdout.buffer.write(out)
`;
 const run=async(op:string)=>{const child=spawn("python3",["-c",py,process.execPath,cli,"tasks","keys",op,"personal",replacement,...(op==="rotate"?[f.privateFile]:[])],{env:{...f.env,SYNTHETIC_OWNER:f.owner.token},stdio:["ignore","pipe","pipe"]});let output="";child.stdout.on("data",c=>{output+=c;});await once(child,"exit");return output;};
 try{
  const rejected=await run("enroll");assert.match(rejected,/conflict/);await assert.rejects(readFile(replacement));
  const {transactTaskStore,readTaskStore}=await import("../src/task-store.js");await transactTaskStore(f.ctx.path,undefined,s=>{s.controls.execution_stopped=false;});
  const rotated=await run("rotate");assert.match(rotated,/reset to false/);const registry=JSON.parse(await readFile(join(f.root,"task-approval-keys.json"),"utf8"));assert.equal(registry.protected_boundary,false);assert.notEqual(registry.keys[0].public_key,(await import("../src/task-approval-keys.js").then(m=>m.privateJson(f.privateFile))).public_key);assert.equal((await readTaskStore(f.ctx.path)).controls.execution_stopped,true);assert.ok(!rotated.includes(f.owner.token));
 }finally{await new Promise<void>(r=>f.server.close(()=>r()));}
});
