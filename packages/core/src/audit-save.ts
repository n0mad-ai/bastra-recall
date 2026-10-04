import { z } from "zod";
import { saveMemory } from "./save.js";
import type { SaveMemoryInput, SaveMemoryResult } from "./save-schema.js";
import {
  AuditLog,
  type AuditEntry,
  moveToTrashUnderClaim,
  restoreFromTrashUnderClaim,
  latestTrashPathFor,
} from "./audit-log.js";
import type { Vault } from "./vault.js";
import { assertInsideVault, sameFile } from "./file-identity.js";
import type { Located, MemoryLocator } from "./memory-locator.js";
import { access, readFile, rename } from "node:fs/promises";
import matter from "gray-matter";
import { occupantOfRaw, readOccupant } from "./memory-locator.js";
import { withIdClaim, type IdClaim } from "./id-transaction.js";
import { newOperationId, reportMutationIncident } from "./mutation-incident.js";

/**
 * Audit-Kontext, den jeder Caller (bridge.ts, index.ts) mitgibt — beschreibt
 * WER die Mutation veranlasst hat. Wird im Audit-Log gespeichert, geht aber
 * NICHT in die Memory-Frontmatter (saubere Trennung CRUD ↔ Audit).
 */
export const AuditContext = z.object({
  actor: z.enum(["user", "assistant", "system", "import"]),
  actor_detail: z.string().optional(),
  reason: z.string().optional(),
  session_id: z.string().optional(),
});
export type AuditContext = z.infer<typeof AuditContext>;

/**
 * Save mit Audit-Trail.
 *
 *   1. Vorherige Memory-Frontmatter von der PLATTE holen (für diff_before).
 *   2. Validation: Assistant-Mutationen brauchen `reason` (1-2 Sätze).
 *   3. saveMemory ausführen.
 *   4. AuditLog.record() mit before/after.
 */
export async function auditedSave(args: {
  vault: Vault;
  auditLog: AuditLog;
  vaultRoot: string;
  input: SaveMemoryInput;
  context: AuditContext;
}): Promise<{ result: SaveMemoryResult; audit: AuditEntry | null; audit_warning?: string }> {
  const { vault, auditLog, vaultRoot, input, context } = args;

  if (context.actor === "assistant" && !context.reason?.trim()) {
    throw new Error(
      "assistant mutations require a `reason` (1-2 sentences explaining the change).",
    );
  }

  // Den Locator des Vaults mitgeben, sonst scannt `saveMemory` das
  // Dateisystem, obwohl der Index in der Hand liegt — und sieht `ambiguous`
  // nicht, das nur der Vault kennt.
  const locator = vaultAsLocator(vault);

  // Codex-Gegenreview (P1): Hier stand ein eigener, vaultweiter Scan plus ein
  // Read, um das Vorbild fürs Audit zu bilden — VOR dem Claim, mit
  // `expectedTarget` als nachträglichem Riegel, und beim Re-Filing mit einem
  // ausdrücklich offen gelassenen Restfenster auf die Quelldatei. All das
  // löst sich auf, seit die Mutation ihr unter dem Claim gelesenes Vorbild
  // selbst zurückgibt: Es ist per Konstruktion die Datei, die gepatcht wurde,
  // es kostet keinen zweiten Vaultscan, und es braucht keinen Riegel mehr,
  // weil zwischen Lesen und Schreiben nichts mehr liegt.
  const result = await saveMemory(vaultRoot, input, { locator });
  const diffBefore = result.audit_before;

  // Das Re-Filing selbst erledigt `saveMemory` unter der ID-Transaktion —
  // hier bleibt nur, den Index nachzuziehen. Vorher stand das Aufräumen hier
  // (und noch einmal in `tool-handlers.ts`), also NACH der Freigabe des Locks:
  // ein Absturz dazwischen hinterließ zwei aktive Dateien mit einer id.
  if (result.refiled_from !== undefined) {
    vault.forgetFile(result.refiled_from);
  }

  // diff_after ebenfalls aus der Mutation: Ein Read des Zielpfads danach
  // beschreibt nicht mehr zwingend DIESEN Schreibvorgang — er sieht auch, was
  // ein Writer nach der Freigabe des Claims dort hingeschrieben hat.
  const diffAfter = result.audit_after;

  const recorded = await recordOrWarn(auditLog, {
    memory_id: result.id,
    actor: context.actor,
    actor_detail: context.actor_detail,
    // Ground truth statt Vorab-Lookup: saveMemory prüft die Existenz am
    // tatsächlichen Zielpfad und meldet sie in `created` zurück.
    operation: result.created ? "create" : "update",
    diff_before: diffBefore,
    diff_after: diffAfter,
    file_path: result.file_path,
    reason: context.reason,
    session_id: context.session_id,
  });

  return { result, ...recorded };
}

