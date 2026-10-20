/**
 * The code-awareness readout (#579) — the ACTIVE half.
 *
 * What is worth holding down here is the same thing #579 pinned for the passive
 * half: the readout must not turn silence into a claim. Specifically —
 *
 *   - a window with no code-awareness event produces nothing at all, so the tab
 *     and the CLI do not grow a section of zeroes on a vault that never turned
 *     the feature on;
 *   - `unavailable` is never collapsed: off, not-enabled, degraded, not-indexed,
 *     loading and cold are six different answers and only one of them is a bug;
 *   - a row written before a field existed is counted as a call and given no
 *     reason it never carried;
 *   - the CLI text and the UI JSON come out of ONE fold, which is why this file
 *     tests the fold and the renderer reads it.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/code-awareness-stats.test.ts`
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { aggregateCodeAwareness } from "../src/code-awareness-stats.js";
import { renderCodeAwareness } from "../src/cli/log-stats-code.js";
import { summarizeCodeAwareness } from "../src/telemetry-report-code.js";
import { aggregate, renderStats } from "../src/cli/log-stats.js";
import { buildTelemetryReport } from "../src/telemetry-report.js";
import { logDeliveredBlock } from "../src/code-delivered-telemetry.js";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const toolCall = (over: Record<string, unknown> = {}) => ({
  kind: "code_tool_call",
  ts: "2026-09-19T10:00:00.000Z",
  tool: "find_code",
  status: "ok",
  mode: "find",
  lane: "symbol",
  hits: 3,
  files: 0,
  truncated: false,
  took_ms: 2,
  repo: "Projekte/bastra-recall",
  surface: "mcp",
  ...over,
});

/** #606: the same answer, delivered through a hook lane instead of called for. */
const delivered = (over: Record<string, unknown> = {}) => ({
  kind: "code_tool_call",
  ts: "2026-09-19T10:00:00.000Z",
  tool: "find_affected_files",
  status: "ok",
  basis: "diff",
  hits: 4,
  files: 4,
  truncated: false,
  took_ms: 8,
  repo: "Projekte/bastra-recall",
  surface: "delivered",
  delivered_lane: "write",
  tokens_est: 120,
  ...over,
});

const refresh = (over: Record<string, unknown> = {}) => ({
  kind: "code_graph_refresh",
  ts: "2026-09-19T10:00:00.000Z",
  repo: "Projekte/bastra-recall",
  reason: "watcher",
  outcome: "ok",
  duration_ms: 1200,
  ...over,
});

describe("code awareness: tool calls", () => {
  it("splits a call by what came back, not just by how many there were", () => {
    const s = aggregateCodeAwareness([
      toolCall(),
      toolCall({ status: "no_answer", lane: undefined, hits: 0 }),
      toolCall({ status: "unavailable", lane: undefined, hits: 0, unavailable_reason: "not_indexed" }),
      toolCall({ status: "unavailable", lane: undefined, hits: 0, unavailable_reason: "loading" }),
    ]);
    const t = s.tools.find((x) => x.tool === "find_code")!;
    assert.equal(t.calls, 4);
    assert.equal(t.ok, 1);
    assert.equal(t.noAnswer, 1);
    assert.equal(t.unavailable, 2);
    assert.deepEqual(
      t.byUnavailableReason.map((r) => r.key).sort(),
      ["loading", "not_indexed"],
    );
  });

  it("keeps the two tools apart and orders them stably", () => {
    const s = aggregateCodeAwareness([
      toolCall({ tool: "find_affected_files", lane: undefined, basis: "diff", files: 7 }),
      toolCall(),
    ]);
    assert.deepEqual(s.tools.map((t) => t.tool), ["find_code", "find_affected_files"]);
    const aff = s.tools[1]!;
    assert.equal(aff.filesNamed, 7);
    assert.deepEqual(aff.byKind, [{ key: "diff", count: 1 }]);
  });

  it("counts an unavailable row from before the reason field as unavailable, never as a reason it never carried", () => {
    const s = aggregateCodeAwareness([toolCall({ status: "unavailable", lane: undefined })]);
    const t = s.tools[0]!;
    assert.equal(t.unavailable, 1);
    assert.deepEqual(t.byUnavailableReason, [{ key: "unknown", count: 1 }]);
  });

  it("reports latency percentiles and survives malformed numbers", () => {
    const s = aggregateCodeAwareness([
      toolCall({ took_ms: 1 }),
      toolCall({ took_ms: 5 }),
      toolCall({ took_ms: 9 }),
      toolCall({ took_ms: "quick" }),
      toolCall({ took_ms: Number.NaN }),
    ]);
    const t = s.tools[0]!;
    assert.equal(t.calls, 5);
    assert.equal(t.p50, 5);
    assert.equal(t.p90, 9);
  });
});

