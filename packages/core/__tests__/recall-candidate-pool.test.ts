/**
 * Tests for the #121 candidate-pool callback: recall exposes the DEEPER pool
 * (below the returned top-k) via opts.onCandidatePool, so the far slice — relevant
 * memories that ranked below k — is observable for offline bridge harvesting.
 *
 * #365/5 adds the cache-hit dimension: the far slice has to survive a warm
 * query cache. A hit used to return before any pool callback on the BM25 path
 * (nothing fired at all) and to replay the served k hits on the hybrid path
 * (depth 2 instead of 8) — so one priming caller made the below-k candidates
 * vanish for the whole 30s TTL.
 *
 * #365/16 adds the scale dimension: the pool used to carry RAW scores next to
 * damped served scores, and since the damping re-sorts, its order flipped
 * against the served one.
 *
 * Runner: node --import tsx --test packages/core/__tests__/recall-candidate-pool.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, type RecallHit } from "../src/index.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";

function memo(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body about ${title}.`,
    "",
  ].join("\n");
}

async function makeIndex(n: number): Promise<{ idx: SearchIndex; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-pool-test-"));
  // All memories share the term "alpha" so they all match; titles differ so they rank.
  for (let i = 0; i < n; i++) {
    await writeFile(join(dir, `m${i}.md`), memo(`m${i}`, `alpha topic ${i}`), "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  return { idx, dir };
}

test("recall exposes a deeper candidate pool than the returned top-k", async () => {
  const { idx, dir } = await makeIndex(8);
  try {
    let pool: RecallHit[] = [];
    const hits = idx.recall("alpha", { k: 2, onCandidatePool: (p) => (pool = p) });
    assert.equal(hits.length, 2, "returns the requested top-k");
    assert.ok(pool.length > hits.length, `pool (${pool.length}) must be deeper than k (${hits.length})`);
    assert.equal(pool.length, 8, "pool reaches all 8 below-k candidates (HOP_SEED_POOL = max(k*4, 20))");
    // The returned hits are the head of the pool (same ids, same order).
    assert.deepEqual(hits.map((h) => h.id), pool.slice(0, 2).map((h) => h.id));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("onCandidatePool is null-overhead when unset (recall still works)", async () => {
  const { idx, dir } = await makeIndex(3);
  try {
    const hits = idx.recall("alpha", { k: 2 });
    assert.equal(hits.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ─── #365/5: the pool has to survive a warm query cache ─────────────────────

/** Provider that can be switched to failing — a failing one at `start()` time
 *  leaves the index with zero vectors, which is the degraded-hybrid path. */
class PoolProvider implements EmbeddingProvider {
  readonly id = "pool-mock";
  readonly dim = 3;
  public failing = false;
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.failing) throw new Error("provider down");
    return texts.map(() => new Float32Array([1, 0, 0]));
  }
}

async function makeHybrid(
  n: number,
  opts: { failFromStart?: boolean } = {},
): Promise<{ idx: SearchIndex; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-pool-hybrid-"));
  for (let i = 0; i < n; i++) {
    await writeFile(join(dir, `m${i}.md`), memo(`m${i}`, `alpha topic ${i}`), "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();

  const provider = new PoolProvider();
  provider.failing = opts.failFromStart === true;
  const emb = new EmbeddingIndex(vault, provider, join(dir, ".bastra", "embeddings.json"));
  await emb.start();
  idx.useEmbeddings(emb);

  return {
    idx,
    close: async () => {
      await emb.stop();
      idx.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("#365/5: a BM25 cache hit replays the deep pool instead of firing nothing", async () => {
  const { idx, dir } = await makeIndex(8);
  try {
    const depths: number[] = [];
    const opts = { k: 2, onCandidatePool: (p: RecallHit[]) => depths.push(p.length) };
    // Callbacks vanish from JSON.stringify, so both calls share one cache key.
    idx.recall("alpha", opts);
    idx.recall("alpha", opts);
    assert.deepEqual(
      depths,
      [8, 8],
      "the warm call must expose the same depth as the cold one — it fired nothing at all before",
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#365/5: a hybrid cache hit replays the deep pool, not the served k", async () => {
  const { idx, close } = await makeHybrid(8);
  try {
    const depths: number[] = [];
    const opts = { k: 2, onCandidatePool: (p: RecallHit[]) => depths.push(p.length) };
    await idx.recallHybrid("alpha", opts);
    await idx.recallHybrid("alpha", opts);
    assert.deepEqual(depths, [8, 8], "the hit used to hand back the 2 served hits as the pool");
  } finally {
    await close();
  }
});

test("#365/5: a degraded-hybrid cache hit replays the deep pool too", async () => {
  // No vectors at all → the documented `vector-arm-empty` degradation, which
  // caches by design (#342). Its cache hit must carry the pool like the others.
  const { idx, close } = await makeHybrid(8, { failFromStart: true });
  try {
    const depths: number[] = [];
    const opts = { k: 2, onCandidatePool: (p: RecallHit[]) => depths.push(p.length) };
    const first = await idx.recallHybrid("alpha", opts);
    assert.ok(first.every((h) => h.mode === "bm25"), "precondition: degraded to BM25");
    await idx.recallHybrid("alpha", opts);
    assert.deepEqual(depths, [8, 8]);
  } finally {
    await close();
  }
});

// ─── #365/16: one score scale, one order ────────────────────────────────────

test("#365/16: the pool carries the damped scores in the served order", async () => {
  const { idx, dir } = await makeIndex(8);
  try {
    // Baseline: what m0 scores undamped.
    let rawPool: RecallHit[] = [];
    idx.recall("alpha", { k: 3, onCandidatePool: (p) => (rawPool = p) });
    const rawM0 = rawPool.find((h) => h.id === "m0")?.score;
    assert.ok(rawM0 !== undefined, "m0 must be in the pool");

    // Demote two of them — a score-only multiplier (#155) that also re-sorts.
    idx.setDemotions(["m0", "m1"]);
    let pool: RecallHit[] = [];
    const hits = idx.recall("alpha", { k: 3, onCandidatePool: (p) => (pool = p) });

    const dampedM0 = pool.find((h) => h.id === "m0")?.score;
    assert.ok(
      dampedM0 !== undefined && dampedM0 < rawM0,
      `the pool must show the damped score for a demoted memory (raw ${rawM0}, pool ${dampedM0})`,
    );

    const poolScores = new Map(pool.map((h) => [h.id, h.score]));
    for (const h of hits) {
      assert.equal(
        poolScores.get(h.id),
        h.score,
        `served hit ${h.id} and its pool entry must carry the same score`,
      );
    }
    assert.deepEqual(
      hits.map((h) => h.id),
      pool.slice(0, 3).map((h) => h.id),
      "the damping re-sorts, so the pool order must follow the served one",
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
