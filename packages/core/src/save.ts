import { createHash } from "node:crypto";
/**
 * The save orchestration: build the frontmatter, resolve the target, commit the
 * file, report what happened.
 *
 * Four neighbours carry what this used to hold inline — `save-schema.ts` (the
 * input contract), `save-text.ts` (slug and body helpers), `save-commit.ts`
 * (the id-level claim) and `save-target.ts` (where the file goes). They were
 * split out when this file passed 800 lines; nothing changed but the location.
 */
import { writeFile, unlink, rename, link, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureVaultDir } from "./vault-root-guard.js";
import type { SaveMemoryInput, SaveMemoryResult, SaveMemoryCommitOptions } from "./save-schema.js";
import { MemoryWriteConflictError, assertBodyTail } from "./save-schema.js";
import { fileExists, readTarget, writeConflict } from "./save-commit.js";
import { withIdClaim, type IdClaim } from "./id-transaction.js";
import { sameFile } from "./file-identity.js";
import { resolveMemoryTarget } from "./save-target.js";
import { moveToTrashUnderClaim } from "./audit-log.js";
import { areaExclusivelyHeld, areaKeyForPath, withAreaShared } from "./area-claim.js";
import { newOperationId, reportMutationIncident } from "./mutation-incident.js";
import { readOccupant, scanVaultForId, vaultRelative } from "./memory-locator.js";
import { SUMMARY_TRUNCATED_NOTE, cloneForAudit, planMemoryWrite } from "./save-plan.js";

/**
 * Build the .md content for a new memory and write it into the vault.
 * The vault watcher will pick it up and index it automatically.
 */
export async function saveMemory(
  vaultRoot: string,
  input: SaveMemoryInput,
  commit: SaveMemoryCommitOptions = {}
): Promise<SaveMemoryResult> {
  // #544: the declared tail of the body, checked before any lock or file I/O.
  // A body that arrives truncated (MCP framing, a lossy proxy, an older
  // client) would otherwise land as a shorter memory that looks exactly like
  // a successful save — the caller cannot tell, and neither can the user.
  // Living here, not only in the tool handler, means every caller of
  // `saveMemory` inherits it, including `auditedSave` / bridge.ts.
  assertBodyTail(input.body, input.body_ends_with);

  // #892: the vault root first, through the one guard. A root seen present
  // before (this run or an earlier one, vault-root-guard.ts) but missing now
  // is a mount that is gone, and the save is refused instead of recreating it
  // on the parent filesystem. A root never seen is the "created on first
  // save" case: a save is a writer that may make a vault. Before the area and
  // id claims, whose lock files live under the root.
  await ensureVaultDir(vaultRoot, vaultRoot, { createRoot: true });

  const locator = commit.locator ?? { locate: (wanted: string) => scanVaultForId(vaultRoot, wanted) };
  // Der injizierte Locator macht hier nur noch das ROUTING: In welchem Regal
  // und in welcher Schreibweise liegt diese id, damit ein Bestands-Memory
  // nicht plötzlich woanders auftaucht. Die verbindliche Frage — gehört die
  // id schon jemandem? — stellt die Transaktion unten, und zwar an die Platte.
  const { id, filePath, scope, existingPath } = resolveMemoryTarget(vaultRoot, input, locator);
  // REIHENFOLGE: Area-Claim VOR ID-Claim, überall im Vault dieselbe.
  //
  // Codex-Gegenreview Runde 10 (P0-1): Der Grabstein wurde bisher mitten im
  // Save gelesen und danach noch geparst, gebaut, geschrieben und umbenannt.
  // Nachgestellt: Zwischen der Prüfung und dem Publish lief ein kompletter
  // Area-Rename durch — der Save veröffentlichte trotzdem im alten Regal, und
  // danach existierten beide. Der SHARED Area-Claim hält das Regal über den
  // GESAMTEN Publish; er schließt Saves untereinander nicht aus (die ändern das
  // Regal nicht), nur gegen Create/Rename/Delete.
  //
  // Codex-Abschlussprüfung (P0-2): Gesperrt wurde der SCOPE. Das physische Ziel
  // kann durch `folder` aber ein ganz anderes Regal sein — bestätigt mit einem
  // gehaltenen `people`-Lock und `saveMemory({ scope: "carnexus", folder:
  // "memories/people" })`, das glatt durchlief. Der Schlüssel kommt deshalb aus
  // dem AUFGELÖSTEN Pfad. Beim Re-Filing sind es zwei Regale: das Ziel und die
  // Quelle, die gleich getrasht wird.
  //
  // Restfenster, bewusst offen: Findet der autoritative Scan unter dem ID-Claim
  // eine Quelle, die die Routing-Auskunft nicht kannte (veralteter Index), ist
  // deren Regal hier nicht mitgesperrt. Es früher zu wissen hieße, den
  // Vaultscan VOR den Area-Claim zu ziehen — und damit die Auskunft, um die es
  // geht, wieder ohne Sperre zu erheben.
  return withAreaShared(
    vaultRoot,
    [areaKeyForPath(vaultRoot, filePath), existingPath !== undefined ? areaKeyForPath(vaultRoot, existingPath) : null],
    () =>
      withIdClaim(
        { vaultRoot, id, filePath, op: input.overwrite ? "save_memory_update" : "save_memory_create" },
        (claim) => commitMemory(vaultRoot, input, commit, { id, filePath, scope }, claim)
      )
  );
}

