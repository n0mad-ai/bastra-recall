/**
 * Was bei einer Mutation schiefging — als Ereignis, nicht als Fehlermeldung (#377).
 *
 * DAS PROBLEM. Jede besitzverändernde Operation im Vault kann teilweise
 * scheitern: ein Rollback, der nicht vollständig durchkam, ein Audit-Append,
 * das NACH dem Commit scheiterte, ein Area-Claim-Konflikt, die Übernahme eines
 * verwaisten Locks. Nichts davon hinterließ eine strukturierte Spur. Der
 * Halbzustand einer Dokument-Operation stand nur im TEXT einer Fehlermeldung,
 * Area-Konflikte wurden gar nicht protokolliert, und ein Auditfehler auf dem
 * MCP- oder REST-Pfad landete bestenfalls auf stderr. Sagt ein Nutzer in zwei
 * Wochen „da war mal was komisch", gibt es nichts nachzusehen.
 *
 * WARUM HIER UND NICHT IM DAEMON. Die Mutationen leben in core, die Telemetrie
 * im Daemon — und core kennt den Daemon nicht. Dieselbe Bauform wie
 * `onIdScan()` in `id-transaction.ts`: core MELDET, der Daemon hört zu und
 * entscheidet allein, ob und wohin geschrieben wird. Ein Vault ohne Daemon
 * (CLI, Tests, Bibliotheksnutzung) meldet ins Leere, und das kostet nichts.
 *
 * WAS NIE INS EVENT GEHÖRT. Keine Memory-Inhalte, keine Frontmatter-Werte,
 * keine absoluten Pfade. Ein Incident soll sagen, WAS passiert ist und in
 * WELCHER Phase — nicht, was in der Datei stand. `memory_id` ist der Schlüssel,
 * an dem man im Audit-Log weitersucht; `detail` ist ein kurzer, vom Aufrufer
 * kontrollierter Grund, ausdrücklich KEINE durchgereichte Fehlermeldung (die
 * trägt regelmäßig Pfade).
 *
 * WAS DAS NICHT IST. Keine Garantie, dass jede Mutation einen Beleg bekommt —
 * dafür bräuchte es einen Write-ahead-Eintrag VOR dem Commit. Das ist die
 * Ausbaustufe, die #378 (Recovery-Journal) beschreibt. Hier geht es darum, dass
 * ein seltener Fehler überhaupt sichtbar wird.
 */
import { randomUUID } from "node:crypto";

/**
 * Wie eine Mutation ausgegangen ist.
 *
 * Die sechs sind bewusst nicht auf „ok/nicht ok" reduziert: Sie verlangen
 * verschiedene Reaktionen. `conflict` ist wiederholbar, `committed` mit
 * `audit_failed` darf NICHT wiederholt werden, und `partial` braucht einen
 * Menschen.
 */
export type MutationStatus =
  /** Durchgelaufen, Zustand ist der gewollte. */
  | "committed"
  /** Gescheitert, aber vollständig zurückgenommen — der Zustand ist der von vorher. */
  | "rolled_back"
  /** Gescheitert UND nicht vollständig zurückgenommen. Der einzige Status, der
   *  einen Menschen braucht. */
  | "partial"
  /** Jemand anderes hielt den Anspruch. Nichts passiert, wiederholbar. */
  | "conflict"
  /** Die Mutation STEHT, nur ihr Beleg fehlt. Wiederholen wäre ein zweiter
   *  Schreibvorgang auf einen bereits geschriebenen Zustand. */
  | "audit_failed"
  /**
   * Ein verwaister Anspruch wurde übernommen — nichts an dieser Mutation ist
   * schiefgegangen, aber eine FRÜHERE ist gestorben, ohne aufzuräumen.
   *
   * Der eigene Status, weil keiner der anderen fünf ihn beschreibt, ohne zu
   * lügen: `conflict` hieße „nichts passiert" (es ist etwas passiert),
   * `committed` hieße „diese Mutation steht" (sie fängt gerade erst an), und
   * `partial` riefe nach einem Menschen, den es hier nicht braucht.
   *
   * Wer die Zahlen liest: Das ist ein Befund über den VORGÄNGER. Einzeln ein
   * abgebrochenes Terminal, gehäuft ein Hinweis auf Abstürze oder eine zu kurz
   * gewählte Verwaisungsfrist. Er gehört in keine Erfolgs- und in keine
   * Fehlerquote dieser Operation.
   */
  | "reclaimed";

export interface MutationIncident {
  /** Hält eine Mutation über ihre Phasen zusammen. Ohne das lässt sich ein
   *  `partial` nicht dem `conflict` zuordnen, der ihn ausgelöst hat. */
  operation_id: string;
  /** Welcher Writer: `save_memory`, `soft_delete`, `restore`, `archive`,
   *  `save_document`, `move_document`, `area_rename`, … */
  op: string;
  status: MutationStatus;
  /** Wo in der Operation: `publish`, `refile-trash`, `audit`, `rollback`,
   *  `area-claim`, `id-claim`. */
  phase: string;
  /** Die betroffene id — der Schlüssel, an dem im Audit-Log weitergesucht wird.
   *  Eine id ist ein Name, kein Inhalt. */
  memory_id?: string;
  /** Bei einem Rollback: wie weit er kam. Fehlt, wo keiner nötig war. */
  rollback?: "complete" | "partial" | "none";
  /** Kurzer, vom Aufrufer kontrollierter Grund — KEINE durchgereichte
   *  Fehlermeldung und kein Pfad. */
  detail?: string;
}

const observers = new Set<(i: MutationIncident) => void>();

/** Incidents mithören. Gibt die Abmeldung zurück. */
export function onMutationIncident(fn: (i: MutationIncident) => void): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}

/** Eine id, die eine Mutation über ihre Phasen zusammenhält. */
export function newOperationId(): string {
  return randomUUID();
}

/**
 * Einen Incident melden.
 *
 * Wirft NIE. Ein Beobachter darf einen Schreibvorgang nicht zum Scheitern
 * bringen — dieselbe Regel wie bei `onIdScan`. Und ein Telemetriepfad, der eine
 * Mutation kippen kann, wäre genau die Fehlerklasse, die dieses Modul sichtbar
 * machen soll.
 */
export function reportMutationIncident(incident: MutationIncident): void {
  for (const fn of observers) {
    try {
      fn(incident);
    } catch {
      /* ignoriert */
    }
  }
}
