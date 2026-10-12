import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, unlink, chmod, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalTaskAgent, taskAgentAccessStatus } from "../src/task-auto-setup.js";
import { authenticateTask, mintTaskCredential, revokeTaskCredential } from "../src/task-auth.js";
import { taskClientToken, taskHookConfigPath } from "../src/task-client-auth.js";
async function isolated(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "task-auto-"));
  const keys = ["BASTRA_TASKS_PATH", "BASTRA_TASK_TOKEN", "BASTRA_CONVERSATIONAL_REMINDERS"];
  const old = keys.map(k => process.env[k]); process.env.BASTRA_TASKS_PATH = join(root, "tasks.json"); delete process.env.BASTRA_TASK_TOKEN; delete process.env.BASTRA_CONVERSATIONAL_REMINDERS;
  try { await fn(root); } finally { keys.forEach((k,i) => old[i] === undefined ? delete process.env[k] : process.env[k] = old[i]); }
}
test("automatic local agent setup is private, concurrent, stable and never an Owner", async () => isolated(async root => {
  const results = await Promise.all([ensureLocalTaskAgent(), ensureLocalTaskAgent()]); assert.ok(results.every(r => r.configured));
  const token = taskClientToken()!; const auth = join(root, "task-auth.json");
  const principal = await authenticateTask(`Bearer ${token}`, auth); assert.equal(principal.role, "agent"); assert.deepEqual(principal.domains, ["personal"]);
  assert.equal((await stat(taskHookConfigPath())).mode & 0o077, 0);
  const before = await readFile(taskHookConfigPath(), "utf8"); await ensureLocalTaskAgent(); assert.equal(await readFile(taskHookConfigPath(), "utf8"), before);
  await revokeTaskCredential(auth, principal.credential_id); assert.equal((await ensureLocalTaskAgent()).configured, false); assert.equal(await readFile(taskHookConfigPath(), "utf8"), before);
}));
test("upgrade uses single Owner domains, preserves unsafe configs and explicit overrides", async () => isolated(async root => {
  const auth = join(root, "task-auth.json"); await mintTaskCredential(auth, { actor_id: "owner", role: "owner", domains: ["project"] });
  await ensureLocalTaskAgent(); assert.deepEqual((await authenticateTask(`Bearer ${taskClientToken()}`, auth)).domains, ["project"]);
  await chmod(taskHookConfigPath(), 0o644); const bytes = await readFile(taskHookConfigPath(), "utf8");
  assert.equal((await ensureLocalTaskAgent()).reason, "existing-config-unsafe"); assert.equal(await readFile(taskHookConfigPath(), "utf8"), bytes);
  process.env.BASTRA_TASK_TOKEN = "invalid"; assert.equal((await ensureLocalTaskAgent()).reason, "explicit-override");
}));
test("disabled and multi-owner installations do not get silent new access", async () => isolated(async root => {
  process.env.BASTRA_CONVERSATIONAL_REMINDERS = "0"; assert.equal((await ensureLocalTaskAgent()).reason, "disabled");
  await assert.rejects(stat(taskHookConfigPath()), { code: "ENOENT" }); delete process.env.BASTRA_CONVERSATIONAL_REMINDERS;
  for (const actor_id of ["one", "two"]) await mintTaskCredential(join(root, "task-auth.json"), { actor_id, role: "owner", domains: [actor_id] });
  assert.equal((await ensureLocalTaskAgent()).configured, false); await assert.rejects(stat(taskHookConfigPath()), { code: "ENOENT" });
}));