/**
 * Der Rumpf des Saves — vollständig UNTER der ID-Transaktion.
 *
 * Alles hier drin, von der ersten Prüfung bis zum Rename, sieht denselben
 * Vault: kein anderer Writer kann in der Zwischenzeit dieselbe id belegen.
 * Vorher lief die Prüfung vor dem Lock und der Commit darin, und dazwischen
 * lag genau das Fenster, in dem zwei Saves derselben id zwei Dateien anlegten.
 */
async function commitMemory(
  vaultRoot: string,
  input: SaveMemoryInput,
  commit: SaveMemoryCommitOptions,
  target: { id: string; filePath: string; scope: string },
  claim: IdClaim
): Promise<SaveMemoryResult> {
  const { id, filePath: filePath0 } = target;
  // EINE autoritative Auskunft für die gesamte Transaktion: Sie beantwortet
  // die Kollisionsfrage, sie bestimmt das ZIEL, und sie sagt, welche Datei
  // beim Re-Filing die Vorlage ist.
  const located = await claim.locate();

  // #382: Die Quelle, die nur der autoritative Scan kennt.
  //
  // Der Area-Claim oben sperrt, was die Routing-Auskunft wusste. Ist deren
  // Index veraltet — er kann aus einem anderen Prozess stammen —, liegt die
  // echte Quelle womöglich in einem Regal, das nicht mitgesperrt wurde. Ein
  // gleichzeitiger Rename dieses Regals wäre dann nicht gegen das Trashen der
  // Quelle serialisiert.
  //
  // Nachträglich mitsperren geht nicht: Die globale Reihenfolge ist Area vor
  // ID, und wer nach der Leerprüfung eines exklusiven Erwerbers noch einen
  // Reader einträgt, öffnet genau das Fenster, das das Protokoll schließt.
  // FRAGEN geht. Läuft dort gerade eine Area-Operation, tritt der Save zurück,
  // statt in sie hineinzuschreiben — derselbe wiederholbare Konflikt, den auch
  // ein gekreuzter Save bekommt.
  //
  // Was das NICHT löst: Ein Rename, der eine Mikrosekunde nach dieser Frage
  // beginnt. Das Fenster wird schmal, nicht null; ganz zu ist es erst mit
  // einem Vaultscan vor dem Area-Claim, und der wäre wieder ungesperrt.
  if (located.kind === "unique" && !sameFile(located.filePath, filePath0)) {
    const sourceArea = areaKeyForPath(vaultRoot, located.filePath);
    if (sourceArea !== null && (await areaExclusivelyHeld(vaultRoot, sourceArea))) {
      reportMutationIncident({
        operation_id: newOperationId(),
        op: "save_memory",
        status: "conflict",
        phase: "area-claim-late-source",
        memory_id: id,
        detail: "source shelf found only by the authoritative scan is under an area operation",
      });
      throw writeConflict(
        id,
        located.filePath,
        `the area holding this memory is being renamed, deleted or created right now — ` +
          `nothing was written. Retry in a moment.`
      );
    }
  }

  const { filePath, observedTarget, exists, refiledFrom, baseRaw, auditBefore, fm, content, summaryTruncated } =
    await planMemoryWrite(vaultRoot, input, commit, target, located);

  // #530: Ein Save, der exakt das schreiben würde, was schon dasteht, ist
  // kein Save. Ohne diese Abzweigung schrieb ein wiederholter Import jede
  // unveränderte Datei neu — neue mtime (Cloud-Sync-Churn) und ein
  // `update`-Audit-Ereignis, dessen Vor- und Nachbild identisch waren.
  //
  // Erneut gelesen statt `observedTarget` geglaubt: zwischen dem ersten Read
  // und hier kann ein Writer OHNE Claim (Obsidian, Cloud-Sync) das Ziel
  // verändert haben. Stimmen die Bytes nicht mehr mit dem überein, was dieser
  // Save als Vorlage hatte, wird NICHT übersprungen — dann läuft der normale
  // Pfad weiter und sein CAS-Vergleich meldet den Konflikt.
  //
  // Ein Re-File ist nie unverändert: dort ist der Umzug selbst die Änderung.
  if (commit?.skipUnchanged && refiledFrom === null && exists) {
    const current = await readTarget(filePath);
    if (current !== null && current === observedTarget && sameExceptUpdatedStamp(content, current)) {
      return {
        id,
        file_path: filePath,
        created: false,
        unchanged: true,
        audit_before: auditBefore,
        audit_after: cloneForAudit(fm),
      };
    }
  }

  await ensureVaultDir(vaultRoot, dirname(filePath));
  // Atomar via temp+rename — dieselbe Begründung wie in related-enrich.ts:241
  // ("ein direkter writeFile lässt das File kurzzeitig leer, live beobachtet").
  // Der Fix war dort gegen ein beobachtetes Datenverlust-Fenster eingebaut,
  // aber nie auf den häufigsten Writer zurückportiert. Der Temp-Name trägt
  // zusätzlich einen Zufallsanteil: ein fixer `.tmp-<pid>` kollidiert bei
  // überlappenden Schreibern desselben Prozesses (#240/B3) und veröffentlicht
  // per rename das Mischprodukt.
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    // #285: compare the exact bytes seen before the candidate was built with
    // the bytes at commit time. Die ID-Transaktion serialisiert jeden Writer,
    // der diese id beansprucht — auch in einem anderen Prozess; der Vergleich
    // fängt einen Schreibvorgang, der VOR dem Claim gelandet ist.
    const commitTarget = await readTarget(filePath);
    if (commitTarget !== observedTarget) {
      throw writeConflict(id, filePath, "target changed while the save was being prepared");
    }

    // Codex-Gegenreview (P0): Beim Re-Filing war die QUELLE die Patch-Vorlage
    // (`baseRaw`), aber verglichen wurde vor dem Publish nur das ZIEL — und
    // getrasht wurde die Quelle danach ungeprüft. Der id-Lock hilft dagegen
    // nicht: Ein externer Writer (Obsidian, Cloud-Sync) kennt ihn nicht.
    // Nachgestellt: Re-File beginnt auf `source: before-external`, während die
    // fertige Tempdatei geschrieben wird ersetzt eine externe Bearbeitung die
    // Quelle durch `source: after-external`, das Re-File meldet Erfolg — und
    // das aktive Memory trägt danach `before-external`, die neuere Fassung
    // liegt nur noch im Trash. Wiederherstellbar, aber aus dem aktiven Bestand
    // still verschwunden.
    //
    // Der Vergleich steht VOR dem Publish, nicht vor dem Trash: Danach wäre
    // das neue Ziel schon veröffentlicht und der Konflikt nur noch per
    // Rollback zurückzunehmen. So ist nichts geschrieben und nichts getrasht.
    if (refiledFrom !== null) {
      const commitSource = await readTarget(refiledFrom);
      if (commitSource !== baseRaw) {
        throw writeConflict(id, refiledFrom, "the source file changed while the re-file was being prepared");
      }
    }

    if (commitTarget === null) {
      // rename() replaces an existing destination. A hard link publishes the
      // completed temp inode atomically but fails with EEXIST if any writer
      // creates the target after the comparison.
      try {
        await link(tmp, filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
          throw writeConflict(id, filePath, "target was created during commit");
        }
        throw err;
      }
      await unlink(tmp);
    } else {
      await rename(tmp, filePath);
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }

  // Das Re-Filing ist erst hier zu Ende: Die neue Datei steht, die ALTE muss
  // weg. Codex-Gegenreview (P0): Dieses Aufräumen lag in den Aufrufern
  // (`tool-handlers.ts`, `auditedSave`) und lief NACH der Freigabe des
  // id-Locks — ein direkter `saveMemory(overwrite, folder)` räumte gar nicht
  // auf und meldete obendrein `created: true`, und ein Absturz dazwischen
  // hinterließ zwei aktive Dateien mit einer id. Ein Umzug ist eine
  // Operation, also gehört er ganz unter denselben Claim.
  if (refiledFrom !== null) {
    try {
      // Codex-Gegenreview (P0): Die Quelle wurde VOR dem Publish gegen
      // `baseRaw` geprüft und danach ungeprüft weggeräumt. Eine externe
      // Änderung, die genau dazwischen eintraf — also sobald das neue Ziel
      // sichtbar wurde —, ging still verloren. Nachgestellt:
      //
      //   outcome: fulfilled, sourceExists: false,
      //   activeHasBastra: true, activeHasExternal: false,
      //   trashHasExternal: true
      //
      // Die alte Fassung stand aktiv im Vault, die neuere lag nur noch im
      // Trash — wiederherstellbar, aber aus dem Bestand verschwunden, und der
      // Save meldete Erfolg. Prüfung und Rename liegen deshalb beieinander,
      // in `moveToTrashUnderClaim`. Bei Abweichung wird der Ziel-Publish
      // zurückgenommen und die Quelle bleibt aktiv: Ein Write-Conflict, den
      // der Aufrufer wiederholen kann, statt eines stillen Verlusts.
      await moveToTrashUnderClaim(vaultRoot, refiledFrom, claim, baseRaw);
    } catch (err) {
      // Die Quelle steht noch, das neue Ziel auch — das wären zwei aktive
      // Dateien mit einer id. Also zurück, so weit es geht: Ein Ziel, das wir
      // gerade erst angelegt haben, wird entfernt; ein überschriebenes bekommt
      // seine Vorbilder-Bytes zurück.
      const undone = await rollbackPublish(filePath, observedTarget);
      // #377: Genau hier entsteht der einzige Zustand dieser Funktion, den ein
      // Mensch anfassen muss — zwei aktive Dateien mit einer id. Der Aufrufer
      // erfährt ihn als Fehlermeldung, aber niemand sonst; ohne Incident ist
      // er nach dem nächsten Terminalfenster verschwunden.
      reportMutationIncident({
        operation_id: newOperationId(),
        op: "save_memory_refile",
        status: undone ? "rolled_back" : "partial",
        phase: "refile-trash",
        memory_id: id,
        rollback: undone ? "complete" : "none",
        detail: err instanceof MemoryWriteConflictError ? "source changed" : "trash failed",
      });
      // Der Grund zählt für den Aufrufer: „jemand hat die Quelle geändert" ist
      // wiederholbar, „der Trash ist kaputt" nicht. Ein Konflikt bleibt
      // deshalb ein Konflikt (`MEMORY_WRITE_CONFLICT`) — aber nur, wenn das
      // Rollback wirklich alles zurückgenommen hat; sonst steht ein
      // Doppelzustand im Vault, und den darf keine Retry-Logik übersehen.
      if (undone && err instanceof MemoryWriteConflictError) throw err;
      throw new Error(
        `re-file aborted: ${vaultRelative(vaultRoot, refiledFrom)} could not be trashed ` +
          `(${(err as Error).message}). ` +
          (undone
            ? `Nothing was changed.`
            : `AND ${vaultRelative(vaultRoot, filePath)} could not be rolled back — both files ` +
              `now carry id '${id}'. Remove or fix one of them by hand.`)
      );
    }
  }

  return {
    id,
    file_path: filePath,
    // Ein Umzug erschafft nichts. Vorher meldete er `created: true`, weil das
    // ZIEL neu war — der Aufrufer konnte einen Move nicht von einem Neuanlegen
    // unterscheiden.
    created: !exists && refiledFrom === null,
    // Vor- und Nachbild, beide unter DIESEM Claim entstanden: das Vorbild aus
    // der Datei, die wirklich die Vorlage war (beim Re-File die Quelle, nicht
    // das Ziel), das Nachbild aus dem Frontmatter, das eben geschrieben wurde.
    audit_before: auditBefore,
    audit_after: cloneForAudit(fm),
    ...(refiledFrom !== null ? { refiled_from: refiledFrom } : {}),
    ...(summaryTruncated
      ? {
          summary_note: SUMMARY_TRUNCATED_NOTE,
        }
      : {}),
  };
}

