/**
 * Word forms (core/word-form.ts): when two lowercased tokens are the same word.
 *
 * These pin the rule itself; the reflex and acted_on behaviour it changes is
 * pinned in daemon/__tests__/word-forms-reflex-acted-on.test.ts.
 *
 * Runner: node --import tsx --test packages/core/__tests__/word-form.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameWordForm, hasWordForm, letterCount } from "../src/word-form.js";

test("sameWordForm: an ending is not a different word, in any suffixing script", () => {
  const same: [string, string][] = [
    ["арка", "арке"],
    ["арка", "арку"],
    ["снял", "снять"],
    ["положи", "положить"],
    ["antwort", "antworten"],
    ["update", "updated"],
    ["切り替え", "切り替える"],
    // Agglutination: a long ending on the whole stem.
    ["laskun", "laskuissa"],
    ["şablonu", "şablonlarında"],
    ["청구서", "청구서들을"], // Hangul compares jamo
    // Prefixes: Arabic/Hebrew clitics and articles, a swapped Bantu class prefix.
    ["قالب", "بالقالب"],
    ["חשבונית", "החשבוניות"],
    ["kiolezo", "violezo"],
  ];
  for (const [a, b] of same) {
    assert.equal(sameWordForm(a, b), true, `${a} ~ ${b}`);
    assert.equal(sameWordForm(b, a), true, `${b} ~ ${a} (symmetric)`);
  }
});

test("sameWordForm: short tokens, identifiers and long gaps stay exact", () => {
  const different: [string, string][] = [
    ["state", "statement"], // gap 4
    ["code", "card"],
    ["cd", "ci"], // too short to say anything
    ["кот", "код"], // 3 letters: exact only
    ["v1.0", "v1.1"], // not letters only
    ["node18", "node20"],
    ["移行", "移動"], // 2 characters: exact only
    ["range", "orange"], // a prefix needs a six-letter stem outside the abjads
    ["decision", "precision"], // a swapped first letter is not room for a longer prefix
    ["contract", "contradiction"], // a long ending needs the whole shorter token as stem
    ["ספר", "ספק"], // a three-letter abjad root has no ending to spare
  ];
  for (const [a, b] of different) assert.equal(sameWordForm(a, b), false, `${a} ≁ ${b}`);
});

test("hasWordForm: exact hit first, word form as fallback", () => {
  const ctx = new Set(["повесь", "арке", "ревью"]);
  assert.equal(hasWordForm(ctx, "арке"), true);
  assert.equal(hasWordForm(ctx, "арка"), true);
  assert.equal(hasWordForm(ctx, "повесить"), true);
  assert.equal(hasWordForm(ctx, "код"), false);
});

test("letterCount: letters, not code points", () => {
  assert.equal(letterCount("deploy"), 6);
  assert.equal(letterCount("में"), 1); // a Devanagari vowel sign is a mark
  assert.equal(letterCount("배포"), 4); // a Hangul syllable counts its jamo
});

// Independent counterexamples from the #1191 review; both directions matter.
const unrelatedPairs: [string, string][] = [
  ["backup", "backdoor"], ["server", "service"], ["auth", "auto"],
  ["delete", "delegate"], ["publish", "public"], ["file", "film"],
  ["plane", "plant"], ["model", "modem"], ["folder", "folded"],
  ["thread", "threat"], ["lease", "least"], ["sale", "salt"],
  ["station", "static"], ["script", "scribble"], ["cancel", "cancerous"],
];
for (const [a, b] of unrelatedPairs) {
  test(`sameWordForm rejects unrelated words: ${a}/${b}`, () => {
    assert.equal(sameWordForm(a, b), false);
    assert.equal(sameWordForm(b, a), false);
    assert.equal(hasWordForm(new Set([a]), b), false);
  });
}

test("sameWordForm keeps ordinary English inflections", () => {
  for (const [a, b] of [["backup", "backups"], ["delete", "deleted"]]) {
    assert.equal(sameWordForm(a, b), true);
    assert.equal(sameWordForm(b, a), true);
  }
});

test("word-form families stay closed and respect canonical spellings", () => {
  for (const [a, b] of [
    ["قالب", "زقالب"], ["חשבונית", "זחשבונית"],
    ["kiolezo", "xiolezo"], ["청구서", "청구서xyz"],
    ["切り替え", "切り替えxyz"], ["antwort", "antwortxyz"],
    ["şablonu", "şablonxyz"], ["арка", "аркеxyz"],
    ["देवनागरी", "देवनागरु"],
  ]) {
    assert.equal(sameWordForm(a, b), false, `${a} ≁ ${b}`);
    assert.equal(sameWordForm(b, a), false, `${b} ≁ ${a}`);
  }
  assert.equal(sameWordForm("şablonu".normalize("NFD"), "şablonlarında"), true);
  assert.equal(sameWordForm("청구서".normalize("NFD"), "청구서들을"), true);
  assert.equal(sameWordForm("café", "cafe\u0301"), true);
});
