/**
 * What one rerank arm did, assembled into something a decision can be read off.
 *
 * Split from the runner because the two answer different questions and one of
 * them has to be inspectable without a vault: the runner talks to Ollama and a
 * 400 MB ONNX session, this file turns rankings into numbers and slices. Every
 * function here is pure.
 *
 * ── Three things this file exists to get right ─────────────────────────────
 *
 * **1. The score floor.** Production serves `slice(0, k)` and the consumer
 * drops everything under `BASTRA_RECALL_FLOOR` (30). Measuring rank on the
 * unfiltered pool would credit a reranker for promoting a candidate the user
 * never sees. So the order here is the production order — rerank the window,
 * cut to k, apply the floor, then measure — and the floor-free figure travels
 * beside it as an explicitly named UPPER BOUND, never as the headline.
 *
 * **2. Slices that are too small to read.** `mixed` is four cases. A bootstrap
 * interval over four paired deltas is arithmetic, not evidence. Any slice under
 * `MIN_SLICE_N` is reported as `not_evaluable` with its n, rather than as a
 * number somebody might quote.
 *
 * **3. One primary endpoint.** A full run produces several hundred confidence
 * intervals across arms, cuts and slices. At α=0.05 several of those are
 * "significant" under pure noise. Exactly one cell is marked `primary` and
 * carries the recommendation; the rest describe. `countIntervals` reports the
 * actual number rather than a figure written down once and left to go stale.
 *
 * **4. Splits that did not split.** A slice can be too small to read
 * (`MIN_SLICE_N`) or, worse, can look like a split while every case landed on
 * one side. `assignPoolBuckets` detects the second case and marks `by_pool`
 * unusable — see its comment for why the pool size is nearly constant here.
 */
import type { RecallHit } from "@bastra-recall/core";
import {
  firstExpectedRank,
  mean,
  pairedComparison,
  recallAny,
  sliceBy,
  type PairedResult,
} from "./rerank-metrics.js";

/**
 * Below this a slice is reported, not measured.
 *
 * 30 is not a power calculation — it is the point below which a percentile
 * bootstrap over a 0/1 outcome resamples so few distinct values that the
 * interval describes the resampling rather than the data. `mixed` (n=4) is the
 * case this exists for; the `weak_result` subset has its own, higher bar (50)
 * registered against it, because there the whole recommendation would hang on
 * one slice.
 */
export const MIN_SLICE_N = 30;

/** The cuts reported. R@3 is the one #103/#118 measured the deficit at. */
export const KS = [1, 3, 5] as const;

export interface CaseRow {
  id: string;
  query: string;
  lang: string;
  /** `expected_ids` — the strict set. `goldset-run.ts`'s headline uses this. */
  expected: Set<string>;
  /** `expected_ids ∪ acceptable_alternatives` — its `rank_any` companion. */
  expectedAny: Set<string>;
  /** The damped pre-slice pool, in RRF order, WITH scores (the floor needs them). */
  baseline: RecallHit[];
  poolSize: number;
  /** `isWeakResult` on the served baseline — the shipped predicate, not a copy. */
  weakResult: boolean;
  /** Assigned once the run's median pool size is known. */
  poolBucket?: "small" | "large";
}

/** One arm's reranked order per N, as hits (scores travel; the floor needs them). */
export type ArmRanking = Record<number, RecallHit[]>;

/**
 * What production would actually serve: cut to k, then drop below the floor.
 *
 * Both steps, in this order, and neither is optional. `slice` first because the
 * floor is applied by the consumer to what it was given, not used to backfill
 * from deeper in the pool.
 */
export function served(hits: readonly RecallHit[], k: number, floor: number): string[] {
  return hits.slice(0, k).filter((h) => h.score >= floor).map((h) => h.id);
}

export interface CutMetrics {
  baseline: number;
  reranked: number;
  paired: PairedResult;
}

export interface SliceReport {
  n: number;
  /** Set when n < MIN_SLICE_N: the numbers are omitted rather than shown small. */
  not_evaluable?: string;
  at?: Record<string, PairedResult>;
}

export interface ArmReport {
  model: string;
  passage: string;
  n: number;
  /** Exactly one arm in a run carries this. It alone bears a recommendation. */
  primary: boolean;
  /** Production-faithful: served, floored, strict `expected_ids`. THE metric. */
  at: Record<string, CutMetrics>;
  /** The `rank_any` companion `goldset-run.ts` reports beside its headline. */
  at_incl_acceptable: Record<string, CutMetrics>;
  /** Same as `at` with NO score floor — an upper bound, and labelled as one. */
  at_no_floor_upper_bound: Record<string, CutMetrics>;
  /** The ceiling: is a gold anywhere in the window at all? */
  recall_any_at_n: number;
  /** Share of cases whose first expected id ended up at a WORSE rank. */
  rank_regression_share: number;
  by_lang: Record<string, SliceReport>;
  by_pool: Record<string, SliceReport>;
  /** Whether `by_pool` measured anything at all. */
  pool_split: PoolSplit;
  weak_result: SliceReport;
}

