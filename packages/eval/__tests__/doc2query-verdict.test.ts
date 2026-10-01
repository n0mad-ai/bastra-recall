/**
 * doc2queryVerdict: each of the three reliability checks blocks PROMOTE on
 * its own, and a clean run with real lift still promotes.
 *
 * Runner: `tsx --test __tests__/doc2query-verdict.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { doc2queryVerdict, type Doc2QueryVerdictInput } from "../src/doc2query-verdict.js";

const clean: Doc2QueryVerdictInput = {
  own: { meanDeltaRank: -3, crossedIn: 0.4, nearRegression: 0.05 },
  foreign: { meanDeltaRank: -0.5, crossedIn: 0.1, nearRegression: 0.05 },
  near: 20,
  farInPool: 20,
  oop: 20,
  cases: 60,
  identicalArms: 10,
};

test("a clean run with real lift promotes", () => {
  const v = doc2queryVerdict(clean);
  assert.equal(v.promote, true);
  assert.equal(v.dataStarved || v.holdoutSanityFailed || v.armDivergenceSanityFailed, false);
});

test("DATA-STARVED blocks PROMOTE", () => {
  for (const over of [{ oop: 4 }, { near: 4 }]) {
    const v = doc2queryVerdict({ ...clean, ...over });
    assert.equal(v.dataStarved, true);
    assert.equal(v.promote, false, JSON.stringify(over));
  }
});

test("HOLDOUT SANITY blocks PROMOTE", () => {
  const v = doc2queryVerdict({ ...clean, near: 180, farInPool: 10, oop: 10, cases: 200 });
  assert.equal(v.holdoutSanityFailed, true);
  assert.equal(v.dataStarved, false);
  assert.equal(v.promote, false);
});

test("ARM-DIVERGENCE SANITY blocks PROMOTE", () => {
  const v = doc2queryVerdict({ ...clean, identicalArms: 59 });
  assert.equal(v.armDivergenceSanityFailed, true);
  assert.equal(v.promote, false);
});
