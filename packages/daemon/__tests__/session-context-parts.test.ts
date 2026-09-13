/**
 * #462 — the session-start block is measured per part, not as one number.
 *
 * Run: npx tsx --test packages/daemon/__tests__/session-context-parts.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SESSION_CONTEXT_PARTS, tokensByPart } from "../src/session-lane.js";

test("#462: every part of the block has a column, missing parts are 0", () => {
  const t = tokensByPart({ recalls: "x".repeat(400), taxonomy: "y".repeat(10) });
  assert.deepEqual(Object.keys(t).sort(), [...SESSION_CONTEXT_PARTS].sort());
  assert.equal(t.recalls, 100);
  assert.equal(t.taxonomy, 3);
  assert.equal(t.pinned, 0);
  assert.equal(t.doku, 0);
});

test("#462: nothing injected means every part is 0", () => {
  const t = tokensByPart({});
  assert.ok(Object.values(t).every((v) => v === 0));
});

test("#462: the parts use the same chars/4 estimator as hint_tokens_est, per part", () => {
  const parts = { pinned: "<pinned>abc</pinned>", recalls: "R".repeat(41), update: "\n<update>u</update>" };
  const t = tokensByPart(parts);
  assert.equal(t.pinned, Math.ceil(parts.pinned.length / 4));
  assert.equal(t.recalls, 11);
  // leading newline is framing, not context — trimmed before counting
  assert.equal(t.update, Math.ceil("<update>u</update>".length / 4));
  const sum = Object.values(t).reduce((a, b) => a + b, 0);
  const whole = Math.ceil((parts.pinned + parts.recalls + parts.update).length / 4);
  assert.ok(sum >= whole && sum - whole <= Object.keys(parts).length, "parts round individually, never below the whole");
});

test("#462: the part list is the block's assembly order", () => {
  assert.deepEqual([...SESSION_CONTEXT_PARTS], [
    "pinned", "recalls", "taxonomy", "language", "care", "import", "onboarding", "update", "patch", "pending", "doku",
  ]);
});
