/**
 * Das Cue-Sidecar-Format (§11.4).
 *
 * Zwei Auflagen des Vertrags sind hier Prüfgegenstand, weil sie sich später
 * nicht nachrüsten lassen, ohne jede bereits erzeugte Datei zu entwerten:
 *
 *  1. Provenienz ist Pflicht. „Jeder abgeleitete Cue trägt IMMER Ziel-ID des
 *     Memorys, Herkunft, Generatorversion, `derived_at`, Konfidenz und die
 *     Verbindung zur Evidenz." Ein Datensatz ohne eines dieser Felder ist kein
 *     sparsamer Cue, sondern keiner.
 *  2. Ungültig ist nicht degradiert. „Ein Cue ohne auflösbare Ziel-ID oder ohne
 *     Evidenzverbindung ist kein unvollständiger Cue, sondern ein ungültiger.
 *     Er wird verworfen, nicht degradiert verwendet." Und er wird GEZÄHLT —
 *     eine Projektion, die stillschweigend die Hälfte verschluckt, macht jede
 *     spätere Cue-Zahl uneinordenbar.
 *
 * Dazu die dritte, die in §11.4 bewusst NEBEN der Ungültigkeit steht: „ein Cue,
 * dessen Ziel-Memory sich ändert, wird als veraltet markiert, statt
 * stillschweigend weiter zu feuern."
 *
 * Runner: node --import tsx --test packages/core/__tests__/cue-sidecar.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectCues,
  loadCueProjection,
  cueSourceFingerprint,
  cueSidecarPath,
  describeCueProjection,
  type CueTargetSource,
} from "../src/cue-sidecar.js";
import type { Memory } from "../src/schema.js";

function memory(id: string, title = "Vertrag Allianz", body = "Police 4711."): Memory {
  return {
    fm: {
      id,
      title,
      type: "reference",
      summary: title,
      topic_path: ["test"],
      tags: ["vertrag"],
      scope: "test-scope",
      recall_when: ["wenn es um die Police geht"],
      created: "2026-01-01",
      updated: "2026-01-01",
    },
    body,
    filePath: `/vault/${id}.md`,
    mtime: 0,
  } as unknown as Memory;
}

function targets(...ms: Memory[]): CueTargetSource {
  const map = new Map(ms.map((m) => [m.fm.id as string, m]));
  return { get: (id) => map.get(id) };
}

/** Ein vollständiger Datensatz — die Basis, von der die Fehlerfälle je genau
 *  ein Feld abziehen, damit klar ist, WELCHES Feld den Ausschlag gab. */
function record(m: Memory, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    memory_id: m.fm.id,
    family: "descriptive_entity",
    cue: "Versicherungsunterlagen",
    origin: "batch",
    generator_version: "cue-gen@1",
    model: "embeddinggemma",
    prompt_version: "descriptive-entity@1",
    derived_at: "2026-08-28T10:00:00.000Z",
    confidence: 0.8,
    evidence: { source_fingerprint: cueSourceFingerprint(m) },
    ...over,
  });
}

test("ein vollständiger Cue landet in der Projektion", () => {
  const m = memory("m1");
  const p = projectCues([record(m)], targets(m));
  assert.equal(p.accepted, 1);
  assert.deepEqual(p.byMemory.get("m1"), ["Versicherungsunterlagen"]);
  assert.deepEqual(p.rejected, []);
  assert.deepEqual(p.stale, []);
});

test("mehrere Cues desselben Memorys sammeln sich", () => {
  const m = memory("m1");
  const p = projectCues(
    [record(m), record(m, { cue: "Haftpflicht" })],
    targets(m),
  );
  assert.equal(p.accepted, 2);
  assert.deepEqual(p.byMemory.get("m1"), ["Versicherungsunterlagen", "Haftpflicht"]);
});

// ── Auflage 1: Provenienz ist Pflicht ───────────────────────────

for (const field of [
  "memory_id",
  "family",
  "cue",
  "origin",
  "generator_version",
  // Die Reproduzierbarkeits-Auflage aus §31 Entscheidung 1: Ohne Modell und
  // Prompt-Fassung ließe sich ein späterer Befund keiner Erzeugung zuordnen.
  "model",
  "prompt_version",
  "derived_at",
  "confidence",
  "evidence",
] as const) {
  test(`ohne ${field} ist es kein Cue`, () => {
    const m = memory("m1");
    const line = record(m, { [field]: undefined });
    const p = projectCues([line], targets(m));
    assert.equal(p.accepted, 0, `${field} muss Pflicht sein`);
    assert.equal(p.rejected.length, 1);
    assert.equal(p.rejected[0].reason, "incomplete_provenance");
    assert.equal(p.rejected[0].line, 1, "die Meldung zeigt auf die Zeile");
  });
}

test("eine Evidenzverbindung ohne Fingerabdruck zählt nicht als Evidenz", () => {
  const m = memory("m1");
  const p = projectCues([record(m, { evidence: {} })], targets(m));
  assert.equal(p.accepted, 0);
  assert.equal(p.rejected[0].reason, "incomplete_provenance");
});

