/**
 * `recategorize_document`. Aus documents-write-handler.ts herausgelöst (#680).
 */
import {
  stat,
} from "node:fs/promises";
import type { z } from "zod";
import type { Vault } from "@bastra-recall/core";
import {
  withIdClaim,
  type IdClaim,
} from "@bastra-recall/core";
import { hiddenFromCaller, hiddenOnDisk, type PrivateAccess } from "./private-access.js";
import {
  acknowledgeCommittedJournal,
} from "./recovery-journal.js";
import { recordAudit } from "./audit-trail.js";
import type { RecategorizeDocumentArgs } from "./documents-write-handler.js";
import {
  todayISO,
  vaultRoot,
  publishSidecar,
  buildFrontmatter,
  isDocumentSidecar,
  readSidecarRaw,
  patchSidecarFrontmatter,
  renderPatched,
  metadataPatch,
} from "./documents-write-shared.js";
import {
  abortMove,
  moveDocumentFiles,
  MovedDocumentFiles,
} from "./documents-write-move.js";

// ─── recategorize_document ──────────────────────────────────────

export async function recategorizeDocument(
  vault: Vault,
  args: z.infer<typeof RecategorizeDocumentArgs> & { force?: boolean },
  /** #464: transportgebunden — siehe private-access.ts. */
  caller?: PrivateAccess,
): Promise<{ id: string; sidecar_path: string; reindexed: boolean; warning?: string }> {
  const m = vault.get(args.id);
  // #464: Wortgleiche Antwort für „gibt es nicht" und „darfst du nicht sehen".
  // Ein Sidecar mit `sensitivity: private` ist für externe Caller schon im
  // Lesepfad unsichtbar; dass es hier änderbar war, machte die Verbergung
  // wertlos — und der Erfolg verriet die Id gleich mit.
  if (!m || hiddenFromCaller(caller, m.fm)) {
    throw new Error(`document not found: ${args.id}`);
  }
  // `type === "doc"` allein reichte, und damit fiel eine PRODUKTDOKU in
  // diesen Pfad: sie kam als Document-Hub-Sidecar mit `scope: documents`
  // wieder heraus, der Text blieb, das Dokument war weg.
  if (!isDocumentSidecar(m.fm)) {
    throw new Error(`not a document sidecar: ${args.id}`);
  }
  // Phase 3.2 Conflict-Detection: wenn das Sidecar zwischen letztem
  // Vault-Read und jetzt extern editiert wurde, refusen wir den Update —
  // sonst überschreiben wir User-Edits aus Obsidian. Caller kann mit
  // `force: true` über das Veto gehen.
  if (!args.force) {
    try {
      const st = await stat(m.filePath);
      if (st.mtimeMs > m.mtime) {
        throw new Error(
          `sidecar was edited externally (mtime ${new Date(st.mtimeMs).toISOString()} > vault ${new Date(m.mtime).toISOString()}). Pass force=true to overwrite.`,
        );
      }
    } catch (err) {
      if ((err as Error).message.startsWith("sidecar was edited")) throw err;
      // stat-Fehler (File weg etc.) → durchlaufen, write-Logik wird erneut prüfen.
    }
  }
  // Codex-Gegenreview (P0): Dieser Pfad las das Sidecar, baute das
  // Frontmatter neu und schrieb es zurück — ohne Sperre und ohne Vergleich.
  // Gemessen: 20 parallele Läufe, einer änderte den Titel, einer die Tags,
  // BEIDE meldeten Erfolg, und in 20 von 20 Läufen blieb nur eine der beiden
  // Änderungen übrig. Ab hier gilt dieselbe Transaktion wie im Save-Pfad: Es
  // gewinnt einer, und der andere erfährt es.
  return withIdClaim(
    { vaultRoot: vaultRoot(vault), id: args.id, filePath: m.filePath, op: "recategorize_document" },
    (claim) => commitRecategorize(claim, vault, args, m, caller),
  );
}

