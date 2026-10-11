import { canonicalTaskValue } from "./task-canonical.js";
/** Versioned, fail-closed commitment snapshots; no transport or action authority. */
import { publishTaskSnapshot } from "./task-runtime-signal.js";
import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, open, readFile, unlink, copyFile, chmod, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { redactSecrets, scrubInjectedBlocks } from "@bastra-recall/core/scrub";
import { withPathLock } from "./path-lock.js";
import { emptyTaskStore, taskStoreSchema, taskSchema, TASK_MAX_BYTES, type TaskStore, type Task } from "./task-schema.js";

export class TaskStoreError extends Error {
  constructor(public readonly code: "corrupt" | "unsupported_version" | "conflict" | "capacity" | "invalid_backup", message: string) {
    super(message); this.name = "TaskStoreError";
  }
}

export function tasksPath(): string {
  return resolve(process.env.BASTRA_TASKS_PATH ?? join(homedir(), ".bastra", "proactive-tasks.json"));
}

export function decodeTaskStore(raw: string): TaskStore {
  if (Buffer.byteLength(raw) > TASK_MAX_BYTES) throw new TaskStoreError("capacity", "task snapshot exceeds its hard limit; original preserved");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new TaskStoreError("corrupt", "invalid task JSON; original preserved"); }
  if (typeof value === "object" && value !== null && "schema_version" in value && value.schema_version !== 1)
    throw new TaskStoreError("unsupported_version", "unsupported task schema; original preserved");
  const parsed = taskStoreSchema.safeParse(value);
  if (!parsed.success) throw new TaskStoreError("corrupt", "invalid task schema or references; original preserved");
  return parsed.data;
}

export async function readTaskStore(path = tasksPath()): Promise<TaskStore> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyTaskStore();
    throw err;
  }
  return decodeTaskStore(raw);
}

/** Private text is scrubbed, while opaque IDs/revisions keep exact identity. */
function cleanText(value: string): string {
  return redactSecrets(scrubInjectedBlocks(value).text, homedir()).text
    .replace(/[\p{Cc}\p{Cf}]/gu, c => c === "\n" ? c : "");
}

function cleanTask(task: Task): Task {
  const out = structuredClone(task);
  for (const key of ["original_request", "goal", "resolution_condition"] as const) out[key] = cleanText(out[key]);
  if (out.review_reason) out.review_reason = cleanText(out.review_reason);
  if (out.last_failure) out.last_failure.message = cleanText(out.last_failure.message);
  if (out.schedule.kind === "event") out.schedule.expected = cleanText(out.schedule.expected);
  for (const row of out.history) row.reason = cleanText(row.reason);
  if (out.decision) {
    out.decision.option = cleanText(out.decision.option); out.decision.reason = cleanText(out.decision.reason);
    out.decision.premise = cleanText(out.decision.premise); out.decision.alternatives = out.decision.alternatives.map(cleanText);
  }
  return taskSchema.parse(out);
}

function cleanStore(store: TaskStore): TaskStore {
  const next = structuredClone(store);
  next.tasks = next.tasks.map(cleanTask);
  for (const event of next.events) event.value = cleanText(event.value);
  for (const occurrence of next.occurrences) {
    occurrence.why = cleanText(occurrence.why);
    if (occurrence.resolution) occurrence.resolution.reason = cleanText(occurrence.resolution.reason);
  }
  for (const recovery of next.recovery_history) recovery.reason = cleanText(recovery.reason);
  return taskStoreSchema.parse(next);
}

/** Enforce audit/lifecycle even for internal callers without a snapshot token. */
function assertTaskProgress(before: TaskStore, after: TaskStore): void {
  for (const old of before.tasks) {
    const next = after.tasks.find(t => t.id === old.id);
    if (!next) throw new TaskStoreError("conflict", "task deletion requires an explicit archive path");
    if (next.revision < old.revision || next.generation < old.generation)
      throw new TaskStoreError("conflict", "task revision/generation cannot go backwards");
    if (canonicalTaskValue(next.history.slice(0, old.history.length)) !== canonicalTaskValue(old.history))
      throw new TaskStoreError("conflict", "task audit history is append-only");
    if (canonicalTaskValue(next) === canonicalTaskValue(old)) continue;
    if (next.revision <= old.revision || next.history.length <= old.history.length)
      throw new TaskStoreError("conflict", "task changes require a newer revision and appended audit");
    const rearm = next.generation === old.generation + 1 && !next.armed && next.history.at(-1)?.operation === "rearm";
    const editedGeneration = next.generation === old.generation + 1 && !next.armed && next.history.at(-1)?.operation === "edit";
    if (next.generation !== old.generation && !rearm && !editedGeneration)
      throw new TaskStoreError("conflict", "generation changes require explicit unarmed re-arm");
    if (["resolved", "cancelled", "expired"].includes(old.state) && (next.state !== old.state || next.armed) && !rearm)
      throw new TaskStoreError("conflict", "terminal task cannot silently re-arm");
  }
}

