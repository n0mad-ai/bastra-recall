/**
 * The hook says what it measured (#302).
 *
 * The bands are fixed points (30 / 100) on a scale whose meaning is set by the
 * fusion constant. #302 measured the consequence: on the hybrid path 99.9% of
 * hits landed in REQUIRED and the noise floor fired 0.0% of the time, and the
 * arm check explained why — every REQUIRED hit was found by BOTH arms, every
 * OPTIONAL hit by one. The cut at 100 was a test for arm agreement wearing the
 * label of a strength test, and the wording asserted strength anyway.
 *
 * Two things are pinned here:
 *   1. the rank a cut selects follows from the constants, at the shipped k and
 *      at the one it replaced — the arithmetic behind the whole issue;
 *   2. the wording never claims strength or agreement it did not measure —
 *      including the BM25-only path, where no fusion runs at all and the score
 *      has no ceiling (#302 measured top hits into six digits there).
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/hook-band-honesty.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RRF_K, RRF_SCALE } from "@bastra-recall/core";
// #343: the formatter moved daemon-side with the rest of the lane.
import { formatHintBlock } from "../src/write-lane.js";
import { twoArmedRankFor, requiredHeadline, unfusedHeadline } from "../src/band-wording.js";

const MUST_LOAD = 100;
const FLOOR = 30;

function hit(id: string, score: number) {
  return { id, title: `Title ${id}`, type: "lesson", scope: "test", summary: `Summary ${id}`, score };
}

test("a cut is a rank, and the shipped constants put REQUIRED near the top of both arms", () => {
  // The inversion the issue rests on: score = 2·SCALE/(K+rank) for a hit both
  // arms found, so cut ⇒ rank. Checked against the shipped pair first.
  const shipped = twoArmedRankFor(MUST_LOAD, RRF_K, RRF_SCALE);
  assert.ok(shipped >= 1 && shipped <= 10, `REQUIRED must mean "both arms ranked it near the top", got top-${shipped}`);

  // The k it replaced, with the scale that went with it: the same cut sat at
  // rank 40 — which is why every two-armed hit cleared it and the band said
  // nothing. This is the regression the issue documented, kept as the contrast.
  assert.equal(twoArmedRankFor(MUST_LOAD, 60, 5000), 40);

  // The floor has to admit meaningfully more than REQUIRED, or the OPTIONAL
  // band is decorative — that was the 0.1%-occupancy defect.
  const floorRank = twoArmedRankFor(FLOOR, RRF_K, RRF_SCALE);
  assert.ok(
    floorRank > shipped * 2,
    `the OPTIONAL band needs room: floor at top-${floorRank} vs REQUIRED at top-${shipped}`
  );
});

test("the fused wording claims agreement, not similarity", () => {
  const block = formatHintBlock([hit("a", 164)], [hit("b", 60)], null, false, false, false);

  assert.match(block, /[Bb]oth search paths agreed/, "the REQUIRED line states what was measured");
  assert.doesNotMatch(block, /Strong matches/, "strength is exactly the claim the score does not support");
  // The OPTIONAL band's real content: one arm, or both but lower.
  assert.match(block, /ONE search path only, or by both but ranked lower/);
});

test("without a vector arm there are no bands to claim", () => {
  const block = formatHintBlock([hit("a", 4211)], [hit("b", 1904)], null, false, false, true);

  assert.match(block, /semantic search is off/i, "the reader has to know no second path ran");
  assert.match(block, /open-ended scale/i, "raw BM25 has no ceiling — say so");
  assert.doesNotMatch(block, /both search paths agreed/i, "nothing agreed: there was only one path");
  assert.doesNotMatch(
    block,
    new RegExp(`score ≥${MUST_LOAD}`),
    "the fused cut describes nothing on an unbounded scale"
  );
});

test("every surface makes the same claim, none of them claims strength", () => {
  // #302 is about the read path all four hook surfaces share, so a fix in one
  // of them is not a fix. The headline is built centrally now; this pins that
  // the shared builder cannot regress into asserting similarity again.
  const rrf = { k: RRF_K, scale: RRF_SCALE };
  for (const subject of ["what you're about to do", "this prompt", "the current session", "these todos"]) {
    const line = requiredHeadline(subject, MUST_LOAD, rrf);
    assert.match(line, /[Bb]oth search paths agreed/);
    assert.match(line, /not how similar the text is/);
    assert.doesNotMatch(line, /[Ss]trong match/);
    assert.ok(line.includes(subject), `the headline has to name its own surface, got: ${line}`);
  }

  // Without the constants the sentence still has to be true — just less sharp.
  const vague = requiredHeadline("this prompt", MUST_LOAD, null);
  assert.match(vague, /[Bb]oth search paths agreed/);
  assert.doesNotMatch(vague, /top \d/, "no rank may be claimed when k is unknown");

  assert.doesNotMatch(unfusedHeadline("this prompt"), /agreed/);
});

test("the honesty flags still win over the band wording", () => {
  // #249/#230 kept: a weak or homeless result must not be dressed up as
  // agreement just because the scores are high by construction.
  const weak = formatHintBlock([hit("a", 164)], [], null, true, false, false);
  assert.match(weak, /NONE of them anchors/);
  assert.doesNotMatch(weak, /[Bb]oth search paths agreed/);

  const noHome = formatHintBlock([hit("a", 164)], [], null, true, true, false);
  assert.match(noHome, /NO memory of it/);
  assert.doesNotMatch(noHome, /[Bb]oth search paths agreed/);
});
