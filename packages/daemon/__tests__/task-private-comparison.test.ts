import "./tasks-opt-in.js";
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,stat,chmod,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {mintTaskCredential} from "../src/task-auth.js";
import {callTaskCrud} from "../src/task-service.js";
import {readTaskStore} from "../src/task-store.js";
import {privateComparisonPath} from "../src/task-private-comparison.js";
import {taskArchivePath} from "../src/task-archive.js";
import {canonicalTaskValue} from "../src/task-canonical.js";
async function fixture(){const root=await mkdtemp(join(tmpdir(),"task-private-")),ctx={path:join(root,"tasks.json"),authPath:join(root,"auth.json"),now:()=>1000};const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]});const ownerAuth=`Bearer ${owner.token}`;const agent=await mintTaskCredential(ctx.authPath,{actor_id:"agent",role:"agent",domains:["personal"]});const auth=`Bearer ${agent.token}`;const input={idempotency_key:"one",original_request:"Remind me: password=0427",goal:"Review",resolution_condition:"Done",schedule:{kind:"instant",at:2000},timezone:"Europe/Madrid",scope:{kind:"personal",name:"fixture"},owner_domains:["personal"],arm:true,origin:{kind:"user-request",client:"test",session:"test",context:"Review deadline"}};return{root,ctx,auth,ownerAuth,input};}
test("private per-store HMAC preserves duplicates, resists public dictionary probe and stays off transports/exports",async()=>{
 const f=await fixture(),g=await fixture();const made=await callTaskCrud(f.ctx,f.auth,"task_create",f.input) as any;await callTaskCrud(g.ctx,g.auth,"task_create",g.input);
 const store=await readTaskStore(f.ctx.path),other=await readTaskStore(g.ctx.path),row=store.tasks[0];assert.match(row.reminder_fingerprint!,/^hmac-v1:[a-f0-9]{64}$/);assert.notEqual(row.reminder_fingerprint,other.tasks[0].reminder_fingerprint);
 const key=await readFile(privateComparisonPath(f.ctx.path),"utf8");assert.equal((await stat(privateComparisonPath(f.ctx.path))).mode&0o077,0);assert.equal(key.length,64);
 const duplicate=await callTaskCrud(f.ctx,f.auth,"task_create",{...f.input,idempotency_key:"repeat"}) as any;assert.equal(duplicate.id,made.id);assert.equal(duplicate.duplicate,true);
 for(const [operation,input]of [["task_get",{id:made.id}],["task_list",{}],["task_status",{}]] as const){const result=await callTaskCrud(f.ctx,f.auth,operation,input);const json=JSON.stringify(result);assert.ok(!json.includes("reminder_fingerprint"));assert.ok(!json.includes("creation_hash"));assert.ok(!json.includes(key));assert.ok(!json.includes(row.reminder_fingerprint!));}
 for(let i=0;i<10000;i++){const raw={goal:row.goal,request:`Remind me: password=${String(i).padStart(4,"0")}`,resolution:row.resolution_condition,origin:{kind:row.origin!.kind,context:row.origin!.context},schedule:row.schedule,timezone:row.timezone,recurrence:row.recurrence??null,domains:[...row.owner_domains].sort(),scope:row.scope,sensitivity:row.sensitivity,evidence:row.evidence,decision:row.decision??null};assert.notEqual(createHash("sha256").update(canonicalTaskValue(raw)).digest("hex"),row.reminder_fingerprint!.slice(8));}
 const done=await callTaskCrud(f.ctx,f.auth,"task_resolve",{id:made.id,expected_revision:made.expected_revision}) as any;const before=await readTaskStore(f.ctx.path);const archived=await callTaskCrud(f.ctx,f.ownerAuth,"task_archive",{task_ids:[done.id],expected_revision:before.revision,recovery_epoch:before.recovery_epoch}) as any;
 const bytes=await readFile(taskArchivePath(f.ctx.path,archived.archive_id),"utf8");assert.ok(!bytes.includes("reminder_fingerprint"));assert.ok(!bytes.includes("creation_hash"));assert.ok(!bytes.includes("hmac-v1:"));assert.ok(!bytes.includes(key));assert.ok(!bytes.includes("password=0427"));
 assert.equal((await callTaskCrud(f.ctx,f.auth,"task_create",f.input) as any).id,made.id);await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_create",{...f.input,goal:"Different"}),{code:"conflict"});
});
test("legacy unkeyed values are removed from live/backup/cold archive and hash index follows",async()=>{
 const f=await fixture();const made=await callTaskCrud(f.ctx,f.auth,"task_create",f.input) as any;let s=await readTaskStore(f.ctx.path);const row=s.tasks[0];row.reminder_fingerprint="a".repeat(64);row.creation_hash="b".repeat(64);row.state="resolved";row.armed=false;
 // Fresh path emulates an existing installation, before migration has run.
 const path=join(f.root,"legacy.json"),id="00000000-0000-4000-8000-000000000001";const group=structuredClone(s);group.archives=[];const bundle=JSON.stringify({schema_version:1,id,snapshot:group});const archive=taskArchivePath(path,id);const {mkdir}=await import("node:fs/promises");await mkdir(join(f.root,"task-archives"),{recursive:true});await writeFile(archive,bundle,{mode:0o600});
 s.archives=[{id,hash:createHash("sha256").update(bundle).digest("hex"),at:1000,actor:"owner",task_ids:[made.id],intent_keys:[],owner_domains:["personal"]}];await writeFile(path,JSON.stringify(s),{mode:0o600});await writeFile(path+".backup",JSON.stringify(s),{mode:0o600});await readTaskStore(path);
 for(const file of [path,path+".backup",archive]){const raw=await readFile(file,"utf8");assert.ok(!raw.includes('"reminder_fingerprint"'));assert.ok(!raw.includes('"creation_hash"'));assert.ok(!raw.includes("a".repeat(64)));assert.ok(!raw.includes("b".repeat(64)));}
 const updated=await readTaskStore(path);assert.equal(updated.archives[0].hash,createHash("sha256").update(await readFile(archive,"utf8")).digest("hex"));await assert.rejects(stat(path+".comparison-migration"),{code:"ENOENT"});
});
test("unsafe or missing comparison key fails closed; no automatic replacement of existing HMAC state",async()=>{
 const f=await fixture();await callTaskCrud(f.ctx,f.auth,"task_create",f.input);const path=privateComparisonPath(f.ctx.path);const key=await readFile(path,"utf8");await chmod(path,0o644);await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_create",{...f.input,idempotency_key:"two"}),{code:"corrupt"});assert.equal(await readFile(path,"utf8"),key);await unlink(path);await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_create",{...f.input,idempotency_key:"three"}),{code:"corrupt"});await assert.rejects(stat(path),{code:"ENOENT"});
});
test("archive cleanup resumes after crash-window index update without blessing foreign bytes",async()=>{
 const f=await fixture();await callTaskCrud(f.ctx,f.auth,"task_create",f.input);const s=await readTaskStore(f.ctx.path);s.tasks[0].state="resolved";s.tasks[0].armed=false;s.tasks[0].reminder_fingerprint="c".repeat(64);
 const path=join(f.root,"resume.json"),id="00000000-0000-4000-8000-000000000002",group=structuredClone(s);group.archives=[];const bundle=JSON.stringify({schema_version:1,id,snapshot:group});const archive=taskArchivePath(path,id);const {mkdir}=await import("node:fs/promises");await mkdir(join(f.root,"task-archives"),{recursive:true});await writeFile(archive,bundle,{mode:0o600});s.archives=[{id,hash:createHash("sha256").update(bundle).digest("hex"),at:1000,actor:"owner",task_ids:[s.tasks[0].id],intent_keys:[],owner_domains:["personal"]}];await writeFile(path,JSON.stringify(s),{mode:0o600});
 const fs=(await import("node:fs")).default,{syncBuiltinESMExports}=await import("node:module"),original=fs.renameSync;let interrupted=false;
 fs.renameSync=(a,b)=>{if(String(b)===archive&&!interrupted){interrupted=true;throw Object.assign(new Error("synthetic migration interruption"),{code:"EACCES"});}return original(a,b);};syncBuiltinESMExports();
 try{await assert.rejects(readTaskStore(path));assert.ok(interrupted);assert.ok((await stat(path+".comparison-migration")).isFile());}finally{fs.renameSync=original;syncBuiltinESMExports();}
 const completed=await readTaskStore(path);const bytes=await readFile(archive,"utf8");assert.ok(!bytes.includes("reminder_fingerprint"));assert.equal(completed.archives[0].hash,createHash("sha256").update(bytes).digest("hex"));await assert.rejects(stat(path+".comparison-migration"),{code:"ENOENT"});
});

