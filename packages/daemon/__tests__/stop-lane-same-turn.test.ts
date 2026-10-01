/**
 * #662: a save suggestion reaches the Claude Code session that produced it, in
 * the running turn, instead of the next session (which has nothing left to
 * save). Codex, payloads without a session id and BASTRA_STOP_SAME_TURN=0 keep
 * the pending relay.
 *
 * #757: Claude Code prints that hand-over to the user, so it comes with a
 * one-line notice in the user's language and the agent block is minimal.
 *
 * Run: node --import tsx --test packages/daemon/__tests__/stop-lane-same-turn.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTurns, runStopLane, type ClaudeStopPayload } from "../src/stop-lane.js";
import { formatSameTurnBlock } from "../src/stop-lane-same-turn.js";

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
    // The lane reads language.primary from ~/.bastra/cli-settings.json — keep
    // the developer's own settings out.
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
    assert.match(ctx, /^- architecture-decision: /m);
    assert.equal(existsSync(join(dir, "pending.json")), false, "nothing is parked for the next session");
    const [row] = await events(dir);
    assert.equal(row.delivery, "same-turn");
    assert.equal(row.session_id, "cc-662-a");
  });
});

test("#757 — the user gets one line in their language, the agent a minimal block", async () => {
  type Out = { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
  await withSandbox({}, async (dir) => {
    const en = JSON.parse(await stop({ session_id: "cc-757-en" })) as Out;
    assert.match(en.systemMessage ?? "", /^bastra-recall is checking .* nothing for you to do\.$/);
    assert.ok(!(en.systemMessage ?? "").includes("\n"), "one line");

    // No duplicated instructions: the wrapper, then one line per suggestion —
    // no nested <save-eval> block with its own "To save: …" tail.
    const lines = (en.hookSpecificOutput?.additionalContext ?? "").split("\n");
    assert.equal(lines.length, 4, "open tag, one instruction, one suggestion, close tag");
    assert.equal(lines[0], '<save-eval-now source="stop-hook">');
    assert.match(lines[1], /save_memory/);
    assert.match(lines[2], /^- architecture-decision: .*we go with the queue/);
    assert.equal(lines[3], "</save-eval-now>");
    assert.equal(lines.filter((l) => /save_memory/.test(l)).length, 1, "save_memory is named once");

    await mkdir(join(dir, ".bastra"), { recursive: true });
    await writeFile(join(dir, ".bastra", "cli-settings.json"), JSON.stringify({ language: { primary: "de" } }), "utf8");
    const de = JSON.parse(await stop({ session_id: "cc-757-de" })) as Out;
    assert.equal(
      de.systemMessage,
      "bastra-recall prüft, ob sich aus diesem Gespräch etwas zu merken lohnt — du musst nichts tun.",
    );
    assert.equal(de.hookSpecificOutput?.additionalContext, en.hookSpecificOutput?.additionalContext, "the agent block stays English");

    await writeFile(join(dir, ".bastra", "cli-settings.json"), JSON.stringify({ language: { primary: "tr" } }), "utf8");
    const tr = JSON.parse(await stop({ session_id: "cc-757-tr" })) as Out;
    assert.equal(tr.systemMessage, en.systemMessage, "a language without a shipped line falls back to English");
  });
});

test("#757 — the same-turn block is scrubbed from a transcript like every other injected block", () => {
  const block = formatSameTurnBlock([
    { heuristic: "feature-completion", title: "t", type: "project-fact", body: "5 files (e.g. packages/daemon/src/a.ts)" },
  ]);
  const [turn] = normalizeTurns([{ role: "user", content: `before\n${block}\nafter` }]);
  assert.equal(turn.content, "before\n\nafter");
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
