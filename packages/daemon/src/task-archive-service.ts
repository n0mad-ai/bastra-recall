/** Task archive operations that authenticate callers and commit under the store lock. */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticateTask, requireTaskOwner, requireTaskDomains } from "./task-auth.js";
import { TASK_MAX_BYTES } from "./task-schema.js";
import { TaskStoreError } from "./task-store-error.js";
import { atomicWrite } from "./task-store-file.js";
import { withTaskStoreGuard } from "./task-store.js";
import {
  archiveIntentKey,
  readTaskArchive,
  selectTaskArchiveGroup,
  taskArchiveBundleSchema,
  taskArchiveGroupRows,
  taskArchiveHash,
  taskArchivePath,
} from "./task-archive.js";
import type { TaskServiceContext } from "./task-service.js";

export const taskArchiveInput = z.strictObject({
  task_ids: z.array(z.string().min(1).max(160)).min(1).max(100),
  expected_revision: z.number().int().nonnegative().safe(),
  recovery_epoch: z.string().min(1).max(160),
});
export async function archiveTasks(ctx: TaskServiceContext, authorization: string | undefined, raw: unknown) {
  const input = taskArchiveInput.parse(raw);
  await authenticateTask(authorization, ctx.authPath);
  return withTaskStoreGuard(ctx.path, async (guard) => {
    const s = guard.snapshot();
    if (s.revision !== input.expected_revision || s.recovery_epoch !== input.recovery_epoch)
      throw new TaskStoreError("conflict", "Archive snapshot changed");
    const current = await authenticateTask(authorization, ctx.authPath);
    const ids = new Set(input.task_ids),
      group = selectTaskArchiveGroup(s, ids);
    if (group.tasks.length !== ids.size) throw Object.assign(new Error("Task absent"), { code: "not_found" });
    const domains = [
      ...new Set([
        ...group.tasks.flatMap((t) => t.owner_domains),
        ...group.proposals.flatMap((p) => p.required_domains),
        ...group.events.flatMap((e) => e.owner_domains),
        ...group.sources.flatMap((src) => src.owner_domains),
      ]),
    ];
    requireTaskDomains(current, domains);
    if (
      !s.controls.execution_stopped ||
      group.tasks.some(
        (t) =>
          t.armed || !["resolved", "cancelled", "expired"].includes(t.state) || t.decision_change?.status === "pending"
      ) ||
      group.occurrences.some((o) => !o.resolution && !(o.kind === "expired" && o.acknowledgement)) ||
      group.intents.some((i) => i.state === "pending" || i.state === "unknown" || i.temp_cleanup_pending) ||
      group.leases.some((l) => l.state === "active")
    )
      throw new TaskStoreError("conflict", "Stop execution; unresolved occurrences/intents/leases stay active");
    if (s.archives.length >= 1000) throw new TaskStoreError("capacity", "Archive index limit; no unsafe eviction");
    const id = randomUUID(),
      rawBundle = JSON.stringify(taskArchiveBundleSchema.parse({ schema_version: 1, id, snapshot: group }));
    if (Buffer.byteLength(rawBundle) > TASK_MAX_BYTES + 1024) throw new TaskStoreError("capacity", "Archive too large");
    const entry = {
      id,
      hash: taskArchiveHash(rawBundle),
      at: (ctx.now ?? Date.now)(),
      actor: current.actor_id,
      task_ids: [...ids],
      intent_keys: group.intents.map((i) => archiveIntentKey(i.actor, i.idempotency_key)),
      owner_domains: domains,
      creation_bindings: Object.fromEntries(
        s.tasks.filter((t) => ids.has(t.id) && t.creation_hash).map((t) => [t.id, t.creation_hash!])
      ),
    };
    await mkdir(dirname(taskArchivePath(ctx.path, id)), { recursive: true, mode: 0o700 });
    await atomicWrite(taskArchivePath(ctx.path, id), rawBundle, guard.assertOwnership);
    // An interrupted pre-index export is harmless: active data still owns every ID.
    await guard.commit((next) => {
      next.archives.push(entry);
      for (const name of taskArchiveGroupRows) {
        const remove = new Set(group[name].map((r) => r.id));
        (next[name] as { id: string }[]) = (next[name] as { id: string }[]).filter((r) => !remove.has(r.id));
      }
    }, "archive");
    return { archive_id: id, task_count: ids.size, history_retained: true, spent_approvals_retained: true };
  });
}
/** Logical deletion retains the original verified private export as a backup. */
export async function deleteArchivedTask(
  ctx: TaskServiceContext,
  authorization: string | undefined,
  input: { id: string; expected_revision: string; archive_id: string }
) {
  return withTaskStoreGuard(ctx.path, async (guard) => {
    const s = guard.snapshot(),
      principal = await authenticateTask(authorization, ctx.authPath);
    const entry = s.archives.find(
      (a) => a.id === input.archive_id && a.owner_domains.every((d) => principal.domains.includes(d))
    );
    if (!entry || !entry.task_ids.includes(input.id))
      throw Object.assign(new Error("Archived task absent"), { code: "not_found" });
    const original = await readTaskArchive(ctx.path, entry, true),
      task = original.tasks.find((t) => t.id === input.id)!;
    if (`${original.recovery_epoch}:${task.revision}` !== input.expected_revision)
      throw new TaskStoreError("conflict", "Archived task revision changed");
    if (s.tasks.some((t) => t.id === input.id))
      throw new TaskStoreError("conflict", "Delete the restored active task first");
    const copies = s.archives.filter((a) => a.task_ids.includes(input.id));
    for (const copy of copies) {
      requireTaskDomains(principal, copy.owner_domains);
      await readTaskArchive(ctx.path, copy, true);
    }
    if (copies.some((a) => !a.deleted_task_ids?.includes(input.id)))
      await guard.commit((next) => {
        for (const copy of next.archives.filter((a) => a.task_ids.includes(input.id)))
          copy.deleted_task_ids = [...new Set([...(copy.deleted_task_ids ?? []), input.id])];
      }, "delete");
    return { id: input.id, archive_id: entry.id, deleted: true, backup_retained: true };
  });
}
export async function restoreTaskArchive(
  ctx: TaskServiceContext,
  authorization: string | undefined,
  archiveId: string
) {
  const owner = await authenticateTask(authorization, ctx.authPath);
  requireTaskOwner(owner);
  return withTaskStoreGuard(ctx.path, async (guard) => {
    const s = guard.snapshot(),
      entry = s.archives.find((a) => a.id === archiveId);
    if (!entry) throw Object.assign(new Error("Archive absent"), { code: "not_found" });
    const current = await authenticateTask(authorization, ctx.authPath);
    requireTaskOwner(current);
    requireTaskDomains(current, entry.owner_domains);
    const archived = await readTaskArchive(ctx.path, entry);
    if (archived.tasks.every((t) => s.tasks.some((active) => active.id === t.id)))
      return { restored: false, archive_id: entry.id };
    if (archived.tasks.some((t) => s.tasks.some((active) => active.id === t.id)))
      throw new TaskStoreError("conflict", "Partial archive restore forbidden");
    await guard.commit((next) => {
      for (const name of taskArchiveGroupRows) {
        for (const row of archived[name]) {
          if ((next[name] as { id: string }[]).some((r) => r.id === row.id))
            throw new TaskStoreError("conflict", "Archived identity reused");
          (next[name] as unknown[]).push(
            name === "tasks"
              ? { ...structuredClone(row), creation_hash: entry.creation_bindings?.[row.id] }
              : structuredClone(row)
          );
        }
      }
      next.controls.execution_stopped = true;
    }, "control");
    return { restored: true, archive_id: entry.id, unarmed: true, execution_stopped: true };
  });
}
