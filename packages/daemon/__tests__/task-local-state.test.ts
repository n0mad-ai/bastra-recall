import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, unlink, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { observeTaskSources, reconcileTaskTime } from "../src/task-events.js";
import { readTaskStore, transactTaskStore } from "../src/task-store.js";
import { newOwnerKey, unlockOwnerKey, bytesHash, signTaskApproval, type ApprovalRegistry } from "../src/task-approval-keys.js";
import { approvalBinding } from "../src/task-actions.js";
import { assessTaskFreshness } from "../src/task-freshness.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "task-local-state-"))); let now = 1000;
  const ctx = { path: join(root,"tasks.json"), authPath: join(root,"auth.json"), now:()=>now };
  const credential = await mintTaskCredential(ctx.authPath,{actor_id:"owner",domains:["personal"],role:"owner"});
  const auth = `Bearer ${credential.token}`;
  const source = {id:"source",producer_actor:"task-source-reader",owner_domains:["personal"],sensitivity:"private",max_age_ms:100000,enabled:true};
  const task = {idempotency_key:"watch",original_request:"Watch",goal:"Watch",resolution_condition:"Owner review",schedule:{kind:"instant",at:999999},timezone:"UTC",scope:{kind:"personal",name:"fixture"},owner_domains:["personal"],arm:true};
  return {root,ctx,auth,source,task,setNow:(v:number)=>{now=v;}};
}
test("project/worktree read real local Git state, persist replay, and do not repeat unchanged snapshots",async()=>{
  const f=await fixture(); const repo=join(f.root,"repo"); await mkdir(repo);
  const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"}).trim();
  git("init","-b","fixture"); git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-m","fixture");
  for(const kind of ["project","worktree"]) await callTaskCrud(f.ctx,f.auth,"task_source_register",{...f.source,id:kind,kind,root:repo});
  await observeTaskSources(f.ctx); let s=await readTaskStore(f.ctx.path); assert.equal(s.events.length,2);
  assert.match(s.events[0].value,/fixture/); assert.match(s.events[1].value,/worktree/);
  await writeFile(join(repo,"new.txt"),"new"); await observeTaskSources(f.ctx);
  s=await readTaskStore(f.ctx.path); assert.equal(s.events.length,3); assert.match(s.events[2].value,/new.txt/);
  f.setNow(900); await observeTaskSources({...f.ctx}); assert.equal((await readTaskStore(f.ctx.path)).events.length,3);
});
test("entity/document project exact structured memory state, not unrelated body versions",async()=>{
  const f=await fixture(); let raw='---\nid: note\ntype: doc\nstatus: draft\ntitle: Invoice\n---\nBody';
  const ctx={...f.ctx,memoryRead:async()=>({id:"note",raw,body:"Body",revision:"revision",sensitivity:"private"})};
  await callTaskCrud(ctx,f.auth,"task_source_register",{...f.source,kind:"entity",memory_id:"note",field:"status"});
  await callTaskCrud(ctx,f.auth,"task_source_register",{...f.source,id:"document",kind:"document",memory_id:"note"});
  await observeTaskSources(ctx); let s=await readTaskStore(ctx.path); assert.equal(s.events[0].value,'"draft"'); assert.match(s.events[1].value,/Invoice/);
  raw=raw.replace("Body","Changed body"); await observeTaskSources(ctx); assert.equal((await readTaskStore(ctx.path)).events.length,2);
  raw=raw.replace("draft","ready"); f.setNow(2000); await observeTaskSources(ctx); assert.equal((await readTaskStore(ctx.path)).events.length,4);
  await callTaskCrud(ctx,f.auth,"task_source_register",{...f.source,id:"public",kind:"entity",memory_id:"note",field:"status",sensitivity:"public"});
  await observeTaskSources(ctx); assert.equal((await readTaskStore(ctx.path)).events.filter(e=>e.source_id==="public").length,0);
});
test("task-phase observes bound task state and refuses cross-domain sources",async()=>{
  const f=await fixture(); const target=await callTaskCrud(f.ctx,f.auth,"task_create",f.task) as any;
  await callTaskCrud(f.ctx,f.auth,"task_source_register",{...f.source,kind:"task-phase",task_id:target.id});
  await observeTaskSources(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).events[0].value,"pending");
  const paused=await callTaskCrud(f.ctx,f.auth,"task_pause",{id:target.id,expected_revision:target.expected_revision}) as any;
  await observeTaskSources(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).events[1].value,"paused");
  await callTaskCrud(f.ctx,f.auth,"task_cancel",{id:target.id,expected_revision:paused.expected_revision});
  await observeTaskSources(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).events[2].value,"cancelled");
  const other=await mintTaskCredential(f.ctx.authPath,{actor_id:"other",domains:["other"],role:"owner"});
  const hidden=await callTaskCrud(f.ctx,`Bearer ${other.token}`,"task_create",{...f.task,idempotency_key:"hidden",owner_domains:["other"]}) as any;
  await callTaskCrud(f.ctx,f.auth,"task_source_register",{...f.source,id:"denied",kind:"task-phase",task_id:hidden.id});
  await observeTaskSources(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).events.filter(e=>e.source_id==="denied").length,0);
  await callTaskCrud(f.ctx,f.auth,"task_source_register",{...f.source,id:"public",kind:"task-phase",task_id:target.id,sensitivity:"public"});
  await observeTaskSources(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).events.filter(e=>e.source_id==="public").length,0);
});
test("symbol snapshots bind exact graph node, reject links, and replay offline latest once after disable/recovery",async()=>{
  const f=await fixture(); const graph=join(f.root,"graph.json");
  const write=async(label:string)=>writeFile(graph,JSON.stringify({nodes:[{id:"symbol",label,file_type:"code",source_file:"index.ts",source_location:"L1"}],links:[]}));
  await write("draft"); await callTaskCrud(f.ctx,f.auth,"task_source_register",{...f.source,kind:"symbol",root:f.root,path:"graph.json",symbol_id:"symbol"});
  await observeTaskSources(f.ctx); const baseline=(await readTaskStore(f.ctx.path)).events[0].value;
  await callTaskCrud(f.ctx,f.auth,"task_create",{...f.task,schedule:{kind:"event",source_id:"source",predicate:"content-version",expected:baseline}});
  await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length,0);
  await transactTaskStore(f.ctx.path,undefined,s=>{s.controls.enabled=false;});
  await write("missed"); await observeTaskSources(f.ctx); await write("latest");
  await transactTaskStore(f.ctx.path,undefined,s=>{s.controls.enabled=true;}); f.setNow(2000);
  await observeTaskSources({...f.ctx}); await reconcileTaskTime(f.ctx); let s=await readTaskStore(f.ctx.path);
  assert.equal(s.events.length,2); assert.equal(s.occurrences.length,1); assert.match(s.events[1].value,/latest/);
  await observeTaskSources(f.ctx); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length,1);
  await symlink(graph,join(f.root,"link")); await callTaskCrud(f.ctx,f.auth,"task_source_register",{...f.source,id:"unsafe",kind:"symbol",root:f.root,path:"link",symbol_id:"symbol"});
  await observeTaskSources(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).events.filter(e=>e.source_id==="unsafe").length,0);
});