export async function atomicWrite(path: string, payload: string, assertOwnership: () => void): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(payload, "utf8"); await handle.sync(); await handle.close();
    assertOwnership();
    // Strict live-owner lock cannot be age-displaced; no await before commit.
    renameSync(tmp, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
  }
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export type TaskMutationKind = "normal" | "control";
/** Caller cannot execute effects here: only a validated, revisioned snapshot. */
export async function transactTaskStore(
  path: string, expectedRevision: Pick<TaskStore, "revision" | "recovery_epoch"> | undefined,
  mutate: (store: TaskStore) => void, kind: TaskMutationKind = "normal",
): Promise<TaskStore> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withPathLock(path, async assertOwnership => {
    const store = await readTaskStore(path);
    if (expectedRevision !== undefined && (store.revision !== expectedRevision.revision || store.recovery_epoch !== expectedRevision.recovery_epoch))
      throw new TaskStoreError("conflict", "task store revision changed");
    const draft = structuredClone(store);
    mutate(draft);
    const next = cleanStore(draft);
    assertTaskProgress(store, next);
    if (JSON.stringify(next) === JSON.stringify(store)) return store;
    next.revision = store.revision + 1;
    next.recovery_epoch = store.recovery_epoch;
    if (kind === "normal" && next.tasks.some(t => t.history.length > 9900))
      throw new TaskStoreError("capacity", "task history reserve reached; control operations remain available");
    const validated = taskStoreSchema.parse(next);
    const payload = JSON.stringify(validated);
    const limit = kind === "control" ? TASK_MAX_BYTES : TASK_MAX_BYTES * 0.75;
    if (Buffer.byteLength(payload) > limit)
      throw new TaskStoreError("capacity", "task capacity reached; pending work preserved");
    // Preserve last valid snapshot before replacing it; never back up corruption.
    // Absence has no recoverable predecessor; do not advertise an empty backup.
    let present = true;
    try { await stat(path); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") present = false; else throw err; }
    if (present) await atomicWrite(`${path}.backup`, JSON.stringify(store), assertOwnership);
    await atomicWrite(path, payload, assertOwnership);
    publishTaskSnapshot(path, validated);
    return validated;
  }, { strictLocal: true });
}

/** Explicit recovery only; invalid backups cannot replace recoverable originals. */
export async function recoverTaskStore(path: string, actor: string): Promise<{ store: TaskStore; quarantine: string | null }> {
  return withPathLock(path, async assertOwnership => {
    let backup: TaskStore;
    try { backup = decodeTaskStore(await readFile(`${path}.backup`, "utf8")); }
    catch { throw new TaskStoreError("invalid_backup", "backup is absent or invalid; original preserved"); }
    let quarantine: string | null = `${path}.corrupt-${randomUUID()}`;
    try {
      await copyFile(path, quarantine); await chmod(quarantine, 0o600);
      const original = await open(quarantine, "r");
      try { await original.sync(); } finally { await original.close(); }
    }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") quarantine = null; else throw err; }
    backup.recovery_history.push({ id: randomUUID(), at: Date.now(), from_revision: backup.revision, actor, reason: "Explicit backup recovery; original quarantined when present" });
    backup.revision++;
    backup.recovery_epoch = randomUUID(); // pre-recovery revision tokens cannot match
    for (const task of backup.tasks) {
      task.armed = false;
      task.review_reason = "Recovered snapshot requires owner review";
    }
    const cleaned = cleanStore(backup);
    const payload = JSON.stringify(cleaned);
    if (Buffer.byteLength(payload) > TASK_MAX_BYTES) throw new TaskStoreError("capacity", "recovery snapshot exceeds hard limit; original preserved");
    await atomicWrite(path, payload, assertOwnership);
    publishTaskSnapshot(path, cleaned);
    return { store: cleaned, quarantine };
  }, { strictLocal: true });
}

export type TaskLifecycleOperation = "snooze" | "acknowledge" | "resolve" | "cancel" | "rearm";
/** Internal lifecycle primitive. Authorization and signed-proof validation belong
 * to the shared service; callers cannot equate delivery with this operation. */
export function transitionTask(task: Task, operation: TaskLifecycleOperation, actor: string, now: number, snoozedUntil?: number): Task {
  const next = structuredClone(task);
  const terminal = ["resolved", "cancelled", "expired"].includes(task.state);
  if (terminal && operation !== "rearm") throw new TaskStoreError("conflict", "terminal task requires explicit re-arm");
  switch (operation) {
    case "acknowledge": break; // occurrence receipt is recorded separately by service
    case "snooze":
      if (snoozedUntil === undefined || snoozedUntil <= now) throw new TaskStoreError("conflict", "snooze requires a future instant");
      next.state = "snoozed"; next.snoozed_until = snoozedUntil; break;
    case "resolve": next.state = "resolved"; next.armed = false; break;
    case "cancel": next.state = "cancelled"; next.armed = false; break;
    case "rearm": delete next.agent_snooze_deadline; delete next.last_material_hash; delete next.last_event_sequence; delete next.slots_checked; delete next.next_slot; next.state = "pending"; next.armed = false; next.generation++; next.review_reason = "Owner review required before arming"; break;
  }
  if (["resolve", "cancel", "rearm"].includes(operation)) delete next.snoozed_until;
  next.revision++; next.updated_at = now;
  next.history.push({ at: now, actor, operation, before_revision: task.revision, after_revision: next.revision, reason: operation });
  return taskSchema.parse(next);
}
