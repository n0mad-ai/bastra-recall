import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, realpath, stat, mkdir, symlink, link } from "node:fs/promises";
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
async function fixture(domains = ["personal"], linkedData = false) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"task-execute-")));await writeFile(join(root,"artifact.txt"),"old\n");
  const envelope=newOwnerKey("synthetic execute password"),registry:ApprovalRegistry={schema_version:1,revision:1,protected_boundary:true,keys:domains.map((domain,i)=>({id:`key-${i}`,domain,public_key:envelope.public_key,fingerprint:bytesHash(envelope.public_key)})),targets:[{id:"artifact",root,path:"artifact.txt",owner_domains:domains,sensitivity:"private",adapter:"local-artifact-v1"}]};
  let dataRoot = root;
  if (linkedData) {
    await mkdir(join(root, "data")); dataRoot = join(root, "linked-data");
    await symlink(join(root, "data"), dataRoot, process.platform === "win32" ? "junction" : "dir");
  }
  const ctx={path:join(dataRoot,"tasks.json"),authPath:join(dataRoot,"auth.json"),executionHost:true,approvalRegistry:Promise.resolve(registry),now:()=>1000,actionClock:()=>({boot_id:"fixture-boot",monotonic:1000})};
  const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains}),agent=await mintTaskCredential(ctx.authPath,{actor_id:"agent",role:"agent",domains});const auth=`Bearer ${agent.token}`,ownerAuth=`Bearer ${owner.token}`;
  await callTaskCrud(ctx,ownerAuth,"task_create",{idempotency_key:"execute",original_request:"Replace local demo artifact",goal:"Replace demo artifact",resolution_condition:"Owner result",schedule:{kind:"instant",at:500},timezone:"Europe/Madrid",scope:{kind:"personal",name:"fixture"},owner_domains:domains,action_level:"execute",arm:true});await reconcileTaskTime(ctx);const task=(await readTaskStore(ctx.path)).tasks[0];
  const prepared=await callTaskCrud(ctx,auth,"task_prepare",{id:task.id,expected_revision:`initial:${task.revision}`,target_id:"artifact",payload:"new\n"}) as any;
  const approveDomain=async(proposalId:string,domain:string)=>{const challenge=await callTaskCrud(ctx,ownerAuth,"task_challenge",{proposal_id:proposalId,domain}) as any;return callTaskCrud(ctx,ownerAuth,"task_approval",{challenge_id:challenge.challenge.id,decision:"approve",signature:signTaskApproval(unlockOwnerKey(envelope,"synthetic execute password"),approvalBinding(challenge.proposal,challenge.challenge,"approve"))}) as Promise<any>;};
  const approve=async(proposalId:string)=>{let result:any;for(const domain of domains)result=await approveDomain(proposalId,domain);return result;};
  const proof=await approve(prepared.proposal.id);await callTaskCrud(ctx,ownerAuth,"task_controls",{execution_stopped:false,adapter:{id:"local-artifact-v1",enabled:true}});
  const lease=await callTaskCrud(ctx,auth,"task_lease",{proposal_id:prepared.proposal.id}) as any;
  const input={proposal_id:prepared.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"one-action"};
  return{root,ctx,registry,auth,ownerAuth,prepared,lease,input,proof,approve,approveDomain};
}
test("exact signed action writes once, durable spend precedes target, private backup/receipt survive retry",async()=>{
  const f=await fixture();const result=await callTaskCrud(f.ctx,f.auth,"task_execute",f.input) as any;assert.equal(result.state,"succeeded");assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"new\n");
  const s=await readTaskStore(f.ctx.path);assert.deepEqual(s.consumed_approval_ids,[f.proof.approval_id]);assert.equal(s.receipts.length,1);assert.equal(s.leases[0].state,"released");
  const backup=JSON.parse(await readFile(taskBackupPath(f.ctx,s.intents[0].backup_id),"utf8"));assert.equal(backup.payload,"old\n");assert.equal((await stat(taskBackupPath(f.ctx,s.intents[0].backup_id))).mode&0o077,0);
  const before=await stat(join(f.root,"artifact.txt"));assert.deepEqual(await callTaskCrud(f.ctx,f.auth,"task_execute",f.input),result);assert.deepEqual(await callTaskCrud(f.ctx,f.auth,"task_execute",Object.fromEntries(Object.entries(f.input).reverse())),result);assert.equal((await stat(join(f.root,"artifact.txt"))).mtimeMs,before.mtimeMs);
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
for (const linkedData of [false, true]) test(`rollback is an exact separately approved proposal and refuses intervening changes${linkedData ? " through a symlinked data directory" : ""}`,async()=>{
  const f=await fixture(["personal"], linkedData);const result=await callTaskCrud(f.ctx,f.auth,"task_execute",f.input) as any;
  if (linkedData) {
    assert.notEqual(f.ctx.path, await realpath(f.ctx.path));
    // The source-only hardlink restriction must not reject our own backup.
    const backup = taskBackupPath(f.ctx, result.receipt.backup_id);
    await link(backup, join(f.root, "backup-copy.json")); assert.equal((await stat(backup)).nlink, 2);
  }
  const rollback=await callTaskCrud(f.ctx,f.auth,"task_rollback_prepare",{receipt_id:result.receipt.id}) as any;
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
test("reference adapter refuses non-reversible before-state before prepare or spending",async()=>{
 for(const payload of ["a\tb\n","a\r\nb\r\n","\ufeffhello\n","a\u0007b\n","a\u200bb\n","x".repeat(20000)]){
  const f=await fixture();await writeFile(join(f.root,"artifact.txt"),payload);const task=(await readTaskStore(f.ctx.path)).tasks[0];
  await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_prepare",{id:task.id,expected_revision:`initial:${task.revision}`,target_id:"artifact",payload:"new\n"}),(e:any)=>e.code==="adapter_not_reversible");
  assert.equal((await readTaskStore(f.ctx.path)).intents.length,0);assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),payload);
 }
});
test("receipt rollback remains independently approvable after resolve/cancel/snooze without rearming task",async()=>{
 for(const op of ["resolve","cancel","snooze"]){const f=await fixture(),executed=await callTaskCrud(f.ctx,f.auth,"task_execute",f.input) as any;const task=(await readTaskStore(f.ctx.path)).tasks[0];await callTaskCrud(f.ctx,f.ownerAuth,`task_${op}` as "task_resolve"|"task_cancel"|"task_snooze",{id:task.id,expected_revision:`initial:${task.revision}`,...(op==="snooze"?{until:10000}:{})});
  const rollback=await callTaskCrud(f.ctx,f.auth,"task_rollback_prepare",{receipt_id:executed.receipt.id}) as any;await f.approve(rollback.proposal.id);const lease=await callTaskCrud(f.ctx,f.auth,"task_lease",{proposal_id:rollback.proposal.id}) as any;await callTaskCrud(f.ctx,f.auth,"task_execute",{proposal_id:rollback.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"after-terminal"});assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");assert.equal((await readTaskStore(f.ctx.path)).tasks[0].state,op==="resolve"?"resolved":op==="cancel"?"cancelled":"snoozed");
 }
});
test("unknown action is visible in bounded owner status and card; explicit reconcile cleans owned temp",async()=>{
 const f=await fixture();const script=`import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b.endsWith('/artifact.txt'))process.kill(process.pid,'SIGKILL');return rename(a,b);};syncBuiltinESMExports();const{callTaskCrud}=await import(${JSON.stringify(new URL("../dist/task-service.js",import.meta.url).href)});const c=JSON.parse(process.env.CTX);c.approvalRegistry=Promise.resolve(JSON.parse(process.env.REG));c.now=()=>1000;c.actionClock=()=>({boot_id:'fixture-boot',monotonic:1000});await callTaskCrud(c,process.env.AUTH,'task_execute',JSON.parse(process.env.INPUT));`;
 const child=spawn(process.execPath,["--input-type=module","-e",script],{env:{...process.env,CTX:JSON.stringify({path:f.ctx.path,authPath:f.ctx.authPath,executionHost:true}),REG:JSON.stringify(f.registry),AUTH:f.auth,INPUT:JSON.stringify(f.input)},stdio:"ignore"});await once(child,"exit");const pending=(await readTaskStore(f.ctx.path)).intents[0],tmp=join(f.root,`.bastra-task-${pending.id}.tmp`);assert.equal(await readFile(tmp,"utf8"),"new\n");
 const result=await callTaskCrud(f.ctx,f.ownerAuth,"task_intent_reconcile",{intent_id:pending.id}) as any;assert.equal(result.state,"unknown");await assert.rejects(readFile(tmp));
 const status=await callTaskCrud(f.ctx,f.ownerAuth,"task_status",{}) as any;assert.equal(status.intents[0].review_hint,"Abgleich nötig");assert.equal(status.receipts[0].outcome,"unknown");assert.equal(status.receipts[0].rollback_available,false);assert.match(status.tasks[0].review_reason,/Abgleich nötig/);assert.ok(!JSON.stringify(status.intents).includes(f.root));
 const due=await callTaskCrud(f.ctx,f.ownerAuth,"task_due",{}) as any;assert.equal(due.cards[0].action_outcome.review_hint,"Abgleich nötig");assert.equal((await callTaskCrud(f.ctx,f.ownerAuth,"task_intent_reconcile",{intent_id:pending.id}) as any).state,"unknown");
});
test("default adapter status is disabled and action capacity reports its actual bounded limits",async()=>{
 const f=await fixture();await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{adapter:{id:"local-artifact-v1",enabled:false}});const status=await callTaskCrud(f.ctx,f.ownerAuth,"task_status",{}) as any;assert.equal(status.adapters[0].enabled,false);assert.equal(status.capacity.intent_limit,1000);
 const {transactTaskStore}=await import("../src/task-store.js");await assert.rejects(transactTaskStore(f.ctx.path,undefined,s=>{s.intents=Array.from({length:1001},(_,i)=>({id:`intent-${i}`})) as any;}),(e:any)=>e.code==="capacity");assert.equal((await readTaskStore(f.ctx.path)).intents.length,0);
});
test("execute rechecks edited/cancelled/snoozed/resolved task, feature/registry and revoked caller",async()=>{
 for(const mode of ["edit","cancel","snooze","resolve","off","registry","credential"]){const f=await fixture(),task=(await readTaskStore(f.ctx.path)).tasks[0];
  if(mode==="edit")await callTaskCrud(f.ctx,f.ownerAuth,"task_edit",{id:task.id,expected_revision:`initial:${task.revision}`,patch:{goal:"Changed"}});
  if(["cancel","snooze","resolve"].includes(mode))await callTaskCrud(f.ctx,f.ownerAuth,`task_${mode}` as "task_cancel"|"task_snooze"|"task_resolve",{id:task.id,expected_revision:`initial:${task.revision}`,...(mode==="snooze"?{until:10000}:{})});
  if(mode==="off")await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{enabled:false});if(mode==="registry")f.registry.revision++;
  if(mode==="credential"){const {authenticateTask,revokeTaskCredential}=await import("../src/task-auth.js");const actor=await authenticateTask(f.auth,f.ctx.authPath);await revokeTaskCredential(f.ctx.authPath,actor.credential_id);}
  await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",f.input),mode);assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");assert.equal((await readTaskStore(f.ctx.path)).intents.length,0);
 }
});
test("two-domain execute requires both fresh unrevoked proofs; one-domain proof cannot borrow other proposal",async()=>{
 for(const mode of ["success","revoked","expired","missing"]){const f=await fixture(["personal","team"]);
  if(mode==="revoked")await callTaskCrud(f.ctx,f.ownerAuth,"task_revoke_approval",{approval_id:f.proof.approval_id});
  if(mode==="expired")f.ctx.actionClock=()=>({boot_id:"fixture-boot",monotonic:301001});
  if(mode==="missing"){const task=(await readTaskStore(f.ctx.path)).tasks[0],proposal=await callTaskCrud(f.ctx,f.auth,"task_prepare",{id:task.id,expected_revision:`initial:${task.revision}`,target_id:"artifact",payload:"another\n"}) as any;await f.approveDomain(proposal.proposal.id,"personal");await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_lease",{proposal_id:proposal.proposal.id}),(e:any)=>e.code==="approval_missing");continue;}
  if(mode==="success")assert.equal((await callTaskCrud(f.ctx,f.auth,"task_execute",f.input) as any).state,"succeeded");else await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",f.input));assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),mode==="success"?"new\n":"old\n");
 }
});
test("second validation after durable intent rejects late content/symlink change and spends only one intent",async()=>{
 for(const mode of ["content","symlink"]){const f=await fixture(),outside=join(await mkdtemp(join(tmpdir(),"task-outside-")),"other.txt");await writeFile(outside,"old\n");
 const script=`import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;let changed=false;fs.renameSync=(a,b)=>{const result=rename(a,b);if(b===process.env.STORE&&!changed&&JSON.parse(fs.readFileSync(b,'utf8')).intents.length){changed=true;if(process.env.MODE==='content')fs.writeFileSync(process.env.TARGET,'external\\n');else{fs.unlinkSync(process.env.TARGET);fs.symlinkSync(process.env.OUTSIDE,process.env.TARGET);}}return result;};syncBuiltinESMExports();const{callTaskCrud}=await import(${JSON.stringify(new URL("../dist/task-service.js",import.meta.url).href)});const c=JSON.parse(process.env.CTX);c.approvalRegistry=Promise.resolve(JSON.parse(process.env.REG));c.now=()=>1000;c.actionClock=()=>({boot_id:'fixture-boot',monotonic:1000});try{await callTaskCrud(c,process.env.AUTH,'task_execute',JSON.parse(process.env.INPUT));console.log('wrong');}catch(e){console.log(e.code);}`;
 const child=spawn(process.execPath,["--input-type=module","-e",script],{env:{...process.env,CTX:JSON.stringify({path:f.ctx.path,authPath:f.ctx.authPath,executionHost:true}),REG:JSON.stringify(f.registry),AUTH:f.auth,INPUT:JSON.stringify(f.input),STORE:f.ctx.path,TARGET:join(f.root,"artifact.txt"),OUTSIDE:outside,MODE:mode},stdio:["ignore","pipe","pipe"]});let output="";child.stdout.on("data",c=>{output+=c;});await once(child,"exit");assert.ok(!output.includes("wrong"));const s=await readTaskStore(f.ctx.path);assert.equal(s.intents.length,1);assert.equal(s.intents[0].state,"pending");assert.equal(s.consumed_approval_ids.length,1);assert.equal(await readFile(outside,"utf8"),"old\n");
 }
});
test("resume uses readable owner confirmation; Enter leaves stop and adapter unchanged",async()=>{
 const f=await fixture();await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{execution_stopped:true,adapter:{id:"local-artifact-v1",enabled:false}});await writeFile(join(f.root,"task-auth.json"),await readFile(f.ctx.authPath),{mode:0o600});
 const py=`import os,pty,subprocess,select,time,sys
master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,preexec_fn=lambda: __import__('fcntl').ioctl(0,__import__('termios').TIOCSCTTY,0))
os.close(slave);out=b'';sent=set();deadline=time.time()+15
pairs=[('Owner-Aufgaben-Token (verborgen): '.encode(),os.environ['SYNTHETIC_OWNER'].encode()+b'\\n'),(b'Lokalen Referenzadapter aktivieren',b'\\n')]
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
os.close(master);sys.stdout.buffer.write(out)
`;
 const {fileURLToPath}=await import("node:url");const child=spawn("python3",["-c",py,process.execPath,fileURLToPath(new URL("../dist/cli.js",import.meta.url)),"tasks","resume","--json"],{env:{...process.env,BASTRA_TASKS_PATH:f.ctx.path,SYNTHETIC_OWNER:f.ownerAuth.slice(7)},stdio:["ignore","pipe","pipe"]});let output="";child.stdout.on("data",c=>{output+=c;});await once(child,"exit");assert.match(output,/Lokalen Referenzadapter aktivieren/);assert.match(output,/forbidden/);const store=await readTaskStore(f.ctx.path);assert.equal(store.controls.execution_stopped,true);assert.equal(store.controls.adapters["local-artifact-v1"].enabled,false);assert.ok(!output.includes(f.ownerAuth.slice(7)));
});
test("execute handles UTF-8/size/mode/hardlink boundaries explicitly and no pre-state is lost",async()=>{
 const {chmod,link}=await import("node:fs/promises");
 for(const mode of ["invalid-utf8","oversize","read-only","hardlink"]){const f=await fixture(),path=join(f.root,"artifact.txt");
  if(mode==="invalid-utf8")await writeFile(path,Buffer.from([0xff,0xfe]));if(mode==="oversize")await writeFile(path,"x".repeat(1024*1024+1));if(mode==="read-only")await chmod(path,0o444);if(mode==="hardlink")await link(path,join(f.root,"other-name.txt"));
  if(["invalid-utf8","oversize"].includes(mode)){await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",f.input));assert.equal((await readTaskStore(f.ctx.path)).intents.length,0);}else{await callTaskCrud(f.ctx,f.auth,"task_execute",f.input);if(mode==="read-only")assert.equal((await stat(path)).mode&0o777,0o444);if(mode==="hardlink")assert.equal(await readFile(join(f.root,"other-name.txt"),"utf8"),"old\n");}
 }
});
test("live evidence/source version and evidence age are re-read at execute admission",async()=>{
 for(const mode of ["evidence","source","age"]){const f=await fixture();await writeFile(join(f.root,"evidence.json"),"evidence");await callTaskCrud(f.ctx,f.ownerAuth,"task_source_register",{id:"evidence",kind:"file",producer_actor:"task-source-reader",root:f.root,path:"evidence.json",owner_domains:["personal"],sensitivity:"private",max_age_ms:1000,enabled:true});
  const task=(await readTaskStore(f.ctx.path)).tasks[0],edited=await callTaskCrud(f.ctx,f.ownerAuth,"task_edit",{id:task.id,expected_revision:`initial:${task.revision}`,patch:{evidence:[{source_id:"evidence",id:"evidence",revision:bytesHash("evidence"),hash:bytesHash("evidence"),observed_at:1000,state_updated_at:1000,max_age_ms:1000,provenance:"attributable"}]}}) as any;
  await callTaskCrud(f.ctx,f.ownerAuth,"task_review",{id:task.id,expected_revision:edited.expected_revision});const {assessTaskFreshness}=await import("../src/task-freshness.js");await assessTaskFreshness(f.ctx);await reconcileTaskTime(f.ctx);const current=(await readTaskStore(f.ctx.path)).tasks[0],prepared=await callTaskCrud(f.ctx,f.auth,"task_prepare",{id:task.id,expected_revision:`initial:${current.revision}`,target_id:"artifact",payload:"new\n"}) as any;await f.approve(prepared.proposal.id);const lease=await callTaskCrud(f.ctx,f.auth,"task_lease",{proposal_id:prepared.proposal.id}) as any;
  if(mode==="evidence")await writeFile(join(f.root,"evidence.json"),"changed");if(mode==="source")await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{source:{id:"evidence",enabled:false}});if(mode==="age")f.ctx.now=()=>3000;
  await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",{proposal_id:prepared.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"evidence-action"}),mode);assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");assert.equal((await readTaskStore(f.ctx.path)).intents.length,0);
 }
});
test("crash before backup and during explicit reconciliation never retries a write; foreign edit stays unknown",async()=>{
 const f=await fixture();const service=new URL("../dist/task-service.js",import.meta.url).href;
 const env={...process.env,CTX:JSON.stringify({path:f.ctx.path,authPath:f.ctx.authPath,executionHost:true}),REG:JSON.stringify(f.registry),AUTH:f.auth,INPUT:JSON.stringify(f.input),STORE:f.ctx.path};
 const boot=`const{callTaskCrud}=await import(${JSON.stringify(service)});const c=JSON.parse(process.env.CTX);c.approvalRegistry=Promise.resolve(JSON.parse(process.env.REG));c.now=()=>1000;c.actionClock=()=>({boot_id:'fixture-boot',monotonic:1000});`;
 const crashIntent=`import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;fs.renameSync=(a,b)=>{const r=rename(a,b);if(b===process.env.STORE&&JSON.parse(fs.readFileSync(b,'utf8')).intents.length)process.kill(process.pid,'SIGKILL');return r;};syncBuiltinESMExports();${boot}await callTaskCrud(c,process.env.AUTH,'task_execute',JSON.parse(process.env.INPUT));`;
 const run=async(script:string,extra={})=>{const child=spawn(process.execPath,["--input-type=module","-e",script],{env:{...env,...extra},stdio:"ignore"});await once(child,"exit");};await run(crashIntent);const intent=(await readTaskStore(f.ctx.path)).intents[0];await assert.rejects(readFile(taskBackupPath(f.ctx,intent.backup_id)));assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");
 await writeFile(join(f.root,"artifact.txt"),"foreign edit\n");const stamp=(await stat(join(f.root,"artifact.txt"))).mtimeMs;
 const crashReceipt=`import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===process.env.STORE&&JSON.parse(fs.readFileSync(a,'utf8')).receipts.length)process.kill(process.pid,'SIGKILL');return rename(a,b);};syncBuiltinESMExports();${boot}await callTaskCrud(c,process.env.AUTH,'task_intent_reconcile',{intent_id:process.env.INTENT});`;
 await run(crashReceipt,{INTENT:intent.id});assert.equal((await readTaskStore(f.ctx.path)).intents[0].state,"pending");const result=await callTaskCrud(f.ctx,f.ownerAuth,"task_intent_reconcile",{intent_id:intent.id}) as any;assert.equal(result.state,"unknown");assert.equal((await stat(join(f.root,"artifact.txt"))).mtimeMs,stamp);assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"foreign edit\n");
});

