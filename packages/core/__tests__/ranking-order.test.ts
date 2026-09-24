/**
 * #240/A7, A8, B1, B2 — the served result must be the top-k of the ranking
 * function the code actually defines, in the score space the thresholds assume.
 *
 *  A7: multipliers (lifecycle, curator, doc damping, salience) ran AFTER the
 *      top-k cut, so a fresh hit at k+1 could never displace an expired one
 *      inside the top-k.
 *  A8: the vault/scope filter ran AFTER the provider's global top-k, so scoped
 *      queries silently lost eligible candidates; and vectors of deleted
 *      memories were never pruned.
 *  B1: an empty vector arm still went through RRF, producing a one-armed score
 *      space (rank 1 = 81.967, rank 20 = 62.5) in which the documented
 *      MUST_LOAD band of 100 is unreachable.
 *  B2: the hybrid cache returned before emitting any stage and survived the
 *      vector arm becoming available.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";
import { progressIndexFor, type RecallStage } from "../src/recall-stages.js";

/** #542: white-box access to the private queue-drain — flushQueue is
 *  intentionally not public API, but these tests need deterministic timing
 *  around the embed backfill (soft `private`, so this compiles past TS only). */
function flush(emb: EmbeddingIndex): Promise<void> {
  return (emb as unknown as { flushQueue(): Promise<void> }).flushQueue();
}

function memoryMd(
  id: string,
  opts: { updated?: string; type?: string; marker?: string; scope?: string } = {},
): string {
  const marker = opts.marker ?? "ANCHORWORD";
  return `---
id: ${id}
title: ${id} ${marker}
type: ${opts.type ?? "lesson"}
summary: ${marker} summary
topic_path: [t]
tags: [t]
scope: ${opts.scope ?? "t"}
recall_when: ["${marker}"]
created: 2020-01-01
updated: ${opts.updated ?? "2026-07-01"}
---

Body ${marker} ${id}.
`;
}

class StubProvider implements EmbeddingProvider {
  readonly id = "mock";
  readonly dim = 3;
  public failing = false;
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.failing) throw new Error("provider down");
    return texts.map(() => new Float32Array([1, 0, 0]));
  }
}

