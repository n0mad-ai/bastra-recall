import test from "node:test";
import assert from "node:assert/strict";
import { aggregateCodeAwareness } from "../src/code-awareness-stats.js";
import { summarizeCodeAwareness } from "../src/telemetry-report-code.js";
// @ts-expect-error — browser module has no declaration file.
import { renderCodeAwareness } from "../webui/js/managers/telemetry-view-code.js";

class FixtureNode {
  children: FixtureNode[] = [];
  className = "";
  style: Record<string, string> = {};
  constructor(readonly tag: string, readonly text = "") {}
  setAttribute(_key: string, _value: string): void {}
  append(child: FixtureNode): void { this.children.push(child); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
}
function all(node: FixtureNode): FixtureNode[] { return [node, ...node.children.flatMap(all)]; }

test("#663: the rendered delivery tile uses one source; passive share names its denominator", t => {
  for (const [name, value] of Object.entries({ Node: FixtureNode, document: {
    createElement: (tag: string) => new FixtureNode(tag), createTextNode: (text: string) => new FixtureNode("#text", text),
  } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  const report = summarizeCodeAwareness([
    { kind: "hook_call", hint_tokens_est: 1000, code_block_tokens_est: 250 },
    { kind: "hook_prompt_call", hint_tokens_est: 9000 },
    { kind: "code_tool_call", surface: "delivered", tool: "find_affected_files", status: "ok", tokens_est: 70, delivered_lane: "write" },
    { kind: "code_tool_call", surface: "delivered", tool: "find_affected_files", status: "ok", tokens_est: 30, delivered_lane: "prompt" },
    { kind: "code_tool_call", surface: "delivered", tokens_est: 999, dedupe_hit: true },
  ].map(row => ({ ts: "2026-10-10T00:00:00Z", ...row })));
  assert.ok(report);
  const render = (value: typeof report): FixtureNode[] => all(renderCodeAwareness(value));
  const nodes = render(report);
  const figure = nodes.find(node => node.children[0]?.className === "tv-fig-k" && node.children[0].textContent === "delivered blocks");
  assert.ok(figure);
  assert.equal(figure.children[1].textContent, "2");
  assert.equal(figure.children[2].textContent, "100 tokens", "must use 70 + 30 delivered tokens, not 250 passive or 999 deduped");
  const share = nodes.find(node => node.tag === "tr" && node.children[0]?.textContent === "share of Write/Edit injection");
  assert.ok(share); assert.equal(share.children[1].textContent, "25.0%");
  assert.doesNotMatch(nodes[0].textContent, /of everything injected/);
  const legacy = { ...report, active: { ...report.active, delivered: undefined } };
  const oldFigure = render(legacy as unknown as typeof report).find(node => node.children[0]?.textContent === "delivered blocks");
  assert.ok(oldFigure); assert.equal(oldFigure.children[2].textContent, "0 tokens", "old reports must not borrow passive costs");
});

test("#665: only successful/failed build durations enter percentiles; other counts remain", () => {
  const refresh = (outcome: string, duration_ms: number) => ({ kind: "code_graph_refresh", outcome, duration_ms });
  const stats = aggregateCodeAwareness([
    refresh("started", 500_000), refresh("ok", 100), refresh("ok", 200), refresh("failed", 300),
    ...Array.from({ length: 50 }, () => refresh("locked", 1)), refresh("skipped", 800_000), refresh("given-up", 900_000),
  ]).refresh;
  assert.equal(stats.p50, 200); assert.equal(stats.p90, 300);
  assert.equal(stats.started, 1); assert.equal(stats.ok, 2); assert.equal(stats.failed, 1);
  assert.equal(stats.locked, 50); assert.equal(stats.skipped, 1); assert.equal(stats.givenUp, 1);
  assert.equal(aggregateCodeAwareness([refresh("locked", 1)]).refresh.p50, 0);
});
