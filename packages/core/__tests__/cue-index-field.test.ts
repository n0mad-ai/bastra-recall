/**
 * Das achte Indexfeld der Cue-Schicht (§11.4) — und vor allem die Zusage, dass
 * es den Kernpfad nicht anfasst.
 *
 * §11.4 nennt den Rollback ausdrücklich: „Die Sidecar-Datei wird ignoriert.
 * Retrieval verhält sich dann exakt wie heute, weil `recall_when` und der
 * BM25-Index unverändert bleiben." Ohne geladene Projektion ist das kein
 * Zufall, sondern Konstruktion: `cues_flat` wird dann gar nicht erst als Feld
 * angemeldet. Der erste Test misst das trotzdem, weil eine Zusage über den
 * Kernpfad nichts wert ist, solange nur ihr Autor sie glaubt — ein Feld, das
 * MiniSearch kennt, verschiebt Feldlängen und Dokumentfrequenzen, und das wäre
 * dem Ranking anzusehen.
 *
 * Der zweite Punkt ist die Vertrauensklasse: §11.4 verlangt, dass
 * handgeschriebenes `recall_when` und abgeleiteter Cue „nie zu einem Feld
 * verschmolzen" werden. Ein Treffer über einen Cue darf deshalb nicht als
 * `matched_recall_when` durchgehen — sonst wäre die Trennung im Schema da und
 * im Signal weg.
 *
 * Runner: node --import tsx --test packages/core/__tests__/cue-index-field.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "../src/index.js";
import type { CueProjection } from "../src/cue-sidecar.js";

function memo(id: string, title: string, recallWhen: string, body: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    `  - ${recallWhen}`,
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function vaultWithMemories(): Promise<{ vault: Vault; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-cueidx-"));
  await writeFile(
    join(dir, "a.md"),
    memo("a", "telescope assembly manual", "orbital docking procedure", "Notes on telescope assembly."),
    "utf8",
  );
  await writeFile(
    join(dir, "b.md"),
    memo("b", "kitchen inventory", "when cooking dinner", "Pots, pans and a telescope-shaped whisk."),
    "utf8",
  );
  await writeFile(
    join(dir, "c.md"),
    memo("c", "annual insurance policy", "when the premium is due", "Allianz, policy 4711."),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  return { vault, dir };
}

const emptyProjection = (): CueProjection => ({
  byMemory: new Map(),
  accepted: 0,
  rejected: [],
  stale: [],
});

const projectionOf = (byMemory: Record<string, string[]>): CueProjection => ({
  byMemory: new Map(Object.entries(byMemory)),
  accepted: Object.values(byMemory).flat().length,
  rejected: [],
  stale: [],
});

/** Ranking UND Scores — „gleiche Reihenfolge" allein würde eine Verschiebung
 *  der Feldlängen verdecken, die sich erst beim nächsten Memory auswirkt. */
function ranking(idx: SearchIndex, query: string): string {
  return idx
    .recall(query, { k: 10 })
    .map((h) => `${h.id}:${h.score}`)
    .join(" | ");
}

const QUERIES = [
  "telescope assembly",
  "orbital docking",
  "insurance policy premium",
  "kitchen",
  "telescope",
];

// ── Der Kernpfad: ohne Projektion ändert sich nichts ─────────────

