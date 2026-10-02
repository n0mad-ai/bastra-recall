/**
 * The Telemetry tab's band tables count `hook_recall.hits[]` — the engine's raw
 * top-k, before the hook CLIs apply the score floor, scope filter and
 * per-session dedup. That population is called `candidates`, in the report
 * JSON and on screen, the same word `scripts/stats.ts` prints for it (#795);
 * "surfaced" stays reserved for what a hook actually injected.
 *
 * Renders the real section from the real read model, so a rename on one side
 * only shows up as an empty cell here. The DOM is a stub of the few calls
 * telemetry-dom.js makes.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/telemetry-view-candidates.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeQuality, type ReportEvent } from "../src/telemetry-report.js";

class StubNode {
  children: StubNode[] = [];
  style: Record<string, string> = {};
  className = "";
  constructor(readonly tag: string, readonly text = "") {}
  setAttribute(): void {}
  append(...nodes: StubNode[]): void {
    this.children.push(...nodes);
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  all(tag: string): StubNode[] {
    return this.children.flatMap((c) => (c.tag === tag ? [c, ...c.all(tag)] : c.all(tag)));
  }
}

const ts = "2026-09-01T10:00:00.000Z";
const EVENTS: ReportEvent[] = [
  { kind: "hook_recall", ts, recall_id: "r1", tool_name: "Write", hits: [{ id: "a", score: 150 }, { id: "b", score: 60 }, { id: "c", score: 10 }] },
  { kind: "hook_recall", ts, recall_id: "r2", tool_name: "Bash", hits: [{ id: "d", score: 120 }] },
  { kind: "recall_episode", ts, recall_id: "r1", memory_id: "a", surfaced: true, band: "required", acted_on: true },
];

test("the band and source tables show the raw top-k as `candidates`, with its counts", async () => {
  const g = globalThis as Record<string, unknown>;
  g.Node = StubNode;
  g.document = {
    createElement: (tag: string) => new StubNode(tag),
    createTextNode: (text: string) => new StubNode("#text", text),
  };
  try {
    // @ts-expect-error — plain browser module, no types (same as telemetry-view-suppression.test.ts).
    const { renderQuality } = await import("../webui/js/managers/telemetry-view.js");
    const T = { mustLoadScore: 100, scoreFloor: 30 };
    const el: StubNode = renderQuality(summarizeQuality(EVENTS, T), T);

    const rows = el.all("tr").map((tr) => tr.children.map((c) => c.textContent));
    assert.deepEqual(rows.find((r) => r[0] === "band" && r.includes("use-rate"))?.[2], "candidates");
    assert.deepEqual(rows.find((r) => r[0] === "source")?.[1], "candidates");
    // band · bar · candidates · loaded · load lower bound · acted · use-rate
    assert.deepEqual(rows.find((r) => r[0] === "required"), ["required", "", "2", "1", "50.0%", "1", "100.0%"]);
    assert.deepEqual(rows.find((r) => r[0] === "below_floor"), ["below_floor", "", "1", "0", "0.0%", "0", "—"]);
    assert.deepEqual(rows.find((r) => r[0] === "write-edit"), ["write-edit", "3", "1", "33.3%", "1", "100.0%"]);
    assert.doesNotMatch(el.textContent, /surfaced/i, "the raw top-k must not be called surfaced");
  } finally {
    delete g.Node;
    delete g.document;
  }
});
