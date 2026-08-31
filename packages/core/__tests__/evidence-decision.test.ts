/**
 * Der deterministische Evidenzentscheid (#264, §10.1–§10.3).
 *
 * Geprüft wird, was sich nachträglich nicht mehr reparieren lässt, weil es
 * entweder in geloggten Entscheidungen steht oder eine Vertragsauflage ist:
 *
 *  1. Was `required` rechtfertigt — ein harter Anker oder MEHRERE unabhängige
 *     Signale, nicht ein hoher Score. Die alten Schwellen 30/100 gelten nach
 *     §10.3 ausdrücklich nicht mehr.
 *  2. Die drei Sperren, die unabhängig von jeder Signalstärke greifen:
 *     Graph-Hop (C-046), abgeleiteter Cue (C-030), abgelaufenes Ziel.
 *  3. Was NICHT entsteht: keine `relevance_probability`, keine
 *     `source_confidence` aus dem heutigen `confidence`-Feld (C-049).
 *
 * Runner: node --import tsx --test packages/core/__tests__/evidence-decision.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideHit, decideHits, collectEvidence } from "../src/evidence-decision.js";
import type { RecallHit } from "../src/search.js";
import type { Memory } from "../src/schema.js";

function hit(over: Partial<RecallHit> = {}): RecallHit {
  return {
    id: "m1",
    title: "Deployment-Strategie",
    type: "reference",
    scope: "projekt-a",
    summary: "Wie deployed wird.",
    topic_path: ["projekt-a"],
    score: 150,
    matched_terms: [],
    ...over,
  } as RecallHit;
}

function memory(over: Partial<Memory["fm"]> = {}, body = "Text."): Memory {
  return {
    fm: {
      id: "m1",
      title: "Deployment-Strategie",
      type: "reference",
      summary: "Wie deployed wird.",
      topic_path: ["projekt-a"],
      tags: ["deploy"],
      scope: "projekt-a",
      recall_when: ["wenn wir deployen"],
      created: "2026-01-01",
      updated: "2026-01-01",
      ...over,
    },
    body,
    filePath: "/vault/m1.md",
    mtime: 0,
  } as unknown as Memory;
}

const bothArms = { rank_bm25: 1, rank_vector: 2, personal_score: 0.03, raw: 0.03 };
const oneArm = { rank_bm25: 1, rank_vector: null, personal_score: 0.03, raw: 0.03 };

// ── 1. Was `required` rechtfertigt ──────────────────────────────

test("ein exakter Identifier-Treffer ist ein harter Anker", () => {
  const d = decideHit({
    hit: hit({ title: "Konfig für app.config.ts" }),
    memory: memory({}, "Siehe app.config.ts im Root."),
    queryTerms: ["app.config.ts"],
  });
  assert.equal(d.evidence.exact_identifier, true);
  assert.equal(d.decision, "required");
});

test("ein vollständig abgedeckter handgeschriebener Trigger ist ein harter Anker", () => {
  const d = decideHit({
    hit: hit(),
    memory: memory({ recall_when: ["wenn wir deployen"] }),
    queryTerms: ["deployen"],
  });
  assert.equal(d.evidence.recall_when_coverage, 1);
  assert.equal(d.decision, "required");
});

test("ein hoher Score allein reicht NICHT — die alten Schwellen gelten nicht mehr", () => {
  // Rang-Summe knapp unter der Obergrenze, aber kein einziges Evidenzmerkmal:
  // genau der Fall, den §10.3 meint, wenn es 30/100 verwirft.
  const d = decideHit({
    hit: hit({ score: 163.9, rrf: oneArm, scope: "fremd" }),
    memory: memory({ recall_when: ["ganz anderer trigger"] }),
    queryTerms: ["unsinnsanfrage"],
    scope: "projekt-a",
  });
  assert.equal(d.decision, "no_answer");
  assert.equal(d.abstain_reason, "no_evidence");
});

test("zwei unabhängige Signale reichen — Armübereinstimmung plus Scope", () => {
  const d = decideHit({
    hit: hit({ rrf: bothArms, scope: "projekt-a" }),
    memory: memory({ recall_when: ["ganz anderer trigger"] }),
    queryTerms: ["unsinn"],
    scope: "projekt-a",
  });
  assert.equal(d.evidence.arm_agreement, true);
  assert.equal(d.evidence.scope_match, true);
  assert.equal(d.decision, "required");
});

test("ein einzelnes Signal ist ein Vorschlag, keine Pflicht", () => {
  const d = decideHit({
    hit: hit({ rrf: oneArm, scope: "projekt-a" }),
    memory: memory({ recall_when: ["ganz anderer trigger"] }),
    queryTerms: ["unsinn"],
    scope: "projekt-a",
  });
  assert.equal(d.evidence.arm_agreement, false);
  assert.equal(d.decision, "optional");
});

// ── 2. Die drei Sperren ─────────────────────────────────────────

test("ein Hop-Treffer wird nie required — auch mit hartem Anker nicht", () => {
  const d = decideHit({
    hit: hit({ hop: "1-hop", rrf: bothArms }),
    memory: memory({ recall_when: ["wenn wir deployen"] }),
    queryTerms: ["deployen"],
    scope: "projekt-a",
  });
  assert.equal(d.evidence.recall_when_coverage, 1, "der Anker ist da");
  assert.equal(d.decision, "optional", "C-046: der Hop trägt keine Pflicht");
  assert.equal(d.abstain_reason, "hop_only");
});

test("ein direkter Treffer mit demselben Anker wird required", () => {
  const d = decideHit({
    hit: hit({ hop: "direct" }),
    memory: memory({ recall_when: ["wenn wir deployen"] }),
    queryTerms: ["deployen"],
  });
  assert.equal(d.decision, "required", "die Sperre gilt dem Hop, nicht dem Anker");
});

test("ein Treffer, der nur über einen abgeleiteten Cue kommt, wird nie required", () => {
  // Der Cue-Term steht weder im handgeschriebenen Trigger noch als Identifier
  // im Text — §10.2/C-030: ein Cue öffnet den Kandidatenpfad und ist nie selbst
  // Beleg. Die Abdeckung bleibt deshalb 0, und ohne zweites Signal ist Schluss.
  const d = decideHit({
    hit: hit({ matched_terms: ["versicherungsunterlagen"], rrf: oneArm, scope: "fremd" }),
    memory: memory({ recall_when: ["wenn wir deployen"] }),
    queryTerms: ["versicherungsunterlagen"],
    scope: "projekt-a",
  });
  assert.equal(d.evidence.recall_when_coverage, 0, "ein Cue zählt nicht als Trigger-Abdeckung");
  assert.equal(d.evidence.exact_identifier, false);
  assert.notEqual(d.decision, "required");
});

test("ein abgelaufenes Ziel wird nie required", () => {
  const d = decideHit({
    hit: hit({ rrf: bothArms }),
    memory: memory({ recall_when: ["wenn wir deployen"], valid_until: "2020-01-01" } as never),
    queryTerms: ["deployen"],
    scope: "projekt-a",
  });
  assert.equal(d.evidence.temporal_status, "expired");
  assert.equal(d.decision, "optional");
  assert.equal(d.abstain_reason, "stale");
});

test("ein als überholt markiertes Ziel ebenso", () => {
  const d = decideHit({
    hit: hit(),
    memory: memory({ obsolete: true, recall_when: ["wenn wir deployen"] } as never),
    queryTerms: ["deployen"],
  });
  assert.equal(d.evidence.temporal_status, "obsolete");
  assert.notEqual(d.decision, "required");
});

// ── 3. Was NICHT entsteht ───────────────────────────────────────

test("keine relevance_probability, keine source_confidence", () => {
  const d = decideHit({
    hit: hit({ rrf: bothArms }),
    // Ein Memory mit dem heutigen confidence-Default 1.0 — genau der Wert, den
    // C-049 verbietet, als Beleg zu führen.
    memory: memory({ confidence: 1 } as never),
    queryTerms: ["deployen"],
  });
  const keys = Object.keys(d.evidence);
  assert.ok(!keys.includes("source_confidence"), "C-049: das Feld bleibt abwesend");
  assert.ok(!("relevance_probability" in d), "§10.1: erst nach unabhängiger Kalibrierung");
  assert.ok(!("accessibility" in d), "§10.1: erst nach dem M3-Gate");
});

test("fehlende Signale sind abwesend, nicht null", () => {
  const d = decideHit({ hit: hit({ rrf: oneArm }), queryTerms: ["x"] });
  assert.ok(!("vector_rank" in d.evidence), "ohne Vektorarm gibt es keinen Rang");
  assert.ok(!("vector_similarity" in d.evidence), "Ränge sind keine Ähnlichkeiten");
  assert.equal(d.evidence.lexical_rank, 1);
});

test("ohne geladenes Memory wird der temporale Status nicht geraten", () => {
  const d = decideHit({ hit: hit(), queryTerms: ["deployen"] });
  assert.equal(d.evidence.temporal_status, "unknown");
});

// ── Die Liste ───────────────────────────────────────────────────

test("decideHits entscheidet je Treffer und lässt die Liste unangetastet", () => {
  const hits = [hit({ id: "a" }), hit({ id: "b", hop: "1-hop" }), hit({ id: "c" })];
  const out = decideHits(hits, {
    queryTerms: ["deployen"],
    scope: "projekt-a",
    memoryOf: () => memory({ recall_when: ["wenn wir deployen"] }),
  });
  assert.deepEqual(out.map((d) => d.id), ["a", "b", "c"], "Reihenfolge und Anzahl unverändert");
  assert.equal(out[0].decision, "required");
  assert.equal(out[1].decision, "optional", "der Hop-Treffer");
  assert.equal(out[2].decision, "required");
});

test("collectEvidence entscheidet nicht — es erhebt nur", () => {
  const e = collectEvidence({ hit: hit({ rrf: bothArms }), queryTerms: ["deployen"] });
  assert.equal(e.arm_agreement, true);
  assert.ok(!("decision" in e));
});