test("ohne geladene Projektion ist das Ranking identisch — Reihenfolge UND Scores", async () => {
  const { vault, dir } = await vaultWithMemories();
  try {
    const ohne = new SearchIndex(vault);
    ohne.start();
    // Der Produktionszustand: keine Sidecar-Datei, also eine leere Projektion.
    // Der Boost ist bewusst hoch gesetzt — wäre das Feld trotz leerer Projektion
    // angemeldet, müsste sich das hier zeigen.
    const mit = new SearchIndex(vault, { projection: emptyProjection(), boost: 8 });
    mit.start();

    for (const q of QUERIES) {
      assert.equal(ranking(mit, q), ranking(ohne, q), `Query "${q}" muss identisch ranken`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Boost 0 heißt aus: eine geladene Projektion ohne Gewicht ändert nichts", async () => {
  const { vault, dir } = await vaultWithMemories();
  try {
    const ohne = new SearchIndex(vault);
    ohne.start();
    // Cues sind da, das Gewicht ist 0. Das Feld darf dann nicht einmal angelegt
    // werden: Ein Dokument, das NUR über einen Cue matcht, käme sonst mit Score
    // 0 trotzdem in den Kandidatenpool und veränderte ihn.
    const aus = new SearchIndex(vault, {
      projection: projectionOf({ a: ["Versicherungsunterlagen"], c: ["Versicherungsunterlagen"] }),
      boost: 0,
    });
    aus.start();

    for (const q of [...QUERIES, "Versicherungsunterlagen"]) {
      assert.equal(ranking(aus, q), ranking(ohne, q), `Query "${q}" muss identisch ranken`);
    }
    assert.equal(
      aus.recall("Versicherungsunterlagen", { k: 10 }).length,
      0,
      "ein Cue-Term darf bei Gewicht 0 keinen Kandidaten öffnen",
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("der Default ist aus — ohne Boost-Angabe passiert nichts", async () => {
  const { vault, dir } = await vaultWithMemories();
  try {
    const ohne = new SearchIndex(vault);
    ohne.start();
    const ohneBoost = new SearchIndex(vault, {
      projection: projectionOf({ c: ["Versicherungsunterlagen"] }),
    });
    ohneBoost.start();
    assert.equal(ranking(ohneBoost, "Versicherungsunterlagen"), ranking(ohne, "Versicherungsunterlagen"));
    assert.equal(ranking(ohneBoost, "insurance policy premium"), ranking(ohne, "insurance policy premium"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── Mit Projektion und Gewicht wirkt das Feld ────────────────────

test("mit Gewicht öffnet ein Cue einen Kandidaten, den kein anderes Feld trägt", async () => {
  const { vault, dir } = await vaultWithMemories();
  try {
    const ohne = new SearchIndex(vault);
    ohne.start();
    assert.equal(
      ohne.recall("Versicherungsunterlagen", { k: 10 }).length,
      0,
      "Vorbedingung: der Cue-Term steht in keinem der sieben Felder",
    );

    const mit = new SearchIndex(vault, {
      projection: projectionOf({ c: ["Versicherungsunterlagen Vertragsablage"] }),
      boost: 5,
    });
    mit.start();
    const hits = mit.recall("Versicherungsunterlagen", { k: 10 });
    assert.equal(hits.length, 1, "genau das Memory mit dem Cue");
    assert.equal(hits[0].id, "c");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("der Identitätstest oben ist nicht vakuum — die Methode sieht Unterschiede", async () => {
  const { vault, dir } = await vaultWithMemories();
  try {
    const ohne = new SearchIndex(vault);
    ohne.start();
    // Derselbe Vergleich wie im ersten Test, nur mit einem Cue, der einen
    // BESTEHENDEN Term trägt. Bliebe auch das gleich, verglichen die Tests oben
    // nichts.
    const mit = new SearchIndex(vault, {
      projection: projectionOf({ c: ["telescope telescope telescope"] }),
      boost: 8,
    });
    mit.start();
    assert.notEqual(ranking(mit, "telescope"), ranking(ohne, "telescope"));

    // Und der Nebenbefund, der die Zusage trägt: Das zusätzliche Feld verschiebt
    // die Scores der ÜBRIGEN Dokumente nicht. `c` kommt hinzu, a und b behalten
    // ihre Zahlen — MiniSearch wertet die Felder unabhängig, ein achtes Feld
    // verdünnt die anderen sieben nicht.
    const scoreOf = (idx: SearchIndex, id: string): number | undefined =>
      idx.recall("telescope", { k: 10 }).find((h) => h.id === id)?.score;
    assert.equal(scoreOf(mit, "a"), scoreOf(ohne, "a"));
    assert.equal(scoreOf(mit, "b"), scoreOf(ohne, "b"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("ein Memory ohne Cues bleibt unberührt, wenn andere welche haben", async () => {
  const { vault, dir } = await vaultWithMemories();
  try {
    const mit = new SearchIndex(vault, {
      projection: projectionOf({ c: ["Versicherungsunterlagen"] }),
      boost: 5,
    });
    mit.start();
    const hits = mit.recall("orbital docking", { k: 10 });
    assert.ok(
      hits.some((h) => h.id === "a"),
      "der Treffer über recall_when steht weiterhin",
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── Vertrauensklassen bleiben getrennt ───────────────────────────

test("ein Cue-Treffer ist kein recall_when-Treffer", async () => {
  const { vault, dir } = await vaultWithMemories();
  try {
    const mit = new SearchIndex(vault, {
      projection: projectionOf({ c: ["Versicherungsunterlagen"] }),
      boost: 5,
    });
    mit.start();
    const hit = mit.recall("Versicherungsunterlagen", { k: 10 })[0];
    assert.ok(hit, "der Cue trägt den Treffer");
    assert.notEqual(
      hit.matched_recall_when,
      true,
      "§11.4: die beiden Vertrauensklassen werden nie zu einem Feld verschmolzen",
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
