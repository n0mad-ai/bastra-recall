/**
 * #513: the pending relay has two lanes. `recency` is shown once and gone;
 * `trends` is shown at every real session start, never consumed on read, and
 * ages out after N counted sessions — not after wall-clock days.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumePendingSuggestions,
  formatPendingRelay,
  isCountableSessionStart,
  PENDING_BLOCK_CHAR_BUDGET,
  PENDING_MAX_AGE_MS,
  PENDING_TRENDS_SESSIONS_DEFAULT,
  takePendingRelay,
  writePendingSuggestion,
} from "../src/pending-suggestions.js";
import { runSessionLane } from "../src/session-lane.js";
import { summarizeSessionStart } from "../src/telemetry-report.js";

async function withRelay(fn: (path: string) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-pending-lanes-"));
  const keys = ["BASTRA_PENDING_SUGGESTIONS_PATH", "BASTRA_TELEMETRY", ...Object.keys(env)];
  const prev = new Map(keys.map((k) => [k, process.env[k]]));
  const path = join(dir, "pending.json");
  process.env.BASTRA_PENDING_SUGGESTIONS_PATH = path;
  process.env.BASTRA_TELEMETRY = "off";
  Object.assign(process.env, env);
  try {
    await fn(path);
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const start = (id: string) => takePendingRelay({ sessionId: id, countable: isCountableSessionStart(id, "startup") });

test("#513: a recency entry is shown at exactly the next start and gone on the following one", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<save-eval>hot</save-eval>");
    const first = await start("s-1");
    assert.equal(first.recency.length, 1);
    assert.equal(first.trends.length, 0);
    const second = await start("s-2");
    assert.equal(second.recency.length, 0);
  });
});

test("#513: a trends entry is shown at every start, not deleted on read, and ages out after N sessions", async () => {
  await withRelay(async (path) => {
    await writePendingSuggestion("<taxonomy-drift>x</taxonomy-drift>", { lane: "trends", key: "drift" });
    for (let i = 1; i <= PENDING_TRENDS_SESSIONS_DEFAULT; i++) {
      const r = await start(`s-${i}`);
      assert.equal(r.trends.length, 1, `start ${i} must still show the trend`);
      assert.equal(r.trends[0].sessions, i);
    }
    // Still on disk after N reads — reading never consumed it.
    assert.match(await readFile(path, "utf8"), /taxonomy-drift/);
    const past = await start(`s-${PENDING_TRENDS_SESSIONS_DEFAULT + 1}`);
    assert.equal(past.trends.length, 0, "aged out after N counted sessions");
  });
});

test("#513: wall-clock age does not expire a trend", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<t>old but alive</t>", { lane: "trends", key: "k" });
    const muchLater = Date.now() + 10 * PENDING_MAX_AGE_MS;
    const r = await takePendingRelay({ now: muchLater, sessionId: "s-1", countable: true });
    assert.equal(r.trends.length, 1);
  });
});

test("#513: N is configurable", async () => {
  await withRelay(
    async () => {
      await writePendingSuggestion("<t>x</t>", { lane: "trends", key: "k" });
      assert.equal((await start("a-1")).trends.length, 1);
      assert.equal((await start("a-2")).trends.length, 1);
      assert.equal((await start("a-3")).trends.length, 0);
    },
    { BASTRA_PENDING_TRENDS_SESSIONS: "2" },
  );
});

test("#513: identical trends dedupe to one row with a refreshed counter", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<t>3 memories share tag a</t>", { lane: "trends", key: "drift" });
    await start("s-1");
    await start("s-2");
    await writePendingSuggestion("<t>4 memories share tag a</t>", { lane: "trends", key: "drift" });
    await writePendingSuggestion("<t>4 memories share tag a</t>", { lane: "trends", key: "drift" });
    const r = await start("s-3");
    assert.equal(r.trends.length, 1, "never stacked");
    assert.match(r.trends[0].blocks, /4 memories/);
    assert.equal(r.trends[0].sessions, 1, "the refresh restarted the counter");

    // Without a key the text itself is the identity.
    await writePendingSuggestion("<t>same</t>", { lane: "trends" });
    await writePendingSuggestion("<t>same</t>", { lane: "trends" });
    assert.equal((await start("s-4")).trends.length, 2);
  });
});

test("#513: synthetic/eval ids, resumed sessions and a repeated id never advance the counter", async () => {
  assert.equal(isCountableSessionStart("eval-123", "startup"), false);
  assert.equal(isCountableSessionStart("test_abc", "startup"), false);
  assert.equal(isCountableSessionStart("", "startup"), false);
  assert.equal(isCountableSessionStart(null, "startup"), false);
  assert.equal(isCountableSessionStart("01a05b6f-real", "compact"), false);
  assert.equal(isCountableSessionStart("01a05b6f-real", "resume"), false);
  assert.equal(isCountableSessionStart("01a05b6f-real", "startup"), true);
  assert.equal(isCountableSessionStart("01a05b6f-real", undefined), true);

  await withRelay(async () => {
    await writePendingSuggestion("<t>x</t>", { lane: "trends", key: "k" });
    for (let i = 0; i < 20; i++) {
      const r = await takePendingRelay({ sessionId: `eval-${i}`, countable: isCountableSessionStart(`eval-${i}`, "startup") });
      assert.equal(r.trends.length, 1, "a synthetic start still sees the trend");
      assert.equal(r.trends[0].sessions, 0, "…but never ages it");
    }
    await start("real-1");
    const again = await start("real-1");
    assert.equal(again.trends[0].sessions, 1, "the same session id counts once");
  });
});

test("#513: the lanes do not evict each other at the per-lane cap", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<t>trend</t>", { lane: "trends", key: "k" });
    for (let i = 0; i < 12; i++) await writePendingSuggestion(`<save-eval>hot ${i}</save-eval>`);
    const r = await start("s-1");
    assert.equal(r.recency.length, 5);
    assert.equal(r.trends.length, 1, "a burst of hot suggestions must not push the trend out");
  });
});

test("#513: consumePendingSuggestions keeps its contract and leaves trends alone", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<t>trend</t>", { lane: "trends", key: "k" });
    await writePendingSuggestion("<save-eval>hot</save-eval>");
    const consumed = await consumePendingSuggestions();
    assert.deepEqual(consumed.map((e) => e.blocks), ["<save-eval>hot</save-eval>"]);
    const r = await start("s-1");
    assert.equal(r.recency.length, 0);
    assert.equal(r.trends.length, 1);
    assert.equal(r.trends[0].sessions, 1, "the plain consume did not count a session");
  });
});

test("#513: the lanes render as two labelled blocks that share the #510 budget", () => {
  const both = formatPendingRelay({
    recency: [{ ts: 1, blocks: "<save-eval>hot</save-eval>" }],
    trends: [{ ts: 1, blocks: "<taxonomy-drift>recurring</taxonomy-drift>", lane: "trends" }],
  });
  assert.match(both.text, /^<pending-save-suggestions source="stop-hook">\n[\s\S]*<\/pending-save-suggestions>\n<pending-trends source="stop-hook">\n/);
  assert.match(both.text, /Recurring — shown at every session start/);
  assert.match(both.text, /<\/pending-trends>$/);
  assert.ok(both.recencyChars > 0 && both.trendsChars > 0);

  assert.equal(formatPendingRelay({ recency: [], trends: [] }).text, "");

  // Recency fills the budget → the trend is squeezed out, announced, and told it comes back.
  const full = formatPendingRelay({
    recency: [{ ts: 1, blocks: "h".repeat(PENDING_BLOCK_CHAR_BUDGET) }],
    trends: [{ ts: 1, blocks: "<t>recurring</t>", lane: "trends" }],
  });
  assert.ok(!full.text.includes("<t>recurring</t>"));
  assert.match(full.text, /1 earlier suggestion suppressed .* they stay pending and come back at the next session start\./);
});

test("#513: SessionStart delivers both lanes and keeps delivering the trend", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<save-eval>hot one</save-eval>");
    await writePendingSuggestion("<taxonomy-drift>recurring one</taxonomy-drift>", { lane: "trends", key: "taxonomy-drift" });
    const ctxOf = async (id: string) => {
      const out = await runSessionLane(
        { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: id },
        "http://127.0.0.1:1",
      );
      return (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
    };
    const first = await ctxOf("lane-wiring-1");
    assert.match(first, /hot one/);
    assert.match(first, /<pending-trends[\s\S]*recurring one/);
    const second = await ctxOf("lane-wiring-2");
    assert.doesNotMatch(second, /hot one/);
    assert.match(second, /recurring one/);
  });
});

test("#513: the telemetry report counts lanes and keeps pre-#513 starts out of them", () => {
  const section = summarizeSessionStart([
    { kind: "session_hook_call", pending_lanes: { recency: 2, trends: 1, recency_chars: 300, trends_chars: 100 } },
    { kind: "session_hook_call", pending_lanes: { recency: 0, trends: 1, recency_chars: 0, trends_chars: 100 } },
    { kind: "session_hook_call" },
  ] as never);
  assert.equal(section.pendingLanes.withLanes, 2);
  assert.equal(section.pendingLanes.withoutLanes, 1);
  assert.deepEqual(section.pendingLanes.recency, { entries: 2, presentIn: 1, avgChars: 150 });
  assert.deepEqual(section.pendingLanes.trends, { entries: 2, presentIn: 2, avgChars: 100 });
});
