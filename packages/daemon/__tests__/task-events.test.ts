import { readAppRecord, writeAppRecord } from "../src/app-record-store.js";
import "./tasks-opt-in.js";
import { test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs script, no declarations
import { dropCallerGitEnv } from "../../../scripts/caller-git-env.mjs";

// #1669: started without test-env.mjs, this file's git must still not reach a caller's GIT_DIR/GIT_WORK_TREE.
dropCallerGitEnv();
const TASK_TEST_REPO = fileURLToPath(new URL("../../../", import.meta.url));
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { evaluateTaskSnapshot, observeTaskSources, reconcileTaskTime, taskValueHash } from "../src/task-events.js";
import { ambiguousTaskCalendar, localWall, resolveTaskCalendar } from "../src/task-clock.js";
import { TASK_MAX_BYTES, emptyTaskStore } from "../src/task-schema.js";
import { cachedTaskSnapshot } from "../src/task-outbox.js";
import { notifyDueTasks } from "../src/task-notification.js";
import { startTaskRuntime } from "../src/task-runtime.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-events-"));
  let now = 1000;
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const auth = `Bearer ${owner.token}`;
  const agentAuth = `Bearer ${agent.token}`;
  const input = {
    idempotency_key: "fixture",
    original_request: "Evaluate",
    goal: "Evaluate",
    resolution_condition: "Owner evaluation",
    schedule: { kind: "instant", at: 2000 },
    timezone: "Europe/Madrid",
    scope: { kind: "personal", name: "fixture" },
    owner_domains: ["personal"],
    arm: true,
  };
  const source = {
    id: "source",
    kind: "event",
    producer_actor: "agent",
    owner_domains: ["personal"],
    sensitivity: "private",
    max_age_ms: 10000,
    enabled: true,
  };
  return {
    root,
    ctx,
    auth,
    agentAuth,
    input,
    source,
    setNow: (v: number) => {
      now = v;
    },
  };
}
test("persisted seven-day duration catches up once after restart and never says gate passed", async () => {
  const f = await fixture();
  const at = 1000 + 604800000;
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "duration", reference_at: 1000, duration_ms: 604800000, at },
  });
  f.setNow(at - 1);
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
  f.setNow(at + 10000);
  await Promise.all(Array.from({ length: 6 }, () => reconcileTaskTime(f.ctx)));
  let s = await readTaskStore(f.ctx.path);
  assert.equal(s.occurrences.length, 1);
  assert.match(s.occurrences[0].why, /not a passed/);
  f.setNow(1000);
  await reconcileTaskTime(f.ctx);
  s = await readTaskStore(f.ctx.path);
  assert.equal(s.occurrences.length, 1);
});
test("bounded elapsed recurrence catches up latest with missed slots and durable next instant", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    recurrence: { kind: "elapsed", interval: 1000, count: 5, catch_up: "latest" },
  });
  f.setNow(4500);
  let s = await reconcileTaskTime(f.ctx);
  assert.equal(s.occurrences.length, 1);
  assert.equal(s.occurrences[0].due_at, 4000);
  assert.equal(s.occurrences[0].missed_count, 2);
  assert.equal(s.tasks[0].next_slot?.at, 5000);
  f.setNow(9000);
  s = await reconcileTaskTime(f.ctx);
  assert.equal(s.occurrences.length, 2);
  assert.equal(s.tasks[0].slots_checked, 5);
  assert.equal(s.tasks[0].next_slot, undefined);
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 2);
});
test("Madrid gap rejects; overlap resolves earlier and cannot double fire; calendar days differ from durations", async () => {
  assert.throws(() => resolveTaskCalendar("2026-03-29T02:30:00", "Europe/Madrid"), { reason: "calendar_gap" });
  assert.equal(resolveTaskCalendar("2026-10-25T02:30:00", "Europe/Madrid").at, Date.parse("2026-10-25T00:30:00Z"));
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: {
      kind: "calendar",
      local_time: "2026-10-25T02:30:00",
      timezone: "Europe/Madrid",
      gap: "reject",
      overlap: "earlier",
      at: 0,
      offset_minutes: 0,
    },
    recurrence: { kind: "calendar", interval: 1, count: 2, catch_up: "latest" },
  });
  f.setNow(Date.parse("2026-10-25T00:30:00Z"));
  let s = await reconcileTaskTime(f.ctx);
  assert.equal(s.occurrences.length, 1);
  assert.equal(s.tasks[0].next_slot?.at, Date.parse("2026-10-26T01:30:00Z"));
  f.setNow(Date.parse("2026-10-25T01:30:00Z"));
  s = await reconcileTaskTime(f.ctx);
  assert.equal(s.occurrences.length, 1);
});
test("only owner registers exact producer; forged source=user and unknown/wrong actors denied", async () => {
  const f = await fixture();
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_source_register", f.source), { code: "forbidden" });
  await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  const event = { source_id: "source", source_revision: 0, dedup_key: "event-1", value: "yes", state_updated_at: 1000 };
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_event", event), { code: "forbidden" });
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_event", { ...event, source: "user" }));
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_event", { ...event, source_id: "unknown" }), {
    code: "forbidden",
  });
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", event);
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", event);
  assert.equal((await readTaskStore(f.ctx.path)).events.length, 1);
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_event", { ...event, value: "no" }), { code: "conflict" });
});
test("secret equals uses original hashes, not identical redaction placeholders", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  const a = "api_key=sk_" + "a".repeat(36);
  const b = "api_key=sk_" + "b".repeat(36);
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "equals", expected: a },
  });
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", {
    source_id: "source",
    source_revision: 0,
    dedup_key: "b",
    value: b,
    state_updated_at: 1000,
  });
  let s = await reconcileTaskTime(f.ctx);
  assert.equal(s.occurrences.length, 0);
  assert.equal(s.tasks[0].schedule.kind === "event" && s.tasks[0].schedule.expected, s.events[0].value);
  assert.ok(!(await readAppRecord("tasks", f.ctx.path)).includes(a));
  assert.ok(!(await readAppRecord("tasks", f.ctx.path)).includes(b));
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", {
    source_id: "source",
    source_revision: 0,
    dedup_key: "a",
    value: a,
    state_updated_at: 1000,
  });
  s = await reconcileTaskTime(f.ctx);
  assert.equal(s.occurrences.length, 1);
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", {
    source_id: "source",
    source_revision: 0,
    dedup_key: "same",
    value: a,
    state_updated_at: 1000,
  });
  s = await reconcileTaskTime(f.ctx);
  assert.equal(s.occurrences.length, 1);
  assert.equal(s.checkpoint, 3);
});
test("snoozed journal event remains eligible after checkpoint and restart", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  const t = (await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "yes" },
  })) as any;
  await callTaskCrud(f.ctx, f.auth, "task_snooze", {
    id: t.id,
    expected_revision: t.expected_revision,
    until: 2000,
  });
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", {
    source_id: "source",
    source_revision: 0,
    dedup_key: "event",
    value: "yes",
    state_updated_at: 1000,
  });
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
  f.setNow(2000);
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("actual registered file and Git ref observe bounded versions; symlink/escape failures are visible", async () => {
  const f = await fixture();
  const artifact = join(f.root, "artifact.txt");
  await writeFile(artifact, "initial");
  await callTaskCrud(f.ctx, f.auth, "task_source_register", {
    ...f.source,
    kind: "file",
    producer_actor: "task-source-reader",
    root: f.root,
    path: "artifact.txt",
  });
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "content-version", expected: taskValueHash("initial") },
  });
  await observeTaskSources(f.ctx);
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
  await writeFile(artifact, "changed");
  await observeTaskSources(f.ctx);
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
  await symlink(artifact, join(f.root, "link"));
  await callTaskCrud(f.ctx, f.auth, "task_source_register", {
    ...f.source,
    id: "unsafe",
    kind: "file",
    producer_actor: "task-source-reader",
    root: f.root,
    path: "link",
  });
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    idempotency_key: "unsafe",
    schedule: { kind: "event", source_id: "unsafe", predicate: "content-version", expected: "old" },
  });
  await observeTaskSources(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).tasks[1].last_failure?.code, "source_unavailable");
  const repo = join(f.root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "fixture", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await callTaskCrud(f.ctx, f.auth, "task_source_register", {
    ...f.source,
    id: "git",
    kind: "git",
    producer_actor: "task-source-reader",
    root: repo,
    ref: "refs/heads/fixture",
  });
  await observeTaskSources(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).events.at(-1)?.value, head);
});
test("journal beyond a tick budget advances, is fair, and cannot duplicate material values", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "due" },
  });
  for (let i = 0; i < 110; i++)
    await callTaskCrud(f.ctx, f.agentAuth, "task_event", {
      source_id: "source",
      source_revision: 0,
      dedup_key: `e-${i}`,
      value: i === 109 ? "due" : "unchanged",
      state_updated_at: 1000,
    });
  for (let i = 0; i < 11; i++) await reconcileTaskTime(f.ctx);
  const s = await readTaskStore(f.ctx.path);
  assert.equal(s.occurrences.length, 1);
  assert.equal(s.checkpoint, 110);
});
test("legacy v1 missing source registry migrates additively and missing secret hash never fires", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "masked" },
  });
  const original = JSON.parse(await readAppRecord("tasks", f.ctx.path));
  delete original.sources;
  delete original.evaluation_cursor;
  delete original.tasks[0].schedule.expected_hash;
  await writeAppRecord("tasks", f.ctx.path, JSON.stringify(original));
  assert.deepEqual((await readTaskStore(f.ctx.path)).sources, []);
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
});
test("file A B A B records four observations and two changes; raw baseline needs no hashing", async () => {
  const f = await fixture();
  const path = join(f.root, "sequence.txt");
  await writeFile(path, "A");
  await callTaskCrud(f.ctx, f.auth, "task_source_register", {
    ...f.source,
    kind: "file",
    producer_actor: "task-source-reader",
    root: f.root,
    path: "sequence.txt",
  });
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "content-version", expected: "A" },
  });
  for (const value of ["A", "B", "A", "B"]) {
    await writeFile(path, value);
    await observeTaskSources(f.ctx);
    await reconcileTaskTime(f.ctx);
  }
  await observeTaskSources(f.ctx);
  await reconcileTaskTime(f.ctx);
  const s = await readTaskStore(f.ctx.path);
  assert.equal(s.events.length, 4);
  assert.equal(s.occurrences.length, 2);
  assert.equal(s.sources[0].observation_number, 4);
});
test("events before owner arming never fire; reconcile rejects agents and owners outside task domains", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", {
    source_id: "source",
    source_revision: 0,
    dedup_key: "old",
    value: "yes",
    state_updated_at: 1000,
  });
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "yes" },
  });
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
  await assert.rejects(callTaskCrud(f.ctx, f.agentAuth, "task_reconcile", {}), { code: "forbidden" });
  const other = await mintTaskCredential(f.ctx.authPath, { actor_id: "other", domains: ["other"], role: "owner" });
  await assert.rejects(callTaskCrud(f.ctx, `Bearer ${other.token}`, "task_reconcile", {}), { code: "forbidden" });
});
test("calendar recurrence shifts its later gap slot past the gap and clock rollback cannot duplicate a saved slot", async () => {
  const f = await fixture();
  const at = resolveTaskCalendar("2026-03-28T02:30:00", "Europe/Madrid").at;
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: {
      kind: "calendar",
      local_time: "2026-03-28T02:30:00",
      timezone: "Europe/Madrid",
      gap: "reject",
      overlap: "earlier",
      at,
      offset_minutes: 60,
    },
    recurrence: { kind: "calendar", interval: 1, count: 3, catch_up: "latest" },
  });
  f.setNow(at);
  const s = await reconcileTaskTime(f.ctx);
  assert.equal(s.tasks[0].armed, true);
  assert.equal(s.tasks[0].last_failure, undefined);
  assert.equal(s.tasks[0].next_slot?.local_time, "2026-03-29T02:30:00");
  assert.equal(localWall(s.tasks[0].next_slot!.at, "Europe/Madrid"), "2026-03-29T03:30:00");
  assert.equal(s.occurrences.length, 1);
  f.setNow(at - 86400000);
  await reconcileTaskTime(f.ctx);
  f.setNow(at);
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("two real processes reconcile the same time slot exactly once", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_create", f.input);
  const { spawn } = await import("node:child_process");
  const program =
    'import {reconcileTaskTime} from "./packages/daemon/src/task-events.ts"; const ctx=JSON.parse(process.env.BASTRA_TEST_TASK_CTX); await reconcileTaskTime({...ctx,now:()=>5000});';
  const workers = [0, 1].map(() =>
    spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
      cwd: TASK_TEST_REPO,
      env: { ...process.env, BASTRA_TEST_TASK_CTX: JSON.stringify(f.ctx) },
      stdio: ["ignore", "ignore", "pipe"],
    })
  );
  for (const child of workers) child.stderr!.resume();
  const outcomes = await Promise.all(workers.map((child) => once(child, "close")));
  for (const [code] of outcomes) assert.equal(code, 0);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("process dies after journal commit before checkpoint; restart evaluates the preserved event once", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "yes" },
  });
  const { spawn } = await import("node:child_process");
  const program =
    'import {submitTaskEvent} from "./packages/daemon/src/task-events.ts"; const ctx=JSON.parse(process.env.BASTRA_TEST_TASK_CTX); await submitTaskEvent({...ctx,now:()=>1000},process.env.BASTRA_TEST_EVENT_AUTH,{source_id:"source",source_revision:0,dedup_key:"crash",value:"yes",state_updated_at:1000}); process.kill(process.pid,"SIGKILL");';
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
    cwd: TASK_TEST_REPO,
    env: { ...process.env, BASTRA_TEST_TASK_CTX: JSON.stringify(f.ctx), BASTRA_TEST_EVENT_AUTH: f.agentAuth },
    stdio: ["ignore", "ignore", "pipe"],
  });
  worker.stderr!.resume();
  const [, signal] = await once(worker, "close");
  assert.equal(signal, "SIGKILL");
  assert.equal((await readTaskStore(f.ctx.path)).checkpoint, 0);
  await reconcileTaskTime(f.ctx);
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("Git A B A B produces four journal events, unchanged polls stay quiet", async () => {
  const f = await fixture();
  const repo = join(f.root, "git-cycle");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "fixture", repo]);
  const commit = (name: string) => {
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      name,
    ]);
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  };
  const a = commit("A");
  const b = commit("B");
  await callTaskCrud(f.ctx, f.auth, "task_source_register", {
    ...f.source,
    kind: "git",
    producer_actor: "task-source-reader",
    root: repo,
    ref: "refs/heads/fixture",
  });
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "git-ref", expected: a },
  });
  for (const value of [a, b, a, b]) {
    execFileSync("git", ["-C", repo, "update-ref", "refs/heads/fixture", value]);
    await observeTaskSources(f.ctx);
    await reconcileTaskTime(f.ctx);
  }
  await observeTaskSources(f.ctx);
  const s = await readTaskStore(f.ctx.path);
  assert.equal(s.events.length, 4);
  assert.equal(s.occurrences.length, 2);
});
test("dedup tuples distinguish colon aliases across owner domains without exposing foreign IDs", async () => {
  const f = await fixture();
  const actors = await Promise.all(
    ["domain-a", "domain-b"].map((domain, i) =>
      mintTaskCredential(f.ctx.authPath, { actor_id: `actor-${i}`, domains: [domain], role: "owner" })
    )
  );
  const ids = ["collision:a", "collision"];
  const keys = ["b", "a:b"];
  const returned: string[] = [];
  for (let i = 0; i < 2; i++) {
    const auth = `Bearer ${actors[i].token}`;
    await callTaskCrud(f.ctx, auth, "task_source_register", {
      ...f.source,
      id: ids[i],
      producer_actor: `actor-${i}`,
      owner_domains: [`domain-${i === 0 ? "a" : "b"}`],
    });
    const result = (await callTaskCrud(f.ctx, auth, "task_event", {
      source_id: ids[i],
      source_revision: 0,
      dedup_key: keys[i],
      value: "same",
      state_updated_at: 1000,
    })) as any;
    returned.push(result.event_id);
  }
  const s = await readTaskStore(f.ctx.path);
  assert.equal(s.events.length, 2);
  assert.notEqual(returned[0], returned[1]);
  for (let i = 0; i < 2; i++) assert.equal(s.events.find((e) => e.id === returned[i])!.source_id, ids[i]);
});
test("legacy dedup lookup preserves own IDs but never accepts another source's colon alias", async () => {
  const f = await fixture();
  for (const id of ["collision:a", "collision"])
    await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, id, producer_actor: "owner" });
  const first = { source_id: "collision:a", source_revision: 0, dedup_key: "b", value: "same", state_updated_at: 1000 };
  await callTaskCrud(f.ctx, f.auth, "task_event", first);
  const s = await readTaskStore(f.ctx.path);
  const legacy = taskValueHash("collision:a:b");
  s.events[0].id = legacy;
  s.events[0].dedup_key = legacy;
  await writeAppRecord("tasks", f.ctx.path, JSON.stringify(s));
  assert.equal(((await callTaskCrud(f.ctx, f.auth, "task_event", first)) as any).event_id, legacy);
  const second = (await callTaskCrud(f.ctx, f.auth, "task_event", {
    ...first,
    source_id: "collision",
    dedup_key: "a:b",
  })) as any;
  assert.notEqual(second.event_id, legacy);
  assert.equal((await readTaskStore(f.ctx.path)).events.length, 2);
});
const DAY = 86400000;
async function dailySeries(f: Awaited<ReturnType<typeof fixture>>, fired: number) {
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    recurrence: { kind: "elapsed", interval: DAY, catch_up: "latest" },
  });
  for (let d = 0; d < fired; d++) {
    f.setNow(2000 + d * DAY + 1000);
    await reconcileTaskTime(f.ctx);
  }
  const s = await readTaskStore(f.ctx.path);
  return { store: s, id: s.tasks[0].id };
}
test("#1586 editing a non-schedule trigger field never re-fires an acknowledged slot", async () => {
  const f = await fixture();
  const { store, id } = await dailySeries(f, 3);
  assert.equal(store.occurrences.length, 3);
  let t = (await callTaskCrud(f.ctx, f.auth, "task_get", { id })) as any;
  t = await callTaskCrud(f.ctx, f.auth, "task_acknowledge", {
    id,
    expected_revision: t.expected_revision,
    occurrence_id: store.occurrences.at(-1)!.id,
  });
  for (const patch of [{ scope: { kind: "personal", name: "renamed" } }, { expires_at: 2000 + 400 * DAY }]) {
    t = await callTaskCrud(f.ctx, f.auth, "task_edit", { id, expected_revision: t.expected_revision, patch });
    await reconcileTaskTime(f.ctx);
    t = await callTaskCrud(f.ctx, f.auth, "task_get", { id });
  }
  let s = await readTaskStore(f.ctx.path);
  assert.equal(s.tasks[0].generation, 2, "trigger edits still bump the generation");
  assert.equal(s.occurrences.length, 3, "the delivered slot is not fired again");
  f.setNow(2000 + 3 * DAY + 1000);
  await reconcileTaskTime(f.ctx);
  s = await readTaskStore(f.ctx.path);
  assert.equal(s.occurrences.length, 4);
  assert.equal(s.occurrences.at(-1)!.missed_count, 0);
  assert.equal(s.occurrences.at(-1)!.due_at, 2000 + 3 * DAY);
});
test("#1586 an open reminder stays visible once after a trigger edit, without a false missed count", async () => {
  const f = await fixture();
  const { id } = await dailySeries(f, 3);
  const t = (await callTaskCrud(f.ctx, f.auth, "task_get", { id })) as any;
  await callTaskCrud(f.ctx, f.auth, "task_edit", {
    id,
    expected_revision: t.expected_revision,
    patch: { scope: { kind: "personal", name: "renamed" } },
  });
  await reconcileTaskTime(f.ctx);
  await reconcileTaskTime(f.ctx);
  const s = await readTaskStore(f.ctx.path);
  const current = s.occurrences.filter((o) => o.generation === s.tasks[0].generation);
  assert.equal(current.length, 1);
  assert.equal(current[0].due_at, 2000 + 2 * DAY);
  assert.equal(current[0].missed_count, 0);
  assert.equal(s.tasks[0].state, "due");
});
test("#1586 a schedule edit still resets the slot cursor", async () => {
  const f = await fixture();
  const { id } = await dailySeries(f, 3);
  const t = (await callTaskCrud(f.ctx, f.auth, "task_get", { id })) as any;
  await callTaskCrud(f.ctx, f.auth, "task_edit", {
    id,
    expected_revision: t.expected_revision,
    patch: { recurrence: { kind: "elapsed", interval: 2 * DAY, catch_up: "latest" } },
  });
  const s = await readTaskStore(f.ctx.path);
  assert.equal(s.tasks[0].slots_checked, undefined);
  assert.equal(s.tasks[0].next_slot, undefined);
});
function calendarSeries(local: string, timezone: string) {
  const task: any = {
    id: "t1",
    generation: 0,
    revision: 0,
    history: [],
    state: "pending",
    armed: true,
    owner_domains: ["d"],
    timezone,
    evidence: [],
    schedule: {
      kind: "calendar",
      at: resolveTaskCalendar(local, timezone).at,
      local_time: local,
      timezone,
      gap: "reject",
      overlap: "earlier",
    },
    recurrence: { kind: "calendar", interval: 1, catch_up: "latest" },
  };
  const store: any = emptyTaskStore();
  store.tasks.push(task);
  return { task, store };
}
// Evaluates every 5 minutes across the change days; every slot must fire exactly once.
function runSeries(local: string, timezone: string, from: string, to: string) {
  const { task, store } = calendarSeries(local, timezone);
  for (let now = Date.parse(from); now <= Date.parse(to); now += 300000) {
    evaluateTaskSnapshot(store, now);
    if (task.state === "due") task.state = "pending";
  }
  return { task, store };
}
const dayOf = (day: string, delta: number) => new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY).toISOString();
function assertDaily(store: any, first: string, days: number, local: string) {
  const keys = store.occurrences.map((o: any) => o.event_key);
  assert.equal(new Set(keys).size, keys.length, "no slot fires twice");
  for (let d = 0; d < days; d++) assert.ok(keys.includes(`time:${dayOf(first, d).slice(0, 10)}T${local}`), `day ${d}`);
}
for (const [timezone, gapDay, overlapDay, local, overlapLocal] of [
  ["Europe/Berlin", "2027-03-28", "2027-10-31", "02:30:00", "02:30:00"],
  ["America/New_York", "2027-03-14", "2027-11-07", "02:30:00", "01:30:00"],
  ["Australia/Lord_Howe", "2027-10-03", "2027-04-04", "02:15:00", "01:45:00"],
] as const) {
  test(`#1585 a daily series over the ${timezone} DST gap fires once right after the gap and stays armed`, () => {
    const start = dayOf(gapDay, -3).slice(0, 10);
    const { task, store } = runSeries(`${start}T${local}`, timezone, dayOf(start, -1), dayOf(gapDay, 3));
    assert.equal(task.armed, true);
    assert.equal(task.last_failure, undefined);
    assertDaily(store, start, 6, local);
    assert.throws(() => resolveTaskCalendar(`${gapDay}T${local}`, timezone), { reason: "calendar_gap" });
    const gap = store.occurrences.find((o: any) => o.event_key === `time:${gapDay}T${local}`);
    assert.ok(gap, "the gap day still gets its reminder");
    assert.ok(localWall(gap.due_at, timezone) > `${gapDay}T${local}`, "it fires after the gap");
    assert.ok(gap.due_at - resolveTaskCalendar(`${dayOf(gapDay, -1).slice(0, 10)}T${local}`, timezone).at <= DAY);
  });
  test(`#1585 a daily series over the ${timezone} repeated hour fires once, at the earlier instant`, () => {
    const start = dayOf(overlapDay, -2).slice(0, 10);
    const { task, store } = runSeries(`${start}T${overlapLocal}`, timezone, dayOf(start, -1), dayOf(overlapDay, 3));
    assert.equal(task.armed, true);
    assertDaily(store, start, 5, overlapLocal);
    const overlap = store.occurrences.find((o: any) => o.event_key === `time:${overlapDay}T${overlapLocal}`);
    assert.ok(ambiguousTaskCalendar(`${overlapDay}T${overlapLocal}`, timezone), "the fixture hits the repeated hour");
    assert.equal(overlap.due_at, resolveTaskCalendar(`${overlapDay}T${overlapLocal}`, timezone).at);
  });
}
test("#1585 a one-off calendar time in a DST gap is still rejected", () => {
  assert.throws(() => resolveTaskCalendar("2027-03-28T02:30:00", "Europe/Berlin"), { reason: "calendar_gap" });
});
async function fullHistoryFixture(rows: number) {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    idempotency_key: "series",
    goal: "Every minute",
    recurrence: { kind: "elapsed", interval: 60000, catch_up: "latest" },
  });
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    idempotency_key: "once",
    goal: "One reminder",
    original_request: "One reminder",
    schedule: { kind: "instant", at: 500000 },
  });
  const s = await readTaskStore(f.ctx.path);
  const series = s.tasks.find((t) => t.goal === "Every minute")!;
  const row = series.history[0];
  while (series.history.length < rows) series.history.push({ ...row, operation: "fire", reason: "fire" });
  await writeAppRecord("tasks", f.ctx.path, JSON.stringify(s));
  f.setNow(600000);
  return { f, seriesId: series.id };
}
test("#1581 a series at its history reserve stops visibly and never blocks other tasks", async () => {
  const { f, seriesId } = await fullHistoryFixture(9899);
  const s = await reconcileTaskTime(f.ctx);
  const series = s.tasks.find((t) => t.id === seriesId)!;
  assert.equal(series.armed, false);
  assert.equal(series.last_failure?.code, "history_capacity");
  assert.ok(series.history.length <= 9900);
  const once = s.tasks.find((t) => t.goal === "One reminder")!;
  assert.equal(once.state, "due", "the unrelated one-shot reminder still fires");
  assert.equal(s.occurrences.filter((o) => o.task_id === once.id).length, 1);
});
test("#1581 a task already past the reserve does not stop time evaluation for every task", async () => {
  const { f, seriesId } = await fullHistoryFixture(9901);
  const s = await reconcileTaskTime(f.ctx);
  assert.equal(s.tasks.find((t) => t.goal === "One reminder")!.state, "due");
  assert.equal(s.tasks.find((t) => t.id === seriesId)!.history.length, 9902);
  assert.equal(s.tasks.find((t) => t.id === seriesId)!.armed, false);
  assert.equal(s.tasks.find((t) => t.id === seriesId)!.last_failure?.code, "history_capacity");
});
const NORMAL_LIMIT = (4 * 1024 * 1024 * 3) / 4;
/** Pads the store to exactly `target` bytes with history rows of one task. */
async function padStore(path: string, taskId: string, target: number) {
  const s = await readTaskStore(path);
  const task = s.tasks.find((t) => t.id === taskId)!;
  const row = { ...task.history[0], operation: "pad", reason: "x".repeat(2000) };
  const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
  // Leaves between 300 bytes and one row for the last row, whose reason fits its 4096 limit.
  const count = Math.floor((target - Buffer.byteLength(JSON.stringify(s)) - 300) / rowBytes);
  for (let i = 0; i < count; i++) task.history.push({ ...row });
  const last = { ...row, reason: "x" };
  task.history.push(last);
  last.reason = "x".repeat(target - Buffer.byteLength(JSON.stringify(s)) + 1);
  const raw = JSON.stringify(s);
  assert.equal(Buffer.byteLength(raw), target);
  await writeAppRecord("tasks", path, raw);
}
const storeBytes = (path: string) => Buffer.byteLength(readAppRecord("tasks", path));
test("#1599 the automatic evaluation does not use the owner's control reserve", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_source_register", f.source);
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "yes" },
  });
  await callTaskCrud(f.ctx, f.agentAuth, "task_event", {
    source_id: "source",
    source_revision: 0,
    dedup_key: "e1",
    value: "yes",
    state_updated_at: 1000,
  });
  const id = (await readTaskStore(f.ctx.path)).tasks[0].id;
  await padStore(f.ctx.path, id, NORMAL_LIMIT - 50);
  f.setNow(3000);
  await assert.rejects(reconcileTaskTime(f.ctx), { code: "capacity" });
  const s = await readTaskStore(f.ctx.path);
  assert.equal(s.occurrences.length, 0, "the refused event evaluation wrote nothing");
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= NORMAL_LIMIT);
  // The reserve above the normal limit is still there for the owner.
  await callTaskCrud(f.ctx, f.auth, "task_cancel", {
    id,
    expected_revision: `${s.recovery_epoch}:${s.tasks[0].revision}`,
  });
  assert.equal((await readTaskStore(f.ctx.path)).tasks[0].state, "cancelled");
});
test("#1599 a full store does not hide an already scheduled reminder from next contact", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_create", f.input);
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    idempotency_key: "later",
    schedule: { kind: "instant", at: 4000 },
  });
  f.setNow(3000);
  const before = await reconcileTaskTime(f.ctx);
  assert.equal(before.occurrences.length, 1);
  await padStore(f.ctx.path, before.tasks[1].id, NORMAL_LIMIT - 50);

  f.setNow(5000);
  const runtime = startTaskRuntime(f.ctx);
  try {
    await runtime.ready;
    assert.equal(runtime.lastError, "capacity");
    assert.equal(cachedTaskSnapshot(f.ctx.path)?.occurrences[0]?.id, before.occurrences[0].id);
  } finally {
    runtime.stop();
    await runtime.settle();
  }
});
test("a time reminder that becomes due in a full store fires from the reserve", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_create", f.input);
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    idempotency_key: "later",
    goal: "Later",
    schedule: { kind: "instant", at: 4000 },
  });
  f.setNow(3000);
  const before = await reconcileTaskTime(f.ctx);
  assert.equal(before.occurrences.length, 1);
  await padStore(f.ctx.path, before.tasks[0].id, NORMAL_LIMIT - 50);
  f.setNow(5000);
  await assert.rejects(reconcileTaskTime(f.ctx), { code: "capacity" });
  const s = await readTaskStore(f.ctx.path);
  const later = s.tasks.find((t) => t.goal === "Later")!;
  assert.equal(later.state, "due");
  assert.equal(s.occurrences.filter((o) => o.task_id === later.id).length, 1);
  assert.ok(storeBytes(f.ctx.path) > NORMAL_LIMIT, "it used the reserve");
  // A second pass has nothing to write and does not fire it again.
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 2);
});
test("#1599 above the normal limit the evaluation still switches a full task off with one audit row", async () => {
  const { f, seriesId } = await fullHistoryFixture(9899);
  const once = (await readTaskStore(f.ctx.path)).tasks.find((t) => t.goal === "One reminder")!;
  await padStore(f.ctx.path, once.id, NORMAL_LIMIT - 50);
  await assert.rejects(reconcileTaskTime(f.ctx), { code: "capacity" });
  const s = await readTaskStore(f.ctx.path);
  const series = s.tasks.find((t) => t.id === seriesId)!;
  assert.equal(series.armed, false);
  assert.equal(series.last_failure?.code, "history_capacity");
  assert.equal(series.history.length, 9900, "exactly one audit row");
  // Besides that row, only the due one-shot reminder used the reserve.
  assert.deepEqual(
    s.occurrences.map((o) => o.task_id),
    [once.id]
  );
});
test("#1599 deleting a task is allowed above the normal limit because it makes the store smaller", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_create", f.input);
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, idempotency_key: "second", goal: "Second" });
  const first = (await readTaskStore(f.ctx.path)).tasks[0];
  await padStore(f.ctx.path, first.id, NORMAL_LIMIT + 100_000);
  const s = await readTaskStore(f.ctx.path);
  await callTaskCrud(f.ctx, f.auth, "task_delete", {
    id: first.id,
    expected_revision: `${s.recovery_epoch}:${s.tasks[0].revision}`,
  });
  const after = await readTaskStore(f.ctx.path);
  assert.deepEqual(
    after.tasks.map((t) => t.goal),
    ["Second"]
  );
  assert.ok(storeBytes(f.ctx.path) < NORMAL_LIMIT);
});

