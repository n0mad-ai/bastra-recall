/** Versioned, fail-closed commitment snapshots; no transport or action authority. */
import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, open, readFile, unlink, copyFile, chmod } from "node:fs/promises";
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
  for (const row of out.history) row.reason = cleanText(row.reason);
  if (out.decision) {
    out.decision.option = cleanText(out.decision.option); out.decision.reason = cleanText(out.decision.reason);
    out.decision.premise = cleanText(out.decision.premise); out.decision.alternatives = out.decision.alternatives.map(cleanText);
  }
  return taskSchema.parse(out);
}

async function atomicWrite(path: string, payload: string, assertOwnership: () => void): Promise<void> {
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
    const next = structuredClone(store);
    mutate(next);
    next.tasks = next.tasks.map(cleanTask);
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
    await atomicWrite(`${path}.backup`, JSON.stringify(store), assertOwnership);
    await atomicWrite(path, payload, assertOwnership);
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
    try { await copyFile(path, quarantine); await chmod(quarantine, 0o600); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") quarantine = null; else throw err; }
    backup.recovery_history.push({ id: randomUUID(), at: Date.now(), from_revision: backup.revision, actor, reason: "Explicit backup recovery; original quarantined when present" });
    backup.revision++;
    backup.recovery_epoch = randomUUID(); // pre-recovery revision tokens cannot match
    for (const task of backup.tasks) {
      task.armed = false;
      task.review_reason = "Recovered snapshot requires owner review";
    }
    const payload = JSON.stringify(taskStoreSchema.parse(backup));
    if (Buffer.byteLength(payload) > TASK_MAX_BYTES) throw new TaskStoreError("capacity", "recovery snapshot exceeds hard limit; original preserved");
    await atomicWrite(path, payload, assertOwnership);
    return { store: backup, quarantine };
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
    case "rearm": next.state = "pending"; next.armed = false; next.generation++; next.review_reason = "Owner review required before arming"; break;
  }
  if (["resolve", "cancel", "rearm"].includes(operation)) delete next.snoozed_until;
  next.revision++; next.updated_at = now;
  next.history.push({ at: now, actor, operation, before_revision: task.revision, after_revision: next.revision, reason: operation });
  return taskSchema.parse(next);
}
