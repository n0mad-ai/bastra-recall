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
