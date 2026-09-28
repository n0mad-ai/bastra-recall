#!/usr/bin/env tsx
/**
 * Offline ablation — marginal lift of `recall_when` (Issue #89).
 *
 * The M0 baseline (scripts/eval.ts) queries each memory with its OWN
 * `recall_when` phrase. That's an upper bound, not a recall measurement: the
 * trigger text lives in the doc, so it retrieves the doc almost by
 * construction. It cannot answer the question a user actually cares about —
 * *how load-bearing is the dedicated trigger field?*
 *
 * This harness isolates that with a controlled ablation over the SAME vault:
 *
 *   - control   : `recall_when` stripped from the searchable fields
 *   - treatment : `recall_when` indexed at its production weight (core: x5)
 *
 * Every other field weight + search option is pinned to core (see
 * index-config.ts), so the two arms differ on exactly one dimension. Queries
 * are PARAPHRASES of each memory's trigger — held out, ideally sharing zero
 * literal tokens — simulating how a future session phrases the situation in
 * its own words rather than the author's.
 *
 *   marginal-lift@k = Recall@k(treatment) - Recall@k(control)
 *
 * A no-trigger ("anti") slice bounds false-positive surfacing: queries with no
 * relevant memory should NOT score high, and adding the trigger field must not
 * inflate that.
 *
 * IMPORTANT — read before citing a number:
 *   The bundled `fixtures/eval-vault` is a tiny SYNTHETIC vault. Its purpose is
 *   to make the harness self-contained and CI-runnable, NOT to be the headline
 *   result. A real, citable marginal-lift number comes from pointing this at a
 *   real vault with hand-written paraphrases:
 *     BASTRA_VAULT_PATH=/path/to/vault npm run lift -- --cases my-cases.json
 *
 * Usage:
 *   npm run lift                          # bundled synthetic vault + cases
 *   npm run lift -- --boost 5 --k 3       # tune the treatment weight / @k
 *   BASTRA_VAULT_PATH=/v npm run lift -- --cases cases.json --out lift.json
 *
 * Exit code: 0 on a normal run; 1 if zero paraphrased queries were evaluated
 * (empty case file, or every case id missing from the vault) — a lift number
 * over zero queries is not a measurement, so it is refused rather than
 * printed as a misleading "+0.0 pp".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Vault } from "@bastra-recall/core";
import type { Memory } from "@bastra-recall/core";
import {
  buildIndex,
  rankOf,
  topScore,
  TREATMENT_RECALL_WHEN_BOOST,
} from "./index-config.js";

// ── Case fixtures ──────────────────────────────────────────────

interface ParaphrasedCase {
  /** Existing memory id in the vault (the gold target). */
  id: string;
  /** Short handle for the report. */
  label: string;
  /** Paraphrases of the memory's recall_when trigger (held-out queries). */
  paraphrases: string[];
}

interface AntiCase {
  /** Off-vault query — no memory should genuinely match. */
  query: string;
  note?: string;
}

interface CaseFile {
  paraphrased: ParaphrasedCase[];
  anti: AntiCase[];
}

// ── CLI ────────────────────────────────────────────────────────

interface Args {
  vault: string;
  cases: string;
  out: string | null;
  boost: number;
  k: number;
}

const DEFAULT_VAULT = resolve(import.meta.dirname, "../fixtures/eval-vault");
const DEFAULT_CASES = resolve(import.meta.dirname, "../fixtures/cases.json");