describe("code awareness: graph refresh", () => {
  it("counts runs by outcome and reports how long the repo was behind", () => {
    const s = aggregateCodeAwareness([
      refresh({ outcome: "started", duration_ms: undefined }),
      refresh({ duration_ms: 1000 }),
      refresh({ outcome: "failed", detail: "graphify exited 1", duration_ms: 3000 }),
      refresh({ outcome: "locked", duration_ms: 20 }),
    ]);
    assert.equal(s.refresh.started, 1);
    assert.equal(s.refresh.ok, 1);
    assert.equal(s.refresh.failed, 1);
    assert.equal(s.refresh.locked, 1);
    assert.deepEqual(s.refresh.failures, [{ key: "graphify exited 1", count: 1 }]);
    assert.equal(s.refresh.p50, 3000, "locked checks are not build durations");
    assert.equal(s.refresh.p90, 3000);
  });

  it("carries the newest external nodes / resolved per repository (#582)", () => {
    const s = aggregateCodeAwareness([
      refresh({ external_total: 40, external_resolved: 0 }),
      refresh({ external_total: 40, external_resolved: 31 }),
    ]);
    assert.deepEqual(s.repos, [
      { repo: "Projekte/bastra-recall", toolCalls: 0, refreshes: 2, externalTotal: 40, externalResolved: 31 },
    ]);
  });

  it("counts repositories from both event kinds", () => {
    const s = aggregateCodeAwareness([
      toolCall({ repo: "a/one" }),
      refresh({ repo: "b/two" }),
    ]);
    assert.deepEqual(s.repos.map((r) => r.repo).sort(), ["a/one", "b/two"]);
  });

  it("folds a throwaway tree under /tmp into one labeled row, not a repo named \"tmp\"", () => {
    const s = aggregateCodeAwareness([
      toolCall({ repo: "tmp" }),
      refresh({ repo: "tmp", external_total: 5, external_resolved: 0 }),
      toolCall({ repo: "Projekte/bastra-recall" }),
    ]);
    const temp = s.repos.find((r) => r.repo === "(temporary tree)");
    assert.deepEqual(temp, { repo: "(temporary tree)", toolCalls: 1, refreshes: 1, externalTotal: null, externalResolved: null });
    assert.ok(s.repos.some((r) => r.repo === "Projekte/bastra-recall"));
    assert.equal(s.repos.length, 2);
  });

  it("folds macOS's $TMPDIR shape (T/<random>) into the same temp-tree row", () => {
    const s = aggregateCodeAwareness([
      toolCall({ repo: "T/code-roi-arm-ab12cd" }),
      toolCall({ repo: "tmp" }),
    ]);
    assert.deepEqual(s.repos, [{ repo: "(temporary tree)", toolCalls: 2, refreshes: 0, externalTotal: null, externalResolved: null }]);
  });

  it("does not treat a real repo merely starting with those letters as a temp tree", () => {
    const s = aggregateCodeAwareness([toolCall({ repo: "tmproject/api" }), toolCall({ repo: "Team/api" })]);
    assert.deepEqual(s.repos.map((r) => r.repo).sort(), ["Team/api", "tmproject/api"]);
  });
});

