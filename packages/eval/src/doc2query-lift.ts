#!/usr/bin/env tsx
/**
 * doc2query index-side lift (#117) — does the LLM-generated `recall_when_expanded`
 * paraphrase field lift the OUT-OF-POOL far slice, with a foreign-paraphrase null?
 *
 * THE LEVER (vs bridge-transfer.ts): bridges expand the QUERY at recall time.
 * doc2query enriches the GOLD's INDEXED fields at write time. The field
 * `recall_when_expanded` (#117) is already populated on the vault (the daemon's
 * TriggerExpander wrote it offline); we MEASURE the existing data, we do NOT run
 * the expander. In production it is indexed as `recall_when_expanded_flat` at BM25
 * boost ×2 (search.ts).
 *
 * THREE ARMS differ ONLY by what is INDEXED on every memory (gold AND distractors):
 *   off (control)   : base fields only — recall_when AND recall_when_expanded both stripped.
 *   own (treatment) : base + the memory's OWN recall_when_expanded (recall_when still stripped).
 *   foreign (null)  : base + a DIFFERENT memory's recall_when_expanded via the fixed
 *                     (i+7)%n permutation (recall_when still stripped). Right structure,
 *                     wrong paraphrases — isolates whether the SPECIFIC paraphrases catch
 *                     the far query, vs. generic lexical-length inflation.
 *
 * recall_when is held out in ALL three arms, so the held-out eval queries (phrase[1..])
 * stay genuinely FAR and the only variable across arms is the doc2query expansion.
 *
 * ── CRITICAL: the dense leg and the wrong-leg trap ──────────────────────────────
 * Production `buildEmbedText` (embeddings.ts:570) embeds [title, tags, recall_when,
 * summary, body] — it does NOT include recall_when_expanded. `hashEmbedContent`
 * (embed-cache.ts:45) likewise omits it. So in SHIPPED #117, doc2query is a BM25-ONLY
 * lever: the dense leg never sees the paraphrases and is identical across arms. Two
 * honest measurements follow from that:
 *   DEFAULT (production-faithful): the dense vectors are built ONCE (recall_when-
 *     stripped, no paraphrases) and SHARED by all three arms; arms differ only in the
 *     BM25 leg. This measures the #117 that actually ships. RRF then fuses a per-arm
 *     BM25 ranking with an identical dense ranking.
 *   --embed-expansion (hypothetical both-legs): append each arm's paraphrases to that
 *     memory's dense embed text and re-embed per arm via the SAME OllamaEmbeddingProvider
 *     (prefix guard — never a hand-rolled embedding/prefix). This measures a doc2query
 *     that production does NOT currently have. Off by default; reported as such.
 *
 * Dense vectors are injected by writing each arm's persistPath JSON (the exact
 * {dim,provider,vectors} format EmbeddingIndex.load expects) with vectors computed
 * via provider.embed — so the query/passage prefix convention is byte-identical to
 * production. The production embeddings.json (which baked in recall_when) is NEVER
 * loaded. All temp dirs are deleted at exit.
 *
 * SIMULATED, NOT real traffic: mint/eval queries are recall_when-phrase drift.
 *
 * Usage:
 *   BASTRA_VAULT_PATH=/v npx tsx src/doc2query-lift.ts --sample 20
 *   BASTRA_VAULT_PATH=/v npx tsx src/doc2query-lift.ts --full
 *   BASTRA_VAULT_PATH=/v npx tsx src/doc2query-lift.ts --full --embed-expansion
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OllamaEmbeddingProvider,
  stripAutoRelatedSection,
  type RecallHit,
  type Memory,
} from "@bastra-recall/core";

// ── Config ───────────────────────────────────────────────────────────────────

const VAULT_PATH = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
if (!VAULT_PATH) {
  console.error("FATAL: BASTRA_VAULT_PATH is not set. Point it at the memory vault.");
  process.exit(2);
}

/** S = serving k (the top-k slice the recall hook returns). NEAR = baseline rank ≤ S. */
const S = 5;
const FOREIGN_OFFSET = 7; // fixed deterministic permutation for the null arm