test("event, claim and raw/client-SHA baselines use the same private content comparison; retries remain exact", async()=>{
 const f=await fixture(), g=await fixture(); const raw="password=0427", digest=createHash("sha256").update(raw).digest("hex");
 const source={id:"source",kind:"event",producer_actor:"agent",owner_domains:["personal"],sensitivity:"private",max_age_ms:10000,enabled:true};
 for(const x of [f,g])await callTaskCrud(x.ctx,x.ownerAuth,"task_source_register",source);
 const input={...f.input,arm:true,schedule:{kind:"event",source_id:"source",predicate:"equals",expected:raw}};
 const a=await callTaskCrud(f.ctx,f.ownerAuth,"task_create",input) as any;
 const b=await callTaskCrud(f.ctx,f.ownerAuth,"task_create",{...input,idempotency_key:"sha",schedule:{...input.schedule,expected:digest}}) as any;
 await callTaskCrud(g.ctx,g.ownerAuth,"task_create",input);
 const event={source_id:"source",source_revision:0,dedup_key:"same",value:raw,state_updated_at:1000,claim:{claim_id:"assumption",claim_revision:"v1",value:raw,evidence_id:"evidence",evidence_revision:"v1"}};
 const first=await callTaskCrud(f.ctx,f.auth,"task_event",event);assert.deepEqual(await callTaskCrud(f.ctx,f.auth,"task_event",event),first);
 await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_event",{...event,value:"password=0583"}),{code:"conflict"});
 await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_event",{...event,claim:{...event.claim,value:"password=0771"}}),{code:"conflict"});
 const {reconcileTaskTime}=await import("../src/task-events.js");await reconcileTaskTime(f.ctx);let s=await readTaskStore(f.ctx.path);
 const hash=s.events[0].value_hash!;assert.match(hash,/^hmac-v1:/);assert.equal(s.events[0].claim!.value_hash,hash);assert.equal(s.tasks[0].schedule.kind==="event"&&s.tasks[0].schedule.expected_hash,hash);assert.equal(s.tasks[1].schedule.kind==="event"&&s.tasks[1].schedule.expected_hash,hash);assert.equal(s.occurrences.length,2);
 const other=await readTaskStore(g.ctx.path);assert.notEqual(other.tasks[0].schedule.kind==="event"&&other.tasks[0].schedule.expected_hash,hash);
 assert.ok(!(await readFile(f.ctx.path,"utf8")).includes(digest));assert.ok(!(await readFile(f.ctx.path,"utf8")).includes(raw));
 // The former dictionary verifier fails for every four-digit candidate.
 for(let i=0;i<10000;i++)assert.notEqual(createHash("sha256").update(`password=${String(i).padStart(4,"0")}`).digest("hex"),hash.slice(8));
 for(const [op,arg] of [["task_get",{id:a.id}],["task_list",{}],["task_status",{}],["task_due",{session:"private",channel:"mcp"}]] as const){const json=JSON.stringify(await callTaskCrud(f.ctx,f.auth,op,arg));assert.ok(!json.includes(hash));assert.ok(!json.includes(digest));for(const field of ["expected_hash","value_hash","last_material_hash","last_value_hash"])assert.ok(!json.includes(field));}
 for(const id of [a.id,b.id]){const task=await callTaskCrud(f.ctx,f.auth,"task_get",{id}) as any;await callTaskCrud(f.ctx,f.auth,"task_resolve",{id,expected_revision:task.expected_revision});}
 s=await readTaskStore(f.ctx.path);const archived=await callTaskCrud(f.ctx,f.ownerAuth,"task_archive",{task_ids:[a.id,b.id],expected_revision:s.revision,recovery_epoch:s.recovery_epoch}) as any;
 const bytes=await readFile(taskArchivePath(f.ctx.path,archived.archive_id),"utf8");assert.ok(!bytes.includes("hmac-v1:"));assert.ok(!bytes.includes(digest));for(const field of ["expected_hash","value_hash","last_material_hash","last_value_hash"])assert.ok(!bytes.includes(field));
 assert.deepEqual(await callTaskCrud(f.ctx,f.auth,"task_event",event),first,"archiving does not mutate the retained event journal");
 await callTaskCrud(f.ctx,f.ownerAuth,"task_archive_restore",{archive_id:archived.archive_id});const restored=await readTaskStore(f.ctx.path);assert.ok(restored.tasks.every(t=>!t.armed));
});

