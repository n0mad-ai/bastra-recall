/**
 * Diagnostic, not a measurement arm: what does the SYMBOL-level query find
 * that the file-level one missed (#582)?
 *
 * Same shape as `graph-ceiling.mjs` and the same truth (the new type errors
 * each historical change really produced), no agent involved. Per scenario:
 *
 *   file          `dependentFilesOf(graph, file)` — the old file-level query,
 *                 reproduced as the baseline it has to beat.
 *   symbols d1    the symbols the diff touches, one hop, package boundary
 *                 resolved (`affected.ts` + `external-refs.ts`).
 *   symbols d2    the same, two hops.
 *   ∪ grep arm    each of those united with what the no-graph agent named in
 *                 the v3 run (`report.json`, `rows[].control.named`).
 *   grep arm      that agent alone, for the same rows.
 *
 * THESE 44 SCENARIOS ARE DEVELOPMENT DATA NOW. The threshold measurement
 * consumed them, and the query above was built while looking at exactly these
 * gaps. Numbers from this script say the mechanism works on the cases it was
 * built against — they are not evidence that it helps in general. That needs
 * fresh scenarios (`mine.mjs`) and a registration.
 *
 * The scenario graph and the scenario tree live in different directories (the
 * runner moves the graph OUT of the tree so no agent can read it as a file),
 * but the reader resolves workspace packages from the repository root it is
 * given. So each scenario is presented through a scratch root of symlinks that
 * puts both back together, read-only, without touching the frozen archive.
 *
 * Usage: node packages/eval/code-roi/v2/affected-ceiling.mjs
 */
import { mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { diffForTree } from "./diff-side.mjs";

const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;
const { loadGraph, dependentFilesOf } = await import(DIST + "reader.js");
const { affectedHits, affectedResult, changedSymbolsOf, narrowPackageHits } = await import(
  DIST + "affected.js"
);

/** Exactly the chain `find_affected_files` runs, minus the cache and the diff. */
async function affectedVia(graph, root, file, symbols, depth) {
  const names = symbols.filter((s) => s.kind !== "file").map((s) => s.name);
  const hits = await narrowPackageHits(root, affectedHits(graph, file, symbols, depth), names);
  return affectedResult(symbols, hits);
}

const OUT = process.env.CODE_ROI_OUT ?? join(homedir(), ".bastra", "eval", "code-roi-v2");
const { scenarios } = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
const report = JSON.parse(readFileSync(join(OUT, "report.json"), "utf8"));
const grepArm = new Map(report.rows.map((r) => [r.id, r.control.named ?? []]));

/** A root that carries both the scenario's tree and its graph, via symlinks. */
function scenarioRoot(id) {
  const tree = join(OUT, "runs", id, "tree");
  const root = mkdtempSync(join(tmpdir(), `code-roi-${id}-`));
  for (const entry of readdirSync(tree)) symlinkSync(join(tree, entry), join(root, entry));
  symlinkSync(join(OUT, "runs", id, "graph", "graphify-out"), join(root, "graphify-out"));
  return root;
}

const rows = [];
for (const s of scenarios) {
  if (s.excluded) continue;
  const root = scenarioRoot(s.id);
  const r = await loadGraph(root);
  if (!r.ok) {
    console.log(s.id, "graph", r.reason);
    continue;
  }
  // The tree is the PARENT commit and the diff runs parent -> commit, so the
  // tree is the diff's old side; `changedLines` reads the new one (`diff-side.mjs`).
  const changed = changedSymbolsOf(r.graph, s.file, diffForTree(s.diff, "old"));
  const d1 = await affectedVia(r.graph, root, s.file, changed, 1);
  const d2 = await affectedVia(r.graph, root, s.file, changed, 2);
  rows.push({
    id: s.id,
    file: s.file,
    truth: s.truth,
    symbols: changed.map((c) => c.name),
    arms: {
      file: dependentFilesOf(r.graph, s.file),
      "symbols d1": d1.files,
      "symbols d2": d2.files,
      "symbols d1 ∪ grep arm": [...new Set([...d1.files, ...(grepArm.get(s.id) ?? [])])],
      "symbols d2 ∪ grep arm": [...new Set([...d2.files, ...(grepArm.get(s.id) ?? [])])],
      "grep arm alone": grepArm.get(s.id) ?? [],
    },
  });
}

const pct = (xs) => ((xs.reduce((a, b) => a + b, 0) / xs.length) * 100).toFixed(1);
console.log(`${"arm".padEnd(22)} recall  precision  complete`);
for (const arm of Object.keys(rows[0].arms)) {
  const rec = [];
  const pre = [];
  let complete = 0;
  for (const row of rows) {
    const got = row.arms[arm];
    const hit = row.truth.filter((t) => got.includes(t)).length;
    rec.push(hit / row.truth.length);
    pre.push(got.length === 0 ? 1 : hit / got.length);
    if (hit === row.truth.length) complete++;
  }
  console.log(
    `${arm.padEnd(22)} ${pct(rec).padStart(5)} %  ${pct(pre).padStart(7)} %  ${complete}/${rows.length}`,
  );
}

console.log("\nremaining gaps (symbols d1):");
for (const row of rows) {
  const missed = row.truth.filter((t) => !row.arms["symbols d1"].includes(t));
  if (missed.length === 0) continue;
  const alsoFile = missed.filter((m) => row.arms.file.includes(m));
  console.log(
    `  ${row.id} ${row.file}\n` +
      `    symbols: ${row.symbols.join(", ") || "(none)"}\n` +
      `    missed:  ${missed.join(", ")}` +
      (alsoFile.length > 0 ? `\n    (the file-level query DID find: ${alsoFile.join(", ")})` : ""),
  );
}
