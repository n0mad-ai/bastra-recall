import "./tasks-opt-in.js";
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,stat,realpath,symlink,mkdir} from "node:fs/promises";
import {tmpdir,hostname} from "node:os";
import {join} from "node:path";
import {mintTaskCredential} from "../src/task-auth.js";
import {callTaskCrud} from "../src/task-service.js";
import {readTaskStore,transactTaskStore} from "../src/task-store.js";
import {taskArchivePath} from "../src/task-archive.js";
import {quarantineOfflineTaskLock} from "../src/task-maintenance.js";
import {registerOwnerTaskTarget} from "../src/cli/task-targets.js";
import {readApprovalRegistry} from "../src/task-approval-keys.js";
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),"task-maintenance-"))),ctx={path:join(root,"data","tasks.json"),authPath:join(root,"data","task-auth.json"),now:()=>1000};const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]}),agent=await mintTaskCredential(ctx.authPath,{actor_id:"agent",role:"agent",domains:["personal"]}),other=await mintTaskCredential(ctx.authPath,{actor_id:"other",role:"owner",domains:["other"]});const auth=`Bearer ${owner.token}`,input={idempotency_key:"one",original_request:"Demo",goal:"Demo",resolution_condition:"Owner outcome",schedule:{kind:"instant",at:2000},timezone:"Europe/Madrid",scope:{kind:"personal",name:"fixture"},owner_domains:["personal"]};return{root,ctx,auth,agent:`Bearer ${agent.token}`,other:`Bearer ${other.token}`,input};}
test("archive is private/exact and frees terminal task capacity without idempotency reuse",async()=>{
 const f=await fixture(),task=await callTaskCrud(f.ctx,f.auth,"task_create",f.input) as any;
 await assert.rejects(callTaskCrud(f.ctx,f.agent,"task_archive",{task_ids:[task.id],expected_revision:1,recovery_epoch:"initial"}),{code:"forbidden"});
 await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_archive",{task_ids:[task.id],expected_revision:1,recovery_epoch:"initial"}),{code:"conflict"});
 await callTaskCrud(f.ctx,f.auth,"task_resolve",{id:task.id,expected_revision:task.expected_revision});const before=await readTaskStore(f.ctx.path);
 await assert.rejects(callTaskCrud(f.ctx,f.other,"task_archive",{task_ids:[task.id],expected_revision:before.revision,recovery_epoch:before.recovery_epoch}),{code:"forbidden"});
 const out=await callTaskCrud(f.ctx,f.auth,"task_archive",{task_ids:[task.id],expected_revision:before.revision,recovery_epoch:before.recovery_epoch}) as any;
 const path=taskArchivePath(f.ctx.path,out.archive_id),after=await readTaskStore(f.ctx.path);assert.equal(after.tasks.length,0);assert.equal(after.archives.length,1);assert.equal((await stat(path)).mode&0o077,0);assert.ok((await readFile(path,"utf8")).includes("Explicit owner resolution")===false); // no occurrence existed
 const retry=await callTaskCrud(f.ctx,f.auth,"task_create",f.input) as any;assert.equal(retry.id,task.id);assert.equal(retry.archived,true);assert.equal((await readTaskStore(f.ctx.path)).tasks.length,0);
 await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_create",{...f.input,goal:"Changed"}),{code:"conflict"});
 await assert.rejects(transactTaskStore(f.ctx.path,undefined,s=>{s.archives=[];}),{code:"conflict"});
 const original=await readFile(path,"utf8");await writeFile(path,original+" ");await assert.rejects(callTaskCrud(f.ctx,f.auth,"task_create",f.input),{code:"corrupt"});assert.equal((await readTaskStore(f.ctx.path)).tasks.length,0);await writeFile(path,original);
 await callTaskCrud(f.ctx,f.auth,"task_archive_restore",{archive_id:out.archive_id});const restored=await readTaskStore(f.ctx.path);assert.deepEqual(restored.tasks,before.tasks);assert.equal(restored.controls.execution_stopped,true);assert.equal((await callTaskCrud(f.ctx,f.auth,"task_archive_restore",{archive_id:out.archive_id}) as any).restored,false);
});
test("recovery requires owner/all backup domains and disarms under a new epoch without touching memories",async()=>{
 const f=await fixture(),task=await callTaskCrud(f.ctx,f.auth,"task_create",{...f.input,arm:true}) as any;
 await callTaskCrud(f.ctx,f.auth,"task_snooze",{id:task.id,expected_revision:task.expected_revision,until:3000});await writeFile(join(f.root,"memory.md"),"untouched");await writeFile(f.ctx.path,"broken");
 await assert.rejects(callTaskCrud(f.ctx,f.other,"task_recover",{}),{code:"forbidden"});assert.equal(await readFile(f.ctx.path,"utf8"),"broken");
 const result=await callTaskCrud(f.ctx,f.auth,"task_recover",{}) as any;const restored=await readTaskStore(f.ctx.path);assert.equal(result.quarantined,true);assert.notEqual(restored.recovery_epoch,"initial");assert.equal(restored.tasks[0].armed,false);assert.equal(restored.controls.execution_stopped,true);assert.equal(await readFile(join(f.root,"memory.md"),"utf8"),"untouched");
});
test("offline lock quarantine never removes a live local owner and preserves unknown originals",async()=>{
 const f=await fixture(),lock=f.ctx.path+".lock";await writeFile(lock,JSON.stringify({pid:process.pid,host:hostname(),token:"live"}),{mode:0o600});await assert.rejects(async()=>quarantineOfflineTaskLock(f.ctx.path));assert.match(await readFile(lock,"utf8"),/live/);
 await writeFile(lock,"unknown interrupted owner");assert.equal(quarantineOfflineTaskLock(f.ctx.path).quarantined,1);await assert.rejects(readFile(lock),{code:"ENOENT"});
});
test("owner target registration rejects agents, domain drift, symlinks, nonreversible bytes and silent replacement",async()=>{
 const f=await fixture(),previous=process.env.BASTRA_TASKS_PATH;process.env.BASTRA_TASKS_PATH=f.ctx.path;
 try{const work=join(f.root,"work");await mkdir(work);await writeFile(join(work,"artifact.txt"),"old\n");const input={id:"artifact",root:work,path:"artifact.txt",owner_domains:["personal"],sensitivity:"private",adapter:"local-artifact-v1"};
 await assert.rejects(registerOwnerTaskTarget(f.agent,input),{code:"forbidden"});await assert.rejects(registerOwnerTaskTarget(f.other,input),{code:"forbidden"});
 await symlink(join(work,"artifact.txt"),join(work,"link.txt"));await assert.rejects(registerOwnerTaskTarget(f.auth,{...input,path:"link.txt"}),{code:"validation"});
 await writeFile(join(work,"bad.txt"),"tab\t");await assert.rejects(registerOwnerTaskTarget(f.auth,{...input,path:"bad.txt"}),{code:"adapter_not_reversible"});
 await registerOwnerTaskTarget(f.auth,input);const registry=await readApprovalRegistry();assert.equal(registry?.targets.length,1);assert.equal(registry?.protected_boundary,false);assert.equal((await readTaskStore(f.ctx.path)).controls.execution_stopped,true);await assert.rejects(registerOwnerTaskTarget(f.auth,input),{code:"conflict"});
 }finally{if(previous===undefined)delete process.env.BASTRA_TASKS_PATH;else process.env.BASTRA_TASKS_PATH=previous;}
});