test("legacy expected/event/claim/material/source digests migrate in live, backup and exports without raw secrets",async()=>{
 const f=await fixture();const raw="password=0427",digest=createHash("sha256").update(raw).digest("hex");
 await callTaskCrud(f.ctx,f.ownerAuth,"task_source_register",{id:"source",kind:"event",producer_actor:"agent",owner_domains:["personal"],sensitivity:"private",max_age_ms:10000,enabled:true});
 const made=await callTaskCrud(f.ctx,f.ownerAuth,"task_create",{...f.input,schedule:{kind:"event",source_id:"source",predicate:"equals",expected:digest}}) as any;
 const event={source_id:"source",source_revision:0,dedup_key:"legacy",value:raw,state_updated_at:1000,claim:{claim_id:"claim",claim_revision:"v1",value:raw,evidence_id:"evidence",evidence_revision:"v1"}};await callTaskCrud(f.ctx,f.auth,"task_event",event);
 const s=await readTaskStore(f.ctx.path);const task=s.tasks[0];assert.equal(task.schedule.kind,"event");if(task.schedule.kind!=="event")throw new Error();task.schedule.expected=digest;task.schedule.expected_hash=digest;task.last_material_hash=digest;s.events[0].value_hash=digest;s.events[0].claim!.value_hash=digest;s.sources[0].last_value_hash=digest;
 const {verifyTaskEvent:legacyVerify}=await import("../src/task-freshness.js");task.verification=legacyVerify(task,s.events[0],s,1000);
 const bodyDigest=createHash("sha256").update(canonicalTaskValue(raw)).digest("hex");task.decision_change={id:"legacy-change",actor:"owner",expected_memory_revision:"v1",binding_hash:"f".repeat(64),new_body_hash:bodyDigest,new_option:"B",new_reason:"Changed",status:"applied"};
 const {taskCreateInputSchema}=await import("../src/task-service.js"),{privateTaskComparison}=await import("../src/task-private-comparison.js");
 const legacyInput=taskCreateInputSchema.parse({...f.input,schedule:{kind:"event",source_id:"source",predicate:"equals",expected:raw}});if(legacyInput.schedule.kind!=="event")throw new Error();legacyInput.schedule.expected_hash=digest;task.creation_hash=await privateTaskComparison(f.ctx.path,"create",legacyInput);const {reminderFingerprint}=await import("../src/task-conversation.js");task.reminder_fingerprint=await reminderFingerprint(f.ctx.path,legacyInput);
 const path=join(f.root,"content-legacy.json"),ctx={...f.ctx,path};await writeFile(privateComparisonPath(path),await readFile(privateComparisonPath(f.ctx.path)),{mode:0o600});
 const id="00000000-0000-4000-8000-000000000003",group=structuredClone(s);group.archives=[];group.tasks[0].state="resolved";group.tasks[0].armed=false;const bundle=JSON.stringify({schema_version:1,id,snapshot:group}),archive=taskArchivePath(path,id);const {mkdir}=await import("node:fs/promises");await mkdir(join(f.root,"task-archives"),{recursive:true});await writeFile(archive,bundle,{mode:0o600});
 s.archives=[{id,hash:createHash("sha256").update(bundle).digest("hex"),at:1000,actor:"owner",task_ids:[made.id],intent_keys:[],owner_domains:["personal"]}];for(const file of [path,path+".backup"])await writeFile(file,JSON.stringify(s),{mode:0o600});
 const migrated=await readTaskStore(path);assert.equal(migrated.tasks[0].verification,undefined,"old comparison-derived cache binding is discarded");const {privateContentComparison}=await import("../src/task-private-comparison.js"),expected=await privateContentComparison(path,raw);assert.equal(migrated.events[0].value_hash,expected);assert.equal(migrated.events[0].claim!.value_hash,expected);assert.equal(migrated.tasks[0].last_material_hash,expected);assert.equal(migrated.sources[0].last_value_hash,expected);assert.equal(migrated.tasks[0].schedule.kind==="event"&&migrated.tasks[0].schedule.expected_hash,expected);
 assert.equal(migrated.tasks[0].decision_change!.new_body_hash,await privateTaskComparison(path,"decision-body",bodyDigest));
 for(const file of [path,path+".backup",archive]){const bytes=await readFile(file,"utf8");assert.ok(!bytes.includes(digest));assert.ok(!bytes.includes(bodyDigest));}assert.ok(!(await readFile(archive,"utf8")).includes("hmac-v1:"));
 assert.equal((await callTaskCrud(ctx,f.ownerAuth,"task_create",{...f.input,schedule:{kind:"event",source_id:"source",predicate:"equals",expected:raw}}) as any).id,made.id,"old keyed create retry retains its original identity");
 const duplicate=await callTaskCrud(ctx,f.auth,"task_create",{...f.input,idempotency_key:"legacy-duplicate",schedule:{kind:"event",source_id:"source",predicate:"equals",expected:raw}}) as any;assert.equal(duplicate.id,made.id);assert.equal(duplicate.duplicate,true,"old keyed reminder equality survives the content migration");
 const retry=await callTaskCrud(ctx,f.auth,"task_event",event) as any;assert.equal(retry.event_id,migrated.events[0].id);assert.equal((await readTaskStore(path)).events.length,1);
 const {reconcileTaskTime}=await import("../src/task-events.js");const evaluated=await reconcileTaskTime(ctx);const {verifyTaskEvent}=await import("../src/task-freshness.js");assert.equal(verifyTaskEvent(evaluated.tasks[0],evaluated.events[0],evaluated,1000).outcome,"verified");assert.equal(evaluated.occurrences.length,0,"unchanged material stays quiet after migration");
});

