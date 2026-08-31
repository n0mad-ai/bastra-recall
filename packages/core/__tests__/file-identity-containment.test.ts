/**
 * Drei Löcher in der Dateiidentität, die alle dasselbe Muster haben: Der
 * Schreibpfad hat eine Frage über das DATEISYSTEM anhand eines PFAD-STRINGS
 * beantwortet — und in jedem der drei Fälle war die Antwort falsch, sobald das
 * Dateisystem nicht buchstabengetreu ist.
 *
 *   Befund 3 — „Lesefehler = da liegt nichts". Eine gewöhnliche Notiz mit
 *   Dateimodus 000 galt als `absent` und wurde ersetzt.
 *   Befund 4 — „andere Schreibweise = andere Datei". Auf APFS trashte das
 *   Re-Filing genau die Datei, die es gerade geschrieben hatte.
 *   Befund 5 — „String beginnt mit dem Vault-Pfad = liegt im Vault". Ein
 *   Symlink im `folder` schrieb erfolgreich aus dem Vault heraus.
 *
 * Runner: `tsx --test packages/core/__tests__/file-identity-containment.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readOccupant,
  sameFile,
  saveMemory,
  scanVaultForId,
  snapshotLocator,
} from "../src/index.js";

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

const memory = (id: string, body = "ALT") =>
  `---\nid: ${id}\ntitle: Alt\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: proj\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\n${body}\n`;

/** Als root greift kein Dateimodus — die Unlesbarkeits-Fälle wären dort grün,
 *  ohne irgendetwas zu beweisen. */
const asRoot = process.getuid?.() === 0;

async function vault(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "fileid-"));
}

// ── Befund 3: unlesbar ist nicht abwesend ────────────────────────────────

test("Befund 3: eine unlesbare Datei ist `unreadable`, nicht `absent`", { skip: asRoot }, async () => {
  const v = await vault();
  const file = join(v, "note.md");
  try {
    await writeFile(file, "# Notiz\n\nPLAIN\n");
    await chmod(file, 0o000);
    const occupant = readOccupant(file);
    assert.equal(occupant.kind, "unreadable");
  } finally {
    await chmod(file, 0o600).catch(() => {});
    await rm(v, { recursive: true, force: true });
  }
});

test("Befund 3: eine FEHLENDE Datei bleibt `absent`", async () => {
  const v = await vault();
  try {
    assert.equal(readOccupant(join(v, "gibt-es-nicht.md")).kind, "absent");
    // Ein Vorfahre, der gar kein Ordner ist (ENOTDIR): auch das ist „nichts da".
    await writeFile(join(v, "datei"), "x");
    assert.equal(readOccupant(join(v, "datei", "drunter.md")).kind, "absent");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("Befund 3: eine unlesbare Notiz am Zielpfad wird nicht ersetzt", { skip: asRoot }, async () => {
  const v = await vault();
  const dir = join(v, "memories", "projects", "proj");
  const file = join(dir, "upper-id.md");
  const note = "# Notiz\n\nPLAIN\n";
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, note);
    await chmod(file, 0o000);
    await assert.rejects(saveMemory(v, { ...base, id: "upper-id", overwrite: true }));
    await chmod(file, 0o600);
    assert.equal(await readFile(file, "utf8"), note, "die Notiz ist unverändert");
  } finally {
    await chmod(file, 0o600).catch(() => {});
    await rm(v, { recursive: true, force: true });
  }
});

test("Befund 3: ein unlesbarer ORDNER macht den Scan unvollständig", { skip: asRoot }, async () => {
  const v = await vault();
  const locked = join(v, "memories", "privat");
  try {
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, "x.md"), memory("versteckt"));
    await chmod(locked, 0o000);

    // Der Scan darf nicht `none` behaupten — hinter dem Ordner kann genau
    // diese id liegen.
    const scanned = scanVaultForId(v, "versteckt");
    assert.equal(scanned.kind, "incomplete");
    assert.equal(snapshotLocator(v).locate("egal").kind, "incomplete");

    // …und der Save darf daneben kein zweites File mit derselben id anlegen.
    await assert.rejects(
      saveMemory(v, { ...base, id: "versteckt" }),
      /cannot verify where memory/,
    );
  } finally {
    await chmod(locked, 0o700).catch(() => {});
    await rm(v, { recursive: true, force: true });
  }
});

// ── Befund 4: Dateiidentität statt Pfad-String ───────────────────────────

