/**
 * Reflex triggers and the acted_on match accept a word form, not only the
 * exact spelling.
 *
 * reflex: every content token of a trigger had to appear in the prompt in
 * exactly the same form, so a case ending ("арке" for "арка") or a verb form
 * ("antworten" for "Antwort") missed the trigger.
 * acted_on: a memory token counted only when the edit used the same spelling,
 * so "ротацию бэкапа" in an edit did not count for a memory about "ротация
 * бэкапов".
 *
 * Revert-check: restore `contextTokens.has(t)` / `contextTokens.has(meaningful[0])`
 * in reflex.ts → the two "satisfies the trigger" tests go red; restore
 * `inputTokens.has(token)` in telemetry-join-state.ts → "an inflected form in
 * the edit still counts" goes red. The strict cases stay green either way.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/word-forms-reflex-acted-on.test.ts
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenizeWithIdentifiers, foldTerm } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { distinctiveTokensForActedOn } from "../src/tool-handlers.js";
import { phraseMatchesContext } from "../src/reflex.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bastra-word-forms-"));
  process.env.BASTRA_LOG_PATH = dir;
  process.env.BASTRA_TELEMETRY = "on";
});
afterEach(async () => {
  delete process.env.BASTRA_LOG_PATH;
  delete process.env.BASTRA_TELEMETRY;
  await rm(dir, { recursive: true, force: true });
});

function actedOn(memoryText: string, toolInput: string) {
  const t = new Telemetry();
  t.rotateTurn("s");
  t.recordLoadedMemory({
    memory_id: "m",
    distinctive_tokens: distinctiveTokensForActedOn(memoryText),
    hook_hint: { recall_id: "r", score: 120 },
    session_id: "s",
  });
  return t.matchLoadedMemories({ tool_name: "Edit", tool_input_excerpt: toolInput, session_id: "s" })[0];
}

const MEMORY_RU = "Ротация бэкапов хранит семь снапшотов на сторадж-боксе";

test("acted_on: an inflected form in the edit still counts", () => {
  const ep = actedOn(MEMORY_RU, "поменял ротацию бэкапа, снапшоты теперь по семь");
  assert.equal(ep?.acted_on, true, `match_strength=${ep?.match_strength}`);
});

test("acted_on stays strict: an unrelated edit in the same language is not acted on", () => {
  const ep = actedOn(MEMORY_RU, "обновил README про установку демона");
  assert.equal(ep?.acted_on, false);
});

function ctx(prompt: string): [Set<string>, string] {
  const toks = tokenizeWithIdentifiers(prompt).map(foldTerm);
  return [new Set(toks), ` ${toks.join(" ")} `];
}

test("reflex: a case ending in the prompt satisfies the trigger", () => {
  const [tokens, seq] = ctx("глянь что в арке по ревью");
  assert.equal(phraseMatchesContext("ревью арка", tokens, seq), true);
});

test("reflex: a verb form in the prompt satisfies the trigger", () => {
  const [tokens, seq] = ctx("danach antworten wir dem maintainer");
  assert.equal(phraseMatchesContext("Antwort maintainer", tokens, seq), true);
});

test("reflex stays strict: a missing content word still blocks the trigger", () => {
  const [tokens, seq] = ctx("глянь что в арке");
  assert.equal(phraseMatchesContext("ревью арка", tokens, seq), false);
});

for (const [trigger, prompt] of [
  ["delete files", "delegate files"],
  ["auth policy", "auto policy"],
  ["delete backup", "delegate backdoor"],
]) {
  test(`reflex rejects unrelated words: ${trigger}/${prompt}`, () => {
    const [tokens, seq] = ctx(prompt);
    assert.equal(phraseMatchesContext(trigger, tokens, seq), false);
  });
}

test("acted_on: unrelated lookalikes do not count as memory use", () => {
  const ep = actedOn("delete backup snapshots", "delegate backdoor closed immediately");
  assert.equal(ep?.match_strength, 0);
  assert.equal(ep?.acted_on, false);
});

// Exercise actual tokenization/folding: ICU segments Japanese; Korean keeps
// word particles attached, and Turkish dotless i folds to i before matching.
for (const [trigger, prompt] of [
  ["切り替え maintainer", "maintainerと切り替える"],
  ["청구서 업데이트", "청구서들을 업데이트"],
  ["şablonu kontrol", "şablonlarında kontrol"],
]) {
  test(`reflex word forms after segmentation/folding: ${trigger}`, () => {
    const [tokens, seq] = ctx(prompt);
    assert.equal(phraseMatchesContext(trigger, tokens, seq), true);
  });
}

test("acted_on: one edit token cannot satisfy two memory word forms", () => {
  for (const memory of ["datei dateien", "dateien datei"]) {
    const ep = actedOn(memory, "dateien");
    assert.equal(ep?.match_strength, 1);
    assert.equal(ep?.acted_on, false);
  }
});

test("acted_on: exact spellings are reserved before inflection matches", () => {
  const ep = actedOn("datei dateien", "dateien datei");
  assert.equal(ep?.match_strength, 2);
  assert.equal(ep?.acted_on, true);
});

test("acted_on: two different inflected edit tokens still count separately", () => {
  const ep = actedOn("antwort backup", "antworten backups");
  assert.equal(ep?.match_strength, 2);
  assert.equal(ep?.acted_on, true);
});

// marker can use mark or marks, but marked can only use mark. The first
// assignment must be movable when the second token needs the same edit word.
test("acted_on: augmenting paths make ambiguous word forms independent of order", () => {
  for (const memory of ["marker marked", "marked marker", "mark marker"]) {
    const ep = actedOn(memory, "mark marks");
    assert.equal(ep?.match_strength, 2, memory);
    assert.equal(ep?.acted_on, true, memory);
  }
});
