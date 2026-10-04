/**
 * Document-Hub WRITE Tools — `save_document`/`recategorize_document`/
 * `move_document`. Triage Issue #24:
 *
 * - Pro-Feature: Triage will diese hinter Lizenz-Gate. Bis das Pro-License-
 *   Service da ist (separates Issue), gaten wir mit env-Flag
 *   `BASTRA_DOCUMENT_WRITE=1` (Legacy: `NEXUS_DOCUMENT_WRITE`). Tool-Liste
 *   wird komplett ausgeblendet wenn das Flag fehlt — externe MCP-Caller
 *   sehen nur Read-Tools.
 *
 * - Cloud-Watcher-Mitigation: Schreib-Pfad reagiert NICHT auf chokidar
 *   (unzuverlässig auf GoogleDrive/iCloud). Stattdessen sofortiger
 *   `vault.reindexFile(sidecarPath)` nach jedem Write — analog zum
 *   `save_memory`-Pattern. Damit ist `save+find im selben Turn` zuverlässig.
 *   Triage-Acceptance: erfüllt.
 */
import {
  stat,
} from "node:fs/promises";
import { z } from "zod";
import type { Vault } from "@bastra-recall/core";

// ─── Argument schemas ───────────────────────────────────────────

const documentCategoryEnum = z.enum([
  "vertrag",
  "rechnung",
  "notiz",
  "code",
  "bild",
  "sonstiges",
]);

export const SaveDocumentArgs = z.object({
  /** Absoluter Pfad der Original-Datei (z.B. ~/Downloads/Vertrag.pdf). */
  original_path: z.string().min(1),
  /** Folder relativ zu `<vault>/documents/`. Leer-String = Root. */
  folder_path: z.string().default(""),
  title: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  category: documentCategoryEnum,
  /**
   * Wenn true bleibt die Originaldatei am Quellort, das Sidecar trägt nur
   * den Verweis. Default false: Datei wird in `<vault>/documents/<folder>`
   * kopiert.
   */
  linked_file: z.boolean().default(false),
  /** Optional: extrahierter Plain-Text-Body des Sidecars. */
  body: z.string().optional(),
  /**
   * Optional: 1-Satz-Summary. Default = title-based.
   * Kein `.max` hier (analog `save_memory`): eine über-lange Summary wird
   * beim Build codepoint-sicher an der Wortgrenze geclampt, nie rejected —
   * ein `too_big`-Error würde den Caller in einen Retry-Roundtrip zwingen.
   */
  summary: z.string().optional(),
  /** Optional: zusätzliche Recall-Trigger. Default = title + tags. */
  recall_when: z.array(z.string()).optional(),
  /** Default false: existierender Document-Eintrag wirft Fehler. */
  overwrite: z.boolean().default(false),
});

export const RecategorizeDocumentArgs = z.object({
  id: z.string().min(1),
  /** Neuer Folder-Pfad. Wenn gesetzt, wird `move_document`-Logik mitgemacht. */
  folder_path: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: documentCategoryEnum.optional(),
  /**
   * Phase 3.2: wenn das Sidecar extern editiert wurde, blockiert der Daemon
   * den Update. `force=true` überschreibt das Veto explizit.
   */
  force: z.boolean().optional(),
});

export const MoveDocumentArgs = z.object({
  id: z.string().min(1),
  folder_path: z.string().min(1),
});

// ─── Tool definitions ───────────────────────────────────────────

export const documentWriteTools = [
  {
    name: "save_document",
    description:
      "Persist a new document into the user's vault: copy (or link) the " +
      "original file and write a sidecar with frontmatter for retrieval. " +
      "Pair with find_document/read_document afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        original_path: {
          type: "string",
          description: "Absolute path to the source file.",
        },
        folder_path: {
          type: "string",
          description:
            "Target folder relative to documents-root (e.g. 'Verträge/2026'). Empty = root.",
        },
        title: { type: "string", description: "Concise human-readable title." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "1–5 retrieval tags.",
        },
        category: {
          type: "string",
          enum: documentCategoryEnum.options,
          description: "Document category.",
        },
        linked_file: {
          type: "boolean",
          description: "If true, do not copy — keep original at source path.",
        },
        body: { type: "string", description: "Optional extracted plain-text." },
        summary: {
          type: "string",
          description: "Optional 1-sentence summary (<=400 chars).",
        },
        overwrite: {
          type: "boolean",
          description: "If true, replace existing document with same id.",
        },
      },
      required: ["original_path", "title", "tags", "category"],
    },
  },
  {
    name: "recategorize_document",
    description:
      "Update folder, title, tags or category of an existing document. " +
      "Refuses to overwrite externally edited sidecars unless force=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Document id (slug)." },
        folder_path: {
          type: "string",
          description: "New folder relative to documents-root.",
        },
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        category: { type: "string", enum: documentCategoryEnum.options },
        force: {
          type: "boolean",
          description:
            "If true, override the conflict-detection veto (use when the user explicitly accepts losing the external edit).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "move_document",
    description:
      "Move a document (original + sidecar) into a different folder. " +
      "The id stays stable; only paths and folder_path-frontmatter change.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Document id (slug)." },
        folder_path: {
          type: "string",
          description: "Target folder relative to documents-root.",
        },
      },
      required: ["id", "folder_path"],
    },
  },
];

// Die Implementierung liegt seit #680 in Geschwister-Modulen; dieses Modul
// behält Schemas, Tool-Definitionen und die öffentlichen Exporte.
export { buildFrontmatter, isProductDoc, isDocumentSidecar } from "./documents-write-shared.js";
export { saveDocument, type SaveDocumentResult } from "./documents-write-save.js";
export { recategorizeDocument } from "./documents-write-recategorize.js";
export { moveDocument, type MoveRollbackResult } from "./documents-write-move.js";

// ─── Conflict-Detection (Phase 3.2 — basic mtime-Check) ─────────

/**
 * Vergleicht die mtime des Original-Files mit der Cache-mtime im Vault.
 * Wenn die Datei seit dem letzten Vault-Read jünger ist, signalisieren wir
 * einen Conflict — der Caller (UI) entscheidet ob er trotzdem überschreibt.
 */
export async function detectExternalEdit(
  vault: Vault,
  id: string,
): Promise<{ conflict: boolean; reason?: string }> {
  const m = vault.get(id);
  if (!m) return { conflict: false };
  const fm = m.fm as typeof m.fm & { original_path?: string };
  const target = fm.original_path ?? m.filePath;
  let st;
  try {
    st = await stat(target);
  } catch {
    return { conflict: false }; // File weg → kein Konflikt, nur Fehler-Pfad
  }
  if (st.mtimeMs > m.mtime) {
    return {
      conflict: true,
      reason: `file changed externally at ${new Date(st.mtimeMs).toISOString()} (vault mtime ${new Date(m.mtime).toISOString()})`,
    };
  }
  return { conflict: false };
}
