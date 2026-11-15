/**
 * Tests for recall score transparency (#230).
 *
 * The hybrid recall score is a scaled rank sum, not a similarity — a top hit is
 * high by construction, so a nonsense query still surfaces a high score. This
 * suite pins the two transparency additions:
 *
 * - `verbosity:"full"` exposes the per-hit `rrf` rank pair (rank_bm25 /
 *   rank_vector / raw); the lean default does NOT (context cost).
 * - a top-level `weak_result: true` fires on the HYBRID path when no returned
 *   hit has a recall_when or title match (the rank-1-of-nothing case), and is
 *   absent on a genuine match. The seam is hybrid-only: BM25-only recall never
 *   sets the flag.
 *
 * Uses a deterministic in-memory embedding provider (no network) so the vector
 * arm always returns ranked neighbours — the exact shape that lets a nonsense
 * query score high.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/recall-score-transparency.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, EmbeddingIndex, type EmbeddingProvider } from "@bastra-recall/core";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";

/** Deterministic provider (dim 4) — maps any text to a stable vector, so the
 *  vector arm returns ranked neighbours for every query, nonsense included. */
class FakeProvider implements EmbeddingProvider {
  readonly id = "fake-transparency";
  readonly dim = 4;
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return texts.map((t) => {
      const v = new Float32Array(4);
      for (let i = 0; i < t.length; i++) v[i % 4] += t.charCodeAt(i) / 1000;
      return v;
    });
  }
}

function memo(id: string, title: string, recallWhen: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title} summary text`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: transparency-test",
    "recall_when:",
    `  - ${recallWhen}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Harness {
  deps: ToolDeps;
  close: () => Promise<void>;
}

async function makeDeps(withEmbeddings: boolean): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-transparency-"));
  await writeFile(join(dir, "alpha.md"), memo("alpha", "alpha bravo", "alpha bravo lesson"), "utf8");
  await writeFile(join(dir, "charlie.md"), memo("charlie", "charlie delta", "charlie delta lesson"), "utf8");
  await writeFile(join(dir, "echo.md"), memo("echo", "echo foxtrot", "echo foxtrot lesson"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  let embIdx: EmbeddingIndex | null = null;
  if (withEmbeddings) {
    embIdx = new EmbeddingIndex(vault, new FakeProvider(), join(dir, ".bastra", "embeddings.json"));
    await embIdx.start();
    // Backfill is fire-and-forget — wait for the vectors so the vector arm runs.
    await waitFor(() => embIdx!.size() === 3);
    search.useEmbeddings(embIdx);
  }
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return {
    deps,
    close: async () => {
      // AWAIT the stop: since #240/B3 it drains the pending persist instead of
      // discarding it, so the write finishes before we pull the directory out
      // from under it. Unawaited, the rm raced the rename and failed the test
      // in teardown while every assertion had passed.
      await embIdx?.stop();
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

// A query that matches no title/recall_when/tag/body token in the fixture vault,
// so the BM25 arm is empty and only the (always-ranked) vector arm returns hits.
const NONSENSE = "quplx zmvnk wbrtj";

test("verbosity:full exposes the rrf rank pair; lean omits it", async () => {
  const { deps, close } = await makeDeps(true);
  try {
    const full = await recallHandler(deps, { query: "alpha bravo", verbosity: "full" });
    assert.ok(full.hits.length > 0, "expected hits");
    const fullHit = full.hits[0] as { rrf?: { rank_bm25: number | null; rank_vector: number | null; raw: number } };
    assert.ok(fullHit.rrf, "full hit must carry the rrf block");
    // Both fields are number|null and at least one arm ranked the hit.
    assert.ok(
      fullHit.rrf!.rank_bm25 !== null || fullHit.rrf!.rank_vector !== null,
      "at least one arm must have a rank"
    );
    assert.equal(typeof fullHit.rrf!.raw, "number", "raw RRF value present");
    assert.ok(fullHit.rrf!.raw > 0, "raw RRF value is positive");

    const lean = await recallHandler(deps, { query: "alpha bravo" });
    const leanHit = lean.hits[0] as { rrf?: unknown };
    assert.equal(leanHit.rrf, undefined, "lean hit must NOT carry rrf");
  } finally {
    await close();
  }
});

test("weak_result fires on a nonsense hybrid query, is absent on a genuine match", async () => {
  const { deps, close } = await makeDeps(true);
  try {
    // Nonsense: vector arm still returns ranked neighbours (rank-1-of-nothing),
    // but no hit has a recall_when or title match → weak_result.
    const weak = await recallHandler(deps, { query: NONSENSE });
    assert.ok(weak.hits.length > 0, "vector arm still surfaces hits for nonsense");
    assert.equal(weak.weak_result, true, "no lexical anchor on the hybrid path → weak_result");
    // The high score is rank-derived, not a similarity — the whole point of #230.
    assert.ok((weak.hits[0] as { score: number }).score > 30, "top hit sits well above the floor");

    // Genuine match: alpha's title + recall_when match → not weak.
    const strong = await recallHandler(deps, { query: "alpha bravo" });
    assert.equal(strong.weak_result, undefined, "a real recall_when/title match is not weak");
  } finally {
    await close();
  }
});

test("weak_result is hybrid-only — BM25-only recall never sets it", async () => {
  const { deps, close } = await makeDeps(false);
  try {
    // A genuine BM25 hit carries a lexical anchor anyway; the point here is that
    // the flag is gated on the hybrid path and stays absent without embeddings.
    const res = await recallHandler(deps, { query: "alpha bravo" });
    assert.ok(res.hits.length > 0, "BM25 path returns the genuine hit");
    assert.equal(res.weak_result, undefined, "BM25-only path must never set weak_result");
  } finally {
    await close();
  }
});
