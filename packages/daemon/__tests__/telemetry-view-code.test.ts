/**
 * The Telemetry tab must be able to name every `unavailable` reason (#579).
 *
 * The tab turns a reason code into a sentence a human can act on. A code with no
 * entry falls back to the raw token, which is not wrong but is exactly the kind
 * of silent gap this section exists to close: `degraded` means "a defect, run
 * bastra doctor" and `cold` means "nothing is wrong, ask again" — printing both
 * as a bare identifier hides the difference.
 *
 * So this pins the label map against the reason codes the classifier can
 * produce. No DOM, like telemetry-view-suppression.test.ts.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/telemetry-view-code.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain browser module, no types.
import { UNAVAILABLE_REASONS, latency, renderCodeAwareness } from "../webui/js/managers/telemetry-view-code.js";
import type { CodeUnavailableReason } from "../src/code-graph/unavailable-reason.js";
import { summarizeCodeAwareness } from "../src/telemetry-report-code.js";

/** Every value `unavailableReason()` can return, listed by hand on purpose:
 *  the type is erased at runtime, so a new code has to be added here too. */
const REASONS: CodeUnavailableReason[] = [
  "off_env",
  "not_enabled",
  "degraded",
  "not_indexed",
  "loading",
  "cold",
];

test("every unavailable reason has a sentence in the tab", () => {
  for (const r of REASONS) {
    const label = (UNAVAILABLE_REASONS as Record<string, string>)[r];
    assert.ok(typeof label === "string" && label.length > 0, `no label for ${r}`);
    assert.notEqual(label, r, `${r} is shown as its raw code`);
  }
});

test("the labels do not turn a cold start into a failure", () => {
  const l = UNAVAILABLE_REASONS as Record<string, string>;
  assert.match(l.degraded, /doctor/);
  assert.doesNotMatch(l.cold, /error|failed|broken/i);
  assert.doesNotMatch(l.loading, /error|failed|broken/i);
});

// #665 — display details. `latency` is pure; the rendered rows use the same
// DOM-less fixture code-telemetry-review-fixes.test.ts introduced.
test("latency: n/a when nothing was measured, one decimal under 10 ms, whole ms above", () => {
  assert.equal(latency(null), "n/a");
  assert.equal(latency(undefined), "n/a");
  assert.equal(latency(0.34), "0.3 ms");
  assert.equal(latency(9.96), "10.0 ms");
  assert.equal(latency(1234.56), "1235 ms");
});

class FixtureNode {
  children: FixtureNode[] = [];
  className = "";
  style: Record<string, string> = {};
  constructor(readonly tag: string, readonly text = "") {}
  setAttribute(_key: string, _value: string): void {}
  append(child: FixtureNode): void { this.children.push(child); }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
}
const all = (node: FixtureNode): FixtureNode[] => [node, ...node.children.flatMap(all)];
const row = (nodes: FixtureNode[], label: string) =>
  nodes.find((n) => n.tag === "tr" && n.children[0]?.textContent === label);

test("the tab shows the interrupted bucket and n/a latency instead of 0 ms", (t) => {
  for (const [name, value] of Object.entries({ Node: FixtureNode, document: {
    createElement: (tag: string) => new FixtureNode(tag), createTextNode: (text: string) => new FixtureNode("#text", text),
  } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  const report = summarizeCodeAwareness([
    { kind: "code_graph_refresh", outcome: "started", repo: "a/b" },
    { kind: "code_graph_refresh", outcome: "started", repo: "a/b" },
    { kind: "code_graph_refresh", outcome: "locked", duration_ms: 1, repo: "a/b" },
    { kind: "code_tool_call", tool: "find_code", status: "ok", lane: "symbol", hits: 1, files: 0, took_ms: 0.34, repo: "a/b", surface: "mcp" },
    { kind: "code_tool_call", surface: "delivered", tool: "find_affected_files", status: "ok", tokens_est: 30, delivered_lane: "boundary", files: 1 },
  ].map((r) => ({ ts: "2026-10-10T00:00:00Z", ...r })) as never)!;
  assert.ok(report);
  const nodes = all(renderCodeAwareness(report));

  const interrupted = row(nodes, "interrupted");
  assert.ok(interrupted, "refresh table has an interrupted row");
  assert.equal(interrupted.children[1].textContent, "1");
  assert.equal(row(nodes, "build duration p50 / p90")!.children[1].textContent, "n/a / n/a");
  assert.equal(row(nodes, "latency p50 / p90")!.children[1].textContent, "n/a / n/a");

  const tool = nodes.find((n) => n.tag === "tr" && n.children[0]?.textContent === "find_code" && n.children.length === 5);
  assert.ok(tool, "latency & reach row for find_code");
  assert.equal(tool.children[2].textContent, "0.3 ms");
  assert.equal(tool.children[4].textContent, "n/a", "find_code cannot name files for a symbol query");

  // The repos figure counts repos that were asked, not merely refreshed.
  const calls = nodes.find((n) => n.children[0]?.className === "tv-fig-k" && n.children[0].textContent === "tool calls");
  assert.ok(calls);
  assert.equal(calls.children[2].textContent, "1 repository asked");

  // A report from before the bucket existed still renders.
  const legacy = { ...report, active: { ...report.active, refresh: { ...report.active.refresh, interrupted: undefined } } };
  assert.equal(row(all(renderCodeAwareness(legacy as never)), "interrupted")!.children[1].textContent, "0");
});