test("crash temp cleanup does not depend on the target leaf and foreign remnants stay visible",async()=>{
 const f=await fixture();const script=`import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b.endsWith('/artifact.txt'))process.kill(process.pid,'SIGKILL');return rename(a,b);};syncBuiltinESMExports();const{callTaskCrud}=await import(${JSON.stringify(new URL("../dist/task-service.js",import.meta.url).href)});const c=JSON.parse(process.env.CTX);c.approvalRegistry=Promise.resolve(JSON.parse(process.env.REG));c.now=()=>1000;c.actionClock=()=>({boot_id:'fixture-boot',monotonic:1000});await callTaskCrud(c,process.env.AUTH,'task_execute',JSON.parse(process.env.INPUT));`;
 const child=spawn(process.execPath,["--input-type=module","-e",script],{env:{...process.env,CTX:JSON.stringify({path:f.ctx.path,authPath:f.ctx.authPath,executionHost:true}),REG:JSON.stringify(f.registry),AUTH:f.auth,INPUT:JSON.stringify(f.input)},stdio:"ignore"});await once(child,"exit");
 const {unlink}=await import("node:fs/promises"),intent=(await readTaskStore(f.ctx.path)).intents[0],tmp=join(f.root,`.bastra-task-${intent.id}.tmp`);assert.equal(await readFile(tmp,"utf8"),"new\n");await unlink(join(f.root,"artifact.txt"));
 await reconcilePendingTaskIntents(f.ctx);assert.equal((await readTaskStore(f.ctx.path)).intents[0].state,"unknown");await assert.rejects(readFile(tmp),{code:"ENOENT"});
 await writeFile(tmp,"foreign bytes");const retry=await callTaskCrud(f.ctx,f.ownerAuth,"task_intent_reconcile",{intent_id:intent.id}) as any;assert.equal(retry.temp_cleanup_pending,true);assert.equal(await readFile(tmp,"utf8"),"foreign bytes");const status=await callTaskCrud(f.ctx,f.ownerAuth,"task_status",{}) as any;assert.equal(status.intents[0].temp_cleanup_pending,true);
 await writeFile(tmp,"new\n");const clean=await callTaskCrud(f.ctx,f.ownerAuth,"task_intent_reconcile",{intent_id:intent.id}) as any;assert.equal(clean.temp_cleanup_pending,false);await assert.rejects(readFile(tmp),{code:"ENOENT"});await assert.rejects(readFile(join(f.root,"artifact.txt")),{code:"ENOENT"});assert.equal((await readTaskStore(f.ctx.path)).receipts.length,1);
});
test("archived execute retries preserve intent/receipt and restored history supports fresh approved rollback",async()=>{
 const f=await fixture(),executed=await callTaskCrud(f.ctx,f.auth,"task_execute",f.input) as any;
 let s=await readTaskStore(f.ctx.path);await callTaskCrud(f.ctx,f.ownerAuth,"task_resolve",{id:s.tasks[0].id,expected_revision:`${s.recovery_epoch}:${s.tasks[0].revision}`});await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{execution_stopped:true});s=await readTaskStore(f.ctx.path);
 const archived=await callTaskCrud(f.ctx,f.ownerAuth,"task_archive",{task_ids:[s.tasks[0].id],expected_revision:s.revision,recovery_epoch:s.recovery_epoch}) as any;const stamp=(await stat(join(f.root,"artifact.txt"))).mtimeMs;
 s=await readTaskStore(f.ctx.path);assert.equal(s.intents.length,0);assert.equal(s.tasks.length,0);assert.deepEqual(s.consumed_approval_ids,[f.proof.approval_id]);assert.deepEqual(await callTaskCrud(f.ctx,f.auth,"task_execute",f.input),executed);assert.equal((await stat(join(f.root,"artifact.txt"))).mtimeMs,stamp);
 await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",{...f.input,fence:f.input.fence+1}),{code:"conflict"});await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",{...f.input,idempotency_key:"reuse-old-proof"}),{code:"not_found"});
 await callTaskCrud(f.ctx,f.ownerAuth,"task_archive_restore",{archive_id:archived.archive_id});await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{execution_stopped:false});const rollback=await callTaskCrud(f.ctx,f.ownerAuth,"task_rollback_prepare",{receipt_id:executed.receipt.id}) as any;await f.approve(rollback.proposal.id);const lease=await callTaskCrud(f.ctx,f.ownerAuth,"task_lease",{proposal_id:rollback.proposal.id}) as any;await callTaskCrud(f.ctx,f.ownerAuth,"task_execute",{proposal_id:rollback.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"after-archive-rollback"});assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");
});

