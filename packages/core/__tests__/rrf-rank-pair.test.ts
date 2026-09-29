/**
 * Tests for the RRF rank pair exposed by `fuseRRF` (#230).
 *
 * The hybrid recall score is a RANK quantity, not a similarity: `fuseRRF` sums
 * `1/(RRF_K + rank)` across the BM25 and vector arms, and `recallHybrid` scales
 * the result by `RRF_SCALE` into a BM25-looking range. This test pins that the
 * fused entry carries the per-arm rank pair (1-based, null when an arm did not
 * return the hit) alongside the raw RRF value, so a caller can decompose any
 * score — and it pins the two structural anchors from the field report: rank 1
 * in both arms is the ceiling (≈163.934), rank 1 in one arm only is ≈81.967.
 *
 * Those two anchors are written against the SCALED score on purpose. `RRF_K`
 * moved from 60 to 5 to stop the damping constant from swamping the rank, and
 * `RRF_SCALE` is tied to it precisely so these numbers do not move with it: the
 * fusion reorders results, it does not re-denominate scores. A change that
 * shifts 163.934 or 81.967 is a change to every band downstream, and this test
 * is where it should fail first.
 *
 * #641: since v1.0.1 the default dense-arm weight is 1.5. The equal-weight
 * arithmetic below is pinned at an explicit weight 1; the last test pins what
 * the default does to the one-armed anchor (the ceiling does not move).
 *
 * Runner: node --import tsx --test packages/core/__tests__/rrf-rank-pair.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseRRF, RRF_K, RRF_SCALE } from "../src/index.js";

const rrf = (rank: number): number => 1 / (RRF_K + rank); // rank is 1-based

test("fuseRRF: 1-based rank pair per arm, null when an arm did not return the hit", () => {
  // bm25 order: a, b, c   |   vector order: b, x
  const fused = fuseRRF(["a", "b", "c"], ["b", "x"], RRF_K, 1);

  const a = fused.get("a")!;
  assert.equal(a.rank_bm25, 1, "a is first in the bm25 arm");
  assert.equal(a.rank_vector, null, "a is absent from the vector arm");
  assert.ok(Math.abs(a.score - rrf(1)) < 1e-12, "a score is a single-arm RRF value");

  const b = fused.get("b")!;
  assert.equal(b.rank_bm25, 2, "b is second in the bm25 arm");
  assert.equal(b.rank_vector, 1, "b is first in the vector arm");
  assert.ok(Math.abs(b.score - (rrf(2) + rrf(1))) < 1e-12, "b score sums both arms");

  const c = fused.get("c")!;
  assert.equal(c.rank_bm25, 3);
  assert.equal(c.rank_vector, null);

  const x = fused.get("x")!;
  assert.equal(x.rank_bm25, null, "x is absent from the bm25 arm");
  assert.equal(x.rank_vector, 2, "x is second in the vector arm");
});

test("fuseRRF: raw value is the sum that RRF_SCALE turns into the reported score", () => {
  const fused = fuseRRF(["only"], ["only"]);
  const e = fused.get("only")!;
  // raw is the unscaled RRF sum; recallHybrid multiplies it by RRF_SCALE for `score`.
  assert.ok(Math.abs(e.score - 2 * rrf(1)) < 1e-12);
});

test("fuseRRF: structural anchors — rank1+rank1 ceiling ≈163.934, one-arm ≈81.967", () => {
  const both = fuseRRF(["top"], ["top"]).get("top")!;
  assert.ok(Math.abs(both.score * RRF_SCALE - 163.934) < 0.01, "rank 1 in both arms is the ceiling");

  const oneArm = fuseRRF(["solo"], [], RRF_K, 1).get("solo")!;
  assert.equal(oneArm.rank_vector, null);
  assert.ok(Math.abs(oneArm.score * RRF_SCALE - 81.967) < 0.01, "rank 1 in a single arm sits near 82");
});

test("fuseRRF: at the default dense weight 1.5 the one-armed anchor splits by arm (#641)", () => {
  const both = fuseRRF(["top"], ["top"]).get("top")!;
  assert.ok(Math.abs(both.score * RRF_SCALE - 163.934) < 0.01, "the ceiling does not move");
  const bm25Only = fuseRRF(["solo"], []).get("solo")!;
  const denseOnly = fuseRRF([], ["solo"]).get("solo")!;
  assert.ok(Math.abs(bm25Only.score * RRF_SCALE - 65.574) < 0.01, "BM25-only rank 1 = 0.8 × 81.967");
  assert.ok(Math.abs(denseOnly.score * RRF_SCALE - 98.361) < 0.01, "dense-only rank 1 = 1.2 × 81.967");
});