/**
 * #530: Sind zwei Dateifassungen bis auf den `updated:`-Stempel gleich?
 *
 * `buildFrontmatter` stempelt `updated` bei JEDEM Schreibvorgang auf heute.
 * Ohne diese Ausnahme wäre derselbe Import einen Tag später nie ein No-Op,
 * obwohl sich inhaltlich nichts geändert hätte. Ersetzt wird nur das ERSTE
 * Vorkommen am Zeilenanfang — das ist das Frontmatter-Feld; der Body steht
 * dahinter und bleibt Wort für Wort im Vergleich.
 */
function sameExceptUpdatedStamp(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (s: string) => s.replace(/^updated: .*$/m, "updated: <stamp>");
  return strip(a) === strip(b);
}

/**
 * Ein gerade veröffentlichtes Ziel zurücknehmen. `true`, wenn der Zustand von
 * vor dem Commit wiederhergestellt ist.
 *
 * `preimage === null` heißt „das Ziel gab es nicht" — dann ist Entfernen die
 * Rücknahme. Sonst müssen die alten Bytes zurück, und zwar atomar: Ein halb
 * geschriebenes Rollback wäre schlimmer als gar keins.
 */
async function rollbackPublish(filePath: string, preimage: string | null): Promise<boolean> {
  try {
    if (preimage === null) {
      await unlink(filePath);
      return true;
    }
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.undo`;
    await writeFile(tmp, preimage, "utf8");
    await rename(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

export interface DeleteMemoryResult {
  id: string;
  file_path: string;
  deleted: boolean;
}

/**
 * Remove a memory file from disk by its absolute path. Caller resolves
 * the path through the vault index (so we don't have to guess where the
 * file lives — it could sit in any subfolder).
 *
 * Codex-Gegenreview (P0): Dieser Writer war öffentlich exportiert und lief an
 * der ID-Transaktion vorbei — ein blindes `unlink` auf einen Pfad, den ein
 * (möglicherweise veralteter) Index geliefert hat. Zwei Löcher in einem:
 * Erstens sah er keinen parallelen Save derselben id, zweitens ist ein Pfad
 * kein Identitätsbeweis — liegt dort inzwischen ein ANDERES Memory oder eine
 * gewöhnliche Notiz, löschte er die. `vaultRoot` ist deshalb Pflicht, der
 * Claim gilt für die id, und gelöscht wird nur, was unter dem Lock erkennbar
 * DIESES Memory ist.
 */
export async function deleteMemoryFile(
  filePath: string,
  id: string,
  opts: { vaultRoot: string; expectedSha256?: string }
): Promise<DeleteMemoryResult> {
  return withIdClaim({ vaultRoot: opts.vaultRoot, id, filePath, op: "delete_memory_file" }, async () => {
    if (!(await fileExists(filePath))) {
      throw new Error(`memory file not found: ${filePath}`);
    }
    if (
      opts.expectedSha256 !== undefined &&
      createHash("sha256")
        .update(await readFile(filePath))
        .digest("hex") !== opts.expectedSha256
    ) {
      throw Object.assign(new Error("memory file content changed since the expected snapshot"), {
        code: "MEMORY_CONTENT_CHANGED",
      });
    }
    const occupant = readOccupant(filePath);
    if (occupant.kind !== "memory" || occupant.id !== id) {
      throw new Error(
        `refusing to delete ${vaultRelative(opts.vaultRoot, filePath)}: it does not hold ` +
          `memory '${id}' (found ${occupant.kind === "memory" ? `'${occupant.id}'` : occupant.kind}). ` +
          `Re-resolve the path — a stale index entry must not delete a foreign file.`
      );
    }
    await unlink(filePath);
    return { id, file_path: filePath, deleted: true };
  });
}
