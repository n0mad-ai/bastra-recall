/**
 * #129: the held-out check a bridge must pass before it may be contributed.
 *
 * The mint and its judge are the same signal (P1), and one bridge perturbs
 * every query that shares its trigger terms (P4). So a bridge earns its way
 * out of this machine only by MEASURED lift on queries it was not minted from:
 *
 * 1. CASES — the #121 candidate-pool log: every logged recall with a pool and
 *    an outcome (an acted-on episode, else a found load that follows it). The
 *    outcome is the gold memory. A case is `near` when the gold already ranks in
 *    the top SERVING_K without any bridge, else `far`; a far case is `in-pool`
 *    when the gold was in the logged candidate pool and `out-of-pool` when it
 *    was not — the stratum a bridge exists for, and the one a reranker cannot
 *    reach (#129 refinement).
 * 2. FOLDS — hash(query) → one of k folds, so a query and its repeats sit in
 *    one fold. For each fold the bridges are minted from the reaches of the
 *    OTHER folds (the same harvestBridges the mint runs), then measured on this
 *    fold's cases only.
 * 3. LIFT — for each held-out case a bridge fires on (the recall path's own
 *    expansionsFor, at the weight a contributed bridge would have): the change
 *    in reciprocal rank of the gold when the bridge's terms are added. A near
 *    case pushed out of the top SERVING_K is a regression.
 * 4. NULL — the same trigger with ANOTHER bridge's expansion terms. A lift a
 *    foreign expansion also produces is query-length inflation, not direction
 *    (zzallirog's null arm, #129 thread).
 *
 * The ranker is passed in: the CLI uses the vault's BM25 index, tests a fixed
 * table. BM25 only, on purpose — it is the arm a bridge widens, it needs no
 * model, and a k-fold over a local log runs in seconds.
 */
import { createHash } from "node:crypto";
import { BridgePool, CONFIRMED_BRIDGE_EVIDENCE, isConfirmedBridge, type Bridge } from "./bridges.js";
import { extractCandidatePools, harvestBridges, reconstructReaches, type TelemetryEvent } from "./harvest.js";

/** Folds for the held-out split. 5 keeps 80 % of the log for minting. */
export const VERIFY_FOLDS = 5;

/** The top-k a recall actually serves; the near/far line and the regression line. */
export const SERVING_K = 5;

export type Stratum = "near" | "far-in-pool" | "far-out-of-pool";
export const STRATA: readonly Stratum[] = ["near", "far-in-pool", "far-out-of-pool"];

export interface HeldOutCase {
  query: string;
  gold: string;
  fold: number;
  /** The gold memory was in the logged candidate pool. */
  inPool: boolean;
}

export interface SliceStats {
  /** Held-out cases in the slice (pool-level) or cases the bridge fired on. */
  cases: number;
  /** Cases where at least one expansion term was added. */
  fired: number;
  /** Σ Δ reciprocal rank of the gold over the fired cases. */
  liftSum: number;
  /** Near cases the expansion pushed out of the top SERVING_K. */
  regressions: number;
}

export interface BridgeVerdict {
  id: string;
  /** Held-out cases the bridge fired on, over all folds. */
  fires: number;
  /** Mean Δ reciprocal rank over those fires (0 when none). */
  lift: number;
  /** Mean Δ reciprocal rank of the foreign-expansion null (0 when unmeasured). */
  nullLift: number;
  nullFires: number;
  byStratum: Record<Stratum, SliceStats>;
}

export interface VerifyReport {
  folds: number;
  cases: number;
  /** Pool level: every fold's bridges together, as recall would run them. */
  pool: Record<Stratum, SliceStats>;
  perBridge: Map<string, BridgeVerdict>;
}

const emptySlice = (): SliceStats => ({ cases: 0, fired: 0, liftSum: 0, regressions: 0 });
const emptyStrata = (): Record<Stratum, SliceStats> => ({
  near: emptySlice(),
  "far-in-pool": emptySlice(),
  "far-out-of-pool": emptySlice(),
});

const normalize = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, " ");

/** hash(query) → fold. Repeats of one query always share a fold. */
export function foldOf(query: string, folds: number = VERIFY_FOLDS): number {
  return createHash("sha256").update(normalize(query)).digest().readUInt32BE(0) % folds;
}

