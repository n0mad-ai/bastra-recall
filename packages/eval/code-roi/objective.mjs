/**
 * Objective counterpart to the agent runs (#579).
 *
 * The agent arms report their own rounds and output sizes, which is the weak
 * link. This measures the same 40 scenarios WITHOUT an agent: what does one
 * `find_code` call put in front of a reader, and what does the grep a
 * competent agent would write put in front of it?
 *
 * It cannot see how many ROUNDS a real agent needs — that is exactly what the
 * agent runs are for. Read the two together: this one is trustworthy about
 * size, the agent runs are the only evidence about rounds.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
const run = promisify(execFile);
const REPO = "/Users/n0mad/Projekte/bastra-recall";
const { loadGraph } = await import(`${REPO}/packages/daemon/dist/code-graph/reader.js`);
const { findCode } = await import(`${REPO}/packages/daemon/dist/code-graph/find-code.js`);

const scen = JSON.parse(await readFile(`${REPO}/packages/eval/code-roi/scenarios.json`, "utf8"));
const graph = (await loadGraph(REPO)).graph;
const cache = { get: () => graph };
const chars = (s) => s.length;

async function grep(args) {
  try { return (await run("grep", args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })).stdout; }
  catch (e) { return e.stdout ?? ""; }
}

const rows = [];
for (const s of scen) {
  const targeted = await grep(["-rnE", `(export )?(async )?function ${s.symbol}\\b`, "packages/", "--include=*.ts"]);
  const broad = await grep(["-rn", s.symbol, "packages/", "--include=*.ts"]);
  const res = findCode(cache, { query: s.symbol, repo: REPO });
  const hit = res.status === "ok" && res.hits.some((h) => h.file === s.truth.file);
  rows.push({
    symbol: s.symbol,
    grep_targeted_chars: chars(targeted),
    grep_targeted_hit: targeted.includes(s.truth.file),
    grep_broad_chars: chars(broad),
    find_code_chars: chars(JSON.stringify(res)),
    find_code_hit: hit,
  });
}
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const med = (k) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log(JSON.stringify({
  scenarios: rows.length,
  grep_targeted_hits: rows.filter((r) => r.grep_targeted_hit).length,
  find_code_hits: rows.filter((r) => r.find_code_hit).length,
  totals: { grep_targeted: sum("grep_targeted_chars"), grep_broad: sum("grep_broad_chars"), find_code: sum("find_code_chars") },
  medians: { grep_targeted: med("grep_targeted_chars"), grep_broad: med("grep_broad_chars"), find_code: med("find_code_chars") },
  find_code_cheaper_than_targeted: rows.filter((r) => r.find_code_chars < r.grep_targeted_chars).length,
  find_code_cheaper_than_broad: rows.filter((r) => r.find_code_chars < r.grep_broad_chars).length,
}, null, 2));
