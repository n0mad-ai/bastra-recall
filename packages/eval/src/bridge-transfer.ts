#!/usr/bin/env tsx
/**
 * Bridge transfer eval (#129) — do learned-recall BRIDGES lift the OUT-OF-POOL
 * far slice, with a null control?
 *
 * A bridge is a query-side LEXICAL lever: it expands a far-worded query with the
 * gold memory's near vocabulary so BM25 can reach a memory the query under-words.
 * The #129 gate asks: on the slice where the gold memory ranks BEYOND the deeper
 * candidate pool (out-of-pool / OOP — a reranker can't rescue what never entered
 * the pool), does the bridge drag it back in, WITHOUT regressing NEAR queries —
 * and crucially, does it beat a FOREIGN-bridge null control (expansion terms from
 * an UNRELATED memory)? If the foreign null lifts too, the "lift" is non-specific
 * lexical-length inflation, not real direction.
 *
 * SIMULATED, NOT real traffic: mint/eval queries are drawn from each memory's own
 * recall_when phrases (phrase[0] mints, phrase[1..] evaluate) — recall_when drift,
 * not acted_on telemetry. The numbers are directional only.
 *
 * RECALL_WHEN HOLDOUT (default — the #129-correct measurement):
 *   A held-out recall_when phrase is NEAR by construction unless recall_when is also
 *   held out of retrieval: each phrase is indexed in its OWN gold's recall_when_flat
 *   (BM25 ×5) AND baked into the gold's embedding vector (buildEmbedText includes
 *   recall_when). So a phrase[1..] query matches its gold almost trivially → the OOP
 *   slice fills with artifacts, not genuinely-far cases. The fix (this default): strip
 *   recall_when from EVERY memory's in-memory frontmatter BEFORE either index is built,
 *   so neither leg can see it. The eval query can then only reach the gold via
 *   title/summary/body/tags/topic — genuinely far for memories whose body doesn't
 *   carry the phrase vocabulary. `--no-holdout` reproduces the old contaminated run.
 *
 * Correctness guards (the exact bugs the #129 thread keeps catching):
 *   1. PREFIX CORRECTNESS — embeddinggemma uses asymmetric query/passage prefixes.
 *      We never hand-roll an embedding or a prefix. We feed the recall_when-stripped
 *      in-memory memories to the SAME EmbeddingIndex + OllamaEmbeddingProvider the
 *      daemon uses; EmbeddingIndex's buildEmbedText + provider.embed apply the exact
 *      production passage convention, just minus recall_when. Queries go ONLY through
 *      search.recallHybrid(query, opts), which embeds them via the same provider. In
 *      holdout mode the persisted embeddings.json is NOT loaded (those vectors carry
 *      recall_when) — a fresh temp persistPath forces a recompute from stripped text.
 *   2. NULL CONTROL — the FOREIGN-bridge arm. Right trigger, wrong expansion.
 *
 * Usage:
 *   BASTRA_VAULT_PATH=/path/to/vault npx tsx src/bridge-transfer.ts --sample 20
 *   BASTRA_VAULT_PATH=/path/to/vault npx tsx src/bridge-transfer.ts --full
 *   BASTRA_VAULT_PATH=/path/to/vault npx tsx src/bridge-transfer.ts --full --no-holdout
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Vault, SearchIndex, EmbeddingIndex, OllamaEmbeddingProvider, type RecallHit } from "@bastra-recall/core";

// The bridge layer lives in the daemon (not exported from core, and a static
// cross-package source import trips tsc's rootDir guard). We load the REAL
// production module at runtime from the daemon's compiled dist so we exercise
// the genuine mintBridge / expandQuery / BridgePool (incl. BridgePool's on-disk
// load round-trip) — never a re-implementation. The specifier is resolved at
// runtime, so it stays out of the type-check program; the shapes below mirror
// daemon/src/learned-recall/bridges.ts exactly.
interface Bridge {
  id: string;
  lang: "de" | "en";
  trigger_terms: string[];
  expansion_terms: string[];
  evidence: number;
  date?: string;
}
interface BridgePool {
  size(lang?: "de" | "en"): number;
  languages(): ("de" | "en")[];
  expansionsFor(query: string, lang: "de" | "en"): string[];
}
interface ExpansionResult {
  query: string;
  lang: "de" | "en" | null;
  added: string[];
}
interface BridgesModule {
  mintBridge: (query: string, memoryTerms: string[], lang?: "de" | "en" | null, date?: string) => Bridge | null;
  expandQuery: (
    query: string,
    pool: BridgePool | null | undefined,
    opts?: { configuredLang?: "de" | "en" | null }
  ) => ExpansionResult;
  distinctiveTerms: (text: string) => string[];
  BridgePool: { load: (rootDir: string) => BridgePool; empty: () => BridgePool };
}
interface HarvestModule {
  writeBridges: (rootDir: string, bridges: Bridge[]) => Promise<number>;
}

const daemonDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../daemon/dist/learned-recall");
const { mintBridge, expandQuery, distinctiveTerms, BridgePool } = (await import(
  path.join(daemonDist, "bridges.js")
)) as BridgesModule;
const { writeBridges } = (await import(path.join(daemonDist, "harvest.js"))) as HarvestModule;

// ── Config knobs (mirror the daemon's env handling) ─────────────────────────

const VAULT_PATH = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
if (!VAULT_PATH) {
  console.error("FATAL: BASTRA_VAULT_PATH is not set. Point it at the memory vault.");
  process.exit(2);
}

/** S = serving k (the top-k slice the recall hook actually returns). NEAR = rank ≤ S. */
const S = 5;