for(const kind of ["project","worktree","task-phase","symbol","entity","document"] as const) test(`${kind}: source disable/resume, offline latest replay, rollback clock and restart stay idempotent`,async()=>{
  const f=await fixture(); let raw="---\nid: note\ntype: doc\nstatus: draft\n---\nBody";
  const ctx={...f.ctx,memoryRead:async()=>({id:"note",raw,body:"Body",revision:"revision",sensitivity:"private"})};
  let source:Record<string,unknown>={...f.source,kind}, change:()=>Promise<void>;
  if(kind==="entity" || kind==="document") {
    source={...source,memory_id:"note",...(kind==="entity"?{field:"status"}:{})};
    change=async()=>{raw=raw.replace("draft","intermediate").replace("intermediate","ready");};
  } else if(kind==="symbol") {
    const path=join(f.root,"graph.json"),write=async(label:string)=>writeFile(path,JSON.stringify({nodes:[{id:"node",label,file_type:"code",source_file:"a.ts",source_location:"L1"}],links:[]}));
    await write("draft"); source={...source,root:f.root,path:"graph.json",symbol_id:"node"};
    change=async()=>{await write("intermediate");await write("ready");};
  } else if(kind==="task-phase") {
    const target=await callTaskCrud(ctx,f.auth,"task_create",{...f.task,idempotency_key:"target"}) as any;
    source={...source,task_id:target.id};
    change=async()=>{const t=await callTaskCrud(ctx,f.auth,"task_snooze",{id:target.id,expected_revision:target.expected_revision,until:5000}) as any;await callTaskCrud(ctx,f.auth,"task_cancel",{id:target.id,expected_revision:t.expected_revision});};
  } else {
    const repo=join(f.root,"repo"); await mkdir(repo);
    const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"});
    git("init","-b","fixture");git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-m","fixture");
    source={...source,root:repo};
    change=kind==="project"?async()=>{await writeFile(join(repo,"draft"),"1");await writeFile(join(repo,"ready"),"2");}:async()=>{git("worktree","add","--detach",join(f.root,"other"));git("worktree","lock",join(f.root,"other"));};
  }
  await callTaskCrud(ctx,f.auth,"task_source_register",source); await observeTaskSources(ctx);
  const baseline=(await readTaskStore(ctx.path)).events.at(-1)!.value;
  await callTaskCrud(ctx,f.auth,"task_create",{...f.task,schedule:{kind:"event",source_id:"source",predicate:"content-version",expected:baseline}});
  await reconcileTaskTime(ctx); assert.equal((await readTaskStore(ctx.path)).occurrences.length,0);
  await callTaskCrud(ctx,f.auth,"task_controls",{source:{id:"source",enabled:false}}); await change(); await observeTaskSources(ctx);
  assert.equal((await readTaskStore(ctx.path)).events.length,1);
  await callTaskCrud(ctx,f.auth,"task_controls",{source:{id:"source",enabled:true}}); f.setNow(2000);
  await observeTaskSources({...ctx}); await reconcileTaskTime(ctx);
  let s=await readTaskStore(ctx.path); assert.equal(s.events.length,2); assert.equal(s.occurrences.length,1);
  await observeTaskSources({...ctx}); await reconcileTaskTime({...ctx}); f.setNow(900); await observeTaskSources(ctx); await reconcileTaskTime(ctx);
  s=await readTaskStore(ctx.path); assert.equal(s.events.length,2); assert.equal(s.occurrences.length,1);
  const status=await callTaskCrud(ctx,f.auth,"task_status",{}) as any;
  assert.equal(status.sources[0].coverage.intermediate_transitions,false);
});