/**
 * Soft-Delete mit Audit-Trail.
 *
 *   1. Memory im Vault-Cache nachschlagen (nur als Pfad-Hinweis für den Claim).
 *   2. File nach <vault>/.bastra/trash/<id>.md verschieben.
 *   3. AuditLog.record() mit operation=delete.
 *
 * Hard-Delete (Forget-Tool, Block 2) hat einen eigenen Pfad und sollte den
 * Trash-Folder umgehen.
 */
export async function auditedSoftDelete(args: {
  vault: Vault;
  auditLog: AuditLog;
  vaultRoot: string;
  memoryID: string;
  context: AuditContext;
}): Promise<{ id: string; trashPath: string; audit: AuditEntry | null; audit_warning?: string }> {
  const { vault, auditLog, vaultRoot, memoryID, context } = args;

  const memory = vault.get(memoryID);
  if (!memory) {
    throw new Error(`memory not found in vault: ${memoryID}`);
  }
  if (context.actor === "assistant" && !context.reason?.trim()) {
    throw new Error(
      "assistant deletes require a `reason` (1-2 sentences explaining the change).",
    );
  }

  // Codex-Gegenreview (P0): Gelöscht wurde der Pfad, den der CACHE nannte, ohne
  // ihn noch einmal anzusehen. Nachgestellt: Der Vault lädt `x`, die Datei wird
  // extern durch eine gewöhnliche Notiz ersetzt, `auditedSoftDelete("x")`
  // verschiebt die fremde Notiz in den Trash — und das Audit behauptet, Memory
  // `x` sei gelöscht worden. Ein Löschen ist eine besitzverändernde Operation,
  // also gehört es unter denselben Claim wie ein Schreiben, mit derselben
  // autoritativen Auskunft.
  return withIdClaim(
    { vaultRoot, id: memoryID, filePath: memory.filePath, op: "soft_delete" },
    async (claim) => {
      const located = await claim.locate();
      if (located.kind !== "unique") {
        throw new Error(
          located.kind === "none"
            ? `cannot delete "${memoryID}": no file on disk holds it (the index is stale).`
            : `cannot delete "${memoryID}": the vault scan is not conclusive (${located.kind}) — ` +
              `fix that first, deleting now would move the wrong file.`,
        );
      }
      // Codex-Gegenreview Runde 10 (P1-4): Hier stand ein EIGENER Read, dessen
      // Ergebnis danach als `diff_before` ins Ledger ging — ohne jede Bindung
      // an die Fassung, die `moveToTrashUnderClaim` gleich verschob. Zwischen
      // beiden konnte eine externe Änderung eintreffen: verschoben wurde die
      // neue Fassung, protokolliert die alte. Das Vorbild kommt deshalb aus der
      // Trash-Primitive selbst, gelesen aus genau den Bytes, die gewandert
      // sind.
      return commitSoftDelete({
        vault,
        auditLog,
        vaultRoot,
        memoryID,
        claim,
        originalPath: located.filePath,
        context,
      });
    },
  );
}

/** Der schreibende Teil des Löschens — unter dem Claim, auf dem autoritativ
 *  ermittelten Pfad. */
