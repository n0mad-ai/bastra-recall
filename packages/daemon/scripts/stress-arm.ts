/**
 * Search arm construction for the stress harness (#261).
 *
 * Split out of eval-stress.ts: building the arm is its own responsibility and
 * carries the M0 gate that the rest of the harness merely consumes — "no
 * silent arm fallback". Everything about which engine legs are live lives
 * here; the harness only asks for a `Recaller`.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, EmbeddingIndex, OllamaEmbeddingProvider } from "@bastra-recall/core";
import type { RecallHit, RecallOptions } from "@bastra-recall/core";

// ── Search wrapper (sync BM25 by default, async hybrid optional) ───

export type Recaller = (query: string, opts?: RecallOptions) => Promise<RecallHit[]>;

export function makeRecaller(search: SearchIndex, hybrid: boolean): Recaller {
  if (hybrid && search.hasEmbeddings()) {
    return (q, opts) => search.recallHybrid(q, opts);
  }
  return async (q, opts) => search.recall(q, opts);
}

// ── Hybrid arm (M0 gate, #261) ─────────────────────────────────
//
// Until now `--hybrid` was structurally BM25: makeRecaller asked
// `search.hasEmbeddings()`, but nothing ever called `useEmbeddings()`, so the
// answer was always false and the arm reported BM25 numbers under a hybrid
// label. Every measurement taken through that flag was mislabelled.
//
// The M0 gate is "no silent arm fallback": if the hybrid arm cannot be built,
// the run aborts. It never degrades to BM25 and calls itself hybrid.
//
// The index is built from a COPY of the vault's vector store. A measurement
// must not mutate what it measures — starting an EmbeddingIndex backfills
// missing vectors and persists them, and an eval run has no business
// rewriting the production store.

/** Bound on the cold-store backfill — long enough for a real vault, short
 *  enough that a stuck provider fails the run instead of hanging it. */
export const HYBRID_BACKFILL_TIMEOUT_MS = 15 * 60 * 1000;

export interface HybridArm {
  provider: string;
  loadedVectors: number;
  backfilled: number;
  cleanup: () => Promise<void>;
}

export function providerFromEnv(): OllamaEmbeddingProvider {
  const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
  const dimEnv = process.env.BASTRA_EMBEDDING_DIM;
  const parsedDim = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
  const dim = parsedDim !== undefined && Number.isFinite(parsedDim) ? parsedDim : undefined;
  const keepAlive = process.env.BASTRA_OLLAMA_KEEP_ALIVE ?? "10m";
  return new OllamaEmbeddingProvider({ baseURL, model, dim, keepAlive });
}

