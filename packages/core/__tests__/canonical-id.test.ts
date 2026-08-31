/**
 * #360-Folgefund D (Codex-Gegenreview): Memory-id und Scope sind IDENTITÄTEN.
 * Auto-generierte ids waren über slugify() immer klein, eine explizit gesetzte
 * id passierte dagegen nur die Pfad-Sicherheitsprüfung — `doku-CarNexus-area`
 * und `doku-carnexus-area` waren zwei logische Memories auf EINER Datei.
 *
 * Runner: `tsx --test packages/core/__tests__/canonical-id.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { canonicalMemoryId, resolveMemoryTarget, saveMemory } from "../src/index.js";

const base = {
  title: "Ein Titel",
  type: "reference" as const,
  summary: "s",
  body: "Body.",
  topic_path: ["t"],
  tags: ["t"],
  recall_when: ["t"],
};

test("canonicalMemoryId: explizite id wird gefaltet, sonst slugify(title)", () => {
  assert.equal(canonicalMemoryId("doku-CarNexus-area", "egal"), "doku-carnexus-area");
  assert.equal(canonicalMemoryId(undefined, "Ein Titel"), "ein-titel");
  assert.equal(canonicalMemoryId("schon-klein", "egal"), "schon-klein");
});

test("resolveMemoryTarget: id und Ordner sind kanonisch, nicht die Rohschreibweise", () => {
  const t = resolveMemoryTarget("/vault", {
    title: "Ein Titel",
    type: "reference",
    scope: "CarNexus",
    id: "Doku-CarNexus-Area",
  });
  assert.equal(t.id, "doku-carnexus-area");
  assert.equal(t.filePath, "/vault/memories/projects/carnexus/doku-carnexus-area.md");
});

test("saveMemory: zwei Schreibweisen desselben Projekts landen auf EINER Datei", async () => {
  const v = await mkdtemp(join(tmpdir(), "canon-id-"));
  try {
    const a = await saveMemory(v, { ...base, id: "doku-CarNexus-area", scope: "CarNexus" });
    const b = await saveMemory(v, {
      ...base,
      id: "doku-carnexus-area",
      scope: "carnexus",
      body: "Zweite Fassung.",
      overwrite: true,
    });
    assert.equal(a.id, "doku-carnexus-area");
    assert.equal(b.id, "doku-carnexus-area");
    assert.equal(a.file_path, b.file_path);
    assert.equal(b.created, false); // nicht als zweites Memory angelegt
    // Frontmatter-Scope folgt dem Ordner — sonst wäre das Memory im eigenen
    // Projekt fremd (die Fehlerklasse aus #360).
    const { data } = matter(await readFile(b.file_path, "utf8"));
    assert.equal(data.scope, "carnexus");
    assert.equal(data.id, "doku-carnexus-area");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Codex-Gegenreview zur Kanonisierung: Sie ist richtig für NEUE Memories,
 * darf aber kein BESTEHENDES unerreichbar machen. Ohne Bestandsschutz hatte
 * der Fall zwei Ausgänge, beide falsch — auf case-sensitiven Systemen ein
 * Duplikat neben der alten Datei, auf case-insensitiven ein Schreibvorgang in
 * die alte Datei, deren Name stehen bleibt, während das Frontmatter die neue
 * id trägt.
 */
