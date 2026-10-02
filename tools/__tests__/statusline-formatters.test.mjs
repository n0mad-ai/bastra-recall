/**
 * Missing usage data must not read as a measured zero: formatCost(null) printed
 * "$0.00" and formatTokens(null) "0 tokens", the same text as spending nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCost,
  formatTokens,
  formatTokenBreakdown,
} from "../../packages/statusline/src/utils/formatters.ts";

test("null usage renders as the absent-value placeholder, not as zero", () => {
  assert.equal(formatCost(null), "--");
  assert.equal(formatTokens(null), "--");
  assert.equal(formatTokenBreakdown(null), "--");
});

test("a measured zero keeps its own text", () => {
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatTokens(0), "0 tokens");
});

test("a tiny non-zero cost is not printed as zero", () => {
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(0.01), "$0.01");
});