test("spent proof survives archive and older-backup recovery, never grants another effect",async()=>{
 const f=await fixture();await callTaskCrud(f.ctx,f.auth,"task_execute",f.input);let s=await readTaskStore(f.ctx.path),t=s.tasks[0];await callTaskCrud(f.ctx,f.ownerAuth,"task_resolve",{id:t.id,expected_revision:`${s.recovery_epoch}:${t.revision}`});await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{execution_stopped:true});s=await readTaskStore(f.ctx.path);
 const archived=await callTaskCrud(f.ctx,f.ownerAuth,"task_archive",{task_ids:[t.id],expected_revision:s.revision,recovery_epoch:s.recovery_epoch}) as any;assert.ok((await readTaskStore(f.ctx.path)).consumed_approval_ids.includes(f.proof.approval_id));
 const {readTaskArchive}=await import("../src/task-archive.js"),{taskApprovalStatus}=await import("../src/task-actions.js");const active=await readTaskStore(f.ctx.path),cold=await readTaskArchive(f.ctx.path,active.archives[0]);assert.equal(taskApprovalStatus(f.ctx,cold,cold.proposals[0],f.registry).domain_status[0].reason,"approval_consumed");await writeFile(f.ctx.path,"truncated after archival");await callTaskCrud(f.ctx,f.ownerAuth,"task_recover",{});s=await readTaskStore(f.ctx.path);assert.ok(s.consumed_approval_ids.includes(f.proof.approval_id));assert.ok(s.archives.some(a=>a.id===archived.archive_id));assert.equal(s.controls.execution_stopped,true);assert.equal(taskApprovalStatus(f.ctx,s,s.proposals[0],f.registry).domain_status[0].reason,"approval_consumed");
 const before=await stat(join(f.root,"artifact.txt"));await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_lease",{proposal_id:f.prepared.proposal.id}));await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",{...f.input,idempotency_key:"old-proof-after-recovery"}));assert.equal((await stat(join(f.root,"artifact.txt"))).mtimeMs,before.mtimeMs);assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"new\n");
});

