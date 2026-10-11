import test from "node:test";
import assert from "node:assert/strict";
import { PROACTIVE_CASES, evaluateObservation, summarizeObservations } from "../src/proactive-measurement.js";

test("missing contracts and observations cannot become a passed window", () => {
  const report = summarizeObservations([]);
  assert.equal(report.functional_verdict, "pending");
  assert.equal(report.expected_runs, 48);
  assert.equal(report.missing_runs, 48);
  assert.deepEqual(Object.values(report.issue_verdicts), ["pending", "pending", "pending"]);
});
test("missing acknowledgement and evidence are not implicit success", () => {
  const c = PROACTIVE_CASES.find(c => c.id === "acknowledged-unfinished")!;
  const result = evaluateObservation(c, { case_id: c.id, repetition: 1, values: { remains_open: true }, evidence: [] });
  assert.equal(result.verdict, "not_evaluable");
  assert.ok(result.missing.includes("acknowledgement_receipts"));
  assert.ok(result.missing.includes("receipt/state/effect evidence"));
});
test("a fabricated acknowledgement fails even when other observations are missing", () => {
  const c = PROACTIVE_CASES.find(c => c.id === "relay-overflow-disabled-purged")!;
  assert.equal(evaluateObservation(c, { case_id: c.id, repetition: 1, values: { fabricated_acknowledgements: 1 }, evidence: [] }).verdict, "failed");
});
test("control loss and unauthorised effects fail instead of counting completed tasks", () => {
  for (const [id, key] of [["kill-recovery", "stopped_effects"], ["prepare-forgery-drift", "unauthorised_effects"], ["owners-fencing", "expired_lease_effects"]]) {
    const c = PROACTIVE_CASES.find(c => c.id === id)!;
    assert.equal(evaluateObservation(c, { case_id: id, repetition: 1, values: { [key]: 1 }, evidence: [] }).verdict, "failed");
  }
});
test("even a complete synthetic response set leaves human and longitudinal gates pending", () => {
  // Manufactured rows exercise the evaluator ONLY, never the feature.
  const rows = PROACTIVE_CASES.flatMap(c => [1, 2, 3].map(repetition => ({ case_id: c.id, repetition, values: { ...c.expected }, evidence: ["test-only"] })));
  const report = summarizeObservations(rows);
  assert.equal(report.functional_verdict, "passed");
  assert.equal(report.observed_runs, 48);
  assert.deepEqual(Object.values(report.issue_verdicts), ["pending", "pending", "pending"]);
  rows[0].values.logical_firings = 2;
  assert.equal(summarizeObservations(rows).functional_verdict, "failed");
});
test("unregistered, duplicated and out-of-range observations are rejected", () => {
  const c = PROACTIVE_CASES[0];
  const row = { case_id: c.id, repetition: 1, values: {}, evidence: [] };
  assert.throws(() => summarizeObservations([row, row]), /duplicate/);
  assert.throws(() => summarizeObservations([{ ...row, case_id: "unregistered" }]), /unregistered/);
  assert.throws(() => summarizeObservations([{ ...row, repetition: 4 }]), /invalid/);
});