test("Befund 4: sameFile erkennt dieselbe Datei unter zwei Namen", async () => {
  const v = await vault();
  try {
    const real = join(v, "a.md");
    await writeFile(real, "x");
    await symlink(real, join(v, "b.md"));
    assert.equal(sameFile(real, join(v, "b.md")), true, "Symlink auf dieselbe Datei");
    await writeFile(join(v, "c.md"), "x");
    assert.equal(sameFile(real, join(v, "c.md")), false, "gleicher Inhalt, andere Datei");
    // Nicht nachweisbar dieselbe → false, nie „ja".
    assert.equal(sameFile(join(v, "weg.md"), join(v, "auch-weg.md")), false);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Ob `memories/People` und `memories/people` DASSELBE Regal sind, entscheidet
 * das Dateisystem — und nur das. Deshalb wird hier gemessen statt angenommen.
 *
 * CI-Befund (27.08.2026): Der Test darunter verlangte pauschal
 * `sameFile === true`, sobald der Save einen anders geschriebenen Pfad
 * zurückgab. Auf APFS (case-insensitiv, Daniels Maschine) war das richtig; auf
 * dem case-SENSITIVEN Linux der CI ist es prinzipiell unerfüllbar — dort sind es
 * zwei verschiedene Dateien, und ein Re-File zwischen ihnen ist ein ganz
 * gewöhnliches Re-File. Der Test war plattformabhängig falsch, nicht der
 * Schreibpfad: auf einem case-sensitiven Volume nachgemessen liegt die Quelle
 * hinterher im Trash, die neue Datei am Ziel, und es gibt kein Duplikat.
 */
async function isCaseInsensitive(dir: string): Promise<boolean> {
  const probe = join(dir, "CaseProbe.md");
  await writeFile(probe, "x");
  return existsSync(join(dir, "caseprobe.md"));
}

test("Befund 4: Re-Filing nur der Schreibweise nach trasht die geschriebene Datei nicht", async () => {
  const v = await vault();
  try {
    await mkdir(join(v, "memories", "People"), { recursive: true });
    const insensitive = await isCaseInsensitive(v);
    const existing = join(v, "memories", "People", "case-id.md");
    await writeFile(existing, memory("case-id"));

    const result = await saveMemory(v, {
      ...base,
      id: "case-id",
      folder: "memories/people",
      overwrite: true,
    });

    // Beide Ausgänge sind richtig — aber je nach Dateisystem ein anderer, und
    // die Verwechslung ist genau der Defekt, den Befund 4 meint.
    if (insensitive) {
      // DASSELBE Regal, nur anders geschrieben: Der Save darf die Datei, die
      // er gerade geschrieben hat, nicht als „die alte" in den Trash schieben.
      if (result.file_path !== existing) {
        assert.equal(
          sameFile(existing, result.file_path),
          true,
          "case-insensitiv: beide Pfade sind dieselbe Datei, der Stringvergleich log",
        );
      }
      assert.equal(
        existsSync(join(v, ".bastra", "trash", "case-id.md")),
        false,
        "hier wurde nichts verschoben, also darf auch nichts im Trash liegen",
      );
    } else {
      // ZWEI Regale: ein gewöhnliches Re-File. Die Quelle gehört in den Trash,
      // und danach darf es genau eine aktive Datei mit dieser id geben.
      assert.equal(sameFile(existing, result.file_path), false);
      assert.equal(existsSync(existing), false, "die Quelle ist umgezogen");
      assert.equal(
        existsSync(join(v, ".bastra", "trash", "case-id.md")),
        true,
        "und liegt wiederherstellbar im Trash",
      );
    }
    assert.ok(existsSync(result.file_path), "die geschriebene Datei existiert");
    assert.match(await readFile(result.file_path, "utf8"), /NEU/);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

// ── Befund 5: Containment über realpath ──────────────────────────────────

test("Befund 5: ein Symlink im folder führt nicht aus dem Vault heraus", async () => {
  const v = await vault();
  const outside = await mkdtemp(join(tmpdir(), "outside-"));
  try {
    await mkdir(join(v, "memories"), { recursive: true });
    await symlink(outside, join(v, "memories", "linked"));

    await assert.rejects(
      saveMemory(v, { ...base, id: "escaped", folder: "memories/linked" }),
      /outside the vault/,
    );
    assert.equal(existsSync(join(outside, "escaped.md")), false, "nichts außerhalb geschrieben");
  } finally {
    await rm(v, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Befund 5: der Normalfall im Vault bleibt schreibbar", async () => {
  const v = await vault();
  try {
    const r = await saveMemory(v, { ...base, id: "drin", folder: "memories/people" });
    assert.equal(r.created, true);
    assert.equal(r.file_path, join(v, "memories", "people", "drin.md"));
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});
