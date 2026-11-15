/**
 * Per-arm deadline for the dense leg (#342).
 *
 * The two arms have measurably different cost profiles but shared one deadline:
 * BM25 is an in-memory MiniSearch pass, the dense arm needs a warm embedding
 * model. #305 measured the gap on a real host — 734ms for the first call after
 * the model was evicted against ~161ms warm, under a 600ms hook budget. The
 * failure that produced was not "slower recall": the whole call missed the
 * budget, the hook returned nothing, and the turn continued as if there had
 * been nothing to say — while the BM25 arm had had its answer ready for 700ms.
 *
 * What these tests pin:
 *   1. the deadline expires into the EXISTING degradation path, so scores stay
 *      in the BM25 space (one-armed RRF is a different space — see #240/B1)
 *   2. `degraded: "vector-arm-timeout"` is distinguishable from the pre-existing
 *      `"vector-arm-empty"`, so the expiry rate is observable rather than
 *      showing up as quietly worse recall
 *   3. a timeout degradation is NOT cached — the cache key varies on
 *      `embeddings.size()`, which a cold model does not change, so caching a
 *      one-armed answer would freeze it for the whole TTL (the trap #240/B2
 *      closed for the boot window, reachable again through this door)
 *   4. the abandoned embed KEEPS RUNNING — the model finishes loading on the
 *      call that gave up on it, which is the only reason the next call is warm.
 *      Cancelling would re-pay the cold start forever.
 *
 * Runner: node --import tsx --test packages/core/__tests__/vector-arm-deadline.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";
import type { StageListener } from "../src/recall-stages.js";
import { abandonAfter } from "../src/deadline.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function memoryMd(id: string, marker = "ANCHORWORD"): string {
  return `---
id: ${id}
title: ${id} ${marker}
type: lesson
summary: ${marker} summary
topic_path: [t]
tags: [t]
scope: t
recall_when: ["${marker}"]
created: 2020-01-01
updated: 2026-07-01
---

Body ${marker} ${id}.
`;
}

/** Provider with a settable delay — stands in for a cold vs. warm model. */
class SlowProvider implements EmbeddingProvider {
  readonly id = "slow-mock";
  readonly dim = 3;
  /** Delay per embed call. 0 = warm. */
  public delayMs = 0;
  /** Calls STARTED — includes ones whose caller has already walked away. */
  public started = 0;
  /** Calls that ran to completion. The gap to `started` is what proves an
   *  abandoned call was left running rather than cancelled. */
  public completed = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.started++;
    if (this.delayMs > 0) await sleep(this.delayMs);
    this.completed++;
    return texts.map(() => new Float32Array([1, 0, 0]));
  }
}

