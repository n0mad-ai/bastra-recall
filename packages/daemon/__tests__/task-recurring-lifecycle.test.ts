import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud, type TaskCrudOperation } from "../src/task-service.js";
import { decodeTaskStore, readTaskStore, recoverTaskStore } from "../src/task-store.js";
import { writeAppRecord } from "../src/app-record-store.js";
import { readTaskArchive, taskArchivePath } from "../src/task-archive.js";
import { reconcileTaskTime } from "../src/task-events.js";
import { friendlyTaskCreate } from "../src/cli/task-friendly.js";
import { resolveTaskCalendar, timeSlot } from "../src/task-clock.js";
import { matchTaskHttpRoute } from "../src/task-http-routes.js";
import { taskTools } from "../src/task-transport.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-series-"));
  let now = 1000;
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const call = (op: string, input: unknown) => callTaskCrud(ctx, `Bearer ${owner.token}`, op as TaskCrudOperation, input) as Promise<any>;
  const input = { idempotency_key: "series", original_request: "Check daily", goal: "Check daily", resolution_condition: "Check completed",
    owner_domains: ["personal"], scope: { kind: "personal", name: "series" }, timezone: "UTC", arm: true,
    schedule: { kind: "instant", at: 2000 }, recurrence: { kind: "elapsed", interval: 1000, catch_up: "latest" } };
  return { ctx, call, input, advance: (at: number) => { now = at; }, mutate: (t: any, op: string, extra = {}) => call(op, { id: t.id, expected_revision: t.expected_revision, ...extra }) };
}

test("unbounded series accepts CLI creation and resolves each occurrence without ending the series", async () => {
  const f = await fixture();
  assert.deepEqual(friendlyTaskCreate({ goal: "Check", after: "1h", every: "1d" }, 1000).recurrence,
    { kind: "elapsed", interval: 86400000, catch_up: "latest" });
  let t = await f.call("task_create", f.input);
  f.advance(2000); await reconcileTaskTime(f.ctx);
  t = await f.call("task_get", { id: t.id });
  const first = (await readTaskStore(f.ctx.path)).occurrences[0];
  t = await f.mutate(t, "task_resolve", { occurrence_id: first.id });
  assert.equal(t.state, "pending"); assert.equal(t.armed, true);
  assert.ok((await readTaskStore(f.ctx.path)).occurrences[0].resolution);
  f.advance(3000); await reconcileTaskTime(f.ctx);
  const store = await readTaskStore(f.ctx.path);
  assert.equal(store.occurrences.length, 2); assert.equal(store.tasks[0].state, "due");
  assert.equal(store.occurrences[1].resolution, undefined);
});

test("pause persists across snapshot reload, suppresses cards and evaluation, resume catches up latest once", async () => {
  const f = await fixture(); let t = await f.call("task_create", f.input);
  f.advance(2000); await reconcileTaskTime(f.ctx); t = await f.call("task_get", { id: t.id });
  t = await f.mutate(t, "task_pause"); assert.equal(t.paused, true);
  assert.equal(decodeTaskStore(JSON.stringify(await readTaskStore(f.ctx.path))).tasks[0].paused, true);
  assert.deepEqual((await f.call("task_due", {})).cards, []);
  f.advance(8000); await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
  t = await f.mutate(t, "task_resume"); assert.equal(t.paused, false); assert.equal(t.armed, true);
  await reconcileTaskTime(f.ctx); await reconcileTaskTime(f.ctx);
  const store = await readTaskStore(f.ctx.path);
  assert.equal(store.occurrences.length, 2); assert.equal(store.occurrences[1].due_at, 8000);
  assert.equal(store.occurrences[1].missed_count, 5);
});

test("series termination is explicit and cannot be silently resumed", async () => {
  const f = await fixture(); let t = await f.call("task_create", f.input);
  t = await f.mutate(t, "task_end_series");
  assert.equal(t.state, "cancelled"); assert.equal(t.armed, false);
  await assert.rejects(f.mutate(t, "task_resume"), { code: "conflict" });
  f.advance(9000); await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
});