async function commitRecategorize(
  claim: IdClaim,
  vault: Vault,
  args: z.infer<typeof RecategorizeDocumentArgs> & { force?: boolean },
  m: { fm: Record<string, unknown> & { id: string; title: string; tags: string[]; summary: string; recall_when: string[]; created: string }; filePath: string },
  caller?: PrivateAccess,
): Promise<{ id: string; sidecar_path: string; reindexed: boolean; warning?: string }> {
  const fm = m.fm as typeof m.fm & {
    original_path?: string;
    document_category?: string;
    folder_path?: string;
    linked_file?: boolean;
    aliases?: string[];
    injection_flags?: string[];
  };

  // Wo das Sidecar WIRKLICH liegt — von der Platte, unter dem Lock. Der
  // Index kann veraltet sein, und ein Frontmatter-Patch auf einen veralteten
  // Pfad schreibt in eine Datei, die dieses Dokument nicht mehr ist.
  const located = await claim.locate();
  if (located.kind !== "unique") {
    throw new Error(
      located.kind === "none"
        ? `document not found on disk: ${args.id}`
        : `cannot recategorize ${args.id}: the vault scan is not conclusive (${located.kind}).`,
    );
  }
  // #464 (wiedereröffnet): Die Prüfung in `recategorizeDocument` fragte den
  // INDEX. Trug das Sidecar auf der PLATTE `sensitivity: private` — extern
  // gesetzt, vom Watcher auf einem Cloud-Mount nie gemeldet —, ließ es sich
  // trotzdem umbenennen und umhängen (5 von 5 Läufen). Dieselbe Frage an die
  // Bytes, unter dem Claim, VOR dem Move und vor jedem Frontmatter-Patch.
  if (hiddenOnDisk(caller, (await readSidecarRaw(located.filePath)).raw)) {
    throw new Error(`document not found: ${args.id}`);
  }

  // Wenn Folder geändert: erst move (verschiebt Files + Sidecar). Sonst nur
  // Sidecar-Frontmatter aktualisieren.
  const oldSidecarPath = located.filePath;
  let sidecarPath = located.filePath;
  let originalPath = fm.original_path ?? m.filePath.replace(/\.md$/, "");
  let folderPath = fm.folder_path ?? "";
  let moved: MovedDocumentFiles | undefined;

  if (args.folder_path !== undefined && args.folder_path !== folderPath) {
    moved = await moveDocumentFiles(vault, {
      op: "recategorize_document",
      id: m.fm.id,
      sidecarPath,
      originalPath,
      currentFolderPath: folderPath,
      newFolderPath: args.folder_path,
      linkedFile: fm.linked_file ?? false,
    });
    sidecarPath = moved.newSidecarPath;
    originalPath = moved.newOriginalPath;
    folderPath = args.folder_path;
  }

  // Codex-Gegenreview (P0): `vault.forgetFile()` lief FRÜHER — direkt nach dem
  // Move, also bevor die Veröffentlichung geglückt war. Scheiterte der Commit
  // danach, war das Dokument aus dem Index verschwunden UND lag am neuen Ort:
  // ein Halbzustand, den der gemeldete Fehler nicht einmal erwähnte. Index-
  // Umhängen und Reindex passieren erst nach dem Gesamtcommit.
  let raw: { data: Record<string, unknown>; body: string; raw: string } | undefined;
  let updated: Record<string, unknown> = {};
  try {
    const category = args.category ?? fm.document_category ?? "sonstiges";
    // Nur die Felder anfassen, die dieser Call meint. Der frühere Rebuild aus
    // buildFrontmatter warf alles weg, was nicht in seiner Feldliste stand.
    raw = await readSidecarRaw(sidecarPath);
    const rebuilt = buildFrontmatter({
      id: m.fm.id,
      title: args.title ?? m.fm.title,
      summary: m.fm.summary,
      tags: args.tags ?? m.fm.tags,
      category,
      recallWhen: m.fm.recall_when,
      originalPath,
      linkedFile: fm.linked_file ?? false,
      folderPath,
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

    // Die mtime-Prüfung oben lief VOR dem Claim und sieht nur, was bis dahin
    // passiert ist. Hier wird gegen die Bytes verglichen, auf denen `updated`
    // und `raw.body` tatsächlich beruhen.
    await publishSidecar(sidecarPath, renderPatched(updated, raw.body), {
      id: m.fm.id,
      preimage: raw.raw,
      force: args.force ?? false,
    });
  } catch (err) {
    if (moved) await abortMove(vault, moved, oldSidecarPath, raw?.raw, err);
    throw err;
  }
  // #240/A3: the OLD sidecar path must leave the index before the new one
  // enters it. Without this both paths point at the same id; the next
  // reconcile (60 s, or any /vault/count) removes the old path and takes
  // the current memory with it — the document went silently unfindable
  // until a daemon restart. Same fix pattern as tool-handlers.ts:839.
  if (sidecarPath !== oldSidecarPath) vault.forgetFile(oldSidecarPath);
  await vault.reindexFile(sidecarPath);

  // #452: siehe save_document.
  const auditWarning = await recordAudit({
    vaultRoot: vaultRoot(vault),
    memoryId: m.fm.id,
    operation: "update",
    actor: "assistant",
    actorDetail: "mcp:recategorize_document",
    diffBefore: raw?.data ?? null,
    diffAfter: updated,
    filePath: sidecarPath,
    ...(sidecarPath !== oldSidecarPath
      ? { reason: `recategorize_document: moved ${oldSidecarPath} → ${sidecarPath}` }
      : {}),
  });

  const journalWarning = await acknowledgeCommittedJournal(moved?.journal);

  return {
    id: m.fm.id,
    sidecar_path: sidecarPath,
    reindexed: true,
    ...((auditWarning || journalWarning) ? { warning: [auditWarning, journalWarning].filter(Boolean).join("; ") } : {}),
  };
}