test("real upgraded daemon needs no setup command and preserves client configuration across restarts", async () => {
  const { spawn } = await import("node:child_process"), { createServer } = await import("node:net"), { fileURLToPath } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "task-auto-process-")), vault = join(root, "vault"), data = join(root, "data"); await mkdir(vault); await mkdir(data);
  const config = join(root, "foreign-client-settings.json"), sentinel = '{"mcpServers":{"foreign":{"command":"synthetic"}},"hooks":{"keep":true}}'; await writeFile(config, sentinel);
  let child: ReturnType<typeof spawn> | undefined, closed: Promise<any> | undefined, base = "";
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; child = undefined; };
  const start = async () => {
    const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const port = (probe.address() as any).port; await new Promise<void>(r => probe.close(() => r())); assert.notEqual(port, 6723); base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { ...process.env, BASTRA_TASKS_PATH: join(data,"tasks.json"), BASTRA_VAULT_PATH: vault, BASTRA_HTTP_PORT: String(port), BASTRA_DAEMON_URL: base, BASTRA_AUTO_UPDATE: "0", BASTRA_EMBEDDING_PROVIDER: "none", BASTRA_BM25_ONLY: "1", BASTRA_PENDING_RELAY: "0" }; delete env.BASTRA_TASK_TOKEN; delete env.BASTRA_CONVERSATIONAL_REMINDERS;
    child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../../../scripts/test-env.mjs", import.meta.url)), fileURLToPath(new URL("../dist/index.js", import.meta.url))], { env, stdio: ["pipe","ignore","pipe"] }); closed = once(child, "close"); let errors = ""; child.stderr!.on("data", c => { errors = (errors+c).slice(-2000); });
    const until = Date.now()+15000; while (Date.now()<until) { try { if ((await fetch(base+"/health")).ok) return; } catch {} await pause(25); } throw new Error(errors || "own daemon did not start");
  };
  try {
    await start(); const credential = JSON.parse(await readFile(join(data,"task-hook-token.json"),"utf8"));
    const call = async (name: string, input: unknown) => { const response = await fetch(base+`/api/v1/task_${name}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${credential.token}`},body:JSON.stringify(input)}); const body = await response.json() as any; assert.equal(response.status,200,JSON.stringify(body)); return body; };
    const task = await call("create",{idempotency_key:"automatic",original_request:"Synthetic upgrade deadline",goal:"Evaluate synthetic run",resolution_condition:"Done",schedule:{kind:"instant",at:Date.now()-1},timezone:"Europe/Madrid",scope:{kind:"personal",name:"upgrade"},owner_domains:["personal"],arm:true,origin:{kind:"agent-observed",client:"automatic-test",session:"synthetic",context:"Promised synthetic follow-up"}}); assert.equal(task.armed,true);
    const waitOccurrence = async (id: string, delivered = false) => {
      const until = Date.now()+10000;
      while(Date.now()<until){ const snapshot=JSON.parse(await readFile(join(data,"tasks.json"),"utf8")); const occurrence=snapshot.occurrences.find((o:any)=>o.task_id===id);if(occurrence&&(!delivered||occurrence.attempts.length))return occurrence;await pause(25); }
      throw new Error("own occurrence/delivery deadline");
    };
    await waitOccurrence(task.id); await pause(100);
    const assembly=await fetch(base+"/hook/session-context",{method:"POST",headers:{"Content-Type":"application/json","x-bastra-task-authorization":`Bearer ${credential.token}`},body:JSON.stringify({assembly_only:true,session_id:"synthetic-session",budget:{tokens:4096}})});
    assert.ok(!(await assembly.text()).includes("bastra-due"));assert.equal((await waitOccurrence(task.id)).attempts.length,0,"internal assembly records no delivery");
    const hookEnv:NodeJS.ProcessEnv={...process.env,BASTRA_TASKS_PATH:join(data,"tasks.json"),BASTRA_VAULT_PATH:vault,BASTRA_DAEMON_URL:base,BASTRA_UPDATE_CHECK:"off"};delete hookEnv.BASTRA_TASK_TOKEN;
    const hook=spawn(process.execPath,[fileURLToPath(new URL("../dist/session-hook.js",import.meta.url))],{env:hookEnv,stdio:["pipe","pipe","pipe"]});let output="",hookError="";hook.stdout.on("data",c=>{output+=c;});hook.stderr.on("data",c=>{hookError+=c;});hook.stdin.end(JSON.stringify({hook_event_name:"SessionStart",session_id:"synthetic-session",cwd:vault}));assert.equal((await once(hook,"close"))[0],0,hookError);
    assert.match(output,/bastra-due/);assert.match(output,/Evaluate synthetic run/);assert.equal((output.match(/<bastra-due/g)||[]).length,1);
    const delivered=await waitOccurrence(task.id,true);assert.equal(delivered.attempts.reduce((n:number,a:any)=>n+(a.count??1),0),1);assert.equal(delivered.acknowledgement,undefined);
    const mcpTask=await call("create",{idempotency_key:"automatic-mcp",original_request:"Synthetic MCP reminder",goal:"MCP automatic reminder",resolution_condition:"Done",schedule:{kind:"instant",at:Date.now()-1},timezone:"Europe/Madrid",scope:{kind:"personal",name:"upgrade"},owner_domains:["personal"],arm:true,origin:{kind:"agent-observed",client:"automatic-test",session:"mcp",context:"Promised MCP follow-up"}});await waitOccurrence(mcpTask.id);await pause(100);
    const client=new Client({name:"synthetic-session-test",version:"fixture"});const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../dist/mcp-forwarder.js",import.meta.url))],env:Object.fromEntries(Object.entries(hookEnv).filter((pair):pair is [string,string]=>typeof pair[1]==="string")),stderr:"pipe"});
    try {await client.connect(transport);const result=await client.callTool({name:"task_status",arguments:{}});const text=(result.content as Array<{text?:string}>).map(c=>c.text??"").join("\n");assert.match(text,/bastra-due/);assert.match(text,/MCP automatic reminder/);assert.equal((text.match(/<bastra-due/g)||[]).length,1);assert.equal((await waitOccurrence(mcpTask.id,true)).attempts.reduce((n:number,a:any)=>n+(a.count??1),0),1);}finally{await client.close();}
    const status = await call("status",{}); assert.equal(status.role,"agent"); assert.equal(status.controls.execution_stopped,true); assert.equal(status.approval.configured,false);
    await stop(); await start(); assert.equal(JSON.parse(await readFile(join(data,"task-hook-token.json"),"utf8")).token,credential.token); assert.equal((await call("get",{id:task.id})).id,task.id);
    assert.equal(await readFile(config,"utf8"),sentinel);
  } finally { await stop(); }
});