type Arm = "off" | "own" | "foreign";

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { sample: number; full: boolean; embedExpansion: boolean } {
  let sample = 30;
  let full = false;
  let embedExpansion = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--full") full = true;
    else if (argv[i] === "--embed-expansion") embedExpansion = true;
    else if (argv[i] === "--sample") {
      const n = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) sample = n;
      i++;
    }
  }
  return { sample, full, embedExpansion };
}

// ── Production-faithful embed text (replica of embeddings.ts:buildEmbedText) ──
// recall_when is ALWAYS stripped here (held out in every arm). `expansion` is the
// arm's recall_when_expanded text, appended ONLY in --embed-expansion mode so the
// dense leg can see the paraphrases. The provider applies the passage prefix, so
// this only controls the TEXT, never the prefix — the prefix guard stays intact.
function embedTextFor(m: Memory, expansion: string[]): string {
  const fm = m.fm;
  const parts = [
    fm.title,
    fm.tags.join(" "),
    // recall_when intentionally omitted (held out in all arms)
    fm.summary,
    // #631: production strips the Auto-Related section before the 4000 cut.
    stripAutoRelatedSection(m.body).trimEnd().slice(0, 4000),
    expansion.join(" "), // empty unless --embed-expansion
  ];
  return parts.filter((p) => p && p.length > 0).join("\n");
}

// ── Rank helpers (shared with bridge-transfer) ───────────────────────────────

function rankInPool(pool: RecallHit[], goldId: string): number {
  const idx = pool.findIndex((h) => h.id === goldId);
  return idx === -1 ? Infinity : idx + 1;
}
function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface RecallResult {
  rank: number;
  poolLen: number;
}
/** Run recallHybrid on a given arm's SearchIndex, capture the #121 pool, return gold's rank. */
async function recallRank(search: SearchIndex, query: string, goldId: string): Promise<RecallResult> {
  let captured: RecallHit[] = [];
  await search.recallHybrid(query, {
    k: S,
    allow_private: true,
    onCandidatePool: (pool) => {
      captured = pool;
    },
  });
  return { rank: rankInPool(captured, goldId), poolLen: captured.length };
}

// ── Per-arm vector injection ─────────────────────────────────────────────────
// Write the {dim,provider,vectors} JSON EmbeddingIndex.load expects, with vectors
// computed via provider.embed on embedTextFor(...). This bypasses EmbeddingIndex's
// private buildEmbedText (which ignores recall_when_expanded) while keeping the
// provider's passage-prefix path. base64-LE float32, matching embeddings.ts:persist.
async function writeVectorsJson(
  persistPath: string,
  provider: OllamaEmbeddingProvider,
  ids: string[],
  vectors: Float32Array[],
): Promise<void> {
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i++) {
    const v = vectors[i];
    out[ids[i]] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
  }
  const data = { dim: provider.dim, provider: provider.id, vectors: out };
  await fs.mkdir(path.dirname(persistPath), { recursive: true });
  await fs.writeFile(persistPath, JSON.stringify(data));
}

/** Embed every memory's passage text in batches via the SAME provider (prefix-correct). */
async function embedAll(
  provider: OllamaEmbeddingProvider,
  memories: Memory[],
  expansionFor: (m: Memory) => string[],
  label: string,
): Promise<{ ids: string[]; vectors: Float32Array[] }> {
  const ids: string[] = [];
  const vectors: Float32Array[] = [];
  const BATCH = 50;
  for (let i = 0; i < memories.length; i += BATCH) {
    const chunk = memories.slice(i, i + BATCH);
    const texts = chunk.map((m) => embedTextFor(m, expansionFor(m)));
    const vecs = await provider.embed(texts);
    for (let j = 0; j < chunk.length; j++) {
      ids.push(chunk[j].fm.id);
      vectors.push(vecs[j]);
    }
    process.stderr.write(`  [${label}] embedded ${Math.min(i + BATCH, memories.length)}/${memories.length}\r`);
  }
  process.stderr.write("\n");
  return { ids, vectors };
}

