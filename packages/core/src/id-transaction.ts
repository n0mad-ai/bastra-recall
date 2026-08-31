/**
 * Die ID-Transaktion: der EINE Weg, unter dem eine Memory-ID beansprucht,
 * verschoben, ersetzt oder wiederhergestellt wird.
 *
 * Warum das eine eigene Stelle braucht (Codex-Gegenreview, P0): Der Vault hatte
 * zuletzt zwar einen id-basierten Commit-Lock, aber nur EIN Writer benutzte ihn
 * — `saveMemory`. `saveDocument`, `auditedRestore`, `mutateMemoryFile` und die
 * Area-Writer schrieben daneben vorbei. Nachgestellt: zwei parallele
 * `saveDocument`-Aufrufe für `a+b.pdf` und `a-b.pdf` erzeugten beide ein
 * Sidecar mit der abgeleiteten id `doc-a-b-pdf`, und der Vault lud beim
 * nächsten Start still nur eines davon.
 *
 * Und der Lock allein genügt auch nicht. Unter ihm wurde derselbe Index erneut
 * befragt, aus dem die Vorabprüfung schon ihre Antwort hatte — stammte der aus
 * einem anderen Prozess und war veraltet, meldete auch die zweite Frage `none`.
 * Zwei aufeinanderfolgende Saves derselben id in verschiedene Ordner gelangen
 * beide. Deshalb ist die Auskunft unter dem Lock hier per Default ein
 * autoritativer PLATTEN-Scan, kein Index:
 *
 *     await withIdClaim({ vaultRoot, id, filePath }, async (claim) => {
 *       const located = await claim.locate();   // von der Platte, unter dem Lock
 *       …prüfen, schreiben…
 *     });
 *
 * Die Invariante, die daraus folgt und die dieses Modul trägt: **eine ID, eine
 * Datei, ein transaktionaler Writer.**
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertInsideDir, assertInsideVault, assertOwnSubdir } from "./file-identity.js";
import { scanVaultForIdAsync, type IdScanStats, type Located } from "./memory-locator.js";
import {
  acquireCommitClaim,
  commitLockPathFor,
  releaseCommitClaim,
} from "./save-commit.js";

/**
 * Wer beantwortet unter dem Lock die Frage „wo lebt diese id?".
 *
 * IMMER der Plattenscan — seit Codex-Gegenreview Runde 10 gibt es keinen Weg
 * mehr, ihn von außen zu ersetzen (siehe `withIdClaim`):
 *
 * Codex-Gegenreview (P0): Der Bulk-Import setzte hier einen Vault-Snapshot
 * ein, weil ein Scan je Datei quadratisch ist. Prozesssicher war das nicht —
 * der Snapshot kennt keinen Save, der währenddessen aus einem anderen Prozess
 * oder von einer zweiten Maschine kommt, und „ein Prozess pro Import" ist
 * keine Zusicherung, solange andere denselben Vault schreiben dürfen.
 * Nachgestellt: Snapshot auf leerem Vault, normaler Save von `race-id`, dann
 * Import — zwei Dateien mit einer id. Der Import zahlt jetzt wie jeder andere
 * Writer.
 */
export interface IdAuthority {
  locate(id: string): Promise<Located>;
}

/**
 * Was ein autoritativer Scan gekostet hat — plus, wofür er lief.
 *
 * Der Scan ist der Preis dieser Invariante, und er hängt NICHT an der Zahl der
 * indexierten Memories, sondern an der Gesamtzahl und Gesamtgröße aller
 * Markdown-Dateien im Vault. Lokal auf APFS ist das zweistellig in
 * Millisekunden; auf einem Cloud-Mount oder in einem großen Obsidian-Vault ist
 * es eine offene Frage. Deshalb wird gemessen und nicht geschätzt: Wer den
 * Preis nicht sieht, merkt eine Regression erst, wenn ein Save Sekunden dauert.
 */
export interface IdScanObservation extends IdScanStats {
  vaultRoot: string;
  id: string;
  /** Welcher Writer den Scan ausgelöst hat. Ohne diese Angabe lassen sich
   *  Create, Update und Import nicht getrennt auswerten — und genau die haben
   *  verschiedene Verteilungen. */
  op: string;
  /** Dauer des Scans in Millisekunden. */
  ms: number;
}