const FOREIGN_OFFSET = 7; // fixed deterministic permutation for the null arm

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { sample: number; full: boolean; holdout: boolean } {
  let sample = 30;
  let full = false;
  let holdout = true; // recall_when held out of both legs = the #129-correct default
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--full") full = true;
    else if (argv[i] === "--no-holdout") holdout = false;
    else if (argv[i] === "--sample") {
      const n = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) sample = n;
      i++;
    }
  }
  return { sample, full, holdout };
}

// ── Memory-terms derivation for minting (bridge EXPANSION terms) ────────────
//
// Production (cli/bridges.ts:107, harvest.ts getMemoryInfo) derives a memory's
// vocabulary from title + summary + recall_when + tags + body — and that is what
// `--no-holdout` uses, so the contaminated arm matches production minting exactly.
//
// HOLDOUT mode (default): a DELIBERATE, NECESSARY divergence from production. Since
// recall_when is held out of the index, expansion terms drawn from recall_when can
// no longer match the gold (its recall_when_flat is empty and its vector no longer
// carries those tokens). So we mint the expansion from the INDEXED fields only —
// title + summary + body + tags, EXCLUDING recall_when — so the bridge can actually
// reach the gold through the surfaces that remain searchable. (Trigger terms are
// unaffected: they come from the MINT query = phrase[0], handled at the call site.)
function memoryTerms(
  m: { fm: { title: string; summary: string; recall_when: string[]; tags: string[] }; body: string },
  holdout: boolean
): string[] {
  const parts = holdout
    ? [m.fm.title, m.fm.summary, m.body, m.fm.tags.join(" ")]
    : [m.fm.title, m.fm.summary, ...m.fm.recall_when, ...m.fm.tags, m.body];
  return distinctiveTerms(parts.join(" "));
}

// ── Rank helpers ─────────────────────────────────────────────────────────────