describe("code awareness: the two readouts", () => {
  it("prints nothing when the window holds no code-awareness event", () => {
    assert.deepEqual(renderCodeAwareness(aggregateCodeAwareness([])), []);
    assert.equal(summarizeCodeAwareness([]), null);
  });

  it("names the unavailable reasons in the CLI text rather than only the total", () => {
    const out = renderCodeAwareness(
      aggregateCodeAwareness([
        toolCall({ status: "unavailable", lane: undefined, unavailable_reason: "not_enabled" }),
      ]),
    ).join("\n");
    assert.match(out, /find_code: 1 call\(s\)/);
    assert.match(out, /unavailable because: not_enabled×1/);
  });

  it("hands the UI the same fold the CLI prints", () => {
    const events = [toolCall(), refresh()];
    const section = summarizeCodeAwareness(events as never)!;
    assert.deepEqual(section.active, aggregateCodeAwareness(events));
    // The passive half stays #579's, unfolded from hook_call rows.
    assert.equal(section.block.withCodeBlock, 0);
  });

  it("reaches `bastra logs --stats` even when the window has no hook lane call at all", () => {
    // The old early return printed "(no hook-lane events…)" and stopped, so an
    // agent that only ever calls find_code produced a readout of nothing.
    const out = renderStats(aggregate([toolCall()]), 400);
    assert.match(out, /code awareness \(experimental\) — tool calls/);
    assert.match(out, /find_code: 1 call\(s\)/);
  });

  it("reaches the UI report next to the other sections", () => {
    const report = buildTelemetryReport(
      { events: [toolCall(), refresh()] as never, files: 1, from: null, to: null, excludedEval: 0, foldedDuplicates: 0 },
      7,
      { mustLoadScore: 100, scoreFloor: 30 },
      30,
    );
    assert.equal(report.codeAwareness?.active.tools[0]?.tool, "find_code");
    assert.equal(report.codeAwareness?.active.refresh.ok, 1);
  });

  it("counts a delivered block apart from the tool calls (#606)", () => {
    // The point of the split: a delivered block must not be able to answer
    // "does anyone call find_affected_files?" with Recall's own injection.
    const s = aggregateCodeAwareness([
      toolCall(),
      delivered(),
      delivered({ delivered_lane: "prompt", basis: "symbols", files: 2, tokens_est: 90 }),
      delivered({ dedupe_hit: true, status: "no_answer", basis: undefined }),
    ]);
    assert.equal(s.events, 4);
    assert.equal(s.tools.length, 1);
    assert.equal(s.tools[0].tool, "find_code");
    assert.equal(s.delivered.blocks, 2);
    assert.equal(s.delivered.dedupeHits, 1);
    // #665: "by lane" sums to the blocks injected, not to blocks + dedupe hits.
    assert.deepEqual(s.delivered.byLane, [
      { key: "write", count: 1 },
      { key: "prompt", count: 1 },
    ]);
    assert.deepEqual(s.delivered.byBasis, [
      { key: "diff", count: 1 },
      { key: "symbols", count: 1 },
    ]);
    assert.equal(s.delivered.filesNamed, 6);
    assert.equal(s.delivered.tokensTotal, 210);
  });

  it("prints the delivered half in `bastra logs --stats`", () => {
    const out = renderCodeAwareness(
      aggregateCodeAwareness([delivered(), delivered({ dedupe_hit: true, status: "no_answer" })]),
    ).join("\n");
    assert.match(out, /delivered blocks: 1 injected, 1 suppressed as already delivered/);
    assert.match(out, /by lane: write×1/);
    assert.match(out, /by basis: diff×1/);
    assert.match(out, /cost: 120 tokens total/);
  });

  it("hands the UI the delivered fold the CLI printed", () => {
    const events = [delivered()];
    const section = summarizeCodeAwareness(events as never)!;
    assert.deepEqual(section.active, aggregateCodeAwareness(events));
    assert.equal(section.active.delivered.blocks, 1);
  });

  it("keeps a window that only ever injected blocks — no tool call, still a section", () => {
    const section = summarizeCodeAwareness([
      { kind: "hook_call", ts: "2026-09-19T10:00:00.000Z", code_block_tokens_est: 120, code_dependents: 3 },
    ] as never)!;
    assert.notEqual(section, null);
    assert.equal(section.active.events, 0);
    assert.equal(section.block.withCodeBlock, 1);
  });
});