async function vaultWith(
  t: { after: (fn: () => unknown) => void },
  files: Record<string, string>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-ranking-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  // Every EmbeddingIndex a test creates must be drained BEFORE the temp dir
  // goes away — it runs an async backfill and a debounced cache/vector
  // persist, and removing the directory underneath it made the suite fail in
  // teardown with ENOTEMPTY while the assertions themselves passed.
  const indexes: EmbeddingIndex[] = [];
  t.after(async () => {
    for (const idx of indexes) await idx.stop();
    search.stop();
    await vault.stop?.();
    // retry: a persist issued just before stop() may still be renaming.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const track = <T extends EmbeddingIndex>(idx: T): T => {
    indexes.push(idx);
    return idx;
  };
  return { dir, vault, search, track };
}

test("A7: k=1 returns the true top-1 after lifecycle damping, not before", async (t) => {
  // Two equally-matching notes: one scores higher raw but is long expired
  // (multiplier 0.2), the other is fresh. With the cut before the multiplier,
  // k=1 served the expired one.
  const { search } = await vaultWith(t, {
    "expired.md": memoryMd("expired-hi", { updated: "2020-01-01", marker: "ANCHORWORD ANCHORWORD" }),
    "fresh.md": memoryMd("fresh-lo", { updated: "2026-07-01", marker: "ANCHORWORD" }),
  });

  const top10 = search.recall("ANCHORWORD", { k: 10 });
  const trueTop = top10[0].id;

  const top1 = search.recall("ANCHORWORD", { k: 1 });
  assert.equal(top1.length, 1);
  assert.equal(
    top1[0].id,
    trueTop,
    `k=1 must serve the same winner as k=10 (got ${top1[0].id}, true top ${trueTop})`,
  );
  assert.equal(trueTop, "fresh-lo", "the fresh note must win once damping is applied");
});

test("A7: doc damping is applied before the cut too", async (t) => {
  const { search } = await vaultWith(t, {
    "doc.md": memoryMd("doc-hi", { type: "doc", marker: "ANCHORWORD ANCHORWORD" }),
    "lesson.md": memoryMd("lesson-lo", { marker: "ANCHORWORD" }),
  });

  const trueTop = search.recall("ANCHORWORD", { k: 10 })[0].id;
  assert.equal(search.recall("ANCHORWORD", { k: 1 })[0].id, trueTop);
});

test("A7: damping is applied once per endpoint, not compounded through a hop", async (t) => {
  // The A7 fix damped the seeds before collectOneHopNeighbors, which computes
  // `seed.score * 0.5 * link.score` — so an expired seed multiplied its
  // neighbours a second time (0.2 × 0.2 = 0.04) and a FRESH neighbour behind
  // an expired seed fell to 4% of its raw score.
  const relatedVia = (id: string) =>
    `related_via:\n  - id: ${id}\n    reason: cosine 1.000\n    score: 1`;

  const seed = (id: string, updated: string) => `---
id: ${id}
title: ${id} SEEDWORD
type: lesson
summary: SEEDWORD summary
topic_path: [t]
tags: [t]
scope: t
recall_when: ["SEEDWORD"]
${relatedVia(`${id}-neigh`)}
created: 2020-01-01
updated: ${updated}
---

Body SEEDWORD ${id}.
`;
  const neighbour = (id: string) => memoryMd(id, { updated: "2026-07-01", marker: "NEIGHWORD" });

  const fresh = await vaultWith(t, {
    "seed.md": seed("s-fresh", "2026-07-01"),
    "neigh.md": neighbour("s-fresh-neigh"),
  });
  const expired = await vaultWith(t, {
    "seed.md": seed("s-expired", "2020-01-01"),
    "neigh.md": neighbour("s-expired-neigh"),
  });

  const hopScore = (s: SearchIndex, id: string): number => {
    const hits = s.recall("SEEDWORD", { k: 5, expand_hops: 1 });
    const hop = hits.find((h) => h.id === id);
    assert.ok(hop, `expected the 1-hop neighbour ${id}, got ${JSON.stringify(hits.map((h) => h.id))}`);
    return hop.score;
  };

  const viaFresh = hopScore(fresh.search, "s-fresh-neigh");
  const viaExpired = hopScore(expired.search, "s-expired-neigh");

  // Both neighbours are equally fresh, so their own multiplier is 1.0 in both
  // runs. The seed's lifecycle must not leak into the neighbour's score.
  assert.equal(
    viaExpired,
    viaFresh,
    `a fresh neighbour must score the same regardless of the seed's age (fresh ${viaFresh}, via expired ${viaExpired})`,
  );
});

test("B1: an empty vector arm returns real BM25 scores, not one-armed RRF", async (t) => {
  const { dir, vault, search, track } = await vaultWith(t, {
    "a.md": memoryMd("note-a", { marker: "ANCHORWORD" }),
    "b.md": memoryMd("note-b", { marker: "ANCHORWORD" }),
  });

  const provider = new StubProvider();
  const emb = track(new EmbeddingIndex(vault, provider, path.join(dir, ".bastra", "embeddings.json")));
  await emb.start();
  search.useEmbeddings(emb);

  const pureBm25 = search.recall("ANCHORWORD", { k: 5 });
  provider.failing = true;
  const degraded = await search.recallHybrid("ANCHORWORD", { k: 5 });

  assert.equal(degraded[0].id, pureBm25[0].id);
  assert.equal(
    degraded[0].score,
    pureBm25[0].score,
    "a degraded recall must live in the BM25 score space the thresholds assume",
  );
  assert.equal(degraded[0].mode, "bm25");
  // The one-armed RRF ceiling was 5000/61 — anything at or below that for a
  // rank-1 hit means we are back in the broken space.
  assert.notEqual(Math.round(degraded[0].score * 1000), Math.round(81.967 * 1000));
});

test("B1: the degraded fallback emits one monotonic stage sequence", async (t) => {
  // The first B1 fix re-entered the public recall(), which opened a second
  // StageEmitter on the same callback: bm25.search fired twice, progress
  // jumped backwards, and a warm inner cache reported the whole hybrid
  // attempt as a cache hit with zero candidate-pool callbacks.
  const { dir, vault, search, track } = await vaultWith(t, {
    "a.md": memoryMd("note-a", { marker: "ANCHORWORD" }),
  });
  const provider = new StubProvider();
  const emb = track(new EmbeddingIndex(vault, provider, path.join(dir, ".bastra", "e.json")));
  await emb.start();
  search.useEmbeddings(emb);
  provider.failing = true;

  const run = async () => {
    // start events carry no durationMs; end/one-shot events do. Counting
    // starts gives executions, counting all gives one-shots like `done`.
    const starts: string[] = [];
    const all: string[] = [];
    let pool = 0;
    await search.recallHybrid("ANCHORWORD", {
      k: 5,
      onStage: (s) => {
        all.push(s.name);
        if (s.durationMs === undefined) starts.push(s.name);
      },
      onCandidatePool: () => {
        pool++;
      },
    });
    return { starts, all, pool };
  };

  const cold = await run();
  assert.equal(
    cold.starts.filter((s) => s === "bm25.search").length,
    1,
    `bm25.search must run once, saw ${JSON.stringify(cold.all)}`,
  );
  assert.equal(cold.all.filter((s) => s === "done").length, 1, "exactly one done");
  assert.equal(cold.pool, 1, "exactly one candidate-pool callback");
  assert.ok(!cold.all.includes("cache.hit"), "a live degraded run is not a cache hit");

  // Warm the pure-BM25 cache, then degrade again — the old code reported the
  // whole attempt as a cache hit and skipped the candidate pool entirely.
  search.recall("ANCHORWORD", { k: 5 });
  const warm = await run();
  assert.equal(warm.pool, 1, "the candidate pool must still fire with a warm inner cache");
  assert.equal(warm.all.filter((s) => s === "done").length, 1);
});

test("B2: a hybrid cache hit still emits stages and the candidate pool", async (t) => {
  const { dir, vault, search, track } = await vaultWith(t, {
    "a.md": memoryMd("note-a", { marker: "ANCHORWORD" }),
  });
  const emb = track(new EmbeddingIndex(vault, new StubProvider(), path.join(dir, ".bastra", "e.json")));
  await emb.start();
  search.useEmbeddings(emb);

  await search.recallHybrid("ANCHORWORD", { k: 5 });

  const stages: string[] = [];
  let poolCalls = 0;
  await search.recallHybrid("ANCHORWORD", {
    k: 5,
    onStage: (s) => stages.push(s.name),
    onCandidatePool: () => {
      poolCalls++;
    },
  });

  assert.ok(stages.includes("cache.hit"), `cache.hit missing, saw ${JSON.stringify(stages)}`);
  assert.ok(stages.includes("done"), "done missing on a cache hit");
  assert.equal(poolCalls, 1, "the candidate pool must still reach the harvester");
});

test("B2: a result cached while the vector arm was empty does not survive recovery", async (t) => {
  const { dir, vault, search, track } = await vaultWith(t, {
    "a.md": memoryMd("note-a", { marker: "ANCHORWORD" }),
  });
  const provider = new StubProvider();
  provider.failing = true;
  const emb = track(new EmbeddingIndex(vault, provider, path.join(dir, ".bastra", "e.json")));
  await emb.start();
  search.useEmbeddings(emb);

  const degraded = await search.recallHybrid("ANCHORWORD", { k: 5 });
  assert.equal(degraded[0].mode, "bm25");

  // Provider recovers and the backfill lands — the same query must not keep
  // serving the degraded result for the rest of the cache TTL.
  provider.failing = false;
  // #542: EmbeddingIndex has no `embedMissing` — that call was a silent
  // no-op (optional chaining on a property that never existed); flushQueue
  // alone drains the pending backfill.
  await flush(emb);

  const recovered = await search.recallHybrid("ANCHORWORD", { k: 5 });
  assert.equal(recovered[0].mode, "hybrid", "recovery must invalidate the degraded cache entry");
});

test("A8: orphan vectors are pruned at start", async (t) => {
  const { dir, vault } = await vaultWith(t, { "a.md": memoryMd("note-a") });

  const persistPath = path.join(dir, ".bastra", "embeddings.json");
  const emb1 = new EmbeddingIndex(vault, new StubProvider(), persistPath);
  await emb1.start();
  await flush(emb1);
  emb1.stop();

  // A memory deleted while the daemon was down: the file is gone, but its
  // vector is still in the persisted index.
  await rm(path.join(dir, "a.md"));
  const vault2 = new Vault(dir);
  await vault2.init();
  const emb2 = new EmbeddingIndex(vault2, new StubProvider(), persistPath);
  await emb2.start();
  t.after(() => emb2.stop());

  assert.equal(emb2.size(), 0, "a vector without a memory must not survive start()");
  assert.equal(emb2.findSimilarById("note-a"), null);
});

test("A8: a scoped query is not truncated by the global vector cut", async (t) => {
  // One tiny scope drowned in a large one: with the filter running after a
  // fixed global top-k, the small scope loses candidates it should keep.
  const files: Record<string, string> = {};
  for (let i = 0; i < 150; i++) {
    files[`big-${i}.md`] = memoryMd(`big-${i}`, { scope: "big" });
  }
  for (let i = 0; i < 5; i++) {
    files[`small-${i}.md`] = memoryMd(`small-${i}`, { scope: "small" });
  }
  const { dir, vault, search, track } = await vaultWith(t, files);

  const emb = track(new EmbeddingIndex(vault, new StubProvider(), path.join(dir, ".bastra", "e.json")));
  await emb.start();
  await flush(emb);
  search.useEmbeddings(emb);

  const hits = await search.recallHybrid("ANCHORWORD", { k: 5, scope: "small" });
  assert.equal(hits.length, 5, `expected all 5 in-scope memories, got ${hits.length}`);
  assert.ok(hits.every((h) => h.id.startsWith("small-")));
});

test("B1/A7: MCP progress never moves backwards, on any path", async (t) => {
  // The A7 reorder put staleness.rank ahead of hops.expand, but
  // RECALL_STAGE_ORDER still listed hops.expand first — so progressIndexFor()
  // reported 7 and then 6 and the progress bar jumped back. The earlier test
  // counted stages but never asserted their order.
  const relatedVia = `related_via:\n  - id: note-b\n    reason: cosine 1.000\n    score: 1`;
  const seeded = `---\nid: note-a\ntitle: note-a ANCHORWORD\ntype: lesson\nsummary: ANCHORWORD summary\ntopic_path: [t]\ntags: [t]\nscope: t\nrecall_when: ["ANCHORWORD"]\n${relatedVia}\ncreated: 2020-01-01\nupdated: 2026-07-01\n---\n\nBody ANCHORWORD note-a.\n`;

  const { dir, vault, search, track } = await vaultWith(t, {
    "a.md": seeded,
    "b.md": memoryMd("note-b", { marker: "ANCHORWORD" }),
  });

  const monotonic = (label: string, names: RecallStage["name"][]) => {
    const idx = names.map(progressIndexFor);
    for (let i = 1; i < idx.length; i++) {
      assert.ok(
        idx[i] >= idx[i - 1],
        `${label}: progress went backwards — ${names.join(" → ")} = ${idx.join(" → ")}`,
      );
    }
  };

  // #542: onStage's real parameter is RecallStage (StageListener) — names
  // kept RecallStage["name"][] so it feeds progressIndexFor without a cast.
  const collect = (): { names: RecallStage["name"][]; onStage: (s: RecallStage) => void } => {
    const names: RecallStage["name"][] = [];
    return { names, onStage: (s) => { if (s.durationMs !== undefined) names.push(s.name); } };
  };

  // BM25, with hops
  const bm = collect();
  search.recall("ANCHORWORD", { k: 5, expand_hops: 1, onStage: bm.onStage });
  monotonic("bm25+hops", bm.names);

  const provider = new StubProvider();
  const emb = track(new EmbeddingIndex(vault, provider, path.join(dir, ".bastra", "e.json")));
  await emb.start();
  search.useEmbeddings(emb);

  // Hybrid, with hops
  const hy = collect();
  await search.recallHybrid("ANCHORWORD", { k: 5, expand_hops: 1, onStage: hy.onStage });
  monotonic("hybrid+hops", hy.names);

  // Degraded fallback, with hops
  provider.failing = true;
  const dg = collect();
  await search.recallHybrid("ANCHORWORD ANCHORWORD", { k: 5, expand_hops: 1, onStage: dg.onStage });
  monotonic("degraded+hops", dg.names);
});
