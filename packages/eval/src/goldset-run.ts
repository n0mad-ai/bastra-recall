#!/usr/bin/env tsx
/**
 * The M0 baseline over the gold set (#262, §18.1).
 *
 * The stress harness in `packages/daemon/scripts/eval-stress.ts` measures the
 * repo fixtures — the very `PARAPHRASED_CASES` §19 rules out, because they are
 * paraphrases of the answer. Nothing consumed the gold set itself, so this is
 * the missing half: it takes the labelled cases and reports what retrieval does
 * on them.
 *
 * Every scoring rule is fixed by the label, not by this file:
 *
 *   - a hit is `expected_ids` in the ranking; `acceptable_alternatives` are
 *     scored separately, because §19 keeps the two apart on purpose;
 *   - how deep a hit still counts comes from the case's own
 *     `allowed_retrieval_depth`;
 *   - a `no_answer` case is correct when nothing clears the score floor;
 *   - a `probe_group` case is reported beside the set, never inside it.
 *
 * There is exactly one free constant here, `PRODUCTION_K`, and it is the k the
 * product actually uses. Widening it would change what damping and the re-sort
 * see, so the rank is measured at the production pool and nowhere else.
 *
 * Usage:
 *   BASTRA_VAULT_PATH=/path/to/vault npx tsx src/goldset-run.ts \
 *     --gold ~/.bastra/eval-goldset/gold-blind.json \
 *     --gold ~/.bastra/eval-goldset/gold-tel-1.json \
 *     --hybrid --out ~/.bastra/eval-runs/<dir>/results.json
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EmbeddingIndex,
  OllamaEmbeddingProvider,
  SearchIndex,
  Vault,
  isWeakResult,
  hitTitleMatches,
  decideHits,
  tokenizeWithIdentifiers,
  type RecallHit,
  type StageListener,
} from "@bastra-recall/core";
import { datasetHash, loadGoldFiles, unknownGoldIds } from "./goldset-dataset.js";
import {
  gateVariants,
  gateCase,
  gateCaseUnder,
  assertReproducesShipped,
  NARROWINGS,
  type CaseGateResult,
  type GateRow,
} from "./goldset-gate.js";
import type { GoldCase } from "./goldset.js";

/** The k the product serves. Ranks are measured here and nowhere else. */
const PRODUCTION_K = 10;
/** Documented default of BASTRA_RECALL_FLOOR — below it a hit is not shown. */
const SCORE_FLOOR = 30;
/** Bound on a cold-store backfill; a stuck provider must fail, not hang. */
const BACKFILL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The case id travels with the query because the control arm needs it: its
 * draw must depend on WHICH case it is, never on where the case sat in the
 * concatenated input (#426). The real arms ignore it.
 */
type Recaller = (query: string, caseId: string) => Promise<RecallHit[]>;

/**
 * What the best-anchored served hit anchors ON.
 *
 * `weak_result` reports THAT nothing anchored; this reports WHAT anchored, and
 * the two are the same measurement from opposite ends: on the hybrid path with
 * a non-empty pool, `anchor === "none"` is exactly `weak_result === true`. The
 * baseline run measured 0/372 weak results on answerable cases and could not
 * say why — nothing recorded which of the two anchors was carrying them.
 */
export type AnchorSource = "recall_when" | "title" | "both" | "none";

/**
 * Walk the served list from the top and report the anchors of the FIRST hit
 * that anchors at all — the best-anchored hit, since the list is ranked.
 *
 * Uses `hitTitleMatches` from core, the same building block `isWeakResult` uses;
 * a second title-matching rule here would drift from the one that ships and the
 * two answers would stop being about the same predicate.
 *
 * An empty pool yields `"none"` while `isWeakResult` yields false — it reports
 * "answered with noise", and nothing served is not that. The distinction is
 * academic on this set (0 of 432 cases abstained) but the field must not claim
 * otherwise.
 */
function anchorOf(hits: RecallHit[]): AnchorSource {
  for (const h of hits) {
    const byRecallWhen = h.matched_recall_when === true;
    const byTitle = hitTitleMatches(h);
    if (byRecallWhen && byTitle) return "both";
    if (byRecallWhen) return "recall_when";
    if (byTitle) return "title";
  }
  return "none";
}

export interface CaseResult {
  id: string;
  query: string;
  no_answer: boolean;
  probe_group?: string;
  kind: string;
  zone: string;
  origin: string;
  lang: string;
  allowed_depth: number;
  /** 1-based rank of the first expected id; 0 = not in the production pool. */
  rank_expected: number;
  /** Same for expected ∪ acceptable. */
  rank_any: number;
  top_id: string;
  top_score: number;
  /** Highest score of any expected id, 0 when it never surfaced. */
  gold_score: number;
  /** Nothing cleared the floor — the engine effectively abstained. */
  abstained: boolean;
  /**
   * No served hit anchors lexically — neither `matched_recall_when` nor a title
   * match. The registered follow-up for the M1 `false_abstention` tolerance
   * (registrations/m1-tolerances.json): the score floor cannot fire on the
   * hybrid path, so the abstention metric is pinned at zero, and this predicate
   * is what a future gate would be built on. Recorded, never scored — this run
   * is a measurement, not a gate.
   *
   * The same `isWeakResult` the daemon serves with, imported from core. A
   * second implementation here would be the drift its docstring warns about.
   */
  weak_result: boolean;
  /**
   * Which anchor carried the best-anchored served hit. Turns "weak_result never
   * fires on answerable cases" from an interpretation into a measurement: the
   * distribution over `recall_when` / `title` / `both` says what is holding the
   * anchor, and `none` is the weak result itself.
   */
  anchor: AnchorSource;
  /**
   * Gold ids the vault no longer holds. A gate failure, never a miss — and
   * since #432 the gate actually fires: {@link unknownGoldIds} stops the run
   * before anything is scored, so on a completed run this list is empty. It
   * stays in the row because that is where the evidence belongs.
   */
  unknown_ids: string[];
  /**
   * Which arm produced the top hit. The M0 gate is "no silent arm fallback":
   * a run labelled hybrid whose hits are all `bm25` is a mislabelled run, and
   * only the recorded mode can prove otherwise.
   */
  top_mode: string;
  /**
   * The served pool as an ordered id/score list — the very list the ranks above
   * are derived from (#417).
   *
   * Without it the artifact stored only the runner's own derivation: an
   * independent checker could recompute every aggregate from the ranks, but a
   * systematic error IN the rank determination — an off-by-one in the hit test
   * at positions 2-10, say — stayed invisible, because `top_id` cross-checks
   * position 1 and nothing else. Ids and scores only: no query text and no
   * bodies, so the artifact's privacy posture is unchanged.
   */
  top_k: { id: string; score: number }[];
  /**
   * The §18.2 component gates, when the run was asked for them (#422).
   *
   * Absent unless `--gate` was passed: the evidence decision is a SHADOW at
   * this stage and must not quietly become part of every artifact. Present, it
   * describes what the shipped predicate did to this case's served pool — the
   * ranks it would leave behind, and the counts the seven gate figures are
   * summed from.
   */
  gate?: CaseGateResult;
  /**
   * The same case with the identifier anchor narrowed to title, `recall_when`
   * and frontmatter — the §10.3 variant Daniel asked to be measured before it
   * is decided (the A1 pattern: an identifier appearing in flowing BODY text
   * counts as a hard anchor today, and a hard anchor alone carries `required`).
   *
   * Produced by the SHIPPED predicate, called with an empty memory body:
   * `evidence-decision.ts` reads `m.body` in exactly one place, the identifier
   * haystack. Nothing else moves.
   */
  gate_no_body?: CaseGateResult;
  /**
   * The same case under each candidate narrowing of the two-of-three rule
   * (§10.3), keyed by variant name — and each of those again with the body
   * anchor removed, so solo and combined effects are both readable.
   *
   * Re-derived from the SHIPPED evidence, never from a second feature
   * extraction, and guarded: the runner asserts per case that the
   * re-derivation reproduces `decideHit` at the identity rule.
   */
  gate_narrowed?: Record<string, CaseGateResult>;
}

const hit = (r: CaseResult, k: number, any = false): boolean => {
  const rank = any ? r.rank_any : r.rank_expected;
  return rank >= 1 && rank <= k;
};

export interface SliceMetrics {
  n: number;
  recall_at_1: number;
  recall_at_3: number;
  recall_at_10: number;
  /** Hit inside the case's own allowed_retrieval_depth (capped at k=10). */
  recall_at_allowed_depth: number;
  /** Same, counting acceptable_alternatives as correct too. */
  recall_at_3_incl_acceptable: number;
  mrr: number;
}

const ratio = (n: number, d: number): number => (d === 0 ? 0 : Number((n / d).toFixed(4)));

export function metricsFor(rows: CaseResult[]): SliceMetrics {
  const n = rows.length;
  return {
    n,
    recall_at_1: ratio(rows.filter((r) => hit(r, 1)).length, n),
    recall_at_3: ratio(rows.filter((r) => hit(r, 3)).length, n),
    recall_at_10: ratio(rows.filter((r) => hit(r, PRODUCTION_K)).length, n),
    recall_at_allowed_depth: ratio(
      rows.filter((r) => hit(r, Math.min(r.allowed_depth, PRODUCTION_K))).length,
      n,
    ),
    recall_at_3_incl_acceptable: ratio(rows.filter((r) => hit(r, 3, true)).length, n),
    mrr: n === 0 ? 0 : Number((rows.reduce((a, r) => a + (r.rank_expected > 0 ? 1 / r.rank_expected : 0), 0) / n).toFixed(4)),
  };
}

function groupBy(rows: CaseResult[], key: (r: CaseResult) => string): Record<string, SliceMetrics> {
  const out: Record<string, CaseResult[]> = {};
  for (const r of rows) (out[key(r)] ??= []).push(r);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, metricsFor(v)]));
}