async function vaultWith(rel: string, frontmatterId: string, scope: string): Promise<string> {
  const v = await mkdtemp(join(tmpdir(), "canon-legacy-"));
  const full = join(v, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(
    full,
    `---\nid: ${frontmatterId}\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: ${scope}\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nAlt.\n`,
  );
  return v;
}

test("Bestandsschutz: eine vorhandene Groß-id wird bedient, nicht dupliziert", async () => {
  const v = await vaultWith("memories/projects/proj/Upper-ID.md", "Upper-ID", "proj");
  try {
    const r = await saveMemory(v, {
      ...base,
      id: "Upper-ID",
      scope: "proj",
      body: "Neu.",
      overwrite: true,
    });
    assert.equal(r.created, false, "kein zweites Memory");
    assert.equal(r.id, "Upper-ID", "die alte Schreibweise bleibt die Identität");
    assert.deepEqual(await readdir(join(v, "memories", "projects", "proj")), ["Upper-ID.md"]);
    // Entscheidend: Dateiname und Frontmatter-id dürfen nicht auseinanderfallen.
    const { data, content } = matter(await readFile(r.file_path, "utf8"));
    assert.equal(data.id, "Upper-ID");
    assert.match(content, /Neu\./);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("Bestandsschutz: ein vorhandenes Groß-Regal bleibt das Regal", async () => {
  const v = await vaultWith("memories/projects/Proj/alte-id.md", "alte-id", "Proj");
  try {
    const r = await saveMemory(v, { ...base, id: "alte-id", scope: "Proj", overwrite: true });
    assert.equal(r.created, false);
    assert.equal(r.file_path, join(v, "memories", "projects", "Proj", "alte-id.md"));
    // Frontmatter-Scope MUSS zum Ordner passen — sonst ist das Memory im
    // eigenen Projekt fremd, die Fehlerklasse aus #360.
    assert.equal(matter(await readFile(r.file_path, "utf8")).data.scope, "Proj");
    assert.deepEqual(await readdir(join(v, "memories", "projects")), ["Proj"]);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("ohne Bestand bleibt alles kanonisch — der Schutz greift nur rückwärts", async () => {
  const v = await mkdtemp(join(tmpdir(), "canon-fresh-"));
  try {
    const r = await saveMemory(v, { ...base, id: "Upper-ID", scope: "Proj" });
    assert.equal(r.id, "upper-id");
    assert.equal(r.file_path, join(v, "memories", "projects", "proj", "upper-id.md"));
    assert.equal(matter(await readFile(r.file_path, "utf8")).data.scope, "proj");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Zweite Codex-Runde zum Bestandsschutz: Die erste Fassung prüfte nur zwei
 * Kombinationen — kanonisches Regal + kanonische id gegen rohes Regal + rohe
 * id. Jede Mischform und jede der Ablagen, die der Vault ausdrücklich kennt
 * (flaches `memorys/`, per `folder` gesetztes Regal), fiel durch.
 */
for (const [label, rel, scope, folder] of [
  ["Mischform: kanonisches Regal, rohe id", "memories/projects/proj/Upper-ID.md", "Proj", undefined],
  ["flache Legacy-Ablage memorys/", "memorys/Upper-ID.md", "proj", undefined],
  ["folder-Regal, Save ohne folder", "memories/people/Upper-ID.md", "proj", undefined],
  ["folder-Regal, Save mit folder", "memories/people/Upper-ID.md", "proj", "memories/people"],
] as const) {
  test(`Bestandsschutz findet den Bestand — ${label}`, async () => {
    const v = await mkdtemp(join(tmpdir(), "canon-any-"));
    try {
      const full = join(v, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(
        full,
        `---\nid: Upper-ID\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: ${scope}\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nAlt.\n`,
      );
      const r = await saveMemory(v, {
        ...base,
        id: "Upper-ID",
        scope,
        body: "Neu.",
        overwrite: true,
        ...(folder ? { folder } : {}),
      });
      assert.equal(r.created, false, "kein zweites Memory");
      assert.equal(r.id, "Upper-ID", "die Bestands-id bleibt die Identität");
      assert.equal(r.file_path, full, "und die Bestands-Datei bleibt die Datei");
      assert.equal(matter(await readFile(full, "utf8")).data.id, "Upper-ID");
    } finally {
      await rm(v, { recursive: true, force: true });
    }
  });
}

/**
 * Dritte Codex-Runde: Der vaultweite Scan suchte nach dem DATEINAMEN. Das hatte
 * zwei Ausgänge, und der erste war Datenverlust.
 */
test("eine fremde Notiz mit passendem Dateinamen wird NICHT überschrieben", async () => {
  const v = await mkdtemp(join(tmpdir(), "canon-note-"));
  try {
    await mkdir(join(v, "notes"), { recursive: true });
    const note = join(v, "notes", "Upper-ID.md");
    const original = "# Meine Notiz\n\nWichtiger Text, kein Memory.\n";
    await writeFile(note, original);

    const r = await saveMemory(v, { ...base, id: "Upper-ID", scope: "proj", overwrite: true });

    // Die Notiz ist kein Memory — sie hat kein Frontmatter, also keine id.
    assert.equal(await readFile(note, "utf8"), original, "die fremde Notiz bleibt unangetastet");
    assert.equal(r.id, "upper-id");
    assert.equal(r.file_path, join(v, "memories", "projects", "proj", "upper-id.md"));
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("ein Bestands-Memory wird über seine Frontmatter-id gefunden, nicht über den Dateinamen", async () => {
  const v = await mkdtemp(join(tmpdir(), "canon-fm-"));
  try {
    await mkdir(join(v, "notes"), { recursive: true });
    const file = join(v, "notes", "legacy-name.md");
    await writeFile(
      file,
      "---\nid: Upper-ID\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: proj\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nAlt.\n",
    );

    const r = await saveMemory(v, {
      ...base,
      id: "Upper-ID",
      scope: "proj",
      body: "Neu.",
      overwrite: true,
    });

    assert.equal(r.created, false, "kein zweites Memory daneben");
    assert.equal(r.id, "Upper-ID");
    assert.equal(r.file_path, file, "die Datei behält ihren abweichenden Namen");
    assert.match(await readFile(file, "utf8"), /Neu\./);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});