test("missing managed token retires former automatic access; unsafe file is visible in normal status", async () => isolated(async root => {
  await ensureLocalTaskAgent(); const token = taskClientToken()!; await authenticateTask(`Bearer ${token}`,join(root,"task-auth.json"));
  await unlink(taskHookConfigPath()); await ensureLocalTaskAgent(); assert.notEqual(taskClientToken(),token);
  await assert.rejects(authenticateTask(`Bearer ${token}`,join(root,"task-auth.json")),{code:"unauthorized"});
  await chmod(taskHookConfigPath(),0o644); await ensureLocalTaskAgent(); const {taskAttachment}=await import("../src/task-delivery.js"); const ctx={path:join(root,"tasks.json"),authPath:join(root,"task-auth.json")};
  const warning=await taskAttachment(ctx,undefined,"access-fixture","prompt");assert.match(warning?.text??"",/Karten bleiben stumm/);assert.equal(await taskAttachment(ctx,undefined,"access-fixture","prompt"),undefined);
  const access=await taskAgentAccessStatus(); assert.equal(access.authorized,false); assert.match(access.hint,/stumm/);
  const {callTaskCrud}=await import("../src/task-service.js"); const owner=await mintTaskCredential(join(root,"task-auth.json"),{actor_id:"owner",role:"owner",domains:["personal"]});
  const status=await callTaskCrud({path:join(root,"tasks.json"),authPath:join(root,"task-auth.json")},`Bearer ${owner.token}`,"task_status",{}) as any;assert.equal(status.agent_access.reason,"unsafe-or-corrupt");
}));

test("hookless forwarder session context authenticates from private token file without env token", async () => isolated(async root => {
  const {createServer}=await import("node:http"); const {spawn}=await import("node:child_process"); const {fileURLToPath}=await import("node:url");
  await ensureLocalTaskAgent(); const token=taskClientToken()!; let authorization:string|undefined;
  const server=createServer((req,res)=>{authorization=req.headers["x-bastra-task-authorization"] as string|undefined;res.setHeader("Content-Type","application/json");res.end(JSON.stringify({context:authorization===`Bearer ${token}`?"<bastra-due>synthetic card</bastra-due>":"no private cards"}));});server.listen(0,"127.0.0.1");await once(server,"listening");
  try { const modulePath=fileURLToPath(new URL("../dist/mcp-forwarder-calls.js",import.meta.url));const child=spawn(process.execPath,["--input-type=module","-e",`const m=await import(${JSON.stringify(modulePath)});console.log(JSON.stringify(await m.maybeSessionContextItem()));`],{env:{...process.env,BASTRA_DAEMON_URL:`http://127.0.0.1:${(server.address() as any).port}`,BASTRA_MCP_SESSION_CONTEXT:"1"},stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",c=>{out+=c;});child.stderr.on("data",c=>{err+=c;});const [code]=await once(child,"close");assert.equal(code,0,err);assert.match(out,/synthetic card/);assert.equal(authorization,`Bearer ${token}`);
  } finally { await new Promise<void>(r=>server.close(()=>r())); }
}));
