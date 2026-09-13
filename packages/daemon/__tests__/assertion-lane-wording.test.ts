/**
 * #384 — the assertion lane's hint is a statement about the environment, not a
 * string of commands. What it must carry: model memory is not a source for
 * this prompt, an unanswered claim is unknown, the candidates follow.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/assertion-lane-wording.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHintBlock } from "../src/prompt-lane.js";

const hit = {
  id: "recall-pool-figures",
  title: "recall@pool 103 far golds",
  type: "project-fact",
  scope: "bastra-recall",
  summary: "96–97 of 103 far golds land in the candidate pool.",
  score: 150,
  matched_recall_when: true,
};

test("#384: the assertion hint states facts — no prohibition, no imperative chain", () => {
  const block = formatHintBlock([hit] as never, "bastra-recall", "assertion", false, false, "claude-code");
  assert.match(block, /makes a CLAIM/);
  assert.match(block, /model memory is not a source/);
  assert.match(block, /the vault does not answer is unknown/);
  assert.match(block, /Pre-recalled candidates for this prompt:/);
  assert.doesNotMatch(block, /Do NOT|do not assert|instead of guessing/i, "the three-command form is gone");
  assert.match(block, /recall-pool-figures/);
});

test("#384: the other modes keep their own headlines", () => {
  const retrieval = formatHintBlock([hit] as never, "bastra-recall", "retrieval", false, false, "claude-code");
  assert.match(retrieval, /LOOKUP \/ retrieval query/);
  assert.doesNotMatch(retrieval, /model memory is not a source/);
});
