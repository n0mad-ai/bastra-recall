/**
 * #465 — jeder Hint-Block sagt, dass er nur Kandidaten trägt und der Inhalt
 * erst mit load_memory im Kontext ist. Ein Modell, das den Block als
 * „steht schon im Kontext" liest, handelt auf einer Zeile Summary.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/candidates-only-notice.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATES_ONLY_NOTICE } from "../src/band-wording.js";
import { renderSessionContext } from "../src/session-assembler.js";
import { formatHintBlock as promptBlock } from "../src/prompt-lane.js";

const hit = {
  id: "conv-1",
  title: "Nachrichtenkonvention",
  type: "lesson",
  scope: "bastra-recall",
  summary: "Copy text is the last message, never between tool calls.",
  score: 163.9,
  matched_recall_when: true,
};

test("#465: the notice names the three things a block is, and the one thing it is not", () => {
  assert.match(CANDIDATES_ONLY_NOTICE, /candidates \(id, title, summary\)/);
  assert.match(CANDIDATES_ONLY_NOTICE, /NOT the memories themselves/);
  assert.match(CANDIDATES_ONLY_NOTICE, /load_memory\(id\)/);
  assert.doesNotMatch(CANDIDATES_ONLY_NOTICE, /apply what fits|for details/, "the two misreadable phrases are gone");
});

test("#465: the session-context block carries the notice in its header", () => {
  const text = renderSessionContext([{ lines: ["- conv-1 (lesson): a summary"] }] as never, 42);
  assert.ok(text.includes(CANDIDATES_ONLY_NOTICE));
  assert.doesNotMatch(text, /apply what fits/);
});

test("#465: the prompt lane's REQUIRED block carries the notice", () => {
  const block = promptBlock([hit] as never, "bastra-recall", "none", false, false, "claude-code");
  assert.ok(block.includes(CANDIDATES_ONLY_NOTICE));
});