async function attachHybrid(vault: Vault, search: SearchIndex, vaultPath: string): Promise<{
  label: string; vectors: number; cleanup: () => Promise<void>;
}> {
  const provider = new OllamaEmbeddingProvider({
    baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
    keepAlive: "10m",
  });
  const tmpRoot = await mkdtemp(join(tmpdir(), "bastra-goldset-hybrid-"));
  const persistPath = join(tmpRoot, "embeddings.json");
  const cleanup = (): Promise<void> => rm(tmpRoot, { recursive: true, force: true });

  // A measurement must not mutate what it measures: work on a COPY of the
  // production store, never the store itself.
  let hadStore = false;
  try {
    await copyFile(join(vaultPath, ".bastra", "embeddings.json"), persistPath);
    hadStore = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") { await cleanup(); throw e; }
  }
  // Probe first: EmbeddingIndex.start() swallows provider failures and retries,
  // so an unreachable provider would surface as a fifteen-minute hang.
  try {
    await provider.embed(["probe"]);
  } catch (e) {
    await cleanup();
    throw new Error(`--hybrid: embedding provider unreachable: ${(e as Error).message}`);
  }

  const emb = new EmbeddingIndex(vault, provider, persistPath);
  await emb.start();
  const want = vault.size();
  const atStart = emb.size();
  const deadline = Date.now() + BACKFILL_TIMEOUT_MS;
  let loaded = atStart;
  while (loaded < want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const now = emb.size();
    if (now !== loaded) console.error(`[goldset-run] embedding ${now}/${want}…`);
    loaded = now;
  }
  if (loaded < want) {
    emb.stop(); await cleanup();
    throw new Error(`--hybrid: only ${loaded}/${want} memories carry a vector — a partial arm is not a measurement.`);
  }
  search.useEmbeddings(emb);
  if (!search.hasEmbeddings()) {
    emb.stop(); await cleanup();
    throw new Error("--hybrid: useEmbeddings() did not take effect — refusing to report BM25 as hybrid.");
  }
  return {
    label: `Hybrid (BM25 + Vector RRF) · ${provider.id} · store ${hadStore ? "copied from vault" : "embedded fresh"}`
      + (loaded > atStart ? ` · ${loaded - atStart} backfilled` : ""),
    vectors: loaded,
    cleanup: async () => { emb.stop(); await cleanup(); },
  };
}

