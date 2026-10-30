/** #1311: repair must not consume the ordinary Stop's harvest/boundary/save work.
 * Revert-check: return the repair request before the loop guard and the first
 * case loses its queue, boundary and save_eval_call. Only the hook-active
 * follow-ups may skip that work; they still terminate after two requests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStopLane, type ClaudeStopPayload } from "../src/stop-lane.js";
import { loadSessionState, mutateSessionState, recordTouched, taskIdFor } from "../src/session-state.js";
import { setRepoEnabled } from "../src/code-graph/enabled-repos.js";

const TRANSCRIPT = [
  { role: "user", content: "we compared both options. decided: we go with the queue, not polling" },
  { role: "assistant", content: "noted" },
];

async function sandbox(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-repair-effects-"));
  const env: Record<string, string> = {
    BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: join(dir, "logs"),
    BASTRA_HOOK_STATE_DIR: join(dir, "state"), BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"),
    BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"),
    BASTRA_PROMPT_IMPACT: "on", BASTRA_STOP_SAME_TURN: "on", BASTRA_SESSION_HARVEST: "on",
  };
  const before = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  await setRepoEnabled(dir, true);
  try { await fn(dir); }
  finally {
    await setRepoEnabled(dir, false);
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(dir: string, sid: string): Promise<ClaudeStopPayload> {
  const taskId = taskIdFor("approved-copy", 1000);
  await mutateSessionState(sid, (s) => {
    s.activeTask = { id: taskId, kind: "approved-copy", since: 1000, generation: 0 };
    s.activeConventions = [{ id: "c", revision: null, setAt: 1000, scope: "task", validator: {
      tool: "validate_artifact", channel: "discord-dm", limit: 2000, unit: "utf16",
    } }];
    // Deleted source: its booked dependents remain actionable without a graph.
    recordTouched(s, dir, "src/save.ts", ["audit", "report", "notify"].map((name) => ({
      file: `src/${name}.ts`, location: `src/${name}.ts:1`, via: "saveMemory", relation: "calls",
    })), false, Date.now());
  });
  const transcript_path = join(dir, `${sid}.jsonl`);
  await writeFile(transcript_path, TRANSCRIPT.map((message) => JSON.stringify({ type: message.role, message })).join("\n") + "\n");
  // No cwd: this test covers bookkeeping, not the graph refresh scheduler.
  return { hook_event_name: "Stop", session_id: sid, transcript_path, transcript: TRANSCRIPT };
}

async function rows(dir: string): Promise<Record<string, unknown>[]> {
  const logDir = join(dir, "logs");
  const all = await Promise.all((await readdir(logDir)).filter((name) => name.startsWith("events-")).map(async (name) =>
    (await readFile(join(logDir, name), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)));
  return all.flat();
}

async function assertOrdinaryWork(dir: string, sid: string): Promise<void> {
  const queue = JSON.parse(await readFile(join(dir, "queue.json"), "utf8")) as { session_id: string }[];
  assert.ok(queue.some((row) => row.session_id === sid), "initial Stop books harvest before the session can end");
  assert.match((await loadSessionState(sid)).boundary?.note ?? "", /src\/audit\.ts/);
  const evaluated = (await rows(dir)).filter((row) => row.kind === "save_eval_call");
  assert.equal(evaluated.length, 1, "initial Stop runs save evaluation exactly once");
  assert.equal(evaluated[0].session_id, sid);
  assert.equal(evaluated[0].delivery, "same-turn");
}

test("#1311 repair preserves initial harvest, boundary and same-turn save output; receipt follow-up does not repeat evaluation", async () => {
  await sandbox(async (dir) => {
    const sid = "repair-effects-receipt";
    const payload = await seed(dir, sid);
    const first = JSON.parse(await runStopLane(payload, "http://127.0.0.1:1"));
    assert.equal(first.decision, undefined);
    assert.match(first.hookSpecificOutput.additionalContext, /<save-eval-now /);
    assert.match(first.hookSpecificOutput.additionalContext, /architecture-decision/);
    assert.match(first.hookSpecificOutput.additionalContext, /<copy-repair .*attempt="1\/2"/);
    await assertOrdinaryWork(dir, sid);
    await mutateSessionState(sid, (s) => {
      const task = s.activeTask!;
      const hash = "a".repeat(64);
      s.receipts = [{ taskId: task.id, generation: task.generation, hash, receipt: `sha256:${hash}`,
        channel: "discord-dm", limit: 2000, unit: "max(codepoints,utf16)", at: Date.now() }];
    });
    assert.equal(await runStopLane({ ...payload, stop_hook_active: true }, "http://127.0.0.1:1"), "{}");
    await assertOrdinaryWork(dir, sid);
  });
});

test("#1311 hook-active repairs stay bounded and log session_known without evaluating saves again", async () => {
  await sandbox(async (dir) => {
    const sid = "repair-effects-exhausted";
    const payload = await seed(dir, sid);
    await runStopLane(payload, "http://127.0.0.1:1");
    const second = JSON.parse(await runStopLane({ ...payload, stop_hook_active: true }, "http://127.0.0.1:1"));
    assert.equal(second.decision, undefined);
    assert.match(second.hookSpecificOutput.additionalContext, /attempt="2\/2"/);
    assert.doesNotMatch(second.hookSpecificOutput.additionalContext, /save-eval-now/);
    for (let i = 0; i < 2; i++) assert.equal(await runStopLane({ ...payload, stop_hook_active: true }, "http://127.0.0.1:1"), "{}");
    const exhausted = (await rows(dir)).filter((row) => row.reason === "repair_exhausted");
    assert.equal(exhausted.length, 1);
    assert.equal(exhausted[0].session_known, true);
    assert.equal(exhausted[0].session_id, sid);
    await assertOrdinaryWork(dir, sid);
  });
});

test("#1311 ordinary exhaustion Stop also keeps save evaluation and harvest", async () => {
  await sandbox(async (dir) => {
    const sid = "repair-effects-ordinary-exhausted";
    const payload = await seed(dir, sid);
    await mutateSessionState(sid, (s) => { s.repairAttempts = { taskId: s.activeTask!.id, generation: 0, count: 2 }; });
    const out = JSON.parse(await runStopLane(payload, "http://127.0.0.1:1"));
    assert.equal(out.decision, undefined);
    assert.match(out.hookSpecificOutput.additionalContext, /save-eval-now/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /copy-repair/);
    await assertOrdinaryWork(dir, sid);
    assert.equal((await rows(dir)).filter((row) => row.reason === "repair_exhausted").length, 1);
  });
});
