/**
 * Der globale Context Governor (#266, §16.3).
 *
 * Geprüft wird die Entscheidung — und die drei Eigenschaften, die sie NICHT
 * haben darf, weil sie sonst Auflagen aus dem Vertrag verletzt:
 *
 *  - Sie sortiert nicht um. Die Reihenfolge kommt vom Aufrufer; der Governor
 *    streicht nur. Umsortieren hieße, eine anderswo begründete Trefferauswahl
 *    zu verändern (C-030/C-046).
 *  - Sie kennt keine Hop-Herkunft. Trimmen darf die eine `related_via`-Sicht
 *    des Hook-Pfades nicht als Klasse wegräumen (C-046).
 *  - Sie lernt nichts. Die Wiedererwähnung entscheidet Sitzungszustand, kein
 *    Nutzungssignal (C-037, §17.5).
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/context-governor.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { governContext, estimateTokens } from "../src/context-governor.js";

/** 40 Zeichen ≈ 10 Token — bequem rechenbare Einträge. */
const item = (id: string, priority: number, chars = 40, over: Record<string, unknown> = {}) => ({
  id,
  priority,
  text: "x".repeat(chars),
  ...over,
});

// ── §16.3 Frage 1: wie viele Memories ───────────────────────────

test("die Höchstzahl greift, und zwar nach Priorität", () => {
  const d = governContext(
    [item("c", 3), item("a", 1), item("b", 2)],
    { items: 2 },
  );
  assert.deepEqual(d.kept.map((i) => i.id), ["a", "b"], "die beiden wichtigsten");
  assert.deepEqual(d.dropped, [{ id: "c", reason: "item_budget" }]);
});

test("ohne Budget bleibt alles", () => {
  const d = governContext([item("a", 1), item("b", 2)]);
  assert.equal(d.kept.length, 2);
  assert.deepEqual(d.dropped, []);
  assert.deepEqual(d.budget, { tokens: 0, items: 0 });
});

// ── §16.3 Frage 2: wie viele Token ──────────────────────────────

test("das Token-Budget greift und wird bilanziert", () => {
  // Drei Einträge à 10 Token, Budget 25 → zwei passen.
  const d = governContext([item("a", 1), item("b", 2), item("c", 3)], { tokens: 25 });
  assert.deepEqual(d.kept.map((i) => i.id), ["a", "b"]);
  assert.equal(d.tokens_spent, 20);
  assert.deepEqual(d.dropped, [{ id: "c", reason: "token_budget" }]);
});

test("ein Eintrag, der allein das Budget sprengt, fällt — er wird nicht gekürzt", () => {
  const d = governContext([item("riese", 1, 4000), item("klein", 2, 40)], { tokens: 25 });
  assert.deepEqual(d.kept.map((i) => i.id), ["klein"], "der kleine passt noch");
  assert.deepEqual(d.dropped, [{ id: "riese", reason: "token_budget" }]);
  // Ein halber Beleg ist keiner: Der Text der behaltenen Einträge ist
  // unangetastet.
  assert.equal(d.kept[0].text.length, 40);
});

test("beide Grenzen gelten gleichzeitig", () => {
  const d = governContext([item("a", 1), item("b", 2), item("c", 3)], { tokens: 1000, items: 1 });
  assert.equal(d.kept.length, 1);
  assert.equal(d.dropped.length, 2);
  assert.ok(d.dropped.every((x) => x.reason === "item_budget"));
});

// ── §16.3 Frage 4: erneute Erwähnung ────────────────────────────

test("was in dieser Sitzung schon gezeigt wurde, fällt zuerst", () => {
  const d = governContext(
    [item("alt", 1, 40, { alreadyShown: true }), item("neu", 2)],
    { items: 1 },
  );
  assert.deepEqual(d.kept.map((i) => i.id), ["neu"], "auch wenn `alt` die höhere Priorität hat");
  assert.deepEqual(d.dropped, [{ id: "alt", reason: "already_shown" }]);
});

test("der Aufrufer kann die Wiedererwähnung erlauben", () => {
  const d = governContext(
    [item("alt", 1, 40, { alreadyShown: true })],
    {},
    { allowRemention: true },
  );
  assert.deepEqual(d.kept.map((i) => i.id), ["alt"]);
});

test("die Entscheidung ist deterministisch — zweimal dasselbe Ergebnis", () => {
  const items = [item("a", 2), item("b", 1), item("c", 2)];
  const first = governContext(items, { items: 2 });
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(governContext(items, { items: 2 }).kept.map((x) => x.id), first.kept.map((x) => x.id));
  }
  // `b` (Priorität 1) und `a` (Priorität 2, vor `c` eingereicht) überleben —
  // ausgegeben aber in EINGABEreihenfolge, nicht in Prioritätsreihenfolge. Bei
  // Gleichstand entscheidet die Eingabereihenfolge, wer aufgenommen wird.
  assert.deepEqual(first.kept.map((x) => x.id), ["a", "b"]);
});

// ── Was der Governor NICHT tut ──────────────────────────────────

