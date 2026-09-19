/**
 * Score the synthetic mutation gate (#582, registration 6).
 *
 * Offline, no agent, no money. For every kept mutation, `find_affected_files`
 * is asked what breaks, and the answer is checked against the CROSS-PACKAGE
 * truth files the mutation really produced. Nothing else is scored: not
 * precision, not the intra-package half, not an agent's willingness to call
 * anything.
 *
 * TWO WAYS, SCORED SEPARATELY (#582 review). The first version handed the tool
 * the symbol name through `symbolsNamed`, which is a path no user takes: it
 * skips `diffSymbols` and with it `symbol-spans.ts`, so what it measured was
 * the graph query alone and not the product. A user changes a file; the
 * product works out from the DIFF which symbols that touched and asks about
 * those. Both are reported:
 *
 *   explicit   file + symbol name, straight into the graph query. The ceiling
 *              the query can reach when the symbol list is perfect.
 *   product    file + diff only, through `changedSymbolsOf` — what a user gets.
 *
 * A gap between them is a finding about the diff-to-symbol step, which is why
 * they are never merged into one number.
 *
 * The graph is built on the gate's own extracted tree, which is where the
 * mutations were measured, so the graph and the truth describe the same code.
 * The tree is left CLEAN: the generator reverted every mutation, and the diff
 * is re-derived here from the operator rather than applied, so the tool is
 * asked about the symbol as it stands — the "before you change it" case.
 *
 * Usage: CODE_ROI_OUT=<gate archive> node mutation-gate-score.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writableOut } from "./archive.mjs";
import { diffForTree } from "./diff-side.mjs";
import { OPERATORS, mutationDiff } from "./mutation-gate.mjs";

const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;
const { loadGraph } = await import(`${DIST}reader.js`);
const { affectedHits, affectedResult, changedSymbolsOf, narrowPackageHits, symbolsNamed } =
  await import(`${DIST}affected.js`);
const { buildCodeGraph } = await import(`${DIST}build.js`);

const OUT = writableOut();
const REG = JSON.parse(
  readFileSync(new URL("../../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
);
const GATE = REG.mechanism_gate?.mutation ?? {};
const TREE = join(OUT, "mut-tree");

const packageOf = (f) => f.split("/").slice(0, 2).join("/");

/** The files `find_affected_files` names at depth 1 for this symbol list. */
async function namedFor(graph, file, symbols) {
  if (symbols.length === 0) return [];
  const hits = await narrowPackageHits(
    TREE,
    affectedHits(graph, file, symbols, 1),
    symbols.filter((s) => s.kind !== "file").map((s) => s.name),
  );
  return affectedResult(symbols, hits).files;
}

/**
 * The diff this mutation produced.
 *
 * Preferred from the record, which is what the generator measured. Rows written
 * before the diff was stored are re-derived from the operator on the clean
 * tree — the operators are pure string edits, so the result is identical.
 */
function diffOf(m) {
  if (typeof m.diff === "string" && m.diff.length > 0) return m.diff;
  const original = readFileSync(join(TREE, m.file), "utf8");
  const op = OPERATORS.find((o) => o.name === m.operator);
  const mutated = op?.apply(original, m.symbol) ?? null;
  if (mutated === null) {
    throw new Error(
      `${m.file}:${m.symbol}:${m.operator}: the operator no longer applies to the tree, so its ` +
        `diff cannot be re-derived. Re-run mutation-gate.mjs against the pinned commit.`,
    );
  }
  return mutationDiff(m.file, original, mutated);
}

/** found / total over a set of rows, with the status the thresholds give it. */
function score(rows, key, threshold, minFiles) {
  const found = rows.reduce((a, r) => a + r[key].found.length, 0);
  const total = rows.reduce((a, r) => a + r.crossTruth.length, 0);
  const share = total === 0 ? null : found / total;
  const status =
    total === 0
      ? "not_evaluable"
      : typeof minFiles === "number" && total < minFiles
        ? "not_evaluable"
        : typeof threshold !== "number"
          ? "no_threshold_registered"
          : share >= threshold
            ? "pass"
            : "fail";
  return { found, total, share, required: typeof threshold === "number" ? `>= ${threshold}` : String(threshold), status };
}

/** Per operator, for one of the two ways. */
function byOperator(rows, key) {
  const out = {};
  for (const r of rows) {
    out[r.operator] ??= { found: 0, total: 0 };
    out[r.operator].found += r[key].found.length;
    out[r.operator].total += r.crossTruth.length;
  }
  for (const v of Object.values(out)) v.share = v.total === 0 ? null : v.found / v.total;
  return out;
}

