/**
 * Score the synthetic mutation gate (#582, registration 6).
 *
 * Offline, no agent, no money. For every kept mutation, `find_affected_files`
 * is asked the question a user would ask — this FILE, this SYMBOL, depth 1 —
 * and the answer is checked against the CROSS-PACKAGE truth files the mutation
 * really produced. Nothing else is scored: not precision, not the
 * intra-package half, not an agent's willingness to call anything.
 *
 * The graph is built on the gate's own extracted tree, which is where the
 * mutations were measured, so the graph and the truth describe the same code.
 * The tree is left CLEAN — every mutation was reverted when it was generated,
 * and none is re-applied here: the tool is asked about a symbol as it stands,
 * which is exactly the "before you change it" case.
 *
 * Usage: CODE_ROI_OUT=<gate archive> node mutation-gate-score.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writableOut } from "./archive.mjs";

const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;
const { loadGraph } = await import(`${DIST}reader.js`);
const { affectedHits, affectedResult, narrowPackageHits, symbolsNamed } = await import(`${DIST}affected.js`);
const { buildCodeGraph } = await import(`${DIST}build.js`);

const OUT = writableOut();
const REG = JSON.parse(
  readFileSync(new URL("../../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
);
const GATE = REG.mechanism_gate?.mutation ?? {};
const TREE = join(OUT, "mut-tree");

const packageOf = (f) => f.split("/").slice(0, 2).join("/");

async function main() {
  if (!existsSync(join(TREE, "graphify-out", "graph.json"))) {
    process.stdout.write("building the graph for the gate tree…\n");
    const built = await buildCodeGraph({ repoRoot: TREE, lowPriority: false });
    if (!built.ok) throw new Error(`graph build failed: ${built.reason} ${built.detail ?? ""}`);
  }
  const loaded = await loadGraph(TREE);
  if (!loaded.ok) throw new Error(`graph ${loaded.reason}`);
  const graph = loaded.graph;

  const kept = readFileSync(join(OUT, "mutations.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kept);

  const rows = [];
  for (const m of kept) {
    const named = symbolsNamed(graph, m.file, [m.symbol]);
    let files = [];
    if (named.found.length > 0) {
      const hits = await narrowPackageHits(
        TREE,
        affectedHits(graph, m.file, named.found, 1),
        named.found.filter((s) => s.kind !== "file").map((s) => s.name),
      );
      files = affectedResult(named.found, hits).files;
    }
    const found = m.crossTruth.filter((t) => files.includes(t));
    const missed = m.crossTruth.filter((t) => !files.includes(t));
    rows.push({
      file: m.file,
      symbol: m.symbol,
      operator: m.operator,
      symbolInGraph: named.found.length > 0,
      crossTruth: m.crossTruth,
      found,
      missed,
      named: files.length,
    });
  }

  const total = rows.reduce((a, r) => a + r.crossTruth.length, 0);
  const found = rows.reduce((a, r) => a + r.found.length, 0);
  const by = (key) => {
    const out = {};
    for (const r of rows) {
      const k = key(r);
      out[k] ??= { found: 0, total: 0 };
      out[k].found += r.found.length;
      out[k].total += r.crossTruth.length;
    }
    return out;
  };

  const threshold = GATE.min_share_found;
  const report = {
    registration_version: REG.registration_version,
    gate: "cross_package_mechanism / mutation",
    mutations: rows.length,
    crossPackageTruthFiles: total,
    found,
    share: total === 0 ? null : found / total,
    required: typeof threshold === "number" ? `>= ${threshold}` : String(threshold),
    status:
      total === 0
        ? "not_evaluable"
        : typeof threshold !== "number"
          ? "no_threshold_registered"
          : found / total >= threshold
            ? "pass"
            : "fail",
    byOperator: by((r) => r.operator),
    bySourcePackage: by((r) => packageOf(r.file)),
    misses: rows
      .filter((r) => r.missed.length > 0)
      .map((r) => ({ file: r.file, symbol: r.symbol, operator: r.operator, missed: r.missed, symbolInGraph: r.symbolInGraph })),
    rows,
    $comment:
      "Offline, no agent. Synthetic breakage: a fair test of the mechanism, no evidence about what people change in practice.",
  };
  writeFileSync(join(OUT, "mutation-gate.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ ...report, rows: undefined }, null, 2) + "\n");
}

await main();