// ── Arm policy application ────────────────────────────────────────────────────
// Mutate a Vault's in-memory frontmatter to the arm's BM25 policy: recall_when
// ALWAYS blanked; recall_when_expanded = own / foreign / [] depending on arm.
function applyArmPolicy(
  vault: Vault,
  arm: Arm,
  expandedById: Map<string, string[]>,
  foreignSourceFor: Map<string, string>,
): void {
  for (const m of vault.list()) {
    (m.fm as { recall_when: string[] }).recall_when = [];
    let expanded: string[] = [];
    if (arm === "own") {
      expanded = expandedById.get(m.fm.id) ?? [];
    } else if (arm === "foreign") {
      const src = foreignSourceFor.get(m.fm.id);
      expanded = src ? expandedById.get(src) ?? [] : [];
    }
    (m.fm as { recall_when_expanded?: string[] }).recall_when_expanded = expanded;
  }
}

interface ArmRow {
  meanDeltaRank: number;
  crossedIn: number;
  nearRegression: number;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { sample, full, embedExpansion } = parseArgs(process.argv.slice(2));
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bastra-doc2query-eval-"));

  // Mirror daemon env handling for the Ollama provider.
  const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
  const dimEnv = process.env.BASTRA_EMBEDDING_DIM;
  const parsedDim = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
  const dim = parsedDim !== undefined && Number.isFinite(parsedDim) ? parsedDim : undefined;
  const keepAlive = process.env.BASTRA_OLLAMA_KEEP_ALIVE ?? "10m";
  const provider = new OllamaEmbeddingProvider({ baseURL, model, dim, keepAlive });

  // ── Load a reference vault once to derive eligibility + the original fields ──
  const refVault = new Vault(VAULT_PATH!);
  await refVault.init();
  const vaultSize = refVault.size();

  // Snapshot ORIGINAL recall_when (mint/eval queries) and recall_when_expanded
  // (the doc2query payload) before any mutation.
  const originalRecallWhen = new Map<string, string[]>();
  const expandedById = new Map<string, string[]>();
  for (const m of refVault.list()) {
    originalRecallWhen.set(m.fm.id, [...m.fm.recall_when]);
    expandedById.set(m.fm.id, [...((m.fm as { recall_when_expanded?: string[] }).recall_when_expanded ?? [])]);
  }
  const phrasesOf = (id: string): string[] => originalRecallWhen.get(id) ?? [];
  const expandedOf = (id: string): string[] => expandedById.get(id) ?? [];

  // ── Eligible: ≥2 recall_when phrases AND a populated recall_when_expanded ───
  // (the doc2query arm needs something to add). Deterministic: first N by id.
  const eligibleAll = refVault
    .list()
    .filter((m) => phrasesOf(m.fm.id).length >= 2 && expandedOf(m.fm.id).length > 0)
    .sort((a, b) => (a.fm.id < b.fm.id ? -1 : a.fm.id > b.fm.id ? 1 : 0));
  const eligible = full ? eligibleAll : eligibleAll.slice(0, sample);
  const n = eligible.length;

  // Foreign permutation over the WHOLE vault (every memory, gold + distractor,
  // gets a foreign-paraphrase source). Deterministic (i+7)%N over sorted ids.
  const allSorted = refVault
    .list()
    .sort((a, b) => (a.fm.id < b.fm.id ? -1 : a.fm.id > b.fm.id ? 1 : 0));
  const N = allSorted.length;
  const foreignSourceFor = new Map<string, string>();
  for (let i = 0; i < N; i++) {
    foreignSourceFor.set(allSorted[i].fm.id, allSorted[(i + FOREIGN_OFFSET) % N].fm.id);
  }

