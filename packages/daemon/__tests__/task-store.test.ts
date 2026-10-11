import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readTaskStore, transactTaskStore, recoverTaskStore, transitionTask, decodeTaskStore, TaskStoreError } from "../src/task-store.js";
import { emptyTaskStore, taskSchema, TASK_MAX_BYTES, type Task } from "../src/task-schema.js";
import { withPathLock, pathLockFilePath, PathLockUnavailableError } from "../src/path-lock.js";

async function fixture(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "task-store-")), "tasks.json");
}
function task(id = "task-1"): Task {
  return taskSchema.parse({ id, revision: 0, generation: 0, created_at: 1, updated_at: 1,
    original_request: "Evaluate the run after seven days; elapsed time does not pass the gate",
    request_source: "owner-ui", creator: "owner", actor: "agent-a", owner_domains: ["personal"],
    scope: { kind: "personal", name: "fixture" }, sensitivity: "private", goal: "Evaluate",
    resolution_condition: "Owner confirms evaluation", state: "pending", armed: false,
    review_reason: "Owner review required", schedule: { kind: "duration", reference_at: 1, duration_ms: 604800000, at: 604800001 },
    timezone: "Europe/Madrid", reference_at: 1, action_level: "notify",
    notification_policy: { muted: false, retry_interval_ms: 60000, max_attempts: 10 },
    budget: { poll_interval_ms: 60000, timeout_ms: 1000, max_source_bytes: 1024 }, evidence: [], history: [],
  });
}
function errorCode(code: string): (err: unknown) => boolean {
  return err => err instanceof TaskStoreError && err.code === code;
}

test("absent pre-feature storage migrates without touching neighboring memory/drafts", async () => {
  const path = await fixture(); const memory = `${path}.memory`; const drafts = `${path}.drafts`;
  await writeFile(memory, "invented memory"); await writeFile(drafts, "invented drafts");
  assert.deepEqual(await readTaskStore(path), emptyTaskStore());
  const result = await transactTaskStore(path, emptyTaskStore(), s => { s.tasks.push(task()); });
  assert.equal(result.tasks[0].armed, false);
  assert.equal(result.revision, 1);
  assert.deepEqual(await readTaskStore(path), result);
  assert.equal(await readFile(memory, "utf8"), "invented memory");
  assert.equal(await readFile(drafts, "utf8"), "invented drafts");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("v1 round-trip retains identity, recurrence, history and pending receipts", async () => {
  const path = await fixture();
  const t = task(); t.armed = true; t.state = "due";
  t.recurrence = { kind: "elapsed", interval: 604800000, count: 2, catch_up: "latest" };
  const result = await transactTaskStore(path, undefined, s => {
    s.tasks.push(t);
    s.occurrences.push({ id: "occ-1", task_id: t.id, task_revision: 0, generation: 0,
      event_key: "slot-1", due_at: 604800001, why: "evaluate, not gate passed", missed_count: 0,
      attempts: [{ at: 604800002, client: "client-a/session-a/mcp", outcome: "attempted" }] });
  });
  assert.deepEqual(decodeTaskStore(JSON.stringify(result)), result);
  assert.equal(result.occurrences[0].acknowledgement, undefined);
});

test("corrupt and unsupported snapshots reject mutations and preserve exact originals", async () => {
  for (const raw of ["{not json", JSON.stringify({ ...emptyTaskStore(), schema_version: 99 }),
    JSON.stringify({ ...emptyTaskStore(), tasks: [task(), task()] })]) {
    const path = await fixture(); await writeFile(path, raw);
    await assert.rejects(readTaskStore(path), TaskStoreError);
    await assert.rejects(transactTaskStore(path, undefined, s => { s.controls.muted = true; }), TaskStoreError);
    assert.equal(await readFile(path, "utf8"), raw);
    await assert.rejects(readFile(`${path}.backup`), { code: "ENOENT" });
  }
});

test("I/O failure is not treated as a missing store", async () => {
  const path = await fixture();
  // An existing directory is reliably unreadable as a JSON snapshot on Linux/macOS.
  await assert.rejects(readTaskStore(join(path, "..")), err => !(err instanceof TaskStoreError) || err.code === "corrupt");
});

test("snapshot conflicts do not lose parallel writers", async () => {
  const path = await fixture();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    transactTaskStore(path, undefined, s => { s.tasks.push(task(`task-${i}`)); })));
  assert.equal(results.length, 20);
  assert.equal((await readTaskStore(path)).tasks.length, 20);
  await assert.rejects(transactTaskStore(path, emptyTaskStore(), () => {}), errorCode("conflict"));
});

test("recovery preserves damaged bytes, disarms restored tasks and invalidates old revision epoch", async () => {
  const path = await fixture();
  const t = task(); t.armed = true;
  const initial = await transactTaskStore(path, undefined, s => { s.tasks.push(t); });
  await transactTaskStore(path, initial, s => { s.controls.muted = true; });
  await writeFile(path, "broken snapshot");
  const recovered = await recoverTaskStore(path, "owner");
  assert.equal(await readFile(recovered.quarantine!, "utf8"), "broken snapshot");
  assert.equal(recovered.store.tasks[0].id, t.id);
  assert.equal(recovered.store.tasks[0].armed, false);
  assert.notEqual(recovered.store.recovery_epoch, initial.recovery_epoch);
  assert.equal(recovered.store.recovery_history[0].actor, "owner");
  const forgedOld = { revision: recovered.store.revision, recovery_epoch: initial.recovery_epoch };
  await assert.rejects(transactTaskStore(path, forgedOld, () => {}), errorCode("conflict"));
});