function cut(
  rows: readonly CaseRow[],
  rankings: Map<string, ArmRanking>,
  n: number,
  k: number,
  expectedOf: (r: CaseRow) => Set<string>,
  floor: number,
  serveK: number,
  seed: number,
): CutMetrics {
  const base = rows.map((r) => recallAny(served(r.baseline, serveK, floor), expectedOf(r), k));
  const rer = rows.map((r) =>
    recallAny(served(rankings.get(r.id)![n], serveK, floor), expectedOf(r), k),
  );
  return {
    baseline: mean(base),
    reranked: mean(rer),
    paired: pairedComparison(rer.map((v, i) => v - base[i]), { seed }),
  };
}

function sliceReport(
  rows: readonly CaseRow[],
  rankings: Map<string, ArmRanking>,
  n: number,
  floor: number,
  serveK: number,
  seed: number,
  minN = MIN_SLICE_N,
): SliceReport {
  if (rows.length < minN) {
    return {
      n: rows.length,
      not_evaluable: `n=${rows.length} is below ${minN}; a bootstrap interval here would describe the resampling, not the data`,
    };
  }
  const at: Record<string, PairedResult> = {};
  for (const k of KS) {
    const base = rows.map((r) => recallAny(served(r.baseline, serveK, floor), r.expected, k));
    const rer = rows.map((r) =>
      recallAny(served(rankings.get(r.id)![n], serveK, floor), r.expected, k),
    );
    at[`r@${k}`] = pairedComparison(rer.map((v, i) => v - base[i]), { seed });
  }
  return { n: rows.length, at };
}

/**
 * Did this case's first expected id end up worse off?
 *
 * "No gold loses rank" was the original wording and it is a dead criterion —
 * over hundreds of cases some always do, so it would have excluded "always on"
 * regardless of the data. A share, with a registered threshold, is the version
 * that can actually be met or missed.
 *
 * Rank 0 means "not in the served, floored list". Falling out of it is the
 * worst regression there is, so it sorts after every real rank.
 */
function regressed(before: string[], after: string[], expected: Set<string>): boolean {
  const rank = (ids: string[]): number => {
    const r = firstExpectedRank(ids, expected);
    return r === 0 ? Number.POSITIVE_INFINITY : r;
  };
  return rank(after) > rank(before);
}

export function reportArm(opts: {
  model: string;
  passage: string;
  n: number;
  primary: boolean;
  rows: readonly CaseRow[];
  rankings: Map<string, ArmRanking>;
  floor: number;
  serveK: number;
  seed: number;
  /** From `assignPoolBuckets`. A degenerate split must not be reported as one. */
  poolSplit: PoolSplit;
}): ArmReport {
  const { rows, rankings, n, floor, serveK, seed } = opts;
  const at: Record<string, CutMetrics> = {};
  const atAny: Record<string, CutMetrics> = {};
  const atNoFloor: Record<string, CutMetrics> = {};
  for (const k of KS) {
    at[`r@${k}`] = cut(rows, rankings, n, k, (r) => r.expected, floor, serveK, seed);
    atAny[`r@${k}`] = cut(rows, rankings, n, k, (r) => r.expectedAny, floor, serveK, seed);
    atNoFloor[`r@${k}`] = cut(rows, rankings, n, k, (r) => r.expected, -Infinity, serveK, seed);
  }

  const byLang: Record<string, SliceReport> = {};
  for (const [lang, sub] of Object.entries(sliceBy(rows, (r) => r.lang))) {
    byLang[lang] = sliceReport(sub, rankings, n, floor, serveK, seed);
  }
  // Both buckets ALWAYS, even when empty: `sliceBy` omits a bucket with no
  // rows, and an artifact holding only `large` reads like a finished split.
  const grouped = sliceBy(rows, (r) => r.poolBucket ?? "unassigned");
  const byPool: Record<string, SliceReport> = {};
  for (const bucket of ["small", "large"]) {
    const sub = grouped[bucket] ?? [];
    byPool[bucket] = opts.poolSplit.degenerate
      ? { n: sub.length, not_evaluable: `pool split degenerate: ${opts.poolSplit.degenerate}` }
      : sliceReport(sub, rankings, n, floor, serveK, seed);
  }

  const regressions = rows.filter((r) =>
    regressed(
      served(r.baseline, serveK, floor),
      served(rankings.get(r.id)![n], serveK, floor),
      r.expected,
    ),
  ).length;

  return {
    model: opts.model,
    passage: opts.passage,
    n,
    primary: opts.primary,
    at,
    at_incl_acceptable: atAny,
    at_no_floor_upper_bound: atNoFloor,
    // The ceiling is a property of the POOL, so it is measured on the window
    // before the cut — that is what "could a rerank have found it at all" means.
    recall_any_at_n: mean(rows.map((r) => recallAny(r.baseline.slice(0, n).map((h) => h.id), r.expected, n))),
    rank_regression_share: rows.length === 0 ? 0 : regressions / rows.length,
    by_lang: byLang,
    by_pool: byPool,
    pool_split: opts.poolSplit,
    // 50, not MIN_SLICE_N: an entire recommendation shape hangs on this one
    // slice, so it carries the higher registered bar.
    weak_result: sliceReport(rows.filter((r) => r.weakResult), rankings, n, floor, serveK, seed, 50),
  };
}

