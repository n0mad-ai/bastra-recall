/**
 * Recovery-Journal für die zweiteiligen Dokument-Operationen (#378).
 *
 * Ein Dokument sind zwei Dateien. Der verifizierte Rollback zwischen ihnen
 * (`ad86155`) läuft nur, solange der Prozess lebt — ein Absturz mitten in der
 * Operation hinterlässt einen halben Zustand, den danach niemand mehr sieht.
 * Geprüft wird deshalb dreierlei:
 *
 *  1. Ein Eintrag steht VOR dem ersten Move auf der Platte und ist nach der
 *     Quittung weg.
 *  2. Die Start-Detection meldet einen offenen Eintrag — und schweigt zu einem
 *     quittierten. Das Event selbst trägt keine Pfade (#377).
 *  3. Am echten Handler: geglückte Operationen hinterlassen nichts, ein Move,
 *     dessen Rollback an einer fremden Datei scheitert, lässt den Eintrag
 *     offen — genau der Fall, den der nächste Start benennen soll.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault, type MutationIncident } from "@bastra-recall/core";
import {
  openRecoveryJournal,
  readOpenRecoveryEntries,
  reportOpenRecoveryEntries,
  describeOpenEntry,
} from "../src/recovery-journal.js";
import { saveDocument, moveDocument } from "../src/documents-write-handler.js";

async function harness(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-docjournal-"));
  const vault = new Vault(dir);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, vault };
}

const BASE = {
  title: "Police",
  category: "vertrag",
  tags: ["vertrag"],
  linked_file: false,
  folder_path: "alt",
  overwrite: false,
} as const;

type SaveArgs = Parameters<typeof saveDocument>[1];

async function savedDoc(dir: string, vault: Vault) {
  const src = join(dir, "Police.pdf");
  await writeFile(src, "POLICE-V1", "utf8");
  return saveDocument(vault, { ...BASE, original_path: src } as SaveArgs);
}

// ── 1. schreiben und quittieren ─────────────────────────────────

test("ein Journal-Eintrag steht auf der Platte und ist nach der Quittung weg", async (t) => {
  const { dir } = await harness(t);

  const handle = await openRecoveryJournal(dir, {
    op: "move_document",
    id: "doc-police-pdf",
    steps: [{ from: join(dir, "a", "Police.pdf"), to: join(dir, "b", "Police.pdf") }],
  });

  const open = await readOpenRecoveryEntries(dir);
  assert.equal(open.length, 1, "vor dem Move muss der Eintrag stehen");
  assert.equal(open[0].operation_id, handle.entry.operation_id);
  assert.equal(open[0].op, "move_document");
  assert.equal(open[0].id, "doc-police-pdf");
  assert.deepEqual(open[0].steps, handle.entry.steps, "das Journal nennt die Pfade");
  assert.equal(open[0].pid, process.pid);

  await handle.acknowledge();
  assert.deepEqual(await readOpenRecoveryEntries(dir), [], "quittiert heißt weg");
  // Zweimal quittieren ist kein Fehler: der Rollback-Pfad kann denselben
  // Eintrag erreichen wie der Commit-Pfad.
  await handle.acknowledge();
});

test("ein Vault ohne Journal-Ordner hat schlicht keine offenen Einträge", async (t) => {
  const { dir } = await harness(t);
  assert.deepEqual(await readOpenRecoveryEntries(dir), []);
});

// ── 2. Start-Detection ──────────────────────────────────────────

test("die Start-Detection meldet einen offenen Eintrag — und schweigt nach der Quittung", async (t) => {
  const { dir } = await harness(t);
  const handle = await openRecoveryJournal(dir, {
    op: "save_document",
    id: "doc-police-pdf",
    steps: [{ from: join(dir, "Police.pdf"), to: join(dir, "documents", "alt", "Police.pdf") }],
  });

  const reported: MutationIncident[] = [];
  const count = await reportOpenRecoveryEntries(dir, (i) => reported.push(i));

  assert.equal(count, 1);
  assert.equal(reported.length, 1, "ein offener Eintrag wird benannt");
  assert.equal(reported[0].operation_id, handle.entry.operation_id);
  assert.equal(reported[0].op, "save_document");
  assert.equal(reported[0].status, "partial", "der einzige Status, der einen Menschen braucht");
  assert.equal(reported[0].phase, "recovery-journal");
  assert.equal(reported[0].memory_id, "doc-police-pdf");
  // #377: Das Event verlässt potenziell den Rechner — Pfade gehören nur in die
  // lokale Meldung, nie ins Event.
  assert.ok(
    !JSON.stringify(reported[0]).includes(dir),
    "der Incident darf keinen Pfad tragen",
  );
  assert.ok(describeOpenEntry(handle.entry).includes(dir), "die stderr-Zeile schon");

  await handle.acknowledge();
  const stillOpen: MutationIncident[] = [];
  assert.equal(await reportOpenRecoveryEntries(dir, (i) => stillOpen.push(i)), 0);
  assert.deepEqual(stillOpen, [], "ein quittierter Eintrag wird nicht gemeldet");
});

test("die Start-Detection repariert nichts", async (t) => {
  const { dir } = await harness(t);
  await openRecoveryJournal(dir, {
    op: "move_document",
    id: "doc-police-pdf",
    steps: [{ from: join(dir, "a"), to: join(dir, "b") }],
  });
  await reportOpenRecoveryEntries(dir, () => {});
  assert.equal(
    (await readOpenRecoveryEntries(dir)).length,
    1,
    "der Eintrag bleibt stehen — Benennen ist nicht Aufräumen",
  );
});

// ── 3. am echten Handler ────────────────────────────────────────

test("geglückte Dokument-Operationen hinterlassen keinen offenen Eintrag", async (t) => {
  const { dir, vault } = await harness(t);

  const doc = await savedDoc(dir, vault);
  assert.deepEqual(await readOpenRecoveryEntries(dir), [], "save_document quittiert");

  // Der Overwrite ersetzt die Originaldatei über Backup und rename — dieselbe
  // zweiteilige Operation, nur ohne Ordnerwechsel.
  const src = join(dir, "Police.pdf");
  await writeFile(src, "POLICE-V2", "utf8");
  await saveDocument(vault, { ...BASE, original_path: src, overwrite: true } as SaveArgs);
  assert.deepEqual(await readOpenRecoveryEntries(dir), [], "der Overwrite quittiert");

  await moveDocument(vault, { id: doc.id, folder_path: "neu" });
  assert.deepEqual(await readOpenRecoveryEntries(dir), [], "move_document quittiert");
});

/**
 * Der Trigger hängt an der entstehenden Tempdatei des Sidecars — genau dann
 * sind Original und Sidecar bereits im Zielordner und der Commit steht noch
 * aus. Gepollt statt `fs.watch`, weil FSEvents unter macOS Latenz hat; dasselbe
 * Muster wie in documents-halfstate-safety.test.ts.
 */