test("er sortiert nicht um — die Ausgabe steht in Eingabereihenfolge", () => {
  // `c` ist am wichtigsten, steht aber unten: Es überlebt, rutscht aber nicht
  // nach oben. Umsortieren wäre eine Änderung der Trefferauswahl, die der
  // Governor nicht begründen kann.
  const d = governContext([item("a", 3), item("b", 2), item("c", 1)], { items: 2 });
  assert.deepEqual(d.kept.map((i) => i.id), ["b", "c"], "Reihenfolge erhalten, `a` gestrichen");
});

test("er kennt keine Hop-Herkunft — ein Nachbar fällt wie jeder andere", () => {
  // C-046: Trimmen darf die `related_via`-Sicht nicht als KLASSE wegräumen.
  // Der Governor liest `hop` nicht; ein Nachbar mit guter Priorität überlebt.
  const d = governContext(
    [item("direkt", 2, 40, { hop: "direct" }), item("nachbar", 1, 40, { hop: "1-hop" })],
    { items: 1 },
  );
  assert.deepEqual(d.kept.map((i) => i.id), ["nachbar"], "Priorität entscheidet, nicht die Herkunft");
});

test("jeder gestrichene Eintrag trägt seinen Grund", () => {
  const d = governContext(
    [item("a", 1, 40, { alreadyShown: true }), item("b", 2), item("c", 3)],
    { items: 1 },
  );
  assert.equal(d.dropped.length, 2);
  assert.deepEqual(new Set(d.dropped.map((x) => x.reason)), new Set(["already_shown", "item_budget"]));
  // Ein stillschweigend gestrichener Kandidat wäre genau die Unsichtbarkeit,
  // die #266 beheben soll.
  assert.ok(d.dropped.every((x) => typeof x.id === "string" && x.reason));
});

test("der Governor beschafft nichts nach — kein Deep Recall, kein Reranker", () => {
  // C-031/C-052, §9.4: Es gibt keinen Laufzeit-Schalter dafür; die Zusage ist
  // die Abwesenheit. Also wird die Abwesenheit geprüft — dieselbe Technik wie
  // beim Session-Assembler.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "context-governor.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const forbidden of ["reranker", "rerank", "crossEncoder", "deepRecall", "recall(", "search", "await "]) {
    assert.ok(!code.includes(forbidden), `der Governor greift auf "${forbidden}" zu — er entscheidet nur`);
  }
});

test("die Token-Schätzung ist die des Repos — vier Zeichen je Token", () => {
  assert.equal(estimateTokens("x".repeat(40)), 10);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1, "aufgerundet");
});

// ── Äquivalenz zur abgelösten Lane-Mechanik (#266 Teilpaket 3) ───

/**
 * Die beiden Hint-Lanes filterten ihre Treffer bis e7bc670 selbst:
 *
 *     for (const h of hits) {
 *       if (shouldDropHit(state.shown[h.id], loadedMtime)) continue;
 *       kept.push(h);
 *     }
 *
 * Jetzt tun sie es über `governContext(items, {})` — ohne Budget, weil sie
 * heute keines haben. Die Auflage war Mechanik ohne Verschärfung, also muss der
 * Governor in genau diesem Aufruf dasselbe tun wie die abgelöste Schleife: die
 * bereits gezeigten streichen, sonst nichts, in derselben Reihenfolge.
 *
 * Statt eines Einzelfalls eine Eigenschaft über zufällige Eingaben — ein
 * Einzelfall trifft die Kante nicht, an der sich zwei Implementierungen
 * unterscheiden.
 */
test("ohne Budget streicht der Governor genau die bereits gezeigten — wie die alte Schleife", () => {
  let seed = 20260828;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let run = 0; run < 200; run++) {
    const items = Array.from({ length: Math.floor(rnd() * 8) }, (_, i) => ({
      id: `m${i}`,
      priority: i,
      text: "x".repeat(Math.floor(rnd() * 400)),
      alreadyShown: rnd() < 0.4,
    }));
    // Die abgelöste Schleife, wörtlich.
    const reference = items.filter((it) => !it.alreadyShown).map((it) => it.id);
    const governed = governContext(items, {}).kept.map((it) => it.id);
    assert.deepEqual(governed, reference, `Lauf ${run}: Ergebnis weicht ab`);
  }
});

test("und die Streichgründe machen sichtbar, was die Schleife nur mitzählte", () => {
  // Die Bash-Lane zählte `droppedDedupCount` hoch und verlor dabei, WELCHE
  // Treffer es traf. Der Governor nennt sie.
  const d = governContext(
    [
      { id: "a", priority: 0, text: "x", alreadyShown: true },
      { id: "b", priority: 1, text: "x" },
      { id: "c", priority: 2, text: "x", alreadyShown: true },
    ],
    {},
  );
  assert.deepEqual(d.kept.map((i) => i.id), ["b"]);
  assert.deepEqual(d.dropped, [
    { id: "a", reason: "already_shown" },
    { id: "c", reason: "already_shown" },
  ]);
});
