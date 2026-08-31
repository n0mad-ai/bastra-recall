/**
 * Recovery-Journal für die zweiteiligen Dokument-Operationen (#378).
 *
 * DAS PROBLEM. Ein Dokument sind ZWEI Dateien, Original und Sidecar. Move und
 * Overwrite bewegen beide, und seit `ad86155` ist der Rollback dazwischen
 * verifiziert: Er meldet pro Datei, was liegen blieb. Aber er läuft nur,
 * solange der Prozess lebt. Ein Absturz (oder ein `kill -9`, ein Neustart des
 * Rechners) mitten in der Operation hinterlässt einen halben Zustand, den
 * danach niemand mehr zusammensetzt — der Rollback kommt nicht mehr dran, und
 * beim nächsten Start schaut nichts hin.
 *
 * WAS DAS JOURNAL TUT. Vor dem ersten Move steht auf der Platte, WAS gleich
 * passieren wird; nach dem letzten Schritt wird der Eintrag quittiert
 * (gelöscht). Was übrig bleibt, ist genau die Menge der Operationen, die
 * angefangen und nie zu Ende gebracht wurden.
 *
 * WAS DAS JOURNAL NICHT TUT. Es repariert nichts. Es ist kein Write-ahead-Log,
 * aus dem sich ein Zustand rekonstruieren ließe, und keine Transaktion — es
 * BENENNT einen Halbzustand, mehr verspricht #378 nicht. Wer den Eintrag
 * gesehen hat, entscheidet selbst; ein automatischer Repair, der auf einen
 * Ordner losgeht, den in der Zwischenzeit jemand von Hand aufgeräumt hat, wäre
 * die schlimmere Fehlerklasse.
 *
 * WARUM PFADE HIER STEHEN DÜRFEN. Das Telemetrie-Event `mutation_incident`
 * (#377) trägt bewusst keine Pfade — es verlässt den Rechner potenziell. Das
 * Journal ist eine lokale Datei IM Vault, deren einziger Zweck es ist, einem
 * Menschen zu sagen, welche zwei Dateien er sich ansehen soll. Ohne Pfade wäre
 * es wertlos. Die Start-Meldung trennt beides sauber: Die Pfade gehen auf
 * stderr, ins Event geht nur op, id und Phase.
 */
import { writeFile, rename, unlink, readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { newOperationId, type MutationIncident } from "@bastra-recall/core";

const JOURNAL_DIR = join(".bastra", "recovery");

/** Ein Schritt, der gleich ausgeführt wird — in der Reihenfolge der Ausführung. */
export interface RecoveryStep {
  from: string;
  to: string;
}

export interface RecoveryJournalEntry {
  /** Dieselbe id wie im `mutation_incident` — verbindet Journal und Telemetrie. */
  operation_id: string;
  /** `save_document`, `move_document`, `recategorize_document`. */
  op: string;
  /** Die Dokument-id. */
  id: string;
  started: string;
  pid: number;
  steps: RecoveryStep[];
}

/** Ein offener Eintrag, solange der Aufrufer ihn nicht quittiert hat. */
export interface RecoveryJournalHandle {
  entry: RecoveryJournalEntry;
  /**
   * Den Eintrag quittieren. Aufrufen, wenn die Operation zu Ende ist — sowohl
   * nach dem geglückten Commit als auch nach einem VOLLSTÄNDIGEN Rollback: In
   * beiden Fällen ist der Zustand auf der Platte ein ganzer. Blieb der Rollback
   * stecken, wird NICHT quittiert; dann soll der nächste Start davon erfahren.
   */
  acknowledge(): Promise<void>;
}

function journalDir(vaultRoot: string): string {
  return join(vaultRoot, JOURNAL_DIR);
}

/**
 * Einen Eintrag anlegen — VOR dem ersten Move.
 *
 * write-to-tmp + rename, damit ein Absturz mitten im Schreiben des Journals nie
 * einen halben Eintrag hinterlässt: Ein Eintrag, der da ist, ist vollständig.
 * Der umgekehrte Fall (Absturz VOR dem rename) ist der harmlose — dann ist auch
 * noch keine Datei bewegt worden.
 */
export async function openRecoveryJournal(
  vaultRoot: string,
  what: { op: string; id: string; steps: RecoveryStep[] },
): Promise<RecoveryJournalHandle> {
  const entry: RecoveryJournalEntry = {
    operation_id: newOperationId(),
    op: what.op,
    id: what.id,
    started: new Date().toISOString(),
    pid: process.pid,
    steps: what.steps,
  };
  const dir = journalDir(vaultRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${entry.operation_id}.json`);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return {
    entry,
    acknowledge: async () => {
      await unlink(path).catch(() => {});
    },
  };
}

/**
 * Alle offenen Einträge lesen.
 *
 * Ein unlesbarer oder unparsbarer Eintrag wird übersprungen: Der Schreibweg ist
 * atomar, also kann so etwas nur von Hand entstanden sein — und ein kaputtes
 * Journal darf den Daemon-Start nicht aufhalten. Der Ordner selbst fehlt bei
 * einem Vault, in dem nie eine solche Operation lief; das ist kein Fehler.
 */
export async function readOpenRecoveryEntries(
  vaultRoot: string,
): Promise<RecoveryJournalEntry[]> {
  const dir = journalDir(vaultRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: RecoveryJournalEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as RecoveryJournalEntry;
      if (typeof parsed?.operation_id === "string" && Array.isArray(parsed?.steps)) {
        entries.push(parsed);
      }
    } catch {
      /* von Hand angelegt oder kaputt — nicht unser Fall */
    }
  }
  return entries;
}

/** Wie ein offener Eintrag im stderr-Log steht — mit Pfaden, lokal. */
export function describeOpenEntry(entry: RecoveryJournalEntry): string {
  const steps = entry.steps.map((s) => `${s.from} -> ${s.to}`).join("; ");
  return (
    `${entry.op} on ${entry.id} (started ${entry.started}, pid ${entry.pid}) was never ` +
    `acknowledged — a crash may have left one of the two files behind. Nothing was ` +
    `repaired automatically. Check: ${steps}`
  );
}

/**
 * Beim Daemon-Start: offene Einträge finden und MELDEN. Repariert nichts.
 *
 * `report` bekommt den Incident (pfadfrei, für die Telemetrie) und den Eintrag
 * selbst (mit Pfaden, für stderr). `partial` ist der richtige Status: Es ist
 * genau der eine, der laut #377 einen Menschen braucht.
 */
export async function reportOpenRecoveryEntries(
  vaultRoot: string,
  report: (incident: MutationIncident, entry: RecoveryJournalEntry) => void,
): Promise<number> {
  const entries = await readOpenRecoveryEntries(vaultRoot);
  for (const entry of entries) {
    report(
      {
        operation_id: entry.operation_id,
        op: entry.op,
        status: "partial",
        phase: "recovery-journal",
        memory_id: entry.id,
        rollback: "none",
        detail: "open_journal_entry",
      },
      entry,
    );
  }
  return entries.length;
}