function armOnTempFile(folder: string, act: () => void) {
  const state = { fired: false };
  const timer = setInterval(() => {
    if (state.fired) return;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    if (names.some((n) => n.includes(".md.tmp-"))) {
      state.fired = true;
      act();
    }
  }, 1);
  timer.unref?.();
  return { state, stop: () => clearInterval(timer) };
}

async function inflateSidecar(path: string, vault: Vault): Promise<void> {
  const parsed = matter(await readFile(path, "utf8"));
  const fat = "Zeile mit belanglosem Inhalt.\n".repeat(400_000);
  await writeFile(path, matter.stringify(`${parsed.content}\n${fat}`, parsed.data), "utf8");
  await vault.reindexFile(path);
}

test("ein Move, dessen Rollback an einer fremden Datei scheitert, lässt den Eintrag offen", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  await inflateSidecar(doc.sidecar_path, vault);

  const zielordner = join(dir, "documents", "neu");
  const armed = armOnTempFile(zielordner, () =>
    // Eine fremde Datei am neuen Sidecar-Pfad: der Commit scheitert, und der
    // Rollback DARF sie nicht mit zurückschleifen — die Dateien bleiben im
    // Zielordner liegen.
    writeFileSync(join(zielordner, "Police.pdf.md"), "# Handgeschrieben\n", "utf8"),
  );
  t.after(armed.stop);

  const outcome = await moveDocument(vault, { id: doc.id, folder_path: "neu" }).then(
    () => "fulfilled" as const,
    (err: Error) => err,
  );
  armed.stop();

  assert.equal(armed.state.fired, true, "das Commit-Fenster wurde getroffen");
  assert.notEqual(outcome, "fulfilled", "ein stiller Erfolg wäre der Defekt");
  assert.match((outcome as Error).message, /could NOT be fully undone/);

  const open = await readOpenRecoveryEntries(dir);
  assert.equal(open.length, 1, "der halbe Zustand bleibt im Journal stehen");
  assert.equal(open[0].op, "move_document");
  assert.equal(open[0].id, doc.id);
  assert.ok(
    open[0].steps.some((s) => s.to.endsWith(join("documents", "neu", "Police.pdf.md"))),
    "der Eintrag nennt den Sidecar-Move",
  );
});
