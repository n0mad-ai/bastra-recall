#!/usr/bin/env tsx
/**
 * The #501 replay: does a query-time cross-encoder fix the mis-ranking deficit?
 *
 * #103 and #118 measured the same thing twice and independently: the candidates
 * ARE in the pool, the ORDER is wrong. Hybrid keeps 99 of 115 far golds in the
 * pool at R@3 far 70.4 %, and a deeper pool pulls in 12 more of which NONE
 * reaches the top 3. Every lever tried so far tunes the fusion of two signals
 * that never look at the query and a candidate together. A cross-encoder does
 * exactly that. Whether it helps enough to pay for itself is what this measures.
 *
 * **This is a decision harness, not a feature.** Nothing here is imported by
 * `core` or `daemon`, no ranking changes, and the deliverable is a table plus a
 * recommendation. The pre-registration — free parameters, slices and the bar
 * each recommendation shape has to clear — is
 * `docs/design/2026-09-09-501-cross-encoder-rerank-messplan.md` and
 * `registrations/rerank-decision.json`, both written before the first number.
 *
 * ── Nothing is reimplemented ───────────────────────────────────────────────
 * The retrieval is the production `SearchIndex.recallHybrid`: real BM25, real
 * `EmbeddingIndex` over the real Ollama provider, real `fuseRRF`, real
 * staleness. Same rule as #103 and #500 — a number produced any other way
 * describes a retriever we do not ship.
 *
 * The rerank window comes from `opts.onCandidatePool` (#121, `search.ts:1226`),
 * which hands out the damped, pre-`slice(k)` pool: exactly the list a real
 * rerank stage would see, in the same order and on the same score scale as the
 * served hits. That is why this measurement needs no production change at all.
 *
 * At `PRODUCTION_K = 10` that pool is `max(k*4, 20)` = 40 deep, so N up to 30
 * is measurable without moving a shipped constant. Reranking the SERVED hits
 * instead would hand back 10 candidates and report a truncation as a result.
 *
 * ── One scoring pass covers every N ────────────────────────────────────────
 * `rerankWindow(pool, 10, …)` only ever consults the scores of the first ten
 * candidates. So the model scores the top `max(N)` once per (case, model,
 * passage mode) and every smaller N is derived from the same scores — exact,
 * not an approximation, and three times cheaper. Latency is the exception and
 * is measured with real N-sized batches (`--latency`), because there the batch
 * size IS the question.
 *
 * ── Run ────────────────────────────────────────────────────────────────────
 *   BASTRA_VAULT_PATH=/path/to/vault npm run rerank-replay --workspace=@bastra-recall/eval -- \
 *     --gold ~/.bastra/eval-goldset/gold-blind.json \
 *     --gold ~/.bastra/eval-goldset/gold-tel-1.json \
 *     --models en-de,bge --out /tmp/rerank-501.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SearchIndex, Vault } from "@bastra-recall/core";
import type { Memory, RecallHit } from "@bastra-recall/core";
import { loadGoldFiles } from "./goldset-dataset.js";
import type { GoldCase } from "./goldset.js";
import { PRODUCTION_K, attachHybrid } from "./goldset-run.js";
import {
  MODELS,
  loadCrossEncoder,
  passageFor,
  type PairScorer,
  type PassageMode,
} from "./rerank-model.js";
import {
  mean,
  pairedComparison,
  recallAny,
  rerankWindow,
  sliceBy,
  type PairedResult,
} from "./rerank-metrics.js";
import { measureLatency, type LatencyReport } from "./rerank-latency.js";

/** Registered in `registrations/rerank-decision.json`; #501 names the three. */
const NS = [10, 20, 30] as const;
/** The cuts the decision is made on. R@3 is the one #103/#118 reported. */
const KS = [1, 3, 5] as const;
const PASSAGE_MODES: readonly PassageMode[] = ["short", "body"];

interface Args {
  gold: string[];
  models: string[];
  out: string | null;
  limit: number | null;
  latency: boolean;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { gold: [], models: ["en-de"], out: null, limit: null, latency: false, seed: 20260909 };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--gold") a.gold.push(argv[++i]);
    else if (f === "--models") a.models = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (f === "--out") a.out = argv[++i];
    else if (f === "--limit") a.limit = Number(argv[++i]);
    else if (f === "--latency") a.latency = true;
    else if (f === "--seed") a.seed = Number(argv[++i]);
    else throw new Error(`unknown flag: ${f}`);
  }
  if (!a.gold.length) throw new Error("--gold is required (repeatable)");
  for (const m of a.models) {
    if (!MODELS[m]) throw new Error(`unknown model ${JSON.stringify(m)} — registered: ${Object.keys(MODELS).join(", ")}`);
  }
  return a;
}

