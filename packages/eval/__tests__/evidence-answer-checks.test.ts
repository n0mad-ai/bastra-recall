import test from "node:test";
import assert from "node:assert/strict";
import { buildAnswerChecks, combineAnswerChecks, parseAnswerCheckVerdict } from "../src/evidence-answer-checks.js";

test("grounding request cannot see the reference answer or shared-input extras", () => {
  const input = { question: "Duration?", answer: "19 days.", referenceFacts: [["REFERENCE_ONLY_SENTINEL"]],
    delivered: { evidence: [{ id: "cue", revision: "r1", start: 0, end: 23, text: "recall_when: retention" }] },
    privateOracle: "EXTRA_PRIVATE_SENTINEL" };
  const [reference, grounding] = buildAnswerChecks(input);
  assert.ok(reference.messages[1].content.includes("REFERENCE_ONLY_SENTINEL"));
  assert.ok(!grounding.messages[1].content.includes("REFERENCE_ONLY_SENTINEL"));
  assert.ok(!grounding.messages[1].content.includes("reference_facts"));
  assert.ok(!JSON.stringify([reference, grounding]).includes("EXTRA_PRIVATE_SENTINEL"));
  assert.deepEqual(JSON.parse(grounding.messages[1].content).provided_evidence, input.delivered.evidence);
});

test("a correct reference answer with failed evidence grounding is a failed answer", () => {
  const yes = { passed: true, reason: "Correct." }, no = { passed: false, reason: "Cue alone is not evidence." };
  assert.equal(combineAnswerChecks(yes, no), "fail");
  assert.equal(combineAnswerChecks(no, yes), "fail");
  assert.equal(combineAnswerChecks(yes, yes), "pass");
  assert.equal(combineAnswerChecks(yes, null), "not_evaluable");
  assert.equal(combineAnswerChecks(null, null), "not_evaluable");
  assert.equal(combineAnswerChecks(no, null), "fail");
});

test("malformed model judgments fail validation instead of coercing truthy values", () => {
  for (const value of [null, {}, { passed: "false", reason: "No" }, { passed: true, reason: " " }, { passed: true }]) {
    assert.throws(() => parseAnswerCheckVerdict(value));
  }
  assert.deepEqual(parseAnswerCheckVerdict({ passed: false, reason: "Omitted exception." }), { passed: false, reason: "Omitted exception." });
});
