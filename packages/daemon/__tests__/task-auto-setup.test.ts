import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalTaskAgent } from "../src/task-auto-setup.js";
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
  const { spawn } = await import("node:child_process"), { once } = await import("node:events"), { createServer } = await import("node:net"), { fileURLToPath } = await import("node:url");
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
    const status = await call("status",{}); assert.equal(status.role,"agent"); assert.equal(status.controls.execution_stopped,true); assert.equal(status.approval.configured,false);
    await stop(); await start(); assert.equal(JSON.parse(await readFile(join(data,"task-hook-token.json"),"utf8")).token,credential.token); assert.equal((await call("get",{id:task.id})).id,task.id);
    assert.equal(await readFile(config,"utf8"),sentinel);
  } finally { await stop(); }
});
