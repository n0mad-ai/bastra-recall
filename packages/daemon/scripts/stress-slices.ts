/**
 * The three measurement slices of the stress harness (#2, #8).
 *
 * Split out of eval-stress.ts. Each runner takes a `Recaller` — it neither
 * knows nor cares which arm produced it — and returns a summary the harness
 * prints. The summary types are the contract between the two halves.
 */
import type { Vault } from "@bastra-recall/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seededDerangement, type Recaller } from "./stress-arm.js";
import { PARAPHRASED_CASES, type ParaphrasedCase } from "./stress-fixtures/paraphrased.js";
import { CROSS_MEMORY_CASES, type CrossMemoryCase } from "./stress-fixtures/cross-memory.js";
import { ANTI_HALLUCINATION_CASES } from "./stress-fixtures/anti-hallucination.js";

// ── Retired gold ids (M0 gate, #261) ───────────────────────────
//
// §18.1: "veraltete Gold-IDs werden entfernt oder versioniert", and the gate
// is "keine unbekannten Gold-IDs". A fixture pointing at a memory that no
// longer exists is not a miss — it is a broken case, and scoring it as a miss
// silently depresses every recall number that follows. So an unknown id is a
// hard error unless it is retired on the record.

interface RetiredGold {
  retired: Array<{ id: string; retired_at: string; reason: string }>;
}

let retiredCache: Set<string> | undefined;

