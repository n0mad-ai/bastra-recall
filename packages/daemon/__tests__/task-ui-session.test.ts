import "./tasks-opt-in.js";
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer, request} from "node:http";
import {once} from "node:events";
import {dispatchTaskUi} from "../src/task-ui-session.js";
import {ensureLocalTaskAgent} from "../src/task-auto-setup.js";
import {taskClientToken} from "../src/task-client-auth.js";
import {authenticateTask, mintTaskCredential, revokeTaskCredential} from "../src/task-auth.js";
import {setUiEnabled} from "../src/settings.js";
import {callTaskCrud} from "../src/task-service.js";
import {readTaskStore} from "../src/task-store.js";
import {dispatchTaskHttp} from "../src/task-transport.js";
test("tokenless task UI session is local/CSRF-protected Agent access, never Owner authority",async()=>{
 const root=await mkdtemp(join(tmpdir(),"task-ui-session-")),ctx={path:join(root,"tasks.json"),authPath:join(root,"task-auth.json")};const previous=process.env.BASTRA_TASKS_PATH,previousToken=process.env.BASTRA_TASK_TOKEN;process.env.BASTRA_TASKS_PATH=ctx.path;delete process.env.BASTRA_TASK_TOKEN;await setUiEnabled(true);await ensureLocalTaskAgent();
 const agent=await authenticateTask(`Bearer ${taskClientToken()}`,ctx.authPath);const server=createServer((req,res)=>{if(!dispatchTaskUi(req,res,req.method!,req.url!,ctx)&&!dispatchTaskHttp(req,res,req.method!,req.url!,ctx)){res.writeHead(404);res.end();}});server.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const post=async(path:string,body:unknown={},extra:Record<string,string>={})=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",...extra},body:JSON.stringify(body)});
 try{
  assert.equal((await post("/ui/tasks/session",{}, {Origin:"https://foreign.invalid"})).status,403);
  const foreignHost = await new Promise<number>((resolve,reject)=>{const r=request(base+"/ui/tasks/session",{method:"POST",headers:{Host:"foreign.invalid","Content-Type":"application/json"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode!));});r.on("error",reject);r.end("{}");});assert.equal(foreignHost,403);
  const bootstrap=await post("/ui/tasks/session",{}, {Origin:base});assert.equal(bootstrap.status,200);const data=await bootstrap.json() as any;const setCookie=bootstrap.headers.get("set-cookie")!;assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);assert.ok(!JSON.stringify(data).includes(taskClientToken()!));assert.equal(data.role,"agent");const headers={Cookie:setCookie.split(";")[0],"x-bastra-task-csrf":data.csrf,Origin:base};
  assert.equal((await post("/ui/tasks/api/task_status",{}, {Cookie:headers.Cookie})).status,403);
  const input={idempotency_key:"ui",original_request:"Synthetic",goal:"Remind me",resolution_condition:"Done",schedule:{kind:"instant",at:Date.now()+100000},timezone:"Europe/Madrid",scope:{kind:"personal",name:"ui"},owner_domains:["personal"],arm:true,origin:{kind:"user-request",client:"ui",session:"synthetic",context:"Synthetic request"}};
  const made=await post("/ui/tasks/api/task_create",input,headers);assert.equal(made.status,200);const task=await made.json() as any;assert.equal(task.armed,true);
  assert.equal((await post("/ui/tasks/api/task_controls",{execution_stopped:false},headers)).status,403);
  assert.equal((await post("/ui/tasks/api/task_edit",{id:task.id,expected_revision:task.expected_revision,patch:{action_level:"execute"}},headers)).status,403);
  assert.equal((await post("/api/v1/task_status",{},headers)).status,401,"cookie cannot bypass explicit REST auth");
  const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]});process.env.BASTRA_TASK_TOKEN=owner.token;assert.equal((await post("/ui/tasks/session")).status,403,"Owner env is never a tokenless browser grant");delete process.env.BASTRA_TASK_TOKEN;
  const before=await readTaskStore(ctx.path);assert.equal(before.controls.execution_stopped,true);
  await revokeTaskCredential(ctx.authPath,agent.credential_id);assert.equal((await post("/ui/tasks/api/task_status",{},headers)).status,401);
  assert.equal((await post("/ui/tasks/logout",{},headers)).status,200);assert.equal((await post("/ui/tasks/api/task_status",{},headers)).status,401);
  await setUiEnabled(false);assert.equal((await post("/ui/tasks/session")).status,403);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await setUiEnabled(false);if(previous===undefined)delete process.env.BASTRA_TASKS_PATH;else process.env.BASTRA_TASKS_PATH=previous;if(previousToken===undefined)delete process.env.BASTRA_TASK_TOKEN;else process.env.BASTRA_TASK_TOKEN=previousToken;}
});
test("cold archive browsing is read-only, domain-filtered and hash-verified",async()=>{
 const root=await mkdtemp(join(tmpdir(),"task-ui-archive-")),ctx={path:join(root,"tasks.json"),authPath:join(root,"task-auth.json")};const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]}),agent=await mintTaskCredential(ctx.authPath,{actor_id:"agent",role:"agent",domains:["personal"]}),other=await mintTaskCredential(ctx.authPath,{actor_id:"other",role:"agent",domains:["other"]});const auth=`Bearer ${owner.token}`;
 const input={idempotency_key:"archive-ui",original_request:"Synthetic",goal:"Finished",resolution_condition:"Done",schedule:{kind:"instant",at:1000},timezone:"Europe/Madrid",scope:{kind:"personal",name:"ui"},owner_domains:["personal"]};let task=await callTaskCrud(ctx,auth,"task_create",input) as any;await callTaskCrud(ctx,auth,"task_resolve",{id:task.id,expected_revision:task.expected_revision});const before=await readTaskStore(ctx.path);const archive=await callTaskCrud(ctx,auth,"task_archive",{task_ids:[task.id],expected_revision:before.revision,recovery_epoch:before.recovery_epoch}) as any;
 const bytes=await readFile(ctx.path,"utf8");const rows=await callTaskCrud(ctx,`Bearer ${agent.token}`,"task_list",{archive_id:archive.archive_id}) as any;assert.equal(rows.tasks[0].state,"resolved");assert.equal(rows.tasks[0].archived,true);assert.equal(await readFile(ctx.path,"utf8"),bytes);await assert.rejects(callTaskCrud(ctx,`Bearer ${other.token}`,"task_list",{archive_id:archive.archive_id}),{code:"not_found"});
});
