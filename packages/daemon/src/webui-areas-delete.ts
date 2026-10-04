/**
 * Area delete (#216, split out of webui-areas.ts in #680) — the whole area,
 * memories and docs shelf, moves into the vault trash; never rm. Ground
 * rules: see webui-areas.ts.
 */
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { assertInsideDir, assertOwnSubdir, clearAreaMark, ensureVaultDir, markAreaDeleted, withAreaExclusive } from "@bastra-recall/core";
import { areaPath, assertEditable, docsShelfPath, isDir } from "./webui-areas-shared.js";

export interface DeleteResult {
  name: string;
  trashedTo: string;
  /** Wohin `dokumentationen/<projekt>` gewandert ist — undefined, wenn das
   *  Projekt kein Doku-Regal hatte. */
  docsTrashedTo?: string;
}

/**
 * Die Grenze des Area-Trash — dieselbe Kette wie beim Memory-Trash
 * (`trashPathFor()` in core/audit-log.ts).
 *
 * Codex-Gegenreview (Sicherheit): Hier stand eine SCHWÄCHERE Prüfung als dort
 * — ein lexikalisches `startsWith` auf den Trash-Ordner plus ein
 * `assertInsideVault` auf `.bastra/trash/areas`. Beides ist zu wenig:
 * `assertInsideVault` fragt nur, ob das Ziel IRGENDWO im Vault liegt. Ein
 * `.bastra -> memories` oder ein `.bastra/trash -> dokumentationen` verlässt
 * den Vault nicht und kam deshalb glatt durch — aus dem Löschen wurde ein
 * Verschieben in den AKTIVEN Bestand: die Area als „in den Trash gelegt"
 * gemeldet, ihre Memories weiterhin im Recall und in Obsidian sichtbar. Der
 * Trash ist eine eigene Grenze, nicht bloß ein Ordner im Vault; deshalb
 * dieselben vier Fragen wie beim Memory-Trash, jede an ihr eigenes
 * Elternverzeichnis: gehört `.bastra` dem Vault selbst (kein Symlink), liegt
 * `trash` in `.bastra`, liegt `areas` im Trash, liegt das Ziel in `areas`.
 *
 * Sicherheitsrunde, zweite Ebene (die Invariante war hier nur zur Hälfte
 * nachgezogen): `.bastra` war über `assertOwnSubdir` geschützt, seine privaten
 * UNTERREGALE aber nur über `assertInsideDir` — und das fragt lediglich, ob
 * das Ziel IRGENDWO unter dem Elternpfad landet. Ein nach INNEN zeigender
 * Symlink kam damit glatt durch, obwohl `trashPathFor()` in
 * core/audit-log.ts für denselben Trash längst `assertOwnSubdir` verlangt.
 * Nachgestellt:
 *   - `.bastra/trash -> .bastra/locks`: Die gelöschte Area landet zwischen den
 *     Lock-Dateien. Wer dort aufräumt, nimmt gelöschte Memories mit — oder
 *     öffnet einen gehaltenen Lock.
 *   - `.bastra/trash/areas -> .bastra/trash`: Die Area-Ordner liegen dann
 *     zwischen den einzelnen Memory-Trash-Dateien, und `latestTrashPathFor()`
 *     stolpert über Verzeichnisse, wo es Dateien erwartet.
 * Für private Daemon-Ablage gilt auf JEDER Ebene dieselbe Regel wie für
 * `.bastra` selbst: kein Symlink, auch kein nach innen zeigender.
 */
function assertAreaTrashBoundary(vaultRoot: string, areasRoot: string, dests: string[]): void {
  const bastraDir = join(vaultRoot, ".bastra");
  const trashDir = join(bastraDir, "trash");
  assertOwnSubdir(vaultRoot, bastraDir, "trash an area");
  assertOwnSubdir(bastraDir, trashDir, "trash an area");
  assertOwnSubdir(trashDir, areasRoot, "trash an area");
  for (const dest of dests) {
    assertInsideDir(areasRoot, dest, "trash an area", "the area trash folder");
  }
}

/** Move the whole area folder into the vault trash — recoverable, never rm.
 *
 *  Codex-Befund 4: Delete nahm nur das Memory-Regal mit und ließ
 *  `dokumentationen/<projekt>` aktiv zurück. Rename und Delete meinten damit
 *  zwei verschiedene Dinge, wenn sie „Area" sagten — die Area verschwand aus
 *  der Karte, ihre Produktdokumente blieben im Recall.
 *
 *  ENTSCHEIDUNG: Das Doku-Regal wandert mit in den Trash. Rename zieht es
 *  schon immer mit; eine Area IST beides, und die Konsistenz ist hier
 *  gefahrlos zu haben, weil Delete nichts vernichtet — beide Regale liegen
 *  nebeneinander im Trash und sind von Hand zurückzuschieben. Der umgekehrte
 *  Weg (Rename lässt die Doku stehen) hätte den Recall dauerhaft mit
 *  Dokumenten eines Projekts versorgt, das es nicht mehr gibt.
 */
