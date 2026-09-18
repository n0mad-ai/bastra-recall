/**
 * Diagnostic, not a measurement arm: does the graph CONTAIN the answer?
 * For every scenario, the one-hop dependent files of the changed file,
 * straight from the scenario's graph, scored against the type-error truth.
 * No agent involved. Run on the consumed v3 sample on 2026-09-18, before any
 * tool was built on top of the graph.
 *
 * Usage: node packages/eval/code-roi/v2/graph-ceiling.mjs
 */
import { readFileSync } from "node:fs";
const D = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;
const { loadGraph, dependentFilesOf } = await import(D + "reader.js");
const OUT = process.env.HOME + "/.bastra/eval/code-roi-v2";
const { scenarios } = JSON.parse(readFileSync(OUT + "/scenarios.json", "utf8"));
let rs = [], ps = [], full = 0;
for (const s of scenarios) {
  if (s.excluded) continue;
  const r = await loadGraph(`${OUT}/runs/${s.id}/graph`);
  if (!r.ok) { console.log(s.id, "graph", r.reason); continue; }
  const deps = dependentFilesOf(r.graph, s.file);
  const t = new Set(s.truth);
  const hit = deps.filter((d) => t.has(d)).length;
  const rec = hit / s.truth.length, pre = deps.length ? hit / deps.length : 1;
  rs.push(rec); ps.push(pre); if (rec === 1) full++;
  if (rec < 1) console.log(s.id, s.file, "recall", rec.toFixed(2), "missed", s.truth.filter((x) => !deps.includes(x)).join(","));
}
const m = (a) => (a.reduce((x, y) => x + y, 0) / a.length * 100).toFixed(1);
console.log("graph one-hop: recall", m(rs), "% precision", m(ps), "% full", full, "/", rs.length);