async function hybridFixture(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-deadline-"));
  await writeFile(path.join(dir, "a.md"), memoryMd("alpha"), "utf8");
  await writeFile(path.join(dir, "b.md"), memoryMd("beta"), "utf8");

  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();

  const provider = new SlowProvider();
  const emb = new EmbeddingIndex(vault, provider, path.join(dir, ".bastra", "embeddings.json"));
  await emb.start();
  search.useEmbeddings(emb);

  t.after(async () => {
    await emb.stop();
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  return { search, provider, emb };
}

/** Collect the `done` stage event so the degradation reason is assertable.
 *  The field is `name`, not `stage` (see RecallStage in recall-stages.ts) —
 *  getting that wrong makes every `degraded: undefined` assertion below pass
 *  for the wrong reason, so `seen` starts as a sentinel that fails loudly. */
function doneCollector(): {
  onStage: StageListener;
  meta: () => Record<string, unknown>;
} {
  let seen: Record<string, unknown> | null = null;
  return {
    onStage: (e) => {
      if (e.name === "done") seen = e.meta ?? {};
    },
    meta: () => {
      assert.ok(seen !== null, "no `done` stage event was observed — collector is not wired up");
      return seen;
    },
  };
}

// ─── abandonAfter: the primitive ────────────────────────────────────────────

test("abandonAfter: resolves with the value when the work beats the deadline", async () => {
  const got = await abandonAfter(Promise.resolve("fast"), 1000);
  assert.equal(got, "fast");
});

test("abandonAfter: resolves null when the deadline wins, and does NOT cancel", async () => {
  let finished = false;
  const slow = sleep(120).then(() => {
    finished = true;
    return "slow";
  });

  const got = await abandonAfter(slow, 20);
  assert.equal(got, null, "expiry hands back null");
  assert.equal(finished, false, "not finished yet — we walked away mid-flight");

  await slow;
  assert.equal(finished, true, "the abandoned work ran to completion; it was never cancelled");
});

test("abandonAfter: deadline <= 0 disables the deadline (kill switch)", async () => {
  const got = await abandonAfter(
    sleep(30).then(() => "waited"),
    0
  );
  assert.equal(got, "waited", "0 must wait indefinitely — the pre-#342 behaviour");
});

test("abandonAfter: a rejection on an abandoned arm does not escape", async () => {
  // Node's default is to terminate on an unhandled rejection, and this runs
  // inside short-lived hook processes — an abandoned arm must never be able to
  // take the process down after its caller has moved on.
  const boom = sleep(20).then(() => {
    throw new Error("arm failed after we walked away");
  });
  const got = await abandonAfter(boom, 5);
  assert.equal(got, null);
  await sleep(60); // give the rejection time to surface if it were unhandled
});

// ─── recallHybrid: the wiring ───────────────────────────────────────────────

test("#342: a slow dense arm degrades to BM25 instead of expiring the whole call", async (t) => {
  const { search, provider } = await hybridFixture(t);
  provider.delayMs = 300;

  const collector = doneCollector();
  const started = Date.now();
  const hits = await search.recallHybrid("ANCHORWORD", {
    k: 5,
    vector_deadline_ms: 40,
    onStage: collector.onStage,
  });
  const elapsed = Date.now() - started;

  assert.ok(hits.length > 0, "the cheap arm's answer must be served, not dropped");
  assert.ok(elapsed < 250, `must return on the deadline, not on the dense arm (took ${elapsed}ms against a 300ms arm)`);
  assert.equal(
    collector.meta().degraded,
    "vector-arm-timeout",
    "the expiry must be distinguishable from an empty vector arm"
  );
  assert.ok(
    hits.every((h) => h.mode === "bm25"),
    "degradation goes through the BM25 path, so scores stay in the BM25 space (#240/B1)"
  );
});

test("#342: the abandoned embed keeps running, so the next call is warm", async (t) => {
  const { search, provider } = await hybridFixture(t);
  provider.delayMs = 200;
  const startedBefore = provider.started;
  const completedBefore = provider.completed;

  await search.recallHybrid("ANCHORWORD", { k: 5, vector_deadline_ms: 20 });

  assert.equal(provider.started, startedBefore + 1, "the dense arm was dispatched");
  assert.equal(
    provider.completed,
    completedBefore,
    "and had not finished when we returned — we really did walk away mid-flight"
  );

  await sleep(320);
  assert.equal(
    provider.completed,
    completedBefore + 1,
    "the abandoned embed still completed; cancelling it would re-pay the cold load every call"
  );
});

test("#342: a timeout degradation is not cached", async (t) => {
  const { search, provider } = await hybridFixture(t);

  // First call: dense arm too slow, degrades to BM25.
  provider.delayMs = 300;
  const cold = await search.recallHybrid("ANCHORWORD", { k: 5, vector_deadline_ms: 40 });
  assert.ok(
    cold.every((h) => h.mode === "bm25"),
    "precondition: first call degraded"
  );

  // Model is warm now. The identical query must NOT be served the one-armed
  // answer from cache — the cache key varies on embeddings.size(), which a cold
  // model does not change, so nothing else would invalidate it for the full TTL.
  provider.delayMs = 0;
  const warm = await search.recallHybrid("ANCHORWORD", { k: 5, vector_deadline_ms: 400 });
  assert.ok(
    warm.some((h) => h.mode !== "bm25"),
    "the warm re-query must reach the dense arm, not replay the cached degradation"
  );
});

test("#342: a warm dense arm is unaffected by the deadline", async (t) => {
  const { search, provider } = await hybridFixture(t);
  provider.delayMs = 0;

  const collector = doneCollector();
  const hits = await search.recallHybrid("ANCHORWORD", {
    k: 5,
    vector_deadline_ms: 400,
    onStage: collector.onStage,
  });

  assert.ok(hits.length > 0);
  assert.equal(collector.meta().degraded, undefined, "no degradation on the warm path");
  assert.ok(
    hits.some((h) => h.mode !== "bm25"),
    "the dense arm contributed"
  );
});

test("#342: no deadline set keeps the pre-existing behaviour", async (t) => {
  const { search, provider } = await hybridFixture(t);
  provider.delayMs = 120;

  const collector = doneCollector();
  const hits = await search.recallHybrid("ANCHORWORD", { k: 5, onStage: collector.onStage });

  assert.equal(collector.meta().degraded, undefined, "unset deadline must wait for the dense arm");
  assert.ok(
    hits.some((h) => h.mode !== "bm25"),
    "the dense arm was awaited to completion"
  );
});
