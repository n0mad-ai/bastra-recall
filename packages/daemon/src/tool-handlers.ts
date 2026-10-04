/**
 * Tool-Handler — pure logic, transport-agnostic.
 *
 * Jeder Handler nimmt {deps, args} und liefert ein plain JSON-Objekt zurück
 * (oder wirft Error mit Message). Wrapping ist Aufgabe der Caller:
 *   - index.ts wrappt für MCP-stdio (content/isError)
 *   - http.ts wrappt für REST (status code + JSON body)
 *
 * Damit teilen sich beide Pfade dieselbe Validierung, Telemetry und
 * Vault-Mutation — kein doppelter Code, kein Drift.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  mutateMemoryFile,
  withIdClaim,
  moveToTrashUnderClaim,
  SaveMemoryInput,
} from "@bastra-recall/core";
import { recordAudit } from "./audit-trail.js";

import type { ToolDeps } from "./tool-deps.js";
import { hiddenFromCaller, hiddenOnDisk, type PrivateAccess } from "./private-access.js";
import type { SaveQualityResult } from "./save-quality.js";
import { MEMORY_TOOL_DEFS } from "./tool-defs-memory.js";

// Re-exported so the 18 existing importers keep their import path.
export type { ToolDeps };
export type { SaveQualityResult };
export { MEMORY_TOOL_DEFS };

// ─── Zod-Schemas ────────────────────────────────────────────────

// ─── Recall — lives in recall-handler.ts (file-size split), re-exported ───
export {
  RecallArgs,
  recallHandler,
  toLeanHit,
  truncateSummary,
} from "./recall-handler.js";
export type { RecallResult, RecallStageTimings } from "./recall-handler.js";


// ─── Load Memory — lives in load-memory-handler.ts (#680 split), re-exported ───
export {
  LoadMemoryArgs,
  leanFrontmatter,
  loadMemoryHandler,
  distinctiveTokensForActedOn,
} from "./load-memory-handler.js";
export type { LoadMemoryResult } from "./load-memory-handler.js";

// ─── Save Memory — lives in save-memory-handler.ts (#680 split), re-exported ───
export {
  SAVE_FAILURE_CAP,
  SAVE_FAILURE_WINDOW_MS,
  noteSaveFailure,
  resetSaveFailures,
  saveMemoryHandler,
} from "./save-memory-handler.js";
export type { SaveMemoryResult } from "./save-memory-handler.js";


export { SaveMemoryInput };


// ─── archive_memory (#217 Intake-Adoption) ──────────────────────

export const ArchiveMemoryArgs = z.object({
  id: z.string().min(1),
  superseded_by: z.string().optional(),
});

/**
 * Archiviert ein Memory in den Vault-Trash (recoverable, nie rm) — das
 * Abschluss-Primitiv der Intake-Adoption: nachdem ein importiertes Memory
 * ins Vollformat überführt wurde (neues Memory mit `source: migrated:…`),
 * räumt archive_memory das Original aus dem lebenden Vault. Gleiche
 * Trash-Mechanik wie das Re-Filing im Save-Pfad (moveToTrash + forgetFile).
 * `superseded_by` wird best-effort in die Trash-Kopie gestempelt, damit der
 * Trash-Ordner beim späteren Audit pro Datei zeigt, wohin adoptiert wurde.
 */