async function commitSoftDelete(a: {
  vault: Vault;
  auditLog: AuditLog;
  vaultRoot: string;
  memoryID: string;
  /** Der Anspruch, unter dem der Pfad ermittelt wurde — `moveToTrashUnderClaim`
   *  nimmt ihn entgegen, damit niemand ohne Transaktion trashen kann. */
  claim: IdClaim;
  originalPath: string;
  context: AuditContext;
}): Promise<{ id: string; trashPath: string; audit: AuditEntry | null; audit_warning?: string }> {
  const { vault, auditLog, vaultRoot, memoryID, claim, originalPath, context } = a;
  const { trashPath, frontmatter: diffBefore } = await moveToTrashUnderClaim(
    vaultRoot,
    originalPath,
    claim,
  );
  // Codex-Befund 5: Die Datei war weg, der Index-Eintrag blieb. Auf einem
  // Cloud-Mount pollt der Watcher (Intervall 1500ms) und bekommt den unlink
  // eines Provider-Mounts oft überhaupt nicht mit — bis zum nächsten Reconcile
  // oder Neustart lieferte der Recall damit ein Memory aus, das auf der Platte
  // schon im Trash lag. Weder der Bridge- noch der MCP-Pfad räumte auf; die
  // Eviction gehört deshalb hierher, in die Mutation selbst.
  vault.forgetFile(originalPath);

  const recorded = await recordOrWarn(auditLog, {
    memory_id: memoryID,
    actor: context.actor,
    actor_detail: context.actor_detail,
    operation: "delete",
    diff_before: diffBefore,
    diff_after: null,
    file_path: originalPath, // Wohin der Restore zurückmoven soll.
    reason: context.reason,
    session_id: context.session_id,
  });

  return { id: memoryID, trashPath, ...recorded };
}

/**
 * Restore aus dem Trash.
 *
 *   1. Letzten `delete`-Audit-Eintrag der Memory finden.
 *   2. Trash-File ermitteln.
 *   3. Original-Pfad rekonstruieren aus diff_before.
 *   4. File zurückmoven.
 *   5. Audit-Eintrag operation=restore mit diff_before=null/diff_after=alt.
 */
export async function auditedRestore(args: {
  auditLog: AuditLog;
  vaultRoot: string;
  memoryID: string;
  /** Optional: bestimmten Original-Pfad erzwingen (Power-User). */
  destFilePath?: string;
  /** Nur noch für Aufrufer, die den Index danach selbst auffrischen wollen —
   *  die BESITZPRÜFUNG hängt nicht mehr daran. Codex-Gegenreview (P0): Fehlte
   *  der Vault, wurde sie vollständig übersprungen, und ein Restore legte
   *  neben einem inzwischen wieder aktiven Memory derselben id eine zweite
   *  Datei an. Ein optionaler Sicherheitsgurt ist kein Sicherheitsgurt. */
  vault?: Vault;
  context: AuditContext;
}): Promise<{ id: string; restoredTo: string; audit: AuditEntry | null; audit_warning?: string }> {
  const { auditLog, vaultRoot, memoryID, destFilePath, context } = args;

  const lastDelete = await auditLog.lastDeleteFor(memoryID);
  if (!lastDelete) {
    throw new Error(`no delete audit-entry found for memory: ${memoryID}`);
  }

  // Neueste Fassung, nicht den Basis-Pfad: seit #240/A4 versioniert
  // moveToTrash, damit ein zweites Löschen die erste Trash-Version nicht
  // still überschreibt — `<id>.md` ist dann die älteste, nicht die jüngste.
  const trashFile = await latestTrashPathFor(vaultRoot, memoryID);
  if (!trashFile || !(await fileExists(trashFile))) {
    throw new Error(`trashed file missing for memory: ${memoryID}`);
  }

  // Zielpfad: vom Caller bevorzugt, sonst aus dem letzten Delete-Audit-Eintrag.
  const dest = destFilePath ?? lastDelete.file_path;
  if (!dest) {
    throw new Error(
      `restore needs an explicit destFilePath — the original path is missing in the audit-log.`,
    );
  }

  // Codex-Befund 6a: `destFilePath` kam ungeprüft vom Caller — ein Restore in
  // ein Geschwisterverzeichnis NEBEN dem Vault funktionierte. Geprüft wird
  // über realpath, nicht über den Textpfad: Cloud-Mounts liegen im Vault
  // regelmäßig als Symlink, und `~/vault/elsewhere/x.md` kann irgendwo hin
  // zeigen, während der String brav mit dem Vault-Pfad beginnt.
  assertInsideVault(vaultRoot, dest, "restore");

  // Ab hier unter der ID-Transaktion: Besitzprüfung und Veröffentlichung
  // sehen denselben Vault, und kein anderer Writer kann die id dazwischen
  // belegen.
  return withIdClaim({ vaultRoot, id: memoryID, filePath: dest, op: "restore" }, async (claim) => {
    // Codex-Gegenreview: Geprüft wurde nur der ZIELPFAD, und die Frage „lebt
    // diese id inzwischen woanders?" hing an einem optionalen Index. Beides
    // ersetzt der autoritative Plattenscan unter dem Lock: Ein prozessübergreifend
    // veralteter Index konnte `none` melden, während die id längst wieder lebte.
    const located = await claim.locate();
    if (located.kind === "incomplete") {
      throw new Error(
        `cannot restore "${memoryID}": the vault scan could not read ` +
          `${located.unreadable.join(", ")} — restoring now could create a second file ` +
          `with the same id. Fix the permissions first.`,
      );
    }
    const live = located.kind === "unique"
      ? [located.filePath]
      : located.kind === "ambiguous"
        ? located.filePaths
        : [];
    const stillElsewhere = live.filter((p) => !sameFile(p, dest));
    if (stillElsewhere.length > 0) {
      throw new Error(
        `cannot restore "${memoryID}": it is already live at ${stillElsewhere.join(", ")}. ` +
          `Restoring would put a second file with the same id into the vault — archive or move ` +
          `the existing one first, or restore to that exact path to replace it.`,
      );
    }

    return publishRestore({ auditLog, vaultRoot, memoryID, claim, trashFile, dest, lastDelete, context });
  });
}

