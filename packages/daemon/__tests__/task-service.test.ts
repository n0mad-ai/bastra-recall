import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential, revokeTaskCredential } from "../src/task-auth.js";
import { callTaskCrud, type TaskCrudOperation } from "../src/task-service.js";
import { readTaskStore, recoverTaskStore, transactTaskStore } from "../src/task-store.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-crud-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1000 };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const other = await mintTaskCredential(ctx.authPath, { actor_id: "other", domains: ["other"], role: "owner" });
  const call = (who: typeof owner, op: TaskCrudOperation, input: unknown) => callTaskCrud(ctx, `Bearer ${who.token}`, op, input) as Promise<any>;
  const input = { idempotency_key: "fixture", original_request: "Evaluate this run", goal: "Evaluate",
    resolution_condition: "Owner evaluation", schedule: { kind: "instant", at: 2000 }, timezone: "Europe/Madrid",
    scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"] };
  return { ctx, owner, agent, other, call, input };
}
test("agent capture stays unarmed; owner explicitly reviews notify without signing key", async () => {
  const f = await fixture(); const t = await f.call(f.agent, "task_create", { ...f.input, action_level: "prepare" });
  assert.equal(t.armed, false); assert.equal(t.creator, "agent"); assert.equal(t.action_level, "prepare");
  await assert.rejects(f.call(f.agent, "task_review", { id: t.id, expected_revision: t.expected_revision }), { code: "forbidden" });
  const reviewed = await f.call(f.owner, "task_review", { id: t.id, expected_revision: t.expected_revision });
  assert.equal(reviewed.armed, true); assert.equal(reviewed.history.at(-1).actor, "owner");
});
test("owner create-and-arm is explicit; forged user/actor/owner claims fail strict input", async () => {
  const f = await fixture(); assert.equal((await f.call(f.owner, "task_create", { ...f.input, arm: true })).armed, true);
  for (const forged of [{ source: "user" }, { actor: "owner" }, { approved: true }, { creator: "owner" }])
    await assert.rejects(f.call(f.agent, "task_create", { ...f.input, ...forged }));
  await assert.rejects(f.call(f.agent, "task_create", { ...f.input, action_level: "prepare", arm: true }), { code: "forbidden" });
  await assert.rejects(f.call(f.owner, "task_create", { ...f.input, idempotency_key: "exec", action_level: "execute", arm: true }), { code: "protected_boundary_required" });
});
test("domain reads hide existence and mutations never cross ownership", async () => {
  const f = await fixture(); const t = await f.call(f.owner, "task_create", f.input);
  assert.deepEqual(await f.call(f.other, "task_list", {}), { tasks: [] });
  await assert.rejects(f.call(f.other, "task_get", { id: t.id }), { code: "not_found" });
  await assert.rejects(f.call(f.other, "task_cancel", { id: t.id, expected_revision: t.expected_revision }), { code: "not_found" });
  await assert.rejects(f.call(f.agent, "task_create", { ...f.input, owner_domains: ["other"] }), { code: "forbidden" });
});
test("concurrent idempotent creation yields one task and changed payload conflicts", async () => {
  const f = await fixture(); const rows = await Promise.all(Array.from({ length: 8 }, () => f.call(f.agent, "task_create", f.input)));
  assert.equal(new Set(rows.map(t => t.id)).size, 1); assert.equal((await readTaskStore(f.ctx.path)).tasks.length, 1);
  const reordered = Object.fromEntries(Object.entries(f.input).reverse().map(([k,v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v]));
  assert.equal((await f.call(f.agent, "task_create", reordered)).id, rows[0].id);
  await assert.rejects(f.call(f.agent, "task_create", { ...f.input, goal: "different" }), { code: "conflict" });
});
test("concurrent expected revisions allow one mutation; edit disarms and preserves audit", async () => {
  const f = await fixture(); const t = await f.call(f.owner, "task_create", { ...f.input, arm: true });
  const args = { id: t.id, expected_revision: t.expected_revision, patch: { goal: "Re-evaluate" } };
  const results = await Promise.allSettled([f.call(f.owner, "task_edit", args), f.call(f.owner, "task_edit", args)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const edited = await f.call(f.owner, "task_get", { id: t.id }); assert.equal(edited.armed, false);
  assert.equal(edited.history.length, 2);
  await assert.rejects(f.call(f.agent, "task_edit", { ...args, expected_revision: edited.expected_revision }), { code: "forbidden" });
});
test("snooze and cancellation are conservative agent controls; rearm is owner-only and unarmed", async () => {
  const f = await fixture(); let t = await f.call(f.owner, "task_create", { ...f.input, arm: true });
  t = await f.call(f.agent, "task_snooze", { id: t.id, expected_revision: t.expected_revision, until: 3000 });
  assert.equal(t.state, "snoozed"); assert.equal(t.generation, 0);
  t = await f.call(f.agent, "task_cancel", { id: t.id, expected_revision: t.expected_revision });
  await assert.rejects(f.call(f.owner, "task_review", { id: t.id, expected_revision: t.expected_revision }), { code: "conflict" });
  await assert.rejects(f.call(f.agent, "task_rearm", { id: t.id, expected_revision: t.expected_revision }), { code: "forbidden" });
  t = await f.call(f.owner, "task_rearm", { id: t.id, expected_revision: t.expected_revision });
  assert.equal(t.state, "pending"); assert.equal(t.armed, false); assert.equal(t.generation, 1);
});
test("prepare acknowledgement and resolution remain owner commands", async () => {
  const f = await fixture(); let t = await f.call(f.owner, "task_create", { ...f.input, arm: true, action_level: "prepare" });
  await transactTaskStore(f.ctx.path, undefined, s => {
    s.occurrences.push({ id: "occ", task_id: t.id, task_revision: 0, generation: 0, event_key: "slot", due_at: 2000,
      why: "Evaluate", missed_count: 0, attempts: [] });
  });
  await assert.rejects(f.call(f.agent, "task_acknowledge", { id: t.id, expected_revision: t.expected_revision, occurrence_id: "occ" }), { code: "forbidden" });
  await assert.rejects(f.call(f.owner, "task_acknowledge", { id: t.id, expected_revision: t.expected_revision }), { code: "validation" });
  t = await f.call(f.owner, "task_acknowledge", { id: t.id, expected_revision: t.expected_revision, occurrence_id: "occ" });
  assert.equal(t.state, "pending"); assert.ok((await readTaskStore(f.ctx.path)).occurrences[0].acknowledgement);
  await assert.rejects(f.call(f.agent, "task_resolve", { id: t.id, expected_revision: t.expected_revision }), { code: "forbidden" });
  t = await f.call(f.owner, "task_resolve", { id: t.id, expected_revision: t.expected_revision });
  assert.equal(t.state, "resolved"); assert.ok((await readTaskStore(f.ctx.path)).occurrences[0].resolution);
});
test("recovery epoch rejects formerly valid revision token; revocation denies next CRUD", async () => {
  const f = await fixture(); const t = await f.call(f.owner, "task_create", f.input);
  await f.call(f.owner, "task_edit", { id: t.id, expected_revision: t.expected_revision, patch: { goal: "New" } });
  await writeFile(f.ctx.path, "broken"); await recoverTaskStore(f.ctx.path, "owner");
  await assert.rejects(f.call(f.owner, "task_review", { id: t.id, expected_revision: t.expected_revision }), { code: "conflict" });
  await revokeTaskCredential(f.ctx.authPath, f.owner.credential_id);
  await assert.rejects(f.call(f.owner, "task_get", { id: t.id }), { code: "unauthorized" });
});
test("agent snooze has a fixed ceiling, cannot extend indefinitely, and owner review resets it", async () => {
  const f = await fixture(); let t = await f.call(f.owner, "task_create", { ...f.input, arm: true, action_level: "prepare" });
  const ceiling = 1000 + 86400000;
  await assert.rejects(f.call(f.agent, "task_snooze", { id: t.id, expected_revision: t.expected_revision, until: ceiling + 1 }), { code: "validation" });
  t = await f.call(f.agent, "task_snooze", { id: t.id, expected_revision: t.expected_revision, until: ceiling });
  f.ctx.now = () => 10000;
  await assert.rejects(f.call(f.agent, "task_snooze", { id: t.id, expected_revision: t.expected_revision, until: ceiling + 1 }), { code: "validation" });
  t = await f.call(f.owner, "task_review", { id: t.id, expected_revision: t.expected_revision });
  assert.equal(t.agent_snooze_deadline, undefined);
  t = await f.call(f.owner, "task_snooze", { id: t.id, expected_revision: t.expected_revision, until: ceiling * 2 });
  assert.equal(t.snoozed_until, ceiling * 2);
});
test("trigger edit discards snooze, advances generation unarmed; cosmetic edit preserves snooze", async () => {
  const f = await fixture(); let t = await f.call(f.owner, "task_create", { ...f.input, arm: true });
  t = await f.call(f.agent, "task_snooze", { id: t.id, expected_revision: t.expected_revision, until: 3000 });
  t = await f.call(f.owner, "task_edit", { id: t.id, expected_revision: t.expected_revision, patch: { goal: "Cosmetic" } });
  assert.equal(t.state, "snoozed"); assert.equal(t.snoozed_until, 3000); assert.equal(t.generation, 0);
  t = await f.call(f.owner, "task_edit", { id: t.id, expected_revision: t.expected_revision, patch: { schedule: { kind: "instant", at: 4000 } } });
  assert.equal(t.state, "pending"); assert.equal(t.snoozed_until, undefined); assert.equal(t.armed, false); assert.equal(t.generation, 1);
});

const origin = { kind: "user-request", client: "test-client", session: "test-session", context: "Remind me to evaluate" };
test("conversational notify arms, deduplicates, acknowledges and resolves without owner token", async () => {
  const f = await fixture(); let t = await f.call(f.agent, "task_create", { ...f.input, arm: true, origin });
  assert.equal(t.armed, true); assert.deepEqual(t.origin, origin); assert.equal(t.request_source, "user-request");
  const duplicate = await f.call(f.agent, "task_create", { ...f.input, idempotency_key: "different", arm: true, origin });
  assert.equal(duplicate.id, t.id); assert.equal(duplicate.duplicate, true);
  await transactTaskStore(f.ctx.path, undefined, s => { s.occurrences.push({ id: "occ", task_id: t.id, task_revision: 0, generation: 0, event_key: "slot", due_at: 2000, why: "Evaluate", missed_count: 0, attempts: [] }); });
  t = await f.call(f.agent, "task_acknowledge", { id: t.id, expected_revision: t.expected_revision, occurrence_id: "occ" });
  assert.notEqual(t.state, "resolved");
  t = await f.call(f.agent, "task_snooze", { id: t.id, expected_revision: t.expected_revision, until: 1000 + 2 * 86400000 });
  t = await f.call(f.agent, "task_resolve", { id: t.id, expected_revision: t.expected_revision });
  assert.equal(t.state, "resolved"); assert.equal(t.armed, false);
});
test("agent cannot elevate notify, arm prepare/execute, or use ambiguous wall time", async () => {
  const f = await fixture(); const t = await f.call(f.agent, "task_create", { ...f.input, origin });
  for (const action_level of ["prepare", "execute"]) {
    await assert.rejects(f.call(f.agent, "task_create", { ...f.input, origin, arm: true, action_level }), { code: "forbidden" });
    await assert.rejects(f.call(f.agent, "task_edit", { id: t.id, expected_revision: t.expected_revision, patch: { action_level } }), { code: "forbidden" });
  }
  await assert.rejects(f.call(f.agent, "task_create", { ...f.input, arm: true }), { code: "validation" });
  await assert.rejects(f.call(f.agent, "task_create", { ...f.input, arm: true, origin, schedule: { kind: "calendar", local_time: "2026-10-25T02:30:00", timezone: "Europe/Madrid", at: 0, offset_minutes: 0, gap: "reject", overlap: "earlier" } }), { code: "validation" });
});

test("feature off saves unarmed and provenance is scrubbed", async () => {
  const f = await fixture(); const previous = process.env.BASTRA_CONVERSATIONAL_REMINDERS;
  process.env.BASTRA_CONVERSATIONAL_REMINDERS = "0";
  try {
    const t = await f.call(f.agent, "task_create", { ...f.input, arm: true, origin: { ...origin, context: "password=synthetic-secret-value" } });
    assert.equal(t.armed, false); assert.match(t.review_reason, /disabled/);
    assert.ok(!JSON.stringify(t.origin).includes("synthetic-secret-value"));
  } finally { if (previous === undefined) delete process.env.BASTRA_CONVERSATIONAL_REMINDERS; else process.env.BASTRA_CONVERSATIONAL_REMINDERS = previous; }
});

test("different reminder goals at the same time/cause stay distinct; exact retries deduplicate", async () => {
  const f = await fixture(); const first = await f.call(f.agent, "task_create", { ...f.input, arm: true, origin });
  const second = await f.call(f.agent, "task_create", { ...f.input, idempotency_key: "second-goal", goal: "Send the evaluation", arm: true, origin });
  assert.notEqual(second.id, first.id); assert.equal(second.armed, true);
  const retry = await f.call(f.agent, "task_create", { ...f.input, idempotency_key: "retry-second", goal: "Send the evaluation", arm: true, origin });
  assert.equal(retry.id, second.id); assert.equal(retry.duplicate, true); assert.equal((await readTaskStore(f.ctx.path)).tasks.length, 2);
});

test("pre-scrub fingerprint deduplicates secrets without merging different raw contents", async () => {
  const f = await fixture(); const request = { ...f.input, arm: true, origin, original_request: "Remind me: password=synthetic-dedup-secret" };
  const first = await f.call(f.agent, "task_create", request);
  const repeated = await f.call(f.agent, "task_create", { ...request, idempotency_key: "secret-repeat" });
  assert.equal(repeated.id, first.id); assert.equal(repeated.duplicate, true); assert.match(first.original_request, /REDACTED/);
  const different = await f.call(f.agent, "task_create", { ...request, idempotency_key: "other-secret", original_request: "Remind me: password=synthetic-other-secret" });
  assert.notEqual(different.id, first.id); assert.equal(different.original_request, first.original_request);
  const store = await readTaskStore(f.ctx.path); assert.equal(store.tasks.length, 2); const raw = JSON.stringify(store);
  assert.ok(!raw.includes("synthetic-dedup-secret")); assert.ok(!raw.includes("synthetic-other-secret"));
  assert.equal(first.reminder_fingerprint, undefined);
  assert.match(store.tasks[0].reminder_fingerprint!, /^hmac-v1:[a-f0-9]{64}$/);
  const edited = await f.call(f.owner, "task_edit", { id: first.id, expected_revision: first.expected_revision, patch: { goal: "Different edited goal" } });
  assert.equal(edited.reminder_fingerprint, undefined);
  assert.notEqual((await f.call(f.agent, "task_create", { ...request, idempotency_key: "after-edit" })).id, first.id);
});
