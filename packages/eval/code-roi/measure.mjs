/**
 * The no-graph control arm for code awareness (#579).
 *
 * Measures the PRIMARY METRIC from the pre-registration: search tokens spent
 * before the correct location is in hand. Two arms over the same scenarios:
 *
 *   control  — what an agent without a code graph reads: `grep` output.
 *   graph    — what `find_code` returns.
 *
 * FAIRNESS IS THE WHOLE POINT. A control arm built to lose proves nothing, so
 * each scenario runs TWO greps: the naive one a first attempt usually is, and
 * a targeted one a competent agent would write. The targeted grep is the one
 * that counts; the naive one is reported alongside to show the spread.
 *
 * A scenario only counts when the arm actually FOUND the right place. An arm
 * that is cheap because it answered nothing is not cheap, it is wrong.
 *
 * Tokens are characters / 4 — the same estimator the daemon already uses for
 * `hint_tokens_est`. It is an approximation, and it is applied identically to
 * both arms, so the RATIO is meaningful even where the absolute number is not.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

const run = promisify(execFile);
const REPO = "/Users/n0mad/Projekte/bastra-recall";
const D = `${REPO}/packages/daemon/dist`;
const { loadGraph, findSymbol, dependentFilesOf, symbolsOfFile } = await import(`${D}/code-graph/reader.js`);
const { findCode } = await import(`${D}/code-graph/find-code.js`);

const tokens = (s) => Math.ceil(s.length / 4);

async function grep(args) {
  try {
    const { stdout } = await run("grep", args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    return e.stdout ?? ""; // grep exits 1 on no match
  }
}

const graph = (await loadGraph(REPO)).graph;
if (!graph) { console.error("no graph"); process.exit(1); }

/** Scenarios: real symbols from this repo, with their real location. */
function buildScenarios(n) {
  const out = [];
  const seen = new Set();
  for (const [, node] of graph.nodes) {
    if (node.kind !== undefined) { /* SafeNode has no kind; use label shape */ }
    const label = node.label;
    if (!label.endsWith("()")) continue;            // functions only
    const name = label.slice(0, -2);
    if (name.length < 6 || seen.has(name)) continue; // skip trivially short names
    if (findSymbol(graph, name).length !== 1) continue; // unambiguous only
    if (!node.file.startsWith("packages/")) continue;
    seen.add(name);
    out.push({ symbol: name, expectFile: node.file, expectLine: node.line });
    if (out.length >= n) break;
  }
  return out;
}

const scenarios = buildScenarios(40);
const rows = [];

for (const s of scenarios) {
  // ---- control arm: what a grep puts in front of the agent
  const naive = await grep(["-rn", s.symbol, "packages/", "--include=*.ts"]);
  const targeted = await grep([
    "-rnE", `(export (async )?function|export const|function) ${s.symbol}\\b`,
    "packages/", "--include=*.ts",
  ]);
  const controlFound = targeted.includes(s.expectFile) || naive.includes(s.expectFile);
  const controlOut = targeted.trim().length > 0 ? targeted : naive;

  // ---- graph arm
  const res = findCode({ get: () => graph }, { query: s.symbol, repo: REPO });
  const graphOut = JSON.stringify(res);
  const graphFound = res.status === "ok" && res.hits.some((h) => h.file === s.expectFile);

  rows.push({
    symbol: s.symbol,
    control_naive_tokens: tokens(naive),
    control_targeted_tokens: tokens(targeted),
    control_tokens: tokens(controlOut),
    control_found: controlFound,
    graph_tokens: tokens(graphOut),
    graph_found: graphFound,
  });
}

const both = rows.filter((r) => r.control_found && r.graph_found);
const sum = (k) => both.reduce((a, r) => a + r[k], 0);
const med = (k) => { const v = both.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

const report = {
  generated_at: new Date().toISOString(),
  repo: REPO,
  scenarios_total: rows.length,
  both_arms_found: both.length,
  control_only_found: rows.filter((r) => r.control_found && !r.graph_found).length,
  graph_only_found: rows.filter((r) => !r.control_found && r.graph_found).length,
  neither_found: rows.filter((r) => !r.control_found && !r.graph_found).length,
  totals: {
    control_targeted_tokens: sum("control_tokens"),
    graph_tokens: sum("graph_tokens"),
    reduction_vs_targeted:
      +((1 - sum("graph_tokens") / sum("control_tokens")) * 100).toFixed(1) + "%",
    control_naive_tokens: sum("control_naive_tokens"),
    reduction_vs_naive:
      +((1 - sum("graph_tokens") / sum("control_naive_tokens")) * 100).toFixed(1) + "%",
  },
  medians: {
    control_targeted: med("control_tokens"),
    control_naive: med("control_naive_tokens"),
    graph: med("graph_tokens"),
  },
  per_scenario_graph_cheaper: both.filter((r) => r.graph_tokens < r.control_tokens).length,
  per_scenario_control_cheaper: both.filter((r) => r.control_tokens < r.graph_tokens).length,
  rows,
};

await writeFile(`${REPO}/packages/eval/code-roi/report.json`, JSON.stringify(report, null, 2));
const { rows: _, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