test("symbol unavailable/budget failures recover without fabrication; hardlinks and invalid UTF-8 are refused",async()=>{
  const f=await fixture(); const path=join(f.root,"graph.json");
  await callTaskCrud(f.ctx,f.auth,"task_source_register",{...f.source,kind:"symbol",root:f.root,path:"graph.json",symbol_id:"node"});
  await callTaskCrud(f.ctx,f.auth,"task_create",{...f.task,schedule:{kind:"event",source_id:"source",predicate:"equals",expected:"null"},budget:{poll_interval_ms:60000,timeout_ms:1000,max_source_bytes:64}});
  await observeTaskSources(f.ctx); let s=await readTaskStore(f.ctx.path); assert.equal(s.events.length,0);assert.equal(s.tasks[0].last_failure?.code,"source_unavailable");
  await writeFile(path," ".repeat(65)); await observeTaskSources(f.ctx);s=await readTaskStore(f.ctx.path);assert.equal(s.tasks[0].last_failure?.code,"source_budget");
  await writeFile(path,Buffer.from([0xff]));await observeTaskSources(f.ctx);assert.equal((await readTaskStore(f.ctx.path)).events.length,0);
  await writeFile(path,JSON.stringify({nodes:[],links:[]}));await link(path,join(f.root,"hardlink"));await observeTaskSources(f.ctx);assert.equal((await readTaskStore(f.ctx.path)).events.length,0);
  await unlink(join(f.root,"hardlink"));await observeTaskSources(f.ctx);await reconcileTaskTime(f.ctx);s=await readTaskStore(f.ctx.path);assert.equal(s.events.length,1);assert.equal(s.tasks[0].last_failure,undefined);assert.equal(s.occurrences.length,1);
});