/** Der Teil des Restores, der schreibt — abgetrennt, damit die Prüfungen oben
 *  lesbar bleiben und der Rumpf vollständig unter dem Claim steht. */
async function publishRestore(a: {
  auditLog: AuditLog;
  vaultRoot: string;
  memoryID: string;
  claim: IdClaim;
  trashFile: string;
  dest: string;
  lastDelete: AuditEntry;
  context: AuditContext;
}): Promise<{ id: string; restoredTo: string; audit: AuditEntry | null; audit_warning?: string }> {
  const { auditLog, vaultRoot, memoryID, claim, trashFile, dest, lastDelete, context } = a;
  await restoreFromTrashUnderClaim(vaultRoot, trashFile, dest, claim);

  // Codex-Befund 6b: Was zurückkam, wurde nie gegen die angeforderte id
  // geprüft. Ein von Hand angefasster oder per Sync-Konflikt ersetzter
  // Trash-Stand landete damit unter fremdem Namen am Originalpfad — und der
  // Reindex direkt danach hätte ihn als diese Memory in den Index gehoben.
  // EIN Read für Identitätsprüfung UND Audit-Nachbild. Codex-Gegenreview
  // Runde 10 (P1-2): `diff_after` kam aus `lastDelete.diff_before`, also aus
  // dem Zustand VOR dem Löschen. Wurde die Trash-Fassung dazwischen verändert
  // (von Hand, per Sync-Konflikt, durch den Archiv-Stempel), protokollierte
  // das Audit eine Fassung, die so nie wiederhergestellt wurde —
  // nachgestellt: tatsächlich `externally-edited-trash`, im Ledger
  // `original-summary`. Ein Beleg beschreibt, was auf der Platte steht.
  const restoredRaw = await readFile(dest, "utf8").catch(() => null);
  const occupant = restoredRaw === null ? readOccupant(dest) : occupantOfRaw(restoredRaw, dest);
  if (occupant.kind !== "memory" || occupant.id !== memoryID) {
    // Zurückrollen, statt die falsche Datei im Vault liegen zu lassen.
    await rename(dest, trashFile).catch(() => {});
    const found = occupant.kind === "memory" ? `"${occupant.id}"` : "no memory at all";
    throw new Error(
      `the trashed file for "${memoryID}" does not hold memory "${memoryID}" (found ${found}) — ` +
        `restore aborted, the trash file is untouched.`,
    );
  }

  const recorded = await recordOrWarn(auditLog, {
    memory_id: memoryID,
    actor: context.actor,
    actor_detail: context.actor_detail,
    operation: "restore",
    diff_before: null,
    // Fällt der Read aus, ist der Stand aus dem Delete-Eintrag die schwächere,
    // aber einzige verfügbare Auskunft — dann steht er ausdrücklich als
    // degradierter Beleg im Ledger, nicht als exaktes Nachbild.
    diff_after:
      restoredRaw !== null
        ? cloneFrontmatter(matter(restoredRaw).data)
        : { ...(lastDelete.diff_before ?? {}), evidence_quality: "degraded" },
    file_path: dest,
    reason: context.reason,
    session_id: context.session_id,
  });

  return { id: memoryID, restoredTo: dest, ...recorded };
}

