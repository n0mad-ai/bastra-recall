/**
 * The code-awareness readout (#589) — the ACTIVE half.
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
    assert.equal(s.refresh.p50, 1000);
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
    assert.match(out, /code awareness — tool calls/);
    assert.match(out, /find_code: 1 call\(s\)/);
  });

  it("reaches the UI report next to the other sections", () => {
    const report = buildTelemetryReport(
      { events: [toolCall(), refresh()] as never, files: 1, from: null, to: null },
      7,
      { mustLoadScore: 100, scoreFloor: 30 },
      30,
    );
    assert.equal(report.codeAwareness?.active.tools[0]?.tool, "find_code");
    assert.equal(report.codeAwareness?.active.refresh.ok, 1);
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
