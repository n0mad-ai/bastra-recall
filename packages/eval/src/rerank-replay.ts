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
 * recommendation. The pre-registration — primary endpoint, free parameters,
 * slices and the bar each recommendation shape has to clear — is
 * `docs/design/2026-09-09-501-cross-encoder-rerank-messplan.md` and
 * `registrations/rerank-decision.json`, both fixed before the first number.
 *
 * ── Nothing is reimplemented ───────────────────────────────────────────────
 * Retrieval is the production `SearchIndex.recallHybrid` behind
 * `gatedHybridRecaller`, the same gate `goldset-run.ts` uses: a case whose
 * dense arm fell back to BM25 stops the run instead of entering the
 * denominator. That path is not hypothetical — `recallHybrid` fires
 * `onCandidatePool` from the BM25 fallback too (`search.ts:840`), with raw
 * BM25 scores in BM25 order, and an ungated replay would have counted those
 * rows as hybrid.
 *
 * The rerank window comes from `opts.onCandidatePool` (#121, `search.ts:1226`):
 * the damped, pre-`slice(k)` pool, in the same order and on the same score
 * scale as the served hits. That is why this measurement needs no production
 * change at all. At `PRODUCTION_K = 10` the pool is `max(k*4, 20)` = 40 deep,
 * so N up to 30 is measurable without moving a shipped constant.
 *
 * ── The score floor is part of the measurement ─────────────────────────────
 * Production serves `slice(0, k)` and drops everything under `SCORE_FLOOR`.
 * Rank is therefore measured AFTER both, in that order (`rerank-report.ts`).
 * The floor-free number rides along as an explicitly named upper bound.
 *
 * ── One scoring pass covers every N ────────────────────────────────────────
 * `rerankWindow(pool, 10, …)` only consults the scores of the first ten
 * candidates, so the model scores the top `max(N)` once per (case, model,
 * passage mode) and every smaller N is DERIVED from those scores. The
 * derivation is exact and pinned by a test. The scores themselves are not
 * exact by construction: batches are padded to the longest sequence and ONNX
 * Runtime guarantees no batch invariance — mathematically the attention mask
 * makes padding neutral, in floating point it is the last bits. Batch
 * invariance is CHECKED, not assumed (`--check-batch-invariance`). For the
 * same reason the latency pass and the quality pass do not score bit-identical
 * values: they use different batch sizes on purpose, and a small discrepancy
 * between them is expected rather than a bug.
 *
 * ── Run ────────────────────────────────────────────────────────────────────
 *   BASTRA_VAULT_PATH=/path/to/vault npm run rerank-replay --workspace=@bastra-recall/eval -- \
 *     --gold ~/.bastra/eval-goldset/gold-blind.json \
 *     --models en-de,bge --out /tmp/rerank-501.json
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SearchIndex, Vault, isWeakResult } from "@bastra-recall/core";
import type { Memory, RecallHit, RecallStage } from "@bastra-recall/core";
import { loadGoldFiles } from "./goldset-dataset.js";
import type { GoldCase } from "./goldset.js";
import { PRODUCTION_K, SCORE_FLOOR, attachHybrid, gatedHybridRecaller } from "./goldset-run.js";
import {
  MODELS,
  assertLanguagesAllowed,
  loadCrossEncoder,
  passageFor,
  type PairScorer,
  type PassageMode,
} from "./rerank-model.js";
import { rerankWindow } from "./rerank-metrics.js";
import {
  assignPoolBuckets,
  countIntervals,
  noAnswerGuard,
  reportArm,
  served,
  type ArmRanking,
  type ArmReport,
  type CaseRow,
} from "./rerank-report.js";
import { measureLatency, type LatencyReport } from "./rerank-latency.js";

/** Registered in `registrations/rerank-decision.json`; #501 names the three. */
export const NS = [10, 20, 30] as const;
const PASSAGE_MODES: readonly PassageMode[] = ["short", "body"];