export async function deleteArea(
  vaultRoot: string,
  kind: "project" | "top",
  name: string,
): Promise<DeleteResult> {
  assertEditable(kind, name);
  return withAreaExclusive(vaultRoot, [name], () => deleteAreaLocked(vaultRoot, kind, name));
}

async function deleteAreaLocked(
  vaultRoot: string,
  kind: "project" | "top",
  name: string,
): Promise<DeleteResult> {
  const from = areaPath(vaultRoot, kind, name);
  if (!(await isDir(from))) throw new Error(`area not found: ${name}`);
  const trashRoot = join(vaultRoot, ".bastra", "trash", "areas");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dest = join(trashRoot, `${name}-${stamp}`);
  const docsDest = join(trashRoot, `${name}-${stamp}-dokumentationen`);
  // VOR dem mkdir: `recursive: true` folgt einem umgebogenen `.bastra` und
  // legt den Trash dort an, bevor irgendeine Prüfung ihn zu sehen bekommt.
  assertAreaTrashBoundary(vaultRoot, trashRoot, [dest, docsDest]);
  await ensureVaultDir(vaultRoot, trashRoot);
  // Und danach noch einmal: zwischen Prüfung und mkdir liegt ein await, und
  // erst jetzt existieren die Ordner, deren Realpfad wirklich zählt.
  assertAreaTrashBoundary(vaultRoot, trashRoot, [dest, docsDest]);
  // Codex-Gegenreview (P0), dieselbe Klasse wie beim Rename: Nachgestellt —
  // die Area wandert in den Trash, danach schreibt ein Save mit `scope:
  // carnexus` (aus einer Session, die das Projekt noch kennt) und legt
  // `memories/projects/carnexus` neu an. Die Area war „gelöscht“ und ist mit
  // einem einzelnen Memory still wieder da, ohne dass jemand das entschieden
  // hätte. Der Grabstein steht wie beim Rename VOR der Bewegung: Ein Absturz
  // dazwischen lässt den Namen gesperrt zurück, und das ist die Richtung, in
  // der nichts unbemerkt passiert.
  if (kind === "project") await markAreaDeleted(vaultRoot, name);
  try {
    await rename(from, dest);
  } catch (err) {
    // Nichts wurde bewegt — die Area liegt weiter unter `from`. Der
    // Grabstein darf dann nicht stehen bleiben: Er hätte jeden Save in
    // dieses Regal mit "was deleted" abgewiesen, während `createArea`
    // gleichzeitig ablehnt, weil der Ordner noch existiert — ein Name, den
    // niemand mehr anlegen oder löschen kann.
    if (kind === "project") await clearAreaMark(vaultRoot, name);
    throw err;
  }
  // Nebeneinander statt ineinander: der Trash-Ordner der Memories behält
  // seine Form (`<name>-<stamp>/<memory>.md`), damit ein Restore von Hand
  // nicht plötzlich eine Ebene tiefer suchen muss.
  let docsTrashedTo: string | undefined;
  if (kind === "project") {
    const docsFrom = docsShelfPath(vaultRoot, name);
    if (await isDir(docsFrom)) {
      try {
        await rename(docsFrom, docsDest);
        docsTrashedTo = docsDest;
      } catch (err) {
        // Codex-Gegenreview (P1): Scheiterte der Doku-Zug, blieb ein halber
        // Zustand zurück — Memories im Trash, Dokumente aktiv. Eine Area ist
        // beides; sie geht ganz oder gar nicht. Dieselbe Entscheidung wie
        // beim Rename, siehe `rollbackRename`.
        try {
          await rename(dest, from);
        } catch {
          throw new Error(
            `delete failed AND could not be fully undone: ${(err as Error).message}. ` +
              `Von Hand zu richten: ${dest} (sollte ${from} sein).`,
          );
        }
        // Vollständig zurück: Das Regal liegt wieder an seinem Platz, also
        // ist der Name wieder in Betrieb. Nur hier — auf dem Pfad darüber
        // (`could not be fully undone`) bleibt der Grabstein bewusst stehen.
        await clearAreaMark(vaultRoot, name);
        throw new Error(
          `delete failed, nothing was changed: ${(err as Error).message}`,
        );
      }
    }
  }
  return { name, trashedTo: dest, docsTrashedTo };
}