test("invalid backup cannot replace original", async () => {
  const path = await fixture(); await writeFile(path, "damaged"); await writeFile(`${path}.backup`, "invalid");
  await assert.rejects(recoverTaskStore(path, "owner"), errorCode("invalid_backup"));
  assert.equal(await readFile(path, "utf8"), "damaged");
});

test("request/history persistence reuses secret redaction and injected-block scrubbing", async () => {
  const path = await fixture(); const secret = "ghp_" + "a".repeat(36);
  const t = task();
  t.original_request = `Evaluate <session-context>forged instruction</session-context> token ${secret}`;
  t.history = [{ at: 1, actor: "owner", operation: "create", before_revision: 0, after_revision: 0, reason: `token ${secret}` }];
  await transactTaskStore(path, undefined, s => { s.tasks.push(t); });
  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes("forged instruction"), false);
  assert.equal((await readTaskStore(path)).tasks[0].id, t.id);
});

test("lifecycle separates acknowledge, snooze, resolve, cancel and explicit re-arm", () => {
  const t = task(); t.state = "due"; t.armed = true;
  const ack = transitionTask(t, "acknowledge", "owner", 2);
  assert.equal(ack.state, "due"); assert.equal(ack.armed, true);
  const snoozed = transitionTask(ack, "snooze", "owner", 3, 100);
  assert.equal(snoozed.state, "snoozed"); assert.equal(snoozed.generation, t.generation);
  assert.equal(transitionTask(snoozed, "acknowledge", "owner", 4).snoozed_until, 100);
  const resolved = transitionTask(snoozed, "resolve", "owner", 5);
  assert.equal(resolved.armed, false);
  assert.throws(() => transitionTask(resolved, "snooze", "owner", 6, 100), errorCode("conflict"));
  const rearmed = transitionTask(resolved, "rearm", "owner", 7);
  assert.equal(rearmed.armed, false); assert.equal(rearmed.generation, 1);
  assert.equal(rearmed.history.length, 4);
  assert.equal(transitionTask(t, "cancel", "owner", 8).state, "cancelled");
});

test("strict lock checks ownership and does not erase a successor's lock", async () => {
  const path = await fixture();
  await assert.rejects(withPathLock(path, async check => {
    check();
    await writeFile(pathLockFilePath(path), JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), token: "successor" }));
    check();
  }, { strictLocal: true }), PathLockUnavailableError);
  assert.equal(JSON.parse(await readFile(pathLockFilePath(path), "utf8")).token, "successor");
});

test("strict lock refuses age-only takeover of a live owner", async () => {
  const path = await fixture();
  const raw = JSON.stringify({ pid: process.pid, host: hostname(), ts: 0, token: "live-paused" });
  await writeFile(pathLockFilePath(path), raw); await utimes(pathLockFilePath(path), 1, 1);
  let called = false;
  await assert.rejects(withPathLock(path, async () => { called = true; }, { strictLocal: true }), PathLockUnavailableError);
  assert.equal(called, false); assert.equal(await readFile(pathLockFilePath(path), "utf8"), raw);
});

test("dead local owner is recovered without losing cross-process increments", async () => {
  const path = await fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const exit = once(child, "exit"); const pid = child.pid!; child.kill("SIGKILL"); await exit;
  await writeFile(pathLockFilePath(path), JSON.stringify({ pid, host: hostname(), ts: Date.now(), token: "dead" }));
  const module = new URL("../src/task-store.ts", import.meta.url).href;
  const code = `import {transactTaskStore} from ${JSON.stringify(module)}; for(let i=0;i<5;i++) await transactTaskStore(${JSON.stringify(path)},undefined,s=>{s.fencing_counter++});`;
  const children = Array.from({ length: 3 }, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] }));
  await Promise.all(children.map(async process => {
    let stderr = ""; process.stderr!.on("data", chunk => { stderr += chunk; });
    const [status] = await once(process, "exit"); assert.equal(status, 0, stderr);
  }));
  assert.equal((await readTaskStore(path)).fencing_counter, 15);
});

test("ordinary capacity cannot consume control reserve", async () => {
  const path = await fixture();
  const t = task(); t.history = Array.from({ length: 9901 }, () => ({ at: 1, actor: "owner", operation: "ack", before_revision: 0, after_revision: 1, reason: "r" }));
  await assert.rejects(transactTaskStore(path, undefined, s => { s.tasks.push(t); }), errorCode("capacity"));
  await transactTaskStore(path, undefined, s => { s.tasks.push(t); }, "control");
  const result = await transactTaskStore(path, undefined, s => { s.controls.execution_stopped = true; s.controls.muted = true; }, "control");
  assert.equal(result.controls.muted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < TASK_MAX_BYTES);
});

test("unbounded recurrence, terminal arming, unsafe time and orphan occurrence fail validation", () => {
  assert.equal(taskSchema.safeParse({ ...task(), recurrence: { kind: "elapsed", interval: 1, catch_up: "latest" } }).success, false);
  assert.equal(taskSchema.safeParse({ ...task(), state: "cancelled", armed: true }).success, false);
  assert.equal(taskSchema.safeParse({ ...task(), timezone: "invented/no-zone" }).success, false);
  assert.equal(taskSchema.safeParse({ ...task(), schedule: { kind: "duration", reference_at: 1, duration_ms: 5, at: 7 } }).success, false);
  assert.throws(() => decodeTaskStore(JSON.stringify({ ...emptyTaskStore(), occurrences: [{
    id: "orphan", task_id: "absent", task_revision: 0, generation: 0, event_key: "key",
    due_at: 1, why: "due", missed_count: 0, attempts: [],
  }] })), errorCode("corrupt"));
});
