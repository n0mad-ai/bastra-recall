/**
 * Die Hop-Regeln, ausdrücklich statt geerbt (#265, C-046, C-031, C-052; §13.1,
 * §18.2, §9.4, §24).
 *
 * Drei Auflagen, die heute schon gelten — aber aus Zufällen, nicht aus Regeln:
 *
 *  1. Ein nur über einen Graph-Hop erreichter Treffer wird nie `required`.
 *     Bisher hielt das, weil die skalierte Rang-Summe einen Nachbarn bei rund
 *     82 deckelt (unter dem Cut von 100) und weil der BM25-Fallback über
 *     `unfused` ohnehin nichts bandet. Beide Zufälle können kippen — ein
 *     anderer Cut, eine andere Skalierung —, und dann wäre die Auflage still
 *     weg.
 *  2. Die Hop-Herkunft bleibt serverintern. Die schlanke Projektion (id,
 *     title, type, scope, summary, score) ist der öffentliche Vertrag; der Hop
 *     gehört in Telemetrie und Debug, wo §18.2/§18.5 ihn brauchen.
 *  3. Kein Cross-Encoder, kein Reranker, kein Deep Recall im
 *     SessionStart-Budget.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/hop-provenance-rules.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bandHits } from "../src/band-wording.js";
import { toLeanHit } from "../src/recall-handler.js";
import type { RecallHit } from "@bastra-recall/core";

const CUT = 100;

const hit = (id: string, score: number, hop?: "direct" | "1-hop") => ({ id, score, ...(hop ? { hop } : {}) });

// ── 1. Hop-only wird nie required ───────────────────────────────

test("ein Hop-Treffer über dem Cut landet trotzdem nicht in required", () => {
  // Der Fall, den die Score-Skalierung heute abfängt und morgen vielleicht
  // nicht mehr: ein Nachbar mit einem Wert oberhalb des Cuts.
  const banded = bandHits([hit("nachbar", 150, "1-hop")], CUT, false);
  assert.deepEqual(banded.required, [], "C-046: ein Hop allein ist keine Evidenz");
  assert.equal(banded.optional.length, 1, "verworfen wird er nicht — nur nicht required");
  assert.equal(banded.optional[0].id, "nachbar");
});

test("ein direkter Treffer über dem Cut bleibt required", () => {
  const banded = bandHits([hit("direkt", 150, "direct")], CUT, false);
  assert.deepEqual(banded.required.map((h) => h.id), ["direkt"]);
});

test("ohne Hop-Angabe bandet es wie bisher — die schlanke Projektion trägt keinen Hop", () => {
  // Die Lane sieht projizierte Hits ohne `hop`. Die Regel darf ihr Verhalten
  // nicht ändern, sonst hinge das Banding an einem Feld, das dort nie ankommt.
  const banded = bandHits([hit("projiziert", 150)], CUT, false);
  assert.deepEqual(banded.required.map((h) => h.id), ["projiziert"]);
});

test("gemischt: der direkte Treffer wird required, der Nachbar nicht", () => {
  const banded = bandHits(
    [hit("direkt", 160, "direct"), hit("nachbar", 155, "1-hop"), hit("schwach", 40, "direct")],
    CUT,
    false,
  );
  assert.deepEqual(banded.required.map((h) => h.id), ["direkt"]);
  assert.deepEqual(banded.optional.map((h) => h.id).sort(), ["nachbar", "schwach"]);
});

test("auf dem unfusionierten Pfad bandet weiterhin nichts — auch kein Hop", () => {
  // §9.4: Ohne Vektorarm gibt es keine Fusion, keine Obergrenze und damit kein
  // Band. Der rohe BM25-Wert reißt jeden Cut trivial; genau deshalb ist der
  // Fallbackpfad der, auf dem die Regel sonst NICHT durch die Skalierung
  // geschützt wäre.
  const banded = bandHits([hit("roh", 405585, "1-hop"), hit("roh2", 12000)], CUT, true);
  assert.deepEqual(banded.required, []);
  assert.deepEqual(banded.optional, []);
  assert.equal(banded.unbanded.length, 2);
});

// ── 2. Die Hop-Herkunft verlässt den Server nicht ───────────────

test("die schlanke Projektion trägt keinen Hop", () => {
  const full = {
    id: "m1",
    title: "T",
    type: "reference",
    scope: "s",
    summary: "S",
    score: 120,
    hop: "1-hop",
    mode: "hybrid",
    matched_terms: ["x"],
    topic_path: ["a"],
  } as unknown as RecallHit;
  const lean = toLeanHit(full);
  assert.deepEqual(Object.keys(lean).sort(), ["id", "scope", "score", "summary", "title", "type"]);
  assert.ok(!("hop" in lean), "§13.1: die Herkunft gehört in Telemetrie und Debug, nicht in die Antwort");
});

test("auch die Hook-Antwort projiziert den Hop nicht", () => {
  // Der Hook-Pfad baut seine Antwort aus `toLeanHit` plus drei benannten
  // Zusatzfeldern. Kippt das, hinge der öffentliche Vertrag an einer
  // Spread-Zeile, die niemand mehr liest.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "http-hook-routes.ts"), "utf8");
  const start = src.indexOf("const payload = {");
  assert.ok(start > 0, "die Antwortprojektion des Hook-Pfades ist unauffindbar");
  // Bis zum ersten `vault_size` NACH dem Payload-Anfang: derselbe Ausdruck
  // steht weiter oben schon einmal in einer anderen Antwort.
  const payload = src.slice(start, src.indexOf("vault_size: vault.size()", start));
  assert.ok(payload.includes("...toLeanHit(h)"), "die Projektion läuft über toLeanHit");
  assert.ok(!/\bhop\b\s*:/.test(payload), "kein hop-Feld in der Hook-Antwort");
});

// ── 3. Was im SessionStart-Budget nie läuft ─────────────────────

test("der Assembler ruft weder Reranker noch Cross-Encoder noch Deep Recall", () => {
  // C-031/C-052, §9.4/§24: „Hooks blockieren nie auf einen langsamen
  // Reranker", und ein Cross-Encoder läuft grundsätzlich nicht im
  // SessionStart-Budget. Es gibt keinen Laufzeit-Schalter, an dem sich das
  // prüfen ließe — die Zusage ist die Abwesenheit. Also wird die Abwesenheit
  // geprüft.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "session-assembler.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const forbidden of ["reranker", "rerank", "cross-encoder", "crossEncoder", "deepRecall", "deep-recall"]) {
    assert.ok(
      !code.includes(forbidden),
      `session-assembler.ts greift auf "${forbidden}" zu — das gehört nicht ins SessionStart-Budget`,
    );
  }
});
