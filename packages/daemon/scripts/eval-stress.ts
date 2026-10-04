#!/usr/bin/env tsx
/**
 * M0.5 — recall stress-test harness (Issues #2 + #8).
 *
 * Builds on top of the M0 baseline in scripts/eval.ts. The M0 eval used each
 * memory's own recall_when phrase as the query — a trivially easy case. This
 * harness exercises three realistic failure modes:
 *
 *   1. paraphrased — query reformulated so it shares ZERO literal tokens
 *      with the original recall_when. Pass: Recall@3 >= 0.7.
 *   2. cross-memory — single query that should surface 2-4 distinct memories
 *      all in top-k. Optional: a `oneHop` slice for `related_via` neighbors
 *      that should only show up when `expand_hops: 1` is set.
 *   3. anti-hallucination — query for a topic that is NOT in the vault. The
 *      top-1 score must stay in the noise band (configurable cutoff).
 *
 * Usage:
 *   BASTRA_VAULT_PATH=/path/to/vault npx tsx scripts/eval-stress.ts \
 *     --slice all              # default: paraphrased,cross,anti
 *     --slice paraphrased      # single slice
 *     --out report.json        # also write a JSON report (no markdown)
 *     --cutoff 80              # noise cutoff for anti slice (default 80)
 *     --hybrid                 # use SearchIndex.recallHybrid (needs embeddings)
 *
 * When `--slice all` runs, the harness additionally writes a markdown
 * report to scripts/stress-report.md with a comparison to M0.
 *
 * Exit code: 0 on pass, 1 on fail. "Pass" = all three configured slices
 * pass their respective thresholds.
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { attachHybrid, makeControlRecaller, makeRecaller, type HybridArm } from "./stress-arm.js";
import {
  runParaphrased,
  runCrossMemory,
  runAntiHallucination,
  shuffleParaphrasedLabels,
  shuffleCrossLabels,
  EVAL_POOL_K,
  NEAR_RANK,
  type ParaphrasedSummary,
  type CrossSummary,
  type AntiSummary,
} from "./stress-slices.js";
import { computeHashes, writeRunArtifact, type RunManifest } from "./stress-artifact.js";
import { PARAPHRASED_CASES } from "./stress-fixtures/paraphrased.js";
import { CROSS_MEMORY_CASES } from "./stress-fixtures/cross-memory.js";
import { ANTI_HALLUCINATION_CASES } from "./stress-fixtures/anti-hallucination.js";

// ── CLI parsing ────────────────────────────────────────────────

interface Args {
  slices: Slice[];
  out: string | null;
  cutoff: number;
  hybrid: boolean;
  /** Drives the control arm and the label-shuffle null (#261). */
  seed: number;
}

type Slice = "paraphrased" | "cross" | "anti";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    slices: ["paraphrased", "cross", "anti"],
    out: null,
    cutoff: 80,
    hybrid: false,
    // Fixed by default: a baseline that moves between runs cannot qualify the
    // number it sits next to. Override only to check the null is stable.
    seed: 20260726,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slice") {
      const v = argv[++i];
      if (!v) throw new Error("--slice needs a value");
      if (v === "all") {
        args.slices = ["paraphrased", "cross", "anti"];
      } else {
        const parts = v.split(",") as Slice[];
        for (const p of parts) {
          if (!["paraphrased", "cross", "anti"].includes(p)) {
            throw new Error(`unknown slice: ${p}`);
          }
        }
        args.slices = parts;
      }
    } else if (a === "--out") {
      args.out = argv[++i] ?? null;
    } else if (a === "--cutoff") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) throw new Error("--cutoff must be a number");
      args.cutoff = n;
    } else if (a === "--seed") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n)) throw new Error("--seed must be an integer");
      args.seed = n;
    } else if (a === "--hybrid") {
      args.hybrid = true;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    `eval-stress — recall stress-test harness (Issues #2 + #8)

Flags:
  --slice paraphrased|cross|anti|all   default: all
  --out report.json                    write JSON report
  --cutoff 80                          anti-slice noise cutoff (default 80)
  --hybrid                             use SearchIndex.recallHybrid (BM25+vector)
  --seed 20260726                      seed for the control arm + shuffle null
  -h, --help                           this message

Env:
  BASTRA_VAULT_PATH (required)         path to the markdown vault
`,
  );
}