test("generic event content-version digest stays private in create, migration and cold export",async()=>{
 const f=await fixture(),raw="password=0427",digest=createHash("sha256").update(raw).digest("hex");
 await callTaskCrud(f.ctx,f.ownerAuth,"task_source_register",{id:"generic",kind:"event",producer_actor:"agent",owner_domains:["personal"],sensitivity:"private",max_age_ms:10000,enabled:true});
 const made=await callTaskCrud(f.ctx,f.ownerAuth,"task_create",{...f.input,schedule:{kind:"event",source_id:"generic",predicate:"content-version",expected:digest}}) as any;
 assert.equal(made.schedule.expected,"Private content baseline");assert.ok(!JSON.stringify(made).includes(digest));
 const s=await readTaskStore(f.ctx.path);if(s.tasks[0].schedule.kind!=="event")throw new Error();s.tasks[0].schedule.expected=digest; // already-HMAC R7 store, before this display correction
 const {taskCreateInputSchema}=await import("../src/task-service.js"),{privateTaskComparison}=await import("../src/task-private-comparison.js"),{reminderFingerprint}=await import("../src/task-conversation.js");
 const oldInput=taskCreateInputSchema.parse({...f.input,schedule:{kind:"event",source_id:"generic",predicate:"content-version",expected:digest}});if(oldInput.schedule.kind!=="event")throw new Error();oldInput.schedule.expected_hash=s.tasks[0].schedule.expected_hash;s.tasks[0].creation_hash=await privateTaskComparison(f.ctx.path,"create",oldInput);s.tasks[0].reminder_fingerprint=await reminderFingerprint(f.ctx.path,oldInput);
 const path=join(f.root,"display-legacy.json");await writeFile(path,JSON.stringify(s),{mode:0o600});await writeFile(path+".backup",JSON.stringify(s),{mode:0o600});await writeFile(privateComparisonPath(path),await readFile(privateComparisonPath(f.ctx.path)),{mode:0o600});
 const ctx={...f.ctx,path},get=await callTaskCrud(ctx,f.ownerAuth,"task_get",{id:made.id}) as any;assert.equal(get.schedule.expected,"Private content baseline");
 assert.equal((await callTaskCrud(ctx,f.ownerAuth,"task_create",{...f.input,schedule:{kind:"event",source_id:"generic",predicate:"content-version",expected:digest}}) as any).id,made.id,"R7 keyed create with formerly public display stays idempotent");
 const duplicate=await callTaskCrud(ctx,f.auth,"task_create",{...f.input,idempotency_key:"display-duplicate",schedule:{kind:"event",source_id:"generic",predicate:"content-version",expected:digest}}) as any;assert.equal(duplicate.id,made.id);assert.equal(duplicate.duplicate,true);
 await callTaskCrud(ctx,f.ownerAuth,"task_resolve",{id:made.id,expected_revision:get.expected_revision});const before=await readTaskStore(path);const archive=await callTaskCrud(ctx,f.ownerAuth,"task_archive",{task_ids:[made.id],expected_revision:before.revision,recovery_epoch:before.recovery_epoch}) as any;
 for(const file of [path,path+".backup",taskArchivePath(path,archive.archive_id)])assert.ok(!(await readFile(file,"utf8")).includes(digest));
});