/** 1-based rank of `goldId` in the candidate pool; Infinity when absent. */
function rankInPool(pool: RecallHit[], goldId: string): number {
  const idx = pool.findIndex((h) => h.id === goldId);
  return idx === -1 ? Infinity : idx + 1;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Recall harness ───────────────────────────────────────────────────────────

interface RecallResult {
  /** Gold's 1-based rank in the deeper candidate pool (Infinity = absent). */
  rank: number;
  /** Length of the candidate pool returned for this query (the per-query P). */
  poolLen: number;
}

/** Run recallHybrid, capture the deeper #121 candidate pool, return gold's rank. */
async function recallRank(search: SearchIndex, query: string, goldId: string): Promise<RecallResult> {
  let captured: RecallHit[] = [];
  await search.recallHybrid(query, {
    k: S,
    allow_private: true, // mirror the Mac-app path: see every memory, no sensitivity drop
    onCandidatePool: (pool) => {
      captured = pool;
    },
  });
  return { rank: rankInPool(captured, goldId), poolLen: captured.length };
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface EvalCase {
  goldId: string;
  query: string; // a held-out recall_when phrase (phrase[1..])
}

interface ArmRow {
  /** rank under this arm minus rank under OFF, over OOP-at-baseline cases (capped). */
  meanDeltaRank: number;
  /** fraction of OOP-at-baseline golds that reached rank ≤ P under this arm. */
  crossedIn: number;
  /** fraction of NEAR-at-baseline golds that got worse (rank increased) under this arm. */
  nearRegression: number;
}

async function main(): Promise<void> {
  const { sample, full, holdout } = parseArgs(process.argv.slice(2));

  // Temp dir that holds the freshly-recomputed (recall_when-stripped) vectors in
  // holdout mode, plus the minted bridge pools. Deleted at the end.
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bastra-bridge-eval-"));

  // ── Build the index the way the daemon does at startup ─────────────────────
  const vault = new Vault(VAULT_PATH!);
  await vault.init();
  const vaultSize = vault.size();

  // ── recall_when HOLDOUT ────────────────────────────────────────────────────
  // Snapshot every memory's ORIGINAL recall_when BEFORE stripping — eligibility,
  // the mint phrase (phrase[0]) and the eval queries (phrase[1..]) all read the
  // originals. Then, in holdout mode, blank recall_when (and the doc2query
  // recall_when_expanded) on the IN-MEMORY frontmatter so NEITHER retrieval leg
  // can see it: SearchIndex.indexOne reads fm.recall_when(_expanded) and
  // EmbeddingIndex.buildEmbedText reads fm.recall_when — both off the same Memory
  // object returned by vault.get(). No disk write; the .md files are untouched.
  const originalRecallWhen = new Map<string, string[]>();
  for (const m of vault.list()) {
    originalRecallWhen.set(m.fm.id, [...m.fm.recall_when]);
    if (holdout) {
      (m.fm as { recall_when: string[] }).recall_when = [];
      (m.fm as { recall_when_expanded?: string[] }).recall_when_expanded = [];
    }
  }

  const search = new SearchIndex(vault);
  search.start();

  // Mirror daemon env handling for the Ollama embedding provider.
  const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
  const dimEnv = process.env.BASTRA_EMBEDDING_DIM;
  const parsedDim = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
  const dim = parsedDim !== undefined && Number.isFinite(parsedDim) ? parsedDim : undefined;
  const keepAlive = process.env.BASTRA_OLLAMA_KEEP_ALIVE ?? "10m";
  const provider = new OllamaEmbeddingProvider({ baseURL, model, dim, keepAlive });

  // Holdout: a FRESH temp persistPath → EmbeddingIndex.load() finds nothing, so
  // every memory is backfilled (re-embedded) from the stripped text via the SAME
  // provider — the production embeddings.json (which baked in recall_when) is never
  // touched or loaded. --no-holdout: reuse the real production vectors as before.
  const persistPath = holdout
    ? path.join(tmpRoot, "embeddings.holdout.json")
    : path.join(VAULT_PATH!, ".bastra", "embeddings.json");
  const embIdx = new EmbeddingIndex(vault, provider, persistPath);
  await embIdx.start();
  if (holdout) {
    // start() only QUEUES the backfill; await the full re-embed before recall so
    // the dense leg isn't empty/partial. Poll pending→0 (re-embeds ~all memories).
    process.stderr.write(`[holdout] re-embedding ${vault.size()} memories without recall_when…\n`);
    let lastSize = -1;
    let stalledTicks = 0;
    while (embIdx.pendingSize() > 0 || embIdx.size() < vaultSize) {
      const size = embIdx.size();
      process.stderr.write(`  pending ${embIdx.pendingSize()}, embedded ${size}/${vaultSize}\r`);
      // Stall guard: if no new vector lands for ~30s (120 ticks) AND the queue is
      // drained, a few memories simply have no embeddable text (or a provider
      // hiccup left them out) — stop waiting rather than hang forever.
      if (size === lastSize) {
        stalledTicks++;
        if (stalledTicks >= 120 && embIdx.pendingSize() === 0) break;
      } else {
        stalledTicks = 0;
        lastSize = size;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    process.stderr.write(`\n[holdout] re-embed complete: ${embIdx.size()}/${vaultSize} vectors\n`);
  }
  search.useEmbeddings(embIdx);

  // ── Eligible memories: ≥2 recall_when phrases (by the ORIGINAL phrases) ─────
  // phrase[0] mints the bridge; phrase[1..] are held-out EVAL queries. This
  // guarantees mint and eval text never overlap (the #129 split requirement).
  // Memories with <2 phrases stay in the index as distractors (not removed).
  const phrasesOf = (id: string): string[] => originalRecallWhen.get(id) ?? [];
  const eligibleAll = vault
    .list()
    .filter((m) => phrasesOf(m.fm.id).length >= 2)
    .sort((a, b) => (a.fm.id < b.fm.id ? -1 : a.fm.id > b.fm.id ? 1 : 0));

  const eligible = full ? eligibleAll : eligibleAll.slice(0, sample);
  const n = eligible.length;

  // ── Build the two bridge pools via the REAL BridgePool.load round-trip ─────
  // BridgePool has no in-memory constructor that takes minted Bridge objects —
  // load(rootDir) is the only data path. So we mint, writeBridges() to a temp
  // dir in the daemon's exact on-disk format (<root>/bridges/<lang>/<id>.json),
  // then BridgePool.load() it back. Temp dirs are deleted at the end.
  const ownBridges: Bridge[] = [];
  const foreignBridges: Bridge[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const m = eligible[i];
    const mintPhrase = phrasesOf(m.fm.id)[0]; // ORIGINAL phrase[0]
    // ownPool: mint phrase paired with its OWN memory's vocabulary.
    const ownTerms = memoryTerms(m, holdout);
    const own = mintBridge(mintPhrase, ownTerms);
    if (own) ownBridges.push(own);
    // foreignPool (null): same mint phrase, but the DIFFERENT memory's vocabulary
    // under a fixed deterministic permutation (i → (i+OFFSET) mod n). Right
    // trigger, wrong expansion. No Math.random.
    const foreignMem = eligible[(i + FOREIGN_OFFSET) % n];
    const foreign = mintBridge(mintPhrase, memoryTerms(foreignMem, holdout));
    if (foreign) foreignBridges.push(foreign);
  }

  const ownRoot = path.join(tmpRoot, "own");
  const foreignRoot = path.join(tmpRoot, "foreign");
  await writeBridges(ownRoot, ownBridges);
  await writeBridges(foreignRoot, foreignBridges);
  const ownPool = BridgePool.load(ownRoot);
  const foreignPool = BridgePool.load(foreignRoot);

  // ── Eval cases: held-out phrases (phrase[1..]) of each eligible memory ──────
  const cases: EvalCase[] = [];
  for (const m of eligible) {
    for (const q of phrasesOf(m.fm.id).slice(1)) {
      if (q && q.trim()) cases.push({ goldId: m.fm.id, query: q });
    }
  }

  // ── Run the three arms per eval query ──────────────────────────────────────
  interface Row {
    goldId: string;
    off: number; // gold rank under the bare query
    on: number; // gold rank under the own-bridge expansion
    foreign: number; // gold rank under the foreign-bridge expansion
    poolLen: number; // candidate pool length for this query (off arm)
  }
  const rows: Row[] = [];
  const poolLens: number[] = [];

  for (const c of cases) {
    const off = await recallRank(search, c.query, c.goldId);
    poolLens.push(off.poolLen);

    const onQuery = expandQuery(c.query, ownPool).query;
    const on = await recallRank(search, onQuery, c.goldId);

    const foreignQuery = expandQuery(c.query, foreignPool).query;
    const foreign = await recallRank(search, foreignQuery, c.goldId);

    rows.push({ goldId: c.goldId, off: off.rank, on: on.rank, foreign: foreign.rank, poolLen: off.poolLen });
  }

  // ── P = the candidate-pool length. It's Math.max(k*4,20)=20 by construction,
  // but a query can return a shorter pool. We report the median/used P. The
  // region split uses each query's OWN pool length as its P (poolLen), which is
  // the honest "did gold make it into THIS query's pool" boundary.
  const usedP = median(poolLens);
  const medianP = usedP;
  // Cap for Infinity ranks: P+1 (one past the deepest possible in-pool rank).
  // Using the global median P keeps the cap stable across cases.
  const RANK_CAP = (Number.isFinite(usedP) ? usedP : 20) + 1;

  const capRank = (r: number): number => (Number.isFinite(r) ? r : RANK_CAP);

  // ── Region assignment by the OFF-arm baseline rank ─────────────────────────
  // NEAR:        rank ≤ S
  // FAR-IN-POOL: S < rank ≤ P (this query's pool length)
  // OOP:         rank > P or absent (Infinity)
  const near: Row[] = [];
  const farInPool: Row[] = [];
  const oop: Row[] = [];
  for (const r of rows) {
    const p = r.poolLen;
    if (r.off <= S) near.push(r);
    else if (Number.isFinite(r.off) && r.off <= p) farInPool.push(r);
    else oop.push(r);
  }

  // ── Per-arm gate readout, focused on the OOP-at-baseline slice ─────────────
  function armRow(pick: (r: Row) => number): ArmRow {
    // meanΔrank over OOP cases (Infinity → RANK_CAP).
    const deltas = oop.map((r) => capRank(pick(r)) - capRank(r.off));
    // crossed-in: fraction of OOP golds that reached rank ≤ that query's P.
    const crossed = oop.filter((r) => Number.isFinite(pick(r)) && pick(r) <= r.poolLen).length;
    // near-regression: fraction of NEAR golds whose rank increased (got worse).
    const regressed = near.filter((r) => capRank(pick(r)) > capRank(r.off)).length;
    return {
      meanDeltaRank: mean(deltas),
      crossedIn: oop.length ? crossed / oop.length : NaN,
      nearRegression: near.length ? regressed / near.length : NaN,
    };
  }

  const onArm = armRow((r) => r.on);
  const foreignArm = armRow((r) => r.foreign);

  // ── Verdict (#129) ─────────────────────────────────────────────────────────
  // promote iff the on-arm shows OOP far-lift (crossedIn > 0 OR meanΔrank < 0)
  // AND its NEAR-regression does not exceed the FOREIGN null's (null-relative:
  // charge lever-specific harm only, not the generic cost a random expansion also
  // pays — #129) — but ONLY if the on-arm also clears the FOREIGN null on the far
  // metric (own crossedIn > foreign crossedIn AND own meanΔrank < foreign meanΔrank).
  const onShowsLift = onArm.crossedIn > 0 || onArm.meanDeltaRank < 0;
  const nearWithinNull = onArm.nearRegression <= foreignArm.nearRegression;
  const beatsForeignCrossed = onArm.crossedIn > foreignArm.crossedIn;
  const beatsForeignDelta = onArm.meanDeltaRank < foreignArm.meanDeltaRank;
  const beatsForeign = beatsForeignCrossed && beatsForeignDelta;
  const promote = onShowsLift && nearWithinNull && beatsForeign;

  // ── Print ──────────────────────────────────────────────────────────────────
  const pct = (x: number): string => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const num = (x: number): string => (Number.isNaN(x) ? "n/a" : x.toFixed(2));

  const tiny = (label: string, count: number): string =>
    count < 5 ? `  ⚠ DATA-STARVED: ${label} n=${count} (<5) — treat the number as noise` : "";

  const holdoutLabel = holdout
    ? "recall_when held out of both legs"
    : "NO holdout — recall_when indexed (CONTAMINATED control run)";
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(" BRIDGE TRANSFER EVAL (#129) — SIMULATED");
  console.log(`  · ${holdoutLabel}`);
  console.log(" (recall_when-phrase drift — NOT real acted_on traffic)");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`  mode : ${holdout ? "HOLDOUT (default)" : "--no-holdout"}`);
  console.log(`  vault size (memories indexed) : ${vaultSize}`);
  console.log(
    `  dense leg : ${holdout ? `re-embedded ${embIdx.size()} memories WITHOUT recall_when (fresh temp vectors)` : `production embeddings.json (${embIdx.size()} vectors)`}`
  );
  console.log(`  eligible memories (≥2 recall_when) : ${n}${full ? " [--full]" : ` [--sample ${sample}]`}`);
  console.log(`  eval queries (held-out phrase[1..]) : ${cases.length}`);
  console.log(`  own bridges minted : ${ownBridges.length}   foreign bridges minted : ${foreignBridges.length}`);
  console.log(
    `  ownPool size : ${ownPool.size()} (${
      ownPool
        .languages()
        .map((l) => `${l}:${ownPool.size(l)}`)
        .join(" ") || "none"
    })`
  );
  console.log(
    `  foreignPool size : ${foreignPool.size()} (${
      foreignPool
        .languages()
        .map((l) => `${l}:${foreignPool.size(l)}`)
        .join(" ") || "none"
    })`
  );
  console.log("");
  console.log(`  S (serving k / NEAR boundary) : ${S}`);
  console.log(
    `  P (candidate-pool length, median/used) : ${num(medianP)}  [pool = max(k*4,20); per-query P = its own pool length]`
  );
  console.log(`  Infinity-rank cap : ${RANK_CAP} (= used P + 1)`);
  console.log("");
  const totalCases = near.length + farInPool.length + oop.length;
  const nearFrac = totalCases ? near.length / totalCases : NaN;
  console.log("  per-slice n (by OFF-arm baseline gold rank):");
  console.log(`    NEAR        (rank ≤ ${S})         : ${near.length}  (${pct(nearFrac)})`);
  console.log(`    FAR-IN-POOL (${S} < rank ≤ P)      : ${farInPool.length}`);
  console.log(`    OOP         (rank > P / absent)  : ${oop.length}`);
  // Holdout sanity gate: if recall_when really left both legs, the queries are now
  // genuinely far, so NEAR must drop sharply. NEAR still ~90% ⇒ the holdout didn't
  // take (most likely the dense leg loaded old vectors) — the numbers are untrustworthy.
  if (holdout && nearFrac >= 0.85) {
    console.log("");
    console.log(`  ⚠⚠ HOLDOUT SANITY FAIL: NEAR is still ${pct(nearFrac)} (≥85%). The recall_when`);
    console.log("     holdout did NOT take (likely the dense leg still loaded baked-in vectors).");
    console.log("     DO NOT TRUST the gate numbers below until this is fixed.");
  }
  for (const w of [tiny("OOP", oop.length), tiny("NEAR", near.length)]) if (w) console.log(w);
  console.log("");
  console.log("  ── GATE TABLE (focused on the OOP-at-baseline slice) ──────────────");
  console.log("");
  console.log("  arm        meanΔrank   crossed-in   near-regression");
  console.log("  ────────   ─────────   ──────────   ───────────────");
  console.log(
    `  on (own)   ${num(onArm.meanDeltaRank).padStart(9)}   ${pct(onArm.crossedIn).padStart(10)}   ${pct(onArm.nearRegression).padStart(15)}`
  );
  console.log(
    `  foreign    ${num(foreignArm.meanDeltaRank).padStart(9)}   ${pct(foreignArm.crossedIn).padStart(10)}   ${pct(foreignArm.nearRegression).padStart(15)}`
  );
  console.log("");
  console.log("  (meanΔrank: negative = lift. Infinity ranks capped at P+1.)");
  console.log("");
  console.log("  ── VERDICT (#129) ─────────────────────────────────────────────────");
  console.log(`    on-arm shows OOP lift        : ${onShowsLift ? "yes" : "no"}`);
  console.log(
    `    near-reg ≤ null              : ${nearWithinNull ? "yes" : "no"} (own ${pct(onArm.nearRegression)} vs null ${pct(foreignArm.nearRegression)})`
  );
  console.log(
    `    on beats foreign (crossed-in): ${beatsForeignCrossed ? "yes" : "no"} (own ${pct(onArm.crossedIn)} vs foreign ${pct(foreignArm.crossedIn)})`
  );
  console.log(
    `    on beats foreign (meanΔrank) : ${beatsForeignDelta ? "yes" : "no"} (own ${num(onArm.meanDeltaRank)} vs foreign ${num(foreignArm.meanDeltaRank)})`
  );
  console.log("");
  console.log(`    >>> ${promote ? "PROMOTE" : "DO NOT PROMOTE"} <<<`);
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("");

  // ── Cleanup: delete the temp bridge dirs ───────────────────────────────────
  await fs.rm(tmpRoot, { recursive: true, force: true });

  // Stop the index so the process can exit (vault watcher / embed timers).
  search.stop();
  embIdx.stop();
  await vault.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
