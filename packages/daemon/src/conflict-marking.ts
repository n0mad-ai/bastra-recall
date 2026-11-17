/**
 * #205 — daemon side of conflict marking. A `save_memory` carrying
 * `conflict_with` is a contradiction report, not a write: the incoming
 * memory is never created, the existing one is never overwritten — the
 * conflict lands as a visible plain-markdown block in the existing memory
 * (rendering lives in core/conflict.ts), the index is refreshed, and the
 * audit log records the diversion (which puts it in the #288 journal too).
 */
import { readFile } from "node:fs/promises";
import {
  assertInsideVault,
  mutateMemoryFile,
  NO_WAIT_TEXT,
  parseMemory,
  renderConflictBlock,
  type Memory,
  type SaveMemoryInput,
} from "@bastra-recall/core";
import { recordAudit } from "./audit-trail.js";
import { hiddenFromCaller, type PrivateAccess } from "./private-access.js";
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

function unknownTarget(id: string): Error {
  return new Error(
    `conflict_with: unknown memory '${id}' — it must exist in the vault. ` +
      `To simply store a new fact, drop the conflict_with field.`
  );
}

function conflictTarget(deps: ToolDeps, input: SaveMemoryInput, finalId: string, access?: PrivateAccess): Memory {
  const id = input.conflict_with;
  if (!id) throw new Error("markConflict called without conflict_with");
  if (id === finalId) throw new Error(`conflict_with: a memory cannot conflict with itself (${finalId}).`);
  const target = deps.vault.get(id);
  if (!target || hiddenFromCaller(access, target.fm)) throw unknownTarget(id);
  return target;
}

function identityMismatch(target: Memory, found: string | null): Error {
  return new Error(
    `conflict_with: ${target.filePath} does not hold memory '${target.fm.id}' ` +
      `(found ${found ?? "no memory"}) — refusing to mark a conflict on a foreign file.`
  );
}

function conflictBlock(raw: string, target: Memory, input: SaveMemoryInput, access?: PrivateAccess): string {
  let fm: Memory["fm"];
  try {
    fm = parseMemory(raw, target.filePath, 0).fm;
  } catch {
    throw identityMismatch(target, null);
  }
  if (hiddenFromCaller(access, fm)) throw unknownTarget(target.fm.id);
  if (fm.id !== target.fm.id) throw identityMismatch(target, fm.id);
  const today = new Date().toISOString().slice(0, 10);
  return renderConflictBlock(
    {
      statement: str(fm.summary) ?? str(fm.title) ?? fm.id,
      date: str(fm.updated) ?? str(fm.created),
      source: str(fm.source),
    },
    { statement: input.summary, detail: input.body, date: today, source: input.source },
    today
  );
}

/** #1484: read the same target as the write, without taking the mutation claim. */
export async function previewConflictMark(
  deps: ToolDeps,
  input: SaveMemoryInput,
  finalId: string,
  access?: PrivateAccess
): Promise<Omit<ConflictMarkResult, "conflict_marked" | "note"> & { conflict_block: string }> {
  const target = conflictTarget(deps, input, finalId, access);
  assertInsideVault(deps.vaultPath, target.filePath);
  const raw = await readFile(target.filePath, NO_WAIT_TEXT).catch(() => null);
  if (raw === null) throw identityMismatch(target, null);
  const block = conflictBlock(raw, target, input, access);
  return { id: target.fm.id, file_path: target.filePath, created: false, conflict_block: block };
}

export async function markConflict(
  deps: ToolDeps,
  input: SaveMemoryInput,
  finalId: string,
  access?: PrivateAccess
): Promise<ConflictMarkResult> {
  const target = conflictTarget(deps, input, finalId, access);
  const targetId = target.fm.id;
  let block: string;
  const outcome = await mutateMemoryFile(
    target.filePath,
    targetId,
    {
      precondition: (raw) => {
        block = conflictBlock(raw, target, input, access);
      },
      body: (content) => `${content.replace(/\s*$/, "")}\n\n${block}\n`,
    },
    { vaultRoot: deps.vaultPath }
  );
  if (outcome.kind === "identity-mismatch") throw identityMismatch(target, outcome.found);
  if (outcome.kind === "raced") {
    throw new Error(
      `conflict_with: '${targetId}' changed while the conflict block was being written — ` +
        `nothing was modified. Retry.`
    );
  }
  if (outcome.kind !== "written") {
    // Kann hier nicht eintreten (dieser Aufruf patcht nur den Body und gibt nie
    // `null` zurück), aber ein Beleg wird nur aus einem WRITTEN gebildet —
    // stillschweigend etwas anderes zu protokollieren wäre genau der Fehler,
    // den P1-2 meint.
    throw new Error(`conflict_with: '${targetId}' reported '${outcome.kind}' — nothing was modified.`);
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
