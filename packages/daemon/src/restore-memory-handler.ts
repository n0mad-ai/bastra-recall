/**
 * restore_memory (#1471) — the undo of archive_memory over MCP, REST and the
 * CLI (`bastra trash`), not only through the Mac-app bridge and the web UI.
 *
 * Without `id` it lists what can come back: memories whose latest audit entry
 * is a delete and whose trash copy still exists, newest first. With `id` it
 * puts the newest trash copy back at its original path through
 * `auditedRestore` — the same primitive the bridge and the web UI use, with
 * its id claim, containment check and `restore` audit entry.
 *
 * A trashed private memory stays as invisible as it was in the vault: the
 * public transports neither list nor restore it (#464).
 */
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { AuditLog, auditedRestore, latestTrashPathFor, type AuditEntry } from "@bastra-recall/core";
import { writerFields } from "./audit-trail.js";
import { hiddenFromCaller, hiddenOnDisk, type PrivateAccess } from "./private-access.js";
import type { ToolDeps } from "./tool-deps.js";

export const RestoreMemoryArgs = z.object({
  id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export interface ArchivedMemory {
  id: string;
  title: string;
  archived_at: string;
  /** Where it lived, relative to the vault — where a restore puts it back. */
  from: string | null;
}

export type RestoreMemoryResult =
  { archived: ArchivedMemory[]; total: number; note: string } | { id: string; restored_to: string; warning?: string };

const DEFAULT_LIMIT = 20;

export async function restoreMemoryHandler(
  deps: ToolDeps,
  args: unknown,
  /** #464: transport-bound — see private-access.ts. Required on purpose: every
   *  caller states its transport's answer; `undefined` (the public REST, remote
   *  MCP and stdio transports) neither lists nor restores a private memory. */
  access: PrivateAccess | undefined
): Promise<RestoreMemoryResult> {
  const parsed = RestoreMemoryArgs.safeParse(args ?? {});
  if (!parsed.success) {
    throw new Error(`invalid restore_memory args: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  const { id, limit } = parsed.data;
  return id === undefined ? listArchived(deps, limit ?? DEFAULT_LIMIT, access) : restoreOne(deps, id, access);
}

/** The trash copy of `id` as this caller may see it, or null. */
async function visibleTrashCopy(
  vaultRoot: string,
  id: string,
  access?: PrivateAccess
): Promise<{ raw: string; path: string } | null> {
  const path = await latestTrashPathFor(vaultRoot, id);
  const raw = path ? await readFile(path, "utf8").catch(() => null) : null;
  if (!path || raw === null || hiddenOnDisk(access, raw)) return null;
  return { raw, path };
}

async function listArchived(deps: ToolDeps, limit: number, access?: PrivateAccess) {
  const entries = await new AuditLog(deps.vaultPath).readAll();
  // The latest entry per id decides: a delete followed by a restore or a
  // new save is not archived any more.
  const latest = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) latest.set(entry.memory_id, entry);
  const candidates = [...latest.values()]
    .filter((e) => e.operation === "delete" && !deps.vault.get(e.memory_id))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  // Only what this caller may see counts — a private memory is not even a number here.
  const archived: ArchivedMemory[] = [];
  let total = 0;
  for (const entry of candidates) {
    const copy = await visibleTrashCopy(deps.vaultPath, entry.memory_id, access);
    if (!copy) continue;
    total++;
    if (archived.length < limit) archived.push(archivedRow(deps.vaultPath, entry, copy.raw));
  }
  return {
    archived,
    total,
    note:
      archived.length === 0
        ? "Nothing archived can be restored."
        : `Restore one with restore_memory({ id }). Showing ${archived.length}, newest first.`,
  };
}

function archivedRow(vaultRoot: string, entry: AuditEntry, raw: string): ArchivedMemory {
  const title = String(matter(raw).data.title ?? entry.diff_before?.title ?? entry.memory_id);
  const from = entry.file_path ? relative(vaultRoot, entry.file_path).split(sep).join("/") : null;
  return { id: entry.memory_id, title, archived_at: entry.timestamp, from };
}

async function restoreOne(deps: ToolDeps, id: string, access?: PrivateAccess) {
  // A live memory under the id that this caller may not see answers like a
  // missing one; the restore's own refusal would name its path (#464).
  const live = deps.vault.get(id);
  if (!(await visibleTrashCopy(deps.vaultPath, id, access)) || (live && hiddenFromCaller(access, live.fm))) {
    throw new Error(`nothing to restore: ${id} — call restore_memory without id to list archived memories.`);
  }
  const out = await auditedRestore({
    auditLog: new AuditLog(deps.vaultPath),
    vaultRoot: deps.vaultPath,
    memoryID: id,
    vault: deps.vault,
    context: {
      actor: "assistant",
      actor_detail: "mcp:restore_memory",
      session_id: deps.telemetry.runId(),
      ...writerFields(),
    },
  });
  await deps.vault.reindexFile(out.restoredTo);
  return { id, restored_to: out.restoredTo, ...(out.audit_warning ? { warning: out.audit_warning } : {}) };
}

/** The stdio server's answer shape for restore_memory. */
export async function restoreMemoryMcp(
  deps: ToolDeps,
  args: unknown,
  /** The stdio server is a public transport (#464): it passes `undefined`. */
  access: PrivateAccess | undefined
): Promise<{ content: { type: "text"; text: string }[]; isError?: true }> {
  try {
    return {
      content: [{ type: "text", text: JSON.stringify(await restoreMemoryHandler(deps, args, access), null, 2) }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
  }
}

export const restoreMemoryTools = [
  {
    name: "restore_memory",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "Undo archive_memory: bring an archived memory back from the vault trash to where it lived. " +
      "Without id: list the archived memories that can be restored (newest first). " +
      "With id: restore that memory; refused if a memory with the same id is live again.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id of the archived memory to restore. Omit to list." },
        limit: { type: "number", description: "How many archived memories to list (1-100, default 20)." },
      },
    },
  },
];
