import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { taskValueHash, reconcileTaskTime, evaluateTaskSnapshot } from "../src/task-events.js";
import { assessTaskFreshness } from "../src/task-freshness.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-auto-resolution-")); let now = 1000;
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", role: "owner", domains: ["personal"] });
  const auth = `Bearer ${owner.token}`, raw = "Expected completed artifact";
  const evidencePath = join(root, "result.txt"); await writeFile(evidencePath, raw);
  await callTaskCrud(ctx, auth, "task_source_register", { id: "result", kind: "file", producer_actor: "task-source-reader", root, path: "result.txt", owner_domains: ["personal"], sensitivity: "private", enabled: true, max_age_ms: 1000 });
  const revision = taskValueHash(raw);
  const input = { idempotency_key: "resolve", original_request: "Check completed artifact", goal: "Check", resolution_condition: "Human text is not parsed", scope: { kind: "personal", name: "resolution" }, timezone: "UTC", schedule: { kind: "instant", at: 2000 }, owner_domains: ["personal"], arm: true,
    auto_resolve: { verifier_id: "bound-evidence-v1" }, evidence: [{ source_id: "result", id: "result", revision, hash: revision, observed_at: 1000, state_updated_at: 1000, max_age_ms: 1000, provenance: "attributable" }] };
  return { ctx, auth, input, evidencePath, advance: (at: number) => { now = at; } };
}

test("explicit registered evidence resolution requires exact fresh verified evidence and keeps audit", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_create", f.input);
  await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx); await reconcileTaskTime(f.ctx);
  const store = await readTaskStore(f.ctx.path);
  assert.equal(store.tasks[0].state, "resolved"); assert.equal(store.tasks[0].armed, false);
  assert.equal(store.tasks[0].history.filter(h => h.operation === "evidence-resolve").length, 1);
  assert.equal(store.tasks[0].verification?.outcome, "verified");
});

test("stale unavailable revised future or contested evidence never auto-resolves", async () => {
  for (const reason of ["stale", "missing", "revised", "future", "contested"] as const) {
    const f = await fixture();
    if (reason === "future") f.input.evidence[0].state_updated_at = 2000;
    if (reason === "contested") f.input.evidence[0].provenance = "contested";
    await callTaskCrud(f.ctx, f.auth, "task_create", f.input);
    if (reason === "stale") f.advance(3000);
    if (reason === "missing") await unlink(f.evidencePath);
    if (reason === "revised") await writeFile(f.evidencePath, "Different artifact");
    await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx);
    const store = await readTaskStore(f.ctx.path);
    assert.notEqual(store.tasks[0].verification?.outcome, "verified", reason);
    assert.notEqual(store.tasks[0].state, "resolved", reason);
  }
});

test("refuted cached verification is not completion; descriptive resolution text alone never resolves", async () => {
  const f = await fixture(); const { auto_resolve: _policy, ...plain } = f.input;
  await callTaskCrud(f.ctx, f.auth, "task_create", plain);
  await assessTaskFreshness(f.ctx);
  const snapshot = await readTaskStore(f.ctx.path);
  snapshot.tasks[0].auto_resolve = f.input.auto_resolve as any;
  snapshot.tasks[0].verification!.outcome = "refuted";
  evaluateTaskSnapshot(snapshot, 1000);
  assert.notEqual(snapshot.tasks[0].state, "resolved");
  const g = await fixture(); const { auto_resolve: _, ...without } = g.input;
  await callTaskCrud(g.ctx, g.auth, "task_create", without);
  await assessTaskFreshness(g.ctx); await reconcileTaskTime(g.ctx);
  assert.equal((await readTaskStore(g.ctx.path)).tasks[0].state, "pending");
});

test("automatic evidence resolution rejects unsupported verifier, empty evidence and recurring reuse", async () => {
  const f = await fixture();
  for (const patch of [{ auto_resolve: { verifier_id: "shell" } }, { evidence: [] }, { recurrence: { kind: "elapsed", interval: 1000, catch_up: "latest" } }])
    await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, ...patch }));
});

test("pausing during an async evidence read discards that result and resume can complete", async () => {
  const f = await fixture(); let pauseDuringRead = true;
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { id: "memory-result", kind: "memory", memory_id: "result", producer_actor: "task-source-reader", owner_domains: ["personal"], sensitivity: "private", enabled: true, max_age_ms: 1000 });
  const reference = { ...f.input.evidence[0], source_id: "memory-result", revision: "v1", hash: undefined };
  const task = await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, evidence: [reference] }) as any;
  const ctx = { ...f.ctx, memoryRead: async () => {
    if (pauseDuringRead) {
      pauseDuringRead = false;
      const current = await callTaskCrud(f.ctx, f.auth, "task_get", { id: task.id }) as any;
      await callTaskCrud(f.ctx, f.auth, "task_pause", { id: task.id, expected_revision: current.expected_revision });
    }
    return { id: "result", revision: "v1", raw: "result", body: "result", sensitivity: "private" };
  } };
  await assessTaskFreshness(ctx);
  let current = await callTaskCrud(ctx, f.auth, "task_get", { id: task.id }) as any;
  assert.equal(current.paused, true); assert.equal(current.verification, undefined);
  await callTaskCrud(ctx, f.auth, "task_resume", { id: task.id, expected_revision: current.expected_revision });
  await assessTaskFreshness(ctx);
  current = await callTaskCrud(ctx, f.auth, "task_get", { id: task.id });
  assert.equal(current.state, "resolved");
});