/**
 * The single cell that carries the recommendation. Everything else describes.
 *
 * A full run produces 180 confidence intervals. At α=0.05 several of them are
 * "significant" under pure noise, so a run without ONE designated endpoint
 * cannot conclude anything — whichever cell happened to come out well would be
 * the finding. This cell is fixed here, in code, before any data exists.
 *
 * Why this cell and not a better-looking one: N=10 with the short passage is
 * the only combination that can pass the latency bar at all (26 ms p50 in the
 * spike; `short`/N=20 already sits at 52 ms against a 50 ms threshold). A lift
 * that appears only at N=30 or on the long passage is unaffordable regardless
 * of its size, so the primary test belongs where the decision is actually made.
 */
export const PRIMARY = { model: "en-de", passage: "short" as PassageMode, n: 10, cut: "r@3" } as const;

interface Args {
  gold: string[];
  models: string[];
  out: string | null;
  limit: number | null;
  latency: boolean;
  latencySample: number;
  checkBatchInvariance: boolean;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    gold: [],
    models: ["en-de"],
    out: null,
    limit: null,
    latency: false,
    latencySample: 40,
    checkBatchInvariance: false,
    seed: 20260909,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--gold") a.gold.push(argv[++i]);
    else if (f === "--models") a.models = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (f === "--out") a.out = argv[++i];
    else if (f === "--limit") a.limit = Number(argv[++i]);
    else if (f === "--latency") a.latency = true;
    else if (f === "--latency-sample") a.latencySample = Number(argv[++i]);
    // Kept as an accepted no-op: the check is unconditional now, because its
    // result decides how the arm is scored rather than only what is reported.
    else if (f === "--check-batch-invariance") a.checkBatchInvariance = true;
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
 * The cases this run scores, in three buckets that must add up.
 *
 * Probes are diagnostics, not questions anyone asked, and are excluded from
 * every other main denominator too. `no_answer` cases leave the LIFT
 * denominator but are not discarded — they are the guard. `malformed` is the
 * third category: a case claiming an answer while naming no id would otherwise
 * vanish between the first two filters, and the run would report a smaller
 * denominator than the file holds without saying so. Today it is empty; the
 * point is that it cannot stop being empty in silence.
 */
export function partitionCases(cases: readonly GoldCase[]): {
  answerable: GoldCase[];
  noAnswer: GoldCase[];
  malformed: GoldCase[];
  probes: number;
} {
  const nonProbe = cases.filter((c) => !c.probe_group);
  const answerable: GoldCase[] = [];
  const noAnswer: GoldCase[] = [];
  const malformed: GoldCase[] = [];
  for (const c of nonProbe) {
    if (c.no_answer) noAnswer.push(c);
    else if (c.expected_ids.length === 0) malformed.push(c);
    else answerable.push(c);
  }
  return { answerable, noAnswer, malformed, probes: cases.length - nonProbe.length };
}

/**
 * What the vault WAS when this run measured it.
 *
 * The reason is a real incident, not tidiness: two runs of this harness over
 * "the same" gold set produced `recall_any@30` = 397/584 and 398/584. The
 * primary number was bit-identical and retrieval proved deterministic on a
 * fixed vault (100 cases retrieved twice in one process, 100/100 identical
 * pools including scores) — but two memories had been written BETWEEN the runs,
 * by the very session that was running them. Two extra documents move the BM25
 * document frequencies for every term, so a gold at rank 31 can land at 30.
 *
 * #500's determinism holds to the sixteenth decimal because LongMemEval's
 * corpus is a frozen file. Ours is a live vault. A determinism check over the
 * gold set can therefore only prove "same vault, same result" — never "same
 * number tomorrow", and the artifact has to say which vault it saw.
 *
 * The hash covers ids AND `updated`, so an edit to an existing memory changes
 * it too; a count alone would only catch growth. Nothing vault-derived travels
 * beyond the digest.
 */
export function vaultFingerprint(vault: Vault): { size: number; ids_updated_sha256: string } {
  const lines = vault
    .list()
    .map((m) => `${String(m.fm.id)}\t${String((m.fm as { updated?: string }).updated ?? "")}`)
    .sort();
  return {
    size: vault.size(),
    ids_updated_sha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
}

/** Telemetry the latency protocol's discard rule needs, per case. */
export interface ArmHealth {
  vector_timeouts: number;
  vector_errors: number;
  wait_ms: number[];
  cases: number;
}

/**
 * Retrieve every case through the gated production path.
 *
 * Two things ride on the `onStage` listener, and neither is decoration:
 * `gatedHybridRecaller` reads `done.degraded` and refuses a BM25 row in a
 * hybrid denominator, and the latency protocol's discard rule needs
 * `wait_ms` / `timed_out` — a rule nobody can apply without the numbers.
 */
async function collectPools(
  search: SearchIndex,
  cases: readonly GoldCase[],
  knownIds: Set<string>,
  label: string,
): Promise<{ rows: CaseRow[]; health: ArmHealth }> {
  const rows: CaseRow[] = [];
  const health: ArmHealth = { vector_timeouts: 0, vector_errors: 0, wait_ms: [], cases: cases.length };
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    // A gold id the vault no longer holds is a stale label, and scoring it
    // would report the staleness as a retrieval miss (#432). Checked HERE, per
    // case, so the run dies in the first seconds rather than after a full
    // Ollama pass — the failure is a property of the files, not of the run.
    for (const id of [...c.expected_ids, ...c.acceptable_alternatives]) {
      if (!knownIds.has(id)) {
        throw new Error(`case ${c.id}: gold id ${id} is not in the vault — a stale label, never a miss`);
      }
    }
    let pool: RecallHit[] = [];
    const recall = gatedHybridRecaller((q, o) =>
      search.recallHybrid(q, {
        ...o,
        onStage: (s: RecallStage) => {
          o.onStage(s);
          if (s.name !== "vector.search" || s.durationMs === undefined) return;
          if (s.meta?.timed_out === true) health.vector_timeouts++;
          if (s.meta?.provider_outcome === "error") health.vector_errors++;
          if (typeof s.meta?.wait_ms === "number") health.wait_ms.push(s.meta.wait_ms);
        },
        onCandidatePool: (p) => {
          pool = p;
        },
      }),
    );
    const hits = await recall(c.query, c.id);
    rows.push({
      id: c.id,
      query: c.query,
      lang: c.lang,
      kind: c.kind,
      expected: new Set(c.expected_ids),
      expectedAny: new Set([...c.expected_ids, ...c.acceptable_alternatives]),
      baseline: pool,
      poolSize: pool.length,
      weakResult: isWeakResult(hits, true),
    });
    if ((i + 1) % 25 === 0) process.stderr.write(`\r[${label}] retrieved ${i + 1}/${cases.length}`);
  }
  process.stderr.write(`\r[${label}] retrieved ${cases.length}/${cases.length}\n`);
  return { rows, health };
}

/**
 * Score one arm over every case, once, at the deepest N.
 *
 * Exported so a stub scorer can drive the real function in tests. The previous
 * version tested a hand-inlined copy of this loop, which is exactly the shape
 * where an off-by-one in the score index survives a green suite.
 */
export async function rankArm(
  scorer: PairScorer,
  mode: PassageMode,
  rows: readonly CaseRow[],
  memoryOf: (id: string) => Memory | undefined,
  label: string,
  ns: readonly number[] = NS,
): Promise<Map<string, ArmRanking>> {
  const deepest = Math.max(...ns);
  const out = new Map<string, ArmRanking>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const window = row.baseline.slice(0, deepest);
    const passages = window.map((h) => {
      const m = memoryOf(h.id);
      if (!m) throw new Error(`pooled id ${h.id} is not in the vault — refusing to score an empty passage`);
      return passageFor(m, mode);
    });
    const scores = await scorer.score(row.query, passages);
    const ranking: ArmRanking = {};
    for (const n of ns) ranking[n] = rerankWindow(row.baseline, n, (_h, j) => scores[j] ?? -Infinity);
    out.set(row.id, ranking);
    // An empty label means "caller drives its own progress": the LongMemEval
    // pass calls this once per question, and a line per call would be 1000
    // lines of noise around three numbers.
    if (label && (i + 1) % 25 === 0) process.stderr.write(`\r[${label}] scored ${i + 1}/${rows.length}`);
  }
  if (label) process.stderr.write(`\r[${label}] scored ${rows.length}/${rows.length}\n`);
  return out;
}