test("one-off resolution retains terminal behavior; unselected recurring occurrence stays open", async () => {
  const f = await fixture(); const { recurrence: _, ...oneOff } = f.input;
  let single = await f.call("task_create", { ...oneOff, idempotency_key: "single" });
  single = await f.mutate(single, "task_resolve"); assert.equal(single.state, "resolved");
  let series = await f.call("task_create", f.input);
  f.advance(2000); await reconcileTaskTime(f.ctx); f.advance(3000); await reconcileTaskTime(f.ctx);
  series = await f.call("task_get", { id: series.id });
  const occurrences = (await readTaskStore(f.ctx.path)).occurrences;
  series = await f.mutate(series, "task_resolve", { occurrence_id: occurrences[0].id });
  assert.equal(series.state, "due"); assert.equal(series.armed, true);
  const store = await readTaskStore(f.ctx.path);
  assert.ok(store.occurrences[0].resolution); assert.equal(store.occurrences[1].resolution, undefined);
  await assert.rejects(f.mutate(series, "task_resolve", { occurrence_id: "unknown" }), { code: "not_found" });
});

test("legacy v3 snapshots keep IDs, revisions and unpaused behavior; calendar series retain DST wall time", async () => {
  const f = await fixture();
  const bounded = await f.call("task_create", { ...f.input, recurrence: { ...f.input.recurrence, count: 3 } });
  const before = await readTaskStore(f.ctx.path);
  const legacy = { ...before, schema_version: 3 };
  const decoded = decodeTaskStore(JSON.stringify(legacy));
  assert.equal(decoded.schema_version, 4);
  assert.equal(decoded.tasks[0].id, bounded.id); assert.equal(decoded.tasks[0].revision, bounded.revision);
  assert.equal(decoded.tasks[0].paused ?? false, false);
  const local_time = "2026-10-24T09:00:00", timezone = "Europe/Berlin";
  const task = { ...decoded.tasks[0], timezone, recurrence: { kind: "calendar" as const, interval: 1, catch_up: "latest" as const },
    schedule: { kind: "calendar" as const, local_time, timezone, gap: "reject" as const, overlap: "earlier" as const, ...resolveTaskCalendar(local_time, timezone) } };
  assert.equal(timeSlot(task, 1).local_time, "2026-10-25T09:00:00");
  assert.equal(timeSlot(task, 1).at - timeSlot(task, 0).at, 25 * 3600000);
});

test("bounded series resolves terminally after its final occurrence", async () => {
  const f = await fixture(); let t = await f.call("task_create", { ...f.input, recurrence: { ...f.input.recurrence, count: 1 } });
  f.advance(2000); await reconcileTaskTime(f.ctx); t = await f.call("task_get", { id: t.id });
  t = await f.mutate(t, "task_resolve");
  assert.equal(t.state, "resolved"); assert.equal(t.armed, false); assert.equal(t.next_slot, undefined);
});

test("pause, resume and end-series share the local HTTP and MCP contracts", () => {
  for (const action of ["pause", "resume", "end_series"]) {
    const operation = `task_${action}`;
    assert.equal(matchTaskHttpRoute("POST", `/api/v1/tasks/series/${action}`)?.operation, operation);
    assert.ok(taskTools.some(tool => tool.name === operation));
  }
});

test("v3 backup recovery and cold archives upgrade without altering IDs or archive bytes", async () => {
  const f = await fixture(); const t = await f.call("task_create", { ...f.input, recurrence: { ...f.input.recurrence, count: 2 } });
  const legacy = { ...await readTaskStore(f.ctx.path), schema_version: 3 };
  await writeAppRecord("tasks", `${f.ctx.path}.backup`, JSON.stringify(legacy));
  const recovered = await recoverTaskStore(f.ctx.path, "owner");
  assert.equal(recovered.store.schema_version, 4); assert.equal(recovered.store.tasks[0].id, t.id);
  assert.equal(recovered.store.tasks[0].armed, false);
  const id = "00000000-0000-4000-8000-000000000004";
  const archive = taskArchivePath(f.ctx.path, id);
  await mkdir(join(archive, ".."), { recursive: true });
  const raw = JSON.stringify({ schema_version: 1, id, snapshot: legacy });
  await writeFile(archive, raw, { mode: 0o600 });
  const decoded = await readTaskArchive(f.ctx.path, { id, hash: createHash("sha256").update(raw).digest("hex"), at: 1000, actor: "owner", task_ids: [t.id], intent_keys: [], owner_domains: ["personal"] });
  assert.equal(decoded.schema_version, 4); assert.equal(decoded.tasks[0].id, t.id);
  assert.equal(decoded.tasks[0].revision, legacy.tasks[0].revision);
  assert.equal(await readFile(archive, "utf8"), raw);
  assert.throws(() => decodeTaskStore(JSON.stringify({ ...legacy, schema_version: 5 })), { code: "unsupported_version" });
});
