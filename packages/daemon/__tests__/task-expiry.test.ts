import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential, authenticateTask } from "../src/task-auth.js";
import { callTaskCrud, type TaskCrudOperation } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { reconcileTaskTime } from "../src/task-events.js";
import { taskDueInput, taskDueProjection } from "../src/task-outbox.js";
import { startTaskRuntime } from "../src/task-runtime.js";
import { notifyDueTasks } from "../src/task-notification.js";
import { friendlyTaskCreate } from "../src/cli/task-friendly.js";
import { validateTaskProposal } from "../src/task-actions.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-expiry-")); let now = 1000;
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", role: "agent", domains: ["personal"] });
  const auth = `Bearer ${agent.token}`;
  const call = (op: string, input: unknown = {}) => callTaskCrud(ctx, auth, op as TaskCrudOperation, input) as Promise<any>;
  const input = { idempotency_key: "expiry", original_request: "Check before validity ends", goal: "Check", resolution_condition: "Done", scope: { kind: "personal", name: "expiry" }, timezone: "UTC", schedule: { kind: "instant", at: 2000 }, arm: true, origin: { kind: "user-request", client: "test", session: "expiry", context: "Check" } };
  return { ctx, auth, call, input, advance: (at: number) => { now = at; }, mutate: (task: any, op: string, extra = {}) => call(op, { id: task.id, expected_revision: task.expected_revision, ...extra }) };
}

test("optional validity expires exactly once and remains durably deliverable after restart", async () => {
  const f = await fixture(); let task = await f.call("task_create", { ...f.input, expires_at: 3000 });
  f.advance(2000); await reconcileTaskTime(f.ctx);
  assert.equal((await f.call("task_get", { id: task.id })).state, "due");
  f.advance(2999); await reconcileTaskTime(f.ctx);
  assert.equal((await f.call("task_get", { id: task.id })).state, "due");
  f.advance(3000); await reconcileTaskTime(f.ctx); await reconcileTaskTime(f.ctx);
  task = await f.call("task_get", { id: task.id });
  assert.equal(task.state, "expired"); assert.equal(task.armed, false);
  let store = await readTaskStore(f.ctx.path);
  assert.equal(store.occurrences.filter(o => o.kind === "expired").length, 1);
  assert.equal(store.tasks[0].history.at(-1)?.operation, "expire");
  const principal = await authenticateTask(f.auth, f.ctx.authPath);
  const projection = taskDueProjection(store, principal, taskDueInput.parse({ max_bytes: 16384 }), 3000, true);
  assert.equal(projection.cards.length, 1); assert.equal(projection.cards[0].state, "expired");
  const due = await f.call("task_due", { max_bytes: 16384 });
  assert.equal(due.cards[0].state, "expired");
  task = await f.mutate(task, "task_acknowledge", { occurrence_id: due.cards[0].occurrence_id });
  assert.equal(task.state, "expired"); assert.equal(task.armed, false);
  store = await readTaskStore(f.ctx.path);
  assert.ok(store.occurrences.find(o => o.kind === "expired")?.acknowledgement);
  await assert.rejects(f.mutate(task, "task_resolve"), { code: "conflict" });
  const archived = await f.call("task_archive", { task_ids: [task.id], expected_revision: store.revision, recovery_epoch: store.recovery_epoch });
  assert.ok(archived.archive_id);
});

test("without validity end a due task survives arbitrary elapsed time", async () => {
  const f = await fixture(); const task = await f.call("task_create", f.input);
  f.advance(2_000_000_000); await reconcileTaskTime(f.ctx);
  assert.equal((await f.call("task_get", { id: task.id })).state, "due");
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});

