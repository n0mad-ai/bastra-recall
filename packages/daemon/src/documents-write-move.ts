/**
 * `move_document` und der rückrollbare Datei-Move, den auch save und
 * recategorize benutzen. Aus documents-write-handler.ts herausgelöst (#680).
 */
import {
  unlink,
  stat,
  link,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, basename } from "node:path";
import type { z } from "zod";
import type { Vault } from "@bastra-recall/core";
import {
  withIdClaim,
  type IdClaim,
} from "@bastra-recall/core";
import { hiddenFromCaller, hiddenOnDisk, type PrivateAccess } from "./private-access.js";
import {
  acknowledgeCommittedJournal,
  openRecoveryJournal,
  type RecoveryJournalHandle,
} from "./recovery-journal.js";
import { recordAudit } from "./audit-trail.js";
import { ensureVaultDir } from "@bastra-recall/core";
import type { MoveDocumentArgs } from "./documents-write-handler.js";
import {
  DOCUMENTS_ROOT,
  todayISO,
  vaultRoot,
  pathExists,
  resolveDocsFolder,
  readTargetRaw,
  publishSidecar,
  buildFrontmatter,
  isDocumentSidecar,
  readSidecarRaw,
  patchSidecarFrontmatter,
  renderPatched,
  metadataPatch,
} from "./documents-write-shared.js";

/**
 * Ein Commit, der nach einem Datei-Move gescheitert ist. Wirft immer.
 *
 * Zwei Ausgänge, und nur einer davon ist der saubere: Trägt der neue
 * Sidecar-Pfad noch genau unsere Bytes, wird der Move komplett zurückgenommen
 * und der ursprüngliche Fehler unverändert weitergereicht — der Zustand ist
 * dann wieder der vor dem Aufruf. Steht dort inzwischen etwas Fremdes, darf
 * kein Rollback es anfassen; dann bleiben die Dateien am neuen Ort, der Index
 * wird darauf umgehängt (sonst zeigte er auf einen leeren Pfad), und der
 * Fehler SAGT, dass der Move steht. Eine Meldung darf nur behaupten, was
 * stimmt.
 */
export async function abortMove(
  vault: Vault,
  moved: MovedDocumentFiles,
  oldSidecarPath: string,
  expectedSidecar: string | undefined,
  err: unknown,
): Promise<never> {
  const undone = await moved
    .rollback(expectedSidecar)
    .catch((e: unknown) => ({ ok: false, detail: (e as Error).message }) as MoveRollbackResult);
  if (undone.ok) throw err;
  if (moved.newSidecarPath !== oldSidecarPath) {
    vault.forgetFile(oldSidecarPath);
    await vault.reindexFile(moved.newSidecarPath).catch(() => {});
  }
  throw new Error(
    `${(err as Error)?.message ?? String(err)}\n\n` +
      `Careful: the files had already been moved and the move could NOT be fully undone: ` +
      `${undone.detail ?? "reason unknown"}. The sidecar frontmatter may still name the old ` +
      `folder. Read the document again (read_document) and redo the move.`,
  );
}

// ─── move_document ──────────────────────────────────────────────

export async function moveDocument(
  vault: Vault,
  args: z.infer<typeof MoveDocumentArgs>,
  /** #464: transportgebunden — siehe private-access.ts. */
  caller?: PrivateAccess,
): Promise<{
  id: string;
  sidecar_path: string;
  original_path: string;
  reindexed: boolean;
  warning?: string;
}> {
  const m = vault.get(args.id);
  // #464: wie im Recategorize — ein Move verschiebt Sidecar UND Originaldatei
  // und ist damit die sichtbarste Mutation von allen.
  if (!m || hiddenFromCaller(caller, m.fm)) {
    throw new Error(`document not found: ${args.id}`);
  }
  // Wie im Recategorize: eine Produktdoku ist kein Sidecar und wird hier
  // weder verschoben noch umgeschrieben.
  if (!isDocumentSidecar(m.fm)) {
    throw new Error(`not a document sidecar: ${args.id}`);
  }
  // Dieselbe Transaktion wie beim Recategorize: Ein Move liest, verschiebt und
  // patcht — ohne Sperre trat er sich mit einem gleichzeitigen Metadaten-Patch
  // desselben Dokuments auf die Füße, und beide meldeten Erfolg.
  return withIdClaim(
    { vaultRoot: vaultRoot(vault), id: args.id, filePath: m.filePath, op: "move_document" },
    (claim) => commitMoveDocument(claim, vault, args, m, caller),
  );
}