/** recall_id → gold memory: an acted-on episode, else a found load after it. */
function goldByRecallId(events: TelemetryEvent[]): Map<string, string> {
  const gold = new Map<string, string>();
  for (const e of events) {
    if (e.kind === "recall_episode" && e.acted_on === true && typeof e.recall_id === "string" && typeof e.memory_id === "string") {
      if (!gold.has(e.recall_id)) gold.set(e.recall_id, e.memory_id);
    }
  }
  for (const e of events) {
    if (e.kind !== "load_memory" || e.found === false || typeof e.id !== "string") continue;
    for (const rid of [e.follows_recall, e.from_hook_recall]) {
      if (typeof rid === "string" && !gold.has(rid)) gold.set(rid, e.id);
    }
  }
  return gold;
}

/** The labelled held-out cases in the candidate-pool log, one per (query, gold). */
export function heldOutCases(events: TelemetryEvent[], folds: number = VERIFY_FOLDS): HeldOutCase[] {
  const gold = goldByRecallId(events);
  const seen = new Set<string>();
  const out: HeldOutCase[] = [];
  for (const entry of extractCandidatePools(events)) {
    const g = entry.recallId !== undefined ? gold.get(entry.recallId) : undefined;
    if (g === undefined) continue;
    const key = `${normalize(entry.query)}\n${g}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ query: entry.query, gold: g, fold: foldOf(entry.query, folds), inPool: entry.pool.some((p) => p.id === g) });
  }
  return out;
}

/** 1-based rank of `id`, 0 when absent. */
function rankOf(ranked: string[], id: string): number {
  return ranked.indexOf(id) + 1;
}

const rr = (rank: number): number => (rank > 0 ? 1 / rank : 0);

/** What a contributed bridge would do: confirmed weight, no local demotion. */
function asContributed(b: Bridge): Bridge {
  const { demoted_at: _local, ...rest } = b;
  return { ...rest, evidence: Math.max(b.evidence, CONFIRMED_BRIDGE_EVIDENCE) };
}

function record(slice: SliceStats, delta: number, regressed: boolean): void {
  slice.fired++;
  slice.liftSum += delta;
  if (regressed) slice.regressions++;
}

/**
 * The k-fold held-out measurement. `events` are the bridge-teaching events
 * (bridgeTeachingEvents, #704); `rank(query)` returns memory ids best first.
 */
export function verifyBridges(opts: {
  events: TelemetryEvent[];
  getMemoryTerms: (memoryId: string) => string[];
  rank: (query: string) => string[];
  folds?: number;
  /** Measure only these bridge ids one by one (the pool level still runs every
   *  fold's bridges). Each fire costs two recalls, and on a real log most fold
   *  bridges are not contribution candidates: 924 cases × ~40 fires each was
   *  ~20 minutes of BM25; the local candidates alone take a fraction of it. */
  only?: ReadonlySet<string>;
}): VerifyReport {
  const folds = opts.folds ?? VERIFY_FOLDS;
  const cases = heldOutCases(opts.events, folds);
  const reaches = reconstructReaches(opts.events);
  const pool = emptyStrata();
  const perBridge = new Map<string, BridgeVerdict & { liftSum: number; nullSum: number }>();

  for (let fold = 0; fold < folds; fold++) {
    const held = cases.filter((c) => c.fold === fold);
    if (held.length === 0) continue;
    const train = reaches.filter((r) => foldOf(r.query, folds) !== fold);
    const bridges = harvestBridges(train, opts.getMemoryTerms)
      .bridges.map(asContributed)
      .sort((a, b) => a.id.localeCompare(b.id));
    const all = BridgePool.of(bridges);
    const single = bridges.map((b) => BridgePool.of([b]));
    // Null arm: the next bridge's expansion under this bridge's trigger.
    const foreign = bridges.map((b, i) => {
      const other = bridges[(i + 1) % bridges.length];
      if (bridges.length < 2 || other.expansion_terms.join(" ") === b.expansion_terms.join(" ")) return null;
      return BridgePool.of([{ ...b, expansion_terms: other.expansion_terms }]);
    });

    for (const c of held) {
      const before = rankOf(opts.rank(c.query), c.gold);
      const near = before > 0 && before <= SERVING_K;
      const stratum: Stratum = near ? "near" : c.inPool ? "far-in-pool" : "far-out-of-pool";
      const measure = (added: string[]): { delta: number; regressed: boolean } => {
        const after = rankOf(opts.rank(`${c.query} ${added.join(" ")}`), c.gold);
        return { delta: rr(after) - rr(before), regressed: near && (after === 0 || after > SERVING_K) };
      };

      pool[stratum].cases++;
      const addedAll = all.expansionsFor(c.query);
      if (addedAll.length > 0) {
        const m = measure(addedAll);
        record(pool[stratum], m.delta, m.regressed);
      }

      bridges.forEach((b, i) => {
        if (opts.only && !opts.only.has(b.id)) return;
        const added = single[i].expansionsFor(c.query);
        if (added.length === 0) return;
        const v =
          perBridge.get(b.id) ??
          { id: b.id, fires: 0, lift: 0, nullLift: 0, nullFires: 0, liftSum: 0, nullSum: 0, byStratum: emptyStrata() };
        perBridge.set(b.id, v);
        const m = measure(added);
        v.fires++;
        v.liftSum += m.delta;
        v.byStratum[stratum].cases++;
        record(v.byStratum[stratum], m.delta, m.regressed);
        const addedNull = foreign[i]?.expansionsFor(c.query) ?? [];
        if (addedNull.length > 0) {
          v.nullFires++;
          v.nullSum += measure(addedNull).delta;
        }
      });
    }
  }

  const out = new Map<string, BridgeVerdict>();
  for (const [id, v] of perBridge) {
    const { liftSum, nullSum, ...rest } = v;
    out.set(id, { ...rest, lift: v.fires > 0 ? liftSum / v.fires : 0, nullLift: v.nullFires > 0 ? nullSum / v.nullFires : 0 });
  }
  return { folds, cases: cases.length, pool, perBridge: out };
}

export interface ContributionVerdict {
  eligible: boolean;
  /** Why not — empty when eligible. */
  reasons: string[];
}

/**
 * #129: may this local bridge be contributed? Every rule has to hold:
 * - not demoted (#714: it fired and led nowhere);
 * - confirmed: evidence from ≥ CONFIRMED_BRIDGE_EVIDENCE independent occasions
 *   (a contributed bridge below that is never loaded anyway, bridges.ts);
 * - measured: it fired on at least one held-out case;
 * - held-out lift ≥ 0 in EVERY slice it fired on — an out-of-pool loss cannot
 *   hide behind an in-pool gain;
 * - no near case pushed out of the top SERVING_K (the P4 regression guard);
 * - lift ≥ the foreign-expansion null.
 */
export function contributionVerdict(b: Bridge, v: BridgeVerdict | undefined): ContributionVerdict {
  const reasons: string[] = [];
  if (typeof b.demoted_at === "string") reasons.push("demoted (fired without outcome)");
  if (!isConfirmedBridge(b)) reasons.push(`unconfirmed (evidence ${b.evidence} < ${CONFIRMED_BRIDGE_EVIDENCE} independent occasions)`);
  if (!v || v.fires === 0) {
    // A bridge already out on the rules above is not measured at all (`only`).
    if (reasons.length === 0) reasons.push("no held-out fire (unmeasured)");
    return { eligible: false, reasons };
  }
  for (const s of STRATA) {
    const slice = v.byStratum[s];
    if (slice.fired > 0 && slice.liftSum < 0) reasons.push(`held-out lift < 0 on ${s} (${(slice.liftSum / slice.fired).toFixed(3)})`);
  }
  const regressions = STRATA.reduce((n, s) => n + v.byStratum[s].regressions, 0);
  if (regressions > 0) reasons.push(`pushed ${regressions} near hit(s) out of the top ${SERVING_K}`);
  if (v.lift < v.nullLift) reasons.push(`lift ${v.lift.toFixed(3)} below the foreign-expansion null ${v.nullLift.toFixed(3)}`);
  return { eligible: reasons.length === 0, reasons };
}
