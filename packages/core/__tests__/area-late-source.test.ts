/**
 * #382 — eine Quelle, die erst der autoritative Scan findet, liegt außerhalb
 * des Area-Claims.
 *
 * Die Reihenfolge im ganzen Vault ist Area vor ID. Welche Regale der Save
 * sperrt, entscheidet er deshalb VOR dem Plattenscan — aus dem aufgelösten
 * Zielpfad und aus der Routing-Auskunft. Ist deren Index veraltet (er kann aus
 * einem anderen Prozess stammen), liegt das Memory in Wahrheit woanders, und
 * genau dieses Regal ist nicht mitgesperrt: Ein gleichzeitiger Rename wäre
 * nicht gegen das Trashen der Quelle serialisiert.
 *
 * Nachträglich mitsperren verbietet das Protokoll — ein Reader, der nach der
 * Leerprüfung eines exklusiven Erwerbers einträgt, ist das Fenster, das die
 * Sperre schließen soll. Fragen darf der Save aber, und dieser Test hält fest,
 * dass er es tut und zurücktritt statt hineinzuschreiben.
 *
 * Der Aufbau stellt den veralteten Index direkt her: Der injizierte Locator
 * meldet „kenne ich nicht", während die Datei physisch in einem anderen Regal
 * liegt. Das ist derselbe Zustand, den ein Index aus einem fremden Prozess
 * erzeugt — nur ohne Zeitfenster.
 *
 * Runner: node --import tsx --test packages/core/__tests__/area-late-source.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMemory } from "../src/save.js";
import { withAreaExclusive } from "../src/area-claim.js";
import type { SaveMemoryInput } from "../src/save-schema.js";

const ID = "m-382";

function memoryFile(id: string, body: string): string {
  return [
    "---",
    `id: ${id}`,
    "title: Deploy Runbook",
    "type: lesson",
    "summary: eine Zusammenfassung",
    "topic_path:",
    "  - ops",
    "tags:",
    "  - deploy",
    "scope: alt",
    "recall_when:",
    "  - beim Deployen",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function input(over: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  return {
    id: ID,
    title: "Deploy Runbook",
    type: "lesson",
    summary: "eine neue Zusammenfassung",
    topic_path: ["ops"],
    tags: ["deploy"],
    // Der Scope zeigt auf das NEUE Regal — dorthin würde der Save routen.
    scope: "neu",
    recall_when: ["beim Deployen"],
    body: "Neuer Text.",
    overwrite: true,
    ...over,
  } as SaveMemoryInput;
}

/** Die Routing-Auskunft, die den echten Ort nicht kennt. */
const blinderLocator = { locate: async () => ({ kind: "none" as const }) };

async function fixture(t: { after: (fn: () => unknown) => void }): Promise<{
  root: string;
  quelle: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bastra-late-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const quelle = join(root, "memories", "projects", "alt", "deploy-runbook.md");
  await mkdir(join(root, "memories", "projects", "alt"), { recursive: true });
  await writeFile(quelle, memoryFile(ID, "ORIGINAL"), "utf8");
  return { root, quelle };
}

test("wird das Quellregal gerade umbenannt, tritt der Save zurück", async (t) => {
  const { root, quelle } = await fixture(t);

  await withAreaExclusive(root, ["alt"], async () => {
    // Innerhalb der Area-Operation: Der Save routet nach `neu`, sperrt also
    // `neu` — und findet die Quelle erst unter dem ID-Claim in `alt`.
    await assert.rejects(
      () => saveMemory(root, input(), { locator: blinderLocator }),
      /being renamed, deleted or created right now/,
      "der Save darf nicht in eine laufende Area-Operation hineinschreiben",
    );
  });

  // Nichts angefasst: Die Quelle liegt unverändert da, wo sie lag.
  assert.match(await readFile(quelle, "utf8"), /ORIGINAL/);
});

test("ohne laufende Area-Operation läuft derselbe Save durch", async (t) => {
  const { root, quelle } = await fixture(t);

  // Exakt derselbe Aufruf, nur ohne den exklusiven Lock daneben. Ohne diesen
  // Gegentest wäre nicht gezeigt, dass die neue Prüfung den Normalfall in Ruhe
  // lässt — sie sitzt auf dem meistbegangenen Schreibpfad des Produkts.
  const result = await saveMemory(root, input(), { locator: blinderLocator });

  assert.equal(result.id, ID);
  assert.equal(result.created, false, "die vorhandene Fassung wurde erkannt");
  assert.match(await readFile(result.file_path, "utf8"), /Neuer Text/);
  // Geschrieben wird dorthin, wo das Memory WIRKLICH liegt: Ein aus dem Scope
  // abgeleiteter Ordner ist kein Re-File-Auftrag, nur ein ausdrücklicher
  // `folder` wäre einer. Der Save folgt also der Platte — und genau deshalb
  // schreibt er in das Regal, das die Prüfung oben schützt.
  assert.equal(result.file_path, quelle, "die Platte gewinnt gegen den blinden Locator");
});

test("eine Area-Operation auf einem UNBETEILIGTEN Regal blockiert nichts", async (t) => {
  const { root } = await fixture(t);

  // Die Prüfung darf nur das Regal betreffen, in dem die Quelle wirklich
  // liegt — sonst würde jede Area-Operation irgendwo im Vault jeden Save
  // aufhalten.
  await withAreaExclusive(root, ["ganz-woanders"], async () => {
    const result = await saveMemory(root, input(), { locator: blinderLocator });
    assert.equal(result.id, ID);
  });
});
