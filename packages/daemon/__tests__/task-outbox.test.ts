import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential, authenticateTask } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { reconcileTaskTime } from "../src/task-events.js";
import { taskDueInput, taskDueProjection, recordTaskDelivery, taskDueText } from "../src/task-outbox.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-outbox-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 3000 };
  const credential = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const auth = `Bearer ${credential.token}`; const principal = await authenticateTask(auth, ctx.authPath);
  const input = { idempotency_key: "fixture", original_request: "Evaluate the run", goal: "Evaluate", resolution_condition: "Owner evaluation", schedule: { kind: "instant", at: 2000 }, timezone: "Europe/Madrid", scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"], arm: true };
  await callTaskCrud(ctx, auth, "task_create", input); await reconcileTaskTime(ctx);
  return { ctx, auth, principal, input };
}
test("rendering and persisted attempts do not acknowledge or resolve; owner receipt is separate", async () => {
  const f = await fixture(); const agent = await mintTaskCredential(f.ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const agentAuth = `Bearer ${agent.token}`;
  const due = await callTaskCrud(f.ctx, agentAuth, "task_due", { session: "session-a", channel: "mcp" }) as any;
  assert.equal(due.cards.length, 1); let s = await readTaskStore(f.ctx.path);
  assert.equal(s.occurrences[0].attempts.length, 1); assert.equal(s.occurrences[0].acknowledgement, undefined); assert.equal(s.tasks[0].state, "due");
  assert.equal((await callTaskCrud(f.ctx, agentAuth, "task_due", { session: "session-a", channel: "mcp" }) as any).cards.length, 0);
  const card = due.cards[0]; await callTaskCrud(f.ctx, f.auth, "task_acknowledge", { id: card.task_id, expected_revision: card.expected_revision, occurrence_id: card.occurrence_id });
  s = await readTaskStore(f.ctx.path); assert.ok(s.occurrences[0].acknowledgement); assert.equal(s.tasks[0].state, "due"); assert.equal(s.occurrences[0].resolution, undefined);
});
test("disabled/purged relay and output overflow preserve pending work with no fabricated attempt", async () => {
  const f = await fixture(); const store = await readTaskStore(f.ctx.path);
  const small = taskDueProjection(store, f.principal, taskDueInput.parse({ max_bytes: 256 }), 3000);
  assert.equal(small.cards.length, 0); assert.equal(small.overflow, 1); assert.equal(store.occurrences[0].attempts.length, 0);
  const before = await readFile(f.ctx.path, "utf8"); const saved = process.env.BASTRA_PENDING_RELAY;
  try { process.env.BASTRA_PENDING_RELAY = "0"; assert.equal(taskDueProjection(store, f.principal, taskDueInput.parse({}), 3000).cards.length, 1); }
  finally { if (saved === undefined) delete process.env.BASTRA_PENDING_RELAY; else process.env.BASTRA_PENDING_RELAY = saved; }
  assert.equal(await readFile(f.ctx.path, "utf8"), before);
});
test("several clients share one occurrence, bounded rendering rotates pending cards", async () => {
  const f = await fixture(); for (let i = 0; i < 4; i++) await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, idempotency_key: `more-${i}` });
  await reconcileTaskTime(f.ctx); const agent = await mintTaskCredential(f.ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const agentAuth = `Bearer ${agent.token}`; const first = await callTaskCrud(f.ctx, agentAuth, "task_due", { session: "a", max_bytes: 16384 }) as any;
  const next = await callTaskCrud(f.ctx, agentAuth, "task_due", { session: "a", max_bytes: 16384 }) as any;
  assert.equal(first.cards.length, 3); assert.equal(next.cards.length, 2);
  const other = await callTaskCrud(f.ctx, f.auth, "task_due", { session: "b", max_bytes: 16384 }) as any;
  assert.equal(other.cards.length, 3); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 5);
});
test("client identity tuple cannot alias another actor/session by inserting colons", async () => {
  const f = await fixture(); const s = await readTaskStore(f.ctx.path);
  const a = taskDueProjection(s, { ...f.principal, actor_id: "owner:a" }, taskDueInput.parse({ session: "b" }), 3000);
  const b = taskDueProjection(s, f.principal, taskDueInput.parse({ session: "a:b" }), 3000);
  assert.notEqual(a.client, b.client);
  await recordTaskDelivery(f.ctx.path, f.principal, a.client, a.occurrenceIds, 3000);
  assert.equal(taskDueProjection(await readTaskStore(f.ctx.path), f.principal, taskDueInput.parse({ session: "a:b" }), 3000).cards.length, 1);
});
test("rendered block obeys byte budget and private domains remain absent", async () => {
  const f = await fixture(); const s = await readTaskStore(f.ctx.path);
  const due = taskDueProjection(s, f.principal, taskDueInput.parse({}), 3000);
  assert.ok(Buffer.byteLength(taskDueText(due)) <= 2048);
  assert.equal(taskDueProjection(s, { ...f.principal, domains: ["other"] }, taskDueInput.parse({}), 3000).cards.length, 0);
});
test("120 attacker-selected sessions cannot exhaust another actor or owner delivery", async () => {
  const f = await fixture(); const agent = await mintTaskCredential(f.ctx.authPath, { actor_id: "attacker", domains: ["personal"], role: "agent" });
  for (let i = 0; i < 120; i++) await callTaskCrud(f.ctx, `Bearer ${agent.token}`, "task_due", { session: `s-${i}` });
  let s = await readTaskStore(f.ctx.path); assert.equal(s.occurrences[0].attempts.length, 1); assert.equal(s.tasks[0].state, "due");
  assert.equal((await callTaskCrud(f.ctx, f.auth, "task_due", { session: "real" }) as any).cards.length, 1);
  const other = await mintTaskCredential(f.ctx.authPath, { actor_id: "other-agent", domains: ["personal"], role: "agent" });
  assert.equal((await callTaskCrud(f.ctx, `Bearer ${other.token}`, "task_due", { session: "real" }) as any).cards.length, 1);
  s = await readTaskStore(f.ctx.path); assert.equal(s.occurrences[0].acknowledgement, undefined); assert.equal(s.occurrences[0].resolution, undefined);
});
test("the sample ring rolls over without blocking owner presentation or losing acknowledgement", async () => {
  const f = await fixture(); const { transactTaskStore } = await import("../src/task-store.js");
  await transactTaskStore(f.ctx.path, undefined, s => {
    s.occurrences[0].attempts = Array.from({ length: 100 }, (_, i) => ({ at: 1, client: `legacy-${i}`, outcome: "attempted" }));
  });
  assert.equal((await callTaskCrud(f.ctx, f.auth, "task_due", {}) as any).cards.length, 1);
  let s = await readTaskStore(f.ctx.path); assert.equal(s.occurrences[0].attempts.length, 100); assert.equal(s.occurrences[0].compacted_attempts, 1);
  assert.equal((await callTaskCrud(f.ctx, f.auth, "task_due", {}) as any).cards.length, 1);
  s = await readTaskStore(f.ctx.path); assert.equal(s.occurrences[0].attempts.length, 100); assert.equal(s.occurrences[0].attempts.at(-1)?.count, 2);
});
test("task_due accurately declares its attempt-receipt write", async () => {
  const { taskTools } = await import("../src/task-transport.js");
  assert.equal(taskTools.find(t => t.name === "task_due")?.annotations.readOnlyHint, false);
});