test("eine Konfidenz außerhalb von 0..1 ist keine Konfidenz", () => {
  const m = memory("m1");
  const p = projectCues([record(m, { confidence: 1.5 })], targets(m));
  assert.equal(p.accepted, 0);
  assert.equal(p.rejected[0].reason, "incomplete_provenance");
});

test("eine unbekannte Cue-Familie wird abgewiesen", () => {
  const m = memory("m1");
  const p = projectCues([record(m, { family: "vibes" })], targets(m));
  assert.equal(p.accepted, 0);
  assert.equal(p.rejected[0].reason, "incomplete_provenance");
});

test("alle vier Vertragsfamilien sind zulässig — der Typ schließt keine aus", () => {
  const m = memory("m1");
  for (const family of [
    "descriptive_entity",
    "associative_bridge",
    "descriptive_scene",
    "associative_horizon",
  ]) {
    const p = projectCues([record(m, { family })], targets(m));
    assert.equal(p.accepted, 1, `${family} steht in der Tabelle in §11.4`);
  }
});

// ── Auflage 2: ungültig ist nicht degradiert, und wird gezählt ───

test("ein Cue auf eine nicht auflösbare Ziel-ID wird verworfen, nicht degradiert", () => {
  const m = memory("m1");
  const fremd = memory("geloescht");
  const p = projectCues([record(fremd)], targets(m));
  assert.equal(p.accepted, 0, "verworfen");
  assert.equal(p.byMemory.size, 0, "und nirgends degradiert untergebracht");
  assert.equal(p.rejected.length, 1, "gezählt");
  assert.equal(p.rejected[0].reason, "unresolvable_target");
  assert.equal(p.rejected[0].memory_id, "geloescht", "und benannt");
});

test("eine kaputte Zeile kostet einen Cue, nicht die Projektion", () => {
  const m = memory("m1");
  const p = projectCues(["{kein json", record(m), ""], targets(m));
  assert.equal(p.accepted, 1, "die intakte Zeile überlebt");
  assert.equal(p.rejected.length, 1);
  assert.equal(p.rejected[0].reason, "malformed_line");
  assert.equal(p.rejected[0].line, 1);
});

test("die Meldung nennt Zahlen und Gründe, keine Cue-Texte", () => {
  const m = memory("m1");
  const p = projectCues([record(m), "{kaputt", record(memory("weg"))], targets(m));
  const line = describeCueProjection(p);
  assert.match(line, /1 cues over 1 memories/);
  assert.match(line, /2 rejected/);
  assert.match(line, /malformed_line=1/);
  assert.match(line, /unresolvable_target=1/);
  assert.ok(!line.includes("Versicherungsunterlagen"), "kein Cue-Text in der Meldung");
});

// ── Veraltung: markiert, nicht stillschweigend weiterfeuernd ─────

test("ändert sich das Ziel-Memory, feuert der Cue nicht mehr — er wird veraltet gemeldet", () => {
  const alt = memory("m1", "Vertrag Allianz", "Police 4711.");
  const line = record(alt);
  const neu = memory("m1", "Vertrag Allianz", "Police 4711. Nachtrag: gekündigt.");
  const p = projectCues([line], targets(neu));
  assert.equal(p.accepted, 0, "nicht weiterfeuern");
  assert.equal(p.byMemory.size, 0);
  assert.deepEqual(p.rejected, [], "veraltet ist NICHT ungültig — §11.4 trennt die beiden");
  assert.equal(p.stale.length, 1, "sondern markiert");
  assert.equal(p.stale[0].memory_id, "m1");
});

test("ein unveränderter Titel mit neuem recall_when lässt den Cue leben", () => {
  const m = memory("m1");
  const line = record(m);
  const mitNeuemTrigger = memory("m1");
  (mitNeuemTrigger.fm as { recall_when: string[] }).recall_when = ["ganz anderer Trigger"];
  const p = projectCues([line], targets(mitNeuemTrigger));
  assert.equal(p.accepted, 1, "recall_when ist die andere Vertrauensklasse, kein Cue-Anlass");
});

// ── Rollback: die fehlende Datei ist der Normalfall ──────────────

test("ohne Sidecar-Datei ist die Projektion leer und wirft nicht", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-cue-"));
  try {
    const p = await loadCueProjection(dir, targets(memory("m1")));
    assert.equal(p.accepted, 0);
    assert.equal(p.byMemory.size, 0);
    assert.deepEqual(p.rejected, [], "keine Datei ist kein Fehler, sondern der Rollback");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("die Datei liegt unter .bastra, nicht bei den Memories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-cue-"));
  try {
    const path = cueSidecarPath(dir);
    assert.equal(path, join(dir, ".bastra", "cues.jsonl"));
    assert.ok(!path.includes("memories"), "eine abgeleitete Projektion gehört nicht in den Bestand");
    const m = memory("m1");
    await mkdir(join(dir, ".bastra"), { recursive: true });
    await writeFile(path, record(m) + "\n", "utf8");
    const p = await loadCueProjection(dir, targets(m));
    assert.equal(p.accepted, 1);
    assert.deepEqual(p.byMemory.get("m1"), ["Versicherungsunterlagen"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
