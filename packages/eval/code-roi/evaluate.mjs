/**
 * Evaluate the two arms (#579).
 *
 * Correctness is checked OBJECTIVELY against ground truth that lives OUTSIDE
 * the repository — an earlier run had an arm stumble over the answers while
 * working, which is why they are no longer checked in.
 *
 * Rounds and output size are self-reported by the agents and labelled as such.
 * The pairing is what makes the comparison meaningful: only scenarios BOTH
 * arms answered correctly are counted, and per-scenario differences are
 * reported next to the totals, because a total can hide that one arm wins
 * rarely and hugely while the other wins often and slightly.
 */
import { readFile } from "node:fs/promises";
const S = process.argv[2] ?? ".";
const truth = new Map(
  JSON.parse(await readFile(`${S}/truth.json`, "utf8")).map((s) => [s.symbol, s.truth]),
);

async function load(n) {
  try { return JSON.parse(await readFile(`${S}/${n}.json`, "utf8")); } catch { return null; }
}
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

function judge(rows) {
  return (rows ?? []).map((r) => {
    const t = truth.get(r.symbol);
    const ok = t !== undefined && r.answer_file === t.file &&
      (typeof r.answer_line !== "number" || Math.abs(r.answer_line - t.line) <= 2);
    return { ...r, correct: ok };
  });
}

const c = judge(await load("clean-control"));
const g = judge(await load("clean-graph"));
if (c.length === 0 || g.length === 0) { console.log("Protokolle fehlen noch."); process.exit(0); }

const gm = new Map(g.map((r) => [r.symbol, r]));
const pairs = c.filter((r) => r.correct && gm.get(r.symbol)?.correct)
  .map((r) => ({ symbol: r.symbol, ctrl: r, graph: gm.get(r.symbol) }));

const sum = (a, k) => a.reduce((n, r) => n + (r[k] ?? 0), 0);
const cChars = pairs.map((p) => p.ctrl.output_chars ?? 0);
const gChars = pairs.map((p) => p.graph.output_chars ?? 0);
const graphCheaper = pairs.filter((p) => (p.graph.output_chars ?? 0) < (p.ctrl.output_chars ?? 0));

console.log(JSON.stringify({
  scenarios: { control: c.length, graph: g.length, both_correct: pairs.length },
  accuracy: {
    control: `${c.filter((r) => r.correct).length}/${c.length}`,
    graph: `${g.filter((r) => r.correct).length}/${g.length}`,
  },
  rounds: { control: sum(pairs.map((p) => p.ctrl), "rounds"), graph: sum(pairs.map((p) => p.graph), "rounds") },
  chars: {
    control_total: sum(pairs.map((p) => p.ctrl), "output_chars"),
    graph_total: sum(pairs.map((p) => p.graph), "output_chars"),
    control_median: median(cChars), graph_median: median(gChars),
  },
  per_scenario: {
    graph_cheaper: graphCheaper.length,
    control_cheaper: pairs.length - graphCheaper.length,
    worst_control: Math.max(...cChars, 0),
    worst_graph: Math.max(...gChars, 0),
  },
  graph_fell_back: g.filter((r) => r.fell_back_to_grep).length,
  wrong: { control: c.filter((r) => !r.correct).map((r) => r.symbol), graph: g.filter((r) => !r.correct).map((r) => r.symbol) },
}, null, 2));
