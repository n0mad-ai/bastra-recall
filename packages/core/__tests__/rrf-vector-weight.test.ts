/**
 * #641: the dense-arm weight of the fusion, opt-in via BASTRA_RRF_VECTOR_WEIGHT.
 *
 * Pinned as arithmetic, like rrf-damping.test.ts: the default must be the
 * shipped equal-weight RRF bit for bit, a weight above 1 must let the dense
 * arm's rank 1 beat a BM25 rank 1 the dense arm only ranks 3rd (the loss #641
 * measured on LongMemEval-S), and the both-arms ceiling must not move.
 *
 * Runner: node --import tsx --test packages/core/__tests__/rrf-vector-weight.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseRRF, rrfVectorWeight, RRF_SCALE } from "../src/index.js";

function withWeight<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.BASTRA_RRF_VECTOR_WEIGHT;
  if (value === undefined) delete process.env.BASTRA_RRF_VECTOR_WEIGHT;
  else process.env.BASTRA_RRF_VECTOR_WEIGHT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_RRF_VECTOR_WEIGHT;
    else process.env.BASTRA_RRF_VECTOR_WEIGHT = prev;
  }
}

// BM25 ranks the distractor 1st and the gold 4th; the dense arm ranks the
// gold 1st and the distractor 3rd.
const BM25 = ["distractor", "b2", "b3", "gold"];
const VECTOR = ["gold", "v2", "distractor"];

test("default weight is 1 and reproduces the unweighted sum exactly", () => {
  withWeight(undefined, () => {
    assert.equal(rrfVectorWeight(), 1);
    const fused = fuseRRF(BM25, VECTOR);
    assert.equal(fused.get("distractor")!.score, 1 / 6 + 1 / 8);
    assert.equal(fused.get("gold")!.score, 1 / 9 + 1 / 6);
    assert.ok(fused.get("distractor")!.score > fused.get("gold")!.score);
  });
});

test("a dense weight of 1.5 hands rank 1 to the dense arm's pick", () => {
  withWeight("1.5", () => {
    const fused = fuseRRF(BM25, VECTOR);
    assert.ok(
      fused.get("gold")!.score > fused.get("distractor")!.score,
      "the dense rank 1 must now outrank the BM25 rank 1 the dense arm puts 3rd",
    );
  });
});

test("rank 1 in both arms keeps the 163.934 ceiling at any weight", () => {
  for (const w of ["1", "1.5", "2", "4"]) {
    withWeight(w, () => {
      const both = fuseRRF(["top"], ["top"]).get("top")!;
      assert.equal(Math.round(both.score * RRF_SCALE * 1000) / 1000, 163.934, `w=${w}`);
    });
  }
});

test("unparsable or out-of-range values fall back to the shipped weight", () => {
  for (const v of ["", "abc", "0", "-1", "11", "Infinity"]) {
    withWeight(v, () => assert.equal(rrfVectorWeight(), 1, `value ${JSON.stringify(v)}`));
  }
  withWeight("2", () => assert.equal(rrfVectorWeight(), 2));
});
