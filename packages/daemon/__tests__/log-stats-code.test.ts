import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { aggregateCodeRoi, renderCodeRoi } from "../src/cli/log-stats-code.js";

/**
 * The `code search ROI` section of `bastra stats` (#579).
 *
 * The rules worth holding down are about honesty, not arithmetic: the section
 * stays silent when nothing fired, it never lets its cost numbers read as a
 * benefit, and rows written before the fields existed do not make the history
 * look like the feature was switched off.
 */

const call = (over: Record<string, unknown> = {}) => ({ hint_tokens_est: 500, ...over });

describe("code search ROI: aggregation", () => {
  it("counts only the calls that actually carried a block", () => {
    const s = aggregateCodeRoi([
      call(),
      call({ code_block_tokens_est: 100, code_dependents: 4 }),
      call({ code_block_tokens_est: 200, code_dependents: 10 }),
    ]);
    assert.equal(s.calls, 3);
    assert.equal(s.withCodeBlock, 2);
    assert.equal(s.codeTokensTotal, 300);
    assert.equal(s.dependentsTotal, 14);
  });

  it("ignores rows from before the fields existed instead of counting them as zero", () => {
    // An upgrade must not make yesterday look like the feature was off.
    const s = aggregateCodeRoi([call(), call(), call()]);
    assert.equal(s.calls, 3);
    assert.equal(s.withCodeBlock, 0);
    assert.equal(s.codeTokensMedian, 0);
  });

  it("survives malformed values rather than throwing in a diagnostics command", () => {
    const s = aggregateCodeRoi([
      call({ code_block_tokens_est: "lots" }),
      call({ code_block_tokens_est: Number.NaN }),
      call({ code_block_tokens_est: 50, code_dependents: null }),
    ]);
    assert.equal(s.withCodeBlock, 1);
    assert.equal(s.codeTokensTotal, 50);
    assert.equal(s.dependentsTotal, 0);
  });

  it("counts stale blocks separately", () => {
    const s = aggregateCodeRoi([
      call({ code_block_tokens_est: 10, code_stale: true }),
      call({ code_block_tokens_est: 10, code_stale: false }),
      call({ code_block_tokens_est: 10 }),
    ]);
    assert.equal(s.staleBlocks, 1);
  });

  it("tracks the affects_files block on its own axis", () => {
    const s = aggregateCodeRoi([
      call({ applies_to_tokens_est: 120, applies_to_count: 3 }),
      call({ code_block_tokens_est: 80 }),
    ]);
    assert.equal(s.withAppliesTo, 1);
    assert.equal(s.appliesToTokensTotal, 120);
    assert.equal(s.appliesToCount, 3);
    assert.equal(s.withCodeBlock, 1);
  });
});

describe("code search ROI: rendering", () => {
  it("says nothing at all when the feature never fired", () => {
    // A section of zeroes reads like a measurement. There is none here.
    assert.deepEqual(renderCodeRoi(aggregateCodeRoi([call(), call()])), []);
  });

  it("never presents cost as saving", () => {
    const lines = renderCodeRoi(
      aggregateCodeRoi([call({ code_block_tokens_est: 100, code_dependents: 5 })]),
    ).join("\n");
    assert.match(lines, /cost:/);
    assert.match(lines, /what it SAVED needs the control arm/);
    // The words that would turn a cost ledger into a claim.
    assert.doesNotMatch(lines, /\bsaved\b(?! needs)/i);
    assert.doesNotMatch(lines, /\bsaves\b/i);
  });

  it("puts the code cost in proportion to everything injected", () => {
    const lines = renderCodeRoi(
      aggregateCodeRoi([call({ hint_tokens_est: 1000, code_block_tokens_est: 250 })]),
    ).join("\n");
    assert.match(lines, /25% of everything injected/);
  });

  it("reports the stale share only when there is one", () => {
    const withStale = renderCodeRoi(
      aggregateCodeRoi([call({ code_block_tokens_est: 10, code_stale: true })]),
    ).join("\n");
    assert.match(withStale, /out of date/);
    const withoutStale = renderCodeRoi(
      aggregateCodeRoi([call({ code_block_tokens_est: 10 })]),
    ).join("\n");
    assert.doesNotMatch(withoutStale, /out of date/);
  });
});
