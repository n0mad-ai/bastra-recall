import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential, authenticateTask } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore, transactTaskStore } from "../src/task-store.js";
import { reconcileTaskTime } from "../src/task-events.js";
import { taskDueInput, taskDueProjection } from "../src/task-outbox.js";
import { notifyDueTasks, taskNotificationStatus } from "../src/task-notification.js";
import { settingEntry, parseStoredSettings } from "../src/settings-registry.js";
import { effectiveSetting } from "../src/settings-effective.js";
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),"task-notification-"));let now=3000;
 const ctx={path:join(root,"tasks.json"),authPath:join(root,"auth.json"),now:()=>now};
 const c=await mintTaskCredential(ctx.authPath,{actor_id:"owner",domains:["personal"],role:"owner"});const auth=`Bearer ${c.token}`;
 await callTaskCrud(ctx,auth,"task_create",{idempotency_key:"notify",original_request:"Synthetic due request",goal:"Synthetic $(not a command)",resolution_condition:"Done",schedule:{kind:"instant",at:2000},timezone:"Europe/Berlin",scope:{kind:"personal",name:"fixture"},owner_domains:["personal"],arm:true});
 await reconcileTaskTime(ctx);return {ctx,auth,setNow:(v:number)=>now=v};
}
test("notification setting defaults on independently of the tasks switch",()=>{
 const entry=settingEntry("tasks.notifications")!;assert.ok(entry);assert.equal(entry.default,true);
 assert.equal(effectiveSetting(entry,parseStoredSettings({update:{mode:"notify"},tasks:{enabled:true,notifications:false}}),{}).value,false);
 assert.equal(settingEntry("tasks.enabled")!.default,true);
});
test("native task notification is durable, race-safe and never acknowledges or resolves",async()=>{
 const f=await fixture();let sent=0;const options={platform:"darwin" as const,enabled:true,send:async(message:{title:string;body:string})=>{sent++;assert.equal(message.title,"Bastra Recall");assert.match(message.body,/Synthetic/);}};
 await Promise.all([notifyDueTasks(f.ctx,options),notifyDueTasks(f.ctx,options)]);
 await notifyDueTasks(f.ctx,options);assert.equal(sent,1);
 const s=await readTaskStore(f.ctx.path);assert.equal(s.tasks[0].state,"due");assert.equal(s.occurrences[0].notification?.submitted_at,3000);assert.equal(s.occurrences[0].acknowledgement,undefined);assert.equal(s.occurrences[0].resolution,undefined);
 const p=await authenticateTask(f.auth,f.ctx.authPath);
 const explicit=taskDueProjection(s,p,taskDueInput.parse({}),3000);assert.equal(explicit.cards[0].already_notified,true);
 const passive=taskDueProjection(s,p,taskDueInput.parse({}),3000,true);assert.equal(passive.cards.length,0);assert.equal(passive.pending,1);
});
test("unsupported platforms and disabled notifications do not send or write",async()=>{
 assert.deepEqual(await taskNotificationStatus("linux"),{supported:false,enabled:false,channel:"macos",receipt:"os-submission-not-human-read"});
 const f=await fixture();const before=await readTaskStore(f.ctx.path);const send=async()=>assert.fail("must not send");
 await notifyDueTasks(f.ctx,{platform:"linux",enabled:true,send});await notifyDueTasks(f.ctx,{platform:"darwin",enabled:false,send});
 assert.deepEqual(await readTaskStore(f.ctx.path),before);
});
test("a definite OS error retries after the declared interval without acknowledging",async()=>{
 const f=await fixture();let calls=0;const options={platform:"darwin" as const,enabled:true,send:async()=>{if(++calls===1)throw new Error("OS unavailable");}};
 await notifyDueTasks(f.ctx,options);assert.equal(calls,1);assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].notification?.failed_at,3000);
 await notifyDueTasks(f.ctx,options);assert.equal(calls,1);f.setNow(63000);await notifyDueTasks(f.ctx,options);assert.equal(calls,2);
 assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].acknowledgement,undefined);
});
test("an interrupted claimed submission is not sent twice after restart",async()=>{
 const f=await fixture();await transactTaskStore(f.ctx.path,undefined,s=>{s.occurrences[0].notification={claimed_at:2500};});
 f.setNow(999999);await notifyDueTasks(f.ctx,{platform:"darwin",enabled:true,send:async()=>assert.fail("claim must survive restart")});
});
test("muted, paused, acknowledged and conversation-delivered occurrences do not notify",async()=>{
 for(const mode of ["muted","paused","acknowledged","conversation"]){
  const f=await fixture();await transactTaskStore(f.ctx.path,undefined,s=>{
   if(mode==="muted")s.controls.muted=true;
   if(mode==="paused"){s.tasks[0].paused=true;s.tasks[0].revision++;s.tasks[0].history.push({at:3000,actor:"owner",operation:"pause",before_revision:s.tasks[0].revision-1,after_revision:s.tasks[0].revision,reason:"pause"});}
   if(mode==="acknowledged")s.occurrences[0].acknowledgement={at:3000,actor:"owner",proof_id:"fixture"};
   if(mode==="conversation")s.occurrences[0].attempts.push({at:3000,client:"fixture",outcome:"attempted",channel:"mcp"});
  });
  await notifyDueTasks(f.ctx,{platform:"darwin",enabled:true,send:async()=>assert.fail(mode)});
 }
});
