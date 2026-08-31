/**
 * #356: the Stop lane's save_eval_call event must carry the Claude Code
 * session_id from the payload — before the fix every Stop stamped a fresh
 * randomUUID(), so per-session aggregation over the Stop lane was impossible.
 *
 * #369 moved the pipeline into the daemon, so this calls `runStopLane`
 * directly instead of spawning the CLI: same assertions, one process instead
 * of two, and it now covers the code path the stub actually reaches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStopLane } from "../src/stop-lane.js";

/** Env the lane reads at call time — restored after each test. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("#356 — save_eval_call carries the payload session_id, not a synthetic one", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-stop-telemetry-"));
  const pendingPath = join(logDir, "pending.json");
  try {
    const out = await withEnv(
      {
        BASTRA_TELEMETRY: "on",
        BASTRA_LOG_PATH: logDir,
        BASTRA_PENDING_SUGGESTIONS_PATH: pendingPath,
      },
      () =>
        runStopLane(
          {
            hook_event_name: "Stop",
            session_id: "stop-sess-356",
            cwd: process.cwd(),
            transcript: [
              { role: "user", content: "please run the tests" },
              { role: "assistant", content: "done, all green" },
            ],
          },
          // Unreachable on purpose: the drift fetch must fail fast, not find a
          // real daemon. It is best-effort, so the lane still completes.
          "http://127.0.0.1:1",
        ),
    );
    assert.equal(out, "{}", "the Stop lane stays silent on stdout");

    const files = (await readdir(logDir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"));
    assert.equal(files.length, 1, "exactly one day file written");
    const events = (await readFile(join(logDir, files[0]), "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const ev = events.find((e) => e.kind === "save_eval_call");
    assert.ok(ev, "a save_eval_call event must be written");
    assert.equal(ev.session_id, "stop-sess-356");
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#369 — the event gates return `{}` without writing anything", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-stop-gate-"));
  try {
    await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir }, async () => {
      assert.equal(await runStopLane({ hook_event_name: "PreToolUse" }, "http://127.0.0.1:1"), "{}");
      assert.equal(
        await runStopLane({ hook_event_name: "Stop", stop_hook_active: true }, "http://127.0.0.1:1"),
        "{}",
        "a Stop raised by a Stop hook must not re-evaluate",
      );
    });
    assert.equal((await readdir(logDir)).length, 0, "a gated call writes no telemetry");
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});
