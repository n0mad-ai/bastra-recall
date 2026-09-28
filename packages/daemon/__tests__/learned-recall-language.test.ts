/**
 * Tests for src/learned-recall/language.ts — heuristic DE/EN detection with abstain.
 *
 * Run: npx tsx --test packages/daemon/__tests__/learned-recall-language.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  bridgeLanguage,
  detectLanguage,
  isBridgeLanguage,
  isSupportedLanguage,
  SUPPORTED_LANGUAGES,
  UNDETERMINED_LANGUAGE,
} from "../src/learned-recall/language.js";

test("detects clear German from function words", () => {
  const r = detectLanguage("wie kann ich das Feld in der Datenbank speichern");
  assert.equal(r.lang, "de");
  assert.ok(r.confidence > 0, "should be confident");
});

test("detects clear English from function words", () => {
  const r = detectLanguage("how do I store the field in the database");
  assert.equal(r.lang, "en");
  assert.ok(r.confidence > 0);
});

test("a single diacritic commits to German even with weak stopword margin", () => {
  // "für" is a DE stopword AND carries a diacritic — unambiguously German.
  const r = detectLanguage("config für test");
  assert.equal(r.lang, "de");
});

test("diacritics outweigh an English stopword tie", () => {
  // "the" (en) vs "ä/ö" diacritics (de*2 each) — German wins on diacritic weight.
  const r = detectLanguage("the Häuser Höfe");
  assert.equal(r.lang, "de");
});

test("a single German proper noun does NOT misroute an English-stopword query to German", () => {
  // "Müller" carries a diacritic, but the sentence is English (the). A single
  // diacritic token in an EN-dominated query must not flip the result to DE.
  const r = detectLanguage("the Müller approach");
  assert.notEqual(r.lang, "de", "one German name must not flip an English query to German");
  assert.equal(r.lang, "en");
});

test("a lone German term inside an English-stopword query stays English (no sub-threshold DE flip)", () => {
  const r = detectLanguage("what is the diff für this");
  assert.notEqual(r.lang, "de");
});

test("multiple distinct diacritic tokens still commit to German", () => {
  // genuinely German: two distinct umlaut-bearing content words, not one name.
  assert.equal(detectLanguage("the Häuser Höfe").lang, "de");
});

test("abstains on a code-shaped query with no function words", () => {
  const r = detectLanguage("NSPanel resignKey Observer attachedSheet");
  assert.equal(r.lang, null, "no language signal → abstain");
  assert.equal(r.confidence, 0);
});

test("abstains on too-short input", () => {
  assert.equal(detectLanguage("x").lang, null);
  assert.equal(detectLanguage("").lang, null);
  assert.equal(detectLanguage("   ").lang, null);
});

test("abstains when DE and EN signals are evenly mixed without diacritics", () => {
  // one DE stopword ("und"), one EN stopword ("the"), no diacritics → ambiguous.
  const r = detectLanguage("und the");
  assert.equal(r.lang, null, "even split, no diacritic → abstain");
});

test("scores are reported for debugging", () => {
  const r = detectLanguage("die Datenbank");
  assert.ok(r.scores.de >= 1);
  assert.equal(typeof r.scores.en, "number");
});

test("isSupportedLanguage guards the enum", () => {
  assert.equal(isSupportedLanguage("de"), true);
  assert.equal(isSupportedLanguage("en"), true);
  assert.equal(isSupportedLanguage("fr"), false);
  assert.equal(isSupportedLanguage(42), false);
  assert.equal(isSupportedLanguage(null), false);
});

test("SUPPORTED_LANGUAGES is the source of truth", () => {
  assert.deepEqual([...SUPPORTED_LANGUAGES], ["de", "en"]);
});

test("#707: bridgeLanguage never returns null — Russian, Turkish, Greek file under und", () => {
  assert.equal(UNDETERMINED_LANGUAGE, "und");
  assert.equal(bridgeLanguage("wie kann ich das Feld in der Datenbank speichern"), "de");
  assert.equal(bridgeLanguage("почему сервер падает ночью"), "und");
  assert.equal(bridgeLanguage("veritabanı şifresi nerede duruyor"), "und");
  assert.equal(bridgeLanguage("γιατί πέφτει ο διακομιστής"), "und");
  assert.equal(bridgeLanguage("NSPanel resignKey"), "und");
});

test("#707: isBridgeLanguage checks the folder shape, not a language list", () => {
  for (const ok of ["de", "en", "und", "ru", "tr", "el"]) assert.equal(isBridgeLanguage(ok), true, ok);
  for (const bad of ["archive", "../x", "", "DE", "de-DE", 42, null]) assert.equal(isBridgeLanguage(bad), false, String(bad));
});