  // ── Build the dense leg ──────────────────────────────────────────────────────
  // DEFAULT (production-faithful): doc2query is BM25-only → one shared vector set
  // (recall_when-stripped, NO paraphrases), reused by all three arms. The arms then
  // differ only in BM25. --embed-expansion: per-arm vectors that DO carry the arm's
  // paraphrases (the hypothetical both-legs lever production does not ship).
  process.stderr.write(
    `[dense] re-embedding ${vaultSize} memories (recall_when stripped${embedExpansion ? ", per-arm paraphrases appended" : ", shared/no paraphrases — production-faithful"})…\n`,
  );
  const armPersist: Record<Arm, string> = {
    off: path.join(tmpRoot, "vec-off.json"),
    own: path.join(tmpRoot, "vec-own.json"),
    foreign: path.join(tmpRoot, "vec-foreign.json"),
  };
  const memsForEmbed = refVault.list(); // original fm (recall_when omitted in embedTextFor)
  if (!embedExpansion) {
    const { ids, vectors } = await embedAll(provider, memsForEmbed, () => [], "shared");
    await writeVectorsJson(armPersist.off, provider, ids, vectors);
    await writeVectorsJson(armPersist.own, provider, ids, vectors);
    await writeVectorsJson(armPersist.foreign, provider, ids, vectors);
  } else {
    const offVecs = await embedAll(provider, memsForEmbed, () => [], "off");
    await writeVectorsJson(armPersist.off, provider, offVecs.ids, offVecs.vectors);
    const ownVecs = await embedAll(provider, memsForEmbed, (m) => expandedOf(m.fm.id), "own");
    await writeVectorsJson(armPersist.own, provider, ownVecs.ids, ownVecs.vectors);
    const foreignVecs = await embedAll(
      provider,
      memsForEmbed,
      (m) => expandedOf(foreignSourceFor.get(m.fm.id) ?? ""),
      "foreign",
    );
    await writeVectorsJson(armPersist.foreign, provider, foreignVecs.ids, foreignVecs.vectors);
  }
  process.stderr.write("[dense] done\n");

  // ── Build the three arm indexes (separate Vault per arm so their in-memory
  //    frontmatter policies don't collide) ─────────────────────────────────────
  async function buildArm(arm: Arm): Promise<{ search: SearchIndex; emb: EmbeddingIndex; vault: Vault }> {
    const vault = new Vault(VAULT_PATH!);
    await vault.init();
    applyArmPolicy(vault, arm, expandedById, foreignSourceFor);
    const search = new SearchIndex(vault);
    search.start(); // BM25: indexOne reads the policy'd recall_when_expanded → recall_when_expanded_flat
    const emb = new EmbeddingIndex(vault, provider, armPersist[arm]);
    await emb.start(); // load() picks up our injected vectors; nothing missing → no backfill
    search.useEmbeddings(emb);
    return { search, emb, vault };
  }
  const arms: Record<Arm, { search: SearchIndex; emb: EmbeddingIndex; vault: Vault }> = {
    off: await buildArm("off"),
    own: await buildArm("own"),
    foreign: await buildArm("foreign"),
  };

  // Sanity: confirm the injected vectors loaded (no silent backfill from buildEmbedText).
  for (const a of ["off", "own", "foreign"] as Arm[]) {
    if (arms[a].emb.size() < vaultSize) {
      process.stderr.write(
        `⚠ arm ${a}: only ${arms[a].emb.size()}/${vaultSize} vectors loaded — injection may have missed memories\n`,
      );
    }
  }

  // ── Eval cases: held-out phrases (phrase[1..]) of each eligible memory ──────
  interface EvalCase {
    goldId: string;
    query: string;
  }
  const cases: EvalCase[] = [];
  for (const m of eligible) {
    for (const q of phrasesOf(m.fm.id).slice(1)) {
      if (q && q.trim()) cases.push({ goldId: m.fm.id, query: q });
    }
  }

  // ── Run all three arms per eval query ──────────────────────────────────────
  interface Row {
    off: number;
    own: number;
    foreign: number;
    poolLen: number; // off-arm pool length (the per-query P for stratification)
  }
  const rows: Row[] = [];
  const poolLens: number[] = [];
  let identicalArms = 0; // sanity: how many cases produced identical off/own/foreign ranks
  for (const c of cases) {
    const off = await recallRank(arms.off.search, c.query, c.goldId);
    const own = await recallRank(arms.own.search, c.query, c.goldId);
    const foreign = await recallRank(arms.foreign.search, c.query, c.goldId);
    poolLens.push(off.poolLen);
    if (off.rank === own.rank && own.rank === foreign.rank) identicalArms++;
    rows.push({ off: off.rank, own: own.rank, foreign: foreign.rank, poolLen: off.poolLen });
  }

