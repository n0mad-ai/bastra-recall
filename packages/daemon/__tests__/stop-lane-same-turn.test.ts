/**
 * #662: a save suggestion reaches the Claude Code session that produced it, in
 * the running turn, instead of the next session (which has nothing left to
 * save). Codex, payloads without a session id and BASTRA_STOP_SAME_TURN=0 keep
 * the pending relay.
 *
 * Run: node --import tsx --test packages/daemon/__tests__/stop-lane-same-turn.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStopLane, type ClaudeStopPayload } from "../src/stop-lane.js";

const DECISION_TRANSCRIPT = [
  { role: "user", content: "we compared both options. decided: we go with the queue, not polling" },
  { role: "assistant", content: "noted" },
];

async function withSandbox<T>(
  extraEnv: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-stop-same-turn-"));
  const env: Record<string, string> = {
    BASTRA_TELEMETRY: "on",
    BASTRA_LOG_PATH: join(dir, "logs"),
    BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"),
    BASTRA_HOOK_STATE_DIR: join(dir, "state"),
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

function stop(extra: Partial<ClaudeStopPayload> & Record<string, unknown>): Promise<string> {
  return runStopLane(
    { hook_event_name: "Stop", cwd: process.cwd(), transcript: DECISION_TRANSCRIPT, ...extra } as ClaudeStopPayload,
    "http://127.0.0.1:1",
  );
}

async function events(dir: string): Promise<Record<string, unknown>[]> {
  const logDir = join(dir, "logs");
  const files = (await readdir(logDir)).filter((n) => n.startsWith("events-"));
  const rows: Record<string, unknown>[] = [];
  for (const f of files) {
    for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (l.trim()) rows.push(JSON.parse(l) as Record<string, unknown>);
    }
  }
  return rows.filter((r) => r.kind === "save_eval_call");
}

test("#662 — a Claude Code Stop hands the suggestion to the running turn, not the pending file", async () => {
  await withSandbox({}, async (dir) => {
    const out = JSON.parse(await stop({ session_id: "cc-662-a" })) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    assert.equal(out.hookSpecificOutput?.hookEventName, "Stop");
    const ctx = out.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /<save-eval-now source="stop-hook">/);
    assert.match(ctx, /heuristic: architecture-decision/);
    assert.equal(existsSync(join(dir, "pending.json")), false, "nothing is parked for the next session");
    const [row] = await events(dir);
    assert.equal(row.delivery, "same-turn");
    assert.equal(row.session_id, "cc-662-a");
  });
});

test("#662 — the same heuristic is delivered once per session", async () => {
  await withSandbox({}, async (dir) => {
    assert.notEqual(await stop({ session_id: "cc-662-b" }), "{}");
    assert.equal(await stop({ session_id: "cc-662-b" }), "{}", "second Stop of the same session stays silent");
    assert.equal(existsSync(join(dir, "pending.json")), false);
    assert.notEqual(await stop({ session_id: "cc-662-other" }), "{}", "another session gets its own delivery");
    const rows = await events(dir);
    assert.deepEqual(
      rows.map((r) => r.delivery),
      ["same-turn", "already-delivered", "same-turn"],
    );
  });
});

test("#662 — Codex, no session id and BASTRA_STOP_SAME_TURN=0 keep the pending relay", async () => {
  for (const [label, env, extra] of [
    ["codex", {}, { session_id: "codex-662", bastra_client: "codex" }],
    ["no session id", {}, {}],
    ["off switch", { BASTRA_STOP_SAME_TURN: "0" }, { session_id: "cc-662-off" }],
  ] as const) {
    await withSandbox(env, async (dir) => {
      assert.equal(await stop(extra), "{}", label);
      const pending = JSON.parse(await readFile(join(dir, "pending.json"), "utf8")) as { blocks: string }[];
      assert.equal(pending.length, 1, label);
      assert.match(pending[0].blocks, /architecture-decision/, label);
      const [row] = await events(dir);
      assert.equal(row.delivery, "pending", label);
    });
  }
});

test("#662 — a Stop raised by a Stop hook is never re-evaluated (loop guard)", async () => {
  await withSandbox({}, async () => {
    assert.equal(await stop({ session_id: "cc-662-loop", stop_hook_active: true }), "{}");
  });
});
