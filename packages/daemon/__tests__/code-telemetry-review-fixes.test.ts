import test from "node:test";
import assert from "node:assert/strict";
import { aggregateCodeAwareness } from "../src/code-awareness-stats.js";

test("#665: only successful/failed build durations enter percentiles; other counts remain", () => {
  const refresh = (outcome: string, duration_ms: number) => ({ kind: "code_graph_refresh", outcome, duration_ms });
  const stats = aggregateCodeAwareness([
    refresh("started", 500_000),
    refresh("ok", 100),
    refresh("ok", 200),
    refresh("failed", 300),
    ...Array.from({ length: 50 }, () => refresh("locked", 1)),
    refresh("skipped", 800_000),
    refresh("given-up", 900_000),
  ]).refresh;
  assert.equal(stats.p50, 200);
  assert.equal(stats.p90, 300);
  assert.equal(stats.started, 1);
  assert.equal(stats.ok, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.locked, 50);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.givenUp, 1);
  // Null, not 0: nothing was built, so there is no duration to report (#665).
  assert.equal(aggregateCodeAwareness([refresh("locked", 1)]).refresh.p50, null);
});
