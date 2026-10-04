/**
 * Missing usage data must not read as a measured zero: formatCost(null) printed
 * "$0.00" and formatTokens(null) "0 tokens", the same text as spending nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseHome,
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

test("collapseHome shortens the home directory and paths below it only", () => {
  assert.equal(collapseHome("/Users/n0mad", "/Users/n0mad"), "~");
  assert.equal(collapseHome("/Users/n0mad/proj", "/Users/n0mad"), "~/proj");
  assert.equal(collapseHome("C:\\Users\\n0mad\\proj", "C:\\Users\\n0mad"), "~\\proj");
});

test("collapseHome leaves a sibling that merely shares the home prefix alone", () => {
  assert.equal(collapseHome("/Users/n0mad-backup", "/Users/n0mad"), "/Users/n0mad-backup");
  assert.equal(collapseHome("/Users/n0mad-backup/x", "/Users/n0mad"), "/Users/n0mad-backup/x");
});
