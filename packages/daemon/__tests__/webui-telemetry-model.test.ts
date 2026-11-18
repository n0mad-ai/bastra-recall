// Web UI telemetry area (js/sections/telemetry-model.js): the display must stay
// honest about what was measured. Carried over from the old Telemetry tab tests
// (telemetry-view-code.test.ts #665, telemetry-view-suppression.test.ts #484):
// nothing measured reads "n/a" or "—", never "0 ms", and a shadow window never
// claims a removal or a saving. The real module runs in a VM context with the
// real English strings; the code section is fed by the daemon's own summarizer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { summarizeCodeAwareness } from "../src/telemetry-report-code.js";

/** The web UI folder. The only place this file names it (rename: #1572). */
const WEBUI = new URL("../webui/app/js/", import.meta.url);

const read = (path: string) => readFile(new URL(path, WEBUI), "utf8");

async function model(lang: "en" | "de" = "en") {
  const strings = runInNewContext(
    `(${(await read(`i18n/telemetry-${lang}.js`)).replace(/^[\s\S]*?export default/m, "").replace(/;\s*$/, "")})`
  );
  const source = (await read("sections/telemetry-model.js"))
    .replace(/^import [\s\S]*?;$/gm, "")
    .replace(/^export /gm, "");
  const m = runInNewContext(`${source}\n({ buildModel })`, {
    LANG: lang,
    t: (key: string, vars?: Record<string, unknown>) => {
      const raw: string = strings[key] ?? key;
      return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : raw;
    },
  });
  // Copy the VM's objects into this realm so deepStrictEqual compares values only.
  return { buildModel: (report: unknown) => structuredClone(m.buildModel(report)) };
}

type Block = { kind: string; h3?: string; rows?: unknown[][] };
type Section = {
  id: string;
  q: string;
  key: string;
  figs?: Array<{ k: string; v: string; sub: string }>;
  topNotes?: unknown[];
  cols: Block[][];
};
const section = (m: any, report: unknown, id: string): Section =>
  m.buildModel(report).sections.find((s: Section) => s.id === id);
const cell = (c: unknown) => (c && typeof c === "object" ? (c as { t?: string }).t : c);
const table = (s: Section, h3: string) => s.cols.flat().find((b) => b.h3 === h3)!;
const row = (b: Block, label: string) => b.rows!.find((r) => cell(r[0]) === label)!.map(cell);

const CODE_EVENTS = [
  { kind: "code_graph_refresh", outcome: "started", repo: "a/b" },
  { kind: "code_graph_refresh", outcome: "started", repo: "a/b" },
  { kind: "code_graph_refresh", outcome: "locked", duration_ms: 1, repo: "a/b" },
  {
    kind: "code_tool_call",
    tool: "find_code",
    status: "ok",
    lane: "symbol",
    hits: 1,
    files: 0,
    took_ms: 0.34,
    repo: "a/b",
    surface: "mcp",
  },
  {
    kind: "code_tool_call",
    surface: "delivered",
    tool: "find_affected_files",
    status: "ok",
    tokens_est: 30,
    delivered_lane: "boundary",
    files: 1,
  },
].map((r) => ({ ts: "2026-10-10T00:00:00Z", ...r }));

test("telemetry: code latency reads n/a when nothing was measured, one decimal under 10 ms", async () => {
  const m = await model();
  const s = section(m, { codeAwareness: summarizeCodeAwareness(CODE_EVENTS as never) }, "code");
  const refresh = table(s, "Graph refresh");
  assert.deepEqual(row(refresh, "interrupted").slice(1), ["1"]);
  assert.deepEqual(row(refresh, "build duration p50 / p90").slice(1), ["n/a / n/a"]);
  assert.deepEqual(
    row(table(s, "Delivered — the graph answer nobody asked for (#606)"), "latency p50 / p90").slice(1),
    ["n/a / n/a"]
  );
  const reach = row(table(s, "Latency & reach"), "find_code");
  assert.equal(reach[2], "0.3 ms");
  assert.equal(reach[4], "n/a", "find_code cannot name files for a symbol query");
  assert.ok(!JSON.stringify(s).includes('"0 ms"'), "no 0 ms anywhere in the section");
});

test("telemetry: the German view says k. A. for an unmeasured latency and uses a decimal comma", async () => {
  const m = await model("de");
  const s = section(m, { codeAwareness: summarizeCodeAwareness(CODE_EVENTS as never) }, "code");
  const text = JSON.stringify(s);
  assert.match(text, /k\. A\. \/ k\. A\./);
  assert.match(text, /"0,3 ms"/);
});

test("telemetry: a latency lane without a median shows a dash, not 0 ms", async () => {
  const m = await model();
  const s = section(m, { latency: { lanes: [{ lane: "hook_call", n: 0 }], daily: [] } }, "latency");
  assert.equal(s.key, "—");
  const lane = s.cols
    .flat()
    .find((b) => b.kind === "table")!
    .rows![0].map(cell);
  assert.deepEqual([lane[2], lane[3]], ["—", "—"]);
  assert.equal(section(m, {}, "latency").key, "—", "no latency report at all");
});

const suppression = (modes: unknown) => ({
  hintSuppression: {
    hints: 4,
    calls: 2,
    tokensAvoided: 120,
    unknownTokenCalls: 0,
    uniqueMemories: 1,
    modes,
    byType: [],
    topMemories: [],
  },
});

test("telemetry: a shadow-only window never claims a removal or a saving", async () => {
  const m = await model();
  const s = section(m, suppression([{ mode: "shadow", calls: 2 }]), "suppression");
  const text = JSON.stringify(s);
  assert.match(s.q, /would have been removed/);
  assert.deepEqual(
    s.figs!.slice(0, 2).map((f) => f.k),
    ["hints would have been removed", "hook payload"]
  );
  assert.doesNotMatch(text, /avoided|Token savings|Most often suppressed/);
  assert.match(text, /Most often matched/);
  assert.match(text, /mode: shadow×2/);
});

test("telemetry: live wording stays as before and missing modes count as live", async () => {
  const m = await model();
  for (const modes of [[{ mode: "live", calls: 3 }], [], undefined]) {
    const s = section(m, suppression(modes), "suppression");
    const text = JSON.stringify(s);
    assert.equal(s.figs![1].k, "hook payload avoided");
    assert.match(text, /Most often suppressed/);
    assert.match(text, /Token savings estimate/);
    assert.deepEqual(s.topNotes!.filter(Boolean), [], "no mode line in a live window");
  }
});

test("telemetry: a mixed window names both halves, lists every mode and claims no saving", async () => {
  const m = await model();
  const s = section(
    m,
    suppression([
      { mode: "live", calls: 5 },
      { mode: "shadow", calls: 2 },
    ]),
    "suppression"
  );
  assert.match(s.q, /removed or would have been removed/);
  assert.equal(s.figs![1].k, "hook payload");
  assert.match(JSON.stringify(s), /mode: live×5, shadow×2/);
});

test("telemetry: the overview names the gate shadow until a live call exists", async () => {
  const m = await model();
  const gate = (evidence: unknown) => m.buildModel({ evidence }).overview.at(-1).v;
  assert.equal(gate({ shadow: { calls: 9, decisions: 3 }, live: { calls: 0 } }), "shadow");
  assert.equal(gate({ shadow: { calls: 9 }, live: { calls: 1 } }), "live");
});