/**
 * The cases this run scores.
 *
 * Probe cases are out — they are diagnostics, not questions anyone asked, and
 * they are excluded from every other main denominator too. `no_answer` cases
 * are also out of the LIFT denominator, but they are NOT discarded: they are
 * the guard in `noAnswerGuard` below, because a reranker can raise R@3 and
 * still hurt by confidently promoting something on a question with no answer.
 */
export function partitionCases(cases: readonly GoldCase[]): {
  answerable: GoldCase[];
  noAnswer: GoldCase[];
  probes: number;
} {
  const nonProbe = cases.filter((c) => !c.probe_group);
  return {
    answerable: nonProbe.filter((c) => !c.no_answer && c.expected_ids.length > 0),
    noAnswer: nonProbe.filter((c) => c.no_answer),
    probes: cases.length - nonProbe.length,
  };
}

/**
 * The reporting slice a case belongs to.
 *
 * `neutral` is 205 of the 584 answerable cases and is kept apart on purpose:
 * those are keyword chains out of hooks ("memory format schema json yaml"),
 * not questions. A cross-encoder is trained on natural-language query/passage
 * pairs, so whether it carries keyword chains at all is an open question with
 * 35 % of the denominator behind it — and if the lift is prose-only, that is a
 * recommendation shape ("prose queries only") which has to be visible in the
 * data rather than invented afterwards.
 */
export function langSlice(c: GoldCase): string {
  return c.lang;
}

export interface CaseRow {
  id: string;
  query: string;
  lang: string;
  /** Ids of the damped pre-slice pool, in RRF order — the baseline ranking. */
  baseline: string[];
  expected: Set<string>;
  poolSize: number;
}

/** One (model, passage mode) arm's ranking for one case, per N. */
type ArmRanking = Record<number, string[]>;

async function collectPools(
  search: SearchIndex,
  cases: readonly GoldCase[],
  label: string,
): Promise<CaseRow[]> {
  const rows: CaseRow[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    let pool: RecallHit[] = [];
    await search.recallHybrid(c.query, {
      k: PRODUCTION_K,
      onCandidatePool: (p) => {
        pool = p;
      },
    });
    rows.push({
      id: c.id,
      query: c.query,
      lang: langSlice(c),
      baseline: pool.map((h) => h.id),
      expected: new Set(c.expected_ids),
      poolSize: pool.length,
    });
    if ((i + 1) % 25 === 0) process.stderr.write(`\r[${label}] retrieved ${i + 1}/${cases.length}`);
  }
  process.stderr.write(`\r[${label}] retrieved ${cases.length}/${cases.length}\n`);
  return rows;
}

/**
 * Score one arm over every case, once, at the deepest N — see the header for
 * why every smaller N falls out of the same scores.
 */
async function rankArm(
  scorer: PairScorer,
  mode: PassageMode,
  rows: readonly CaseRow[],
  memoryOf: (id: string) => Memory | undefined,
  label: string,
): Promise<Map<string, ArmRanking>> {
  const deepest = Math.max(...NS);
  const out = new Map<string, ArmRanking>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const window = row.baseline.slice(0, deepest);
    const passages = window.map((id) => {
      const m = memoryOf(id);
      // A pooled id the vault no longer holds is a stale label, not a miss —
      // `goldset-run.ts` refuses the run over exactly this. Scoring an empty
      // passage would quietly bury the candidate instead.
      if (!m) throw new Error(`pooled id ${id} is not in the vault — stale label, refusing to score it`);
      return passageFor(m, mode);
    });
    const scores = await scorer.score(row.query, passages);
    const ranking: ArmRanking = {};
    for (const n of NS) ranking[n] = rerankWindow(row.baseline, n, (_id, j) => scores[j] ?? -Infinity);
    out.set(row.id, ranking);
    if ((i + 1) % 25 === 0) process.stderr.write(`\r[${label}] scored ${i + 1}/${rows.length}`);
  }
  process.stderr.write(`\r[${label}] scored ${rows.length}/${rows.length}\n`);
  return out;
}

