/**
 * Second scenario family: "what depends on this file?" (#579)
 *
 * This is the question the Write/Edit block answers, and it is a different
 * shape from a symbol lookup: an agent without a graph cannot grep for it in
 * one go. It has to find the file's exported symbols first, then search for
 * each of them — so the control arm here is a SEQUENCE, and its cost is the
 * sum of what those rounds put in front of the agent.
 *
 * Modelled conservatively in the control arm's favour: it greps for the file's
 * basename (catching import statements) rather than for every exported symbol
 * one by one, which would cost far more.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

const run = promisify(execFile);
const REPO = "/Users/n0mad/Projekte/bastra-recall";
const D = `${REPO}/packages/daemon/dist`;
const { loadGraph, dependentFilesOf, symbolsOfFile } = await import(`${D}/code-graph/reader.js`);
const { dependentsNote } = await import(`${D}/code-graph/dependents-block.js`);

const tokens = (s) => Math.ceil(s.length / 4);
async function grep(args) {
  try { return (await run("grep", args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })).stdout; }
  catch (e) { return e.stdout ?? ""; }
}

const graph = (await loadGraph(REPO)).graph;
const cache = { get: () => graph };

// Files with real dependents, spread across the repo.
const candidates = [...graph.symbolsByFile.keys()]
  .filter((f) => f.endsWith(".ts") && !f.includes("__tests__") && dependentFilesOf(graph, f).length > 0);
const step = Math.max(1, Math.floor(candidates.length / 35));
const files = candidates.filter((_, i) => i % step === 0).slice(0, 35);

const rows = [];
for (const file of files) {
  const base = file.split("/").pop().replace(/\.ts$/, "");
  // Control: grep for imports of this module.
  const out = await grep(["-rnE", `from ["'][^"']*${base}(\\.js|\\.ts)?["']`, "packages/", "--include=*.ts"]);
  const truth = new Set(dependentFilesOf(graph, file));
  const foundByGrep = new Set(
    out.split("\n").map((l) => l.split(":")[0]).filter((p) => p && p !== file),
  );

  // The cache MUST be passed: without it the call falls back to the process
  // singleton, which is cold in a fresh process, and the cold-start rule then
  // correctly returns null — measuring the rule instead of the block.
  const note = await dependentsNote({ filePath: `${REPO}/${file}`, repoRoot: REPO, session: { shown: {} }, cache, budgetMs: 5000 });
  const blockTokens = note ? tokens(note.note) : 0;

  // Recall of the control arm against the graph's answer.
  let hit = 0;
  for (const t of truth) if (foundByGrep.has(t)) hit++;

  rows.push({
    file,
    truth_dependents: truth.size,
    grep_tokens: tokens(out),
    grep_found_of_truth: hit,
    grep_recall: truth.size ? +(hit / truth.size * 100).toFixed(0) : 0,
    block_tokens: blockTokens,
  });
}

const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const med = (k) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
const cheaper = rows.filter((r) => r.block_tokens > 0 && r.block_tokens < r.grep_tokens).length;

const report = {
  generated_at: new Date().toISOString(),
  scenarios: rows.length,
  totals: { grep_tokens: sum("grep_tokens"), block_tokens: sum("block_tokens"),
    reduction: +((1 - sum("block_tokens") / sum("grep_tokens")) * 100).toFixed(1) + "%" },
  medians: { grep: med("grep_tokens"), block: med("block_tokens") },
  per_scenario_block_cheaper: cheaper,
  per_scenario_grep_cheaper: rows.length - cheaper,
  grep_recall_median_pct: med("grep_recall"),
  rows,
};
await writeFile(`${REPO}/packages/eval/code-roi/report-deps.json`, JSON.stringify(report, null, 2));
const { rows: _, ...s } = report;
console.log(JSON.stringify(s, null, 2));