/** Deterministic PRNG (mulberry32) so the control arm does not move between runs. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The floor every real arm must clear: a random ranking of real ids. Without
 * it a Recall@3 has no scale — nobody can say whether it is retrieval or the
 * shape of the gold set.
 */
export function controlRecaller(ids: string[], seed: number): Recaller {
  // The id pool is sorted, not taken in vault-listing order: the null baseline
  // must be a property of the run seed and the data, never of how the vault
  // happened to enumerate itself.
  const sorted = [...ids].sort();
  return async (_q, caseId) => {
    // Seeded from the run seed and the case's own identity (#426). Seeding from
    // a running counter instead made the draw depend on the case's POSITION in
    // the concatenated input, so reordering the gold files moved the control
    // value on unchanged data — against the documented determinism invariant.
    const rnd = seededRandom(seed ^ stringSeed(caseId));
    const pool = [...sorted];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, PRODUCTION_K).map((id, i) => ({ id, score: 100 - i } as RecallHit));
  };
}

/** Stable 32-bit hash of a case id — the same construction the split uses. */
function stringSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * The per-query degradation gate the M0 arm claim needs (#428).
 *
 * The initial `--hybrid` setup probes the provider and waits for a full vector
 * store, but provider health can change over hundreds of cases: `recallHybrid`
 * then answers from BM25 alone and says so ONLY through the `done` stage's
 * `degraded` meta. The runner installed no `onStage` callback, so those rows
 * stayed inside an artifact labelled hybrid, carrying raw BM25 scores in a
 * column of RRF ones.
 *
 * `top_mode` cannot stand in for this: a healthy fused result legitimately
 * labels its top hit `bm25` or `vector` when the hit appeared in one arm only.
 * Only the emitted reason distinguishes "fused, one arm carried the top hit"
 * from "the vector arm was not there".
 */
export function gatedHybridRecaller(
  search: (query: string, opts: { k: number; onStage: StageListener }) => Promise<RecallHit[]>,
): Recaller {
  return async (query, caseId) => {
    let degraded: string | undefined;
    const hits = await search(query, {
      k: PRODUCTION_K,
      onStage: (s) => {
        const reason = s.name === "done" ? s.meta?.degraded : undefined;
        if (typeof reason === "string") degraded = reason;
      },
    });
    if (degraded !== undefined) {
      throw new Error(
        `case ${caseId}: the vector arm fell back to BM25 (${degraded}) — `
          + "a run labelled hybrid cannot hold a BM25 row.",
      );
    }
    return hits;
  };
}

export async function scoreCases(
  cases: GoldCase[],
  recall: Recaller,
  knownIds: Set<string>,
  /** Whether THIS recaller is the full hybrid path — `isWeakResult` is defined
   *  only there (in BM25-only mode the score is a real BM25 quantity and the
   *  floor already does the job). False for the random control. */
  hybridActive: boolean,
  /** #422: when given, each case is additionally scored through the evidence
   *  decision. Called exactly the way the daemon calls it, so the measurement
   *  describes the predicate that ships and not a second reading of it. */
  decide?: (hits: RecallHit[], query: string) => ReturnType<typeof decideHits>,
  /** #422/§10.3: the same decision under the narrowed anchor, for the delta. */
  decideNoBody?: (hits: RecallHit[], query: string) => ReturnType<typeof decideHits>,
  /** #422/§10.3: the candidate narrowings of the two-of-three rule. */
  narrow?: (
    served: RecallHit[],
    query: string,
    expected: Set<string>,
    any: Set<string>,
  ) => Record<string, CaseGateResult>,
): Promise<CaseResult[]> {
  const rows: CaseResult[] = [];
  for (const c of cases) {
    const unknown = [...c.expected_ids, ...c.acceptable_alternatives].filter((i) => !knownIds.has(i));
    const hits = await recall(c.query, c.id);
    const above = hits.filter((h) => h.score >= SCORE_FLOOR);
    const exp = new Set(c.expected_ids);
    const any = new Set([...c.expected_ids, ...c.acceptable_alternatives]);
    const rExp = above.findIndex((h) => exp.has(h.id));
    const rAny = above.findIndex((h) => any.has(h.id));
    rows.push({
      id: c.id,
      query: c.query,
      no_answer: c.no_answer,
      ...(c.probe_group ? { probe_group: c.probe_group } : {}),
      kind: c.kind,
      zone: c.expected_zone,
      origin: c.origin_type,
      lang: c.lang,
      allowed_depth: c.allowed_retrieval_depth,
      rank_expected: rExp + 1,
      rank_any: rAny + 1,
      top_id: above[0]?.id ?? "(none)",
      top_score: above[0]?.score ?? 0,
      gold_score: rExp === -1 ? 0 : above[rExp].score,
      abstained: above.length === 0,
      // On the SERVED pool, like the daemon: `above` is what clears the floor,
      // and `abstained` is measured on the same list two lines up.
      weak_result: isWeakResult(above, hybridActive),
      anchor: anchorOf(above),
      unknown_ids: unknown,
      top_mode: above[0]?.mode ?? "(none)",
      // The same `above` the ranks were read off, so a checker re-deriving them
      // is checking the runner rather than a second recording of it.
      top_k: above.map((h) => ({ id: h.id, score: h.score })),
      // On `above`, the SERVED pool, and before anything projects the hop away
      // — C-046 wants the decision taken where the provenance still exists.
      ...(decide ? { gate: gateCase(above, decide(above, c.query), exp, any) } : {}),
      ...(decideNoBody ? { gate_no_body: gateCase(above, decideNoBody(above, c.query), exp, any) } : {}),
      ...(narrow ? { gate_narrowed: narrow(above, c.query, exp, any) } : {}),
    });
  }
  return rows;
}

/**
 * The slice of a scored row the §18.2 report reads (#422).
 *
 * `has_identifier` comes from the GOLD CASE and not from the row: it is a
 * property of the query, the artifact's row shape has never carried it, and the
 * identifier gate is no reason to change that shape for every ungated run too.
 */
const toGateRow = (r: CaseResult, hasIdentifier: (id: string) => boolean): GateRow => ({
  no_answer: r.no_answer,
  ...(r.probe_group ? { probe_group: r.probe_group } : {}),
  has_identifier: hasIdentifier(r.id),
  rank_expected: r.rank_expected,
  ...(r.gate ? { gate: r.gate } : {}),
  ...(r.gate_no_body ? { gate_no_body: r.gate_no_body } : {}),
  ...(r.gate_narrowed ? { gate_narrowed: r.gate_narrowed } : {}),
});

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * §18.1 wants every run citable: code, git, vault, model, config and dataset
 * hash, next to the raw output and the command line. A run whose artifact
 * depends on an uncommitted helper is not reproducible, so this lives here.
 */
function gitState(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return "not-a-git-checkout";
  }
}

