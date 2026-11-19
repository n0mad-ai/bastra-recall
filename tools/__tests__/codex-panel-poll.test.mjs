/**
 * #1490/#1530: data preparation of the Codex panel. CodexLiveSource.poll reads
 * the rollout, the Recall feed and the vault size and maps them onto the panel
 * data every design renders. Pinned before poll was split into reading and
 * building; the refactor must leave every expectation here unchanged.
 *
 * The rollout cwd does not exist, so the git reader reports "unknown" without
 * touching a real repository.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexLiveSource } from "../../packages/statusline/src/panel/codex-data.ts";
import { dropCallerGitEnv } from "../../scripts/caller-git-env.mjs";

// #1669: started without test-env.mjs, this file's git must still not reach a caller's GIT_DIR/GIT_WORK_TREE.
dropCallerGitEnv();

const NOW = Date.parse("2026-11-17T10:00:00.000Z");
const CWD = "/nirgendwo/codex-project";
const iso = (ms) => new Date(NOW + ms).toISOString();
const meta = (id = "codex-s") => ({
  type: "session_meta",
  timestamp: iso(-600000),
  payload: { id, cwd: CWD, timestamp: iso(-600000) },
});
const ev = (payload, ms) => ({ type: "event_msg", timestamp: iso(ms), payload });
const tokens = (info, rate_limits) => ev({ type: "token_count", info, rate_limits }, -50000);
const call = (id, extra = {}, ms = -40000) =>
  ev(
    {
      type: "item_completed",
      turn_id: "t1",
      item: { type: "McpToolCall", server: "bastra-recall", id, tool: "recall", durationMs: 200, ...extra },
    },
    ms
  );
const USAGE = tokens(
  {
    total_token_usage: { total_tokens: 5000, input_tokens: 4000, cached_input_tokens: 1000 },
    last_token_usage: { total_tokens: 250 },
    model_context_window: 1000,
  },
  {
    primary: { window_minutes: 10080, used_percent: 18, resets_at: 1791400000 },
    secondary: { window_minutes: 300, used_percent: 42, resets_at: 1791150000 },
  }
);
const BASE = [
  meta(),
  { type: "turn_context", payload: { model: "gpt-test", effort: "high" } },
  ev({ type: "task_started", turn_id: "t1" }, -60000),
  USAGE,
  call("a", { result: { structuredContent: { hits: [1, 2], vault_size: 77 } } }),
];
const DONE = ev({ type: "task_complete", turn_id: "t1" }, -30000);

async function poll(t, { rows = BASE, feeds = [], vault, missing = false, session = "codex-s", now = NOW } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-panel-poll-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout.jsonl");
  if (!missing) await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const [i, f] of feeds.entries())
    await writeFile(path.join(dir, `${i + 1}.json`), JSON.stringify({ cc_session_id: "codex-s", ...f }));
  if (vault !== undefined) await writeFile(path.join(dir, "vault.json"), JSON.stringify({ vault_size: vault }));
  return new CodexLiveSource(session, file, dir).poll(now);
}

const UNKNOWN_GIT = {
  branch: null,
  staged: 0,
  changed: 0,
  untracked: 0,
  conflicts: 0,
  ahead: null,
  behind: null,
  known: false,
};

test("an idle finished turn maps every Codex value and reports Recall ready", async (t) => {
  const d = await poll(t, { rows: [...BASE, DONE] });
  assert.deepEqual(d, {
    mode: "live",
    client: "codex",
    fresh: true,
    project: "codex-project",
    model: "gpt-test",
    effort: "high",
    context: 25,
    contextTotal: 1000,
    contextFree: 750,
    usage: 18,
    usageResetsAt: 1791400000,
    usage5h: 42,
    usage5hResetsAt: 1791150000,
    loadedTitles: [],
    apiDurationMs: null,
    costUsd: null,
    cacheHitRatio: null,
    cachedInputRatio: 0.25,
    vault: 77,
    searches: 1,
    hits: 2,
    loads: 0,
    saves: 0,
    errors: 0,
    latency: 200,
    clientLatency: 200,
    timingSource: "client",
    now: NOW,
    git: UNKNOWN_GIT,
    tokens: 5000,
    durationMs: 600000,
    active: false,
    agentActive: false,
    recent: false,
    stage: "Recall bereit",
    stageText: { key: "stage.ready" },
  });
});

test("an unreadable or foreign transcript shows nothing as known", async (t) => {
  for (const options of [{ missing: true }, { rows: [meta("other"), ...BASE.slice(1)] }]) {
    const d = await poll(t, { ...options, vault: 12 });
    assert.equal(d.fresh, false);
    assert.equal(d.project, "Codex", "a foreign transcript is dropped, not shown");
    assert.equal(d.model, "Codex");
    for (const key of ["context", "contextTotal", "contextFree", "usage", "usageResetsAt", "usage5h"])
      assert.equal(d[key], null, key);
    for (const key of ["usage5hResetsAt", "searches", "hits", "loads", "saves", "latency", "tokens", "durationMs"])
      assert.equal(d[key], null, key);
    assert.equal(d.loadedTitles, undefined);
    assert.equal(d.errors, 0);
    assert.equal(d.vault, 12, "the vault size does not depend on the transcript");
    assert.equal(d.active, false);
    assert.equal(d.agentActive, false);
    assert.deepEqual(d.stageText, { key: "stage.codexUnavailable" });
  }
});

test("a fresh feed stage during the running turn is the live stage", async (t) => {
  const running = await poll(t, {
    feeds: [{ ts: NOW - 1000, current_stage: "embed", current_message: "Semantik abgleichen" }],
  });
  assert.equal(running.active, true);
  assert.equal(running.agentActive, true);
  assert.deepEqual(running.stageText, { key: "stage.raw", vars: { text: "Semantik abgleichen" } });
  assert.equal(running.stage, "Semantik abgleichen");

  const stageOnly = await poll(t, { feeds: [{ ts: NOW - 1000, current_stage: "embed" }] });
  assert.equal(stageOnly.stage, "embed", "without a message the stage name is shown");

  const newest = await poll(t, {
    feeds: [
      { ts: NOW - 2000, current_stage: "old" },
      { ts: NOW - 500, current_stage: "new" },
      { ts: NOW - 100, current_stage: "foreign", cc_session_id: "other" },
    ],
  });
  assert.equal(newest.stage, "new", "the newest feed of this session wins");
});

test("a stale, early or future feed does not claim a live stage", async (t) => {
  for (const ts of [NOW - 15000, NOW - 61000, NOW + 10]) {
    const d = await poll(t, { feeds: [{ ts, current_stage: "embed" }] });
    assert.equal(d.active, false, `feed at ${ts - NOW}`);
    assert.equal(d.agentActive, true);
    assert.deepEqual(d.stageText, { key: "stage.codexActive" });
  }
});

test("a tool call within five seconds of a running turn shows as recent, with its error", async (t) => {
  const ok = await poll(t, { rows: [...BASE, call("b", { tool: "load_memory" }, -4999)] });
  assert.equal(ok.recent, true);
  assert.deepEqual(ok.stageText, { key: "stage.recent", vars: { tool: "load_memory" } });

  const failed = await poll(t, { rows: [...BASE, call("b", { status: "failed" }, -1000)] });
  assert.equal(failed.errors, 1);
  assert.deepEqual(failed.stageText, { key: "stage.recentError", vars: { tool: "recall" } });

  const old = await poll(t, { rows: [...BASE, call("b", {}, -5000)] });
  assert.equal(old.recent, false, "five seconds is no longer recent");
  const done = await poll(t, { rows: [...BASE, call("b", {}, -1000), DONE] });
  assert.equal(done.recent, false, "a finished turn is never recent");
  assert.deepEqual(done.stageText, { key: "stage.ready" });
});

test("the forwarder time replaces the client time only for the same finished turn", async (t) => {
  const match = {
    ts: NOW - 59000,
    turn_id: NOW - 60000 + 9999,
    recall_count: 1,
    total_ms: 146,
    current_stage: null,
  };
  const same = await poll(t, { feeds: [match] });
  assert.equal(same.latency, 146);
  assert.equal(same.timingSource, "forwarder");
  assert.equal(same.clientLatency, 200, "the client time stays visible next to it");

  for (const [label, change, rows] of [
    ["another turn", { turn_id: NOW - 60000 + 10000 }],
    ["an earlier feed", { ts: NOW - 61000 }],
    ["a different call count", { recall_count: 2 }],
    ["a running stage", { current_stage: "embed" }],
    ["no total", { total_ms: "146" }],
    ["a failed call", {}, [...BASE, call("b", { status: "failed" })]],
  ]) {
    const d = await poll(t, { feeds: [{ ...match, ...change }], rows });
    assert.equal(d.timingSource, "client", label);
  }
});

test("context, cache share and vault size stay unknown instead of inventing values", async (t) => {
  const overflow = await poll(t, {
    rows: [
      ...BASE,
      tokens({
        total_token_usage: { input_tokens: 10, cached_input_tokens: 11 },
        last_token_usage: { total_tokens: 1500 },
      }),
    ],
    vault: 1368,
  });
  assert.equal(overflow.context, 100);
  assert.equal(overflow.contextFree, 0);
  assert.equal(overflow.cachedInputRatio, null, "more cached than input is not a share");
  assert.equal(overflow.vault, 1368, "the daemon's vault size wins over the tool result");

  const noWindow = await poll(t, {
    rows: [
      meta(),
      ev({ type: "task_started", turn_id: "t1" }, -60000),
      tokens({ total_token_usage: { input_tokens: 0 } }),
    ],
  });
  assert.equal(noWindow.context, null);
  assert.equal(noWindow.contextTotal, null);
  assert.equal(noWindow.contextFree, null);
  assert.equal(noWindow.cachedInputRatio, null);
  assert.equal(noWindow.vault, null);
  assert.equal(noWindow.usage, null);
  assert.equal(noWindow.usage5h, null);
});

test("the panel data keeps its exact key order", async (t) => {
  const keys = Object.keys(await poll(t, { rows: [...BASE, DONE] }));
  assert.deepEqual(keys, [
    "mode",
    "client",
    "fresh",
    "project",
    "model",
    "effort",
    "context",
    "contextTotal",
    "contextFree",
    "usage",
    "usageResetsAt",
    "usage5h",
    "usage5hResetsAt",
    "loadedTitles",
    "apiDurationMs",
    "costUsd",
    "cacheHitRatio",
    "cachedInputRatio",
    "vault",
    "searches",
    "hits",
    "loads",
    "saves",
    "errors",
    "latency",
    "clientLatency",
    "timingSource",
    "now",
    "git",
    "tokens",
    "durationMs",
    "active",
    "agentActive",
    "recent",
    "stage",
    "stageText",
  ]);
  assert.deepEqual(Object.keys(await poll(t, { missing: true })), keys, "an unknown transcript has the same keys");
});

test("zero and missing token and quota values: zero is a value, missing is unknown", async (t) => {
  const cases = [
    [{ input_tokens: 10, cached_input_tokens: 0 }, 0],
    [{ input_tokens: 10, cached_input_tokens: 10 }, 1],
    [{ input_tokens: 0, cached_input_tokens: 0 }, null],
    [{ input_tokens: 10 }, null],
    [{ cached_input_tokens: 3 }, null],
    [{ input_tokens: -1, cached_input_tokens: 0 }, null],
  ];
  for (const [usage, share] of cases) {
    const d = await poll(t, {
      rows: [meta(), ev({ type: "task_started", turn_id: "t1" }, -60000), tokens({ total_token_usage: usage })],
    });
    assert.equal(d.cachedInputRatio, share, JSON.stringify(usage));
  }
  const quota = await poll(t, {
    rows: [
      meta(),
      tokens(
        { last_token_usage: { total_tokens: 0 }, model_context_window: 0 },
        { primary: { window_minutes: 10080, used_percent: 0 }, secondary: { window_minutes: 60, used_percent: 9 } }
      ),
    ],
  });
  assert.equal(quota.usage, 0, "0 % used is shown as 0 %");
  assert.equal(quota.usageResetsAt, null);
  assert.equal(quota.usage5h, null, "a window that is neither 5 h nor 7 days is not the 5 h quota");
  assert.equal(quota.context, null, "a zero window has no fill level");
  assert.equal(quota.contextTotal, 0);
  assert.equal(quota.contextFree, 0);
});

test("results of earlier polls are independent objects", async (t) => {
  const first = await poll(t, { missing: true });
  first.latency = 1;
  first.loadedTitles = ["changed"];
  const second = await poll(t, { missing: true });
  assert.equal(second.latency, null);
  assert.equal(second.loadedTitles, undefined);
  const known = await poll(t);
  known.loadedTitles.push("changed");
  assert.deepEqual((await poll(t)).loadedTitles, []);
});

test("panel data for every scenario stays byte-identical (golden digest)", async (t) => {
  const scenarios = [
    {},
    { rows: [...BASE, DONE] },
    { missing: true },
    { feeds: [{ ts: NOW - 1000, current_stage: "embed", current_message: "läuft" }], vault: 5 },
    { rows: [...BASE, call("b", { status: "failed" }, -1000)] },
    { feeds: [{ ts: NOW - 59000, turn_id: NOW - 55000, recall_count: 1, total_ms: 99 }] },
  ];
  const out = [];
  for (const s of scenarios) out.push(JSON.stringify(await poll(t, s)));
  const digest = createHash("sha256").update(out.join("\n")).digest("hex");
  assert.equal(digest, GOLDEN_POLL, `panel data changed: ${digest}`);
});

// Generated from main before the #1530 split.
const GOLDEN_POLL = "b9f82319df9c20e03c9a44e23fe46eec0d1b2ba02ac93075e67ae8bdcd08ceb5";