test("protected paths and encompassing roots reject before registry writes; explicit update/remove reset authority",async()=>{
 const f=await fixture(),previous=process.env.BASTRA_TASKS_PATH,vaultPrevious=process.env.BASTRA_VAULT_PATH;process.env.BASTRA_TASKS_PATH=f.ctx.path;process.env.BASTRA_VAULT_PATH=join(f.root,"vault");
 try{await mkdir(join(f.root,"vault"));await writeFile(join(f.root,"vault","note.md"),"vault");const work=join(f.root,"work");await mkdir(work);await writeFile(join(work,"artifact.txt"),"old\n");const input={id:"artifact",root:work,path:"artifact.txt",owner_domains:["personal"],sensitivity:"private",adapter:"local-artifact-v1"};
 const targets=[{root:join(f.root,"data"),path:"task-auth.json"},{root:f.root,path:"work/artifact.txt"},{root:join(f.root,"vault"),path:"note.md"}];
 for(const name of [".bastra/config.json",".claude/settings.json",".codex/config.toml",".cursor/mcp.json","Library/LaunchAgents/test.plist",".zshrc",".bash_profile",".git/config",".git/HEAD",".git/refs/heads/main",".git/hooks/pre-commit",".husky/pre-commit",".github/workflows/test.yml",".envrc",".npmrc"]){const target=join(work,name);await mkdir(join(target,".."),{recursive:true});await writeFile(target,"protected");targets.push({root:work,path:name});}
 targets.push({root:join(work,".git","hooks"),path:"pre-commit"});
 for(const target of targets)await assert.rejects(registerOwnerTaskTarget(f.auth,{...input,...target}),(e:any)=>e.reason==="target_protected");
 const keys=join(f.root,"owner-keys");await mkdir(keys);await writeFile(join(keys,"private.json"),"synthetic encrypted-key fixture");await writeFile(join(f.root,"data","task-approval-keys.json"),JSON.stringify({schema_version:1,revision:0,protected_boundary:false,keys:[],targets:[],key_storage_roots:[keys]}),{mode:0o600});
 await assert.rejects(registerOwnerTaskTarget(f.auth,{...input,root:keys,path:"private.json"}),(e:any)=>e.reason==="target_protected");
 const alias=join(f.root,"alias");await symlink(work,alias);const {normalizedOwnerTarget}=await import("../src/cli/task-target-safety.js");assert.equal((await normalizedOwnerTarget({...input,root:alias})).root,work);
 await writeFile(join(work,"package.json"),JSON.stringify({scripts:{test:"echo synthetic"}}));assert.match((await normalizedOwnerTarget({...input,path:"package.json"})).execution_warning!,/Skripte/);
 await registerOwnerTaskTarget(f.auth,input);await writeFile(join(work,"second.txt"),"second\n");await registerOwnerTaskTarget(f.auth,{...input,path:"second.txt"},true);assert.equal((await readApprovalRegistry())?.targets[0].path,"second.txt");
 const {removeOwnerTaskTarget}=await import("../src/cli/task-targets.js");await assert.rejects(removeOwnerTaskTarget(f.agent,"artifact"),{code:"forbidden"});await removeOwnerTaskTarget(f.auth,"artifact");assert.equal((await readApprovalRegistry())?.targets.length,0);assert.equal((await readTaskStore(f.ctx.path)).controls.execution_stopped,true);
 }finally{if(previous===undefined)delete process.env.BASTRA_TASKS_PATH;else process.env.BASTRA_TASKS_PATH=previous;if(vaultPrevious===undefined)delete process.env.BASTRA_VAULT_PATH;else process.env.BASTRA_VAULT_PATH=vaultPrevious;}
});
test("older backup recovery discovers the exact cold export and reports restored active history",async()=>{
 const f=await fixture(),task=await callTaskCrud(f.ctx,f.auth,"task_create",f.input) as any;await callTaskCrud(f.ctx,f.auth,"task_resolve",{id:task.id,expected_revision:task.expected_revision});const s=await readTaskStore(f.ctx.path),archived=await callTaskCrud(f.ctx,f.auth,"task_archive",{task_ids:[task.id],expected_revision:s.revision,recovery_epoch:s.recovery_epoch}) as any;await writeFile(f.ctx.path,"truncated current snapshot");
 const result=await callTaskCrud(f.ctx,f.auth,"task_recover",{}) as any,restored=await readTaskStore(f.ctx.path);assert.equal(result.changes_may_be_missing,true);assert.equal(result.recovered_archive_exports,1);assert.equal(restored.tasks[0].id,task.id);assert.equal(restored.tasks[0].armed,false);assert.equal(restored.archives[0].id,archived.archive_id);assert.equal(restored.controls.execution_stopped,true);
});