function hashCode(): string {
  const here = import.meta.dirname;
  // `goldset-dataset.ts` is in the list because the rules that admit a run's
  // data are part of what the run is cited by — leaving it out when the
  // functions moved there would have quietly narrowed the code hash.
  return sha256(["goldset-run.ts", "goldset-dataset.ts", "goldset.ts"]
    .map((f) => readFileSync(join(here, f), "utf8"))
    .join("\n"));
}

interface Args { gold: string[]; out: string; hybrid: boolean; seed: number; gate: boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = { gold: [], out: "", hybrid: false, seed: 20260828, gate: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--gold") a.gold.push(argv[++i] ?? "");
    else if (f === "--out") a.out = argv[++i] ?? "";
    else if (f === "--hybrid") a.hybrid = true;
    else if (f === "--seed") a.seed = Number(argv[++i]);
    else if (f === "--gate") a.gate = true;
    else throw new Error(`unknown flag: ${f}`);
  }
  if (!a.gold.length) throw new Error("--gold is required (repeatable)");
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vaultPath = process.env.BASTRA_VAULT_PATH;
  if (!vaultPath) throw new Error("BASTRA_VAULT_PATH is required");

  const { cases, sources } = loadGoldFiles(args.gold);

  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  // Without start() the lexical index holds zero documents: BM25 returns
  // nothing, the fusion runs one-armed on vectors, and the run reports itself
  // as hybrid anyway. That is the silent arm fallback the M0 gate forbids, so
  // the document count is asserted below rather than trusted.
  search.start();
  if (search.size() !== vault.size()) {
    throw new Error(`lexical index holds ${search.size()} of ${vault.size()} memories — the BM25 arm would be blind.`);
  }
  const knownIds = new Set(vault.list().map((m) => String(m.fm.id)));
  // A gold id the vault no longer holds is a stale label, and scoring it would
  // report the staleness as a retrieval miss (#432). Stop before the measurement
  // rather than publish a depressed number under a successful exit code.
  const unknown = unknownGoldIds(cases, knownIds);
  if (unknown.length) {
    throw new Error(
      `${unknown.length} gold id(s) are not in the vault — a gate failure, never a miss: ${unknown.join(", ")}`,
    );
  }

