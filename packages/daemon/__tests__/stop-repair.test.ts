/**
 * #1311 — bounded repair in the Stop lane for approved-copy tasks.
 *
 * An approved-copy task whose active conventions require a validator and that
 * has no receipt (#1310) for its task id and generation gets a same-turn
 * instruction to run validate_artifact — twice per task, then one
 * `non_conformance` row (`repair_exhausted`) and `{}`. The count is per task,
 * not per hash, and expires with the task. Codex gets no repair; nothing ever
 * carries `decision: "block"`.
 *
 * Revert-check: move the repair check behind the `stop_hook_active` guard —
 * the second request goes red; drop the `count > REPAIR_MAX_ATTEMPTS` bound —
 * the termination case goes red; drop `delete state.repairAttempts` from
 * bumpTaskGeneration and the binding check in stop-repair.ts — the expiry
 * case goes red.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/stop-repair.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { withPathLock } from "../src/path-lock.js";
import { checkStopRepair } from "../src/stop-repair.js";
import { join } from "node:path";
import { runStopLane, type ClaudeStopPayload } from "../src/stop-lane.js";
import { expireReceipts } from "../src/receipt-store.js";
import { REPAIR_INSTRUCTION } from "../src/stop-lane-same-turn.js";
import { bumpTaskGeneration, loadSessionState, mutateSessionState, taskIdFor, type ActiveConvention } from "../src/session-state.js";

const TRANSCRIPT = [
  { role: "user", content: "passt so, schick es raus" },
  { role: "assistant", content: "Hallo Sam, das Paket kommt am Dienstag." },
];
const VALIDATOR = { tool: "validate_artifact", channel: "discord-dm", limit: 2000, unit: "utf16" };

async function withSandbox<T>(fn: (dir: string) => Promise<T>, extraEnv: Record<string, string> = {}): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-stop-repair-"));
  const env: Record<string, string> = {
    BASTRA_TELEMETRY: "on",
    BASTRA_LOG_PATH: join(dir, "logs"),
    BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"),
    BASTRA_HOOK_STATE_DIR: join(dir, "state"),
    HOME: dir,
    USERPROFILE: dir,
    ...extraEnv,
  };
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn(dir);
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(
  sid: string,
  opts: { kind?: "approved-copy" | "draft-for-review"; validator?: boolean; since?: number; generation?: number } = {},
): Promise<string> {
  const kind = opts.kind ?? "approved-copy";
  const since = opts.since ?? 1000;
  const id = taskIdFor(kind, since);
  await mutateSessionState(sid, (s) => {
    s.activeTask = { id, kind, since, generation: opts.generation ?? 0 };
    const conv: ActiveConvention = { id: "nachrichtenkonvention", revision: null, setAt: since, scope: "task" };
    if (opts.validator !== false) conv.validator = VALIDATOR;
    s.activeConventions = [conv];
  });
  return id;
}

async function addReceipt(sid: string, taskId: string, generation: number, hash = "a".repeat(64)): Promise<void> {
  await mutateSessionState(sid, (s) => {
    (s.receipts ??= []).push({ taskId, generation, hash, receipt: `sha256:${hash}`, channel: "discord-dm", limit: 2000, unit: "max(codepoints,utf16)", at: 1 });
  });
}

function stop(sid: string, extra: Partial<ClaudeStopPayload> & Record<string, unknown> = {}): Promise<string> {
  return runStopLane(
    { hook_event_name: "Stop", session_id: sid, cwd: process.cwd(), transcript: TRANSCRIPT, ...extra } as ClaudeStopPayload,
    "http://127.0.0.1:1",
  );
}

type Out = { systemMessage?: string; decision?: string; hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };

function assertRequest(raw: string, attempt: number): void {
  const out = JSON.parse(raw) as Out;
  assert.equal(out.decision, undefined, "never a block decision");
  assert.equal(out.hookSpecificOutput?.hookEventName, "Stop");
  const ctx = out.hookSpecificOutput?.additionalContext ?? "";
  assert.ok(ctx.includes(REPAIR_INSTRUCTION), ctx);
  assert.match(ctx, new RegExp(`attempt="${attempt}/2"`));
  assert.ok(out.systemMessage);
}

async function nonConformance(dir: string): Promise<Record<string, unknown>[]> {
  const logDir = join(dir, "logs");
  const rows: Record<string, unknown>[] = [];
  for (const f of (await readdir(logDir).catch(() => [] as string[])).filter((n) => n.startsWith("events-"))) {
    for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (l.trim()) rows.push(JSON.parse(l) as Record<string, unknown>);
    }
  }
  return rows.filter((r) => r.kind === "non_conformance");
}

test("#1311 — no validator required (or no copy task): Stop behaves exactly as before", async () => {
  await withSandbox(async (dir) => {
    await seed("rp-novalidator", { validator: false });
    await seed("rp-draft", { kind: "draft-for-review", validator: false });
    for (const sid of ["rp-novalidator", "rp-draft", "rp-empty"]) {
      assert.equal(await stop(sid, { stop_hook_active: true }), "{}", sid);
      assert.equal((await loadSessionState(sid)).repairAttempts, undefined, sid);
    }
    assert.deepEqual(await nonConformance(dir), []);
  });
});

test("#1311 — approved-copy without receipt: request 1, request 2, then {} + repair_exhausted, then silent", async () => {
  await withSandbox(async (dir) => {
    const taskId = await seed("rp-loop");
    assertRequest(await stop("rp-loop"), 1);
    assertRequest(await stop("rp-loop", { stop_hook_active: true }), 2);
    assert.equal(await stop("rp-loop", { stop_hook_active: true }), "{}");
    const rows = await nonConformance(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "repair_exhausted");
    assert.equal(rows[0].session_id, "rp-loop");
    assert.equal(rows[0].task_id, taskId);
    assert.equal(rows[0].attempts, 2);
    // Terminated: further Stops of the same task neither ask nor log again.
    assert.equal(await stop("rp-loop", { stop_hook_active: true }), "{}");
    assert.equal((await nonConformance(dir)).length, 1);
  });
});

test("#1311 — a new artifact hash does not reset the count; a stale-generation receipt does not count", async () => {
  await withSandbox(async () => {
    const taskId = await seed("rp-hash", { generation: 1 });
    assertRequest(await stop("rp-hash"), 1);
    await addReceipt("rp-hash", taskId, 0, "b".repeat(64));
    assertRequest(await stop("rp-hash", { stop_hook_active: true }), 2);
    assert.equal(await stop("rp-hash", { stop_hook_active: true }), "{}");
  });
});

test("#1311 — a valid receipt for the current task and generation suppresses repair", async () => {
  await withSandbox(async (dir) => {
    const taskId = await seed("rp-ok", { generation: 2 });
    await addReceipt("rp-ok", taskId, 2);
    assert.equal(await stop("rp-ok", { stop_hook_active: true }), "{}");
    assert.equal((await loadSessionState("rp-ok")).repairAttempts, undefined);
    // A receipt that lands after the first request ends the repair.
    const other = await seed("rp-late");
    assertRequest(await stop("rp-late"), 1);
    await addReceipt("rp-late", other, 0);
    assert.equal(await stop("rp-late", { stop_hook_active: true }), "{}");
    assert.deepEqual(await nonConformance(dir), []);
  });
});

test("#1311 — the count expires with the task: new generation and new task start over", async () => {
  await withSandbox(async () => {
    await seed("rp-expire");
    assertRequest(await stop("rp-expire"), 1);
    assertRequest(await stop("rp-expire", { stop_hook_active: true }), 2);
    assert.equal(await stop("rp-expire", { stop_hook_active: true }), "{}");
    await bumpTaskGeneration("rp-expire");
    assert.equal((await loadSessionState("rp-expire")).repairAttempts, undefined);
    assertRequest(await stop("rp-expire"), 1);
    // A new task (prompt-task.ts calls expireReceipts on every kind change).
    await mutateSessionState("rp-expire", (s) => {
      s.activeTask = { id: taskIdFor("approved-copy", 5000), kind: "approved-copy", since: 5000, generation: 1 };
      expireReceipts(s);
    });
    assert.equal((await loadSessionState("rp-expire")).repairAttempts, undefined);
    assertRequest(await stop("rp-expire"), 1);
  });
});

test("#1311 — Codex and the same-turn off switch get no repair", async () => {
  await withSandbox(async () => {
    await seed("rp-codex");
    assert.equal(await stop("rp-codex", { stop_hook_active: true, bastra_client: "codex" }), "{}");
    assert.equal((await loadSessionState("rp-codex")).repairAttempts, undefined);
  });
  await withSandbox(async () => {
    await seed("rp-off");
    assert.equal(await stop("rp-off", { stop_hook_active: true }), "{}");
    assert.equal((await loadSessionState("rp-off")).repairAttempts, undefined);
  }, { BASTRA_STOP_SAME_TURN: "0" });
});

test("#1311 — the repair path stays inside the 1000 ms Stop budget", async () => {
  await withSandbox(async () => {
    await seed("rp-budget");
    for (const active of [false, true, true]) {
      const t0 = performance.now();
      await stop("rp-budget", { stop_hook_active: active });
      assert.ok(performance.now() - t0 < 1000, `Stop took ${performance.now() - t0} ms`);
    }
  });
});


test("#1311 — a busy session claim skips immediately and never writes a late repair count", async () => {
  await withSandbox(async (dir) => {
    await seed("rp-busy");
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const holder = withPathLock(join(dir, "state", "rp-busy.json"), async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    try {
      const started = performance.now();
      const result = await Promise.race([
        checkStopRepair({ hook_event_name: "Stop", session_id: "rp-busy" }),
        delay(1100).then(() => "timed-out"),
      ]);
      assert.equal(result, null, "busy claim must return without waiting for the holder");
      assert.ok(performance.now() - started < 1000);
    } finally {
      release();
      await holder;
    }
    // A timeout-only response would leave a queued callback writing here.
    await delay(20);
    assert.equal((await loadSessionState("rp-busy")).repairAttempts, undefined);
    assertRequest(await stop("rp-busy"), 1);
  });
});

test("#1311 — convention removal queued before repair cannot produce a stale-validator request", async () => {
  await withSandbox(async (dir) => {
    await seed("rp-removed");
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const holder = withPathLock(join(dir, "state", "rp-removed.json"), async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    const removal = mutateSessionState("rp-removed", (s) => { delete s.activeConventions; });
    const checking = checkStopRepair({ hook_event_name: "Stop", session_id: "rp-removed" });
    try {
      // The old implementation reads the validator snapshot, then queues behind removal.
      await delay(20);
    } finally {
      release();
      await holder;
    }
    await removal;
    assert.equal(await checking, null);
    assert.equal((await loadSessionState("rp-removed")).repairAttempts, undefined);
    assert.equal(await checkStopRepair({ hook_event_name: "Stop", session_id: "rp-removed" }), null);
  });
});

test("#1311 — an expired response claim never invokes its mutation or writes state", async () => {
  await withSandbox(async () => {
    await seed("rp-deadline");
    let invoked = false;
    const persisted = await mutateSessionState("rp-deadline", (s) => {
      invoked = true;
      s.repairAttempts = { taskId: s.activeTask!.id, generation: 0, count: 1 };
    }, { noQueue: true, deadline: Date.now() - 1 });
    assert.equal(persisted, false);
    assert.equal(invoked, false);
    assert.equal((await loadSessionState("rp-deadline")).repairAttempts, undefined);
  });
});