test("legacy proposal migration retires binding chain without losing spent retry, receipt or fresh rollback",async()=>{
 const f=await fixture(),done=await callTaskCrud(f.ctx,f.auth,"task_execute",f.input) as any;
 let current=await callTaskCrud(f.ctx,f.auth,"task_get",{id:f.prepared.proposal.task_id}) as any;await callTaskCrud(f.ctx,f.ownerAuth,"task_resolve",{id:current.id,expected_revision:current.expected_revision});await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{execution_stopped:true});
 const previousRollback=await callTaskCrud(f.ctx,f.auth,"task_rollback_prepare",{receipt_id:done.receipt.id}) as any;
 const {actionHash}=await import("../src/task-approval-keys.js");const oldRollbackId=actionHash(["task-rollback-v1",done.receipt.id,"agent",done.receipt.after_hash]);
 const s=await readTaskStore(f.ctx.path);s.proposals.find(p=>p.id===previousRollback.proposal.id)!.id=oldRollbackId;for(const row of s.proposals)delete row.binding_version;
 const proposal=s.proposals[0],binding=proposal.task_binding!,approvalBindingHash=s.approvals[0].binding_hash!,signature=s.approvals[0].signature!;delete proposal.binding_version;
 const {mkdir}=await import("node:fs/promises"),{taskArchivePath}=await import("../src/task-archive.js"),{privateComparisonPath}=await import("../src/task-private-comparison.js");
 const path=join(f.root,"legacy-proposals.json"),id="00000000-0000-4000-8000-000000000009",snapshot=structuredClone(s);snapshot.archives=[];const bundle=JSON.stringify({schema_version:1,id,snapshot});await mkdir(join(f.root,"task-archives"),{recursive:true});const archive=taskArchivePath(path,id);await writeFile(archive,bundle,{mode:0o600});
 s.archives=[{id,hash:bytesHash(bundle),at:1000,actor:"owner",task_ids:[proposal.task_id],intent_keys:[],owner_domains:["personal"]}];for(const file of [path,path+".backup"])await writeFile(file,JSON.stringify(s),{mode:0o600});await writeFile(privateComparisonPath(path),await readFile(privateComparisonPath(f.ctx.path)),{mode:0o600});f.ctx.path=path;
 const migrated=await readTaskStore(path);assert.equal(migrated.proposals[0].status,"stale");assert.equal(migrated.proposals[0].task_binding,undefined);assert.equal(migrated.approvals[0].signature,undefined);assert.equal(migrated.approvals[0].binding_hash,undefined);assert.equal(migrated.challenges[0].binding_hash,undefined);assert.deepEqual(migrated.consumed_approval_ids,s.consumed_approval_ids);
 for(const file of [path,path+".backup",archive]){const bytes=await readFile(file,"utf8");for(const verifier of [binding,approvalBindingHash,signature])assert.ok(!bytes.includes(verifier));}
 const publicProposal=await callTaskCrud(f.ctx,f.auth,"task_proposal",{proposal_id:proposal.id}) as any;assert.equal(publicProposal.binding_status,"approval_stale");assert.equal(publicProposal.proposal.task_binding,undefined);assert.equal(publicProposal.proposal.payload,undefined);
 await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_lease",{proposal_id:proposal.id}),{code:"approval_stale"});const before=(await stat(join(f.root,"artifact.txt"))).mtimeMs;assert.deepEqual(await callTaskCrud(f.ctx,f.auth,"task_execute",f.input),done);assert.equal((await stat(join(f.root,"artifact.txt"))).mtimeMs,before);
 const rollback=await callTaskCrud(f.ctx,f.auth,"task_rollback_prepare",{receipt_id:done.receipt.id}) as any;assert.equal(rollback.proposal.binding_version,2);assert.notEqual(rollback.proposal.id,oldRollbackId,"fresh rollback cannot reuse a retired v1 identity");assert.equal(rollback.proposal.status,"prepared");await f.approve(rollback.proposal.id);await callTaskCrud(f.ctx,f.ownerAuth,"task_controls",{execution_stopped:false});const lease=await callTaskCrud(f.ctx,f.auth,"task_lease",{proposal_id:rollback.proposal.id}) as any;
 await callTaskCrud(f.ctx,f.auth,"task_execute",{proposal_id:rollback.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"fresh-rollback"});assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");assert.ok((await readTaskStore(path)).consumed_approval_ids.includes(f.proof.approval_id));
});


