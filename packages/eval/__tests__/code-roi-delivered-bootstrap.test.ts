import { describe, test } from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error — plain .mjs measurement script, no declarations
const { bootstrapStat, truthClusterKeys } = await import("../code-roi/v2/evaluate-delivered.mjs");

describe("the delivered scorer bootstraps truth-overlap clusters", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ repo: null, file: `f${i}.ts`, v: i }));
  const statistic = (sample: { v: number }[]) => sample.reduce((a, r) => a + r.v, 0) / sample.length;

  test("the same seed gives the same interval", () => {
    const a = bootstrapStat(rows, statistic, 20260918, 500);
    const b = bootstrapStat(rows, statistic, 20260918, 500);
    assert.deepEqual(a, b);
    assert.equal(a?.clusters, 30);
  });

  test("the fallback is repo plus changed file when no truth component was assigned", () => {
    const pooled = [
      { repo: "r1", file: "same.ts", v: 0 },
      { repo: "r2", file: "same.ts", v: 1 },
    ];
    assert.equal(bootstrapStat(pooled, statistic, 1, 50)?.clusters, 2);
    assert.equal(bootstrapStat(pooled.map((r) => ({ ...r, repo: "r1" })), statistic, 1, 50)?.clusters, 1);
  });

  test("truth overlap is transitive", () => {
    const keys = truthClusterKeys([
      { id: "S1", repo: "r", truth: ["a.test.ts"] },
      { id: "S2", repo: "r", truth: ["a.test.ts", "b.test.ts"] },
      { id: "S3", repo: "r", truth: ["b.test.ts"] },
      { id: "S4", repo: "r", truth: ["other.test.ts"] },
    ]);
    assert.equal(keys.get("S1"), keys.get("S2"));
    assert.equal(keys.get("S2"), keys.get("S3"));
    assert.notEqual(keys.get("S1"), keys.get("S4"));
  });

  test("no rows is null, not an interval around nothing", () => {
    assert.equal(bootstrapStat([], statistic, 1, 10), null);
  });
});
