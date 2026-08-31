/**
 * Die Testklasse, deren Fehlen die ganze Reparaturkette um #360 möglich
 * gemacht hat: NEGATIVE Identitäts- und Kollisionsfälle.
 *
 * Jede Zeile hier war reproduzierbarer Datenverlust oder ein stilles Duplikat,
 * während die Suite vollständig grün war. Der gemeinsame Nenner: Der Save-Pfad
 * schloss von einem Pfad oder einem Dateinamen auf eine Identität. Was ein
 * Memory ist und welches, entscheidet jetzt `memory-locator.ts` — mit
 * derselben Parser-Semantik, mit der auch der Vault seinen Index baut.
 *
 * Runner: `tsx --test packages/core/__tests__/memory-identity-matrix.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMemory } from "../src/index.js";

const base = {
  title: "T",
  type: "reference" as const,
  summary: "s",
  body: "NEU",
  topic_path: ["t"],
  tags: ["t"],
  scope: "proj",
  recall_when: ["t"],
};

/** Ein gültiges Memory-File. */
const memory = (id: string) =>
  `---\nid: ${id}\ntitle: Alt\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: proj\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nALT\n`;

/** Ein Memory-File ohne id — der Vault repariert sie aus dem Dateinamen. */
const memoryWithoutId =
  `---\ntitle: Alt\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: proj\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nALT\n`;

async function vaultWith(files: Array<[string, string]>): Promise<string> {
  const v = await mkdtemp(join(tmpdir(), "identity-"));
  for (const [rel, content] of files) {
    await mkdir(join(v, rel, ".."), { recursive: true });
    await writeFile(join(v, rel), content);
  }
  return v;
}

// ── Was NICHT überschrieben werden darf ──────────────────────────────────

test("A: eine gewöhnliche Notiz am kanonischen Zielpfad bleibt unangetastet", async () => {
  const note = "# Notiz\n\nPLAIN\n";
  const v = await vaultWith([["memories/projects/proj/upper-id.md", note]]);
  try {
    await assert.rejects(
      saveMemory(v, { ...base, id: "upper-id", overwrite: true }),
      /is not a memory/,
    );
    assert.equal(await readFile(join(v, "memories/projects/proj/upper-id.md"), "utf8"), note);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("B: ein FREMDES Memory am erwarteten Pfad wird nicht überschrieben", async () => {
  const v = await vaultWith([["memories/projects/proj/upper-id.md", memory("other-id")]]);
  try {
    await assert.rejects(
      saveMemory(v, { ...base, id: "upper-id", overwrite: true }),
      /holds memory 'other-id'/,
    );
    assert.match(
      await readFile(join(v, "memories/projects/proj/upper-id.md"), "utf8"),
      /id: other-id[\s\S]*ALT/,
    );
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("C: eine Notiz mit zufälligem YAML-Feld `id` ist kein Memory", async () => {
  const note = "---\nid: Upper-ID\ncategory: personal\n---\n\nPLAIN\n";
  const v = await vaultWith([["notes/personal.md", note]]);
  try {
    // Kein Memory → der Locator findet nichts → kanonisches Ziel, frei.
    const r = await saveMemory(v, { ...base, id: "Upper-ID", overwrite: true });
    assert.equal(r.id, "upper-id");
    assert.equal(r.file_path, join(v, "memories", "projects", "proj", "upper-id.md"));
    assert.equal(await readFile(join(v, "notes/personal.md"), "utf8"), note, "die Notiz bleibt");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("C2: eine Notiz ohne jedes Frontmatter, deren Name wie eine id aussieht", async () => {
  const note = "# Meine Notiz\n\nPLAIN\n";
  const v = await vaultWith([["notes/Upper-ID.md", note]]);
  try {
    const r = await saveMemory(v, { ...base, id: "Upper-ID", overwrite: true });
    assert.equal(r.id, "upper-id");
    assert.equal(await readFile(join(v, "notes/Upper-ID.md"), "utf8"), note);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

// ── Was gefunden werden MUSS ─────────────────────────────────────────────

test("D: ein echtes Memory unter abweichendem Pfad — auch bei kanonischer Eingabe", async () => {
  const v = await vaultWith([["notes/legacy.md", memory("upper-id")]]);
  try {
    const r = await saveMemory(v, { ...base, id: "upper-id", body: "NEU", overwrite: true });
    assert.equal(r.created, false, "kein Duplikat");
    assert.equal(r.file_path, join(v, "notes", "legacy.md"));
    assert.match(await readFile(r.file_path, "utf8"), /NEU/);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("E: ein Memory ohne id — der Vault repariert sie aus dem Dateinamen, der Save auch", async () => {
  const v = await vaultWith([["notes/upper-id.md", memoryWithoutId]]);
  try {
    const r = await saveMemory(v, { ...base, id: "upper-id", body: "NEU", overwrite: true });
    assert.equal(r.created, false, "kein Duplikat neben dem reparierten Memory");
    assert.equal(r.file_path, join(v, "notes", "upper-id.md"));
    assert.match(await readFile(r.file_path, "utf8"), /NEU/);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("Bestandsschutz: rohe Groß-id unter abweichendem Dateinamen", async () => {
  const v = await vaultWith([["notes/legacy-name.md", memory("Upper-ID")]]);
  try {
    const r = await saveMemory(v, { ...base, id: "Upper-ID", body: "NEU", overwrite: true });
    assert.equal(r.created, false);
    assert.equal(r.id, "Upper-ID");
    assert.equal(r.file_path, join(v, "notes", "legacy-name.md"));
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

// ── Kollisionen ──────────────────────────────────────────────────────────

test("F: dieselbe id in zwei Regalen ist eine Kollision, kein zweites Memory", async () => {
  const v = await mkdtemp(join(tmpdir(), "identity-f-"));
  try {
    const a = await saveMemory(v, { ...base, id: "dup-id", folder: "memories/people" });
    assert.equal(a.created, true);
    await assert.rejects(
      saveMemory(v, { ...base, id: "dup-id", folder: "memories/knowledge" }),
      /would create a second file with the same id/,
    );
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("G: zwei Dateien mit derselben id blockieren den Save, statt geraten zu werden", async () => {
  const v = await vaultWith([
    ["memories/people/a.md", memory("dup-id")],
    ["memories/knowledge/b.md", memory("dup-id")],
  ]);
  try {
    await assert.rejects(
      saveMemory(v, { ...base, id: "dup-id", overwrite: true }),
      /exists in more than one file/,
    );
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

// ── Der Normalfall bleibt unberührt ──────────────────────────────────────

test("Normalfall: neu anlegen und in place überschreiben", async () => {
  const v = await mkdtemp(join(tmpdir(), "identity-ok-"));
  try {
    const first = await saveMemory(v, { ...base, title: "Ein Titel" });
    assert.equal(first.created, true);
    assert.equal(first.id, "ein-titel");
    const second = await saveMemory(v, { ...base, title: "Ein Titel", body: "NEU", overwrite: true });
    assert.equal(second.created, false);
    assert.equal(second.file_path, first.file_path);
    assert.match(await readFile(second.file_path, "utf8"), /NEU/);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});