export interface ArmReport {
  model: string;
  passage: PassageMode;
  n: number;
  /** Per k: baseline R@k, reranked R@k, and the paired comparison of the two. */
  at: Record<string, { baseline: number; reranked: number; paired: PairedResult }>;
  /** The ceiling: any expected id anywhere in the reranked window. */
  recall_any_at_n: number;
  by_lang: Record<string, Record<string, PairedResult>>;
}

function reportArm(
  model: string,
  passage: PassageMode,
  n: number,
  rows: readonly CaseRow[],
  rankings: Map<string, ArmRanking>,
  seed: number,
): ArmReport {
  const at: ArmReport["at"] = {};
  for (const k of KS) {
    const base = rows.map((r) => recallAny(r.baseline, r.expected, k));
    const rer = rows.map((r) => recallAny(rankings.get(r.id)![n], r.expected, k));
    at[`r@${k}`] = {
      baseline: mean(base),
      reranked: mean(rer),
      paired: pairedComparison(rer.map((v, i) => v - base[i]), { seed }),
    };
  }
  const byLang: ArmReport["by_lang"] = {};
  for (const [lang, sub] of Object.entries(sliceBy(rows, (r) => r.lang))) {
    byLang[lang] = {};
    for (const k of KS) {
      const base = sub.map((r) => recallAny(r.baseline, r.expected, k));
      const rer = sub.map((r) => recallAny(rankings.get(r.id)![n], r.expected, k));
      byLang[lang][`r@${k}`] = pairedComparison(rer.map((v, i) => v - base[i]), { seed });
    }
  }
  return {
    model,
    passage,
    n,
    at,
    recall_any_at_n: mean(rows.map((r) => recallAny(r.baseline, r.expected, n))),
    by_lang: byLang,
  };
}

/**
 * The counter-test. A rerank that lifts R@3 and also promotes something on a
 * question with no answer has not helped — it has made a confident mistake
 * louder. Reported as "how often did the top position change", which is the
 * observable part; whether that costs `weak_result` its trigger is the second
 * half and needs the shipped predicate, not a copy of it.
 */
