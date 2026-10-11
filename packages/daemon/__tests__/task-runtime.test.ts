import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { startProactiveTaskJob } from "../src/daemon-jobs.js";
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
async function waitFor(check: () => Promise<boolean>, timeout = 10000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("isolated task job did not reach expected state");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-runtime-")); let now = 1000;
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const auth = `Bearer ${owner.token}`;
  const input = { idempotency_key: "fixture", original_request: "Evaluate the run", goal: "Evaluate", resolution_condition: "Owner evaluation",
    schedule: { kind: "instant", at: 2000 }, timezone: "Europe/Madrid", scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"], arm: true };
  return { root, ctx, auth, input, setNow: (v: number) => { now = v; } };
}
test("daemon job startup catches up a persisted due task, manual/automatic races fire once", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_create", f.input); f.setNow(3000);
  const job = startProactiveTaskJob(f.ctx, 10);
  try {
    await job.runtime.ready;
    await Promise.all([job.runtime.tick(), callTaskCrud(f.ctx, f.auth, "task_reconcile", {})]);
    assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
  } finally { job.stop(); await job.runtime.settle(); }
});
test("empty/unarmed jobs do no periodic I/O; contact catches a new deadline before polling cadence", async () => {
  const f = await fixture(); const job = startProactiveTaskJob(f.ctx, 10);
  try {
    await job.runtime.ready; const reads = job.runtime.reads;
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(job.runtime.reads, reads);
    await assert.rejects(stat(f.ctx.path), { code: "ENOENT" });
    await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, arm: false });
    await new Promise(resolve => setTimeout(resolve, 50)); const before = await readFile(f.ctx.path, "utf8");
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(await readFile(f.ctx.path, "utf8"), before);
    let t = await callTaskCrud(f.ctx, f.auth, "task_get", { id: (await readTaskStore(f.ctx.path)).tasks[0].id }) as any;
    await callTaskCrud(f.ctx, f.auth, "task_review", { id: t.id, expected_revision: t.expected_revision });
    f.setNow(2000); job.runtime.contact(); await waitFor(async () => (await readTaskStore(f.ctx.path)).occurrences.length === 1);
  } finally { job.stop(); await job.runtime.settle(); }
});
test("source polling is automatic; failed check backs off and does not block a clock task", async () => {
  const f = await fixture(); await writeFile(join(f.root, "artifact.txt"), "A");
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { id: "source", kind: "file", producer_actor: "task-source-reader", owner_domains: ["personal"], sensitivity: "private", max_age_ms: 1000, enabled: true, root: f.root, path: "artifact.txt" });
  const watched = await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "content-version", expected: "A" } }) as any;
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, idempotency_key: "clock" });
  const job = startProactiveTaskJob(f.ctx, 10);
  try {
    await job.runtime.ready; assert.equal((await readTaskStore(f.ctx.path)).events.length, 1);
    await writeFile(join(f.root, "artifact.txt"), "B"); f.setNow(61000); await job.runtime.tick();
    await waitFor(async () => (await readTaskStore(f.ctx.path)).occurrences.filter(o => o.task_id === watched.id).length === 1);
    const { unlink } = await import("node:fs/promises"); await unlink(join(f.root, "artifact.txt"));
    f.setNow(121000); await job.runtime.tick(); await waitFor(async () => job.runtime.checks.get(watched.id)?.backoff === 60000);
    const unchanged = await readFile(f.ctx.path, "utf8"); f.setNow(122000); await job.runtime.tick(); assert.equal(await readFile(f.ctx.path, "utf8"), unchanged);
    f.setNow(181000); await job.runtime.tick(); await waitFor(async () => job.runtime.checks.get(watched.id)?.backoff === 120000);
    assert.ok((await readTaskStore(f.ctx.path)).occurrences.some(o => o.task_id !== watched.id));
  } finally { job.stop(); await job.runtime.settle(); }
});
test("real isolated daemon catches up due data on startup with no task_reconcile request", async () => {
  const f = await fixture(); const vault = join(f.root, "vault"); await mkdir(vault);
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "instant", at: Date.now() - 1000 } });
  const portServer = createServer(); portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>(resolve => portServer.close(() => resolve())); assert.notEqual(port, 6723);
  const child = spawn(process.execPath, ["--import", "./scripts/test-env.mjs", "packages/daemon/dist/index.js"], {
    cwd: REPO, env: { ...process.env, BASTRA_VAULT_PATH: vault, BASTRA_TASKS_PATH: f.ctx.path, BASTRA_HTTP_PORT: String(port), BASTRA_DAEMON_URL: `http://127.0.0.1:${port}`, BASTRA_AUTO_UPDATE: "0", BASTRA_EMBEDDING_PROVIDER: "none", BASTRA_BM25_ONLY: "1" }, stdio: ["pipe", "ignore", "pipe"],
  });
  let errors = ""; child.stderr!.on("data", chunk => { errors = (errors + chunk.toString()).slice(-4000); });
  const closed = once(child, "close");
  try {
    await waitFor(async () => (await readTaskStore(f.ctx.path)).occurrences.length === 1);
    const store = await readTaskStore(f.ctx.path); assert.equal(store.tasks[0].state, "due"); assert.equal(store.occurrences[0].attempts.length, 0);
  } catch (error) { throw new Error(`${(error as Error).message}; isolated daemon: ${errors}`); }
  finally { child.kill("SIGTERM"); await closed; }
});
