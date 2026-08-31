/**
 * Regressionstest für die Umlaut-Transliteration in slugify().
 *
 * Bug (bis 2026-07-10): die ä→ae/ö→oe/ü→ue-Map lief NACH normalize("NFKD") +
 * Diacritic-Strip. NFKD zerlegt ä in a + combining diaeresis, der Strip lässt
 * ein nacktes "a" zurück — die Map fand kein ä mehr. Ergebnis: "Präferenz" →
 * "praferenz" statt "praeferenz"; nur ß→ss überlebte (ß hat keine NFKD-
 * Zerlegung). Aufgefallen als dangling Wikilink im Vault: ein aus dem
 * Gedächtnis in ae-Schreibung gesetzter Link traf den a-verstümmelten
 * Dateinamen nicht.
 *
 * Runner: `node --import tsx --test packages/core/__tests__/slugify-umlaut.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/save-text.js";

test("umlauts transliterate to ae/oe/ue (not stripped to a/o/u)", () => {
  assert.equal(slugify("Präferenz"), "praeferenz");
  assert.equal(slugify("Löschen"), "loeschen");
  assert.equal(slugify("Übung"), "uebung");
  assert.equal(slugify("Größe"), "groesse");
});

test("sharp s and non-German diacritics keep their behavior", () => {
  assert.equal(slugify("Straße"), "strasse");
  // Nicht-deutsche Diakritika werden weiterhin gestript, nicht transliteriert.
  assert.equal(slugify("Café"), "cafe");
  assert.equal(slugify("naïve"), "naive");
});

test("uppercase umlauts transliterate via lowercase-first", () => {
  assert.equal(slugify("ÄNDERUNG"), "aenderung");
  assert.equal(slugify("Österreich"), "oesterreich");
});
