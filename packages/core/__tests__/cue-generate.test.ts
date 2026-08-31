/**
 * Der Batch-Erzeuger für `descriptive_entity`-Cues (§31 Entscheidung 1, §11.4).
 *
 * Mit Mock-LLM, wie `trigger-expand.test.ts` — CI hat kein Ollama, und der
 * Prüfgegenstand ist ohnehin nicht das Modell, sondern was der Erzeuger mit
 * dessen Antwort macht: was er liest, was er verwirft, welche Provenienz er
 * anhängt und woher die Konfidenz kommt.
 *
 * Die Auflage mit der längsten Halbwertszeit steht in §11.4 und wird hier
 * zuerst geprüft: `recall_when` ist die konkurrierende Vertrauensklasse. Ein
 * Erzeuger, der die handgeschriebenen Trigger liest, schreibt sie um, statt
 * eine eigene Cue-Familie zu bilden — und der spätere Vergleich der beiden
 * Klassen misst dann sich selbst.
 *
 * Runner: node --import tsx --test packages/core/__tests__/cue-generate.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCuePrompt,
  parseCueCandidates,
  confidenceFromRank,
  generateCuesFor,
  generateCueBatch,
  cueToJsonl,
  CUE_GENERATOR_VERSION,
  CUE_PROMPT_VERSION,
  type CueBatchOptions,
} from "../src/cue-generate.js";
import { parseCueRecord, cueSourceFingerprint } from "../src/cue-sidecar.js";
import type { Memory } from "../src/schema.js";
import type { Vault } from "../src/vault.js";

function memory(over: Partial<Memory["fm"]> = {}, body = "Police 4711 bei der Allianz."): Memory {
  return {
    fm: {
      id: "m1",
      title: "Hausratversicherung Allianz",
      type: "reference",
      summary: "Police 4711, jährlich 240 Euro.",
      topic_path: ["finanzen", "versicherungen"],
      tags: ["versicherung", "allianz"],
      scope: "privat",
      recall_when: ["GEHEIMTRIGGER wenn die Police fällig ist"],
      created: "2026-01-01",
      updated: "2026-01-01",
      ...over,
    },
    body,
    filePath: "/vault/m1.md",
    mtime: 0,
  } as unknown as Memory;
}

/** Ein Modell, das immer dieselbe Liste liefert, und mitschreibt, was es sah. */
function mockChat(reply: string): { chat: CueBatchOptions["chat"]; prompts: string[] } {
  const prompts: string[] = [];
  return {
    chat: async (p) => {
      prompts.push(p);
      return reply;
    },
    prompts,
  };
}

/** Selbsttest, der jeden Cue auf einem festen Rang zurückholt. */
const rankAlways = (rank: number | null): CueBatchOptions["selfTest"] =>
  async () => ({ rank });

const baseOpts = (over: Partial<CueBatchOptions> = {}): CueBatchOptions => ({
  chat: mockChat("Versicherungsunterlagen\nFinanzen").chat,
  selfTest: rankAlways(1),
  model: "test-model",
  now: () => new Date("2026-08-28T12:00:00.000Z"),
  ...over,
});

// ── Die Auflage: recall_when ist kein Input ──────────────────────

test("der Prompt liest den autorisierten Inhalt — und recall_when NICHT", () => {
  const prompt = buildCuePrompt(memory());
  assert.match(prompt, /Hausratversicherung Allianz/, "Titel");
  assert.match(prompt, /Police 4711, jährlich 240 Euro/, "Summary");
  assert.match(prompt, /versicherung, allianz/, "Tags");
  assert.match(prompt, /finanzen \/ versicherungen/, "topic_path");
  assert.match(prompt, /Police 4711 bei der Allianz/, "Body");
  assert.ok(
    !prompt.includes("GEHEIMTRIGGER"),
    "§11.4: die handgeschriebenen Trigger sind die andere Vertrauensklasse",
  );
});

test("der Prompt fragt nach dem Oberbegriff, nicht nach einer Paraphrase", () => {
  const prompt = buildCuePrompt(memory());
  assert.match(prompt, /SUPERORDINATE CONCEPTS/);
  assert.match(prompt, /one level UP/);
});

test("injizierte Kontextblöcke gehen nicht in den Prompt", () => {
  const m = memory({}, "<recall-hints>fremder Text</recall-hints>\nEchter Inhalt.");
  const prompt = buildCuePrompt(m);
  assert.ok(!prompt.includes("fremder Text"), "#149: gescrubbt");
  assert.match(prompt, /Echter Inhalt/);
});

// ── Parser ──────────────────────────────────────────────────────

test("der Parser räumt Aufzählungszeichen, Nummern und Anführungszeichen weg", () => {
  const out = parseCueCandidates('- Versicherungsunterlagen\n2. "Finanzen"\n* Verträge', 5);
  assert.deepEqual(out, ["Versicherungsunterlagen", "Finanzen", "Verträge"]);
});

test("Slug-Ketten, Fragen, überlange Zeilen und Dubletten fallen raus", () => {
  const raw = [
    "Versicherungsunterlagen",
    "versicherung-police-allianz-2026",
    "Welchem Begriff gehört das an?",
    "x".repeat(80),
    "versicherungsunterlagen",
    "Finanzen",
  ].join("\n");
  assert.deepEqual(parseCueCandidates(raw, 5), ["Versicherungsunterlagen", "Finanzen"]);
});

test("der Parser respektiert die Obergrenze", () => {
  assert.equal(parseCueCandidates("a\nb\nc\nd\ne", 2).length, 2);
});

// ── Konfidenz aus dem Selbsttest ────────────────────────────────