async function commitMoveDocument(
  claim: IdClaim,
  vault: Vault,
  args: z.infer<typeof MoveDocumentArgs>,
  m: { fm: Record<string, unknown> & { id: string; title: string; tags: string[]; summary: string; recall_when: string[]; created: string }; filePath: string },
  caller?: PrivateAccess,
): Promise<{
  id: string;
  sidecar_path: string;
  original_path: string;
  reindexed: boolean;
  warning?: string;
}> {
  const fm = m.fm as typeof m.fm & {
    original_path?: string;
    folder_path?: string;
    linked_file?: boolean;
    aliases?: string[];
    injection_flags?: string[];
  };
  const located = await claim.locate();
  if (located.kind !== "unique") {
    throw new Error(
      located.kind === "none"
        ? `document not found on disk: ${args.id}`
        : `cannot move ${args.id}: the vault scan is not conclusive (${located.kind}).`,
    );
  }
  // #464 (wiedereröffnet): wie im Recategorize — die Prüfung oben fragte den
  // INDEX, und ein Move verschiebt Sidecar UND Originaldatei. Dieselbe Frage
  // an die Bytes, unter dem Claim, bevor irgendetwas bewegt wird.
  if (hiddenOnDisk(caller, (await readSidecarRaw(located.filePath)).raw)) {
    throw new Error(`document not found: ${args.id}`);
  }

  const moved = await moveDocumentFiles(vault, {
    op: "move_document",
    id: m.fm.id,
    sidecarPath: located.filePath,
    originalPath: fm.original_path ?? located.filePath.replace(/\.md$/, ""),
    currentFolderPath: fm.folder_path ?? "",
    newFolderPath: args.folder_path,
    linkedFile: fm.linked_file ?? false,
  });

  // Codex-Gegenreview (P0): `vault.forgetFile()` lief hier direkt nach dem
  // Move — vor der Veröffentlichung. Scheiterte der Commit, fehlte das
  // Dokument im Index, während Original und Sidecar bereits im Zielordner
  // lagen. Index-Umhängen erst nach dem Gesamtcommit; bis dahin bleibt der
  // Move rückrollbar.
  let raw: { data: Record<string, unknown>; body: string; raw: string } | undefined;
  let updated: Record<string, unknown> = {};
  try {
    // Frontmatter im neuen Sidecar patchen — ein Move ändert Pfade, sonst
    // nichts. Der frühere Rebuild verlor dabei `related`, `related_via`,
    // `sensitivity`, `source` und eine gepflegte `confidence`.
    raw = await readSidecarRaw(moved.newSidecarPath);
    const rebuilt = buildFrontmatter({
      id: m.fm.id,
      title: m.fm.title,
      summary: m.fm.summary,
      tags: m.fm.tags,
      category:
        (fm as { document_category?: string }).document_category ?? "sonstiges",
      recallWhen: m.fm.recall_when,
      originalPath: moved.newOriginalPath,
      linkedFile: fm.linked_file ?? false,
      folderPath: args.folder_path,
      created: m.fm.created,
      updated: todayISO(),
      aliases: (raw.data.aliases as string[] | undefined) ?? fm.aliases,
      // #147: Capture-Flags überleben den Patch — Metadaten-Ops ändern nie die
      // Provenienz-Bewertung des Inhalts.
      injectionFlags:
        (raw.data.injection_flags as string[] | undefined) ?? fm.injection_flags,
    });
    updated = patchSidecarFrontmatter(
      raw.data,
      metadataPatch(raw.data, rebuilt),
    );
    // `move_document` kennt kein `force` — ein Ordnerwechsel ist nie der Ort,
    // an dem jemand eine fremde Bearbeitung bewusst wegwirft.
    await publishSidecar(moved.newSidecarPath, renderPatched(updated, raw.body), {
      id: m.fm.id,
      preimage: raw.raw,
    });
  } catch (err) {
    await abortMove(vault, moved, located.filePath, raw?.raw, err);
  }
  // #240/A3: drop the old path from the index before the new one is read —
  // otherwise both paths carry the same id and the next reconcile deletes
  // the moved document.
  if (moved.newSidecarPath !== located.filePath) vault.forgetFile(located.filePath);
  await vault.reindexFile(moved.newSidecarPath);

  // #452: siehe save_document. Das Pfadpaar steht im `reason` — der
  // Frontmatter-Diff allein zeigt nur `folder_path`/`original_path`.
  const auditWarning = await recordAudit({
    vaultRoot: vaultRoot(vault),
    memoryId: m.fm.id,
    operation: "update",
    actor: "assistant",
    actorDetail: "mcp:move_document",
    diffBefore: raw?.data ?? null,
    diffAfter: updated,
    filePath: moved.newSidecarPath,
    reason: `move_document: ${located.filePath} → ${moved.newSidecarPath}`,
  });

  const journalWarning = await acknowledgeCommittedJournal(moved.journal);

  return {
    id: m.fm.id,
    sidecar_path: moved.newSidecarPath,
    original_path: moved.newOriginalPath,
    reindexed: true,
    ...((auditWarning || journalWarning) ? { warning: [auditWarning, journalWarning].filter(Boolean).join("; ") } : {}),
  };
}