/**
 * Refuses a path that lands inside a git working tree (#261).
 *
 * `--out` writes the per-case rows — every paraphrase query and every gold id —
 * and resolves against the cwd, which is normally this checkout. That is the
 * same leak `stress-report.md` was: vault-derived text one `git add .` away
 * from a public repo. §18.1 and C-025 allow only aggregated reports without
 * vault-derived query text there.
 *
 * A hard refusal rather than a warning, and it costs nothing: the run artifact
 * under ~/.bastra/eval-runs/ already holds the identical `results.json`.
 */
function assertOutsideGitTree(target: string): void {
  let dir = dirname(resolve(target));
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      throw new Error(
        `--out ${target} points inside a git working tree (${dir}).\n` +
          `The JSON carries every paraphrase query and gold id; only aggregated reports without ` +
          `vault-derived query text belong in a repository (§18.1, C-025).\n` +
          `The same data is already in the run artifact under ~/.bastra/eval-runs/<date>-<hash>/results.json — ` +
          `pass a path outside the checkout if you need a second copy.`,
      );
    }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

// ── Output helpers ─────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function printParaphrased(s: ParaphrasedSummary): void {
  console.log("\n## Slice 1 — Paraphrased\n");
  console.log(
    `Cases: **${s.total}** across ${s.perMemory.size} memories  ·  Pass criterion: Recall@3 ≥ 0.7`,
  );
  if (s.retiredIds.length) {
    console.log(`\n_Skipped ${s.retiredIds.length} retired gold ids (on the record, not scored as misses):_`);
    for (const id of s.retiredIds) console.log(`  - ${id}`);
  }
  if (s.unknownIds.length) {
    // Not "skipped" — a broken fixture. Scoring it as a miss would silently
    // depress every recall number that follows, so it fails the run instead.
    console.log(`\n**${s.unknownIds.length} UNKNOWN gold ids — M0 gate failure.**`);
    console.log(`Remove the fixture entry, or retire the id in stress-fixtures/retired-gold.json with a reason:`);
    for (const id of s.unknownIds) console.log(`  - ${id}`);
  }
  console.log(`\n- **Recall@1: ${pct(s.recallAt1)}**`);
  console.log(`- **Recall@3: ${pct(s.recallAt3)}**`);
  console.log(`- **MRR:      ${s.mrr.toFixed(3)}**`);
  console.log(`- Verdict:   ${s.pass ? "PASS" : "FAIL"}`);

  // #261: a miss in far_in_pool is a RANKING failure — the gold was retrieved
  // and lost the sort. A miss in oop is a RETRIEVAL failure — the first stage
  // never surfaced it, and no re-ranking can fix that. They read identically
  // in Recall@3 and need opposite work, which is why they are split here.
  // Print the depth actually observed, not the formula. max(k*4,20) = 200 is
  // reachable only on the BM25 path (search.ts:294). recallHybrid fuses
  // bm25.slice(0,50) with vector.slice(0,50) (search.ts:401, :428), so its pool
  // is capped at 100 regardless of k — printing 200 there states a depth the
  // run never had, and makes the two arms' oop shares look comparable.
  const observedDepth = s.rows.reduce((m, r) => Math.max(m, r.poolLen), 0);
  console.log(
    `\n### Region split (observation k=${EVAL_POOL_K}; deepest pool actually observed: ${observedDepth} candidates)\n`,
  );
  console.log("| region | cases | share |");
  console.log("|---|---:|---:|");
  for (const region of ["near", "far_in_pool", "oop", "unobserved"] as const) {
    const n = s.regions[region];
    const label =
      region === "near" ? `rank ≤ ${NEAR_RANK}`
      : region === "far_in_pool" ? `${NEAR_RANK} < rank ≤ pool`
      : region === "oop" ? "never surfaced"
      : "pool hook did not fire — instrumentation gap, not a result";
    console.log(`| ${region} (${label}) | ${n} | ${s.total ? pct(n / s.total) : "—"} |`);
  }

  const misses = s.rows.filter((r) => r.rank === 0 || r.rank > 3);
  if (misses.length === 0) {
    console.log("\nNo misses.");
    return;
  }
  console.log(`\n### Misses (rank > 3 or not in top-10) — ${misses.length}\n`);
  console.log("| rank | gold | paraphrase | top hit (won) | top score |");
  console.log("|---|---|---|---|---:|");
  for (const r of misses) {
    console.log(
      `| ${r.rank || "—"} | \`${r.goldId}\` | ${truncate(r.paraphrase, 60)} | \`${r.topId}\` | ${r.topScore.toFixed(1)} |`,
    );
  }
}