export async function attachHybrid(vault: Vault, search: SearchIndex, vaultPath: string): Promise<HybridArm> {
  const provider = providerFromEnv();
  const tmpRoot = await mkdtemp(join(tmpdir(), "bastra-stress-hybrid-"));
  const persistPath = join(tmpRoot, "embeddings.json");
  const cleanup = () => rm(tmpRoot, { recursive: true, force: true });

  // Work on a copy of the production store when there is one; otherwise the
  // index embeds from scratch and we say so in the report.
  const source = join(vaultPath, ".bastra", "embeddings.json");
  let hadStore = false;
  try {
    await copyFile(source, persistPath);
    hadStore = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      await cleanup();
      throw new Error(`--hybrid: cannot read the vector store at ${source}: ${(e as Error).message}`);
    }
  }

  // Probe FIRST. EmbeddingIndex.start() swallows a provider failure — it logs
  // "batch error, requeue" and keeps retrying — so an unreachable provider
  // would show up only as a backfill that never finishes, i.e. as a fifteen
  // minute hang followed by a confusing size error. One embed call up front
  // turns that into an immediate, honest failure.
  const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  try {
    await provider.embed(["probe"]);
  } catch (e) {
    await cleanup();
    throw new Error(
      `--hybrid: the embedding provider is unreachable (${provider.id} at ${baseURL}): ${(e as Error).message}\n` +
        `The hybrid arm cannot be built, and a BM25 run must not be reported as hybrid.`,
    );
  }

  const emb = new EmbeddingIndex(vault, provider, persistPath);
  await emb.start();

  // start() fires the backfill with `void flushQueue()` and returns before the
  // vectors land, so size() is 0 at this point on a cold store. There is no
  // public way to await it — poll, bounded, and say what is happening.
  const atStart = emb.size();
  const want = vault.size();
  const deadline = Date.now() + HYBRID_BACKFILL_TIMEOUT_MS;
  let loaded = atStart;
  while (loaded < want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const now = emb.size();
    if (now !== loaded) console.error(`[stress] embedding ${now}/${want}…`);
    loaded = now;
  }

  if (loaded < want) {
    emb.stop();
    await cleanup();
    throw new Error(
      `--hybrid: only ${loaded}/${want} memories carry a vector after ` +
        `${Math.round(HYBRID_BACKFILL_TIMEOUT_MS / 1000)}s. The dense leg would be blind for the rest, ` +
        `so the arm is not hybrid for the whole vault.\n` +
        `Let the daemon finish embedding the vault, then run again — a partially embedded arm is not a measurement.`,
    );
  }

  search.useEmbeddings(emb);
  if (!search.hasEmbeddings()) {
    emb.stop();
    await cleanup();
    throw new Error("--hybrid: useEmbeddings() did not take effect — refusing to report BM25 as hybrid.");
  }

  return {
    provider: `Hybrid (BM25 + Vector RRF) · ${provider.id} · dim ${provider.dim} · ` +
      `store ${hadStore ? "copied from vault" : "embedded fresh"}` +
      (loaded > atStart ? ` · ${loaded - atStart} backfilled for this run` : ""),
    loadedVectors: loaded,
    backfilled: loaded - atStart,
    cleanup: async () => {
      emb.stop();
      await cleanup();
    },
  };
}

// ── Control arm (M0 gate, #261) ────────────────────────────────
//
// The floor every real arm has to clear. It ranks candidates at random, so
// its Recall@k is what the metric reports when there is no retrieval signal
// at all. Without it a number like "45.2% Recall@3" has no scale: nobody can
// say whether it is retrieval or the shape of the gold set.
//
// Seeded, because a control arm that moves between runs is not a control.

/** Deterministic 32-bit PRNG (mulberry32) — no dependency, same draw everywhere. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sattolo's algorithm: a seeded uniform CYCLIC permutation, i.e. a derangement.
 *
 * Fisher-Yates draws a uniform permutation, which has one fixed point in
 * expectation for any N — and a fixed point in a label shuffle is a pairing
 * that was never broken. At the default seed the 25-case paraphrase fixture had
 * exactly one, so 4 of the 100 null rows carried the TRUE query/gold pairing
 * and were scored as genuine hits. The null read ~4% against a true expectation
 * near 0.5%.
 *
 * The one-token difference from Fisher-Yates is `rnd() * i` instead of
 * `rnd() * (i + 1)` — j is drawn strictly below i, so nothing can stay put.
 */
export function seededDerangement<T>(items: readonly T[], seed: number): T[] {
  const rnd = seededRandom(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Fisher-Yates against a seeded draw. Returns a new array. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rnd = seededRandom(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A Recaller that ignores the query and returns a seeded random ranking of the
 * vault. Scores descend so downstream rank logic behaves normally; they carry
 * no meaning beyond ordering.
 *
 * The permutation is drawn per query (seed mixed with the query string), not
 * once per run — a single fixed order would accidentally favour whichever gold
 * ids happen to sit near its front.
 */
export function makeControlRecaller(vault: Vault, seed: number): Recaller {
  const ids = vault.list().map((m) => m.fm.id);
  return async (query, opts) => {
    let mix = seed >>> 0;
    for (let i = 0; i < query.length; i++) mix = (Math.imul(mix, 31) + query.charCodeAt(i)) >>> 0;
    const k = opts?.k ?? 10;
    const ranked = seededShuffle(ids, mix)
      .slice(0, k)
      .map((id, i) => ({ id, score: k - i }) as RecallHit);
    // Honour the pool hook so the region split is computed the same way for
    // the control arm as for the measured one. For a random ranker the regions
    // are exactly what one would expect — which is the point of a floor.
    opts?.onCandidatePool?.(ranked);
    return ranked;
  };
}

