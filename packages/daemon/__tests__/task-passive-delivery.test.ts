import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { startProactiveTaskJob } from "../src/daemon-jobs.js";
import { installTaskHttpProjection, finalizeTaskMcp } from "../src/task-delivery.js";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-passive-")); const vaultPath = join(root, "vault"); await mkdir(vaultPath);
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "task-auth.json"), now: () => 3000 };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const input = { idempotency_key: "fixture", original_request: "Evaluate after seven days", goal: "Evaluate", resolution_condition: "Owner evaluation", schedule: { kind: "instant", at: 2000 }, timezone: "Europe/Madrid", scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"], arm: true };
  await callTaskCrud(ctx, `Bearer ${owner.token}`, "task_create", input); const job = startProactiveTaskJob(ctx); await job.runtime.ready;
  return { root, ctx, owner, agent, job, vaultPath };
}
async function closeServer(server: ReturnType<typeof createServer>) { await new Promise<void>(resolve => server.close(() => resolve())); }
test("successful HTTP replies attach authenticated cached due work; legacy/errors stay unchanged", async () => {
  const f = await fixture(); const server = createServer((req, res) => {
    installTaskHttpProjection(req, res, f.ctx); res.setHeader("Content-Type", "application/json");
    res.writeHead(req.url?.includes("fail") ? 400 : 200); const body = req.url?.includes("fail") ? '{"error":"fixture"}' : '{"ok":true}';
    res.setHeader("Content-Length", Buffer.byteLength(body)); res.end(body);
  }); server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    assert.deepEqual(await (await fetch(base + "/api/v1/fixture")).json(), { ok: true });
    const headers = { "x-bastra-task-authorization": `Bearer ${f.agent.token}` };
    const response = await fetch(base + "/api/v1/fixture", { headers }); const body = await response.json() as any;
    assert.equal(body.proactive_due.cards.length, 1); assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(JSON.stringify(body))));
    assert.deepEqual(await (await fetch(base + "/api/v1/fail", { headers })).json(), { error: "fixture" });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].acknowledgement, undefined);
  } finally { await closeServer(server); f.job.stop(); await f.job.runtime.settle(); }
});
test("MCP success finalizer adds a stable due block, errors cannot become success", async () => {
  const f = await fixture(); try {
    const result = await finalizeTaskMcp({ content: [{ type: "text", text: "fixture" }] }, f.ctx, `Bearer ${f.agent.token}`, "mcp-session");
    assert.equal(result.content.length, 2); assert.match(result.content[1].text, /bastra-due/);
    const failure = { isError: true, content: [{ type: "text", text: "fixture error" }] };
    assert.deepEqual(await finalizeTaskMcp(failure, f.ctx, `Bearer ${f.agent.token}`), failure);
  } finally { f.job.stop(); await f.job.runtime.settle(); }
});
test("real session assembler and ongoing prompt deliver with mapped credentials, never acknowledge", async () => {
  const f = await fixture(); const previous = process.env.BASTRA_TASKS_PATH; process.env.BASTRA_TASKS_PATH = f.ctx.path;
  const vault = new Vault(f.vaultPath); await vault.init(); const search = new SearchIndex(vault); search.start(); const telemetry = new Telemetry();
  const handle = await startHttpServer({ port: 0, vault, search, telemetry, version: "fixture", toolDeps: { vault, search, telemetry, vaultPath: f.vaultPath }, documentWriteEnabled: false, embedding: { on: false, providerId: null, source: "none" }, origin: { startedBy: "direct", envOrigin: "own", configFingerprint: "0123456789ab" } });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    for (const route of ["session-context", "prompt", "session"]) {
      const payload = { session_id: `session-${route}`, prompt: "fixture", hook_event_name: route === "prompt" ? "UserPromptSubmit" : "SessionStart", source: "startup", cwd: f.vaultPath };
      const response = await fetch(`${base}/hook/${route}`, { method: "POST", headers: { "Content-Type": "application/json", "x-bastra-task-authorization": `Bearer ${f.owner.token}` }, body: JSON.stringify(route === "session-context" ? { session_id: payload.session_id, budget: { tokens: 4096 } } : { payload }) });
      const body = await response.json() as any; const text = body.context ?? body.hookSpecificOutput?.additionalContext ?? "";
      assert.match(text, /bastra-due/, route);
      if (route === "session-context") assert.ok(body.blocks.some((b:any) => b.kind === "due" && b.included));
    }
    const untrusted = await (await fetch(`${base}/hook/session-context`)).json() as any; assert.ok(!untrusted.context.includes("bastra-due"));
    const s = await readTaskStore(f.ctx.path); assert.equal(s.tasks[0].state, "due"); assert.equal(s.occurrences[0].acknowledgement, undefined);
  } finally { await handle.close(); search.stop(); await vault.stop(); f.job.stop(); await f.job.runtime.settle(); if (previous === undefined) delete process.env.BASTRA_TASKS_PATH; else process.env.BASTRA_TASKS_PATH = previous; }
});

test("compiled bridge catches up and attaches cards to ordinary replies with dedicated auth", async () => {
  const f = await fixture(); f.job.stop(); await f.job.runtime.settle();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/bridge.js", import.meta.url))], {
    env: { ...process.env, BASTRA_VAULT_PATH: f.vaultPath, BASTRA_TASKS_PATH: f.ctx.path, BASTRA_TASK_TOKEN: f.owner.token, BASTRA_VAULT_RECONCILE_MS: "0", BASTRA_EMBEDDING: "off" }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    let output = ""; let ready = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { ready += chunk; });
    const deadline = Date.now() + 10000;
    while (!ready.includes("ready") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(ready, /ready/);
    // Ready is not a task job barrier; the client contact also queues catch-up.
    for (let id = 1; id <= 50 && !output.includes("proactive_due"); id++) {
      child.stdin.write(JSON.stringify({ id, method: "vault_status" }) + "\n");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const reply = output.trim().split("\n").map(line => JSON.parse(line)).find(row => row.proactive_due);
    assert.equal(reply.result.size, 0); assert.equal(reply.proactive_due.cards.length, 1);
    assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].acknowledgement, undefined);
  } finally { child.kill(); await once(child, "exit"); }
});