function printCross(s: CrossSummary): void {
  console.log("\n## Slice 2 — Cross-Memory\n");
  if (s.unknownIds.length) {
    console.log(`**${s.unknownIds.length} UNKNOWN expected ids — M0 gate failure.** ${s.unknownIds.join(", ")}\n`);
  }
  if (s.retiredIds.length) {
    console.log(`_${s.retiredIds.length} retired expected ids on the record:_ ${s.retiredIds.join(", ")}\n`);
  }
  console.log(
    `Cases: **${s.total}**  ·  Passed: **${s.passed}/${s.total}**  ·  Recall@k: **${pct(s.recallAtK)}**  ·  Verdict: ${s.pass ? "PASS" : "FAIL"}`,
  );
  console.log("\n| pass | query | expected | found | missing | 1-hop missing |");
  console.log("|:---:|---|---:|---:|---|---|");
  for (const r of s.rows) {
    const e = r.expected.length;
    const f = e - r.missing.length;
    console.log(
      `| ${r.pass ? "✓" : "×"} | ${truncate(r.query, 60)} | ${e} | ${f}/${e} | ${
        r.missing.length === 0 ? "—" : r.missing.map((id) => `\`${id}\``).join(" ")
      } | ${
        r.oneHopMissing.length === 0
          ? "—"
          : r.oneHopMissing.map((id) => `\`${id}\``).join(" ")
      } |`,
    );
  }
}

function printAnti(s: AntiSummary): void {
  console.log("\n## Slice 3 — Anti-Hallucination\n");
  console.log(
    `Cases: **${s.total}**  ·  Cutoff: **<${s.cutoff}**  ·  Median top-score: **${s.median.toFixed(1)}**  ·  Verdict: ${s.pass ? "PASS" : "FAIL"} (median < cutoff)`,
  );
  console.log(
    `\nIndividual cases under cutoff: **${s.underCutoff}/${s.total}** (${pct(s.underCutoff / s.total)}).`,
  );
  console.log("\n### Top-score histogram\n");
  console.log("| bucket | count |");
  console.log("|---|---:|");
  for (const [bucket, count] of s.histogram) {
    const bar = "█".repeat(count);
    console.log(`| ${bucket} | ${count} ${bar} |`);
  }
  console.log("\n### Per query\n");
  console.log("| query | top score | top hit | < cutoff |");
  console.log("|---|---:|---|:---:|");
  for (const r of s.rows) {
    console.log(
      `| ${truncate(r.query, 55)} | ${r.topScore.toFixed(1)} | \`${truncate(r.topId, 50)}\` | ${r.underCutoff ? "✓" : "×"} |`,
    );
  }
}

// ── Markdown report (combined, when --slice all) ────────────────

/**
 * The historic M0 baseline (#261 / C-029). It is a foreign figure relative to
 * any current run — a different, much smaller corpus — so it carries its
 * provenance rather than sitting in the table as three bare literals.
 */
const M0_BASELINE = {
  date: "2026-05-27",
  vaultSize: 59,
  cases: 59,
  recallAt1: 0.983,
  recallAt3: 1.0,
  mrr: 0.992,
  source: "packages/daemon/scripts/save-eval-result.ts",
} as const;

interface ReportInput {
  vaultPath: string;
  vaultSize: number;
  provider: string;
  para?: ParaphrasedSummary;
  cross?: CrossSummary;
  anti?: AntiSummary;
  /** The M0 gate result. Without it the file could print PASS on a run that exited 1. */
  unknownGold: string[];
  allPass: boolean;
  seed: number;
  controlPara?: ParaphrasedSummary;
  controlCross?: CrossSummary;
  nullPara?: ParaphrasedSummary;
  nullCross?: CrossSummary;
}

