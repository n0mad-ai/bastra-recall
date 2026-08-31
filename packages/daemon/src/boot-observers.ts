/**
 * Die Beobachter, die der Daemon beim Start anmeldet.
 *
 * core kennt den Daemon nicht: `onIdScan` und `onMutationIncident` sind
 * Meldekanäle, in die core hineinruft, ohne zu wissen, ob jemand zuhört. Ein
 * Vault ohne Daemon (CLI, Tests, Bibliotheksnutzung) meldet ins Leere. Wer
 * zuhört und was daraus wird, entscheidet allein diese Datei — und weil das
 * inzwischen drei Blöcke sind, steht sie neben `index.ts` statt darin.
 *
 * Reiner Umzug aus `index.ts`; die Blöcke sind unverändert.
 */
import { onIdScan, onMutationIncident, reportMutationIncident } from "@bastra-recall/core";
import type { Telemetry } from "./telemetry.js";
import { reportOpenRecoveryEntries, describeOpenEntry } from "./recovery-journal.js";

export async function wireBootObservers(opts: {
  telemetry: Telemetry;
  vaultPath: string;
}): Promise<void> {
  const { telemetry, vaultPath } = opts;

  // Der Preis der ID-Transaktion, dauerhaft gemessen (Codex-Gegenreview): Jeder
  // besitzverändernde Writer scannt den Vault. Lokal ist das zweistellig in
  // Millisekunden, auf einem Cloud-Mount eine offene Frage — und der Preis
  // hängt an der Gesamtzahl ALLER Markdown-Dateien, nicht an der Zahl der
  // indexierten Memories. Ohne Messung fällt eine Regression erst auf, wenn
  // ein Save Sekunden dauert.
  const vaultIsCloudMount = /(CloudStorage|Dropbox|iCloud)/i.test(vaultPath);
  onIdScan((o) => {
    void telemetry.logIdScan({
      id: o.id,
      op: o.op,
      ms: o.ms,
      files: o.files,
      bytes: o.bytes,
      dirs: o.dirs,
      blind_spots: o.blindSpots,
      cloud_mount: vaultIsCloudMount,
    });
  });

  // #377: Mutations-Incidents aus core. Dieselbe Bauform wie `onIdScan` oben —
  // core meldet, der Daemon entscheidet allein, ob geschrieben wird. Ein Vault
  // ohne Daemon (CLI, Tests) meldet ins Leere, und das kostet nichts.
  onMutationIncident((i) => {
    void telemetry.logMutationIncident({
      operation_id: i.operation_id,
      op: i.op,
      status: i.status,
      phase: i.phase,
      memory_id: i.memory_id ?? null,
      rollback: i.rollback ?? null,
      detail: i.detail ?? null,
    });
  });

  // #378: Offene Recovery-Journal-Einträge. Ein Dokument sind zwei Dateien;
  // der verifizierte Rollback zwischen ihnen läuft nur, solange der Prozess
  // lebt. Was hier auftaucht, ist eine Operation, die angefangen und nie
  // quittiert wurde — also ein möglicher Halbzustand. Benannt, NICHT repariert:
  // Die Pfade gehen auf stderr (lokal), ins Telemetrie-Event nur op und id.
  try {
    await reportOpenRecoveryEntries(vaultPath, (incident, entry) => {
      console.error(`[bastra-recall] recovery journal: ${describeOpenEntry(entry)}`);
      // Über denselben Kanal wie jeder andere Incident (#377) — die Abbildung
      // auf das Telemetrie-Event steht dort oben genau einmal.
      reportMutationIncident(incident);
    });
  } catch (err) {
    console.error(
      `[bastra-recall] recovery journal: could not be read (${(err as Error).message})`,
    );
  }
}