/**
 * Das Ergebnis eines Datei-Moves — inklusive der Möglichkeit, ihn wieder
 * zurückzunehmen.
 *
 * Codex-Gegenreview (P0): Der Move war endgültig, sobald die beiden `rename`
 * durch waren; scheiterte danach der Sidecar-Commit, blieb ein halber Zustand
 * zurück. Nachgestellt: alter Ordner leer, neuer Ordner mit Original und
 * Sidecar, das Frontmatter zeigte noch auf den alten Ordner, und im
 * Vault-Index fehlte das Dokument ganz (weil `forgetFile` schon gelaufen war).
 * Der Move bleibt deshalb bis zum geglückten Commit rückrollbar.
 */
export interface MovedDocumentFiles {
  newSidecarPath: string;
  newOriginalPath: string;
  /**
   * Nimmt den Move zurück. `expectedSidecar` sind die Bytes, die der Aufrufer
   * zuletzt am NEUEN Sidecar-Pfad gesehen hat; ohne Angabe gilt der Stand
   * unmittelbar nach dem Move.
   *
   * Der Vergleich ist kein Luxus: Scheitert der Commit gerade deshalb, weil
   * jemand von außen an den neuen Pfad geschrieben hat, würde ein blindes
   * Zurückbenennen genau diese fremde Bearbeitung mitschleifen — der Fix wäre
   * derselbe Datenverlust in grün.
   *
   * Codex-Gegenreview Runde 10 (P0-4): Verglichen wurde NUR der neue Sidecar.
   * Zwei Reproduktionen:
   *   A) Eine extern am ALTEN Originalpfad entstandene Datei wurde vom
   *      zurückgerollten Bastra-Original ersetzt und ging verloren — `rename`
   *      überschreibt.
   *   B) Der Original-Rollback scheiterte, sein Fehler wurde verschluckt, und
   *      `rollback()` meldete trotzdem `true`: Sidecar wieder im alten Ordner,
   *      Original weiterhin im neuen, Index auf dem alten Sidecar.
   * Deshalb ein Ergebnis PRO DATEI: `ok` nur, wenn Original UND Sidecar
   * verifiziert wieder am alten Ort liegen; sonst sagt `detail` pfadgenau, was
   * wo liegt.
   */
  rollback(expectedSidecar?: string | null): Promise<MoveRollbackResult>;
  /**
   * #378: Der Journal-Eintrag dieses Moves. Fehlt, wenn gar nichts zu bewegen
   * war (linked_file im selben Ordner) — dann gibt es auch keinen halben
   * Zustand, der einen Absturz überleben könnte.
   */
  journal?: RecoveryJournalHandle;
}

export interface MoveRollbackResult {
  /** Der Zustand von vor dem Move ist vollständig wiederhergestellt. */
  ok: boolean;
  /** Was NICHT zurückgenommen werden konnte — pfadgenau. */
  detail?: string;
}

/**
 * Eine Datei bewegen, ohne am Ziel etwas zu ersetzen.
 *
 * Codex-Gegenreview Runde 10 (P0-4): Die Zielprüfungen waren `pathExists` plus
 * ein späteres `rename` — ein zwischenzeitlich entstandenes Ziel wurde damit
 * still überschrieben, auf dem Hinweg wie auf dem Rückweg. `link()` schlägt
 * atomar mit EEXIST fehl; dasselbe Muster wie im Trash und im Save-Pfad.
 * Original und Sidecar liegen beide unter dem Dokumenten-Regal, also auf
 * einem Dateisystem — ein Hardlink ist dort immer möglich.
 */
