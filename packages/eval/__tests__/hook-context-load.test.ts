import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents, renderHookContextLoad, summarizeHookContextLoad } from "../src/hook-context-load.js";

const lane = (kind: string, tokens: number, agent = "main", client = "claude-code") => ({
  kind,
  hint_tokens_est: tokens,
  dimensions: { agent, client },
});
const kernel = (session: string, agent: string, chars: number, ids = ["a"]) => ({
  kind: "gate_hook_call",
  session_id: session,
  kernel_chars: chars,
  kernel_ids: ids,
  dimensions: { agent },
});

test("lane sizes count only emitting calls in the percentiles, every call in calls", () => {
  const load = summarizeHookContextLoad([
    lane("hook_call", 0, "subagent"),
    lane("hook_call", 100, "subagent"),
    lane("hook_call", 300, "subagent"),
    { kind: "draft_hint", hook_event: "PreToolUse", hint_tokens_est: 50 },
  ]);
  const row = load.lanes.find((r) => r.key === "hook_call · subagent")!;
  assert.deepEqual(
    { calls: row.calls, emitted: row.emitted, max: row.max, sum: row.sum },
    { calls: 3, emitted: 2, max: 300, sum: 400 }
  );
  assert.equal(load.drafts[0]!.key, "PreToolUse");
  assert.equal(load.drafts[0]!.sum, 50);
});

test("an identical kernel delivered twice to the same session counts as a repeat; a changed one does not", () => {
  const load = summarizeHookContextLoad([
    kernel("s1", "subagent", 9000),
    kernel("s1", "subagent", 9000),
    kernel("s1", "subagent", 9100, ["a", "b"]),
    kernel("s2", "subagent", 9000),
    { kind: "gate_hook_call", session_id: "s1", kernel_reminder_chars: 200, dimensions: { agent: "subagent" } },
  ]);
  assert.deepEqual(load.kernel, [
    {
      agent: "subagent",
      full: 4,
      fullChars: 36100,
      identical: 1,
      identicalChars: 9000,
      reminders: 1,
      reminderChars: 200,
    },
  ]);
});

test("plan follow-through joins load_memory.from_hook_recall to the plan lane's recalls", () => {
  const load = summarizeHookContextLoad([
    lane("todo_hook_call", 400, "main", "codex"),
    { kind: "hook_recall", recall_id: "r1", dimensions: { hook_source: "todo" } },
    { kind: "hook_recall", recall_id: "r2", dimensions: { hook_source: "todo" } },
    { kind: "hook_recall", recall_id: "r3", dimensions: { hook_source: "prompt" } },
    { kind: "load_memory", from_hook_recall: "r2" },
    { kind: "load_memory", from_hook_recall: "r3" },
  ]);
  assert.deepEqual(load.planFollowThrough, { recalls: 2, followed: 1 });
  assert.equal(load.plan[0]!.key, "codex");
  assert.match(renderHookContextLoad(load, "w"), /1 of 2 plan recall/);
});

test("readEvents keeps the inclusive day window and skips torn lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-context-load-"));
  writeFileSync(join(dir, "events-2026-11-01.jsonl"), JSON.stringify(lane("hook_call", 1)) + "\n");
  writeFileSync(join(dir, "events-2026-11-02.jsonl"), JSON.stringify(lane("hook_call", 2)) + "\n{torn\n");
  writeFileSync(join(dir, "events-2026-11-03.jsonl"), JSON.stringify(lane("hook_call", 3)) + "\n");
  const events = readEvents(dir, "2026-11-02", "2026-11-03");
  assert.deepEqual(
    events.map((e) => e.hint_tokens_est),
    [2, 3]
  );
});
