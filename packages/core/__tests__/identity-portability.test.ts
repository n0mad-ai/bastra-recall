/**
 * P2 aus dem Codex-Audit: Identität über Unicode-Grenzen hinweg.
 *
 * Zwei Stellen behandelten gleichwertige Schreibweisen als verschiedene Dinge —
 * dieselbe Klasse wie der Groß-/Kleinschreibungs-Fehler aus #360, nur eine
 * Ebene tiefer, und auf macOS besonders leicht auszulösen: Das Dateisystem
 * legt Namen in NFD ab, Editoren liefern NFC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeScopeKey, scopeEquals, extractWikilinks } from "../src/index.js";

test("normalizeScopeKey: NFC und NFD sind derselbe Scope", () => {
  const nfc = "Café"; // U+00E9
  const nfd = "Café"; // e + combining acute
  assert.notEqual(nfc, nfd, "die Eingaben sind wirklich verschiedene Strings");
  assert.equal(normalizeScopeKey(nfc), normalizeScopeKey(nfd));
  assert.equal(scopeEquals(nfc, nfd), true);
  assert.equal(scopeEquals("CAFÉ", "café"), true);
});

test("extractWikilinks: eine id aus nicht-lateinischer Schrift ist verlinkbar", () => {
  // slugify() behält seit dem Cyrillic/CJK-Fix Buchstaben jeder Schrift —
  // solche ids gab es also, nur fand das ASCII-Muster sie nie.
  assert.deepEqual(extractWikilinks("siehe [[记忆]]"), ["记忆"]);
  assert.deepEqual(extractWikilinks("siehe [[память-и-контекст]]"), ["память-и-контекст"]);
  assert.deepEqual(extractWikilinks("siehe [[ein-normaler-slug]]"), ["ein-normaler-slug"]);
});

test("extractWikilinks: kein Freibrief — Leerzeichen und Pfade bleiben draußen", () => {
  assert.deepEqual(extractWikilinks("[[my id]]"), []);
  assert.deepEqual(extractWikilinks("[[../escape]]"), []);
  assert.deepEqual(extractWikilinks("[[]]"), []);
});