test("entity scrubbed journal values retain exact comparison and never repeat on unchanged secret state",async()=>{
  const f=await fixture(); const secret="api_key=sk_"+"a".repeat(36), expected=JSON.stringify(secret);
  const raw=`---\nid: note\nstatus: ${JSON.stringify(secret)}\n---\nBody`;
  const ctx={...f.ctx,memoryRead:async()=>({id:"note",raw,body:"Body",revision:"revision",sensitivity:"private"})};
  await callTaskCrud(ctx,f.auth,"task_source_register",{...f.source,kind:"entity",memory_id:"note",field:"status"});
  await callTaskCrud(ctx,f.auth,"task_create",{...f.task,schedule:{kind:"event",source_id:"source",predicate:"equals",expected}});
  await observeTaskSources(ctx); await reconcileTaskTime(ctx); let s=await readTaskStore(ctx.path);
  assert.equal(s.events.length,1); assert.equal(s.occurrences.length,1); assert.notEqual(s.events[0].value,expected);
  await observeTaskSources(ctx); await reconcileTaskTime(ctx); s=await readTaskStore(ctx.path);
  assert.equal(s.events.length,1); assert.equal(s.occurrences.length,1);
});

test("local-state trigger can prepare but never grants execution authority even with signed fixture approval",async()=>{
  const f=await fixture(), envelope=newOwnerKey("synthetic fixture password"); await writeFile(join(f.root,"artifact"),"old");
  const registry:ApprovalRegistry={schema_version:1,revision:1,protected_boundary:true,keys:[{id:"owner-key",domain:"personal",public_key:envelope.public_key,fingerprint:bytesHash(envelope.public_key)}],targets:[{id:"artifact",root:f.root,path:"artifact",owner_domains:["personal"],sensitivity:"private",adapter:"local-artifact-v1"}]};
  const ctx={...f.ctx,executionHost:true,approvalRegistry:Promise.resolve(registry),actionClock:()=>({boot_id:"fixture",monotonic:1000})};
  const target=await callTaskCrud(ctx,f.auth,"task_create",{...f.task,idempotency_key:"target"}) as any;
  await callTaskCrud(ctx,f.auth,"task_source_register",{...f.source,kind:"task-phase",task_id:target.id});
  const watcher=await callTaskCrud(ctx,f.auth,"task_create",{...f.task,action_level:"execute",schedule:{kind:"event",source_id:"source",predicate:"equals",expected:"pending"}}) as any;
  await observeTaskSources(ctx); await assessTaskFreshness(ctx); await reconcileTaskTime(ctx); const task=(await readTaskStore(ctx.path)).tasks.find(t=>t.id===watcher.id)!;
  const prepared=await callTaskCrud(ctx,f.auth,"task_prepare",{id:task.id,expected_revision:`initial:${task.revision}`,target_id:"artifact",payload:"new"}) as any;
  const challenge=await callTaskCrud(ctx,f.auth,"task_challenge",{proposal_id:prepared.proposal.id,domain:"personal"}) as any;
  await callTaskCrud(ctx,f.auth,"task_approval",{challenge_id:challenge.challenge.id,decision:"approve",signature:signTaskApproval(unlockOwnerKey(envelope,"synthetic fixture password"),approvalBinding(challenge.proposal,challenge.challenge,"approve"))});
  await callTaskCrud(ctx,f.auth,"task_controls",{execution_stopped:false,adapter:{id:"local-artifact-v1",enabled:true}});
  const lease=await callTaskCrud(ctx,f.auth,"task_lease",{proposal_id:prepared.proposal.id}) as any;
  await assert.rejects(callTaskCrud(ctx,f.auth,"task_execute",{proposal_id:prepared.proposal.id,lease_id:lease.lease.id,holder_token:lease.holder_token,fence:lease.lease.fence,idempotency_key:"denied"}),{code:"approval_stale"});
  assert.equal(await readFile(join(f.root,"artifact"),"utf8"),"old");assert.equal((await readTaskStore(ctx.path)).intents.length,0);
});
