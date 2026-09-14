/**
 * The arithmetic of the #501 rerank decision — pure, and deliberately alone.
 *
 * Everything here is a function of arrays. No vault, no index, no model, no
 * clock. That is the point: the parts of a measurement that decide what the
 * number MEANS are exactly the parts nobody can inspect once they are tangled
 * up with an Ollama call and a 400 MB ONNX session. Split out, they are
 * testable against hand-worked examples (`__tests__/rerank-replay.test.ts`),
 * and the runner beside them holds no statistics of its own.
 *
 * The resampling mirrors what `rrf-k-beir.ts` did for `RRF_K`: paired per
 * query, bootstrap CI plus a sign-flip permutation test. A rerank lift without
 * an interval is not a finding — #118 is the standing reminder that a plausible
 * lever can move a mean and rescue nothing.
 */

/**
 * Reorder the first `n` of `pool` by `scoreOf`, leave the tail where it is.
 *
 * The tail matters and is not an implementation detail: a rerank stage in
 * production would sit between `staleness.rank` and `slice(0, k)` and would
 * only ever be given a window. Dropping the tail here would silently measure a
 * TRUNCATION as part of the rerank whenever `k > n`, and the served k is 10
 * while the smallest registered window is also 10.
 *
 * Ties keep pool order. A cross-encoder that cannot separate two candidates has
 * said nothing about them, and the RRF order is what we had before it spoke.
 */
export function rerankWindow<T>(
  pool: readonly T[],
  n: number,
  scoreOf: (item: T, indexInWindow: number) => number,
): T[] {
  if (n <= 0) return [...pool];
  const head = pool.slice(0, n);
  const tail = pool.slice(n);
  const scored = head.map((item, i) => ({ item, i, score: scoreOf(item, i) }));
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return [...scored.map((s) => s.item), ...tail];
}

/** Did ANY expected id make the top k? The same predicate #500 reports. */
export function recallAny(ranked: readonly string[], expected: ReadonlySet<string>, k: number): 0 | 1 {
  if (expected.size === 0) return 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (expected.has(ranked[i])) return 1;
  return 0;
}

/** 1-based rank of the first expected id, or 0 when none is in the list. */
export function firstExpectedRank(ranked: readonly string[], expected: ReadonlySet<string>): number {
  for (let i = 0; i < ranked.length; i++) if (expected.has(ranked[i])) return i + 1;
  return 0;
}

/** Mean of a numeric sample. Empty is 0 — a slice with no cases has no lift. */
export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Deterministic PRNG (mulberry32), the same construction `goldset-run.ts` uses
 * for its control arm — a resampled interval that moves between runs on
 * unchanged data is not a reportable number.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairedResult {
  n: number;
  /** Mean of the per-case deltas (treatment − control). */
  delta: number;
  /** Percentile bootstrap interval over the paired deltas. */
  ci95: [number, number];
  /** Two-sided sign-flip permutation p-value. */
  p: number;
  /** How the cases split — the numbers a mean hides. */
  better: number;
  worse: number;
  unchanged: number;
}

/**
 * The paired comparison, resampled.
 *
 * `deltas[i]` is one case's treatment minus its control on the SAME query
 * through the SAME retrieval — that pairing is what makes the interval narrow
 * enough to say anything on a few hundred cases, and it is also what keeps
 * Ollama's mood out of the number (§4 of the measurement plan): whatever the
 * dense arm did on case i sits in both halves of delta i.
 */
export function pairedComparison(
  deltas: readonly number[],
  opts: { iterations?: number; seed?: number } = {},
): PairedResult {
  const iterations = opts.iterations ?? 10_000;
  const seed = opts.seed ?? 20260909;
  const n = deltas.length;
  const observed = mean(deltas);
  const split = {
    better: deltas.filter((d) => d > 0).length,
    worse: deltas.filter((d) => d < 0).length,
    unchanged: deltas.filter((d) => d === 0).length,
  };
  if (n === 0) return { n, delta: 0, ci95: [0, 0], p: 1, ...split };

  const rndBoot = seededRandom(seed);
  const means: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += deltas[Math.floor(rndBoot() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * iterations)];
  const hi = means[Math.min(iterations - 1, Math.ceil(0.975 * iterations) - 1)];

  // Sign-flip: under the null the sign of a paired delta is arbitrary. Seeded
  // separately from the bootstrap so neither test rides the other's stream.
  const rndPerm = seededRandom(seed ^ 0x5f5f5f5f);
  let atLeastAsExtreme = 0;
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rndPerm() < 0.5 ? -deltas[i] : deltas[i];
    if (Math.abs(sum / n) >= Math.abs(observed)) atLeastAsExtreme++;
  }
  // +1/+1 (the standard small-sample correction) so a p of exactly 0 — which
  // no permutation test can actually license — is never reported.
  const p = (atLeastAsExtreme + 1) / (iterations + 1);

  return { n, delta: observed, ci95: [lo, hi], p, ...split };
}

/** Group cases into named slices; a case may appear in exactly one per grouping. */
export function sliceBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) (out[key(r)] ??= []).push(r);
  return out;
}