  let armLabel = "BM25 only";
  let cleanup: (() => Promise<void>) | null = null;
  let vectors = 0;
  if (args.hybrid) {
    const arm = await attachHybrid(vault, search, vaultPath);
    armLabel = arm.label; vectors = arm.vectors; cleanup = arm.cleanup;
  }

  // Never report BM25 under a hybrid label: the hybrid path is taken only when
  // the vector arm is actually attached, --hybrid aborts above if it is not,
  // and `gatedHybridRecaller` stops the run if the arm goes away mid-set.
  const recaller: Recaller = search.hasEmbeddings()
    ? gatedHybridRecaller((q, o) => search.recallHybrid(q, o))
    : async (q) => search.recall(q, { k: PRODUCTION_K });

  const hybridActive = search.hasEmbeddings();
  // #422: the same call the daemon makes in `http-hook-routes.ts` — the
  // ORIGINAL query terms, the requested scope, the vault for temporal status.
  // Reproducing it rather than paraphrasing it is the whole point: a second
  // reading of the predicate would measure the second reading.
  //
  // The runner writes NO `evidence_decision` event. `decideHits` is pure and
  // logs nothing; the events come from the daemon. That separation keeps the
  // shadow-acceptance count in #422's first checkbox free of gold-set runs.
  //
  // `scope: null` on purpose, and it makes the gated arm STRICTER than a scoped
  // production call: `scope_match` is false for every hit, so one of the three
  // independent signals is unavailable and `required` needs the other two. It
  // is the honest setting here — the runner's own retrieval is unscoped, and
  // crediting a scope match the search never filtered on would report a signal
  // that did no work. Whoever reads the figures should know the direction: with
  // a scope, more hits reach `required`, not fewer.
  const decide = args.gate
    ? (hits: RecallHit[], query: string): ReturnType<typeof decideHits> =>
        decideHits(hits, {
          queryTerms: tokenizeWithIdentifiers(query),
          scope: null,
          memoryOf: (id) => vault.get(id),
        })
    : undefined;
  // The counterfactual: the same call, with the memory's body blanked. That is
  // the ONLY input `hasExactIdentifier` loses — `temporalStatus` reads
  // `obsolete`/`valid_until`, `recallWhenCoverage` reads `recall_when`. So this
  // is the shipped predicate answering "what if the body did not anchor", not a
  // second implementation of it.
  const decideNoBody = args.gate
    ? (hits: RecallHit[], query: string): ReturnType<typeof decideHits> =>
        decideHits(hits, {
          queryTerms: tokenizeWithIdentifiers(query),
          scope: null,
          memoryOf: (id) => {
            const m = vault.get(id);
            return m ? { ...m, body: "" } : undefined;
          },
        })
    : undefined;
  // The narrowings of the two-of-three rule, solo and combined with the anchor
  // variant. Each is re-derived from the SHIPPED evidence of the run it belongs
  // to — `decide` for the solo column, `decideNoBody` for the combined one — and
  // `assertReproducesShipped` stops the run if the re-derivation and
  // `decideHit` ever disagree at the identity rule.
  const narrow = args.gate
    ? (
        served: RecallHit[],
        query: string,
        expected: Set<string>,
        anyIds: Set<string>,
      ): Record<string, CaseGateResult> => {
        const terms = tokenizeWithIdentifiers(query).filter((t) => t.length >= 3);
        const shipped = decideHits(served, {
          queryTerms: tokenizeWithIdentifiers(query),
          scope: null,
          memoryOf: (id) => vault.get(id),
        });
        const noBody = decideHits(served, {
          queryTerms: tokenizeWithIdentifiers(query),
          scope: null,
          memoryOf: (id) => {
            const m = vault.get(id);
            return m ? { ...m, body: "" } : undefined;
          },
        });
        assertReproducesShipped(shipped, served, terms.length);
        const out: Record<string, CaseGateResult> = {};
        for (const [name, rule] of Object.entries(NARROWINGS)) {
          out[name] = gateCaseUnder(served, shipped, expected, anyIds, terms.length, rule);
          out[`${name}+no_body`] = gateCaseUnder(served, noBody, expected, anyIds, terms.length, rule);
        }
        return out;
      }
    : undefined;
  const identifierQueries = new Set(cases.filter((c) => c.has_identifier).map((c) => c.id));
  const started = Date.now();
  const main = await scoreCases(cases, recaller, knownIds, hybridActive, decide, decideNoBody, narrow);
  const mainMs = Date.now() - started;
  const control = await scoreCases(cases, controlRecaller([...knownIds], args.seed), knownIds, false);
  await cleanup?.();

