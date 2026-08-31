/**
 * #205 — daemon side of conflict marking. A `save_memory` carrying
 * `conflict_with` is a contradiction report, not a write: the incoming
 * memory is never created, the existing one is never overwritten — the
 * conflict lands as a visible plain-markdown block in the existing memory
 * (rendering lives in core/conflict.ts), the index is refreshed, and the
 * audit log records the diversion (which puts it in the #288 journal too).
 */
import { mutateMemoryFile, renderConflictBlock, type SaveMemoryInput } from "@bastra-recall/core";
import { recordAudit } from "./audit-trail.js";
import type { ToolDeps } from "./tool-deps.js";

export interface ConflictMarkResult {
  /** The EXISTING memory that now carries the conflict block. */
  id: string;
  file_path: string;
  created: false;
  conflict_marked: true;
  note: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function markConflict(
  deps: ToolDeps,
  input: SaveMemoryInput,
  finalId: string,
): Promise<ConflictMarkResult> {
  const targetId = input.conflict_with;
  if (!targetId) throw new Error("markConflict called without conflict_with");
  if (targetId === finalId) {
    throw new Error(`conflict_with: a memory cannot conflict with itself (${finalId}).`);
  }
  const target = deps.vault.get(targetId);
  if (!target) {
    throw new Error(
      `conflict_with: unknown memory '${targetId}' — it must exist in the vault. ` +
        `To simply store a new fact, drop the conflict_with field.`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const block = renderConflictBlock(
    {
      statement: str(target.fm.summary) ?? str(target.fm.title) ?? targetId,
      date: str(target.fm.updated) ?? str(target.fm.created),
      source: str(target.fm.source),
    },
    { statement: input.summary, detail: input.body, date: today, source: input.source },
    today,
  );
  // Über `mutateMemoryFile`: atomar (ein direktes writeFile ließ die Datei
  // kurzzeitig halb geschrieben), mit Identitätsprüfung (ein Pfad beweist
  // nicht, welches Memory dort liegt) und mit Vergleich vor dem Commit, damit
  // ein paralleler Save nicht rückgängig gemacht wird.
  const outcome = await mutateMemoryFile(
    target.filePath,
    targetId,
    { body: (content) => `${content.replace(/\s*$/, "")}\n\n${block}\n` },
    { vaultRoot: deps.vaultPath },
  );
  if (outcome.kind === "identity-mismatch") {
    throw new Error(
      `conflict_with: ${target.filePath} does not hold memory '${targetId}' ` +
        `(found ${outcome.found ?? "no memory"}) — refusing to mark a conflict on a foreign file.`,
    );
  }
  if (outcome.kind === "raced") {
    throw new Error(
      `conflict_with: '${targetId}' changed while the conflict block was being written — ` +
        `nothing was modified. Retry.`,
    );
  }
  if (outcome.kind !== "written") {
    // Kann hier nicht eintreten (dieser Aufruf patcht nur den Body und gibt nie
    // `null` zurück), aber ein Beleg wird nur aus einem WRITTEN gebildet —
    // stillschweigend etwas anderes zu protokollieren wäre genau der Fehler,
    // den P1-2 meint.
    throw new Error(
      `conflict_with: '${targetId}' reported '${outcome.kind}' — nothing was modified.`,
    );
  }
  await deps.vault.reindexFile(target.filePath);

  // Codex-Gegenreview Runde 10 (P1-2): `diffBefore` kam aus `target.fm`, also
  // aus dem Vault-CACHE, und `diffAfter` aus einem Cache-Lookup nach dem
  // Reindex. Nachgestellt: Auf der Platte stand `external-on-disk`, das Audit
  // meldete vorher `cache-summary` — ein Beleg, der eine Fassung beschreibt,
  // die dieser Schreibvorgang nie gesehen hat. Beide Abbilder kommen jetzt aus
  // der Mutation selbst, gelesen unter demselben Claim aus denselben Bytes,
  // die überschrieben wurden.
  await recordAudit({
    vaultRoot: deps.vaultPath,
    memoryId: targetId,
    operation: "update",
    actor: "assistant",
    actorDetail: "mcp:save_memory:conflict",
    diffBefore: outcome.before,
    diffAfter: outcome.after,
    filePath: target.filePath,
    reason: `conflict marked: incoming save '${input.title}' contradicts this memory`,
    sessionId: deps.telemetry.runId(),
  });

  return {
    id: targetId,
    file_path: target.filePath,
    created: false,
    conflict_marked: true,
    note:
      `Conflict marked on '${targetId}' — the incoming memory was NOT created; its content is preserved ` +
      `inside the conflict block. Decide with the user which claim stands, then resolve with an explicit ` +
      `overwrite=true save of that memory. Do not repeat this save_memory call.`,
  };
}