export function retiredGoldIds(): Set<string> {
  if (!retiredCache) {
    const file = join(import.meta.dirname, "stress-fixtures", "retired-gold.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RetiredGold;
    retiredCache = new Set(parsed.retired.map((r) => r.id));
  }
  return retiredCache;
}

// ── Pool regions (M0, #261) ────────────────────────────────────
//
// The three regions §18.1 wants labelled separately. Without them a "miss" is
// unreadable: a gold that ranked 7th and a gold the first stage never even
// surfaced are the same zero in Recall@3, but they are opposite problems —
// one is a ranking failure, the other a retrieval failure, and only the second
// is what bridges and query expansion exist to fix.
//
// S and P follow the convention already used by the persona and bridge
// harnesses (bridge-transfer.ts), so the numbers stay comparable across them.

/** NEAR is rank <= S. Same S as packages/eval's harnesses. */
export const NEAR_RANK = 5;

/**
 * k used ONLY to observe a deep candidate pool. Production is max(k*4, 20)
 * (search.ts), so k=50 yields 200 — the upper end of the ">=100 or 200" the
 * contract asks for in out-of-pool evals. Eval-only: the measured Recall@k
 * still comes from a separate call at the production k, because widening the
 * pool changes what damping and re-sorting see.
 */
export const EVAL_POOL_K = 50;

/**
 * `unobserved` is not a region — it is the admission that the pool hook never
 * fired for this case, so nothing can be said about where the gold sat.
 *
 * It exists because the alternative is worse. SearchIndex caches recall
 * results for 30s, and on a BM25 cache hit it returns early WITHOUT calling
 * onCandidatePool (search.ts:241-248); the hybrid path does call it, but with
 * the cached top-k rather than the deep pool (search.ts:388). Either way a
 * cached observation call yields an empty or short pool, which would classify
 * every case as `oop` — a catastrophic retrieval failure that is really an
 * instrumentation gap. A visible `unobserved` count says so instead.
 */
export type PoolRegion = "near" | "far_in_pool" | "oop" | "unobserved";

export function classifyRegion(poolRank: number, poolLen: number, observed = true): PoolRegion {
  if (!observed) return "unobserved";
  if (poolRank >= 1 && poolRank <= NEAR_RANK) return "near";
  if (poolRank >= 1 && poolRank <= poolLen) return "far_in_pool";
  return "oop";
}

/**
 * Runs the observation call and returns the gold's 1-based rank in the deep pool.
 *
 * Listens for the `degraded` marker as well. A provider hiccup makes
 * `EmbeddingIndex.search` return [] (embeddings.ts), and `recallHybrid` then
 * answers from pure BM25 — which DOES fire the pool hook (search.ts:309). The
 * pool would come back looking fine while being a different engine, a
 * different depth and a different ordering than the measured call used. That
 * is the silent arm fallback the M0 gate forbids, and without this listener it
 * would have been reintroduced inside the instrument meant to certify it.
 */
async function observePool(
  recall: Recaller,
  query: string,
  goldId: string,
): Promise<{ poolRank: number; poolLen: number; observed: boolean }> {
  let pool: Array<{ id: string }> | undefined;
  let degraded = false;
  await recall(query, {
    k: EVAL_POOL_K,
    onCandidatePool: (p) => { pool = p; },
    onStage: (st) => {
      if (st.meta && typeof st.meta.degraded === "string") degraded = true;
    },
  });
  if (pool === undefined || degraded) return { poolRank: 0, poolLen: 0, observed: false };
  const idx = pool.findIndex((h) => h.id === goldId);
  return { poolRank: idx === -1 ? 0 : idx + 1, poolLen: pool.length, observed: true };
}

// ── Label-shuffle null (M0 gate, #261) ─────────────────────────
//
// The null hypothesis for every gold-labelled slice: keep the queries, keep
// the gold ids, break only the pairing between them. A harness that still
// scores well on permuted labels is not measuring retrieval — it is measuring
// the shape of the gold set, or leaking the answer through the query. The
// null is what makes a headline number readable: 45% means nothing until you
// know whether shuffled labels also score 45%.
//
// Seeded, so the null is reproducible; a null that moves per run cannot be
// cited next to the number it qualifies.

/** Reassigns gold ids across cases, keeping every query and every id in play. */
export function shuffleParaphrasedLabels(cases: readonly ParaphrasedCase[], seed: number): ParaphrasedCase[] {
  const ids = seededDerangement(cases.map((c) => c.id), seed);
  return cases.map((c, i) => ({ ...c, id: ids[i] }));
}

/** Same for the cross slice: the expected SETS move between queries intact. */
export function shuffleCrossLabels(cases: readonly CrossMemoryCase[], seed: number): CrossMemoryCase[] {
  const expected = seededDerangement(cases.map((c) => ({ expected: c.expected, oneHop: c.oneHop })), seed);
  return cases.map((c, i) => ({ ...c, expected: expected[i].expected, oneHop: expected[i].oneHop }));
}

// ── Slice 1: paraphrased ───────────────────────────────────────

export interface ParaphrasedResult {
  goldId: string;
  label: string;
  paraphrase: string;
  rank: number; // 0 = miss
  topId: string;
  topScore: number;
  goldScore: number; // 0 if not in top-10
  /** 1-based rank in the DEEP observation pool; 0 = never surfaced. */
  poolRank: number;
  /** Length of that pool for this query. */
  poolLen: number;
  region: PoolRegion;
}

export interface ParaphrasedSummary {
  total: number;
  /** Gold ids missing from the vault and NOT on the retirement record — a gate failure. */
  unknownIds: string[];
  /** Gold ids missing but retired on the record — skipped, not counted as misses. */
  retiredIds: string[];
  /** Case counts per region; a miss in `oop` is a retrieval failure, in `far_in_pool` a ranking one. */
  regions: Record<PoolRegion, number>;
  recallAt1: number;
  recallAt3: number;
  mrr: number;
  perMemory: Map<string, { hits: number; tests: number }>;
  rows: ParaphrasedResult[];
  pass: boolean;
}

export async function runParaphrased(
  vault: Vault,
  recall: Recaller,
  cases: readonly ParaphrasedCase[] = PARAPHRASED_CASES,
  /**
   * Off for the baseline passes. They re-query the same strings within the
   * cache TTL, so their observation calls would be served from a cache that
   * carries no deep pool — and they have no use for the region split anyway.
   */
  observeRegions = true,
): Promise<ParaphrasedSummary> {
  const knownIds = new Set(vault.list().map((m) => m.fm.id));
  const retired = retiredGoldIds();
  const unknownIds: string[] = [];
  const retiredIds: string[] = [];
  const rows: ParaphrasedResult[] = [];
  const perMemory = new Map<string, { hits: number; tests: number }>();

  for (const c of cases) {
    if (!knownIds.has(c.id)) {
      // Retired on the record: skipped, and NOT scored as a miss. Anything
      // else is a broken fixture and fails the gate.
      (retired.has(c.id) ? retiredIds : unknownIds).push(c.id);
      continue;
    }
    const slot = perMemory.get(c.id) ?? { hits: 0, tests: 0 };
    for (const p of c.paraphrases) {
      // Two calls on purpose. The measured rank comes from the PRODUCTION k,
      // because widening the pool changes what damping and the re-sort see.
      // The deep pool is observed separately and only classifies the case.
      const hits = await recall(p, { k: 10 });
      const { poolRank, poolLen, observed } = observeRegions
        ? await observePool(recall, p, c.id)
        : { poolRank: 0, poolLen: 0, observed: false };
      const rank = hits.findIndex((h) => h.id === c.id);
      const goldHit = hits[rank];
      rows.push({
        goldId: c.id,
        label: c.label,
        paraphrase: p,
        rank: rank === -1 ? 0 : rank + 1,
        topId: hits[0]?.id ?? "(none)",
        topScore: hits[0]?.score ?? 0,
        goldScore: goldHit?.score ?? 0,
        poolRank,
        poolLen,
        region: classifyRegion(poolRank, poolLen, observed),
      });
      slot.tests++;
      if (rank !== -1 && rank < 3) slot.hits++;
    }
    perMemory.set(c.id, slot);
  }

  const total = rows.length;
  const top1 = rows.filter((r) => r.rank === 1).length;
  const top3 = rows.filter((r) => r.rank >= 1 && r.rank <= 3).length;
  const mrr = total === 0
    ? 0
    : rows.reduce((acc, r) => acc + (r.rank > 0 ? 1 / r.rank : 0), 0) / total;

  const regions: Record<PoolRegion, number> = { near: 0, far_in_pool: 0, oop: 0, unobserved: 0 };
  for (const r of rows) regions[r.region]++;

  const recallAt3 = total === 0 ? 0 : top3 / total;
  return {
    total,
    unknownIds,
    retiredIds,
    regions,
    recallAt1: total === 0 ? 0 : top1 / total,
    recallAt3,
    mrr,
    perMemory,
    rows,
    pass: recallAt3 >= 0.7,
  };
}

// ── Slice 2: cross-memory ──────────────────────────────────────

export interface CrossResult {
  query: string;
  expected: string[];
  found: string[]; // ids in top-k order
  missing: string[];
  oneHopExpected: string[];
  oneHopFound: string[];
  oneHopMissing: string[];
  topScore: number;
  pass: boolean;
}

export interface CrossSummary {
  total: number;
  passed: number;
  rows: CrossResult[];
  recallAtK: number;
  pass: boolean;
  /** Expected ids missing from the vault and not retired — a gate failure. */
  unknownIds: string[];
  /** Expected ids missing but retired on the record. */
  retiredIds: string[];
}

export async function runCrossMemory(
  vault: Vault,
  recall: Recaller,
  cases: readonly CrossMemoryCase[] = CROSS_MEMORY_CASES,
): Promise<CrossSummary> {
  const knownIds = new Set(vault.list().map((m) => m.fm.id));
  const retired = retiredGoldIds();
  const unknownIds: string[] = [];
  const retiredIds: string[] = [];
  const rows: CrossResult[] = [];

  for (const c of cases) {
    // Same gate as the paraphrased slice. Filtering an unknown id out of
    // `expected` silently shrinks what the case demands, so a stale fixture
    // makes the slice look easier instead of broken.
    for (const id of [...c.expected, ...(c.oneHop ?? [])]) {
      if (!knownIds.has(id)) (retired.has(id) ? retiredIds : unknownIds).push(id);
    }
    const validExpected = c.expected.filter((id) => knownIds.has(id));
    // Nothing left to grade. Scoring it would count a case that demands
    // nothing as PASS and lift Recall@k — the retirement record is meant to be
    // score-neutral, not to make the slice easier.
    if (validExpected.length === 0) continue;
    const validOneHop = (c.oneHop ?? []).filter((id) => knownIds.has(id));
    const k = Math.max(4, validExpected.length);

    const directHits = await recall(c.query, { k });
    const foundDirect = directHits.map((h) => h.id);
    const missing = validExpected.filter((id) => !foundDirect.includes(id));

    let oneHopFound: string[] = [];
    if (validOneHop.length > 0) {
      const hopHits = await recall(c.query, { k, expand_hops: 1 });
      const hopIds = hopHits.map((h) => h.id);
      oneHopFound = validOneHop.filter((id) => hopIds.includes(id));
    }
    const oneHopMissing = validOneHop.filter((id) => !oneHopFound.includes(id));

    const pass = missing.length === 0 && oneHopMissing.length === 0;
    rows.push({
      query: c.query,
      expected: validExpected,
      found: foundDirect,
      missing,
      oneHopExpected: validOneHop,
      oneHopFound,
      oneHopMissing,
      topScore: directHits[0]?.score ?? 0,
      pass,
    });
  }

  const passed = rows.filter((r) => r.pass).length;
  const totalExpected = rows.reduce(
    (acc, r) => acc + r.expected.length + r.oneHopExpected.length,
    0,
  );
  const totalFound = rows.reduce(
    (acc, r) =>
      acc +
      (r.expected.length - r.missing.length) +
      (r.oneHopExpected.length - r.oneHopMissing.length),
    0,
  );
  const recallAtK = totalExpected === 0 ? 0 : totalFound / totalExpected;
  return {
    total: rows.length,
    passed,
    rows,
    recallAtK,
    // Every case retired leaves rows.length === 0, and
    // `passed === rows.length` reads `0 === 0` as PASS — the retirement
    // record was meant to be score-neutral, not to make the slice pass by
    // having nothing left to grade.
    pass: rows.length > 0 && passed === rows.length,
    unknownIds,
    retiredIds,
  };
}

// ── Slice 3: anti-hallucination ────────────────────────────────

export interface AntiResult {
  query: string;
  topScore: number;
  topId: string;
  note: string;
  underCutoff: boolean;
}

export interface AntiSummary {
  total: number;
  underCutoff: number;
  cutoff: number;
  median: number;
  rows: AntiResult[];
  histogram: Map<string, number>;
  pass: boolean;
}

export async function runAntiHallucination(
  vault: Vault,
  recall: Recaller,
  cutoff: number,
): Promise<AntiSummary> {
  const rows: AntiResult[] = [];
  for (const c of ANTI_HALLUCINATION_CASES) {
    const hits = await recall(c.query, { k: 3 });
    const top = hits[0];
    const topScore = top?.score ?? 0;
    rows.push({
      query: c.query,
      topScore,
      topId: top?.id ?? "(none)",
      note: c.note ?? "",
      underCutoff: topScore < cutoff,
    });
  }

  const sortedScores = [...rows.map((r) => r.topScore)].sort((a, b) => a - b);
  const median = sortedScores.length === 0
    ? 0
    : sortedScores[Math.floor(sortedScores.length / 2)] ?? 0;

  // Bucket histogram: 0-30, 30-60, 60-100, 100-150, >=150.
  const histogram = new Map<string, number>([
    ["0-30", 0],
    ["30-60", 0],
    ["60-100", 0],
    ["100-150", 0],
    [">=150", 0],
  ]);
  for (const r of rows) {
    if (r.topScore < 30) histogram.set("0-30", (histogram.get("0-30") ?? 0) + 1);
    else if (r.topScore < 60)
      histogram.set("30-60", (histogram.get("30-60") ?? 0) + 1);
    else if (r.topScore < 100)
      histogram.set("60-100", (histogram.get("60-100") ?? 0) + 1);
    else if (r.topScore < 150)
      histogram.set("100-150", (histogram.get("100-150") ?? 0) + 1);
    else histogram.set(">=150", (histogram.get(">=150") ?? 0) + 1);
  }

  const underCutoff = rows.filter((r) => r.underCutoff).length;
  // Pass when the *median* is under the cutoff. Individual outliers are
  // expected with BM25 + fuzzy + prefix matching on short generic tokens.
  return {
    total: rows.length,
    underCutoff,
    cutoff,
    median,
    rows,
    histogram,
    pass: median < cutoff,
  };
}
