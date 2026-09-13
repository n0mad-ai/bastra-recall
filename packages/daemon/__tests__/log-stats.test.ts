/**
 * Tests for `bastra logs --stats` (#279 slice) — the readout that made the
 * hook-budget loss visible.
 *
 * The aggregation exists because averaging over all events lied: the `none`
 * lane never recalls, so its 4ms median dragged the mean far below what the
 * recalling lanes actually cost. These tests pin the two properties that
 * matter — lanes stay separate, and a call still counts as a call when it was
 * gated, suppressed or timed out.
 *
 * Run: npx tsx --test packages/daemon/__tests__/log-stats.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregate,
  percentiles,
  renderStats,
  restartWindows,
  laneVerdict,
  releaseGateMet,
  RELEASE_THRESHOLDS,
  REQUIRED_LANES,
  GATE_LANE_BY_KIND,
  DEFAULT_HOOK_BUDGET_MS,
} from "../src/cli/log-stats.js";
import {
  FAST_BUDGET_MS,
  PROMPT_ASSERTION_BUDGET_MS,
  RECALL_BUDGET_MS,
  STOP_BUDGET_MS,
} from "../src/hook-budgets.js";

function promptCall(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "prompt_hook_call",
    ts: "2026-07-28T05:00:00.000Z",
    // Every writer stamps the payload's session (#356), and since #305 the
    // fold pairs rows on it — a fixture without one is not a row the log can
    // contain.
    session_id: "session-a",
    detected_mode: "none",
    status: "ok",
    hint_count: 0,
    latency_ms_total: 4,
    ...over,
  };
}

test("percentiles on a known distribution", () => {
  const p = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(p?.n, 10);
  assert.equal(p?.median, 6);
  assert.equal(p?.p90, 10);
  assert.equal(p?.max, 10);
});

test("percentiles of nothing is null, not zero", () => {
  // Zero would render as "0ms", which reads like a measurement.
  assert.equal(percentiles([]), null);
});

test("lanes stay separate — the silent lane cannot mask the recalling one", () => {
  const events = [
    ...Array.from({ length: 100 }, () => promptCall({ detected_mode: "none", latency_ms_total: 4 })),
    promptCall({ detected_mode: "assertion", latency_ms_total: 259, status: "timeout", hint_count: 0 }),
    promptCall({ detected_mode: "retrieval", latency_ms_total: 222, hint_count: 5 }),
  ];
  const stats = aggregate(events);
  const byMode = Object.fromEntries(stats.lanes.map((l) => [l.mode, l]));
  assert.equal(byMode.none.latency?.median, 4);
  assert.equal(byMode.assertion.latency?.median, 259);
  assert.equal(byMode.retrieval.latency?.median, 222);
  assert.equal(byMode.assertion.timeouts, 1);
  assert.equal(stats.totals.calls, 102);
});

test("the PreToolUse hook joins the same table as its own lane", () => {
  const events = [
    { kind: "hook_call", ts: "2026-07-28T05:00:00.000Z", status: "timeout", latency_ms: 260 },
    { kind: "hook_call", ts: "2026-07-28T05:00:01.000Z", status: "ok", latency_ms: 60, hint_count: 3 },
    promptCall(),
  ];
  const stats = aggregate(events);
  const pre = stats.lanes.find((l) => l.mode === "pretooluse");
  assert.ok(pre, "pretooluse lane missing");
  assert.equal(pre.calls, 2);
  assert.equal(pre.timeouts, 1);
  assert.equal(pre.withHits, 1);
  assert.equal(pre.latency?.max, 260);
});

test("gated, suppressed and timed-out calls still count as calls", () => {
  // Counting only the calls that made it through would report a lane that
  // suppresses everything as a healthy one.
  const events = [
    promptCall({ status: "gated", gated: true }),
    promptCall({ status: "suppressed", suppressed: true }),
    promptCall({ status: "timeout" }),
    promptCall({ status: "ok", hint_count: 2 }),
  ];
  const stats = aggregate(events);
  const none = stats.lanes.find((l) => l.mode === "none");
  assert.equal(none?.calls, 4);
  assert.equal(none?.gated, 1);
  assert.equal(none?.suppressed, 1);
  assert.equal(none?.timeouts, 1);
  assert.equal(none?.withHits, 1);
});

test("non-hook events are counted, never mistaken for lanes", () => {
  const stats = aggregate([
    { kind: "save_memory", ts: "2026-07-28T05:00:00.000Z" },
    { kind: "save_memory", ts: "2026-07-28T05:00:01.000Z" },
    promptCall(),
  ]);
  assert.equal(stats.lanes.length, 1);
  assert.deepEqual(stats.otherKinds, [{ kind: "save_memory", count: 2 }]);
});

test("save attempts report written and held halves with hold reasons", () => {
  const stats = aggregate([
    { kind: "save_memory", ts: "2026-07-28T05:00:00.000Z" },
    { kind: "save_memory", ts: "2026-07-28T05:00:01.000Z" },
    { kind: "save_hold", ts: "2026-07-28T05:00:02.000Z", reason: "claim_gate" },
    { kind: "save_hold", ts: "2026-07-28T05:00:03.000Z", reason: "claim_gate" },
    { kind: "save_hold", ts: "2026-07-28T05:00:04.000Z", reason: "id_exists" },
  ]);
  assert.deepEqual(stats.saves, {
    written: 2,
    held: 3,
    byReason: [
      { reason: "claim_gate", count: 2 },
      { reason: "id_exists", count: 1 },
    ],
  });
  const out = renderStats(stats, 600);
  assert.match(out, /5 attempted, 2 written, 3 held \(60%\)/);
  assert.match(out, /claim_gate×2, id_exists×1/);
});

test("cross-session hint suppression reports avoided hints and context", () => {
  const stats = aggregate([
    {
      kind: "hook_recall",
      ts: "2026-09-05T05:00:00.000Z",
      usage_suppressed: [
        { id: "a", type: "project-fact" },
        { id: "b", type: "lesson" },
      ],
      usage_suppressed_tokens_est: 73,
    },
    {
      kind: "hook_recall",
      ts: "2026-09-05T05:01:00.000Z",
      usage_suppressed: [{ id: "a", type: "project-fact" }],
      usage_suppressed_tokens_est: 31,
    },
  ]);
  assert.deepEqual(stats.hintSuppression, {
    calls: 2,
    hints: 3,
    tokens: 104,
    byType: [
      { type: "project-fact", count: 2 },
      { type: "lesson", count: 1 },
    ],
    // Ohne Modusfeld: älter als #484 und damit im Wirkbetrieb entstanden.
    modes: [{ mode: "live", calls: 2 }],
  });
  assert.match(renderStats(stats, 600), /3 repeated-unused hint\(s\) removed.*~104 hook-payload tokens avoided/);
});

test("#484 shadow: der Bericht sagt nicht 'removed', wenn nichts entfernt wurde", () => {
  const stats = aggregate([
    {
      kind: "hook_recall",
      ts: "2026-09-06T05:00:00.000Z",
      usage_suppressed: [{ id: "a", type: "lesson" }],
      usage_suppressed_tokens_est: 40,
      usage_suppressed_mode: "shadow",
    },
  ]);
  assert.deepEqual(stats.hintSuppression.modes, [{ mode: "shadow", calls: 1 }]);
  const rendered = renderStats(stats, 600);
  assert.match(rendered, /would have been removed/);
  assert.doesNotMatch(rendered, /tokens avoided/);
  assert.match(rendered, /mode: shadow×1/);
});

test("the render names each lane's budget and what it is judged against", () => {
  // Was: one "hook budget Xms — worst lane p90" line. Since #305 budgets are
  // per lane, so the readout names the lane's own ceiling and its verdict.
  const stats = aggregate([
    promptCall({ detected_mode: "assertion", latency_ms_total: 259, status: "timeout" }),
  ]);
  const out = renderStats(stats, 250);
  assert.match(out, /assertion/);
  assert.match(out, /assertion\s+1000ms budget · p90 ≤ 900ms · fail ≤ 5%/);
  assert.match(out, /1 timeout\(s\)/);
});

test("a lane with no release threshold still gets a headroom line", () => {
  // A trigger class nobody has written a threshold for must not vanish from
  // the readout — that is how a lane goes unmeasured.
  const stats = aggregate([
    promptCall({ detected_mode: "brand-new-lane", latency_ms_total: 120, status: "ok", hint_count: 1 }),
  ]);
  const out = renderStats(stats, 600);
  assert.match(out, /brand-new-lane: no release threshold set — p90 120ms against 600ms \(80% headroom\)/);
});

test("an empty window says so instead of rendering an empty table", () => {
  assert.match(renderStats(aggregate([]), 600), /no hook-lane events/);
});

test("the readout's budget default matches what the hooks actually enforce", async () => {
  // A readout that names a ceiling the hooks do not use reports the wrong
  // headroom — and it did exactly that once, claiming 250ms after the hooks
  // moved to 600ms. Since #305 the budget is per lane, so the pin is per lane:
  // these two clients serve the recall lanes and must hold the fallback the
  // readout uses for any lane with no threshold of its own.
  const src = dirname(fileURLToPath(import.meta.url));
  for (const hook of ["hook.ts", "todo-hook.ts"]) {
    const body = await readFile(join(src, "..", "src", hook), "utf8");
    const m = /envInt\("BASTRA_HOOK_TIMEOUT_MS",\s*(\d+)/.exec(body);
    assert.ok(m, `${hook}: no BASTRA_HOOK_TIMEOUT_MS default found — did the constant move?`);
    assert.equal(
      Number(m[1]),
      DEFAULT_HOOK_BUDGET_MS,
      `${hook} enforces ${m[1]}ms but the stats readout assumes ${DEFAULT_HOOK_BUDGET_MS}ms`,
    );
  }
});

test("#305: every release threshold names the budget its lane really enforces", () => {
  // The threshold table is what the gate is read off. If it drifts from
  // hook-budgets.ts, the readout judges lanes against a ceiling nobody
  // enforces — the same class of defect as the 250ms-vs-600ms one above, one
  // layer up.
  assert.equal(RELEASE_THRESHOLDS.assertion.budgetMs, PROMPT_ASSERTION_BUDGET_MS);
  for (const mode of ["pretooluse", "none", "retrieval", "generic"]) {
    assert.equal(RELEASE_THRESHOLDS[mode].budgetMs, RECALL_BUDGET_MS, `${mode} budget drifted`);
  }
  // The assertion lane must be the slow one, or the split has no point.
  assert.ok(RELEASE_THRESHOLDS.assertion.budgetMs > RELEASE_THRESHOLDS.pretooluse.budgetMs);
  // #305's 200ms target survives on the fast lane and nowhere else.
  assert.equal(RELEASE_THRESHOLDS.pretooluse.p90TargetMs, 200);
});

test("#305: the prompt CLIENTS outlast the slowest class the daemon can hand them", async () => {
  // The client posts before the trigger class exists, so a client budget below
  // the assertion budget cuts off calls the daemon goes on to finish — which is
  // exactly what produced 73 of the 74 duplicate client rows in the measured
  // week. Read the real constants, not a copy of them.
  const src = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["src/prompt-hook.ts", "stub/bastra-hook.ts"]) {
    const body = await readFile(join(src, "..", rel), "utf8");
    assert.match(
      body,
      /PROMPT_ASSERTION_BUDGET_MS/,
      `${rel} must take its prompt budget from hook-budgets.ts, not a literal`,
    );
  }
});

test("#305: a lane over its failure ceiling fails the gate, and says which number did it", () => {
  // The assertion lane as it was measured: inside its latency target, far
  // outside its failure ceiling. That combination is the whole finding of #305
  // — the lane was not slow so much as cut off — so the verdict has to name the
  // failure rate, not the latency.
  const v = laneVerdict({
    mode: "assertion", calls: 273, withHits: 215, suppressed: 19, gated: 0,
    timeouts: 64, errors: 0, latency: { n: 273, median: 423, p90: 731, max: 1017 },
  });
  assert.equal(v.verdict, "fail");
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0], /64\/273 calls returned nothing \(23\.4% > 5%\)/);
  assert.equal(releaseGateMet([v]), false);
});

test("#305: the same lane inside both ceilings passes", () => {
  // What the 1000ms budget is expected to produce: the 64 cut calls
  // reconstruct to <= 975ms, so they land instead of expiring.
  const v = laneVerdict({
    mode: "assertion", calls: 273, withHits: 270, suppressed: 0, gated: 0,
    timeouts: 2, errors: 0, latency: { n: 273, median: 440, p90: 836, max: 975 },
  });
  assert.equal(v.verdict, "pass");
  assert.deepEqual(v.reasons, []);
  assert.equal(releaseGateMet([v]), true);
});

test("#305: a lane too small to judge gets no verdict, and no free pass either", () => {
  // The `retrieval` lane had n=1 in the measured week. A gate that swings on
  // one call is worse than no gate — but "we did not measure" must not read as
  // "it works".
  const v = laneVerdict({
    mode: "retrieval", calls: 1, withHits: 1, suppressed: 0, gated: 0,
    timeouts: 0, errors: 0, latency: { n: 1, median: 114, p90: 114, max: 114 },
  });
  assert.equal(v.verdict, "not_evaluable");
  assert.equal(releaseGateMet([v]), false);
  assert.match(renderStats(aggregate([]), 600), /no hook-lane events/);
});

test("#305: the readout prints the gate, per lane, with its verdict", () => {
  const events = [
    ...Array.from({ length: 60 }, (_, i) =>
      promptCall({ ts: `2026-09-06T05:${String(i % 60).padStart(2, "0")}:00.000Z`, detected_mode: "assertion", status: "timeout", latency_ms_total: 610 }),
    ),
    ...Array.from({ length: 60 }, (_, i) =>
      ({ kind: "hook_call", ts: `2026-09-06T07:${String(i % 60).padStart(2, "0")}:00.000Z`, status: "ok", latency_ms: 60, hint_count: 1 }),
    ),
  ];
  const rendered = renderStats(aggregate(events), 600);
  assert.match(rendered, /release gate \(#305\)/);
  assert.match(rendered, /assertion\s+1000ms budget · p90 ≤ 900ms · fail ≤ 5% — FAIL/);
  assert.match(rendered, /pretooluse\s+600ms budget · p90 ≤ 200ms · fail ≤ 2% — PASS/);
  assert.match(rendered, /gate: NOT MET/);
});

// ─── #305: the readout has to be decidable, not just printable ───────────

function clientRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  // What a thin client / the compiled stub writes when its socket budget
  // expires: no trigger classification (it never got an answer), so it writes
  // the literal "none".
  return {
    kind: "prompt_hook_call",
    ts: "2026-09-06T05:00:00.000Z",
    session_id: "session-a",
    hook_version: "0.6.0-stub",
    detected_mode: "none",
    daemon_reachable: false,
    status: "timeout",
    hint_count: 0,
    latency_ms_total: 608,
    ...over,
  };
}

test("#305: a client timeout and the daemon row for the same call are ONE call", () => {
  // Measured on the reference host: 73 of 74 client rows in the prompt lane
  // had a daemon row within 500ms. Counting both doubled the denominator and
  // tripled the timeout rate the release gate was being read off — and put
  // the assertion lane's failures under the silent lane's name.
  const stats = aggregate([
    promptCall({ ts: "2026-09-06T05:00:00.000Z", detected_mode: "assertion", status: "ok", latency_ms_total: 880, hint_count: 3 }),
    clientRow({ ts: "2026-09-06T05:00:00.200Z" }),
  ]);
  assert.equal(stats.totals.calls, 1);
  assert.equal(stats.foldedDuplicates, 1);
  // The daemon's lane wins, the client's verdict wins: the daemon finished,
  // but the turn had already moved on with nothing.
  const byMode = Object.fromEntries(stats.lanes.map((l) => [l.mode, l]));
  assert.equal(byMode.assertion?.calls, 1);
  assert.equal(byMode.assertion?.timeouts, 1);
  assert.equal(byMode.none, undefined, "the client row must not invent a `none` call");
  assert.equal(byMode.assertion?.latency?.median, 880);
});

test("#305: a client row with no daemon partner stays its own call", () => {
  // `daemon-unreachable` describes a call the daemon really never saw — on the
  // reference host only 1 of 38 such rows had a partner. Folding those away
  // would hide the one band that is a genuine delivery failure.
  const stats = aggregate([
    promptCall({ ts: "2026-09-06T05:00:00.000Z", status: "ok", hint_count: 1 }),
    clientRow({ ts: "2026-09-06T05:30:00.000Z", status: "daemon-unreachable", latency_ms_total: 8 }),
  ]);
  assert.equal(stats.totals.calls, 2);
  assert.equal(stats.foldedDuplicates, 0);
  assert.equal(stats.totals.errors, 1);
});

// ─── #305: nearness is not call identity ─────────────────────────────────

test("#305: a success in one session is not folded with a timeout in another", () => {
  // The reproduction from the counter-review, and the fault class #305 was
  // opened for one level down. A machine that runs two sessions logs two hook
  // calls 100ms apart all the time; the first fold paired on kind and time
  // alone, so session A's DELIVERED assertion call was folded with session B's
  // client timeout and rewritten to that other session's verdict. On the
  // reference host's seven-day log this hit 82 of 139 client rows — every
  // fold crossed a session, 31 of them overwrote a call the daemon delivered.
  const delivered = promptCall({
    session_id: "session-a",
    ts: "2026-09-06T05:00:00.000Z",
    detected_mode: "assertion",
    status: "ok",
    latency_ms_total: 880,
    hint_count: 3,
  });
  const stats = aggregate([delivered, clientRow({ session_id: "session-b", ts: "2026-09-06T05:00:00.100Z" })]);
  assert.equal(stats.foldedDuplicates, 0, "two sessions are two calls, however close they sit");
  assert.equal(stats.totals.calls, 2);
  const byMode = Object.fromEntries(stats.lanes.map((l) => [l.mode, l]));
  assert.equal(byMode.assertion?.calls, 1);
  assert.equal(byMode.assertion?.timeouts, 0, "session A delivered — its row must not wear session B's timeout");
  assert.equal(byMode.assertion?.withHits, 1);
});

test("#305: two calls of one session close together stay two calls", () => {
  // The other direction: with the session now part of the identity, the window
  // is the only thing left keeping two calls of the SAME session apart. One
  // client row may consume one daemon row, never both.
  const stats = aggregate([
    promptCall({ ts: "2026-09-06T05:00:00.000Z", detected_mode: "assertion", status: "ok", latency_ms_total: 700, hint_count: 2 }),
    promptCall({ ts: "2026-09-06T05:00:00.100Z", detected_mode: "assertion", status: "ok", latency_ms_total: 720, hint_count: 1 }),
    clientRow({ ts: "2026-09-06T05:00:00.150Z" }),
  ]);
  assert.equal(stats.foldedDuplicates, 1);
  assert.equal(stats.totals.calls, 2, "three rows, two of them one call — not one call");
  const assertionLane = stats.lanes.find((l) => l.mode === "assertion");
  assert.equal(assertionLane?.timeouts, 1, "exactly one of the two calls was lost to the turn");
  assert.equal(assertionLane?.latency?.n, 2, "both calls keep the latency the daemon measured");
});

test("#305: a client row without a session is its own call, not the nearest one", () => {
  // Unidentifiable is not the same as unmatched. A row with no session (the
  // payload carried none) cannot be shown to belong to any daemon row, and a
  // fold is a claim that it does.
  const stats = aggregate([
    promptCall({ ts: "2026-09-06T05:00:00.000Z", detected_mode: "assertion", status: "ok", latency_ms_total: 880 }),
    { ...clientRow({ ts: "2026-09-06T05:00:00.100Z" }), session_id: undefined },
  ]);
  assert.equal(stats.foldedDuplicates, 0);
  assert.equal(stats.totals.calls, 2);
});

test("#305: every hook client stamps the payload's session, or the fold has nothing to pair on", async () => {
  // Source-level drift guard, like the client/daemon split test below. The
  // compiled stub wrote an unconditional `randomUUID()` here: its rows carried
  // an id that appeared in no other row of the log, which is why the fold was
  // left pairing on timestamps. The binary is built by `deno compile` and is
  // not executable from this suite, so the constraint is read off the source.
  const src = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["stub/bastra-hook.ts", "src/hook.ts", "src/prompt-hook.ts"]) {
    const body = await readFile(join(src, "..", rel), "utf8");
    assert.match(
      body,
      /session_id:[^,\n]*\?\?\s*randomUUID\(\)/,
      `${rel}: the client row must carry the payload's session (#356)`,
    );
    assert.doesNotMatch(
      body,
      /session_id:\s*randomUUID\(\)/,
      `${rel}: a bare randomUUID() gives the row an id no other row shares — the fold then has nothing to pair on but time (#305)`,
    );
  }
});

test("#305: aggregate does not mutate the events it was handed", () => {
  const daemonRow = promptCall({ ts: "2026-09-06T05:00:00.000Z", detected_mode: "assertion", status: "ok", latency_ms_total: 880 });
  aggregate([daemonRow, clientRow({ ts: "2026-09-06T05:00:00.100Z" })]);
  assert.equal(daemonRow.status, "ok");
});

test("#305: calls inside a daemon restart are reported apart from the normal case", () => {
  // A hook cannot reach a daemon that is not running. Counting a deliberate
  // restart with the rest reports the restart as a delivery failure — on the
  // reference host every single `daemon-unreachable` call sat in one.
  const stats = aggregate([
    { kind: "warmup_settle", ts: "2026-09-06T05:00:00.000Z", trigger: "boot" },
    { kind: "hook_call", ts: "2026-09-06T05:00:05.000Z", status: "daemon-unreachable", latency_ms: 7 },
    { kind: "hook_call", ts: "2026-09-06T05:00:06.000Z", status: "daemon-unreachable", latency_ms: 6 },
    // well clear of the +120s window
    { kind: "hook_call", ts: "2026-09-06T06:00:00.000Z", status: "ok", latency_ms: 60, hint_count: 2 },
  ]);
  assert.equal(stats.restart.windows, 1);
  assert.equal(stats.restart.calls, 2);
  assert.equal(stats.restart.errors, 2);
  assert.equal(stats.totals.calls, 1);
  assert.equal(stats.totals.errors, 0, "a restart must not count against the live delivery rate");
  assert.match(renderStats(stats, 600), /excluded: 2 call\(s\) inside 1 daemon restart window\(s\)/);
});

test("#305: the first prewarm of a fresh daemon process marks a restart too", () => {
  // Not every boot produces a `warmup_settle trigger=boot` row; the prewarm
  // with `embed_calls_since_boot: 0` is the second marker of the same event.
  const windows = restartWindows([
    { kind: "ollama_lifecycle", ts: "2026-09-06T05:00:00.000Z", action: "prewarm", embed_calls_since_boot: 0 },
    { kind: "ollama_lifecycle", ts: "2026-09-06T05:40:00.000Z", action: "prewarm", embed_calls_since_boot: 12 },
  ]);
  assert.equal(windows.length, 1, "a prewarm mid-life is not a boot");
});

test("#305: restarts that overlap collapse into one window, not many", () => {
  const windows = restartWindows([
    { kind: "warmup_settle", ts: "2026-09-06T05:00:00.000Z", trigger: "boot" },
    { kind: "warmup_settle", ts: "2026-09-06T05:00:30.000Z", trigger: "boot" },
    { kind: "warmup_settle", ts: "2026-09-06T06:00:00.000Z", trigger: "boot" },
  ]);
  assert.equal(windows.length, 2);
});

test("#305: the report states what it excluded and what it folded", () => {
  // A rate that quietly got better is not a measurement either.
  const rendered = renderStats(
    aggregate([
      { kind: "warmup_settle", ts: "2026-09-06T05:00:00.000Z", trigger: "boot" },
      { kind: "hook_call", ts: "2026-09-06T05:00:05.000Z", status: "daemon-unreachable", latency_ms: 7 },
      promptCall({ ts: "2026-09-06T06:00:00.000Z", detected_mode: "assertion", status: "ok", latency_ms_total: 700 }),
      clientRow({ ts: "2026-09-06T06:00:00.100Z" }),
    ]),
    600,
  );
  assert.match(rendered, /excluded: 1 call\(s\)/);
  assert.match(rendered, /folded: 1 client-side row\(s\)/);
});

test("#305: the fold's client/daemon split matches what the sources actually stamp", async () => {
  // The fold decides "client row or daemon row" from the `-thin` / `-stub`
  // suffix of `hook_version`. That is a convention, and a convention nothing
  // checks is how #506 happened: a matcher kept naming an event that had been
  // renamed, and no test noticed for seven days. Read the real constants.
  const src = dirname(fileURLToPath(import.meta.url));
  const versionOf = async (rel: string): Promise<string> => {
    const body = await readFile(join(src, "..", rel), "utf8");
    const m = /(?:HOOK_VERSION|STUB_VERSION) = "([^"]+)"/.exec(body);
    assert.ok(m, `${rel}: no HOOK_VERSION/STUB_VERSION found — did the constant move?`);
    return m[1];
  };
  for (const rel of ["src/hook.ts", "src/prompt-hook.ts", "stub/bastra-hook.ts"]) {
    assert.match(
      await versionOf(rel),
      /-(thin|stub)$/,
      `${rel} writes telemetry from the hook process; its version must say so, or its rows count twice`,
    );
  }
  for (const rel of ["src/prompt-lane.ts", "src/write-lane.ts", "src/todo-lane.ts", "src/session-lane.ts"]) {
    assert.doesNotMatch(
      await versionOf(rel),
      /-(thin|stub)$/,
      `${rel} runs in the daemon; a client suffix would make its rows foldable into each other`,
    );
  }
});

test("#305: a window that is nothing but a restart says so", () => {
  const rendered = renderStats(
    aggregate([
      { kind: "warmup_settle", ts: "2026-09-06T05:00:00.000Z", trigger: "boot" },
      { kind: "hook_call", ts: "2026-09-06T05:00:05.000Z", status: "daemon-unreachable", latency_ms: 7 },
    ]),
    600,
  );
  assert.match(rendered, /no hook-lane events/);
  assert.match(rendered, /1 call\(s\) fell inside 1 daemon restart window\(s\)/);
});

// ─── #305: every advertised automatic lane is a gate lane ────────────────

/** `n` rows of one kind, a minute apart, well clear of any restart window. */
function lane(kind: string, n: number, over: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    kind,
    ts: `2026-09-06T0${5 + Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}:00.000Z`,
    session_id: `session-${i}`,
    status: "ok",
    hint_count: 1,
    latency_ms_total: 60,
    ...over,
  }));
}