test("near the hard limit each full-task audit competes independently and due slots retry", async () => {
  const { f, seriesId } = await fullHistoryFixture(9899);
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    idempotency_key: "second-series",
    goal: "Second full series",
    recurrence: { kind: "elapsed", interval: 60000, catch_up: "latest" },
  });
  const full = await readTaskStore(f.ctx.path);
  const second = full.tasks.find((t) => t.goal === "Second full series")!;
  second.history = full.tasks.find((t) => t.id === seriesId)!.history;
  await writeAppRecord("tasks", f.ctx.path, JSON.stringify(full));
  const once = full.tasks.find((t) => t.goal === "One reminder")!;
  await padStore(f.ctx.path, once.id, TASK_MAX_BYTES - 345);

  await assert.rejects(reconcileTaskTime(f.ctx), { code: "capacity" });
  const after = await readTaskStore(f.ctx.path);
  const series = after.tasks.find((t) => t.id === seriesId)!;
  assert.equal(series.armed, false);
  assert.equal(series.history.at(-1)?.operation, "history-full");
  assert.equal(after.tasks.find((t) => t.id === second.id)?.armed, true, "only one history audit fits");
  assert.equal(after.occurrences.length, 0);
  const pending = after.tasks.find((t) => t.id === once.id)!;
  assert.equal(pending.slots_checked ?? 0, 0, "the reminder stays eligible for a retry");
  await callTaskCrud(f.ctx, f.auth, "task_delete", {
    id: series.id,
    expected_revision: `${after.recovery_epoch}:${series.revision}`,
  });
  await reconcileTaskTime(f.ctx).catch((error) => {
    assert.equal(error.code, "capacity");
  });
  const retried = await readTaskStore(f.ctx.path);
  assert.deepEqual(
    retried.occurrences.map((o) => o.task_id),
    [once.id]
  );
  assert.equal(retried.tasks.find((t) => t.id === second.id)?.history.at(-1)?.operation, "history-full");
  const state = (await callTaskCrud(f.ctx, f.auth, "task_get", { id: once.id })) as { state: string };
  assert.equal(state.state, "due");
  await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1, "a later pass does not duplicate delivery");
});

