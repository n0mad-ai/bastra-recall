/**
 * What `RRF_K` actually buys, pinned as behaviour rather than as a number.
 *
 * The damping constant decides how much a rank is worth against mere presence
 * in both arms. At the TREC default of 60 the denominator swamps the rank on
 * pools this size: a memory sitting at rank 20 in BOTH arms outranked a memory
 * at rank 1 in one. #302 wrote that arithmetic out for the score bands; it is a
 * ranking cost too, and `packages/eval/src/rrf-k-beir.ts` measures what it
 * costs on a public corpus.
 *
 * The ordering property lives here rather than in that harness because it is
 * arithmetic: it holds for any two lists, on any corpus, and a test that needs
 * 3 633 documents and a running Ollama to state it is not a test.
 *
 * Runner: node --import tsx --test packages/core/__tests__/rrf-damping.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseRRF, RRF_K } from "../src/index.js";

/** bm25 arm: `solo` first, `pair` at rank 20. vector arm: `pair` at rank 20. */
function twoArmsWithADeepPair(): { bm25: string[]; vector: string[] } {
  const filler = (p: string): string[] => Array.from({ length: 18 }, (_, i) => `${p}${i}`);
  return {
    bm25: ["solo", ...filler("b"), "pair"],
    vector: [...filler("v"), "x", "pair"],
  };
}

test("a rank-1 hit in one arm beats a rank-20 hit in both", () => {
  const { bm25, vector } = twoArmsWithADeepPair();
  const fused = fuseRRF(bm25, vector);
  const solo = fused.get("solo")!;
  const pair = fused.get("pair")!;

  assert.equal(solo.rank_bm25, 1);
  assert.equal(solo.rank_vector, null);
  assert.equal(pair.rank_bm25, 20);
  assert.equal(pair.rank_vector, 20);

  assert.ok(
    solo.score > pair.score,
    `rank 1 in one arm (${solo.score}) must outrank rank 20 in both (${pair.score}) — ` +
      "otherwise the fusion is scoring arm agreement, not relevance"
  );
});

test("the TREC default is what inverted it — same lists, k=60", () => {
  const { bm25, vector } = twoArmsWithADeepPair();
  const old = fuseRRF(bm25, vector, 60);
  assert.ok(
    old.get("pair")!.score > old.get("solo")!.score,
    "documents the regression this constant fixes: at k=60 the deep pair wins"
  );
});

test("RRF_K stays small enough for the pools recall actually returns", () => {
  // k has to be commensurate with the pool. Hooks ask for 3-10 hits and the
  // deepest caller asks for 50; a k above that band reproduces the inversion
  // above no matter what the two arms found.
  assert.ok(RRF_K >= 1 && RRF_K <= 20, `RRF_K=${RRF_K} is outside the measured band`);
});

/**
 * The anchors cannot guard `RRF_K`, and it took a cold reviewer to notice.
 *
 * `rrf-rank-pair.test.ts` asserts `2/(RRF_K+1) × RRF_SCALE ≈ 163.934`. Substitute
 * `RRF_SCALE = 5000(RRF_K+1)/61` and it is `10000/61` for EVERY k — the (k+1)
 * cancels. Before this change those were the literals 60 and 5000 and the
 * assertion pinned three independent facts; tying the scale to k turned it into
 * an identity. Measured by mutation: k ∈ {1, 3, 17} passes the whole suite.
 *
 * What the hooks actually consume is not the ceiling, it is the curve below it,
 * so that is what gets pinned here.
 */
test("the score at an intermediate rank is pinned, because the anchors cannot be", () => {
  const scale = (5000 * (RRF_K + 1)) / 61;
  const at = (rankA: number, rankB: number | null): number => {
    const raw = 1 / (RRF_K + rankA) + (rankB === null ? 0 : 1 / (RRF_K + rankB));
    return raw * scale;
  };

  // A two-armed hit at rank 20 in both arms: the case #302 is about — it used
  // to clear MUST_LOAD (125.0 at k=60) and must not.
  const deepPair = at(20, 20);
  assert.ok(
    deepPair < 100,
    `rank 20 in both arms scores ${deepPair.toFixed(1)}; above the MUST_LOAD band (100) it is ` +
      "arm agreement being read as relevance"
  );

  // …and it must still clear the noise floor, or the fusion has stopped
  // returning things it found.
  assert.ok(deepPair >= 30, `rank 20 in both arms scores ${deepPair.toFixed(1)}, below the 30 floor`);

  // A one-armed rank 1 is the documented 81.967 at every k. A one-armed rank 10
  // is not, and it is what the 50-floor hooks see (`bash-fail-hook.ts:44`,
  // `prompt-hook.ts:87`, `bash-pre-hook.ts:34`, `todo-hook.ts:43`): one arm's
  // tenth guess should not be strong enough to interrupt a failed command.
  const soloDeep = at(10, null);
  assert.ok(
    soloDeep < 50,
    `one-armed rank 10 scores ${soloDeep.toFixed(1)} and clears the 50 floor — ` +
      "the interrupting hooks would fire on one arm's tenth guess"
  );
  assert.ok(
    soloDeep > 20,
    `one-armed rank 10 scores ${soloDeep.toFixed(1)}, so deep single-arm hits are gone entirely`
  );
});