const scanObservers = new Set<(o: IdScanObservation) => void>();

/** Jeden autoritativen Scan mithören. Gibt die Abmeldung zurück. */
export function onIdScan(fn: (o: IdScanObservation) => void): () => void {
  scanObservers.add(fn);
  return () => scanObservers.delete(fn);
}

/** Der autoritative Scan: liest die Platte, nicht den Index. */
export function diskAuthority(vaultRoot: string, op = "unknown"): IdAuthority {
  return {
    async locate(id: string): Promise<Located> {
      const stats: IdScanStats = { dirs: 0, files: 0, bytes: 0, blindSpots: 0 };
      const started = Date.now();
      try {
        return await scanVaultForIdAsync(vaultRoot, id, stats);
      } finally {
        const observation: IdScanObservation = {
          ...stats,
          vaultRoot,
          id,
          op,
          ms: Date.now() - started,
        };
        for (const fn of scanObservers) {
          // Ein Beobachter darf einen Schreibvorgang nie zum Scheitern bringen.
          try {
            fn(observation);
          } catch {
            /* ignoriert */
          }
        }
      }
    },
  };
}

/**
 * Die Marke, die einen ECHTEN Claim von einem nachgebauten unterscheidet.
 *
 * Codex-Gegenreview Runde 10 (Security): `IdClaim` war rein strukturell —
 * `{ id, locate }` genügte. Zusammen mit den öffentlich exportierten
 * Trash-Primitiven stimmte die Zusage „wer den Claim hat, hält den passenden
 * Lock" damit nicht als API-Garantie: Jeder Aufrufer konnte sich einen bauen.
 * Das Symbol wird NICHT exportiert; ein Claim entsteht nur in `withIdClaim`.
 */
const ID_CLAIM: unique symbol = Symbol("bastra.idClaim");

export interface IdClaim {
  /** @internal — nur `withIdClaim` setzt das. */
  readonly [ID_CLAIM]: true;
  readonly id: string;
  /**
   * Wo lebt diese id — verbindlich, unter dem Lock erhoben.
   *
   * Jeder Aufruf fragt neu. Ein Memoisieren wäre bequem und falsch: Wer
   * innerhalb der Transaktion selbst schreibt, muss danach dieselbe Frage neu
   * stellen dürfen und die Wirkung seines Schreibens sehen.
   */
  locate(): Promise<Located>;
}

/**
 * Trägt dieser Claim die Marke — oder hat ihn jemand nachgebaut (#381)?
 *
 * Die nominale Typisierung schützt den TYPESCRIPT-Vertrag: Ohne das Symbol
 * lässt sich `IdClaim` nicht literal erzeugen. Zur LAUFZEIT galt das nicht.
 * `@bastra-recall/core` ist ein veröffentlichtes Paket, `moveToTrashUnderClaim`
 * und `restoreFromTrashUnderClaim` sind exportiert, und ein Aufrufer ohne
 * TypeScript — JavaScript, ein anderer Sprachbindungs-Layer, ein
 * Kompilat ohne Typprüfung — konnte ein schlichtes `{ id, locate }` übergeben.
 * Die Zusage „wer den Claim hat, hält den passenden Lock" war damit eine
 * Konvention, keine Garantie.
 *
 * DER SCHADEN WAR BEGRENZT, und das bleibt die ehrliche Einordnung: Die
 * Trash-Primitive prüft zusätzlich, dass die Datei wirklich das Memory dieser
 * id enthält — verschieben ließ sich also nur, was der id ohnehin gehört.
 * Gehalten wurde der Lock trotzdem nicht, und damit konnte die Operation mit
 * einem gleichzeitigen echten Writer kollidieren.
 *
 * Wirft statt `false` zurückzugeben: Ein nachgebauter Claim ist kein Zustand,
 * über den ein Aufrufer entscheiden dürfte, sondern ein Programmierfehler an
 * der Schnittstelle.
 */
