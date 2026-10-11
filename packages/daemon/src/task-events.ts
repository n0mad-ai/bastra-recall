import { checkTaskDecisions } from "./task-reconsideration.js";
/** Single task-owned journal and evaluator; no in-memory timer owns work. */
import { verifyTaskEvent, taskBindingHash } from "./task-freshness.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { relative, resolve, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { authenticateTask, requireTaskDomains, requireTaskOwner } from "./task-auth.js";
import { taskSourceSchema, taskIdentitySchema, type TaskStore, type Task } from "./task-schema.js";
import { transactTaskStore, readTaskStore } from "./task-store.js";
import { latestTimeSlot, timeSlot } from "./task-clock.js";
import type { TaskServiceContext } from "./task-service.js";
const exec = promisify(execFile);
export function taskValueHash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export const taskEventInput = z.strictObject({ source_id: taskIdentitySchema, source_revision: z.number().int().nonnegative().safe(),
  claim: z.strictObject({ claim_id: z.string().min(1).max(160), claim_revision: z.string().min(1).max(160), value: z.string().min(1).max(4096), evidence_id: z.string().min(1).max(160), evidence_revision: z.string().min(1).max(160) }).optional(),
  dedup_key: taskIdentitySchema, value: z.string().min(1).max(4096), state_updated_at: z.number().int().nonnegative().safe() });
