#!/usr/bin/env tsx
/**
 * Simulated-user survival — recall_when lift under realistic query drift (#89).
 *
 * `marginal-lift.ts` answers "does the trigger field help?" with one paraphrase
 * set. This harness asks the sharper, production-shaped question on the SAME
 * control/treatment indexes:
 *
 *   recall_when is written at SAVE time — a prediction of how a future session
 *   will phrase the situation. The query is formed at RECALL time, in that
 *   session's own words. How much of the trigger's lift SURVIVES when the
 *   recall-time query drifts away from the save-time prediction?
 *
 * We model the recall-time query distribution with N simulated user personas
 * (junior/senior/terse/verbose/non-native/…), each phrasing every memory in
 * their own voice. Every query gets a continuous overlap score against the
 * gold memory's recall_when tokens, then we split:
 *
 *   near  = query shares trigger vocabulary (overlap ≥ cut)   — prediction hit
 *   far   = query uses different words (overlap < cut)        — prediction missed
 *   survival = marginal-lift@k(far) / marginal-lift@k(near)
 *
 * survival ≈ 1  -> recall_when generalizes past its own wording (load-bearing).
 * survival ≈ 0  -> the trigger only helps when you already used its words
 *                  (the lift is closer to the circular M0 regime than to real recall).
 *
 * Two integrity guards keep the envelope honest (see __tests__):
 *   - persona DIVERSITY: the N personas must be genuinely distinct voices, not
 *     one voice in N masks (mode collapse would fake a tight envelope).
 *   - overlap SPREAD: diverse users naturally span near↔far, so the gradient is
 *     emergent, not hand-binned.
 *
 * Why simulated, not hand-written paraphrases? In production NOBODY hand-writes
 * the memories (the AI saves them) OR hand-phrases the recall query (the AI
 * forms it). Both ends are model-mediated, so simulated queries are the
 * ecologically faithful test. The default retriever is lexical BM25 (no
 * embedding space), so the only contamination risk is trigger-vocabulary
 * leakage — which the overlap score measures directly. See README.
 *
 * ── THREE ARMS (#103) — attribute the far-null to the right missing lever ──
 * `--arms lexical,hybrid,expanded` runs up to three control/treatment pairs
 * over the same persona queries. Every control strips BOTH trigger fields
 * (recall_when AND recall_when_expanded); the arms differ ONLY in what the
 * treatment adds back:
 *
 *   lexical  : BM25, treatment indexes recall_when at ×boost — the original
 *              harness (default; exact legacy behavior + output).
 *   hybrid   : production `recallHybrid` (BM25 + Ollama dense leg + RRF).
 *              Control strips recall_when from BOTH legs — see hybrid-arm.ts.
 *              Needs a reachable Ollama (BASTRA_OLLAMA_URL /
 *              BASTRA_EMBEDDING_MODEL / BASTRA_EMBEDDING_DIM /
 *              BASTRA_OLLAMA_KEEP_ALIVE, same envs doc2query-lift uses).
 *   expanded : BM25, treatment ADDITIONALLY indexes the #117 write-time
 *              expansions (recall_when_expanded) at the production ×2 boost.
 *
 * ── FAR-SPLIT (#103, per @zzallirog discussion #105) ──
 * Every far query is also classified by WHERE the gold sat: `in-pool` (anywhere
 * in the first-stage candidate pool — retrieved but possibly mis-ranked, a
 * precision problem) vs `not-retrieved` (a recall-bound miss, the case an
 * index-side lever must fix). Both slices are reported per arm together with a
 * precision signal (mean gold rank among in-pool fars) so the two failure modes
 * don't average into one number.
 *
 * IMPORTANT — read before citing a number:
 *   The bundled `fixtures/personas.json` runs against the tiny SYNTHETIC
 *   eval-vault. It proves the harness computes; it is NOT a headline result.
 *   A citable survival number comes from a real vault:
 *     BASTRA_VAULT_PATH=/path npm run personas -- --personas my-personas.json
 *
 * Usage:
 *   npm run personas                          # bundled synthetic vault + personas
 *   npm run personas -- --k 3 --near 0.30     # tune @k and the near/far cut
 *   npm run personas -- --arms lexical,hybrid,expanded   # three-arm (#103)
 *   npm run personas -- --pool 100            # sweep first-stage pool depth (#118)
 *   BASTRA_VAULT_PATH=/v npm run personas -- --personas p.json --out survival.json
 *
 * Exit code: 0 always (a measurement, not a pass/fail gate).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Vault } from "@bastra-recall/core";
import type { Memory, RecallHit, SearchIndex } from "@bastra-recall/core";
import { buildIndex, rankOf, TREATMENT_RECALL_WHEN_BOOST, EXPANDED_RECALL_WHEN_BOOST } from "./index-config.js";
import { buildHybridArmPair } from "./hybrid-arm.js";

// ── Persona fixtures ───────────────────────────────────────────

interface PersonaFile {
  /** label -> (memory id -> the query that persona would type for it). */
  personas: Record<string, Record<string, string>>;
}

