/**
 * Der Score-Modus erreicht auch die Lanes, die ihn bisher nicht kannten (P0).
 *
 * Prompt-, Todo- und Write-Lane lesen `unfused` seit #302 korrekt. SessionStart
 * und die beiden Bash-Lanes hatten eigene, ältere Response-Typen ohne dieses
 * Feld — sie banden also rohe BM25-Werte auf einer offenen Skala mit den Cuts
 * 50/100, die ausschließlich auf der fusionierten Skala (Obergrenze 163.934)
 * definiert sind. Nachgestellt: bei einem BM25-Score von 405585 behauptete
 * SessionStart „Both search paths agreed … score ≥100" — es lief genau EIN
 * Pfad.
 *
 * Zusätzlich sortierte SessionStart bis zu DREI unabhängig degradierende
 * Antworten direkt nach Score. Ein unbegrenzter Raum gewinnt gegen einen
 * gedeckelten immer, ohne besser zu sein.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/hook-lane-score-modes.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBlock, mergeSessionHits } from "../src/session-lane.js";
import { formatHintBlock as formatFailBlock } from "../src/bash-fail-lane.js";
import { formatHintBlock as formatPreBlock } from "../src/bash-pre-lane.js";
import { bandHits } from "../src/band-wording.js";

function hit(id: string, score: number) {
  return { id, title: `Title ${id}`, type: "lesson", scope: "test", summary: `Summary ${id}`, score };
}

test("SessionStart: ohne Fusion wird keine Übereinstimmung zweier Pfade behauptet", () => {
  // 405585 ist ein gemessener roher BM25-Wert. Auf der fusionierten Skala wäre
  // er unmöglich — die Obergrenze dort ist 163.934.
  const block = formatBlock([hit("a", 405585)], "demo", "startup", false, true);

  assert.doesNotMatch(block, /[Bb]oth search paths agreed/, "es lief nur ein Pfad");
  assert.doesNotMatch(block, /score ≥100/, "der fusionierte Cut beschreibt hier nichts");
  assert.doesNotMatch(block, /OPTIONAL \(score/, "auch das untere Band ist ein Cut");
  assert.match(block, /semantic search is off/i, "der Leser muss wissen, dass kein zweiter Pfad lief");
  assert.doesNotMatch(block, /score 405585/, "die Zahl lädt zum Vergleichen ein, den sie nicht trägt");
});

test("SessionStart: fusioniert bleibt alles wie bisher", () => {
  const block = formatBlock([hit("a", 164), hit("b", 60)], "demo", "startup", false, false);
  assert.match(block, /[Bb]oth search paths agreed/);
  assert.match(block, /OPTIONAL \(score 30–99\)/);
  assert.match(block, /score 164/);
});

test("SessionStart: drei unabhängig degradierende Antworten werden nicht numerisch gemischt", () => {
  // Query 1 lief hybrid (Rang-Summe), Query 2 fiel auf rohes BM25 zurück.
  // Ein Score-Vergleich stellt 405585 unbesehen an die Spitze, obwohl die
  // Zahl aus einem anderen Raum stammt.
  const responses = [
    { scope: "user-preference", resp: { hits: [hit("fused-1", 160), hit("fused-2", 120)] } },
    { scope: "all-projects", resp: { hits: [hit("raw-1", 405585)] } },
  ];
  const merged = mergeSessionHits(responses, true, 30);

  assert.deepEqual(
    merged.map((h) => h.id),
    ["fused-1", "raw-1", "fused-2"],
    "im gemischten Fall wird pro Query reihum genommen, nicht nach Zahl sortiert",
  );
});

test("SessionStart: fusioniert wird weiterhin nach Score sortiert und geflooert", () => {
  const responses = [
    { scope: "user-preference", resp: { hits: [hit("low", 40), hit("noise", 10)] } },
    { scope: "all-projects", resp: { hits: [hit("high", 160)] } },
  ];
  assert.deepEqual(
    mergeSessionHits(responses, false, 30).map((h) => h.id),
    ["high", "low"],
  );
});

test("Bash-Lanes: ohne Fusion wird keine Zahl gezeigt, die niemand vergleichen kann", () => {
  const fail = formatFailBlock([hit("a", 405585)], true);
  assert.doesNotMatch(fail, /score 405585/);
  assert.match(fail, /semantic search is off/i);

  const pre = formatPreBlock("rm -rf", "destructive", [hit("a", 405585)], true);
  assert.doesNotMatch(pre, /score 405585/);
  // Die Warnung selbst hängt nicht am Score und muss unverändert stehen.
  assert.match(pre, /STOP — destructive Bash command detected/);
});

test("die zentrale Banding-Funktion vergibt ohne Fusion kein Band", () => {
  const hits = [hit("a", 405585), hit("b", 1997)];
  const fused = bandHits(hits, 100, false);
  assert.deepEqual(fused.required.map((h) => h.id), ["a", "b"]);
  assert.deepEqual(fused.unbanded, []);

  const unfused = bandHits(hits, 100, true);
  assert.deepEqual(unfused.required, []);
  assert.deepEqual(unfused.optional, []);
  assert.deepEqual(unfused.unbanded.map((h) => h.id), ["a", "b"], "alle Hits, aber ohne Bandanspruch");
});