export const taskSourceInput = z.strictObject(taskSourceSchema.shape).omit({ revision: true, schema_version: true });
export async function registerTaskSource(ctx: TaskServiceContext, authorization: string | undefined, input: unknown) {
  const principal = await authenticateTask(authorization, ctx.authPath); requireTaskOwner(principal);
  const source = taskSourceSchema.parse({ ...taskSourceInput.parse(input), schema_version: 1, revision: 0 }); requireTaskDomains(principal, source.owner_domains);
  if (source.kind !== "event" && source.producer_actor !== "task-source-reader") throw Object.assign(new Error("local adapter requires reserved producer"), { code: "validation" });
  if (source.root) source.root = await realpath(source.root);
  const store = await transactTaskStore(ctx.path, undefined, s => {
    if (s.sources.some(row => row.id === source.id)) throw Object.assign(new Error("source IDs cannot be silently rebound"), { code: "conflict" });
    s.sources.push({ ...source, schema_version: 1, revision: 0 });
  });
  return { source_id: source.id, revision: store.sources.find(s => s.id === source.id)!.revision };
}
export function taskEventKey(source: TaskStore["sources"][number], actor: string, key: string): string {
  return taskValueHash(JSON.stringify(["task-event-v1", source.id, source.revision, source.kind, [...source.owner_domains].sort(), actor, key]));
}
export function findTaskEvent(store: TaskStore, source: TaskStore["sources"][number], actor: string, key: string) {
  const framed = taskEventKey(source, actor, key); const legacy = taskValueHash(`${source.id}:${key}`);
  return store.events.find(e => e.dedup_key === framed)
    ?? store.events.find(e => e.dedup_key === legacy && e.source_id === source.id && e.source_revision === String(source.revision)
      && e.actor === actor && JSON.stringify([...e.owner_domains].sort()) === JSON.stringify([...source.owner_domains].sort()));
}
function appendEvent(store: TaskStore, sourceId: string, actor: string, sourceRevision: number, value: string, key: string, updated: number, now: number): TaskStore["events"][number] {
  const source = store.sources.find(s => s.id === sourceId && s.enabled);
  if (!source || source.producer_actor !== actor || source.revision !== sourceRevision) throw Object.assign(new Error("registered source writer denied"), { code: "forbidden" });
  const value_hash = source.kind === "file" ? value : taskValueHash(value);
  const dedup_key = taskEventKey(source, actor, key);
  const existing = findTaskEvent(store, source, actor, key);
  if (existing) {
    if (existing.value_hash !== value_hash || existing.source_revision !== String(sourceRevision)) throw Object.assign(new Error("dedup key drift"), { code: "conflict" });
    return existing;
  }
  const event = { id: dedup_key, dedup_key, sequence: (store.events.at(-1)?.sequence ?? 0) + 1,
    source_id: source.id, source_revision: String(source.revision), actor, owner_domains: source.owner_domains,
    observed_at: now, state_updated_at: updated, sensitivity: source.sensitivity, value, value_hash };
  store.events.push(event); return event;
}
export async function submitTaskEvent(ctx: TaskServiceContext, authorization: string | undefined, input: unknown) {
  const principal = await authenticateTask(authorization, ctx.authPath); const event = taskEventInput.parse(input);
  let id = "";
  await transactTaskStore(ctx.path, undefined, s => {
    const source = s.sources.find(source => source.id === event.source_id);
    if (!source) throw Object.assign(new Error("unregistered source"), { code: "forbidden" });
    requireTaskDomains(principal, source.owner_domains);
    const claim = event.claim ? { claim_id: event.claim.claim_id, claim_revision: event.claim.claim_revision,
      evidence_id: event.claim.evidence_id, evidence_revision: event.claim.evidence_revision, value_hash: taskValueHash(event.claim.value) } : undefined;
    const existing = findTaskEvent(s, source, principal.actor_id, event.dedup_key);
    if (existing && JSON.stringify(existing.claim) !== JSON.stringify(claim)) throw Object.assign(new Error("claim dedup drift"), { code: "conflict" });
    const appended = appendEvent(s, event.source_id, principal.actor_id, event.source_revision, event.value, event.dedup_key, event.state_updated_at, (ctx.now ?? Date.now)());
    if (claim) appended.claim = claim;
    id = appended.id;
  });
  return { event_id: id };
}
function audit(task: Task, now: number, operation: string): void {
  const before = task.revision++; task.updated_at = now;
  task.history.push({ at: now, actor: "task-source-reader", operation, before_revision: before, after_revision: task.revision, reason: operation });
}
function fire(store: TaskStore, task: Task, key: string, due: number, now: number, missed = 0): void {
  const id = taskValueHash(JSON.stringify(["task-occurrence-v1", task.id, task.generation, [...task.owner_domains].sort(), key]));
  if (store.occurrences.some(o => o.id === id)) return;
  store.occurrences.push({ id, task_id: task.id, task_revision: task.revision, generation: task.generation,
    event_key: key, ...(task.decision && task.schedule.kind === "event" && task.schedule.predicate === "premise" ? { new_premise: task.verification?.refuted_value } : {}), due_at: due, why: "Registered condition is due; evaluation is not a passed measurement gate", missed_count: missed, attempts: [] });
  task.state = "due"; delete task.snoozed_until; audit(task, now, "fire");
}
/** Pure bounded transaction; journal and logical occurrences commit together. */
export function evaluateTaskSnapshot(store: TaskStore, now: number): void {
  if (!store.controls.enabled || !store.tasks.length) return;
  let remaining = 100;
  const start = store.evaluation_cursor % store.tasks.length;
  let visited = 0;
  while (visited < store.tasks.length && remaining > 0) {
    const task = store.tasks[(start + visited++) % store.tasks.length]; remaining--;
    if (!task.armed || ["resolved", "cancelled", "expired"].includes(task.state)
      || (task.state === "snoozed" && task.snoozed_until! > now)) continue;
    if (task.schedule.kind === "event") {
      const before = task.last_event_sequence ?? 0;
      const beforeRevision = task.revision;
      let checked = 0;
      for (const event of store.events) {
        if (event.sequence <= before) continue;
        if (remaining-- <= 0 || checked++ >= 10) break;
        if (task.schedule.source_id !== event.source_id) { task.last_event_sequence = event.sequence; continue; }
        const source = store.sources.find(s => s.id === event.source_id && s.enabled);
        if (!source || !source.owner_domains.every(d => task.owner_domains.includes(d))
          || !event.value_hash || !task.schedule.expected_hash) { task.last_event_sequence = event.sequence; continue; }
        let verification = verifyTaskEvent(task, event, store, now);
        if (verification.reason === "premise_requires_evidence_verifier" || (task.evidence.length && ["verified", "refuted"].includes(verification.outcome))) {
          const cached = task.verification;
          if (!cached || cached.event_id !== event.id || cached.binding_hash !== taskBindingHash(task)
            || cached.state_updated_at === undefined || cached.state_updated_at > now || cached.state_updated_at > cached.observed_at
            || !task.evidence.every(e => store.sources.some(s => s.id === e.source_id && s.enabled) && (e.state_updated_at === undefined || (e.state_updated_at <= now && e.state_updated_at <= e.observed_at)))
            || now - cached.state_updated_at > cached.max_age_ms) {
            if (store.events.some(e => e.source_id === event.source_id && e.sequence > event.sequence)) { task.last_event_sequence = event.sequence; continue; }
            break;
          }
          verification = cached;
        }
        if (!["verified", "refuted"].includes(verification.outcome)) {
          if (store.events.some(e => e.source_id === event.source_id && e.sequence > event.sequence)) { task.last_event_sequence = event.sequence; continue; }
          break; // latest unavailable/inconclusive event stays retryable after recovery
        }
        task.last_event_sequence = event.sequence;
        const materialChanged = task.last_material_hash !== (event.claim?.value_hash ?? event.value_hash);
        task.last_material_hash = event.claim?.value_hash ?? event.value_hash;
        const matches = task.schedule.predicate === "equals" ? verification.outcome === "verified" : verification.outcome === "refuted";
        if (matches && materialChanged) fire(store, task, `event:${event.id}`, event.observed_at, now);
      }
      if (task.last_event_sequence !== before && task.revision === beforeRevision) audit(task, now, "journal-check");
      if (task.state === "snoozed") { task.state = "due"; delete task.snoozed_until; audit(task, now, "unsnooze"); }
      continue;
    }
    try {
      if (task.evidence.length) {
        const verification = task.verification;
        if (!verification || verification.binding_hash !== taskBindingHash(task) || verification.outcome !== "verified"
          || verification.state_updated_at === undefined || verification.state_updated_at > now || verification.state_updated_at > verification.observed_at
          || !task.evidence.every(e => store.sources.some(s => s.id === e.source_id && s.enabled) && (e.state_updated_at === undefined || (e.state_updated_at <= now && e.state_updated_at <= e.observed_at)))
          || now - verification.state_updated_at > verification.max_age_ms) continue;
      }
      // The saved next slot is frozen across restarts/tzdata changes.
      if (task.next_slot && task.next_slot.at > now) continue;
      const latest = latestTimeSlot(task, now);
      if (latest && latest.index >= (task.slots_checked ?? 0)) {
        const slot = task.next_slot?.index === latest.index ? task.next_slot : latest.slot;
        fire(store, task, `time:${slot.key}`, slot.at, now, latest.index - (task.slots_checked ?? 0));
        task.slots_checked = latest.index + 1;
        const next = task.recurrence && (task.recurrence.count === undefined || task.slots_checked < task.recurrence.count)
          ? timeSlot(task, task.slots_checked) : undefined;
        if (next && (task.recurrence?.until === undefined || next.at <= task.recurrence.until)) {
          task.next_slot = { ...next, index: task.slots_checked }; task.next_check_at = next.at;
        } else { delete task.next_slot; delete task.next_check_at; }
      } else if (task.state === "snoozed") { task.state = "due"; delete task.snoozed_until; audit(task, now, "unsnooze"); }
    } catch { if (task.last_failure?.code !== "calendar_gap") { task.armed = false; task.last_failure = { at: now, code: "calendar_gap", message: "Calendar slot needs owner review" }; audit(task, now, "source-failed"); } }
  }
  store.evaluation_cursor = (start + visited) % store.tasks.length;
  const watchers = store.tasks.filter(t => t.armed && t.schedule.kind === "event" && !["resolved", "cancelled", "expired"].includes(t.state));
  const cursor = watchers.length ? Math.min(...watchers.map(t => t.last_event_sequence ?? 0)) : (store.events.at(-1)?.sequence ?? 0);
  store.checkpoint = Math.max(store.checkpoint, cursor);
}
export async function reconcileTaskTime(ctx: TaskServiceContext): Promise<TaskStore> {
  return transactTaskStore(ctx.path, undefined, async s => {
    await checkTaskDecisions(ctx, s);
    evaluateTaskSnapshot(s, (ctx.now ?? Date.now)());
  });
}
/** Registered local paths observe snapshots, not every intermediate write. */
export async function observeTaskSources(ctx: TaskServiceContext, activeOnly = false, allowedSources?: ReadonlySet<string>): Promise<void> {
  const snapshot = await readTaskStore(ctx.path); if (!snapshot.controls.enabled) return;
  let count = 0; const started = Date.now();
  for (const source of snapshot.sources) {
    if (Date.now() - started >= 5000) break;
    if (allowedSources && !allowedSources.has(source.id)) continue;
    if (activeOnly && !snapshot.tasks.some(t => t.armed && !["resolved", "cancelled", "expired"].includes(t.state) && t.schedule.kind === "event" && t.schedule.source_id === source.id)) continue;
    if (!source.enabled || !["file", "git", "memory"].includes(source.kind) || count++ >= 10) continue;
    const now = (ctx.now ?? Date.now)();
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let value: string;
      try {
        value = await Promise.race([(async () => {
      const root = source.kind === "memory" ? "" : await realpath(source.root!);
      if (source.kind !== "memory" && root !== source.root) throw new Error("registered root changed");
      if (source.kind === "memory") {
        if (!ctx.memoryRead) throw new Error("memory reader unavailable");
        const memory = await ctx.memoryRead(source.memory_id!);
        if (memory.sensitivity !== "public" && source.sensitivity === "public") throw new Error("memory sensitivity drift");
        return memory.revision;
      } else if (source.kind === "file") {
        const target = resolve(root, source.path!); const rel = relative(root, target);
        if (rel.startsWith("..") || isAbsolute(rel) || (await lstat(target)).isSymbolicLink() || await realpath(target) !== target) throw new Error("path containment");
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if ((await handle.stat()).size > 1024 * 1024) throw new Error("source byte budget");
          const bytes = Buffer.alloc(1024 * 1024 + 1); const read = await handle.read(bytes, 0, bytes.length, 0);
          if (read.bytesRead > 1024 * 1024) throw new Error("source byte budget");
          return taskValueHash(bytes.subarray(0, read.bytesRead).toString("utf8"));
        }
        finally { await handle.close(); }
      } else {
        const value = (await exec("git", ["-C", root, "rev-parse", "--verify", "--end-of-options", source.ref!], { timeout: 1000, maxBuffer: 4096 })).stdout.trim();
        if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error("invalid git revision");
        return value;
      }

        })(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("source timeout")), Math.min(1000, Math.max(1, 5000 - (Date.now() - started)))); })]);
      } finally { if (timeout) clearTimeout(timeout); }
      await transactTaskStore(ctx.path, undefined, s => {
        const current = s.sources.find(row => row.id === source.id);
        if (!current || !current.enabled || current.revision !== source.revision) return;
        const observed = taskValueHash(value);
        for (const task of s.tasks) if (task.armed && task.schedule.kind === "event" && task.schedule.source_id === source.id && task.last_failure?.code === "source_unavailable") {
          delete task.last_failure; audit(task, now, "source-recovered");
        }
        if (current.last_value_hash === observed) return;
        current.observation_number++;
        appendEvent(s, source.id, "task-source-reader", source.revision, value, String(current.observation_number), now, now);
        current.last_value_hash = observed;
      });
    } catch {
      await transactTaskStore(ctx.path, undefined, s => {
        for (const task of s.tasks) if (task.schedule.kind === "event" && task.schedule.source_id === source.id && task.last_failure?.code !== "source_unavailable") {
          task.last_failure = { at: now, code: "source_unavailable", message: "Registered source cannot be observed" }; audit(task, now, "source-failed");
        }
      }, "control");
    }
  }
}