/**
 * How many confidence intervals this run actually produced.
 *
 * Counted, never asserted. The review of version 1 put it at 180 for the arm
 * shape of the time; the slices added since (pool buckets, the `weak_result`
 * subset, the floor-free and acceptable-alternatives families) push it higher,
 * and a hard-coded figure in the report would have gone quietly stale — which
 * is the same failure mode as the "over 30" this number replaced.
 */
export function countIntervals(reports: readonly ArmReport[]): number {
  let n = 0;
  for (const r of reports) {
    n += Object.keys(r.at).length + Object.keys(r.at_incl_acceptable).length + Object.keys(r.at_no_floor_upper_bound).length;
    for (const s of [...Object.values(r.by_lang), ...Object.values(r.by_pool), r.weak_result]) {
      n += Object.keys(s.at ?? {}).length;
    }
  }
  return n;
}

/**
 * The counter-test on questions that have no answer.
 *
 * **Limit of what this can say, and it is a hard limit:** a top-1 change on an
 * unanswerable question is not harm. There is no right answer there, and both
 * candidates are equally wrong. This measures only whether the rerank reorders
 * that subset SYSTEMATICALLY. The registered 20 % threshold is a veto trigger,
 * never a quality statement, and must not be read as one.
 */
export function noAnswerGuard(
  rows: readonly CaseRow[],
  rankings: Map<string, ArmRanking>,
  n: number,
  serveK: number,
  floor: number,
): { n_cases: number; top1_changed: number; share: number } {
  let changed = 0;
  for (const r of rows) {
    const after = rankings.get(r.id)?.[n];
    if (!after) continue;
    const b = served(r.baseline, serveK, floor)[0] ?? null;
    const a = served(after, serveK, floor)[0] ?? null;
    if (a !== b) changed++;
  }
  return {
    n_cases: rows.length,
    top1_changed: changed,
    share: rows.length === 0 ? 0 : changed / rows.length,
  };
}

export interface PoolSplit {
  median: number;
  cap: number;
  small: number;
  large: number;
  /** Set when the split did not actually split. `by_pool` is then unusable. */
  degenerate?: string;
}

/**
 * The median split over pool size — and the check that it split anything.
 *
 * The threshold is fixed by construction rather than chosen after seeing the
 * recall numbers, the same discipline `longmemeval-run.ts` applies to its
 * near/far cut. That part was never the risk.
 *
 * **The risk is that this split degenerates silently on our data.** The pool is
 * near-constant by construction: `bm25Top` (50) ∪ `vectorTop` (up to 50) is
 * fused and then cut to `HOP_SEED_POOL = max(k*4, 20)` = 40. On a vault well
 * over 50 memories the fused set exceeds 40 for practically every query, so
 * `poolSize == 40` throughout, the median is 40, `>= median` puts EVERY case in
 * `large`, and `small` stays empty. A plain `sliceBy` then omits the empty
 * bucket entirely and the artifact reads `by_pool: { large: { n: 584 } }` —
 * which looks like a result. The `above_pool_size` recommendation shape would
 * be dead again, this time behind a plausible-looking mechanism.
 *
 * So: both buckets are always emitted, and a split that did not split says so
 * in the artifact rather than on stderr, where nobody reads it afterwards.
 *
 * This is a PREDICTION derived from the code, not an observation — it could not
 * be measured without Ollama. It is falsified if the vector arm routinely
 * returns fewer than ~40 hits after filtering. The warning is correct either
 * way: if the prediction does not hold, it stays silent.
 */
export function assignPoolBuckets(rows: CaseRow[], cap: number): PoolSplit {
  const sizes = rows.map((r) => r.poolSize).sort((a, b) => a - b);
  const median = sizes.length === 0 ? 0 : sizes[Math.floor(sizes.length / 2)];
  for (const r of rows) r.poolBucket = r.poolSize >= median ? "large" : "small";
  const small = rows.filter((r) => r.poolBucket === "small").length;
  const large = rows.length - small;
  let degenerate: string | undefined;
  if (rows.length === 0) degenerate = "no cases";
  else if (small === 0 || large === 0) {
    degenerate = `one bucket is empty (small=${small}, large=${large}) — pool size does not vary in this run, so there is nothing to split on`;
  } else if (median >= cap) {
    degenerate = `median ${median} sits at the pool cap ${cap} — the split is an artefact of the cap, not of query difficulty`;
  }
  return { median, cap, small, large, ...(degenerate ? { degenerate } : {}) };
}