  // ── Stratify by OFF-arm baseline rank ───────────────────────────────────────
  const usedP = median(poolLens);
  const RANK_CAP = (Number.isFinite(usedP) ? usedP : 20) + 1;
  const capRank = (r: number): number => (Number.isFinite(r) ? r : RANK_CAP);

  const near: Row[] = [];
  const farInPool: Row[] = [];
  const oop: Row[] = [];
  for (const r of rows) {
    if (r.off <= S) near.push(r);
    else if (Number.isFinite(r.off) && r.off <= r.poolLen) farInPool.push(r);
    else oop.push(r);
  }

  function armRow(pick: (r: Row) => number): ArmRow {
    const deltas = oop.map((r) => capRank(pick(r)) - capRank(r.off));
    const crossed = oop.filter((r) => Number.isFinite(pick(r)) && pick(r) <= r.poolLen).length;
    const regressed = near.filter((r) => capRank(pick(r)) > capRank(r.off)).length;
    return {
      meanDeltaRank: mean(deltas),
      crossedIn: oop.length ? crossed / oop.length : NaN,
      nearRegression: near.length ? regressed / near.length : NaN,
    };
  }
  const ownArm = armRow((r) => r.own);
  const foreignArm = armRow((r) => r.foreign);

  // ── Verdict ─────────────────────────────────────────────────────────────────
  // null-relative NEAR rule (#129): charge a lever for NEAR-regression only above
  // what the FOREIGN null also pays — lever-specific harm, not generic churn.
  const ownShowsLift = ownArm.crossedIn > 0 || ownArm.meanDeltaRank < 0;
  const nearWithinNull = ownArm.nearRegression <= foreignArm.nearRegression;
  const beatsForeignCrossed = ownArm.crossedIn > foreignArm.crossedIn;
  const beatsForeignDelta = ownArm.meanDeltaRank < foreignArm.meanDeltaRank;
  const beatsForeign = beatsForeignCrossed && beatsForeignDelta;
  const promote = ownShowsLift && nearWithinNull && beatsForeign;

  // ── Print ──────────────────────────────────────────────────────────────────
  const pct = (x: number): string => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const num = (x: number): string => (Number.isNaN(x) ? "n/a" : x.toFixed(2));
  const tiny = (label: string, count: number): string =>
    count < 5 ? `  ⚠ DATA-STARVED: ${label} n=${count} (<5) — treat the number as noise` : "";