test("a frequent series can use a reminder reserve without spending the owner's control reserve", async () => {
  const f = await fixture();
  await callTaskCrud(f.ctx, f.auth, "task_create", {
    ...f.input,
    recurrence: { kind: "elapsed", interval: 1000, catch_up: "latest" },
  });
  const id = (await readTaskStore(f.ctx.path)).tasks[0].id;
  const reminderLimit = (TASK_MAX_BYTES * 7) / 8;
  await padStore(f.ctx.path, id, reminderLimit - 650);

  f.setNow(2000);
  await assert.rejects(reconcileTaskTime(f.ctx), { code: "capacity" });
  let state = await readTaskStore(f.ctx.path);
  assert.equal(state.occurrences.length, 1);
  const delivered: string[] = [];
  const options = {
    platform: "darwin",
    enabled: true,
    send: async (message: { body: string }) => void delivered.push(message.body),
  } as const;
  await notifyDueTasks(f.ctx, options);
  assert.deepEqual(delivered, [f.input.goal]);
  for (const now of [3000, 4000]) {
    f.setNow(now);
    await assert.rejects(reconcileTaskTime(f.ctx), { code: "capacity" });
  }
  state = await readTaskStore(f.ctx.path);
  await notifyDueTasks(f.ctx, options);
  assert.deepEqual(delivered, [f.input.goal], "the prior reminder is not delivered again");
  assert.equal(state.occurrences.length, 1, "no automatic write can fill the control reserve");
  assert.equal(state.tasks[0].next_slot?.at, 3000);
  assert.ok(storeBytes(f.ctx.path) <= reminderLimit);
  await callTaskCrud(f.ctx, f.auth, "task_resolve", {
    id,
    occurrence_id: state.occurrences[0].id,
    expected_revision: `${state.recovery_epoch}:${state.tasks[0].revision}`,
  });
  state = await readTaskStore(f.ctx.path);
  await callTaskCrud(f.ctx, f.auth, "task_cancel", {
    id,
    expected_revision: `${state.recovery_epoch}:${state.tasks[0].revision}`,
  });
  state = await readTaskStore(f.ctx.path);
  assert.equal(state.tasks[0].state, "cancelled");
  await callTaskCrud(f.ctx, f.auth, "task_archive", {
    task_ids: [id],
    expected_revision: state.revision,
    recovery_epoch: state.recovery_epoch,
  });
  assert.deepEqual((await readTaskStore(f.ctx.path)).tasks, []);
});