test("die Konfidenz ist der reziproke Rang", () => {
  assert.equal(confidenceFromRank(1), 1);
  assert.equal(confidenceFromRank(2), 0.5);
  assert.equal(confidenceFromRank(4), 0.25);
  assert.equal(confidenceFromRank(null), 0, "nicht zurückgeholt heißt keine Konfidenz");
  assert.equal(confidenceFromRank(0), 0);
});

test("ein Cue, der sein eigenes Memory nicht zurückholt, wird verworfen und gezählt", async () => {
  const r = await generateCuesFor(memory(), baseOpts({ selfTest: rankAlways(null) }));
  assert.equal(r.cues.length, 0);
  assert.equal(r.dropped.selfTest, 2, "beide Kandidaten");
});

test("die Konfidenzschwelle ist ein freier Parameter und greift", async () => {
  const unter = await generateCuesFor(
    memory(),
    baseOpts({ selfTest: rankAlways(4), minConfidence: 0.5 }),
  );
  assert.equal(unter.cues.length, 0);
  assert.equal(unter.dropped.lowConfidence, 2);

  const drueber = await generateCuesFor(
    memory(),
    baseOpts({ selfTest: rankAlways(1), minConfidence: 0.5 }),
  );
  assert.equal(drueber.cues.length, 2);
});

test("die Obergrenze pro Memory ist ein freier Parameter und greift", async () => {
  const r = await generateCuesFor(
    memory(),
    baseOpts({ chat: mockChat("A\nB\nC\nD").chat, maxCues: 2 }),
  );
  assert.equal(r.cues.length, 2);
});

// ── Provenienz ──────────────────────────────────────────────────

test("jeder Cue trägt die vollständige Provenienz und übersteht den eigenen Parser", async () => {
  const m = memory();
  const r = await generateCuesFor(m, baseOpts());
  const cue = r.cues[0];
  assert.equal(cue.memory_id, "m1");
  assert.equal(cue.family, "descriptive_entity");
  assert.equal(cue.cue, "Versicherungsunterlagen");
  assert.equal(cue.origin, "batch", "§31: der Batch-Weg, eine der beiden Bedingungen");
  assert.equal(cue.generator_version, CUE_GENERATOR_VERSION);
  assert.equal(cue.prompt_version, CUE_PROMPT_VERSION);
  assert.equal(cue.model, "test-model");
  assert.equal(cue.derived_at, "2026-08-28T12:00:00.000Z");
  assert.equal(cue.confidence, 1);
  assert.equal(
    cue.evidence.source_fingerprint,
    cueSourceFingerprint(m),
    "der Evidenzbezug zeigt auf den Inhalt, aus dem der Cue kam",
  );
  // Der Kreis muss sich schließen: Was der Erzeuger schreibt, muss der Leser
  // aus 152c61d akzeptieren — sonst erzeugt der Batch eine Datei, die die
  // Projektion vollständig verwirft.
  assert.deepEqual(parseCueRecord(JSON.parse(cueToJsonl(cue))), cue);
});

test("Modell und Prompt-Fassung machen zwei Läufe unterscheidbar", async () => {
  const a = (await generateCuesFor(memory(), baseOpts({ model: "modell-a" }))).cues[0];
  const b = (await generateCuesFor(memory(), baseOpts({ model: "modell-b" }))).cues[0];
  assert.notEqual(a.model, b.model);
  assert.equal(a.cue, b.cue, "gleiche Eingabe, gleicher Anspruch — nur die Herkunft trennt sie");
});

// ── Der Sweep ───────────────────────────────────────────────────

/** Ein Vault-Ausschnitt: der Sweep benutzt nur `list()`. */
function fakeVault(memories: Memory[]): Vault {
  return { list: () => memories } as unknown as Vault;
}

test("der Sweep überspringt obsolete Memories und zählt, was er tat", async () => {
  const cues: string[] = [];
  const report = await generateCueBatch(
    fakeVault([
      memory({ id: "a" }),
      memory({ id: "b", obsolete: true } as Partial<Memory["fm"]>),
      memory({ id: "c" }),
    ]),
    { ...baseOpts(), onCue: (c) => void cues.push(c.memory_id) },
  );
  assert.equal(report.memories_seen, 2, "obsolete zählt nicht mit");
  assert.equal(report.memories_with_cues, 2);
  assert.equal(report.cues_written, 4, "zwei Cues je Memory");
  assert.deepEqual(cues, ["a", "a", "c", "c"]);
});

test("ein Modell, das nur schweigt, stoppt den Sweep statt ihn zu Ende zu quälen", async () => {
  const many = Array.from({ length: 20 }, (_, i) => memory({ id: `m${i}` }));
  const report = await generateCueBatch(fakeVault(many), {
    ...baseOpts({ chat: mockChat("").chat }),
    onCue: () => {},
  });
  assert.equal(report.stopped_early, true);
  assert.equal(report.cues_written, 0);
  assert.equal(report.memories_seen, 5, "nach fünf Fehlschlägen ist Schluss");
});

test("ein einzelner Fehlschlag stoppt den Sweep nicht", async () => {
  let call = 0;
  const report = await generateCueBatch(
    fakeVault([memory({ id: "a" }), memory({ id: "b" }), memory({ id: "c" })]),
    {
      ...baseOpts({
        chat: async () => {
          call++;
          if (call === 1) throw new Error("Modell hat gehustet");
          return "Versicherungsunterlagen";
        },
      }),
      onCue: () => {},
    },
  );
  assert.equal(report.stopped_early, false);
  assert.equal(report.generation_failures, 1);
  assert.equal(report.cues_written, 2, "die beiden folgenden Memories laufen durch");
});
