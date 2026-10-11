import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {mintTaskCredential} from "../src/task-auth.js";
import {callTaskCrud} from "../src/task-service.js";
import {readTaskStore} from "../src/task-store.js";
import {observeTaskSources,reconcileTaskTime} from "../src/task-events.js";
import {Vault} from "@bastra-recall/core";
import {assessTaskFreshness,taskMemoryReader} from "../src/task-freshness.js";
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),"task-intake-budget-"))),ctx={path:join(root,"tasks.json"),authPath:join(root,"auth.json"),now:()=>1000};const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]});return{root,ctx,auth:`Bearer ${owner.token}`};}
const source={id:"source",kind:"file",producer_actor:"task-source-reader",owner_domains:["personal"],sensitivity:"private",max_age_ms:1000,enabled:true};
const input={idempotency_key:"budget",original_request:"Watch",goal:"Watch",resolution_condition:"Owner",timezone:"Europe/Madrid",scope:{kind:"personal",name:"fixture"},owner_domains:["personal"],arm:true,schedule:{kind:"event",source_id:"source",predicate:"content-version",expected:"before"}};
test("8193-byte file with an 8-byte task intake limit stays unavailable and never fires",async()=>{
 const f=await fixture();await writeFile(join(f.root,"source.txt"),"x".repeat(8193));await callTaskCrud(f.ctx,f.auth,"task_source_register",{...source,root:f.root,path:"source.txt"});await callTaskCrud(f.ctx,f.auth,"task_create",{...input,budget:{poll_interval_ms:60000,timeout_ms:20,max_source_bytes:8}});await callTaskCrud(f.ctx,f.auth,"task_reconcile",{});
 const s=await readTaskStore(f.ctx.path);assert.equal(s.events.length,0);assert.equal(s.occurrences.length,0);assert.equal(s.tasks[0].last_failure?.code,"source_budget");assert.equal(s.tasks[0].state,"pending");
});
test("shared source uses eligible largest admission and each small consumer independently rejects its cost",async()=>{
 const f=await fixture();await writeFile(join(f.root,"source.txt"),"x".repeat(8193));await callTaskCrud(f.ctx,f.auth,"task_source_register",{...source,root:f.root,path:"source.txt"});
 for(const [id,max] of [["small",8],["large",16384]] as const)await callTaskCrud(f.ctx,f.auth,"task_create",{...input,idempotency_key:id,budget:{poll_interval_ms:60000,timeout_ms:1000,max_source_bytes:max}});
 await observeTaskSources(f.ctx);await assessTaskFreshness(f.ctx);await reconcileTaskTime(f.ctx);const s=await readTaskStore(f.ctx.path);assert.equal(s.events[0].observation_bytes,8193);assert.equal(s.occurrences.length,1);assert.equal(s.tasks[0].verification?.outcome,"unavailable");assert.equal(s.tasks[0].verification?.reason,"source_budget");assert.equal(s.occurrences[0].task_id,s.tasks[1].id);
});
test("memory byte limit and smaller timeout forbid a late result from journaling or firing",async()=>{
 for(const timeout of [false,true]){const f=await fixture();const ctx={...f.ctx,memoryRead:async(_id:string,budget?:{max_bytes:number;timeout_ms:number})=>{assert.equal(budget?.max_bytes,timeout?16384:8);assert.equal(budget?.timeout_ms,timeout?5:1000);if(timeout)await new Promise(r=>setTimeout(r,60));return{id:"note",raw:"x".repeat(8193),body:"fixture",revision:"v2",sensitivity:"private"};}};
 await callTaskCrud(ctx,f.auth,"task_source_register",{...source,kind:"memory",memory_id:"note"});await callTaskCrud(ctx,f.auth,"task_create",{...input,budget:{poll_interval_ms:60000,timeout_ms:timeout?5:1000,max_source_bytes:timeout?16384:8}});await observeTaskSources(ctx);await new Promise(r=>setTimeout(r,70));await assessTaskFreshness(ctx);await reconcileTaskTime(ctx);const s=await readTaskStore(ctx.path);assert.equal(s.events.length,0);assert.equal(s.occurrences.length,0);assert.equal(s.tasks[0].last_failure?.code,timeout?"source_timeout":"source_budget");}
});
test("Git OID output cannot bypass an eight-byte admission limit",async()=>{
 const f=await fixture(),repo=join(f.root,"repo");await mkdir(repo);execFileSync("git",["init","-b","fixture",repo]);execFileSync("git",["-C",repo,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-m","fixture"]);await callTaskCrud(f.ctx,f.auth,"task_source_register",{...source,kind:"git",root:repo,ref:"refs/heads/fixture"});await callTaskCrud(f.ctx,f.auth,"task_create",{...input,schedule:{...input.schedule,predicate:"git-ref"},budget:{poll_interval_ms:60000,timeout_ms:20,max_source_bytes:8}});await observeTaskSources(f.ctx);await assessTaskFreshness(f.ctx);await reconcileTaskTime(f.ctx);const s=await readTaskStore(f.ctx.path);assert.equal(s.events.length,0);assert.equal(s.occurrences.length,0);assert.equal(s.tasks[0].last_failure?.code,"source_budget");
});

test("actual Memory locator reports its byte limit rather than generic unavailability",async()=>{
 const f=await fixture(),vaultPath=join(f.root,"vault");await mkdir(vaultPath);await writeFile(join(vaultPath,"note.md"),"---\nid: note\ntitle: Fixture\ntype: reference\nsummary: Fixture\n---\n"+"x".repeat(1024));
 const vault=new Vault(vaultPath);await vault.init();try{
 const ctx={...f.ctx,memoryRead:taskMemoryReader({vault,vaultPath})};await callTaskCrud(ctx,f.auth,"task_source_register",{...source,kind:"memory",memory_id:"note"});await callTaskCrud(ctx,f.auth,"task_create",{...input,budget:{poll_interval_ms:60000,timeout_ms:1000,max_source_bytes:8}});await observeTaskSources(ctx);const s=await readTaskStore(ctx.path);assert.equal(s.tasks[0].last_failure?.code,"source_budget");assert.equal(s.tasks[0].last_failure?.message,"Quell-Bytegrenze überschritten");assert.equal(s.events.length,0);assert.equal(s.occurrences.length,0);
 }finally{await vault.stop();}
});