describe("code awareness: audit follow-ups (#665)", () => {
  it("books a start with no terminal row as interrupted, so started = ok + failed + locked + interrupted", () => {
    const s = aggregateCodeAwareness([
      refresh({ outcome: "started" }),
      refresh({ outcome: "ok" }),
      refresh({ outcome: "started" }),
      refresh({ outcome: "locked", duration_ms: 1 }),
      refresh({ outcome: "started" }),
      refresh({ outcome: "failed", detail: "x" }),
      refresh({ outcome: "given-up", detail: "x" }),
      refresh({ outcome: "started" }), // daemon restarted mid-build
      refresh({ outcome: "skipped", detail: "graph fresh" }), // never had a start
    ]).refresh;
    assert.equal(s.started, 4);
    assert.equal(s.interrupted, 1);
    assert.equal(s.started, s.ok + s.failed + s.locked + s.interrupted);
  });

  it("never reports a negative interrupted count when a start fell outside the window", () => {
    const s = aggregateCodeAwareness([refresh({ outcome: "ok" })]).refresh;
    assert.equal(s.interrupted, 0);
  });

  it("prints the interrupted bucket in `bastra logs --stats`", () => {
    const out = renderCodeAwareness(
      aggregateCodeAwareness([refresh({ outcome: "started" }), refresh({ outcome: "started" }), refresh()]),
    ).join("\n");
    assert.match(out, /graph refresh: 2 run\(s\) — 1 ok, 0 failed, 0 locked, 1 interrupted, 0 skipped, 0 given up/);
  });

  it("counts 'by lane' after the dedupe check, so it sums to the blocks injected", () => {
    const s = aggregateCodeAwareness([
      delivered({ delivered_lane: "write" }),
      delivered({ delivered_lane: "write", dedupe_hit: true, status: "no_answer", basis: undefined }),
      delivered({ delivered_lane: "boundary", dedupe_hit: true, status: "no_answer", basis: undefined }),
    ]).delivered;
    assert.equal(s.blocks, 1);
    assert.equal(s.dedupeHits, 2);
    assert.deepEqual(s.byLane, [{ key: "write", count: 1 }]);
    assert.equal(s.byLane.reduce((n, l) => n + l.count, 0), s.blocks);
  });

  it("reports no latency at all, not 0 ms, when no delivered row was timed", () => {
    const s = aggregateCodeAwareness([delivered({ took_ms: undefined, delivered_lane: "boundary", basis: undefined })]);
    assert.equal(s.delivered.blocks, 1);
    assert.equal(s.delivered.p50, null);
    assert.equal(s.delivered.p90, null);
    const out = renderCodeAwareness(s).join("\n");
    assert.match(out, /delivered blocks: 1 injected/);
    assert.match(out, /latency: p50 n\/a, p90 n\/a/);
  });

  it("reports no build duration when only lock checks ran", () => {
    const s = aggregateCodeAwareness([refresh({ outcome: "started" }), refresh({ outcome: "locked", duration_ms: 1 })]);
    assert.equal(s.refresh.p50, null);
    assert.match(renderCodeAwareness(s).join("\n"), /build duration \(successful or failed\): p50 n\/a, p90 n\/a/);
  });

  it("keeps a sub-10 ms latency from rounding to 0 ms in the CLI", () => {
    const out = renderCodeAwareness(aggregateCodeAwareness([toolCall({ took_ms: 0.34 })])).join("\n");
    assert.match(out, /latency: p50 0\.3 ms, p90 0\.3 ms/);
    const slow = renderCodeAwareness(aggregateCodeAwareness([toolCall({ took_ms: 1234.56 })])).join("\n");
    assert.match(slow, /latency: p50 1235 ms, p90 1235 ms/);
  });

  it("shows n/a for find_code's files named when nothing could name one", () => {
    const out = renderCodeAwareness(aggregateCodeAwareness([toolCall({ files: 0 })])).join("\n");
    assert.match(out, /files named: n\/a/);
    const aff = renderCodeAwareness(
      aggregateCodeAwareness([toolCall({ tool: "find_affected_files", lane: undefined, basis: "diff", files: 0 })]),
    ).join("\n");
    assert.match(aff, /0 file\(s\) named/);
  });

  it("omits took_ms from a delivered row that was not timed, instead of writing 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bastra-665-"));
    const prev = process.env.BASTRA_LOG_PATH;
    process.env.BASTRA_LOG_PATH = dir;
    try {
      await logDeliveredBlock({ sessionId: "s1", lane: "boundary", repo: "/x/Projekte/bastra-recall", files: 2, tokensEst: 40, dedupeHit: false });
      await logDeliveredBlock({ sessionId: "s1", lane: "write", repo: "/x/Projekte/bastra-recall", basis: "diff", files: 1, tokensEst: 20, tookMs: 7, dedupeHit: false });
    } finally {
      if (prev === undefined) delete process.env.BASTRA_LOG_PATH;
      else process.env.BASTRA_LOG_PATH = prev;
    }
    const rows: Record<string, unknown>[] = [];
    for (const f of (await readdir(dir)).filter((n) => n.startsWith("events-"))) {
      for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line) rows.push(JSON.parse(line));
    }
    assert.equal(rows.length, 2);
    const boundary = rows.find((r) => r.delivered_lane === "boundary")!;
    const write = rows.find((r) => r.delivered_lane === "write")!;
    assert.ok(!("took_ms" in boundary), "untimed row must not carry took_ms");
    assert.equal(write.took_ms, 7);
    // …and the fold leaves the untimed row out of the percentiles.
    assert.equal(aggregateCodeAwareness(rows).delivered.p50, 7);
  });
});