function bySourcePackage(rows, key) {
  const out = {};
  for (const r of rows) {
    const k = packageOf(r.file);
    out[k] ??= { found: 0, total: 0 };
    out[k].found += r[key].found.length;
    out[k].total += r.crossTruth.length;
  }
  return out;
}

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
    const explicitFiles = await namedFor(graph, m.file, named.found);
    // The stored diff runs CLEAN -> MUTATED, and the tree was left clean, so
    // the tree is the diff's old side while `changedLines` reads the new one.
    // Turned around, the clean tree becomes the new side — which is also the
    // case this gate means to ask about: the symbol as it stands, before the
    // change (`diff-side.mjs`).
    const diff = diffForTree(diffOf(m), "old");
    const fromDiff = changedSymbolsOf(graph, m.file, diff);
    const productFiles = await namedFor(graph, m.file, fromDiff);
    const split = (files) => ({
      found: m.crossTruth.filter((t) => files.includes(t)),
      missed: m.crossTruth.filter((t) => !files.includes(t)),
      named: files.length,
    });
    rows.push({
      file: m.file,
      symbol: m.symbol,
      operator: m.operator,
      symbolInGraph: named.found.length > 0,
      diffSymbols: fromDiff.map((s) => s.name),
      crossTruth: m.crossTruth,
      explicit: split(explicitFiles),
      product: split(productFiles),
    });
  }

  // The threshold is SPLIT (Daniel Nevoigt, 2026-09-19): the operators whose
  // breakage is a visible name or call break must be found completely; the
  // type-flow operator is reported and never gated, because the graph is not
  // built to model type flow and gating it would gate a limitation that is
  // registered as known.
  const gatedOps = GATE.min_share_found?.gated_operators ?? [];
  const gatedThreshold = GATE.min_share_found?.gated_min_share;
  const minFiles = REG.mechanism_gate?.min_cross_package_truth_files;
  const gatedRows = rows.filter((r) => gatedOps.includes(r.operator));

  // ONLY THE PRODUCT WAY DECIDES (#582 review). Both ways were reported with a
  // `gated` block carrying a pass/fail status, so the report showed two
  // verdicts where the registration knows one. `explicit` hands the tool a
  // symbol list no user can produce; it is a diagnostic ceiling for the graph
  // query, and reading a pass off it would pass the gate on a path nobody
  // takes. Its numbers stay — the gap between the two IS the finding — but they
  // are labelled for what they are.
  const part = (key, decides) => ({
    overall: { ...score(rows, key, undefined, undefined), $comment: "reported, never a pass criterion on its own" },
    gated: decides
      ? score(gatedRows, key, gatedThreshold, minFiles)
      : {
          ...score(gatedRows, key, gatedThreshold, minFiles),
          status: "diagnostic_only",
          $comment:
            "NOT a gate. The share and the registered threshold are shown so the gap to " +
            "`product.gated` can be read, but this way hands the tool a perfect symbol list " +
            "and no user takes it. The gate is decided on `product` alone.",
        },
    byOperator: byOperator(rows, key),
    bySourcePackage: bySourcePackage(rows, key),
    misses: rows
      .filter((r) => r[key].missed.length > 0)
      .map((r) => ({
        file: r.file,
        symbol: r.symbol,
        operator: r.operator,
        missed: r[key].missed,
        symbolInGraph: r.symbolInGraph,
      })),
  });

  const report = {
    registration_version: REG.registration_version,
    gate: "cross_package_mechanism / mutation",
    mutations: rows.length,
    gated_operators: gatedOps,
    reported_only_operators: GATE.min_share_found?.reported_only_operators ?? [],
    decided_by: "product.gated",
    explicit: part("explicit", false),
    product: part("product", true),
    $comment:
      "Two ways, never merged: `explicit` hands the tool the symbol name (the query's ceiling), " +
      "`product` gives it only the file and the diff (what a user gets). The gate is decided on " +
      "`product.gated`; `explicit.gated` is `diagnostic_only`. Offline, no agent. " +
      "Synthetic breakage: a fair test of the mechanism, no evidence about what people change.",
    rows,
  };
  writeFileSync(join(OUT, "mutation-gate.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ ...report, rows: undefined }, null, 2) + "\n");
}

await main();
