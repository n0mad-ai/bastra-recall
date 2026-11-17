import { test } from "node:test";
import assert from "node:assert/strict";
import { seededRandom } from "../src/seeded-random.js";

// Pinned from the three former copies in goldset-split.ts, goldset-run.ts and
// rerank-metrics.ts before they were merged (#1520 D8). A change here shifts
// every registered split, control arm and bootstrap interval.
const PINNED: [number, number[]][] = [
  [0, [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086]],
  [42, [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423]],
  [20260828, [0.45197239564731717, 0.6811085434164852, 0.21311987238004804, 0.9705515159294009, 0.961527964565903]],
  [0xffffffff, [0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489]],
];

test("seededRandom reproduces the pinned mulberry32 sequences", () => {
  for (const [seed, expected] of PINNED) {
    const rnd = seededRandom(seed);
    assert.deepEqual(
      expected.map(() => rnd()),
      expected,
      `seed ${seed}`
    );
  }
});

test("seededRandom treats a negative seed as its unsigned 32-bit value", () => {
  const a = seededRandom(-1);
  const b = seededRandom(0xffffffff);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});