function buildMarkdownReport(r: ReportInput): string {
  const now = new Date().toISOString();
  const home = process.env.HOME ?? "";
  const displayPath =
    home && r.vaultPath.startsWith(home) ? "~" + r.vaultPath.slice(home.length) : r.vaultPath;
  const lines: string[] = [];
  lines.push(`# Bastra Recall — Stress Eval Report`);
  lines.push("");
  lines.push(`- **Run date:** ${now}`);
  lines.push(`- **Vault path:** \`${displayPath}\``);
  lines.push(`- **Vault size:** ${r.vaultSize} memories`);
  lines.push(`- **Search provider:** ${r.provider}`);
  lines.push("");
  // The gate first — a reader must not have to reach the bottom to learn the
  // run was invalid. #261: the file used to print PASS per slice while the
  // process exited 1 on a broken fixture set.
  lines.push(`- **Verdict:** ${r.allPass ? "PASS" : "FAIL"}`);
  if (r.unknownGold.length) {
    lines.push(
      `- **M0 gate failure:** ${r.unknownGold.length} unknown gold id(s) — ` +
        `${r.unknownGold.join(", ")}. Every number below is computed over a reduced case set.`,
    );
  }
  lines.push("");
  lines.push(`## Comparison to M0 baseline`);
  lines.push("");
  lines.push(
    "M0 used each memory's own first `recall_when` as the query (trivial). " +
      "Stress-eval uses paraphrased queries with zero literal-token overlap.",
  );
  lines.push("");
  // #261 / C-029: the M0 column is a foreign figure relative to this run and
  // carries its provenance. It was measured on a different, much smaller
  // corpus, so the delta is NOT a like-for-like regression — §18.1 forbids a
  // joint ranking across measurements with differing setups.
  lines.push(
    `> The M0 column is a **historic own measurement** (${M0_BASELINE.date}, ` +
      `${M0_BASELINE.vaultSize} memories, ${M0_BASELINE.cases} own-trigger cases). ` +
      `This run is ${r.vaultSize} memories with paraphrased queries. Different corpus and ` +
      `different query construction — read the columns separately, not as one series.`,
  );
  lines.push("");
  lines.push(`| metric | M0 (own trigger, ${M0_BASELINE.vaultSize} memories) | Stress (paraphrased, ${r.vaultSize} memories) |`);
  lines.push("|---|---:|---:|");
  lines.push(`| Recall@1 | ${pct(M0_BASELINE.recallAt1)} | ${r.para ? pct(r.para.recallAt1) : "—"} |`);
  lines.push(`| Recall@3 | ${pct(M0_BASELINE.recallAt3)} | ${r.para ? pct(r.para.recallAt3) : "—"} |`);
  lines.push(`| MRR      | ${M0_BASELINE.mrr.toFixed(3)} | ${r.para ? r.para.mrr.toFixed(3) : "—"} |`);
  lines.push("");

  // §18.1 requires the control arm and the label-shuffle null "im Report
  // ausgewiesen". They existed only on stdout.
  lines.push("## Baselines");
  lines.push("");
  lines.push(`Seed \`${r.seed}\`. Control = random ranking at the same k. Null = same arm, gold labels permuted.`);
  lines.push("");
  lines.push("| slice | measured | control arm | label-shuffle null |");
  lines.push("|---|---:|---:|---:|");
  if (r.para) {
    lines.push(`| paraphrased Recall@3 | ${pct(r.para.recallAt3)} | ${r.controlPara ? pct(r.controlPara.recallAt3) : "—"} | ${r.nullPara ? pct(r.nullPara.recallAt3) : "—"} |`);
  }
  if (r.cross) {
    lines.push(`| cross Recall@k | ${pct(r.cross.recallAtK)} | ${r.controlCross ? pct(r.controlCross.recallAtK) : "—"} | ${r.nullCross ? pct(r.nullCross.recallAtK) : "—"} |`);
  }
  if (r.anti) {
    lines.push(`| anti-hallucination | median ${r.anti.median.toFixed(1)} | n/a — the control emits synthetic ranks, not BM25 scores | n/a — no gold labels to permute |`);
  }
  lines.push("");
  if (r.para) {
    lines.push("### Region split (paraphrased)");
    lines.push("");
    lines.push("| region | cases |");
    lines.push("|---|---:|");
    for (const region of ["near", "far_in_pool", "oop", "unobserved"] as const) {
      lines.push(`| ${region} | ${r.para.regions[region]} |`);
    }
    lines.push("");
  }

  if (r.para) {
    lines.push("## Slice 1 — Paraphrased");
    lines.push("");
    lines.push(
      `- Cases: ${r.para.total} across ${r.para.perMemory.size} memories`,
    );
    lines.push(`- Recall@1: **${pct(r.para.recallAt1)}**`);
    lines.push(`- Recall@3: **${pct(r.para.recallAt3)}**`);
    lines.push(`- MRR: **${r.para.mrr.toFixed(3)}**`);
    lines.push(`- Pass criterion: Recall@3 ≥ 0.7`);
    lines.push(`- **Verdict: ${r.para.pass ? "PASS" : "FAIL"}**`);
    const misses = r.para.rows.filter((row) => row.rank === 0 || row.rank > 3);
    if (misses.length > 0) {
      lines.push("");
      lines.push(`### Misses — ${misses.length}`);
      lines.push("");
      lines.push("| rank | gold | paraphrase | top hit (won) |");
      lines.push("|---|---|---|---|");
      for (const m of misses) {
        lines.push(
          `| ${m.rank || "—"} | \`${m.goldId}\` | ${truncate(m.paraphrase, 60)} | \`${m.topId}\` |`,
        );
      }
    }
    if (r.para.unknownIds.length) {
      lines.push("");
      lines.push(`_Skipped unknown ids: ${r.para.unknownIds.length}_`);
    }
    lines.push("");
  }

  if (r.cross) {
    lines.push("## Slice 2 — Cross-Memory");
    lines.push("");
    lines.push(`- Cases: ${r.cross.total}`);
    lines.push(`- Passed: ${r.cross.passed}/${r.cross.total}`);
    lines.push(`- Aggregate Recall@k: **${pct(r.cross.recallAtK)}**`);
    lines.push(`- **Verdict: ${r.cross.pass ? "PASS" : "FAIL"}**`);
    lines.push("");
    lines.push("| pass | query | expected | found | missing |");
    lines.push("|:---:|---|---:|---:|---|");
    for (const row of r.cross.rows) {
      const e = row.expected.length;
      const f = e - row.missing.length;
      lines.push(
        `| ${row.pass ? "✓" : "×"} | ${truncate(row.query, 60)} | ${e} | ${f}/${e} | ${
          row.missing.length === 0 ? "—" : row.missing.map((id) => `\`${id}\``).join(" ")
        } |`,
      );
    }
    lines.push("");
  }

  if (r.anti) {
    lines.push("## Slice 3 — Anti-Hallucination");
    lines.push("");
    lines.push(`- Cases: ${r.anti.total}`);
    lines.push(`- Noise cutoff: <${r.anti.cutoff}`);
    lines.push(`- Median top-score: **${r.anti.median.toFixed(1)}**`);
    lines.push(
      `- Under-cutoff cases: **${r.anti.underCutoff}/${r.anti.total}** (${pct(r.anti.underCutoff / r.anti.total)})`,
    );
    lines.push(`- **Verdict: ${r.anti.pass ? "PASS" : "FAIL"} (median < cutoff)**`);
    lines.push("");
    lines.push("### Histogram");
    lines.push("");
    lines.push("| bucket | count |");
    lines.push("|---|---:|");
    for (const [bucket, count] of r.anti.histogram) {
      lines.push(`| ${bucket} | ${count} |`);
    }
    lines.push("");
    lines.push("### Per query");
    lines.push("");
    lines.push("| query | top score | top hit |");
    lines.push("|---|---:|---|");
    for (const row of r.anti.rows) {
      lines.push(
        `| ${truncate(row.query, 60)} | ${row.topScore.toFixed(1)} | \`${truncate(row.topId, 50)}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("_Generated by `scripts/eval-stress.ts` (Issues #2, #8)._");
  return lines.join("\n") + "\n";
}

// ── main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vaultPath = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
  if (!vaultPath) {
    console.error("FATAL: BASTRA_VAULT_PATH (or NEXUS_VAULT_PATH) not set");
    process.exit(2);
  }

  // #261: the artifact keeps the RAW output, so tee both streams from here
  // on. Reconstructing the report from the structured results afterwards
  // would record what we meant to print, not what we printed.
  const captured = { out: [] as string[], err: [] as string[] };
  const realLog = console.log.bind(console);
  const realErr = console.error.bind(console);
  console.log = (...a: unknown[]) => {
    captured.out.push(a.join(" ") + "\n");
    realLog(...a);
  };
  console.error = (...a: unknown[]) => {
    captured.err.push(a.join(" ") + "\n");
    realErr(...a);
  };

  const vault = new Vault(vaultPath);
  const { loaded, skipped } = await vault.init();
  if (skipped.length) {
    console.error(`[stress] ${skipped.length} memorys skipped:`);
    for (const s of skipped) console.error(`  - ${s.path}: ${s.err}`);
  }
  console.error(`[stress] vault loaded: ${loaded} memorys`);

  const search = new SearchIndex(vault);
  search.start();

  // #261: build the dense leg BEFORE makeRecaller reads hasEmbeddings(), or
  // the arm silently stays BM25. attachHybrid throws rather than degrade.
  let arm: HybridArm | undefined;
  if (args.hybrid) {
    arm = await attachHybrid(vault, search, vaultPath);
    console.error(`[stress] hybrid arm: ${arm.loadedVectors}/${vault.size()} vectors`);
  }
  const recall = makeRecaller(search, args.hybrid);
  const provider = arm ? arm.provider : "BM25-only";
  console.error(`[stress] provider: ${provider}`);

  const para = args.slices.includes("paraphrased")
    ? await runParaphrased(vault, recall)
    : undefined;
  const cross = args.slices.includes("cross")
    ? await runCrossMemory(vault, recall)
    : undefined;
  const anti = args.slices.includes("anti")
    ? await runAntiHallucination(vault, recall, args.cutoff)
    : undefined;

  // #261: two baselines, without which the numbers above have no scale.
  //
  // The control arm ranks at random — its Recall@k is what the metric prints
  // when there is no retrieval signal at all. The label-shuffle null keeps
  // every query and every gold id but breaks the pairing; a harness that still
  // scores well there is measuring the gold set's shape, not retrieval.
  //
  // Both are seeded. A baseline that moves between runs cannot qualify the
  // number it sits next to.
  const control = makeControlRecaller(vault, args.seed);
  const controlPara = args.slices.includes("paraphrased")
    ? await runParaphrased(vault, control, undefined, false)
    : undefined;
  const controlCross = args.slices.includes("cross")
    ? await runCrossMemory(vault, control)
    : undefined;
  const nullPara = args.slices.includes("paraphrased")
    ? await runParaphrased(vault, recall, shuffleParaphrasedLabels(PARAPHRASED_CASES, args.seed), false)
    : undefined;
  const nullCross = args.slices.includes("cross")
    ? await runCrossMemory(vault, recall, shuffleCrossLabels(CROSS_MEMORY_CASES, args.seed))
    : undefined;

  // ── stdout report ─────────────────────────────────────────
  console.log("\n# Bastra Recall — Stress Eval\n");
  console.log(`Vault: **${loaded}** memories  ·  Provider: **${provider}**`);
  // #261: the production candidate pool is `max(k * 4, 20)` (search.ts:294,
  // :464). It caps what any slice can retrieve, so a number is only readable
  // next to the pool it was measured in.
  console.log(
    `Candidate pool per slice (production formula \`max(k*4, 20)\`): ` +
      `paraphrased k=10 → 40  ·  cross k=max(4, |expected|) → ≥20  ·  anti k=3 → 20`,
  );
  if (para) printParaphrased(para);
  if (cross) printCross(cross);
  if (anti) printAnti(anti);

  console.log("\n## Baselines\n");
  console.log(
    `Seed: \`${args.seed}\`  ·  Control = random ranking, same k  ·  ` +
      `Null = same arm, gold labels permuted across queries.`,
  );
  console.log("\n| slice | measured | control arm | label-shuffle null |");
  console.log("|---|---:|---:|---:|");
  if (para) {
    console.log(
      `| paraphrased Recall@3 | ${pct(para.recallAt3)} | ${controlPara ? pct(controlPara.recallAt3) : "—"} | ${nullPara ? pct(nullPara.recallAt3) : "—"} |`,
    );
  }
  if (cross) {
    console.log(
      `| cross Recall@k | ${pct(cross.recallAtK)} | ${controlCross ? pct(controlCross.recallAtK) : "—"} | ${nullCross ? pct(nullCross.recallAtK) : "—"} |`,
    );
  }
  if (anti) {
    // The anti slice has no gold ids to permute — it grades "should NOT match",
    // so a shuffle has nothing to shuffle. Said out loud rather than left as a
    // blank the reader has to interpret.
    console.log(`| anti-hallucination | median ${anti.median.toFixed(1)} | n/a | n/a — no gold labels to permute |`);
  }

  // M0 gate: "keine unbekannten Gold-IDs". Not a warning — a fixture pointing
  // at a memory that no longer exists makes every number below it wrong.
  const unknownGold = [...(para?.unknownIds ?? []), ...(cross?.unknownIds ?? [])];
  const passes: boolean[] = [];
  if (unknownGold.length > 0) passes.push(false);
  if (para) passes.push(para.pass);
  if (cross) passes.push(cross.pass);
  if (anti) passes.push(anti.pass);
  const allPass = passes.length > 0 && passes.every((p) => p);

  console.log("\n## Overall\n");
  console.log(`Verdict: **${allPass ? "PASS" : "FAIL"}**`);

  // ── JSON export ───────────────────────────────────────────
  if (args.out) {
    const json = {
      run_date: new Date().toISOString(),
      vault_path: vaultPath,
      vault_size: loaded,
      provider,
      slices: {
        paraphrased: para
          ? {
              total: para.total,
              recall_at_1: para.recallAt1,
              recall_at_3: para.recallAt3,
              mrr: para.mrr,
              pass: para.pass,
              unknown_ids: para.unknownIds,
              rows: para.rows,
            }
          : null,
        cross: cross
          ? {
              total: cross.total,
              passed: cross.passed,
              recall_at_k: cross.recallAtK,
              pass: cross.pass,
              rows: cross.rows,
            }
          : null,
        anti: anti
          ? {
              total: anti.total,
              cutoff: anti.cutoff,
              median: anti.median,
              under_cutoff: anti.underCutoff,
              pass: anti.pass,
              histogram: Object.fromEntries(anti.histogram),
              rows: anti.rows,
            }
          : null,
      },
      overall_pass: allPass,
    };
    assertOutsideGitTree(args.out);
    writeFileSync(resolve(args.out), JSON.stringify(json, null, 2), { mode: 0o600 });
    console.error(`[stress] wrote JSON report to ${args.out}`);
  }

  // #261: the run artifact. Written before teardown so a failure here is
  // visible as a failure of the run, not a footnote after it.
  const manifest: RunManifest = {
    run_date: new Date().toISOString(),
    vault_path: vaultPath,
    vault_size: loaded,
    provider,
    command: [process.argv0, ...process.argv.slice(1)].join(" "),
    hashes: computeHashes({
      mems: vault.list(),
      provider,
      config: { slices: args.slices, cutoff: args.cutoff, hybrid: args.hybrid, seed: args.seed },
      dataset: { PARAPHRASED_CASES, CROSS_MEMORY_CASES, ANTI_HALLUCINATION_CASES },
    }),
    seed: args.seed,
  };
  const artifactDir = await writeRunArtifact({
    manifest,
    stdout: captured.out.join(""),
    stderr: captured.err.join(""),
    results: {
      slices: { paraphrased: para, cross: cross, anti: anti },
      baselines: {
        control: { paraphrased: controlPara, cross: controlCross },
        label_shuffle_null: { paraphrased: nullPara, cross: nullCross },
      },
      verdict: allPass ? "PASS" : "FAIL",
    },
  });
  // #261: the markdown report lands NEXT TO the artifact, not in the checkout.
  // It carries every paraphrase query, the gold ids and the vault path, and
  // §18.1 allows only aggregated reports without vault-derived query text in
  // the public repo (C-025, §23). It used to be written into scripts/ and was
  // git-tracked.
  if (args.slices.length === 3) {
    const md = buildMarkdownReport({
      vaultPath,
      vaultSize: loaded,
      provider,
      para,
      cross,
      anti,
      unknownGold,
      allPass,
      seed: args.seed,
      controlPara,
      controlCross,
      nullPara,
      nullCross,
    });
    writeFileSync(join(artifactDir, "stress-report.md"), md, { mode: 0o600 });
  }
  console.error(`[stress] run artifact: ${artifactDir}`);

  search.stop();
  if (arm) await arm.cleanup();
  await vault.stop();

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("[stress] FATAL:", err);
  process.exit(1);
});
