/**
 * The web telemetry report must not claim a real removal in shadow mode (#484).
 *
 * The read model counts shadow calls into the same `hints`/`tokensAvoided`
 * sums on purpose and only reports the mode separately, so the labels are the
 * single place where "removed"/"avoided" can become a lie. The CLI report
 * (src/cli/log-stats.ts) already words it correctly; this pins the web report
 * to the same wording without a DOM.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/telemetry-view-suppression.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain browser module, no types (same as memory-counter.test.ts).
import { hintSuppressionLabels } from "../webui/js/managers/telemetry-view.js";

test("live only keeps today's wording", () => {
  const l = hintSuppressionLabels([{ mode: "live", calls: 3 }]);
  assert.equal(l.verb, "removed");
  assert.equal(l.tokensLabel, "hook payload avoided");
  assert.equal(l.heading, "Most often suppressed");
  assert.equal(l.modeLine, null);
  assert.match(l.tokensNote, /^Token savings estimate/);
});

test("missing modes are treated as live", () => {
  assert.deepEqual(hintSuppressionLabels([]), hintSuppressionLabels([{ mode: "live", calls: 1 }]));
  assert.equal(hintSuppressionLabels(undefined).verb, "removed");
});

test("shadow only never claims a removal or a saving", () => {
  const l = hintSuppressionLabels([{ mode: "shadow", calls: 2 }]);
  assert.equal(l.verb, "would have been removed");
  assert.equal(l.tokensLabel, "hook payload");
  assert.equal(l.heading, "Most often matched");
  assert.equal(l.modeLine, "mode: shadow×2");
  assert.doesNotMatch(l.tokensNote, /Token savings/);
});

test("mixed window names both halves and lists every mode", () => {
  const l = hintSuppressionLabels([{ mode: "live", calls: 5 }, { mode: "shadow", calls: 2 }]);
  assert.equal(l.verb, "removed or would have been removed");
  assert.equal(l.tokensLabel, "hook payload");
  assert.equal(l.modeLine, "mode: live×5, shadow×2");
});