test("#305: plan, session, Bash pre/post and Stop are lanes, not `other events`", () => {
  // They were counted under `otherKinds` — the orientation line at the bottom
  // of the readout — so five of the seven automatic lanes could not appear in
  // the verdict table at all, let alone fail it.
  const stats = aggregate([
    ...lane("todo_hook_call", 1, { hit_count: 4 }),
    ...lane("session_hook_call", 1),
    ...lane("bash_hook_call", 1),
    ...lane("bash_fail_hook_call", 1, { hit_count: 2 }),
    ...lane("save_eval_call", 1, { status: undefined, suggested_count: 1, latency_ms_total: 30 }),
  ]);
  const modes = stats.lanes.map((l) => l.mode).sort();
  assert.deepEqual(modes, ["bash-post", "bash-pre", "plan", "session", "stop"]);
  assert.deepEqual(stats.otherKinds, [], "a gate lane must not also be filed as a foreign event kind");
  assert.equal(stats.totals.calls, 5);
  // Each of these lanes names its hit count differently; reading only
  // `hint_count` reported three of them as delivering nothing, ever.
  assert.equal(stats.lanes.every((l) => l.withHits === 1), true, JSON.stringify(stats.lanes));
});

test("#305: a Stop lane over its failure ceiling turns the gate red", () => {
  // The structural half of the defect: before the lane existed in the table,
  // 40 broken Stop calls next to one healthy write lane printed `gate: MET`.
  // The Stop lane stamps no status — its failure shape is the fail-open
  // backstop's `error` field.
  const stats = aggregate([
    ...lane("hook_call", 40, { latency_ms: 60 }),
    ...lane("save_eval_call", 40, { status: undefined, error: "transcript unreadable", latency_ms_total: 30 }),
  ]);
  const rendered = renderStats(stats, 600);
  assert.match(rendered, /stop\s+1000ms budget · p90 ≤ 200ms · fail ≤ 2% — FAIL: 40\/40 calls returned nothing/);
  assert.match(rendered, /gate: NOT MET/);
});

