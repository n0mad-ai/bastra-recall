/** Private cold snapshots retain idempotency and audit; nothing unresolved is evicted. */
import { deleteTaskRows } from "./task-delete-rows.js";
import { exportTaskComparisons } from "./task-private-comparison.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { taskStoreSchema, TASK_MAX_BYTES, type TaskStore } from "./task-schema.js";
import { canonicalTaskValue } from "./task-canonical.js";
import { TaskStoreError } from "./task-store-error.js";
import { decodeTaskStore } from "./task-store-codec.js";
export const taskArchiveHash = (v: string) => createHash("sha256").update(v).digest("hex");
export const archiveIntentKey = (actor: string, key: string) =>
  taskArchiveHash(canonicalTaskValue(["archive-intent-v1", actor, key]));
export const taskArchiveBundleSchema = z.strictObject({
  schema_version: z.literal(1),
  id: z.string().uuid(),
  snapshot: z.preprocess((value) => decodeTaskStore(JSON.stringify(value)), taskStoreSchema),
});
export function taskArchivePath(path: string, id: string) {
  return join(dirname(path), "task-archives", `${z.string().uuid().parse(id)}.json`);
}
export async function readTaskArchive(
  path: string,
  entry: TaskStore["archives"][number],
  includeDeleted = false
): Promise<TaskStore> {
  try {
    const fd = await open(taskArchivePath(path, entry.id), constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.mode & 0o077 || info.size > TASK_MAX_BYTES + 1024) throw new Error("unsafe archive");
      const bytes = Buffer.alloc(TASK_MAX_BYTES + 1025),
        read = await fd.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > TASK_MAX_BYTES + 1024) throw new Error("archive too large");
      raw = bytes.subarray(0, read.bytesRead).toString("utf8");
    } finally {
      await fd.close();
    }
    if (taskArchiveHash(raw) !== entry.hash) throw new Error("archive hash differs");
    const b = taskArchiveBundleSchema.parse(JSON.parse(raw));
    if (
      b.id !== entry.id ||
      canonicalTaskValue(b.snapshot.tasks.map((t) => t.id).sort()) !== canonicalTaskValue([...entry.task_ids].sort())
    )
      throw new Error("archive index differs");
    if (!includeDeleted) deleteTaskRows(b.snapshot, new Set(entry.deleted_task_ids ?? []));
    return b.snapshot;
  } catch {
    throw new TaskStoreError("corrupt", "Private task archive missing or altered; no idempotency reuse");
  }
}
export async function archivedTask(path: string, s: TaskStore, id: string) {
  const entry = [...s.archives].reverse().find((a) => a.task_ids.includes(id));
  if (!entry) return;
  if (entry.deleted_task_ids?.includes(id))
    throw new TaskStoreError("conflict", "Archived task was explicitly deleted; use a new request identity");
  const snapshot = await readTaskArchive(path, entry);
  const task = snapshot.tasks.find((t) => t.id === id)!;
  return { entry, snapshot, task: { ...task, creation_hash: entry.creation_bindings?.[id] } };
}
export async function archivedIntent(path: string, s: TaskStore, actor: string, key: string) {
  const digest = archiveIntentKey(actor, key),
    entry = [...s.archives].reverse().find((a) => a.intent_keys.includes(digest));
  if (!entry) return;
  const original = await readTaskArchive(path, entry, true);
  if (
    original.intents.some(
      (i) => i.actor === actor && i.idempotency_key === key && entry.deleted_task_ids?.includes(i.task_id)
    )
  )
    throw new TaskStoreError("conflict", "Archived task was explicitly deleted");
  const snapshot = await readTaskArchive(path, entry),
    intent = snapshot.intents.find((i) => i.actor === actor && i.idempotency_key === key);
  if (!intent) throw new TaskStoreError("corrupt", "Archived intent index differs");
  return { entry, snapshot, intent };
}
export const taskArchiveGroupRows = [
  "tasks",
  "occurrences",
  "proposals",
  "challenges",
  "approvals",
  "leases",
  "intents",
  "receipts",
] as const;
export function selectTaskArchiveGroup(s: TaskStore, ids: Set<string>): TaskStore {
  const group = structuredClone(s);
  group.archives = [];
  group.tasks = s.tasks.filter((t) => ids.has(t.id)).map((t) => structuredClone(t));
  group.proposals = s.proposals.filter((p) => ids.has(p.task_id)).map((row) => structuredClone(row));
  const proposals = new Set(group.proposals.map((p) => p.id));
  group.occurrences = s.occurrences.filter((o) => ids.has(o.task_id));
  group.challenges = s.challenges.filter((c) => proposals.has(c.proposal_id)).map((row) => structuredClone(row));
  group.approvals = s.approvals.filter((a) => proposals.has(a.proposal_id)).map((row) => structuredClone(row));
  group.leases = s.leases.filter((l) => ids.has(l.task_id));
  group.intents = s.intents.filter((i) => ids.has(i.task_id));
  group.receipts = s.receipts.filter((r) => ids.has(r.task_id));
  const sources = new Set(
    group.tasks.flatMap((t) => [
      ...t.evidence.map((e) => e.source_id),
      ...(t.schedule.kind === "event" ? [t.schedule.source_id] : []),
    ])
  );
  group.events = s.events
    .filter((e) => sources.has(e.source_id) || group.occurrences.some((o) => o.event_key === `event:${e.id}`))
    .map((row) => structuredClone(row));
  group.sources = s.sources.filter((src) => sources.has(src.id)).map((row) => structuredClone(row));
  group.checkpoint = 0;
  group.evaluation_cursor = 0;
  group.recovery_history = [];
  exportTaskComparisons(group);
  return taskStoreSchema.parse(group);
}
/** Called by the guard, never trusted merely because a caller supplies archive kind. */
export async function validateTaskArchivePrune(path: string, before: TaskStore, after: TaskStore): Promise<TaskStore> {
  if (
    after.archives.length !== before.archives.length + 1 ||
    canonicalTaskValue(after.archives.slice(0, -1)) !== canonicalTaskValue(before.archives)
  )
    throw new TaskStoreError("conflict", "Archive index append required");
  const entry = after.archives.at(-1)!,
    archived = await readTaskArchive(path, entry),
    ids = new Set(entry.task_ids),
    expected = selectTaskArchiveGroup(before, ids);
  if (
    !before.controls.execution_stopped ||
    expected.tasks.some(
      (t) =>
        t.armed || !["resolved", "cancelled", "expired"].includes(t.state) || t.decision_change?.status === "pending"
    ) ||
    expected.occurrences.some((o) => !o.resolution && !(o.kind === "expired" && o.acknowledgement)) ||
    expected.intents.some((i) => ["pending", "unknown"].includes(i.state) || i.temp_cleanup_pending) ||
    expected.leases.some((l) => l.state === "active")
  )
    throw new TaskStoreError("conflict", "Unresolved work cannot be archived");
  if (canonicalTaskValue(archived) !== canonicalTaskValue(expected))
    throw new TaskStoreError("conflict", "Archive is not exact committed predecessor");
  const comparison = structuredClone(before);
  for (const name of taskArchiveGroupRows) {
    const removed = new Set(archived[name].map((r) => r.id));
    (comparison[name] as { id: string }[]) = (comparison[name] as { id: string }[]).filter((r) => !removed.has(r.id));
  }
  comparison.archives = after.archives;
  if (canonicalTaskValue(comparison) !== canonicalTaskValue(after))
    throw new TaskStoreError("conflict", "Only exact archived rows may be retired");
  return comparison;
}
/** Recover only private, fully validated cold exports; never delete orphan files. */
export async function discoverTaskArchiveExports(path: string, actor: string) {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(dirname(taskArchivePath(path, "00000000-0000-4000-8000-000000000000")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const eligible = names.filter((n) => /^[a-f0-9-]{36}\.json$/.test(n)).sort();
  if (eligible.length > 1000)
    throw new TaskStoreError("capacity", "Too many recovery archive exports; originals preserved");
  const result: Array<{ entry: TaskStore["archives"][number]; snapshot: TaskStore }> = [];
  for (const name of eligible) {
    const id = z.string().uuid().parse(name.slice(0, -5)),
      fd = await open(taskArchivePath(path, id), constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.mode & 0o077 || info.size > TASK_MAX_BYTES + 1024)
        throw new TaskStoreError("corrupt", "Unsafe cold export; original preserved");
      const bytes = Buffer.alloc(TASK_MAX_BYTES + 1025),
        read = await fd.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > TASK_MAX_BYTES + 1024) throw new TaskStoreError("capacity", "Cold export too large");
      raw = bytes.subarray(0, read.bytesRead).toString("utf8");
    } finally {
      await fd.close();
    }
    let bundle: z.infer<typeof taskArchiveBundleSchema>;
    try {
      bundle = taskArchiveBundleSchema.parse(JSON.parse(raw));
    } catch {
      throw new TaskStoreError("corrupt", "Invalid cold export; originals preserved");
    }
    if (
      bundle.id !== id ||
      bundle.snapshot.archives.length ||
      bundle.snapshot.tasks.some((t) => t.armed || !["resolved", "cancelled", "expired"].includes(t.state)) ||
      bundle.snapshot.occurrences.some((o) => !o.resolution) ||
      bundle.snapshot.intents.some((i) => ["pending", "unknown"].includes(i.state) || i.temp_cleanup_pending) ||
      bundle.snapshot.leases.some((l) => l.state === "active")
    )
      throw new TaskStoreError("corrupt", "Invalid terminal cold export");
    const snapshot = bundle.snapshot,
      entry = {
        id,
        hash: taskArchiveHash(raw),
        actor,
        at: Date.now(),
        task_ids: snapshot.tasks.map((t) => t.id),
        intent_keys: snapshot.intents.map((i) => archiveIntentKey(i.actor, i.idempotency_key)),
        owner_domains: [
          ...new Set([
            ...snapshot.tasks.flatMap((t) => t.owner_domains),
            ...snapshot.proposals.flatMap((p) => p.required_domains),
            ...snapshot.events.flatMap((e) => e.owner_domains),
            ...snapshot.sources.flatMap((s) => s.owner_domains),
          ]),
        ],
      };
    // Validate the same indexed format used by ordinary reads.
    await readTaskArchive(path, entry);
    result.push({ entry, snapshot });
  }
  return result;
}