test("event execution uses its source cursor, ignoring foreign events but retaining own-event and binding guards",async()=>{
 for(const mode of ["foreign-processed","foreign-unprocessed","own-unprocessed","own-processed","binding-drift"]){
  const f=await fixture();
  for(const id of ["own","foreign"])await callTaskCrud(f.ctx,f.ownerAuth,"task_source_register",{id,kind:"event",producer_actor:"owner",owner_domains:["personal"],sensitivity:"private",max_age_ms:10000,enabled:true});
  let task=await callTaskCrud(f.ctx,f.auth,"task_get",{id:f.prepared.proposal.task_id}) as any;
  task=await callTaskCrud(f.ctx,f.ownerAuth,"task_edit",{id:task.id,expected_revision:task.expected_revision,patch:{schedule:{kind:"event",source_id:"own",predicate:"equals",expected:"ready"}}}) as any;
  await callTaskCrud(f.ctx,f.ownerAuth,"task_review",{id:task.id,expected_revision:task.expected_revision});
  const event=(source_id:string,dedup_key:string)=>callTaskCrud(f.ctx,f.ownerAuth,"task_event",{source_id,source_revision:0,dedup_key,value:source_id==="own"?"ready":"unrelated",state_updated_at:1000});
  await event("own","own-1");await event("foreign","foreign-1");await event("foreign","foreign-2");await reconcileTaskTime(f.ctx);
  const {assessTaskFreshness}=await import("../src/task-freshness.js");await assessTaskFreshness(f.ctx);task=await callTaskCrud(f.ctx,f.auth,"task_get",{id:task.id}) as any;
  const snapshot=await readTaskStore(f.ctx.path);assert.equal(snapshot.tasks[0].last_event_sequence,3);assert.equal(snapshot.events.find(e=>e.source_id==="own")!.sequence,1);
  const prepared=await callTaskCrud(f.ctx,f.auth,"task_prepare",{id:task.id,expected_revision:task.expected_revision,target_id:"artifact",payload:"new\n"}) as any;await f.approve(prepared.proposal.id);
  const lease=await callTaskCrud(f.ctx,f.auth,"task_lease",{proposal_id:prepared.proposal.id}) as any;
  const approved=await callTaskCrud(f.ctx,f.auth,"task_proposal",{proposal_id:prepared.proposal.id}) as any;assert.equal(approved.binding_status,"current");assert.equal(approved.approved,true);
  if(mode==="foreign-unprocessed")await event("foreign","foreign-late");
  if(mode.startsWith("own-")){await event("own","own-late");if(mode==="own-processed")await reconcileTaskTime(f.ctx);}
  if(mode==="binding-drift"){task=await callTaskCrud(f.ctx,f.auth,"task_get",{id:task.id}) as any;task=await callTaskCrud(f.ctx,f.ownerAuth,"task_edit",{id:task.id,expected_revision:task.expected_revision,patch:{goal:"Changed reviewed goal"}}) as any;await callTaskCrud(f.ctx,f.ownerAuth,"task_review",{id:task.id,expected_revision:task.expected_revision});}
  const input={proposal_id:prepared.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"source-cursor"};
  if(mode.startsWith("foreign-")){const result=await callTaskCrud(f.ctx,f.auth,"task_execute",input) as any;assert.equal(result.state,"succeeded");assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"new\n");}
  else{await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_execute",input),{code:"approval_stale"},mode);assert.equal(await readFile(join(f.root,"artifact.txt"),"utf8"),"old\n");assert.equal((await readTaskStore(f.ctx.path)).intents.length,0);}
 }
});