// ─── helpers ────────────────────────────────────────────────────

/**
 * Den Audit-Eintrag anhängen — und ihn NIE die bereits committete Mutation
 * zurückweisen lassen.
 *
 * Codex-Gegenreview Runde 10 (P1-3): Das Append steht nach dem dauerhaften
 * Save, dem Trash-Move und dem Restore. Nachgestellt: `auditedSave` warf
 * `AUDIT-IO-FAIL`, während die Memory-Datei vollständig auf der Platte lag —
 * ein Aufrufer, der auf den Fehler hin wiederholt, wiederholt eine Mutation,
 * die schon stattgefunden hat. Die Mutation gilt deshalb als gelungen, und der
 * fehlende Beleg wird als `audit_warning` gemeldet.
 *
 * Was das NICHT ist: eine Garantie, dass jede Mutation einen Beleg bekommt.
 * Dafür bräuchte es einen Write-ahead-Eintrag VOR dem Commit (Outbox/Journal),
 * der nach dem Commit quittiert wird. Bis dahin ist die ehrliche Aussage
 * „committed, aber unprotokolliert" besser als ein Fehler, der zum
 * Doppelschreiben einlädt.
 */
async function recordOrWarn(
  auditLog: AuditLog,
  entry: Parameters<AuditLog["record"]>[0],
): Promise<{ audit: AuditEntry | null; audit_warning?: string }> {
  try {
    return { audit: await auditLog.record(entry) };
  } catch (err) {
    // #377: Der Fall, den vorher NIEMAND sah. `audit_warning` erreicht nur den
    // Aufrufer — und auf dem MCP- und REST-Pfad nicht einmal den (#380). Ein
    // Incident macht daraus eine Spur, die zwei Wochen später noch da ist.
    // Die Fehlermeldung selbst geht NICHT ins Event: sie trägt regelmäßig den
    // Pfad des Ledgers.
    reportMutationIncident({
      operation_id: newOperationId(),
      op: `audit_${entry.operation}`,
      status: "audit_failed",
      phase: "audit",
      memory_id: entry.memory_id,
      detail: (err as NodeJS.ErrnoException)?.code ?? "append failed",
    });
    return {
      audit: null,
      audit_warning:
        `the ${entry.operation} was committed, but the audit entry could not be written ` +
        `(${(err as Error).message}) — do NOT retry the operation; it already happened.`,
    };
  }
}



function cloneFrontmatter(fm: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fm)) as Record<string, unknown>;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Der Vault als {@link MemoryLocator} — inklusive der Dateien, die er wegen
 *  derselben id quarantäniert hat. `get()` allein verschweigt sie, und ein
 *  Save auf die eine ließe die andere unverändert stehen (#240/A2.3). */
function vaultAsLocator(vault: Vault): MemoryLocator {
  return {
    locate(id: string): Located {
      const paths = vault.pathsFor(id);
      if (paths.length === 0) return { kind: "none" };
      if (paths.length === 1) return { kind: "unique", filePath: paths[0] };
      return { kind: "ambiguous", filePaths: paths };
    },
  };
}

