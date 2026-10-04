import { test } from "node:test";
import assert from "node:assert/strict";
import type { Memory } from "@bastra-recall/core";
import { measureLatency } from "../src/rerank-latency.js";
import type { PairScorer } from "../src/rerank-model.js";
import type { CaseRow } from "../src/rerank-report.js";

/**
 * A latency cell with no warm sample is "no data", never "0 ms".
 * When every row's pool is shallower than N, nothing is timed at that N and
 * `samples` is 0; the percentiles used to default to 0, which reads as "fast".
 */
const scorer: PairScorer = {
  id: "fake",
  loadMs: 0,
  score: async (_q, passages) => passages.map(() => 0),
  close: () => {},
};
const memoryOf = (id: string): Memory => ({ fm: { id, title: id, summary: id }, body: id }) as unknown as Memory;
const row = (poolSize: number): CaseRow =>
  ({ id: "c", query: "q", baseline: Array.from({ length: poolSize }, (_, i) => ({ id: `m${i}` })) }) as unknown as CaseRow;

test("an N deeper than every pool reports null percentiles with samples 0", async () => {
  const [r] = await measureLatency(scorer, "short", [row(3), row(3)], memoryOf, "fake", [10], { scoredAnything: false });
  assert.equal(r.samples, 0);
  assert.equal(r.warm_p50_ms, null);
  assert.equal(r.warm_p95_ms, null);
});

test("an N deeper than every pool reports first_call_ms null, not 0", async () => {
  const [r] = await measureLatency(scorer, "short", [row(3)], memoryOf, "fake", [10], { scoredAnything: false });
  assert.equal(r.first_call_ms, null);
});

test("with warm samples the percentiles are numbers", async () => {
  const rows = [row(5), row(5), row(5)];
  const [r] = await measureLatency(scorer, "short", rows, memoryOf, "fake", [5], { scoredAnything: false });
  assert.equal(r.samples, 2); // the first call is reported apart, not sampled
  assert.equal(typeof r.warm_p50_ms, "number");
  assert.equal(typeof r.warm_p95_ms, "number");
});