  const totalCases = near.length + farInPool.length + oop.length;
  const nearFrac = totalCases ? near.length / totalCases : NaN;

  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(" DOC2QUERY INDEX-SIDE LIFT (#117) — SIMULATED");
  console.log("  · recall_when_expanded index-side lift · recall_when held out · foreign-expansion null");
  console.log(" (recall_when-phrase drift — NOT real acted_on traffic)");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`  dense-leg mode : ${embedExpansion ? "--embed-expansion (paraphrases embedded too — HYPOTHETICAL both-legs)" : "production-faithful (doc2query BM25-ONLY; dense leg shared/identical across arms)"}`);
  console.log("  buildEmbedText finding : production embeddings.ts:buildEmbedText does NOT include");
  console.log("    recall_when_expanded → in shipped #117 the dense leg never sees the paraphrases.");
  console.log("");
  console.log(`  vault size (memories indexed) : ${vaultSize}`);
  console.log(`  eligible memories (≥2 recall_when AND has recall_when_expanded) : ${n}${full ? " [--full]" : ` [--sample ${sample}]`}`);
  console.log(`  eval queries (held-out phrase[1..]) : ${cases.length}`);
  console.log(`  arms : off (no expansion) · own (own paraphrases) · foreign ((i+${FOREIGN_OFFSET})%N paraphrases)`);
  console.log("");
  console.log(`  S (serving k / NEAR boundary) : ${S}`);
  console.log(`  P (candidate-pool length, median/used) : ${num(usedP)}  [pool = max(k*4,20); per-query P = its own pool length]`);
  console.log(`  Infinity-rank cap : ${RANK_CAP} (= used P + 1)`);
  console.log("");
  console.log("  per-slice n (by OFF-arm baseline gold rank):");
  console.log(`    NEAR        (rank ≤ ${S})         : ${near.length}  (${pct(nearFrac)})`);
  console.log(`    FAR-IN-POOL (${S} < rank ≤ P)      : ${farInPool.length}`);
  console.log(`    OOP         (rank > P / absent)  : ${oop.length}`);
  // Holdout sanity: recall_when held out → far queries → NEAR must not dominate.
  if (nearFrac >= 0.9) {
    console.log("");
    console.log(`  ⚠⚠ HOLDOUT SANITY: NEAR is ${pct(nearFrac)} (≥90%). recall_when may not be held out`);
    console.log("     of both legs — far queries aren't far. Distrust the gate below.");
  }
  // Arm-divergence sanity: if every case ranks identically across arms, the lever
  // isn't reaching retrieval (e.g. dense-only and paraphrases not embedded).
  const identicalFrac = cases.length ? identicalArms / cases.length : NaN;
  if (cases.length && identicalFrac >= 0.98) {
    console.log("");
    console.log(`  ⚠⚠ ARM-DIVERGENCE SANITY: ${pct(identicalFrac)} of cases rank IDENTICALLY across all`);
    console.log("     three arms — the doc2query lever is barely reaching retrieval. Distrust the gate.");
  } else {
    console.log(`  (arms produced identical rankings on ${pct(identicalFrac)} of cases — lever IS reaching retrieval)`);
  }
  for (const w of [tiny("OOP", oop.length), tiny("NEAR", near.length)]) if (w) console.log(w);
  console.log("");
  console.log("  ── GATE TABLE (focused on the OOP-at-baseline slice) ──────────────");
  console.log("");
  console.log("  arm        meanΔrank   crossed-in   near-regression");
  console.log("  ────────   ─────────   ──────────   ───────────────");
  console.log(
    `  own        ${num(ownArm.meanDeltaRank).padStart(9)}   ${pct(ownArm.crossedIn).padStart(10)}   ${pct(ownArm.nearRegression).padStart(15)}`,
  );
  console.log(
    `  foreign    ${num(foreignArm.meanDeltaRank).padStart(9)}   ${pct(foreignArm.crossedIn).padStart(10)}   ${pct(foreignArm.nearRegression).padStart(15)}`,
  );
  console.log("");
  console.log("  (meanΔrank: negative = lift. Infinity ranks capped at P+1.)");
  console.log("");
  console.log("  ── VERDICT (#117) ─────────────────────────────────────────────────");
  console.log(`    own shows OOP lift           : ${ownShowsLift ? "yes" : "no"}`);
  console.log(`    near-reg ≤ null              : ${nearWithinNull ? "yes" : "no"} (own ${pct(ownArm.nearRegression)} vs null ${pct(foreignArm.nearRegression)})`);
  console.log(`    own beats foreign (crossed-in): ${beatsForeignCrossed ? "yes" : "no"} (own ${pct(ownArm.crossedIn)} vs foreign ${pct(foreignArm.crossedIn)})`);
  console.log(`    own beats foreign (meanΔrank) : ${beatsForeignDelta ? "yes" : "no"} (own ${num(ownArm.meanDeltaRank)} vs foreign ${num(foreignArm.meanDeltaRank)})`);
  console.log("");
  console.log(`    >>> ${promote ? "PROMOTE" : "DO NOT PROMOTE"} <<<`);
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("");

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  for (const a of ["off", "own", "foreign"] as Arm[]) {
    arms[a].search.stop();
    arms[a].emb.stop();
    await arms[a].vault.stop();
  }
  await refVault.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
