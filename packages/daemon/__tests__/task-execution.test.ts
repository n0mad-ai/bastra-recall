import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { reconcileTaskTime } from "../src/task-events.js";
import { newOwnerKey, unlockOwnerKey, signTaskApproval, bytesHash, type ApprovalRegistry } from "../src/task-approval-keys.js";
import { approvalBinding } from "../src/task-actions.js";
import { reconcilePendingTaskIntents, taskBackupPath } from "../src/task-execution.js";
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),"task-execute-")));await writeFile(join(root,"artifact.txt"),"old\n");
  const envelope=newOwnerKey("synthetic execute password"),registry:ApprovalRegistry={schema_version:1,revision:1,protected_boundary:true,keys:[{id:"key",domain:"personal",public_key:envelope.public_key,fingerprint:bytesHash(envelope.public_key)}],targets:[{id:"artifact",root,path:"artifact.txt",owner_domains:["personal"],sensitivity:"private",adapter:"local-artifact-v1"}]};
  const ctx={path:join(root,"tasks.json"),authPath:join(root,"auth.json"),executionHost:true,approvalRegistry:Promise.resolve(registry),now:()=>1000,actionClock:()=>({boot_id:"fixture-boot",monotonic:1000})};
  const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]}),agent=await mintTaskCredential(ctx.authPath,{actor_id:"agent",role:"agent",domains:["personal"]});const auth=`Bearer ${agent.token}`,ownerAuth=`Bearer ${owner.token}`;
  await callTaskCrud(ctx,ownerAuth,"task_create",{idempotency_key:"execute",original_request:"Replace local demo artifact",goal:"Replace demo artifact",resolution_condition:"Owner result",schedule:{kind:"instant",at:500},timezone:"Europe/Madrid",scope:{kind:"personal",name:"fixture"},owner_domains:["personal"],action_level:"execute",arm:true});await reconcileTaskTime(ctx);const task=(await readTaskStore(ctx.path)).tasks[0];
  const prepared=await callTaskCrud(ctx,auth,"task_prepare",{id:task.id,expected_revision:`initial:${task.revision}`,target_id:"artifact",payload:"new\n"}) as any;
  const approve=async(proposalId:string)=>{const challenge=await callTaskCrud(ctx,ownerAuth,"task_challenge",{proposal_id:proposalId,domain:"personal"}) as any;return callTaskCrud(ctx,ownerAuth,"task_approval",{challenge_id:challenge.challenge.id,decision:"approve",signature:signTaskApproval(unlockOwnerKey(envelope,"synthetic execute password"),approvalBinding(challenge.proposal,challenge.challenge,"approve"))}) as Promise<any>;};
  const proof=await approve(prepared.proposal.id);await callTaskCrud(ctx,ownerAuth,"task_controls",{execution_stopped:false,adapter:{id:"local-artifact-v1",enabled:true}});
  const lease=await callTaskCrud(ctx,auth,"task_lease",{proposal_id:prepared.proposal.id}) as any;
  const input={proposal_id:prepared.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"one-action"};
  return{root,ctx,registry,auth,ownerAuth,prepared,lease,input,proof,approve};
}
test("exact signed action writes once, durable spend precedes target, private backup/receipt survive retry",async()=>{
  const f=await fixture();const result=await callTaskCrud(f.ctx,f.auth,"task_execute",f.input) as any;assert.equal(result.state,"succeeded");assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"new\n");
  const s=await readTaskStore(f.ctx.path);assert.deepEqual(s.consumed_approval_ids,[f.proof.approval_id]);assert.equal(s.receipts.length,1);assert.equal(s.leases[0].state,"released");
  const backup=JSON.parse(await readFile(taskBackupPath(f.ctx,s.intents[0].backup_id),"utf8"));assert.equal(backup.payload,"old\n");assert.equal((await stat(taskBackupPath(f.ctx,s.intents[0].backup_id))).mode&0o077,0);
  const before=await stat(join(f.root,"artifact.txt"));assert.deepEqual(await callTaskCrud(f.ctx,f.auth,"task_execute",f.input),result);assert.equal((await stat(join(f.root,"artifact.txt"))).mtimeMs,before.mtimeMs);
  await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",{...f.input,idempotency_key:"second-action"}));assert.equal((await readTaskStore(f.ctx.path)).receipts.length,1);
});
test("stop, adapter, revoked/expired approval, expired lease and target drift are rechecked after lease grant",async()=>{
  for(const mode of ["stop","adapter","revoked","approval-expired","lease-expired","target"]){const f=await fixture();
    if(mode==="stop")await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{execution_stopped:true});
    if(mode==="adapter")await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{adapter:{id:"local-artifact-v1",enabled:false}});
    if(mode==="revoked")await callTaskCrud(f.ctx,f.ownerAuth,"task_revoke_approval",{approval_id:f.proof.approval_id});
    if(mode==="approval-expired")f.ctx.now=()=>400000;
    if(mode==="lease-expired")f.ctx.actionClock=()=>({boot_id:"fixture-boot",monotonic:32000});
    if(mode==="target")await writeFile(join(f.root,"artifact.txt"),"external\n");
    await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",f.input),mode);const store=await readTaskStore(f.ctx.path);assert.equal(store.intents.length,0,mode);assert.equal(store.consumed_approval_ids.length,0,mode);
    assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),mode==="target"?"external\n":"old\n",mode);
  }
});
test("standalone host and forged holder/fence/domain cannot execute; disabled feature emits no challenge",async()=>{
  const f=await fixture();await assert.rejects(callTaskCrud({...f.ctx,executionHost:false},f.auth,"task_execute",f.input),(e:any)=>e.code==="execution_host_required");
  for(const patch of [{holder_token:"a".repeat(43)},{fence:99}])await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",{...f.input,...patch}));
  await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{enabled:false});await assert.rejects(callTaskCrud(f.ctx,f.ownerAuth,"task_challenge",{proposal_id:f.prepared.proposal.id,domain:"personal"}),(e:any)=>e.code==="feature_disabled");
  assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");
});
test("rollback is an exact separately approved proposal and refuses intervening changes",async()=>{
  const f=await fixture();const result=await callTaskCrud(f.ctx,f.auth,"task_execute",f.input) as any;const rollback=await callTaskCrud(f.ctx,f.auth,"task_rollback_prepare",{receipt_id:result.receipt.id}) as any;
  assert.equal(rollback.proposal.rollback_of,result.receipt.id);assert.equal(rollback.executes,false);assert.equal(rollback.new_owner_approvals_required,true);assert.equal(rollback.preview.after,"old\n");
  await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_lease",{proposal_id:rollback.proposal.id}));await f.approve(rollback.proposal.id);const lease=await callTaskCrud(f.ctx,f.auth,"task_lease",{proposal_id:rollback.proposal.id}) as any;
  await callTaskCrud(f.ctx,f.auth,"task_execute",{proposal_id:rollback.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"rollback"});assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");
  await writeFile(join(f.root,"artifact.txt"),"later edit\n");await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_rollback_prepare",{receipt_id:result.receipt.id}),(e:any)=>e.code==="approval_stale");
});
test("two compiled processes sharing one lease create exactly one intent/target receipt",async()=>{
  const f=await fixture(),moduleUrl=new URL("../dist/task-service.js",import.meta.url).href;
  const script=`import{callTaskCrud}from ${JSON.stringify(moduleUrl)};const c=JSON.parse(process.env.CTX);c.approvalRegistry=Promise.resolve(JSON.parse(process.env.REG));c.now=()=>1000;c.actionClock=()=>({boot_id:'fixture-boot',monotonic:1000});try{const r=await callTaskCrud(c,process.env.AUTH,'task_execute',JSON.parse(process.env.INPUT));console.log(r.state);}catch(e){console.log(e.code);}`;
  const run=async()=>{const child=spawn(process.execPath,["--input-type=module","-e",script],{env:{...process.env,CTX:JSON.stringify({path:f.ctx.path,authPath:f.ctx.authPath,executionHost:true}),REG:JSON.stringify(f.registry),AUTH:f.auth,INPUT:JSON.stringify(f.input)},stdio:["ignore","pipe","pipe"]});let output="";child.stdout.on("data",c=>{output+=c;});await once(child,"exit");return output.trim();};
  assert.deepEqual(await Promise.all([run(),run()]),["succeeded","succeeded"]);const store=await readTaskStore(f.ctx.path);assert.equal(store.intents.length,1);assert.equal(store.receipts.length,1);
});
test("real process crashes before rename/after rename preserve intent+spend; startup never retries the write",async()=>{
  for(const phase of ["before","after"]){const f=await fixture();
    const script=`import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b.endsWith('/artifact.txt')){if(process.env.PHASE==='before')process.kill(process.pid,'SIGKILL');rename(a,b);process.kill(process.pid,'SIGKILL');}return rename(a,b);};syncBuiltinESMExports();const{callTaskCrud}=await import(${JSON.stringify(new URL("../dist/task-service.js",import.meta.url).href)});const c=JSON.parse(process.env.CTX);c.approvalRegistry=Promise.resolve(JSON.parse(process.env.REG));c.now=()=>1000;c.actionClock=()=>({boot_id:'fixture-boot',monotonic:1000});await callTaskCrud(c,process.env.AUTH,'task_execute',JSON.parse(process.env.INPUT));`;
    const child=spawn(process.execPath,["--input-type=module","-e",script],{env:{...process.env,PHASE:phase,CTX:JSON.stringify({path:f.ctx.path,authPath:f.ctx.authPath,executionHost:true}),REG:JSON.stringify(f.registry),AUTH:f.auth,INPUT:JSON.stringify(f.input)},stdio:"ignore"});await once(child,"exit");
    const pending=await readTaskStore(f.ctx.path);assert.equal(pending.intents[0].state,"pending");assert.equal(pending.consumed_approval_ids.length,1);assert.equal(pending.receipts.length,0);
    const target=await readFile(join(f.root,"artifact.txt"),"utf8");assert.equal(target,phase==="before"?"old\n":"new\n");const stamp=(await stat(join(f.root,"artifact.txt"))).mtimeMs;
    await reconcilePendingTaskIntents(f.ctx);const recovered=await readTaskStore(f.ctx.path);assert.equal(recovered.intents[0].state,phase==="before"?"unknown":"succeeded");assert.equal(recovered.receipts[0].outcome,phase==="before"?"unknown":"reconciled");assert.equal((await stat(join(f.root,"artifact.txt"))).mtimeMs,stamp);
  }
});
test("paused real executor cannot be displaced; expired approval/lease prevents the resumed rename",async()=>{
 const f=await fixture();const moduleUrl=new URL("../dist/task-service.js",import.meta.url).href;
 const script=`import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;let clock=1000;fs.renameSync=(a,b)=>{if(b.endsWith('/artifact.txt'))throw new Error('rename should be denied');return rename(a,b);};syncBuiltinESMExports();const{callTaskCrud}=await import(${JSON.stringify(moduleUrl)});const c=JSON.parse(process.env.CTX);c.approvalRegistry=Promise.resolve(JSON.parse(process.env.REG));c.now=()=>1000;c.actionClock=()=>({boot_id:'fixture-boot',monotonic:clock});const original=c.actionClock;let count=0;c.actionClock=()=>{count++;if(count===5){process.stdout.write('paused\\n');process.kill(process.pid,'SIGSTOP');clock=400000;}return original();};try{await callTaskCrud(c,process.env.AUTH,'task_execute',JSON.parse(process.env.INPUT));console.log('wrong');}catch(e){console.log(e.code||'denied');}`;
 const child=spawn(process.execPath,["--input-type=module","-e",script],{env:{...process.env,CTX:JSON.stringify({path:f.ctx.path,authPath:f.ctx.authPath,executionHost:true}),REG:JSON.stringify(f.registry),AUTH:f.auth,INPUT:JSON.stringify(f.input)},stdio:["ignore","pipe","pipe"]});let output="";child.stdout.on("data",c=>{output+=c;});
 try{const until=Date.now()+10000;while(!output.includes("paused")&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.match(output,/paused/);
  const {withPathLock}=await import("../src/path-lock.js");await assert.rejects(withPathLock(f.ctx.path,async()=>"stolen",{strictLocal:true}));
  child.kill("SIGCONT");await once(child,"exit");assert.ok(!output.includes("wrong"));assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");
 }finally{child.kill("SIGCONT");child.kill();}
});
test("actual compiled daemon hosts authenticated execute and returns the durable receipt over HTTP",async()=>{
 const f=await fixture();const {mkdir}=await import("node:fs/promises"),{createServer}=await import("node:net"),{fileURLToPath}=await import("node:url"),{actionClock}=await import("../src/task-approval-keys.js");
 f.ctx.now=Date.now;f.ctx.actionClock=actionClock;await f.approve(f.prepared.proposal.id);
 await writeFile(join(f.root,"task-auth.json"),await readFile(f.ctx.authPath),{mode:0o600});await writeFile(join(f.root,"task-approval-keys.json"),JSON.stringify(f.registry),{mode:0o600});const vault=join(f.root,"vault");await mkdir(vault);
 const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));assert.notEqual(port,6723);const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,["--import",fileURLToPath(new URL("../../../scripts/test-env.mjs",import.meta.url)),fileURLToPath(new URL("../dist/index.js",import.meta.url))],{env:{...process.env,BASTRA_VAULT_PATH:vault,BASTRA_TASKS_PATH:f.ctx.path,BASTRA_HTTP_PORT:String(port),BASTRA_DAEMON_URL:base,BASTRA_AUTO_UPDATE:"0",BASTRA_EMBEDDING_PROVIDER:"none",BASTRA_BM25_ONLY:"1"},stdio:["pipe","ignore","pipe"]});let errors="";child.stderr!.on("data",c=>{errors=(errors+c).slice(-2000);});const closed=once(child,"close");
 const call=async(name:string,input:unknown)=>{const response=await fetch(`${base}/api/v1/${name}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:f.auth},body:JSON.stringify(input)});const body=await response.json() as any;assert.equal(response.status,200,JSON.stringify(body));return body;};
 try{let ready=false;const until=Date.now()+15000;while(Date.now()<until){try{ready=(await fetch(base+"/health")).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,25));}assert.ok(ready,errors);
  const lease=await call("task_lease",{proposal_id:f.prepared.proposal.id});const result=await call("task_execute",{proposal_id:f.prepared.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"real-http"});assert.equal(result.state,"succeeded");assert.equal(result.receipt.outcome,"succeeded");assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"new\n");
 }finally{child.kill("SIGTERM");await closed;}
});