export function noAnswerGuard(
  rows: readonly CaseRow[],
  rankings: Map<string, ArmRanking>,
  n: number,
): { n_cases: number; top1_changed: number } {
  let changed = 0;
  for (const r of rows) {
    const after = rankings.get(r.id)?.[n];
    if (!after) continue;
    if ((r.baseline[0] ?? null) !== (after[0] ?? null)) changed++;
  }
  return { n_cases: rows.length, top1_changed: changed };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pp(x: number): string {
  const v = x * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vaultPath = process.env.BASTRA_VAULT_PATH;
  if (!vaultPath) throw new Error("BASTRA_VAULT_PATH is required");

  const { cases, sources } = loadGoldFiles(args.gold);
  const part = partitionCases(cases);
  let answerable = part.answerable;
  if (args.limit !== null) answerable = answerable.slice(0, args.limit);

  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  if (search.size() !== vault.size()) {
    throw new Error(`lexical index holds ${search.size()} of ${vault.size()} memories — the BM25 arm would be blind.`);
  }
  // The dense arm is not optional here. #501 asks what a reranker adds ON TOP
  // of the shipped hybrid ranking; measured over a BM25-only pool it would
  // answer a question nobody asked.
  const arm = await attachHybrid(vault, search, vaultPath);
  console.error(`[rerank-replay] ${arm.label}`);

  console.error(
    `[rerank-replay] ${answerable.length} answerable · ${part.noAnswer.length} no_answer guard · ` +
      `${part.probes} probes excluded · sources ${JSON.stringify(sources)}`,
  );

  const rows = await collectPools(search, answerable, "answerable");
  const guardRows = await collectPools(search, part.noAnswer, "no_answer");

  const shallow = rows.filter((r) => r.poolSize < Math.max(...NS)).length;
  if (shallow > 0) {
    console.error(
      `[rerank-replay] note: ${shallow} case(s) returned a pool shallower than N=${Math.max(...NS)} — ` +
        "their deepest windows are the whole pool, which is the honest ceiling, not a truncation bug.",
    );
  }

  const reports: ArmReport[] = [];
  const guards: Record<string, ReturnType<typeof noAnswerGuard>> = {};
  const latency: LatencyReport[] = [];
  for (const modelKey of args.models) {
    const scorer = await loadCrossEncoder(modelKey);
    console.error(`[rerank-replay] ${scorer.id} loaded in ${scorer.loadMs} ms`);
    // The latency pass runs FIRST and on a fresh scorer, so its first sample
    // is a genuine cold call. Doing it after the quality pass would time a
    // session warmed by hundreds of batches and report that as cold.
    if (args.latency) {
      const state = { scoredAnything: false };
      for (const mode of PASSAGE_MODES) {
        latency.push(...(await measureLatency(scorer, mode, rows, (id) => vault.get(id), modelKey, NS, state)));
      }
    }
    for (const mode of PASSAGE_MODES) {
      const label = `${modelKey}/${mode}`;
      const rankings = await rankArm(scorer, mode, rows, (id) => vault.get(id), label);
      const guardRankings = await rankArm(scorer, mode, guardRows, (id) => vault.get(id), `${label} guard`);
      for (const n of NS) {
        reports.push(reportArm(modelKey, mode, n, rows, rankings, args.seed));
        guards[`${label}/N=${n}`] = noAnswerGuard(guardRows, guardRankings, n);
      }
    }
    scorer.close();
  }

  const L: string[] = [];
  L.push("");
  L.push(`  #501 — query-time cross-encoder rerank · ${answerable.length} answerable gold cases`);
  L.push("  M4 Pro — the FAST side of the hardware tiers. Every latency figure is a lower bound.");
  L.push("");
  L.push(`  ${"model/passage".padEnd(16)} | ${"N".padStart(3)} | ${"R@3".padStart(7)} | ${"ΔR@3".padStart(6)} | ${"95% CI".padStart(15)} | ${"R@5".padStart(7)} | ${"ΔR@5".padStart(6)} | any@N`);
  L.push(`  ${"-".repeat(16)}-+-----+---------+--------+-----------------+---------+--------+------`);
  for (const r of reports) {
    const c3 = r.at["r@3"].paired.ci95;
    L.push(
      `  ${`${r.model}/${r.passage}`.padEnd(16)} | ${String(r.n).padStart(3)} | ` +
        `${pct(r.at["r@3"].reranked).padStart(7)} | ${pp(r.at["r@3"].paired.delta).padStart(6)} | ` +
        `${`[${pp(c3[0])}, ${pp(c3[1])}]`.padStart(15)} | ` +
        `${pct(r.at["r@5"].reranked).padStart(7)} | ${pp(r.at["r@5"].paired.delta).padStart(6)} | ` +
        `${pct(r.recall_any_at_n)}`,
    );
  }
  L.push("");
  L.push("  baseline (no rerank): " + KS.map((k) => `R@${k} ${pct(reports[0]?.at[`r@${k}`].baseline ?? 0)}`).join(" · "));
  L.push("");
  if (latency.length) {
    L.push("  added latency — M4 Pro, lower bound. Model load is beside these, never inside them:");
    L.push(`    ${"model/passage".padEnd(16)} | ${"N".padStart(3)} | ${"p50".padStart(8)} | ${"p95".padStart(8)} | first call | n`);
    for (const l of latency) {
      L.push(
        `    ${`${l.model}/${l.passage}`.padEnd(16)} | ${String(l.n).padStart(3)} | ` +
          `${`${l.warm_p50_ms.toFixed(1)} ms`.padStart(8)} | ${`${l.warm_p95_ms.toFixed(1)} ms`.padStart(8)} | ` +
          `${l.first_call_ms.toFixed(1)} ms${l.first_call_is_cold ? " (cold)" : ""} | ${l.samples}`,
      );
    }
    L.push(`    model load: ${latency[0].load_ms} ms — a prewarm-lane cost (#361), not a recall cost.`);
    L.push("");
  }
  L.push("  no_answer guard — a rerank that moves the top slot here made a confident mistake louder:");
  for (const [key, g] of Object.entries(guards)) {
    L.push(`    ${key.padEnd(24)} top-1 changed on ${g.top1_changed}/${g.n_cases}`);
  }
  L.push("");
  const out = L.join("\n");
  console.log(out);

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          issue: 501,
          registration: "packages/eval/registrations/rerank-decision.json",
          hardware: "Apple M4 Pro — fast side of the tiers; latency figures are lower bounds",
          arm_label: arm.label,
          cases: { answerable: rows.length, no_answer: guardRows.length, probes_excluded: part.probes, sources },
          production_k: PRODUCTION_K,
          reports,
          no_answer_guard: guards,
          latency,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.error(`[rerank-replay] wrote ${args.out}`);
  }

  await arm.cleanup();
  search.stop();
  await vault.stop();
}

if (import.meta.filename === process.argv[1]) {
  main().catch((e: Error) => {
    console.error(`[rerank-replay] FATAL: ${e.message}`);
    process.exit(1);
  });
}
