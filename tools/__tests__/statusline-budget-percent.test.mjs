/**
 * calculateBudgetPercentage clamped to 100, so with showValue:false the bar
 * printed "!100%" for both a 5% and a 400% overspend.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateBudgetPercentage,
  resolveBudgetDisplay,
} from "../../packages/statusline/src/utils/budget.ts";

test("an overspend reports its real percentage", () => {
  assert.equal(calculateBudgetPercentage(20, 5), 400);
  assert.equal(calculateBudgetPercentage(105, 100), 105);
});

test("the printed text tells a 5% overspend from a 400% one", () => {
  const show = (cost) =>
    resolveBudgetDisplay(cost, null, {
      amount: 100,
      showValue: false,
      showPercentage: true,
    }).percentText;
  assert.equal(show(105), "!105%");
  assert.equal(show(400), "!400%");
});

test("an unset or invalid budget still yields no percentage", () => {
  assert.equal(calculateBudgetPercentage(5, undefined), null);
  assert.equal(calculateBudgetPercentage(5, 0), null);
  assert.equal(calculateBudgetPercentage(-1, 10), null);
});