function parseArgs(argv: string[]): Args {
  const args: Args = {
    vault: process.env.BASTRA_VAULT_PATH ?? DEFAULT_VAULT,
    cases: DEFAULT_CASES,
    out: null,
    boost: TREATMENT_RECALL_WHEN_BOOST,
    k: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault") {
      args.vault = req(argv[++i], "--vault");
    } else if (a === "--cases") {
      args.cases = req(argv[++i], "--cases");
    } else if (a === "--out") {
      args.out = req(argv[++i], "--out");
    } else if (a === "--boost") {
      args.boost = num(argv[++i], "--boost");
    } else if (a === "--k") {
      args.k = num(argv[++i], "--k");
    } else if (a === "-h" || a === "--help") {
      console.log(
        "marginal-lift — recall_when ablation\n" +
          "  --vault <path>  vault to index (or BASTRA_VAULT_PATH)\n" +
          "  --cases <path>  paraphrased + anti cases JSON\n" +
          "  --boost <n>     treatment recall_when weight (default 5)\n" +
          "  --k <n>         Recall@k (default 3)\n" +
          "  --out <path>    also write a JSON report",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return args;
}

function req(v: string | undefined, flag: string): string {
  if (!v) throw new Error(`${flag} needs a value`);
  return v;
}

function num(v: string | undefined, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a number`);
  return n;
}

// ── Metrics ────────────────────────────────────────────────────

interface ArmStats {
  queries: number;
  recallAt1: number;
  recallAtK: number;
  mrr: number;
}

interface PerArmRun {
  hit1: number;
  hitK: number;
  reciprocalRankSum: number;
  total: number;
}

function emptyRun(): PerArmRun {
  return { hit1: 0, hitK: 0, reciprocalRankSum: 0, total: 0 };
}

function record(run: PerArmRun, rank: number, k: number): void {
  run.total++;
  if (rank === 1) run.hit1++;
  if (rank >= 1 && rank <= k) run.hitK++;
  if (rank > 0) run.reciprocalRankSum += 1 / rank;
}

function finalize(run: PerArmRun): ArmStats {
  const n = run.total || 1;
  return {
    queries: run.total,
    recallAt1: run.hit1 / n,
    recallAtK: run.hitK / n,
    mrr: run.reciprocalRankSum / n,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const caseFile = JSON.parse(readFileSync(args.cases, "utf8")) as CaseFile;

  const vault = new Vault(args.vault);
  const { loaded, skipped } = await vault.init();
  if (skipped.length) {
    for (const s of skipped) console.error(`  skipped ${s.path}: ${s.err}`);
  }
  const memories: Memory[] = vault.list().filter((m) => !m.fm.obsolete);
  const known = new Set(memories.map((m) => m.fm.id));

  const control = buildIndex(memories, { kind: "control" });
  const treatment = buildIndex(memories, { kind: "treatment", boost: args.boost });

  // ── paraphrased slice ──
  const controlRun = emptyRun();
  const treatmentRun = emptyRun();
  const rescued: { id: string; query: string; ctrlRank: number; treatRank: number }[] = [];
  const unknownIds: string[] = [];

  for (const c of caseFile.paraphrased) {
    if (!known.has(c.id)) {
      unknownIds.push(c.id);
      continue;
    }
    for (const q of c.paraphrases) {
      const cRank = rankOf(control.search(q), c.id);
      const tRank = rankOf(treatment.search(q), c.id);
      record(controlRun, cRank, args.k);
      record(treatmentRun, tRank, args.k);
      // "rescued" = buried/missed by control, pulled into top-k by treatment.
      const ctrlBuried = cRank === 0 || cRank > args.k;
      const treatHit = tRank >= 1 && tRank <= args.k;
      if (ctrlBuried && treatHit) {
        rescued.push({ id: c.id, query: q, ctrlRank: cRank, treatRank: tRank });
      }
    }
  }

  if (controlRun.total === 0) {
    const reason =
      caseFile.paraphrased.length === 0
        ? "the case file has no paraphrased cases"
        : `all ${unknownIds.length} case id(s) are missing from the vault`;
    console.error(`[lift] not evaluable: ${reason} — refusing to report a lift number`);
    process.exit(1);
  }

  const ctrl = finalize(controlRun);
  const treat = finalize(treatmentRun);
  const lift1 = treat.recallAt1 - ctrl.recallAt1;
  const liftK = treat.recallAtK - ctrl.recallAtK;

  // ── anti-trigger slice (false-positive band) ──
  const antiControl: number[] = [];
  const antiTreatment: number[] = [];
  for (const a of caseFile.anti) {
    antiControl.push(topScore(control.search(a.query)));
    antiTreatment.push(topScore(treatment.search(a.query)));
  }
  const antiCtrlMed = median(antiControl);
  const antiTreatMed = median(antiTreatment);

  // ── report ──
  const lines: string[] = [];
  lines.push("# recall_when — Marginal-Lift Ablation\n");
  lines.push(
    `Vault: **${loaded}** memorys  ·  paraphrased queries: **${treat.queries}**  ·  ` +
      `treatment boost: **x${args.boost}**  ·  k = **${args.k}**\n`,
  );
  lines.push("## Recall (paraphrased held-out queries)\n");
  lines.push("| metric | control (stripped) | treatment (x" + args.boost + ") | marginal lift |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| Recall@1 | ${pct(ctrl.recallAt1)} | ${pct(treat.recallAt1)} | **${signed(lift1)}** |`,
  );
  lines.push(
    `| Recall@${args.k} | ${pct(ctrl.recallAtK)} | ${pct(treat.recallAtK)} | **${signed(liftK)}** |`,
  );
  lines.push(`| MRR | ${ctrl.mrr.toFixed(3)} | ${treat.mrr.toFixed(3)} | ${signedRaw(treat.mrr - ctrl.mrr)} |`);
  lines.push("");
  lines.push(
    `**marginal-lift@${args.k} = ${signed(liftK)}** ` +
      `(${rescued.length}/${treat.queries} queries rescued from outside top-${args.k})\n`,
  );

  lines.push("## False-positive band (no-trigger control)\n");
  lines.push(
    `Median top-1 score on ${caseFile.anti.length} off-vault queries — ` +
      `control: **${antiCtrlMed.toFixed(1)}**, treatment: **${antiTreatMed.toFixed(1)}**. ` +
      `Adding the trigger field ${antiTreatMed > antiCtrlMed + 1 ? "RAISES" : "does not raise"} ` +
      `false-positive surfacing.\n`,
  );

  if (rescued.length > 0) {
    lines.push(`## Rescued by recall_when (top ${Math.min(rescued.length, 15)})\n`);
    lines.push("| gold id | paraphrase | control rank | treatment rank |");
    lines.push("|---|---|---|---|");
    for (const r of rescued.slice(0, 15)) {
      lines.push(`| ${r.id} | ${trunc(r.query, 48)} | ${r.ctrlRank || "miss"} | ${r.treatRank} |`);
    }
    lines.push("");
  }

  if (unknownIds.length > 0) {
    lines.push(
      `> ⚠️ ${unknownIds.length} case id(s) not in vault (skipped): ${unknownIds.join(", ")}\n`,
    );
  }

  const report = lines.join("\n");
  console.log(report);

  if (args.out) {
    const json = {
      vault: args.vault,
      vaultSize: loaded,
      boost: args.boost,
      k: args.k,
      control: ctrl,
      treatment: treat,
      marginalLiftAt1: lift1,
      marginalLiftAtK: liftK,
      rescued: rescued.length,
      antiFalsePositive: { controlMedian: antiCtrlMed, treatmentMedian: antiTreatMed },
      unknownIds,
    };
    writeFileSync(args.out, JSON.stringify(json, null, 2));
    console.error(`\n[lift] JSON written to ${args.out}`);
  }
}

function signed(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pp`;
}

function signedRaw(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