/**
 * Does a batch of 30 score its first ten pairs like a batch of 10?
 *
 * The whole "one pass covers every N" claim rests on this, and it is not
 * guaranteed: padding to the longest sequence can change kernel paths and
 * reduction order. If the ORDER of the first ten differs, the efficiency is
 * gone and each N must be scored separately — that is the price, not a reason
 * to keep the assumption.
 */
export async function checkBatchInvariance(
  scorer: PairScorer,
  mode: PassageMode,
  row: CaseRow,
  memoryOf: (id: string) => Memory | undefined,
): Promise<{ maxAbsDelta: number; orderStable: boolean }> {
  const passages = (k: number): string[] =>
    row.baseline.slice(0, k).map((h) => {
      const m = memoryOf(h.id);
      if (!m) throw new Error(`pooled id ${h.id} is not in the vault`);
      return passageFor(m, mode);
    });
  const deep = await scorer.score(row.query, passages(30));
  const shallow = await scorer.score(row.query, passages(10));
  let maxAbsDelta = 0;
  for (let i = 0; i < shallow.length; i++) maxAbsDelta = Math.max(maxAbsDelta, Math.abs(deep[i] - shallow[i]));
  const orderOf = (s: number[]): string =>
    s.map((v, i) => [v, i] as const).sort((a, b) => (b[0] - a[0]) || (a[1] - b[1])).map(([, i]) => i).join(",");
  return { maxAbsDelta, orderStable: orderOf(deep.slice(0, 10)) === orderOf(shallow) };
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
  if (part.malformed.length > 0) {
    throw new Error(
      `${part.malformed.length} case(s) claim an answer but name no expected id: ` +
        `${part.malformed.map((c) => c.id).join(", ")}`,
    );
  }
  // B1 guard FIRST, on the UNLIMITED set. Run after `--limit` it would see
  // only the surviving cases, and a small limit on a neutral-heavy file could
  // let an English-only model through on a German set. Smoke tests only, but
  // the ordering costs nothing.
  const langs = new Set([...part.answerable, ...part.noAnswer].map((c) => c.lang));
  for (const m of args.models) assertLanguagesAllowed(MODELS[m], langs);

  let answerable = part.answerable;
  let guardCases = part.noAnswer;
  if (args.limit !== null) {
    // The guard is cut proportionally, not left at full size: a --limit run
    // that scores 20 answerable cases against all 79 guard cases spends most
    // of its time on the smoke test's least interesting half.
    answerable = answerable.slice(0, args.limit);
    guardCases = guardCases.slice(0, Math.max(1, Math.round(args.limit * (part.noAnswer.length / Math.max(1, part.answerable.length)))));
  }

  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  if (search.size() !== vault.size()) {
    throw new Error(`lexical index holds ${search.size()} of ${vault.size()} memories — the BM25 arm would be blind.`);
  }
  const knownIds = new Set(vault.list().map((m) => String(m.fm.id)));
  // The dense arm is not optional: #501 asks what a reranker adds ON TOP of the
  // shipped hybrid ranking. Measured over a BM25-only pool it would answer a
  // question nobody asked.
  const arm = await attachHybrid(vault, search, vaultPath);
  console.error(`[rerank-replay] ${arm.label}`);
  console.error(
    `[rerank-replay] ${answerable.length} answerable · ${guardCases.length} no_answer guard · ` +
      `${part.probes} probes excluded · floor ${SCORE_FLOOR} · serve k=${PRODUCTION_K} · sources ${JSON.stringify(sources)}`,
  );

  const main = await collectPools(search, answerable, knownIds, "answerable");
  const guard = await collectPools(search, guardCases, knownIds, "no_answer");
  const rows = main.rows;
  const guardRows = guard.rows;
  // The cap the pool cannot exceed: HOP_SEED_POOL = max(k*4, 20) in
  // `recallHybrid`. Derived from PRODUCTION_K so it cannot drift from it.
  const POOL_CAP = Math.max(PRODUCTION_K * 4, 20);
  const poolSplit = assignPoolBuckets(rows, POOL_CAP);
  console.error(
    `[rerank-replay] pool-size median ${poolSplit.median} (cap ${POOL_CAP}) — small ${poolSplit.small} / large ${poolSplit.large}`,
  );
  if (poolSplit.degenerate) {
    console.error(`[rerank-replay] WARNING: by_pool is NOT evaluable — ${poolSplit.degenerate}`);
  }

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
  const invariance: Record<string, Awaited<ReturnType<typeof checkBatchInvariance>>> = {};
  for (const modelKey of args.models) {
    const scorer = await loadCrossEncoder(modelKey);
    console.error(`[rerank-replay] ${scorer.id} loaded in ${scorer.loadMs} ms`);
    // The latency pass runs FIRST on a fresh scorer, so its first sample is a
    // genuine cold call rather than a session warmed by hundreds of batches.
    if (args.latency) {
      const state = { scoredAnything: false };
      const sample = rows.slice(0, args.latencySample);
      for (const mode of PASSAGE_MODES) {
        latency.push(...(await measureLatency(scorer, mode, sample, (id) => vault.get(id), modelKey, NS, state)));
      }
    }
    // Batch invariance is CHECKED, not assumed — and when it fails the harness
    // does not footnote it, it stops taking the shortcut. `bge-reranker-base`
    // fails it (max |Δlogit| 0.28-0.39, order NOT stable) while the main arm
    // `en-de` is exactly 0. So for bge every N gets its own scoring pass at its
    // own batch size, which is what a production stage at that N would do; the
    // deep pass would otherwise have reported "rerank the top 10 using scores
    // computed in a batch of 30", a procedure nobody would ship.
    for (const mode of PASSAGE_MODES) {
      if (rows.length > 0) {
        invariance[`${modelKey}/${mode}`] = await checkBatchInvariance(scorer, mode, rows[0], (id) => vault.get(id));
      }
    }
    const stable = PASSAGE_MODES.every((m) => invariance[`${modelKey}/${m}`]?.orderStable !== false);
    if (!stable) {
      console.error(
        `[rerank-replay] ${modelKey}: batch invariance FAILED — scoring each N separately (costs more, and is the only correct option)`,
      );
    }
    const rankFor = async (
      mode: PassageMode,
      subject: readonly CaseRow[],
      label: string,
    ): Promise<Map<string, ArmRanking>> => {
      if (stable) return rankArm(scorer, mode, subject, (id) => vault.get(id), label);
      const merged = new Map<string, ArmRanking>();
      for (const n of NS) {
        const part = await rankArm(scorer, mode, subject, (id) => vault.get(id), `${label} N=${n}`, [n]);
        for (const [id, r] of part) merged.set(id, { ...(merged.get(id) ?? {}), ...r });
      }
      return merged;
    };
    for (const mode of PASSAGE_MODES) {
      const label = `${modelKey}/${mode}`;
      const rankings = await rankFor(mode, rows, label);
      const guardRankings = await rankFor(mode, guardRows, `${label} guard`);
      for (const n of NS) {
        reports.push(
          reportArm({
            model: modelKey,
            passage: mode,
            n,
            primary: modelKey === PRIMARY.model && mode === PRIMARY.passage && n === PRIMARY.n,
            rows,
            rankings,
            floor: SCORE_FLOOR,
            serveK: PRODUCTION_K,
            seed: args.seed,
            poolSplit,
          }),
        );
        guards[`${label}/N=${n}`] = noAnswerGuard(guardRows, guardRankings, n, PRODUCTION_K, SCORE_FLOOR);
      }
    }
    scorer.close();
  }

  const primary = reports.find((r) => r.primary);
  const L: string[] = [];
  L.push("");
  L.push(`  #501 — query-time cross-encoder rerank · ${rows.length} answerable gold cases`);
  L.push("  M4 Pro — the FAST side of the hardware tiers. Every latency figure is a LOWER BOUND.");
  L.push(`  Served k=${PRODUCTION_K}, score floor ${SCORE_FLOOR} — the production order, applied before measuring.`);
  L.push("");
  if (primary) {
    const c = primary.at[PRIMARY.cut];
    L.push(`  PRIMARY ENDPOINT — ${PRIMARY.model}/${PRIMARY.passage}, N=${PRIMARY.n}, ${PRIMARY.cut}. This cell alone carries a recommendation.`);
    L.push(
      `    baseline ${pct(c.baseline)} → reranked ${pct(c.reranked)} · Δ ${pp(c.paired.delta)} pp · ` +
        `CI95 [${pp(c.paired.ci95[0])}, ${pp(c.paired.ci95[1])}] · p ${c.paired.p.toFixed(4)} · ` +
        `better ${c.paired.better} / worse ${c.paired.worse} / unchanged ${c.paired.unchanged}`,
    );
    L.push(`    rank regression ${pct(primary.rank_regression_share)} · recall_any@${primary.n} ${pct(primary.recall_any_at_n)}`);
    const ip = primary.in_pool_only;
    if (ip.at) {
      const d = ip.at[PRIMARY.cut];
      L.push(
        `    EXPLORATORY, same arm over the ${ip.n} cases whose gold is inside the window at all: ` +
          `Δ ${pp(d.delta)} pp · CI95 [${pp(d.ci95[0])}, ${pp(d.ci95[1])}] — the dilution check, not the endpoint`,
      );
    }
    for (const [k, sl] of Object.entries(primary.by_kind)) {
      const d = sl.at?.[PRIMARY.cut];
      L.push(`    by kind · ${k.padEnd(12)} n=${String(sl.n).padStart(3)} ${d ? `Δ ${pp(d.delta)} pp · CI95 [${pp(d.ci95[0])}, ${pp(d.ci95[1])}]` : (sl.not_evaluable ?? "")}`);
    }
  } else {
    L.push("  PRIMARY ENDPOINT NOT MEASURED — the registered cell is not among the arms this run scored.");
  }
  L.push("");
  L.push(`  EXPLORATORY — ${countIntervals(reports)} confidence intervals in this run. At α=0.05 several are`);
  L.push("  \"significant\" under pure noise. This table describes; it does not decide.");
  L.push(`  ${"model/passage".padEnd(16)} | ${"N".padStart(3)} | ${"R@3".padStart(7)} | ${"ΔR@3".padStart(6)} | ${"95% CI".padStart(15)} | ${"ΔR@5".padStart(6)} | any@N | regr`);
  for (const r of reports) {
    const c3 = r.at["r@3"].paired.ci95;
    L.push(
      `  ${`${r.model}/${r.passage}`.padEnd(16)}${r.primary ? "*" : " "}| ${String(r.n).padStart(3)} | ` +
        `${pct(r.at["r@3"].reranked).padStart(7)} | ${pp(r.at["r@3"].paired.delta).padStart(6)} | ` +
        `${`[${pp(c3[0])}, ${pp(c3[1])}]`.padStart(15)} | ${pp(r.at["r@5"].paired.delta).padStart(6)} | ` +
        `${pct(r.recall_any_at_n)} | ${pct(r.rank_regression_share)}`,
    );
  }
  L.push("");
  L.push("  no_answer guard — a top-1 change here is NOT harm (there is no right answer);");
  L.push("  it measures only whether the rerank reorders that subset systematically.");
  for (const [key, g] of Object.entries(guards)) {
    L.push(`    ${key.padEnd(24)} top-1 changed on ${g.top1_changed}/${g.n_cases} (${pct(g.share)})`);
  }
  if (latency.length) {
    L.push("");
    L.push("  added latency — M4 Pro, lower bound, direct span (NOT a difference: contention is not cancelled).");
    for (const l of latency) {
      L.push(
        `    ${`${l.model}/${l.passage}`.padEnd(16)} | N=${String(l.n).padStart(2)} | ` +
          `p50 ${l.warm_p50_ms.toFixed(1)} ms | p95 ${l.warm_p95_ms.toFixed(1)} ms | ` +
          `first ${l.first_call_ms.toFixed(1)} ms${l.first_call_is_cold ? " (cold)" : ""} | n=${l.samples}`,
      );
    }
    L.push(`    model load: ${latency[0].load_ms} ms — a prewarm-lane cost (#361), not a recall cost.`);
  }
  L.push("");
  if (poolSplit.degenerate) {
    L.push(`  by_pool NOT EVALUABLE — ${poolSplit.degenerate}`);
    L.push("  The 'above pool size' recommendation shape cannot be decided from this run.");
    L.push("");
  }
  const totalCases = main.health.cases + guard.health.cases;
  L.push(
    `  dense-arm health — ${main.health.vector_timeouts + guard.health.vector_timeouts} timeout(s), ` +
      `${main.health.vector_errors + guard.health.vector_errors} error(s) over ${totalCases} recalls. ` +
      "A run with a conspicuous timeout rate is DISCARDED, not interpreted.",
  );
  if (Object.keys(invariance).length) {
    L.push("");
    for (const [k, v] of Object.entries(invariance)) {
      L.push(`  batch invariance ${k}: max |Δlogit| ${v.maxAbsDelta.toExponential(2)}, order stable: ${v.orderStable}`);
    }
  }
  L.push("");
  console.log(L.join("\n"));

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          issue: 501,
          registration: "packages/eval/registrations/rerank-decision.json",
          registration_version: 2,
          hardware: "Apple M4 Pro — fast side of the tiers; latency figures are LOWER BOUNDS",
          arm_label: arm.label,
          vault: vaultFingerprint(vault),
          primary_endpoint: PRIMARY,
          production_k: PRODUCTION_K,
          score_floor: SCORE_FLOOR,
          pool_split: poolSplit,
          cases: {
            answerable: rows.length,
            no_answer: guardRows.length,
            probes_excluded: part.probes,
            malformed: part.malformed.length,
            sources,
          },
          dense_arm_health: { main: main.health, guard: guard.health },
          // Per-case baseline diagnostics. Cheap, and the reason it is here:
          // tonight the run had to be repeated because the artifact carried
          // aggregates only and a new slice (by kind) could not be computed
          // from it. Rows travel so the next question does not cost a re-run.
          cases_baseline: rows.map((r) => ({
            id: r.id,
            lang: r.lang,
            kind: r.kind,
            pool_size: r.poolSize,
            weak_result: r.weakResult,
            rank_in_pool: r.baseline.findIndex((h) => r.expected.has(h.id)) + 1,
            served_rank: served(r.baseline, PRODUCTION_K, SCORE_FLOOR).findIndex((id) => r.expected.has(id)) + 1,
          })),
          interval_count: countIntervals(reports),
          reports,
          no_answer_guard: guards,
          latency,
          batch_invariance: invariance,
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

export { served };

if (import.meta.filename === process.argv[1]) {
  main().catch((e: Error) => {
    console.error(`[rerank-replay] FATAL: ${e.message}`);
    process.exit(1);
  });
}
