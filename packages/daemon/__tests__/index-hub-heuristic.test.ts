/**
 * looksLikeIndexHub — die Grenze zwischen Navigation und Inhalt (#221).
 *
 * Feldtest von zzallirog auf 0.8.4: von 8 als Index übersprungenen Dateien
 * waren 3 gewöhnliche Notizen; die größte kam als Ghost mit Grad 18 zurück.
 * Ursache: Link-Dichte allein. Eine dichte Memory — Prosa-Fakten mit `·`
 * getrennt, Links inline — reißt die Dichte-Latte, obwohl sie echter Inhalt
 * ist. Seit dem Fix muss die Dichte halten UND die Datei ohne Body-Absätze
 * sein.
 *
 * Runner: `tsx --test __tests__/index-hub-heuristic.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeIndexHub } from "../src/import/index-harvest.js";

/** Handgepflegter Index: Abschnitte, Linkzeilen, ein Einzeiler-Hook je Eintrag. */
function realIndex(entries = 20): string {
  const lines = ["# vault index", "## projects"];
  for (let i = 0; i < entries; i++) lines.push(`- [note ${i}](note-${i}.md) — one-line hook`);
  lines.push("## semantic", "- [[some-note]] deep link", "- [[other-note]] deep link");
  return lines.join("\n");
}

test("a hand-maintained index is still recognised as navigation", () => {
  assert.equal(looksLikeIndexHub(realIndex()), true);
});

test("an index may open with one line of explanation and stay an index", () => {
  const withIntro = ["# vault index", "This file lists every note in the vault and is kept by hand."]
    .concat(realIndex().split("\n").slice(1))
    .join("\n");
  assert.equal(looksLikeIndexHub(withIntro), true);
});

/** Vorspann aus `n` echten Prosa-Absätzen, jeder über der 60-Zeichen-Marke. */
function preamble(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `Absatz ${i + 1}: Diese Datei hält die beiden Gedächtniszonen auseinander und erklärt, wofür sie da ist.`
  );
}

// zzallirogs Nachmessung an seinem Vault (#221): seine echten Indexe öffnen mit
// 4, 5 und 15 Prosa-Absätzen. Eine absolute Absatz-Toleranz las sie alle als
// Notiz — nach dem Fix blieb KEIN einziger Index mehr erkannt.
test("a real index survives a long preamble — 4 paragraphs over 130 links", () => {
  const body = ["# MEMORY", ...preamble(4), ...realIndex(130).split("\n").slice(1)].join("\n");
  assert.equal(looksLikeIndexHub(body), true, "MEMORY.md: 4 Absätze auf 130 Links");
});

test("a real index survives even 15 paragraphs over 177 links", () => {
  const body = ["# FEEDBACK_INDEX", ...preamble(15), ...realIndex(177).split("\n").slice(1)].join("\n");
  assert.equal(looksLikeIndexHub(body), true, "FEEDBACK_INDEX.md: 15 Absätze auf 177 Links");
});

test("prose that outweighs the links is a note, however many links it carries", () => {
  // Dieselbe Absatzzahl, aber nur ein Zehntel der Links: das kippt die Waage.
  const body = ["# note", ...preamble(15), ...realIndex(15).split("\n").slice(1)].join("\n");
  assert.equal(looksLikeIndexHub(body), false, "15 Absätze auf 15 Links sind Inhalt");
});

test("#221: a dense note with inline links is content, not navigation", () => {
  // Der gemeldete False Positive: Prosa-Fakten, `·`-getrennt, Links mittendrin.
  const dense = [
    "Der Daemon hält BM25 und den Embedding-Index in EINEM Prozess — siehe [http](http.ts.md) ·",
    "die Hooks sprechen ihn über [hook/recall](hook-recall.md) an, nie über die REST-Fläche ·",
    "der Forwarder startet ihn bei Bedarf, [siehe hier](forwarder.md), und hält ihn am Leben ·",
    "Wichtig: der Idle-Shutdown zählt [/health](health.md) NICHT als Aktivität, sonst hält ihn",
    "ein Monitor ewig wach — die Begründung steht in [#50](issue-50.md) und in [#92](issue-92.md) ·",
    "Für die Map projiziert [graph](graph.md) den Vault; [semantic](semantic.md) legt die",
    "Bedeutungsebene darüber, und [live-updates](live.md) speist die Notices der Oberfläche.",
  ].join("\n");
  assert.equal(looksLikeIndexHub(dense), false, "a degree-18 ghost is a note that was dropped");
});

test("list-heavy notes are judged by their paragraphs, not their bullets", () => {
  // Notizen nutzen auch Listen — Listenzeilen dürfen deshalb nichts entscheiden.
  const listyNote = [
    "Diese Entscheidung fiel nach dem Feldtest und betrifft den gesamten Importpfad des Vaults.",
    "- [a](a.md)",
    "- [b](b.md)",
    "- [c](c.md)",
    "- [d](d.md)",
    "- [e](e.md)",
    "- [f](f.md)",
    "- [g](g.md)",
    "- [h](h.md)",
    "Der Grund dafür ist die Ghost-Zahl: jede übersprungene Notiz kehrt als Lücke im Rad zurück.",
  ].join("\n");
  assert.equal(looksLikeIndexHub(listyNote), false, "two body paragraphs are content");
});

test("too few links is never a hub, whatever the prose does", () => {
  assert.equal(looksLikeIndexHub("- [a](a.md)\n- [b](b.md)\n- [c](c.md)"), false);
});