export function assertRealClaim(claim: IdClaim, op: string): void {
  if (claim?.[ID_CLAIM] !== true) {
    throw new Error(
      `${op} requires a real id claim from withIdClaim() — the object passed was not one. ` +
        `Wrap the call in withIdClaim({ vaultRoot, id, filePath }, (claim) => …).`,
    );
  }
}

export interface IdClaimOptions {
  vaultRoot: string;
  /** Die id, die beansprucht wird — der Lock hängt an ihr, nicht am Pfad. */
  id: string;
  /** Der Pfad, um den es geht. Nur für die Fehlermeldung und die
   *  Containment-Prüfung; der Lock kennt ihn nicht. */
  filePath: string;
  /** Welcher Writer hier schreibt (`save_memory`, `save_document`, `archive`,
   *  …). Geht in die Scan-Messung ein; siehe {@link IdScanObservation}. */
  op?: string;
}

/**
 * Die id für die Dauer von `fn` beanspruchen.
 *
 * Nebenbei die zentrale Realpath-Schranke für JEDEN Writer, der hier
 * durchgeht: Sowohl das Ziel als auch das Lock-Verzeichnis müssen real im
 * Vault liegen. Das schließt ein Loch, das bisher schon ein gewöhnlicher
 * `saveMemory` aufriss — ein `.bastra -> /außerhalb`-Symlink ließ das
 * Lock-Verzeichnis außerhalb des Vaults entstehen, weil der Pfad nur
 * zusammengesetzt und nie aufgelöst wurde.
 *
 * Nicht reentrant: Wer innerhalb von `fn` dieselbe id erneut beansprucht,
 * bekommt einen Write-Conflict. Das ist Absicht — ein verschachtelter Anspruch
 * auf dieselbe id ist immer ein Denkfehler im Aufrufer, und ein Fehler ist
 * besser als ein Deadlock.
 */
export async function withIdClaim<T>(
  opts: IdClaimOptions,
  fn: (claim: IdClaim) => Promise<T>,
): Promise<T> {
  assertInsideVault(opts.vaultRoot, opts.filePath);
  const lockPath = commitLockPathFor(opts.vaultRoot, opts.id);
  // Sicherheitsrunde: Der Lock lag bisher nur „irgendwo im Vault". Zeigt
  // `.bastra` auf ein AKTIVES Regal, entstehen die Lock-Dateien mitten im
  // Bestand — sichtbar in Obsidian, mitsynchronisiert, und ein Aufräumen dort
  // öffnet den Lock für einen zweiten Writer. `.bastra` ist eine eigene
  // Grenze: erst muss sie im Vault liegen, dann der Lock in ihr.
  const bastraDir = join(opts.vaultRoot, ".bastra");
  // Dieselbe Kette wie beim Trash: `.bastra` muss dem Vault gehören, das
  // Lock-Regal muss `.bastra` gehören, und der Lock muss darin liegen. Die
  // mittlere Frage fehlte — ein `.bastra/locks -> .bastra/trash` verlässt
  // `.bastra` nicht und kam deshalb durch.
  assertOwnSubdir(opts.vaultRoot, bastraDir, "lock");
  const locksDir = dirname(lockPath);
  assertOwnSubdir(bastraDir, locksDir, "lock");
  assertInsideDir(locksDir, lockPath, "lock", "the locks folder");
  await mkdir(dirname(lockPath), { recursive: true });
  const token = await acquireCommitClaim(lockPath, opts.id, opts.filePath);
  // Kein injizierbares `authority` mehr. Codex-Gegenreview Runde 10
  // (Security): Solange `IdClaimOptions` eine austauschbare Auskunft führte,
  // konnte ein Aufrufer den autoritativen Plattenscan durch eine beliebige
  // Antwort ersetzen — die Invariante „unter dem Lock entscheidet die Platte"
  // galt dann nur für die internen Aufrufstellen, nicht für die API.
  const authority = diskAuthority(opts.vaultRoot, opts.op);
  try {
    return await fn({
      [ID_CLAIM]: true,
      id: opts.id,
      locate: () => authority.locate(opts.id),
    });
  } finally {
    await releaseCommitClaim(lockPath, token);
  }
}