  // Split the set the way §19 asks for it. Probes never enter the denominator.
  const probes = main.filter((r) => r.probe_group);
  const real = main.filter((r) => !r.probe_group);
  const answerable = real.filter((r) => !r.no_answer);
  const noAnswer = real.filter((r) => r.no_answer);
  const ctrlAnswerable = control.filter((r) => !r.probe_group && !r.no_answer);

  const results = {
    // 2: every row carries `top_k`, so the rank determination itself is
    // re-checkable and not only its result (#417). Version 1 artifacts stay
    // valid — they are the ones without the field.
    schema_version: 2,
    run_date: new Date().toISOString(),
    arm: armLabel,
    vectors,
    production_k: PRODUCTION_K,
    score_floor: SCORE_FLOOR,
    seed: args.seed,
    sources,
    counts: {
      cases_in_files: main.length,
      probes: probes.length,
      main_denominator: real.length,
      answerable: answerable.length,
      no_answer: noAnswer.length,
    },
    unknown_gold_ids: [...new Set(real.flatMap((r) => r.unknown_ids))],
    answerable: metricsFor(answerable),
    control_arm: metricsFor(ctrlAnswerable),
    by_kind: groupBy(answerable, (r) => r.kind),
    by_zone: groupBy(answerable, (r) => r.zone),
    by_origin: groupBy(answerable, (r) => r.origin),
    by_lang: groupBy(answerable, (r) => r.lang),
    probe_arm: {
      by_group: groupBy(probes, (r) => r.probe_group ?? "-"),
      abstained: probes.filter((r) => r.abstained).length,
      n: probes.length,
    },
    abstention: {
      // Raw counts. No tolerance verdict here — M1 owns that (§18.2).
      no_answer_cases: noAnswer.length,
      correctly_abstained: noAnswer.filter((r) => r.abstained).length,
      answered_anyway: noAnswer.filter((r) => !r.abstained).length,
      answerable_cases: answerable.length,
      false_abstention: answerable.filter((r) => r.abstained).length,
      relevant_loss: answerable.filter((r) => r.rank_expected === 0).length,
    },
    arm_modes: main.reduce<Record<string, number>>((a, r) => {
      a[r.top_mode] = (a[r.top_mode] ?? 0) + 1;
      return a;
    }, {}),
    duration_ms: { main_arm: mainMs },
    ...(args.gate
      ? { component_gates: gateVariants(main.map((r) => toGateRow(r, (id) => identifierQueries.has(id)))) }
      : {}),
    rows: main,
  };