export async function archiveMemoryHandler(
  deps: ToolDeps,
  args: Record<string, unknown>,
  /** #464: transportgebunden — siehe private-access.ts. */
  access?: PrivateAccess,
): Promise<{ id: string; archived_to: string; superseded_by: string | null }> {
  const parsed = ArchiveMemoryArgs.safeParse(args);
  if (!parsed.success) {
    throw new Error(`invalid archive_memory args: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  const { id, superseded_by } = parsed.data;
  const mem = deps.vault.get(id);
  if (!mem) {
    throw new Error(`unknown memory: ${id} — archive_memory only archives memories that exist in the vault.`);
  }
  // #464: Der Lesepfad (`loadMemoryHandler`) verbirgt Private-Memories vor
  // externen Callern, der Archivpfad tat es nicht — ein Caller konnte
  // entfernen, was er nicht sehen durfte, und lernte aus dem Erfolg sogar,
  // dass die Id existiert. Dieselbe Antwort wie beim Lesen: als gäbe es
  // die Id nicht. Die Erlaubnis kommt vom Transport, nicht aus `args`.
  if (hiddenFromCaller(access, mem.fm)) {
    throw new Error(`unknown memory: ${id} — archive_memory only archives memories that exist in the vault.`);
  }
  // Codex-Gegenreview (P0): Verschoben wurde der Pfad aus dem CACHE, ohne ihn
  // noch einmal anzusehen. War die Datei extern durch etwas anderes ersetzt
  // worden, wanderte diese fremde Datei in den Trash — und das Archiv
  // behauptete, es sei dieses Memory gewesen. Archivieren ist eine
  // besitzverändernde Operation und gehört unter denselben Claim wie ein
  // Schreiben, mit derselben autoritativen Auskunft.
  const { archivedTo, originalPath, diffBefore } = await withIdClaim(
    { vaultRoot: deps.vaultPath, id, filePath: mem.filePath, op: "archive" },
    async (claim) => {
      const located = await claim.locate();
      if (located.kind !== "unique") {
        throw new Error(
          located.kind === "none"
            ? `cannot archive "${id}": no file on disk holds it (the index is stale).`
            : `cannot archive "${id}": the vault scan is not conclusive (${located.kind}) — ` +
              `fix that first, archiving now would move the wrong file.`,
        );
      }
      // #464 (wiedereröffnet): Die Sensitivitätsprüfung oben fragte den INDEX.
      // Trägt die Datei auf der PLATTE `sensitivity: private` — extern gesetzt,
      // vom Watcher auf einem Cloud-Mount nie gemeldet —, verschob das Archiv
      // sie samt Inhalt in den Trash (5 von 5 Läufen im Gegenreview). Also
      // dieselbe Frage an die Bytes, unter demselben Claim, VOR jeder Bewegung.
      //
      // Der Read hier ist kein zweiter Read neben der Bewegung: `preimage`
      // bindet ihn an die Fassung, die `moveToTrashUnderClaim` gleich liest —
      // weicht sie ab, wird gar nichts verschoben.
      const preimage = await readFile(located.filePath, "utf8");
      if (hiddenOnDisk(access, preimage)) {
        throw new Error(
          `unknown memory: ${id} — archive_memory only archives memories that exist in the vault.`,
        );
      }
      // Codex-Gegenreview Runde 10 (P1-4): Hier stand ein eigener Read, dessen
      // Ergebnis als `diff_before` ins Ledger ging — ohne Bindung an die
      // Fassung, die gleich danach wegwanderte. Beweis und Bewegung kommen
      // jetzt aus EINEM Read in der Trash-Primitive selbst.
      const { trashPath: to, frontmatter: onDisk } = await moveToTrashUnderClaim(
        deps.vaultPath,
        located.filePath,
        claim,
        preimage,
      );
      deps.vault.forgetFile(located.filePath);
      if (superseded_by) {
        try {
          // `expectedId: null` — die Datei liegt im Trash und ist per
          // Definition kein indexiertes Memory mehr; geprüft wird nur, dass
          // niemand sie zwischen Lesen und Schreiben angefasst hat.
          await mutateMemoryFile(to, null, {
            frontmatter: (fm) => ({ ...fm, obsolete: true, superseded_by }),
          });
        } catch {
          /* Audit-Stempel ist best-effort — das Archiv selbst steht bereits. */
        }
      }
      return { archivedTo: to, originalPath: located.filePath, diffBefore: onDisk };
    },
  );
  // #206: archiving is the one operation that takes a memory out of the active
  // index, so it is the one that most needs a record. `diff_before` keeps the
  // frontmatter as it was — the trash file is recoverable, but the log is what
  // says WHEN and through which run it left.
  const auditWarning = await recordAudit({
    vaultRoot: deps.vaultPath,
    memoryId: id,
    operation: "delete",
    actor: "assistant",
    actorDetail: "mcp:archive_memory",
    diffBefore: diffBefore ?? { ...mem.fm },
    diffAfter: null,
    filePath: originalPath,
    ...(superseded_by ? { reason: `superseded by ${superseded_by}` } : {}),
    sessionId: deps.telemetry.runId(),
  });
  return {
    id,
    archived_to: archivedTo,
    superseded_by: superseded_by ?? null,
    // #380: Ein Archivieren ohne Beleg ist der Fall, der am meisten wehtut —
    // das Memory ist aus dem aktiven Index, und das Log sollte sagen, wann.
    ...(auditWarning ? { warning: auditWarning } : {}),
  };
}

// ─── MCP Tool-Definitionen ───────────────────────────────────────
// Single source of truth für die MCP-Tool-Liste (recall/load_memory/
// save_memory). Sowohl der embedded MCP-Server in index.ts als auch
// der HTTP-Forwarder mcp-forwarder.ts importieren das hier, damit Schema
// und Description nicht aus dem Sync geraten.
