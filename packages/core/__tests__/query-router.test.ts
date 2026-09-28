/**
 * #362 — der Query-Router: welche Arme braucht eine Anfrage?
 *
 * Strukturell, ohne Wortliste (#679): Termzahl und Bezeichnerform. Geprüft
 * auch an Schriften ohne Groß-/Kleinschreibung und ohne Leerzeichen, weil
 * genau dort eine lateinisch gedachte Regel still falsch wird.
 *
 * Runner: node --import tsx --test packages/core/__tests__/query-router.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { routeQueryArms, isIdentifierTerm, ROUTER_SHORT_MAX_TERMS } from "../src/query-router.js";

test("#362: kurze Anfragen gehen an BM25 — in jeder Sprache", () => {
  for (const q of ["ok", "weiter bitte", "спасибо", "gracias amigo", "  ok!  ", "ok ok OK"]) {
    const r = routeQueryArms(q);
    assert.equal(r.arms, "bm25", q);
    assert.equal(r.reason, "short", q);
  }
  assert.equal(ROUTER_SHORT_MAX_TERMS, 2);
});

test("#362: gewöhnliche Sätze bleiben hybrid", () => {
  for (const q of [
    "wie deployen wir das Projekt nach dem Release",
    "what did we decide about the coffee machine",
    "почему не работает поиск в хранилище",
  ]) {
    assert.deepEqual([routeQueryArms(q).arms, routeQueryArms(q).reason], ["hybrid", "default"], q);
  }
});

test("#362: bezeichnerförmige Anfragen gehen an BM25", () => {
  const r = routeQueryArms("recall_mode prompt-lane.ts routeRetrieval");
  assert.equal(r.arms, "bm25");
  assert.equal(r.reason, "identifier");
  assert.equal(r.identifier_terms, 3);
  // Die Hälfte reicht; weniger nicht.
  assert.equal(routeQueryArms("fix http-hook-routes.ts timeout now").arms, "hybrid");
  assert.equal(routeQueryArms("fix http-hook-routes.ts runHookRecall").arms, "bm25");
});

test("#362: Bezeichnerform — Kleber, Binnenmajuskel, Buchstabe neben Ziffer", () => {
  for (const t of ["a.b", "snake_case", "src/core", "std::vec", "routeRetrieval", "v2", "utf8"]) {
    assert.equal(isIdentifierTerm(t), true, t);
  }
  // Ein Bindestrich allein macht kein Wort zum Bezeichner (Scope-Filter, e-mail).
  for (const t of ["Scope-Filter", "e-mail", "Kaffee", "Deployment", "東京"]) {
    assert.equal(isIdentifierTerm(t), false, t);
  }
});

test("#362: eine Schrift ohne Leerzeichen wird in Wörter zerlegt, nicht als ein Term gezählt", () => {
  // Ohne Wortsegmentierung wäre ein ganzer japanischer Satz „ein Term", also
  // `short` — und liefe scharf geschaltet ohne dichten Arm: eine Regel, die
  // nur für Sprachen mit Leerzeichen richtig ist.
  const r = routeQueryArms("東京の天気はどうですか");
  assert.ok(r.unique_terms > ROUTER_SHORT_MAX_TERMS, `unique_terms=${r.unique_terms}`);
  assert.equal(r.arms, "hybrid");
  assert.equal(routeQueryArms("กรุงเทพอากาศเป็นอย่างไรบ้างวันนี้").arms, "hybrid");
});

test("#362: leer und reine Satzzeichen bleiben beim heutigen Weg", () => {
  assert.deepEqual(routeQueryArms(""), { arms: "hybrid", reason: "default", unique_terms: 0, identifier_terms: 0 });
  assert.equal(routeQueryArms("?! …").arms, "hybrid");
});
