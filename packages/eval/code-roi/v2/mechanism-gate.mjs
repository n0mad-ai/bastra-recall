/**
 * The cross-package mechanism gate — offline, no agent, no money (#582, v6).
 *
 * WHY IT EXISTS. The main sample cannot answer the question #582 was built
 * for. Measured on its 40 scenarios: 53 truth files, of which TWO lie in a
 * different workspace package from the changed file. The package bridge can
 * therefore contribute at most (1 + 1/3)/40 = 3.3 percentage points of recall,
 * against a registered effect threshold of +5 — the mechanism cannot reach its
 * own gate even if it is perfect. The agent measurement stays as it is; this
 * gate asks the narrower question directly, on scenarios selected for it.
 *
 * WHAT IT MEASURES. For every scenario whose changed file lives inside a
 * workspace package and whose truth crosses a package boundary: the share of
 * those CROSS-PACKAGE truth files that `find_affected_files` names at depth 1.
 * Nothing else — not precision, not the intra-package half, not an agent's
 * behaviour. One number, one mechanism.
 *
 * WHAT IT IS NOT. It is not evidence that the tool helps anybody: no agent is
 * involved. It is the floor under the effect measurement — if the bridge does
 * not find these files offline, no description will make an agent find them.
 *
 * Usage: CODE_ROI_OUT=<gate archive> node mechanism-gate.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writableOut } from "./archive.mjs";
import { diffForTree } from "./diff-side.mjs";

const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;
const { loadGraph } = await import(`${DIST}reader.js`);
const { affectedHits, affectedResult, changedSymbolsOf, narrowPackageHits } = await import(
  `${DIST}affected.js`
);

const OUT = writableOut();
const REG = JSON.parse(
  readFileSync(new URL("../../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
);
const GATE = REG.mechanism_gate;

/** The workspace package a repo-relative path belongs to, by its top two segments. */
function packageOf(file) {
  return file.split("/").slice(0, 2).join("/");
}

/** Exactly the chain `find_affected_files` runs, minus the cache and the diff. */
async function affectedFor(graph, root, file, diff) {
  // The scenario's tree is the PARENT commit and its diff runs parent ->
  // commit, so the tree is the diff's old side while `changedLines` reads the
  // new one (`diff-side.mjs`).
  const symbols = changedSymbolsOf(graph, file, diffForTree(diff, "old"));
  const names = symbols.filter((s) => s.kind !== "file").map((s) => s.name);
  const hits = await narrowPackageHits(root, affectedHits(graph, file, symbols, 1), names);
  return affectedResult(symbols, hits).files;
}

export function gateRows(scenarios) {
  return scenarios
    .filter((s) => !s.excluded)
    .map((s) => ({
      ...s,
      crossTruth: s.truth.filter((t) => packageOf(t) !== packageOf(s.file)),
    }))
    .filter((s) => s.crossTruth.length > 0);
}

export function gateScore(rows) {
  const found = rows.reduce((a, r) => a + r.crossTruth.filter((t) => r.named.includes(t)).length, 0);
  const total = rows.reduce((a, r) => a + r.crossTruth.length, 0);
  return { found, total, share: total === 0 ? null : found / total, scenarios: rows.length };
}

async function main() {
  const { scenarios } = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
  const rows = gateRows(scenarios);
  for (const row of rows) {
    const graphRoot = join(OUT, "runs", row.id, "graph");
    if (!existsSync(join(graphRoot, "graphify-out", "graph.json"))) {
      throw new Error(`${row.id}: no graph — build the scenario trees first`);
    }
    const loaded = await loadGraph(graphRoot);
    if (!loaded.ok) throw new Error(`${row.id}: graph ${loaded.reason}`);
    row.named = await affectedFor(loaded.graph, graphRoot, row.file, row.diff);
  }

  const score = gateScore(rows);
  const min = GATE?.min_cross_package_truth_files;
  const threshold = GATE?.min_share_found;
  const numeric = typeof threshold === "number";
  const report = {
    registration_version: REG.registration_version,
    gate: "cross_package_mechanism",
    ...score,
    required: numeric ? `>= ${threshold}` : String(threshold),
    status:
      typeof min === "number" && score.total < min
        ? "not_evaluable"
        : !numeric
          ? "no_threshold_registered"
          : score.share >= threshold
            ? "pass"
            : "fail",
    rows: rows.map((r) => ({
      id: r.id,
      file: r.file,
      crossTruth: r.crossTruth,
      found: r.crossTruth.filter((t) => r.named.includes(t)),
    })),
    $comment: "Offline, no agent. Not evidence that the tool helps anybody — the floor under the effect measurement.",
  };
  writeFileSync(join(OUT, "mechanism-gate.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ ...report, rows: undefined }, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
