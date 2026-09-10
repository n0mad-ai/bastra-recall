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

import { aggregate, percentiles, renderStats, DEFAULT_HOOK_BUDGET_MS } from "../src/cli/log-stats.js";

function promptCall(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "prompt_hook_call",
    ts: "2026-07-28T05:00:00.000Z",
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

test("the render names the budget and the headroom against it", () => {
  const stats = aggregate([
    promptCall({ detected_mode: "assertion", latency_ms_total: 259, status: "timeout" }),
  ]);
  const out = renderStats(stats, 250);
  assert.match(out, /assertion/);
  assert.match(out, /hook budget 250ms/);
  assert.match(out, /-4% headroom/); // p90 259 against a 250 ceiling
  assert.match(out, /1 timeout\(s\)/);
});

test("an empty window says so instead of rendering an empty table", () => {
  assert.match(renderStats(aggregate([]), 600), /no prompt-hook events/);
});

test("the readout's budget default matches what the hooks actually enforce", async () => {
  // A readout that names a ceiling the hooks do not use reports the wrong
  // headroom — and it did exactly that once, claiming 250ms after the hooks
  // moved to 600ms.
  const src = dirname(fileURLToPath(import.meta.url));
  for (const hook of ["hook.ts", "prompt-hook.ts", "todo-hook.ts"]) {
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
