import { test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const TASK_TEST_REPO = fileURLToPath(new URL("../../../", import.meta.url));
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { observeTaskSources, reconcileTaskTime, taskValueHash } from "../src/task-events.js";
import { resolveTaskCalendar } from "../src/task-clock.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-events-"));
  let now = 1000;
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const auth = `Bearer ${owner.token}`; const agentAuth = `Bearer ${agent.token}`;
  const input = { idempotency_key: "fixture", original_request: "Evaluate", goal: "Evaluate", resolution_condition: "Owner evaluation",
    schedule: { kind: "instant", at: 2000 }, timezone: "Europe/Madrid", scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"], arm: true };
  const source = { id: "source", kind: "event", producer_actor: "agent", owner_domains: ["personal"], sensitivity: "private", max_age_ms: 10000, enabled: true };
  return { root, ctx, auth, agentAuth, input, source, setNow: (v: number) => { now = v; } };
}
test("persisted seven-day duration catches up once after restart and never says gate passed", async () => {
  const f = await fixture(); const at = 1000 + 604800000;
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "duration", reference_at: 1000, duration_ms: 604800000, at } });
  f.setNow(at - 1); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
  f.setNow(at + 10000); await Promise.all(Array.from({ length: 6 }, () => reconcileTaskTime(f.ctx)));
  let s = await readTaskStore(f.ctx.path); assert.equal(s.occurrences.length, 1); assert.match(s.occurrences[0].why, /not a passed/);
  f.setNow(1000); await reconcileTaskTime(f.ctx); s = await readTaskStore(f.ctx.path); assert.equal(s.occurrences.length, 1);
});
test("bounded elapsed recurrence catches up latest with missed slots and durable next instant", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, recurrence: { kind: "elapsed", interval: 1000, count: 5, catch_up: "latest" } });
  f.setNow(4500); let s = await reconcileTaskTime(f.ctx);
  assert.equal(s.occurrences.length, 1); assert.equal(s.occurrences[0].due_at, 4000); assert.equal(s.occurrences[0].missed_count, 2);
  assert.equal(s.tasks[0].next_slot?.at, 5000);
  f.setNow(9000); s = await reconcileTaskTime(f.ctx); assert.equal(s.occurrences.length, 2); assert.equal(s.tasks[0].slots_checked, 5); assert.equal(s.tasks[0].next_slot, undefined);
  await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 2);
});
test("Madrid gap rejects; overlap resolves earlier and cannot double fire; calendar days differ from durations", async () => {
  assert.throws(() => resolveTaskCalendar("2026-03-29T02:30:00", "Europe/Madrid"), /gap/);
  assert.equal(resolveTaskCalendar("2026-10-25T02:30:00", "Europe/Madrid").at, Date.parse("2026-10-25T00:30:00Z"));
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input,
    schedule: { kind: "calendar", local_time: "2026-10-25T02:30:00", timezone: "Europe/Madrid", gap: "reject", overlap: "earlier", at: 0, offset_minutes: 0 },
    recurrence: { kind: "calendar", interval: 1, count: 2, catch_up: "latest" } });
  f.setNow(Date.parse("2026-10-25T00:30:00Z")); let s = await reconcileTaskTime(f.ctx);
  assert.equal(s.occurrences.length, 1); assert.equal(s.tasks[0].next_slot?.at, Date.parse("2026-10-26T01:30:00Z"));
  f.setNow(Date.parse("2026-10-25T01:30:00Z")); s = await reconcileTaskTime(f.ctx); assert.equal(s.occurrences.length, 1);
});
test("only owner registers exact producer; forged source=user and unknown/wrong actors denied", async () => {
  const f = await fixture();
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_source_register", f.source), { code: "forbidden" });
  await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  const event = { source_id: "source", source_revision: 0, dedup_key: "event-1", value: "yes", state_updated_at: 1000 };
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_event", event), { code: "forbidden" });
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_event", { ...event, source: "user" }));
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_event", { ...event, source_id: "unknown" }), { code: "forbidden" });
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", event);
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", event); assert.equal((await readTaskStore(f.ctx.path)).events.length, 1);
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_event", { ...event, value: "no" }), { code: "conflict" });
});
test("secret equals uses original hashes, not identical redaction placeholders", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  const a = "api_key=sk_" + "a".repeat(36); const b = "api_key=sk_" + "b".repeat(36);
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "equals", expected: a } });
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", { source_id: "source", source_revision: 0, dedup_key: "b", value: b, state_updated_at: 1000 });
  let s = await reconcileTaskTime(f.ctx); assert.equal(s.occurrences.length, 0);
  assert.equal(s.tasks[0].schedule.kind === "event" && s.tasks[0].schedule.expected, s.events[0].value);
  assert.ok(!(await readFile(f.ctx.path, "utf8")).includes(a)); assert.ok(!(await readFile(f.ctx.path, "utf8")).includes(b));
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", { source_id: "source", source_revision: 0, dedup_key: "a", value: a, state_updated_at: 1000 });
  s = await reconcileTaskTime(f.ctx); assert.equal(s.occurrences.length, 1);
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", { source_id: "source", source_revision: 0, dedup_key: "same", value: a, state_updated_at: 1000 });
  s = await reconcileTaskTime(f.ctx); assert.equal(s.occurrences.length, 1); assert.equal(s.checkpoint, 3);
});
test("snoozed journal event remains eligible after checkpoint and restart", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  let t = await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "yes" } }) as any;
  t = await callTaskCrud(f.ctx, f.auth, "task_snooze", { id: t.id, expected_revision: t.expected_revision, until: 2000 });
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", { source_id: "source", source_revision: 0, dedup_key: "event", value: "yes", state_updated_at: 1000 });
  await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
  f.setNow(2000); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("actual registered file and Git ref observe bounded versions; symlink/escape failures are visible", async () => {
  const f = await fixture(); const artifact = join(f.root, "artifact.txt"); await writeFile(artifact, "initial");
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, kind: "file", producer_actor: "task-source-reader", root: f.root, path: "artifact.txt" });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "content-version", expected: taskValueHash("initial") } });
  await observeTaskSources(f.ctx); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
  await writeFile(artifact, "changed"); await observeTaskSources(f.ctx); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
  await symlink(artifact, join(f.root, "link"));
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, id: "unsafe", kind: "file", producer_actor: "task-source-reader", root: f.root, path: "link" });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, idempotency_key: "unsafe", schedule: { kind: "event", source_id: "unsafe", predicate: "content-version", expected: "old" } });
  await observeTaskSources(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).tasks[1].last_failure?.code, "source_unavailable");
  const repo = join(f.root, "repo"); await mkdir(repo); execFileSync("git", ["init", "-b", "fixture", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, id: "git", kind: "git", producer_actor: "task-source-reader", root: repo, ref: "refs/heads/fixture" });
  await observeTaskSources(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).events.at(-1)?.value, head);
});
test("journal beyond a tick budget advances, is fair, and cannot duplicate material values", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "due" } });
  for (let i = 0; i < 110; i++) await callTaskCrud(f.ctx, f.agentAuth, "task_event", { source_id: "source", source_revision: 0, dedup_key: `e-${i}`, value: i === 109 ? "due" : "unchanged", state_updated_at: 1000 });
  for (let i = 0; i < 11; i++) await reconcileTaskTime(f.ctx);
  const s = await readTaskStore(f.ctx.path); assert.equal(s.occurrences.length, 1); assert.equal(s.checkpoint, 110);
});
test("legacy v1 missing source registry migrates additively and missing secret hash never fires", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "masked" } });
  const original = JSON.parse(await readFile(f.ctx.path, "utf8")); delete original.sources; delete original.evaluation_cursor;
  delete original.tasks[0].schedule.expected_hash; await writeFile(f.ctx.path, JSON.stringify(original));
  assert.deepEqual((await readTaskStore(f.ctx.path)).sources, []);
  await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
});
test("file A B A B records four observations and two changes; raw baseline needs no hashing", async () => {
  const f = await fixture(); const path = join(f.root, "sequence.txt"); await writeFile(path, "A");
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, kind: "file", producer_actor: "task-source-reader", root: f.root, path: "sequence.txt" });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "content-version", expected: "A" } });
  for (const value of ["A", "B", "A", "B"]) { await writeFile(path, value); await observeTaskSources(f.ctx); await reconcileTaskTime(f.ctx); }
  await observeTaskSources(f.ctx); await reconcileTaskTime(f.ctx);
  const s = await readTaskStore(f.ctx.path); assert.equal(s.events.length, 4); assert.equal(s.occurrences.length, 2); assert.equal(s.sources[0].observation_number, 4);
});
test("events before owner arming never fire; reconcile rejects agents and owners outside task domains", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", { source_id: "source", source_revision: 0, dedup_key: "old", value: "yes", state_updated_at: 1000 });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "yes" } });
  await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_reconcile", {}), { code: "forbidden" });
  const other = await mintTaskCredential(f.ctx.authPath, { actor_id: "other", domains: ["other"], role: "owner" });
  await assert.rejects(callTaskCrud(f.ctx, `Bearer ${other.token}`, "task_reconcile", {}), { code: "forbidden" });
});
test("calendar recurrence rejects its later gap slot and clock rollback cannot duplicate a saved slot", async () => {
  const f = await fixture(); const at = resolveTaskCalendar("2026-03-28T02:30:00", "Europe/Madrid").at;
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "calendar", local_time: "2026-03-28T02:30:00", timezone: "Europe/Madrid", gap: "reject", overlap: "earlier", at, offset_minutes: 60 }, recurrence: { kind: "calendar", interval: 1, count: 3, catch_up: "latest" } });
  f.setNow(at); const s = await reconcileTaskTime(f.ctx);
  assert.equal(s.tasks[0].armed, false); assert.equal(s.tasks[0].last_failure?.code, "calendar_gap"); assert.equal(s.occurrences.length, 1);
  f.setNow(at - 86400000); await reconcileTaskTime(f.ctx); f.setNow(at); await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("two real processes reconcile the same time slot exactly once", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_create", f.input);
  const { spawn } = await import("node:child_process");
  const program = 'import {reconcileTaskTime} from "./packages/daemon/src/task-events.ts"; const ctx=JSON.parse(process.env.BASTRA_TEST_TASK_CTX); await reconcileTaskTime({...ctx,now:()=>5000});';
  const workers = [0, 1].map(() => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { cwd: TASK_TEST_REPO, env: { ...process.env, BASTRA_TEST_TASK_CTX: JSON.stringify(f.ctx) }, stdio: ["ignore", "ignore", "pipe"] }));
  for (const child of workers) child.stderr!.resume();
  const outcomes = await Promise.all(workers.map(child => once(child, "close")));
  for (const [code] of outcomes) assert.equal(code, 0);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("process dies after journal commit before checkpoint; restart evaluates the preserved event once", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "yes" } });
  const { spawn } = await import("node:child_process");
  const program = 'import {submitTaskEvent} from "./packages/daemon/src/task-events.ts"; const ctx=JSON.parse(process.env.BASTRA_TEST_TASK_CTX); await submitTaskEvent({...ctx,now:()=>1000},process.env.BASTRA_TEST_EVENT_AUTH,{source_id:"source",source_revision:0,dedup_key:"crash",value:"yes",state_updated_at:1000}); process.kill(process.pid,"SIGKILL");';
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { cwd: TASK_TEST_REPO, env: { ...process.env, BASTRA_TEST_TASK_CTX: JSON.stringify(f.ctx), BASTRA_TEST_EVENT_AUTH: f.agentAuth }, stdio: ["ignore", "ignore", "pipe"] });
  worker.stderr!.resume(); const [, signal] = await once(worker, "close"); assert.equal(signal, "SIGKILL");
  assert.equal((await readTaskStore(f.ctx.path)).checkpoint, 0);
  await reconcileTaskTime(f.ctx); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("Git A B A B produces four journal events, unchanged polls stay quiet", async () => {
  const f = await fixture(); const repo = join(f.root, "git-cycle"); await mkdir(repo);
  execFileSync("git", ["init", "-b", "fixture", repo]);
  const commit = (name: string) => {
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", name]);
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  };
  const a = commit("A"); const b = commit("B");
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, kind: "git", producer_actor: "task-source-reader", root: repo, ref: "refs/heads/fixture" });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "event", source_id: "source", predicate: "git-ref", expected: a } });
  for (const value of [a, b, a, b]) {
    execFileSync("git", ["-C", repo, "update-ref", "refs/heads/fixture", value]);
    await observeTaskSources(f.ctx); await reconcileTaskTime(f.ctx);
  }
  await observeTaskSources(f.ctx);
  const s = await readTaskStore(f.ctx.path); assert.equal(s.events.length, 4); assert.equal(s.occurrences.length, 2);
});
test("dedup tuples distinguish colon aliases across owner domains without exposing foreign IDs", async () => {
  const f = await fixture();
  const actors = await Promise.all(["domain-a", "domain-b"].map((domain, i) => mintTaskCredential(f.ctx.authPath, { actor_id: `actor-${i}`, domains: [domain], role: "owner" })));
  const ids = ["collision:a", "collision"]; const keys = ["b", "a:b"]; const returned: string[] = [];
  for (let i = 0; i < 2; i++) {
    const auth = `Bearer ${actors[i].token}`;
    await callTaskCrud(f.ctx, auth, "task_source_register", { ...f.source, id: ids[i], producer_actor: `actor-${i}`, owner_domains: [`domain-${i === 0 ? "a" : "b"}`] });
    const result = await callTaskCrud(f.ctx, auth, "task_event", { source_id: ids[i], source_revision: 0, dedup_key: keys[i], value: "same", state_updated_at: 1000 }) as any;
    returned.push(result.event_id);
  }
  const s = await readTaskStore(f.ctx.path); assert.equal(s.events.length, 2); assert.notEqual(returned[0], returned[1]);
  for (let i = 0; i < 2; i++) assert.equal(s.events.find(e => e.id === returned[i])!.source_id, ids[i]);
});