test("#305: an automatic lane the window never saw is NOT EVALUABLE, not absent", () => {
  // "We did not measure it" is a verdict of its own — #437's word for the
  // same situation in the experiment arms (stats-arms.ts). A lane that simply
  // leaves the list is what let this gate call a release green while five
  // lanes went unmeasured.
  const rendered = renderStats(aggregate(lane("hook_call", 40, { latency_ms: 60 })), 600);
  for (const mode of ["plan", "session", "bash-pre", "bash-post", "stop"]) {
    assert.match(
      rendered,
      new RegExp(`${mode}\\s+\\d+ms budget · [^\\n]*— NOT EVALUABLE \\(0 call\\(s\\) of the min-N 30\\)`),
      `${mode} must state that it was not measured`,
    );
  }
  assert.match(rendered, /pretooluse\s+600ms budget[^\n]*— PASS/);
  assert.match(rendered, /gate: NOT MET/, "one healthy lane out of seven is not a release");
});

test("#305: every gate lane has a threshold, and every threshold names a real budget", () => {
  // Drift guard: a lane counted into the table without a threshold silently
  // falls back to the `no-threshold` branch, which the gate accepts — the
  // exact hole this pass closed.
  for (const mode of REQUIRED_LANES) {
    const t = RELEASE_THRESHOLDS[mode];
    assert.ok(t, `${mode} is counted as a lane but has no release threshold`);
    assert.ok(
      [RECALL_BUDGET_MS, FAST_BUDGET_MS, STOP_BUDGET_MS, PROMPT_ASSERTION_BUDGET_MS].includes(t.budgetMs),
      `${mode}: ${t.budgetMs}ms is not one of the budgets hook-budgets.ts enforces`,
    );
    assert.ok(t.p90TargetMs <= t.budgetMs, `${mode}: a p90 target above the lane's own budget cannot be missed`);
  }
  assert.deepEqual(
    Object.values(GATE_LANE_BY_KIND).sort(),
    ["bash-post", "bash-pre", "plan", "pretooluse", "session", "stop"],
    "all six kind-based automatic lanes, or the gate covers fewer lanes than the product advertises",
  );
});