  const manifest = {
    run_date: results.run_date,
    /**
     * Whether this artifact is a measurement or test debris (#420).
     *
     * Suite passes used to write real directories into `~/.bastra/eval-runs`
     * beside the registered baselines; `scripts/test-env.mjs` now redirects them
     * to a tmpdir. This field is the second line of defence: a later cleanup can
     * tell the two apart from the artifact itself rather than from where it
     * happens to sit, so it can never sweep away evidence a release condition
     * cites by path.
     */
    run_kind: process.env.NODE_TEST_CONTEXT ? "test" : "measurement",
    vault_path: vaultPath,
    vault_size: vault.size(),
    provider: armLabel,
    command: `BASTRA_VAULT_PATH=<vault> npx tsx src/goldset-run.ts ${process.argv.slice(2).join(" ")}`,
    seed: args.seed,
    hashes: {
      code: hashCode(),
      git: gitState(),
      vault: sha256(vault.list().map((m) => `${String(m.fm.id)} ${String(m.fm.updated ?? "")}`).sort().join("\n")),
      model: sha256(armLabel),
      config: sha256(JSON.stringify({ k: PRODUCTION_K, floor: SCORE_FLOOR, hybrid: args.hybrid })),
      dataset: datasetHash(sources, cases),
    },
  };
  const day = manifest.run_date.slice(0, 10);
  const short = sha256(JSON.stringify(manifest.hashes) + manifest.run_date).slice(0, 12);
  const dir = join(process.env.BASTRA_EVAL_RUNS_DIR ?? join(homedir(), ".bastra", "eval-runs"), `${day}-${short}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const lines = [
    `[goldset-run] ${real.length} cases (+${probes.length} probes) · arm: ${armLabel}`,
    `[goldset-run] answerable: ${JSON.stringify(results.answerable)}`,
    `[goldset-run] control:    ${JSON.stringify(results.control_arm)}`,
    `[goldset-run] abstention: ${JSON.stringify(results.abstention)}`,
  ];
  for (const l of lines) console.error(l);

  const w = (name: string, body: string): void =>
    writeFileSync(join(dir, name), body, { mode: 0o600 });
  w("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  w("results.json", JSON.stringify(results, null, 2) + "\n");
  w("stdout.txt", "");
  w("stderr.txt", lines.join("\n") + "\n");
  w("command.txt", manifest.command + "\n");
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
  }
  console.error(`[goldset-run] run artifact: ${dir}`);
}

if (import.meta.filename === process.argv[1]) {
  main().catch((e: Error) => {
    console.error(`[goldset-run] FATAL: ${e.message}`);
    process.exit(1);
  });
}
