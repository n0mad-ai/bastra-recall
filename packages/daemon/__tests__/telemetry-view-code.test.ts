/**
 * The Telemetry tab must be able to name every `unavailable` reason (#579).
 *
 * The tab turns a reason code into a sentence a human can act on. A code with no
 * entry falls back to the raw token, which is not wrong but is exactly the kind
 * of silent gap this section exists to close: `degraded` means "a defect, run
 * bastra doctor" and `cold` means "nothing is wrong, ask again" — printing both
 * as a bare identifier hides the difference.
 *
 * So this pins the label map against the reason codes the classifier can
 * produce. No DOM, like telemetry-view-suppression.test.ts.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/telemetry-view-code.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain browser module, no types.
import { UNAVAILABLE_REASONS } from "../webui/js/managers/telemetry-view-code.js";
import type { CodeUnavailableReason } from "../src/code-graph/unavailable-reason.js";

/** Every value `unavailableReason()` can return, listed by hand on purpose:
 *  the type is erased at runtime, so a new code has to be added here too. */
const REASONS: CodeUnavailableReason[] = [
  "off_env",
  "not_enabled",
  "degraded",
  "not_indexed",
  "loading",
  "cold",
];

test("every unavailable reason has a sentence in the tab", () => {
  for (const r of REASONS) {
    const label = (UNAVAILABLE_REASONS as Record<string, string>)[r];
    assert.ok(typeof label === "string" && label.length > 0, `no label for ${r}`);
    assert.notEqual(label, r, `${r} is shown as its raw code`);
  }
});

test("the labels do not turn a cold start into a failure", () => {
  const l = UNAVAILABLE_REASONS as Record<string, string>;
  assert.match(l.degraded, /doctor/);
  assert.doesNotMatch(l.cold, /error|failed|broken/i);
  assert.doesNotMatch(l.loading, /error|failed|broken/i);
});