test("validity outranks snooze and paused-only runtimes still process expiry", async () => {
  const f = await fixture(); let task = await f.call("task_create", { ...f.input, expires_at: 3000 });
  task = await f.mutate(task, "task_snooze", { until: 9000 });
  task = await f.mutate(task, "task_pause");
  const runtime = startTaskRuntime(f.ctx); await runtime.ready;
  try {
    assert.equal(runtime.hasWork, true);
    f.advance(5000); await runtime.tick();
    const current = await f.call("task_get", { id: task.id });
    assert.equal(current.state, "expired"); assert.equal(current.snoozed_until, undefined);
  } finally { runtime.stop(); await runtime.settle(); }
});

test("expired notification is submitted once and does not become a read receipt", async () => {
  const f = await fixture(); const task = await f.call("task_create", { ...f.input, expires_at: 3000 });
  f.advance(5000); await reconcileTaskTime(f.ctx);
  const sent: string[] = [];
  const options = { platform: "darwin" as const, enabled: true, send: async (m: { body: string }) => { sent.push(m.body); } };
  await notifyDueTasks(f.ctx, options); await notifyDueTasks(f.ctx, options);
  assert.equal(sent.length, 1); assert.match(sent[0], /expired|abgelaufen/i);
  const store = await readTaskStore(f.ctx.path);
  assert.equal(store.tasks[0].id, task.id);
  assert.equal(store.occurrences.find(o => o.kind === "expired")?.acknowledgement, undefined);
});

test("definite expiry notification failures keep retry work, submitted and uncertain claims stop it", async () => {
  const f = await fixture(); await f.call("task_create", { ...f.input, expires_at: 3000 });
  f.advance(5000); await reconcileTaskTime(f.ctx);
  let attempts = 0;
  const options = { platform: "darwin" as const, enabled: true, send: async () => { attempts++; throw new Error("OS temporarily unavailable"); } };
  await notifyDueTasks(f.ctx, options); await notifyDueTasks(f.ctx, options);
  assert.equal(attempts, 1);
  const runtime = startTaskRuntime({ ...f.ctx, executionHost: true }); await runtime.ready;
  try {
    if (process.platform === "darwin") assert.equal(runtime.hasWork, true);
    f.advance(100000);
    await notifyDueTasks(f.ctx, { ...options, send: async () => { attempts++; } });
    assert.equal(attempts, 2); assert.equal(runtime.hasWork, false);
  } finally { runtime.stop(); await runtime.settle(); }
});

test("CLI and edit carry optional validity without confusing recurrence end", async () => {
  const f = await fixture();
  const made = friendlyTaskCreate({ goal: "Check", after: "1h", expires: "1970-01-01T03:00:00Z", timezone: "UTC", every: "1d" }, 1000) as any;
  assert.equal(made.expires_at, 10800000); assert.equal(made.recurrence.until, undefined);
  let task = await f.call("task_create", f.input);
  task = await f.mutate(task, "task_edit", { patch: { expires_at: 3000 } });
  assert.equal(task.expires_at, 3000); assert.equal(task.armed, true);
  await assert.rejects(f.call("task_edit", { id: task.id, expected_revision: "initial:0", patch: { expires_at: 9000 } }), { code: "conflict" });
  await assert.rejects(f.call("task_create", { ...f.input, idempotency_key: "bad", expires_at: -1 }));
  task = await f.mutate(task, "task_edit", { patch: { expires_at: null } });
  assert.equal(task.expires_at, undefined); assert.equal(task.armed, true);
  f.advance(9000); await reconcileTaskTime(f.ctx);
  assert.equal((await f.call("task_get", { id: task.id })).state, "due");
});

test("review and execution reject elapsed validity before a scheduler tick", async () => {
  const f = await fixture(); const task = await f.call("task_create", { ...f.input, expires_at: 3000 });
  f.advance(3000);
  await assert.rejects(f.mutate(task, "task_review"), { code: "conflict" });
  const store = await readTaskStore(f.ctx.path);
  assert.equal(store.tasks[0].state, "pending");
  await assert.rejects(validateTaskProposal(f.ctx, store, { task_id: task.id, status: "prepared", task_binding: "present" } as any, {} as any), { code: "conflict" });
});