// ── CLI ────────────────────────────────────────────────────────

const ARM_NAMES = ["lexical", "hybrid", "expanded"] as const;
type ArmName = (typeof ARM_NAMES)[number];

interface Args {
  vault: string;
  personas: string;
  out: string | null;
  boost: number;
  k: number;
  near: number;
  arms: ArmName[];
  /** First-stage pool depth; null = core's default max(k·4, 20) (#118). */
  pool: number | null;
}

const DEFAULT_VAULT = resolve(import.meta.dirname, "../fixtures/eval-vault");
const DEFAULT_PERSONAS = resolve(import.meta.dirname, "../fixtures/personas.json");

function parseArgs(argv: string[]): Args {
  const args: Args = {
    vault: process.env.BASTRA_VAULT_PATH ?? DEFAULT_VAULT,
    personas: DEFAULT_PERSONAS,
    out: null,
    boost: TREATMENT_RECALL_WHEN_BOOST,
    k: 3,
    near: 0.3,
    arms: ["lexical"],
    pool: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault") args.vault = req(argv[++i], "--vault");
    else if (a === "--personas") args.personas = req(argv[++i], "--personas");
    else if (a === "--out") args.out = req(argv[++i], "--out");
    else if (a === "--boost") args.boost = num(argv[++i], "--boost");
    else if (a === "--k") args.k = num(argv[++i], "--k");
    else if (a === "--near") args.near = num(argv[++i], "--near");
    else if (a === "--arms") args.arms = parseArms(req(argv[++i], "--arms"));
    else if (a === "--pool") args.pool = poolNum(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log(
        "persona-lift — simulated-user survival of recall_when\n" +
          "  --vault <path>     vault to index (or BASTRA_VAULT_PATH)\n" +
          "  --personas <path>  personas JSON ({personas:{label:{id:query}}})\n" +
          "  --arms <list>      comma list of lexical,hybrid,expanded (default: lexical;\n" +
          "                     hybrid needs a reachable Ollama, see BASTRA_OLLAMA_URL)\n" +
          "  --boost <n>        treatment recall_when weight (default 5; lexical/expanded\n" +
          "                     arms only — hybrid always runs production weights)\n" +
          "  --k <n>            Recall@k (default 3)\n" +
          "  --pool <n>         first-stage candidate-pool depth (#118; default max(k·4, 20),\n" +
          "                     i.e. core's HOP_SEED_POOL — only moves the far in-pool/\n" +
          "                     not-retrieved split, R@k is unaffected without a reranker)\n" +
          "  --near <0..1>      query↔trigger overlap cut for near/far (default 0.30)\n" +
          "  --out <path>       also write a JSON report"
      );
      process.exit(0);
    } else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function parseArms(spec: string): ArmName[] {
  const out: ArmName[] = [];
  for (const raw of spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!(ARM_NAMES as readonly string[]).includes(raw)) {
      throw new Error(`--arms: unknown arm "${raw}" (valid: ${ARM_NAMES.join(", ")})`);
    }
    if (!out.includes(raw as ArmName)) out.push(raw as ArmName);
  }
  if (out.length === 0) throw new Error("--arms needs at least one arm");
  return out;
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
function poolNum(v: string | undefined): number {
  const n = num(v, "--pool");
  if (!Number.isInteger(n) || n < 1) throw new Error("--pool must be a positive integer");
  return n;
}

// ── Tokenisation (matches the overlap gate; lexical, BM25-relevant) ──

const STOP = new Set(
  (
    "a an the to of in on at for and or but with without when how why is are be it its " +
    "into as my me i you your their them they not no than instead while per after before " +
    "does do that this so what which"
  ).split(" ")
);
function toks(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((t) => t && t.length > 1 && !STOP.has(t))
  );
}
/** Fraction of the query's content tokens that occur in the trigger tokens. */
function coverage(query: string, trigger: Set<string>): number {
  const q = toks(query);
  if (q.size === 0) return 0;
  let hit = 0;
  for (const t of q) if (trigger.has(t)) hit++;
  return hit / q.size;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ── Recall counters ────────────────────────────────────────────

interface Run {
  hitK: number;
  hit1: number;
  total: number;
}
const emptyRun = (): Run => ({ hitK: 0, hit1: 0, total: 0 });
function record(run: Run, rank: number, k: number): void {
  run.total++;
  if (rank === 1) run.hit1++;
  if (rank >= 1 && rank <= k) run.hitK++;
}
const recallK = (r: Run): number => (r.total ? r.hitK / r.total : 0);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const signed = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pp`;

// ── Far-split counters (#103 / discussion #105) ────────────────
// Over FAR queries only: was the gold anywhere in the first-stage candidate
// pool (`in-pool` = mis-ranking territory) or absent (`not-retrieved` = a
// recall-bound miss)? goldRankSum/inPool is the precision signal.

interface FarSplit {
  inPool: number;
  notRetrieved: number;
  goldRankSum: number;
}
const emptySplit = (): FarSplit => ({ inPool: 0, notRetrieved: 0, goldRankSum: 0 });
function recordFar(split: FarSplit, rank: number): void {
  if (rank >= 1) {
    split.inPool++;
    split.goldRankSum += rank;
  } else {
    split.notRetrieved++;
  }
}
const meanGoldRank = (s: FarSplit): number => (s.inPool ? s.goldRankSum / s.inPool : NaN);

// ── Arm plumbing (#103) ────────────────────────────────────────
// Every rank is the gold's 1-based position in the arm's FIRST-STAGE candidate
// pool; 0 = not retrieved. For the BM25-only arms the pool mirrors core
// recall()'s HOP_SEED_POOL = max(k*4, 20) (search.ts) — exactly the pool
// onCandidatePool exposes (#121). For hybrid we capture that pool directly.
// `--pool` (#118) sweeps that depth for every arm. It moves ONLY the far
// in-pool/not-retrieved split, never R@k: without a reranker behind the pool,
// widening the window cannot change which memory ends up in the top k.

type BmIndex = ReturnType<typeof buildIndex>;

interface ArmRunner {
  rank(side: "control" | "treatment", query: string, goldId: string): Promise<number> | number;
  close?(): Promise<void>;
}

interface ArmCounters {
  overallC: Run;
  overallT: Run;
  nearC: Run;
  nearT: Run;
  farC: Run;
  farT: Run;
  farSplitC: FarSplit;
  farSplitT: FarSplit;
  perPersonaT: Map<string, Run>;
  /** per-query wall time of the treatment-side retrieval call, ms (#118). */
  latencyT: number[];
}
const emptyCounters = (): ArmCounters => ({
  overallC: emptyRun(),
  overallT: emptyRun(),
  nearC: emptyRun(),
  nearT: emptyRun(),
  farC: emptyRun(),
  farT: emptyRun(),
  farSplitC: emptySplit(),
  farSplitT: emptySplit(),
  perPersonaT: new Map(),
  latencyT: [],
});

function bm25PoolRank(index: BmIndex, query: string, goldId: string, poolCap: number): number {
  return rankOf(index.search(query).slice(0, poolCap), goldId);
}

/**
 * Run production recallHybrid, capture the #121 pool, return the gold's pool rank.
 *
 * `poolCap` (#118) is the depth we WANT to observe. core sizes its exposed pool
 * as `HOP_SEED_POOL = max(k·4, 20)`, so the only lever from the outside is the
 * `k` we pass: ask for `ceil(poolCap/4)` and the callback hands us at least
 * `poolCap` candidates, which we then slice ourselves. `k` does not touch the
 * fusion order (RRF runs before the pool is cut), so this widens the WINDOW,
 * not the ranking — at the default poolCap the captured pool is identical to
 * what `k` alone produced before.
 *
 * Structural ceiling worth knowing before reading a deep sweep: recallHybrid
 * fuses `bm25.slice(0, 50)` with `vectorTop.slice(0, 50)` (search.ts), so the
 * fused pool can never exceed ~100 distinct ids no matter how deep we ask.
 */
async function hybridPoolRank(search: SearchIndex, query: string, goldId: string, poolCap: number): Promise<number> {
  let captured: RecallHit[] = [];
  await search.recallHybrid(query, {
    k: Math.ceil(poolCap / 4),
    allow_private: true,
    onCandidatePool: (pool) => {
      captured = pool;
    },
  });
  const idx = captured.slice(0, poolCap).findIndex((h) => h.id === goldId);
  return idx === -1 ? 0 : idx + 1;
}

// ── Latency (#118) ─────────────────────────────────────────────
// Wall time of ONE arm's retrieval call per query — for hybrid that is
// production `recallHybrid` including the Ollama query-embed round-trip; for
// the BM25 arms it is the in-process minisearch call. Nothing around it (hook
// process, MCP transport, topic detection, formatting) is in these numbers.

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
const ms = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : "n/a");

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = JSON.parse(readFileSync(args.personas, "utf8")) as PersonaFile;

  const vault = new Vault(args.vault);
  const { loaded, skipped } = await vault.init();
  for (const s of skipped) console.error(`  skipped ${s.path}: ${s.err}`);
  const memories: Memory[] = vault.list().filter((m) => !m.fm.obsolete);
  const known = new Set(memories.map((m) => m.fm.id));
  const triggerToks = new Map<string, Set<string>>();
  for (const m of memories) {
    const t = new Set<string>();
    for (const phrase of m.fm.recall_when) for (const tok of toks(phrase)) t.add(tok);
    triggerToks.set(m.fm.id, t);
  }

  // First-stage pool cap (see comment on bm25PoolRank). Default mirrors core's
  // HOP_SEED_POOL; `--pool` (#118) sweeps it without touching production.
  const poolCap = args.pool ?? Math.max(args.k * 4, 20);

  // Every control strips BOTH trigger fields (buildIndex control indexes
  // neither), so lexical + expanded share one control index.
  const control = buildIndex(memories, { kind: "control" });
  const runners = new Map<ArmName, ArmRunner>();
  if (args.arms.includes("lexical")) {
    const treatment = buildIndex(memories, { kind: "treatment", boost: args.boost });
    runners.set("lexical", {
      rank: (side, q, id) => bm25PoolRank(side === "control" ? control : treatment, q, id, poolCap),
    });
  }
  if (args.arms.includes("expanded")) {
    const withExpansions = memories.filter((m) => (m.fm.recall_when_expanded ?? []).length > 0).length;
    if (withExpansions === 0) {
      console.error(
        "⚠ expanded arm: no memory carries recall_when_expanded — treatment degenerates to lexical (#117 expansions missing on this vault)"
      );
    }
    const treatment = buildIndex(memories, {
      kind: "treatment",
      boost: args.boost,
      expandedBoost: EXPANDED_RECALL_WHEN_BOOST,
    });
    runners.set("expanded", {
      rank: (side, q, id) => bm25PoolRank(side === "control" ? control : treatment, q, id, poolCap),
    });
  }
  if (args.arms.includes("hybrid")) {
    if (args.boost !== TREATMENT_RECALL_WHEN_BOOST) {
      console.error(
        `⚠ hybrid arm always runs production weights (recall_when ×${TREATMENT_RECALL_WHEN_BOOST}); --boost ${args.boost} only affects lexical/expanded arms`
      );
    }
    const pair = await buildHybridArmPair(args.vault);
    runners.set("hybrid", {
      rank: (side, q, id) =>
        hybridPoolRank(side === "control" ? pair.control.search : pair.treatment.search, q, id, poolCap),
      close: pair.cleanup,
    });
  }

  const counters = new Map<ArmName, ArmCounters>();
  for (const arm of args.arms) counters.set(arm, emptyCounters());
  const unknownIds = new Set<string>();
  let totalQueries = 0;

  for (const [label, byMemory] of Object.entries(file.personas)) {
    for (const arm of args.arms) counters.get(arm)!.perPersonaT.set(label, emptyRun());
    for (const [id, query] of Object.entries(byMemory)) {
      if (!known.has(id)) {
        unknownIds.add(id);
        continue;
      }
      totalQueries++;
      const cov = coverage(query, triggerToks.get(id) ?? new Set());
      const isNear = cov >= args.near;
      for (const arm of args.arms) {
        const c = counters.get(arm)!;
        const runner = runners.get(arm)!;
        const cRank = await runner.rank("control", query, id);
        const t0 = performance.now();
        const tRank = await runner.rank("treatment", query, id);
        c.latencyT.push(performance.now() - t0);
        record(c.overallC, cRank, args.k);
        record(c.overallT, tRank, args.k);
        record(isNear ? c.nearC : c.farC, cRank, args.k);
        record(isNear ? c.nearT : c.farT, tRank, args.k);
        if (!isNear) {
          recordFar(c.farSplitC, cRank);
          recordFar(c.farSplitT, tRank);
        }
        record(c.perPersonaT.get(label)!, tRank, args.k);
      }
    }
  }
  for (const runner of runners.values()) await runner.close?.();

  const liftAllOf = (c: ArmCounters): number => recallK(c.overallT) - recallK(c.overallC);
  const liftNearOf = (c: ArmCounters): number => recallK(c.nearT) - recallK(c.nearC);
  const liftFarOf = (c: ArmCounters): number => recallK(c.farT) - recallK(c.farC);
  const survivalOf = (c: ArmCounters): number => {
    const near = liftNearOf(c);
    return near > 0 ? liftFarOf(c) / near : NaN;
  };

  // persona-diversity sanity (mean pairwise query Jaccard across shared ids)
  const labels = Object.keys(file.personas);
  const pairSims: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const A = file.personas[labels[i]],
        B = file.personas[labels[j]];
      const ids = Object.keys(A).filter((id) => id in B);
      if (!ids.length) continue;
      const s = ids.reduce((acc, id) => acc + jaccard(toks(A[id]), toks(B[id])), 0) / ids.length;
      pairSims.push(s);
    }
  }
  const meanSim = pairSims.length ? pairSims.reduce((a, b) => a + b, 0) / pairSims.length : 0;

  // ── report ──
  // Single lexical arm → the exact legacy report + JSON (backward compatible,
  // byte-for-byte). Anything else → the multi-arm report with the far-split.
  const legacyOnly = args.arms.length === 1 && args.arms[0] === "lexical";
  const L: string[] = [];

  if (legacyOnly) {
    const c = counters.get("lexical")!;
    const { overallC, overallT, nearC, nearT, farC, farT, perPersonaT } = c;
    const liftAll = liftAllOf(c);
    const liftNear = liftNearOf(c);
    const liftFar = liftFarOf(c);
    const survival = survivalOf(c);

    L.push("# recall_when — Simulated-User Survival\n");
    L.push(
      `Vault: **${loaded}** memorys  ·  personas: **${labels.length}**  ·  ` +
        `queries: **${totalQueries}**  ·  boost: **×${args.boost}**  ·  k = **${args.k}**  ·  ` +
        `near/far cut: **${args.near}**\n`
    );

    L.push("## Lift by recall-time vocabulary drift\n");
    L.push("| query↔trigger | n | control R@" + args.k + " | treatment R@" + args.k + " | marginal lift |");
    L.push("|---|---|---|---|---|");
    L.push(
      `| **all** | ${overallT.total} | ${pct(recallK(overallC))} | ${pct(recallK(overallT))} | **${signed(liftAll)}** |`
    );
    L.push(
      `| near (≥${args.near}) | ${nearT.total} | ${pct(recallK(nearC))} | ${pct(recallK(nearT))} | ${signed(liftNear)} |`
    );
    L.push(
      `| far (<${args.near}) | ${farT.total} | ${pct(recallK(farC))} | ${pct(recallK(farT))} | ${signed(liftFar)} |`
    );
    L.push("");
    L.push(
      `**survival = lift(far) / lift(near) = ${Number.isFinite(survival) ? survival.toFixed(2) : "n/a"}** — ` +
        `the fraction of recall_when's benefit that holds when the recall-time query ` +
        `drifts off the save-time trigger wording.\n`
    );

    L.push("## Robustness envelope across user personas\n");
    L.push(`Recall@${args.k} (treatment) per simulated user — the spread is the envelope:\n`);
    L.push("| persona | queries | Recall@" + args.k + " |");
    L.push("|---|---|---|");
    const persRecalls: number[] = [];
    for (const [label, r] of perPersonaT) {
      persRecalls.push(recallK(r));
      L.push(`| ${label} | ${r.total} | ${pct(recallK(r))} |`);
    }
    if (persRecalls.length) {
      L.push("");
      L.push(
        `Envelope: **${pct(Math.min(...persRecalls))} – ${pct(Math.max(...persRecalls))}** ` +
          `across ${persRecalls.length} user styles.\n`
      );
    }
  } else {
    L.push("# recall_when — Simulated-User Survival (multi-arm, #103)\n");
    L.push(
      `Vault: **${loaded}** memorys  ·  personas: **${labels.length}**  ·  ` +
        `queries: **${totalQueries}**  ·  boost: **×${args.boost}**  ·  k = **${args.k}**  ·  ` +
        `near/far cut: **${args.near}**  ·  arms: **${args.arms.join(", ")}**\n`
    );

    L.push("## Lift by recall-time vocabulary drift — per arm\n");
    L.push("| arm | query↔trigger | n | control R@" + args.k + " | treatment R@" + args.k + " | marginal lift |");
    L.push("|---|---|---|---|---|---|");
    for (const arm of args.arms) {
      const c = counters.get(arm)!;
      L.push(
        `| ${arm} | **all** | ${c.overallT.total} | ${pct(recallK(c.overallC))} | ${pct(recallK(c.overallT))} | **${signed(liftAllOf(c))}** |`
      );
      L.push(
        `| ${arm} | near (≥${args.near}) | ${c.nearT.total} | ${pct(recallK(c.nearC))} | ${pct(recallK(c.nearT))} | ${signed(liftNearOf(c))} |`
      );
      L.push(
        `| ${arm} | far (<${args.near}) | ${c.farT.total} | ${pct(recallK(c.farC))} | ${pct(recallK(c.farT))} | ${signed(liftFarOf(c))} |`
      );
    }
    L.push("");
    L.push("**survival = lift(far) / lift(near)** per arm:\n");
    for (const arm of args.arms) {
      const s = survivalOf(counters.get(arm)!);
      L.push(`- ${arm}: **${Number.isFinite(s) ? s.toFixed(2) : "n/a"}**`);
    }
    L.push("");

    L.push("## Far slice — in-pool vs not-retrieved (per @zzallirog, #105)\n");
    L.push(
      `Where the gold sat on far queries. \`in-pool\` = somewhere in the first-stage ` +
        `candidate pool (retrieved but possibly mis-ranked — a precision problem); ` +
        `\`not-retrieved\` = a recall-bound miss (what an index-side lever must fix). ` +
        `Pool = **${poolCap}**${args.pool === null ? " (default max(k·4, 20), core's #121 candidate pool)" : " (--pool, #118)"}. ` +
        `Precision signal: mean gold rank among in-pool fars (lower = better).\n`
    );
    L.push("| arm | side | far n | in-pool | not-retrieved | mean gold rank (in-pool) |");
    L.push("|---|---|---|---|---|---|");
    for (const arm of args.arms) {
      const c = counters.get(arm)!;
      for (const [side, split] of [
        ["control", c.farSplitC],
        ["treatment", c.farSplitT],
      ] as const) {
        const mgr = meanGoldRank(split);
        L.push(
          `| ${arm} | ${side} | ${split.inPool + split.notRetrieved} | ${split.inPool} | ` +
            `${split.notRetrieved} | ${Number.isFinite(mgr) ? mgr.toFixed(2) : "n/a"} |`
        );
      }
    }
    L.push("");

    L.push("## Retrieval-path latency at this pool depth (#118)\n");
    L.push(
      `Wall time of ONE treatment-side retrieval call per query, against the ~500 ms ` +
        `hook budget. hybrid = production \`recallHybrid\` incl. the Ollama query embed; ` +
        `lexical/expanded = the in-process BM25 call. Hook process start, MCP transport, ` +
        `topic detection and formatting are NOT in these numbers.\n`
    );
    L.push("| arm | queries | p50 ms | p95 ms | max ms |");
    L.push("|---|---|---|---|---|");
    for (const arm of args.arms) {
      const s = [...counters.get(arm)!.latencyT].sort((a, b) => a - b);
      L.push(
        `| ${arm} | ${s.length} | ${ms(percentile(s, 50))} | ${ms(percentile(s, 95))} | ` + `${ms(s.at(-1) ?? NaN)} |`
      );
    }
    L.push("");

    L.push("## Robustness envelope across user personas\n");
    L.push(`Recall@${args.k} (treatment) per simulated user — the spread is the envelope:\n`);
    L.push("| persona | queries | " + args.arms.join(" | ") + " |");
    L.push("|---|---|" + args.arms.map(() => "---|").join(""));
    for (const label of labels) {
      const cells = args.arms.map((arm) => pct(recallK(counters.get(arm)!.perPersonaT.get(label)!)));
      const n = counters.get(args.arms[0])!.perPersonaT.get(label)!.total;
      L.push(`| ${label} | ${n} | ${cells.join(" | ")} |`);
    }
    L.push("");
    for (const arm of args.arms) {
      const rs = [...counters.get(arm)!.perPersonaT.values()].map(recallK);
      if (rs.length) {
        L.push(
          `- ${arm} envelope: **${pct(Math.min(...rs))} – ${pct(Math.max(...rs))}** across ${rs.length} user styles.`
        );
      }
    }
    L.push("");
  }

  L.push("## Persona-diversity check\n");
  L.push(
    `Mean pairwise query similarity (token Jaccard): **${meanSim.toFixed(3)}** ` +
      `(${meanSim < 0.35 ? "diverse — envelope is honest" : "HIGH — personas may be mode-collapsed; envelope suspect"}).\n`
  );

  if (unknownIds.size) {
    L.push(`> ⚠️ ${unknownIds.size} id(s) not in vault (skipped): ${[...unknownIds].join(", ")}\n`);
  }

  const report = L.join("\n");
  console.log(report);

  if (args.out) {
    let json: Record<string, unknown>;
    if (legacyOnly) {
      const c = counters.get("lexical")!;
      json = {
        vault: args.vault,
        vaultSize: loaded,
        boost: args.boost,
        k: args.k,
        nearCut: args.near,
        queries: totalQueries,
        liftAll: liftAllOf(c),
        liftNear: liftNearOf(c),
        liftFar: liftFarOf(c),
        survival: survivalOf(c),
        personaRecall: Object.fromEntries([...c.perPersonaT].map(([l, r]) => [l, recallK(r)])),
        meanPairwiseSimilarity: meanSim,
        unknownIds: [...unknownIds],
      };
    } else {
      const sliceJson = (cRun: Run, tRun: Run): Record<string, unknown> => ({
        n: tRun.total,
        control: recallK(cRun),
        treatment: recallK(tRun),
        lift: recallK(tRun) - recallK(cRun),
      });
      const splitJson = (s: FarSplit): Record<string, unknown> => ({
        inPool: s.inPool,
        notRetrieved: s.notRetrieved,
        meanGoldRank: meanGoldRank(s), // NaN → null in JSON
      });
      const latencyJson = (xs: number[]): Record<string, unknown> => {
        const s = [...xs].sort((a, b) => a - b);
        return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s.at(-1) ?? null };
      };
      json = {
        vault: args.vault,
        vaultSize: loaded,
        boost: args.boost,
        k: args.k,
        nearCut: args.near,
        poolCap,
        queries: totalQueries,
        arms: Object.fromEntries(
          args.arms.map((arm) => {
            const c = counters.get(arm)!;
            return [
              arm,
              {
                slices: {
                  all: sliceJson(c.overallC, c.overallT),
                  near: sliceJson(c.nearC, c.nearT),
                  far: sliceJson(c.farC, c.farT),
                },
                survival: survivalOf(c), // NaN → null in JSON
                farSplit: {
                  control: splitJson(c.farSplitC),
                  treatment: splitJson(c.farSplitT),
                },
                latencyMs: latencyJson(c.latencyT),
                personaRecall: Object.fromEntries([...c.perPersonaT].map(([l, r]) => [l, recallK(r)])),
              },
            ];
          })
        ),
        meanPairwiseSimilarity: meanSim,
        unknownIds: [...unknownIds],
      };
    }
    writeFileSync(args.out, JSON.stringify(json, null, 2));
    console.error(`\n[persona-lift] JSON written to ${args.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