async function moveExclusive(src: string, dest: string): Promise<void> {
  try {
    await link(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(`target already exists: ${dest}`);
    }
    throw err;
  }
  try {
    await unlink(src);
  } catch (err) {
    // Sonst existierten BEIDE Links — dieselbe Regel wie beim Trash.
    await unlink(dest).catch(() => {});
    throw err;
  }
}

/** Ist an diesem Pfad noch exakt die Datei, die wir dort hingelegt haben? */
function sameFileStat(a: Stats | null, b: Stats | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}

export async function moveDocumentFiles(
  vault: Vault,
  args: {
    /** #378: für den Journal-Eintrag — welcher Writer, welches Dokument. */
    op: string;
    id: string;
    sidecarPath: string;
    originalPath: string;
    currentFolderPath: string;
    newFolderPath: string;
    linkedFile: boolean;
  },
): Promise<MovedDocumentFiles> {
  const root = vaultRoot(vault);
  const docsRoot = join(root, DOCUMENTS_ROOT);
  const targetFolder = resolveDocsFolder(root, docsRoot, args.newFolderPath);
  await ensureVaultDir(root, targetFolder);

  const sidecarFilename = basename(args.sidecarPath);
  const originalFilename = basename(args.originalPath);

  const newSidecarPath = join(targetFolder, sidecarFilename);
  const newOriginalPath = args.linkedFile
    ? args.originalPath
    : join(targetFolder, originalFilename);

  // #240/A5.3: BEIDE Ziele prüfen, bevor das erste umbenannt wird. Vorher
  // wanderte das Original erfolgreich ans Ziel und erst danach kollidierte
  // der Sidecar — Ergebnis war ein gemeldeter Fehler bei halb ausgeführtem
  // Move: Original im Zielordner, Sidecar in der Quelle, Frontmatter und
  // Platte widersprachen sich.
  const movesOriginal =
    !args.linkedFile && newOriginalPath !== args.originalPath;
  const movesSidecar = newSidecarPath !== args.sidecarPath;
  if (movesOriginal && (await pathExists(newOriginalPath))) {
    throw new Error(`target original already exists: ${newOriginalPath}`);
  }
  if (movesSidecar && (await pathExists(newSidecarPath))) {
    throw new Error(`target sidecar already exists: ${newSidecarPath}`);
  }

  // #378: VOR dem ersten Move steht auf der Platte, was gleich passiert. Der
  // Rollback unten deckt jeden Fehler ab, den dieser Prozess noch erlebt — ein
  // Absturz dazwischen aber nicht, und danach schaut nichts mehr hin. Nur wenn
  // wirklich etwas bewegt wird: sonst gibt es keinen halben Zustand.
  const journal =
    movesOriginal || movesSidecar
      ? await openRecoveryJournal(root, {
          op: args.op,
          id: args.id,
          steps: [
            ...(movesOriginal ? [{ from: args.originalPath, to: newOriginalPath }] : []),
            ...(movesSidecar ? [{ from: args.sidecarPath, to: newSidecarPath }] : []),
          ],
        })
      : undefined;

  if (movesOriginal) {
    try {
      await moveExclusive(args.originalPath, newOriginalPath);
    } catch (err) {
      // `moveExclusive` räumt seinen eigenen Halbzustand auf — es ist nichts
      // bewegt worden, also gibt es auch nichts zu berichten.
      await journal?.acknowledge();
      throw err;
    }
  }
  if (movesSidecar) {
    try {
      await moveExclusive(args.sidecarPath, newSidecarPath);
    } catch (err) {
      // Der Sidecar-Move ist der zweite Schritt: schlägt er fehl (ENOSPC,
      // EACCES, Cloud-Mount-Stall), das Original zurückrollen, damit kein
      // Split-State zurückbleibt. Scheitert AUCH das, wird es gesagt — vorher
      // verschluckte ein `.catch(() => {})` genau diesen Fall.
      if (movesOriginal) {
        try {
          await moveExclusive(newOriginalPath, args.originalPath);
        } catch (undoErr) {
          // Halber Zustand, und er bleibt es: der Journal-Eintrag wird NICHT
          // quittiert, damit der nächste Start ihn benennt.
          throw new Error(
            `${(err as Error).message} — AND the original could not be moved back: ` +
              `it is at ${newOriginalPath} instead of ${args.originalPath} ` +
              `(${(undoErr as Error).message}).`,
          );
        }
      }
      await journal?.acknowledge();
      throw err;
    }
  }

  // Die Identität direkt nach dem Move: Wer später zurückrollt, muss beweisen
  // können, dass am neuen Pfad noch UNSERE Datei liegt.
  const publishedOriginal = movesOriginal ? await stat(newOriginalPath).catch(() => null) : null;

  // Der Stand direkt nach dem Move — die Erwartung für einen Rollback, dessen
  // Aufrufer gar nicht mehr zum Lesen gekommen ist (ein Fehler zwischen Move
  // und Sidecar-Read). Ein Read auf eine kleine Datei; ohne ihn müsste ein
  // solcher Fehlschlag den Halbzustand stehen lassen.
  let movedBytes: string | null = null;
  if (movesSidecar) {
    try {
      movedBytes = await readTargetRaw(newSidecarPath);
    } catch (err) {
      // Codex-Gegenreview Runde 10 (P0-4): Schlug dieser Read fehl, war
      // bereits verschoben — der Caller bekam aber nie eine Rollback-Funktion
      // und blieb auf dem Halbzustand sitzen. Also hier selbst zurücknehmen.
      const undo: string[] = [];
      try {
        await moveExclusive(newSidecarPath, args.sidecarPath);
      } catch (e) {
        undo.push(`${newSidecarPath} (should be ${args.sidecarPath}): ${(e as Error).message}`);
      }
      if (movesOriginal) {
        try {
          await moveExclusive(newOriginalPath, args.originalPath);
        } catch (e) {
          undo.push(`${newOriginalPath} (should be ${args.originalPath}): ${(e as Error).message}`);
        }
      }
      // Nur der vollständig zurückgenommene Move ist quittierbar.
      if (undo.length === 0) await journal?.acknowledge();
      throw new Error(
        `the moved sidecar could not be read back (${(err as Error).message})` +
          (undo.length > 0
            ? ` AND the move could not be undone. Fix by hand: ${undo.join("; ")}.`
            : ` — the move was undone, nothing was changed.`),
      );
    }
  }

  const rollback = async (
    expectedSidecar: string | null = movedBytes,
  ): Promise<MoveRollbackResult> => {
    const problems: string[] = [];
    if (movesSidecar) {
      // Nur zurückrollen, was auch noch unser Sidecar ist — sonst schleift der
      // Rollback eine fremde Bearbeitung an den alten Pfad.
      const current = await readTargetRaw(newSidecarPath).catch(() => undefined);
      if (current !== expectedSidecar) {
        return {
          ok: false,
          detail:
            `${newSidecarPath} was written by someone else after the move — nothing was ` +
            `rolled back, both files stay in the new folder.`,
        };
      }
      try {
        await moveExclusive(newSidecarPath, args.sidecarPath);
      } catch (e) {
        problems.push(
          `${newSidecarPath} could not go back to ${args.sidecarPath} (${(e as Error).message})`,
        );
      }
    }
    if (movesOriginal) {
      // Dieselbe Frage fürs Original — sie fehlte ganz, und deshalb ersetzte
      // der Rollback eine extern am alten Pfad entstandene Datei.
      if (!sameFileStat(publishedOriginal, await stat(newOriginalPath).catch(() => null))) {
        problems.push(
          `${newOriginalPath} was changed by someone else after the move — it was left there`,
        );
      } else {
        try {
          await moveExclusive(newOriginalPath, args.originalPath);
        } catch (e) {
          problems.push(
            `${newOriginalPath} could not go back to ${args.originalPath} (${(e as Error).message})`,
          );
        }
      }
    }
    if (problems.length > 0) return { ok: false, detail: problems.join("; ") };
    // #378: Der Zustand von vor dem Move steht wieder — also ist die Operation
    // zu Ende und der Eintrag quittierbar. Genau der andere Ausgang ist der,
    // um den es geht: Blieb etwas liegen, bleibt der Eintrag offen.
    await journal?.acknowledge();
    return { ok: true };
  };

  return { newSidecarPath, newOriginalPath, rollback, journal };
}
