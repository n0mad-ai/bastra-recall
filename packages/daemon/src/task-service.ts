import { reminderDuplicate, reminderFingerprint } from "./task-conversation.js";
import { privateContentComparison, privateTaskComparison, publicTaskResult } from "./task-private-comparison.js";
import { recoverTasks,taskRecoverInput } from "./task-maintenance.js";
import { archiveTasks, restoreTaskArchive, archivedTask, taskArchiveInput } from "./task-archive.js";
import { executeTaskAction, TASK_EXECUTION_INPUTS, isTaskExecution } from "./task-execution.js";
import { taskStatus, taskControls, taskStatusInput, taskControlsInput } from "./task-status.js";
import { callTaskAction, TASK_ACTION_INPUTS } from "./task-actions.js";
import type { ApprovalRegistry } from "./task-approval-keys.js";
import { canonicalTaskValue as canonical } from "./task-canonical.js";
/** Canonical CRUD contract. Transport input never supplies a trusted principal. */
import { reconsiderTask, taskReconsiderInput, taskDecisionStatus, checkTaskDecisions } from "./task-reconsideration.js";
import { taskDueInput, taskDueProjection, recordTaskDelivery } from "./task-outbox.js";
import { requestTaskReconciliation } from "./task-runtime-signal.js";
import { assessTaskFreshness, type TaskMemorySnapshot } from "./task-freshness.js";
import { observeTaskSources, registerTaskSource, submitTaskEvent, taskEventInput, taskSourceInput, reconcileTaskTime } from "./task-events.js";
import { ambiguousTaskCalendar, resolveTaskCalendar } from "./task-clock.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { authenticateTask, requireTaskDomains, requireTaskOwner, type TaskPrincipal } from "./task-auth.js";
import { taskIdentitySchema, taskSchema, type Task, type TaskStore } from "./task-schema.js";
import { readTaskStore, transactTaskStore, transitionTask, TaskStoreError, type TaskLifecycleOperation } from "./task-store.js";
const identity = taskIdentitySchema;
const instant = z.number().int().nonnegative().safe();
const token = z.string().regex(/^[a-z0-9._-]+:\d+$/);
const fields = taskSchema.shape;
const editableSchema = z.strictObject({
  original_request: fields.original_request, goal: fields.goal,
  resolution_condition: fields.resolution_condition, schedule: fields.schedule,
  timezone: fields.timezone, scope: fields.scope, sensitivity: fields.sensitivity,
  owner_domains: fields.owner_domains, recurrence: fields.recurrence,
  action_level: fields.action_level, evidence: fields.evidence, decision: fields.decision,
  notification_policy: fields.notification_policy, budget: fields.budget,
});
export const taskCreateInputSchema = editableSchema.extend({
  idempotency_key: identity, arm: z.boolean().default(false), origin: fields.origin,
  sensitivity: fields.sensitivity.default("private"),
  action_level: fields.action_level.default("notify"), evidence: fields.evidence.default([]),
  notification_policy: fields.notification_policy.default({ muted: false, retry_interval_ms: 60000, max_attempts: 10 }),
  budget: fields.budget.default({ poll_interval_ms: 60000, timeout_ms: 1000, max_source_bytes: 1024 * 1024 }),
});
const getInput = z.strictObject({ id: identity });
const mutationInput = getInput.extend({ expected_revision: token });
const editInput = mutationInput.extend({ patch: editableSchema.partial().refine(p => Object.keys(p).length > 0) });
const lifecycleInput = mutationInput.extend({ until: instant.optional(), occurrence_id: identity.optional() });
export const TASK_CRUD_OPERATIONS = ["task_recover", "task_archive", "task_archive_restore", "task_execute", "task_intent_reconcile", "task_rollback_prepare", "task_status", "task_controls", "task_prepare", "task_proposal", "task_challenge", "task_approval", "task_revoke_approval", "task_lease", "task_release", "task_reconsider", "task_due", "task_source_register", "task_event", "task_reconcile", "task_create", "task_list", "task_get", "task_review", "task_edit", "task_snooze", "task_acknowledge", "task_resolve", "task_cancel", "task_rearm"] as const;
export type TaskCrudOperation = typeof TASK_CRUD_OPERATIONS[number];
export class TaskServiceError extends Error {
  constructor(public readonly code: "not_found" | "validation" | "conflict" | "protected_boundary_required", message: string) {
    super(message); this.name = "TaskServiceError";
  }
}
export function taskRevision(store: TaskStore, task: Task): string { return `${store.recovery_epoch}:${task.revision}`; }
function view(store: TaskStore, task: Task) { return { ...task, expected_revision: taskRevision(store, task) }; }
function findTask(store: TaskStore, id: string, principal: TaskPrincipal): Task {
  const task = store.tasks.find(t => t.id === id);
  // Hide even existence from actors without every ownership domain.
  if (!task || !task.owner_domains.every(d => principal.domains.includes(d)))
    throw new TaskServiceError("not_found", "task absent in authorized domains");
  return task;
}
function audit(task: Task, principal: TaskPrincipal, operation: string, now: number): void {
  const previous = task.revision; task.revision++; task.updated_at = now;
  task.history.push({ at: now, actor: principal.actor_id, operation, before_revision: previous, after_revision: task.revision, reason: operation });
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function validateEventBinding(store: TaskStore, schedule: Extract<Task["schedule"], {kind: "event"}>, domains: string[]): void {
  const source = store.sources.find(s => s.id === schedule.source_id && s.enabled);
  if (!source || !source.owner_domains.every(d => domains.includes(d)) || !schedule.expected_hash)
    throw new TaskServiceError("validation", "Registered source and an exact owner-reviewed baseline are required");
}
async function normalizeSchedule(path: string, schedule: Task["schedule"], sourceKind?: string): Promise<void> {
  if (schedule.kind === "event") {
    const supplied = schedule.predicate !== "git-ref" && !["git", "memory"].includes(sourceKind ?? "") && /^[a-f0-9]{64}$/.test(schedule.expected);
    schedule.expected_hash = await privateContentComparison(path, schedule.expected, supplied);
    if (/^[a-f0-9]{64}$/.test(schedule.expected) && !["file", "git", "memory"].includes(sourceKind ?? "")) schedule.expected = "Private content baseline";
  }
  if (schedule.kind === "calendar") {
    try { Object.assign(schedule, resolveTaskCalendar(schedule.local_time, schedule.timezone)); }
    catch (error) { throw Object.assign(new TaskServiceError("validation", "Calendar wall time is invalid or in a DST gap"),{reason:(error as any)?.reason}); }
  }
}
export interface TaskServiceContext { path: string; authPath: string; now?: () => number; memoryRead?: (id: string, budget?: {max_bytes:number;timeout_ms:number}) => Promise<TaskMemorySnapshot>; memoryChange?: (id: string, revision: string, body: string, changeId: string, expectedHash?: string, updatedDate?: string) => Promise<string>; approvalRegistry?: Promise<ApprovalRegistry | undefined>; approvalRegistryPath?: string; executionHost?: boolean; actionClock?: () => { boot_id: string; monotonic: number }; memorySubscribe?: (listener: (id: string) => void) => () => void }
/** Resolve fresh credential mapping here for HTTP, MCP and CLI alike. */
async function callTaskCrudInner(ctx: TaskServiceContext, authorization: string | undefined,
  operation: TaskCrudOperation, raw: unknown): Promise<unknown> {
  const principal = await authenticateTask(authorization, ctx.authPath);
  const now = (ctx.now ?? Date.now)();
  if (isTaskExecution(operation)) return executeTaskAction(ctx, authorization, operation, raw);
  if (operation === "task_recover") return recoverTasks(ctx,authorization,raw);
  if (operation === "task_archive") return archiveTasks(ctx,authorization,raw);
  if (operation === "task_archive_restore") { const input=z.strictObject({archive_id:z.string().uuid()}).parse(raw); return restoreTaskArchive(ctx,authorization,input.archive_id); }
  if (operation === "task_status") return taskStatus(ctx, authorization, raw);
  if (operation === "task_controls") return taskControls(ctx, authorization, raw);
  if (Object.hasOwn(TASK_ACTION_INPUTS, operation)) return callTaskAction(ctx, authorization, operation as keyof typeof TASK_ACTION_INPUTS, raw);
  if (operation === "task_reconsider") return reconsiderTask(ctx, authorization, raw);
  if (operation === "task_due") {
    const input = taskDueInput.parse(raw);
    // Explicit inspection already records a durable attempt; disk is authority.
    // Passive hook attachments retain their no-I/O cached projection.
    let store = await readTaskStore(ctx.path);
    if (store.tasks.some(t => t.armed && t.decision && t.owner_domains.every(d => principal.domains.includes(d))))
      store = await transactTaskStore(ctx.path, undefined, s => checkTaskDecisions(ctx, s));
    const projection = taskDueProjection(store, principal, input, now);
    await recordTaskDelivery(ctx.path, principal, projection.client, projection.occurrenceIds, now, input.session, input.channel);
    const { client: _client, occurrenceIds: _ids, ...result } = projection; return result;
  }
  if (operation === "task_source_register") return registerTaskSource(ctx, authorization, raw);
  if (operation === "task_event") return submitTaskEvent(ctx, authorization, raw);
  if (operation === "task_reconcile") {
    z.strictObject({}).parse(raw); requireTaskOwner(principal);
    const snapshot = await readTaskStore(ctx.path);
    requireTaskDomains(principal, [...new Set(snapshot.tasks.flatMap(t => t.owner_domains))]);
    await observeTaskSources(ctx); await assessTaskFreshness(ctx);
    await reconcileTaskTime(ctx); return { reconciled: true };
  }
  if (operation === "task_list") {
    z.strictObject({}).parse(raw);
    const store = await readTaskStore(ctx.path);
    return { tasks: store.tasks.filter(t => t.owner_domains.every(d => principal.domains.includes(d))).map(t => view(store, t)) };
  }
  if (operation === "task_get") {
    const input = getInput.parse(raw); const store = await readTaskStore(ctx.path);
    return view(store, findTask(store, input.id, principal));
  }
  if (operation === "task_create") {
    const input = taskCreateInputSchema.parse(raw);
    const legacyInput = structuredClone(input);
    if (principal.role === "agent" && input.arm && input.schedule.kind === "calendar" && ambiguousTaskCalendar(input.schedule.local_time, input.schedule.timezone))
      throw new TaskServiceError("validation", "Clarify DST overlap and submit the confirmed exact instant");
    const sourceKind = input.schedule.kind === "event" ? (await readTaskStore(ctx.path)).sources.find(s=>input.schedule.kind === "event" && s.id === input.schedule.source_id)?.kind : undefined;
    await normalizeSchedule(ctx.path, input.schedule, sourceKind);
    if (legacyInput.schedule.kind === "event") legacyInput.schedule.expected_hash = legacyInput.schedule.predicate === "content-version" && /^[a-f0-9]{64}$/.test(legacyInput.schedule.expected)
      ? legacyInput.schedule.expected : createHash("sha256").update(legacyInput.schedule.expected,"utf8").digest("hex");
    else legacyInput.schedule = structuredClone(input.schedule);
    const previousDisplayInput = structuredClone(input);
    if (previousDisplayInput.schedule.kind === "event" && legacyInput.schedule.kind === "event") previousDisplayInput.schedule.expected = legacyInput.schedule.expected;
    requireTaskDomains(principal, input.owner_domains);
    if (input.arm && input.action_level !== "notify") requireTaskOwner(principal);
    if (principal.role === "agent" && input.arm && !input.origin) throw new TaskServiceError("validation", "Conversational arming requires origin, client, session and context");
    if (input.arm && input.action_level === "execute" && !(await ctx.approvalRegistry)?.protected_boundary) throw new TaskServiceError("protected_boundary_required", "execute monitoring requires protected owner configuration");
    const id = hash({ actor: principal.actor_id, key: input.idempotency_key });
    const creationHash = await privateTaskComparison(ctx.path,"create",input);
    let archived: Awaited<ReturnType<typeof archivedTask>>;
    let duplicateId: string | undefined;
    const store = await transactTaskStore(ctx.path, undefined, async s => {
      archived = s.tasks.some(t=>t.id===id) ? undefined : await archivedTask(ctx.path,s,id);
      const existing = s.tasks.find(t => t.id === id) ?? archived?.task;
      if (existing) {
        requireTaskDomains(principal, existing.owner_domains);
        if (existing.creation_hash !== creationHash) {
          // Pre-content-HMAC keyed create identities still prove an exact old retry.
          // Reconstruct only the submitted request, never the stored scrubbed text.
          if (existing.creation_hash !== await privateTaskComparison(ctx.path,"create",legacyInput)
            && existing.creation_hash !== await privateTaskComparison(ctx.path,"create",previousDisplayInput))
            throw new TaskServiceError("conflict", "idempotency key already has a different request");
        }
        return;
      }
      if (principal.role === "agent" && input.action_level === "notify") {
        const duplicate = await reminderDuplicate(ctx.path, s, input, input.schedule.kind === "event" ? [legacyInput,previousDisplayInput] : []);
        if (duplicate) { duplicateId = duplicate.id; return; }
      }
      const { idempotency_key: _key, arm: requestedArm, ...values } = input;
      const limit = principal.role === "agent" && requestedArm && (process.env.BASTRA_CONVERSATIONAL_REMINDERS === "0" || !s.controls.enabled) ? "Conversational reminders disabled; saved unarmed" : undefined;
      const arm = requestedArm && !limit;
      if (arm && values.schedule.kind === "event") validateEventBinding(s, values.schedule, values.owner_domains);
      const task = taskSchema.parse({ ...values, id, creation_hash: creationHash, reminder_fingerprint: await reminderFingerprint(ctx.path, values), revision: 0, generation: 0,
        last_event_sequence: s.events.at(-1)?.sequence ?? 0, created_at: now, updated_at: now, creator: principal.actor_id, actor: principal.actor_id,
        request_source: principal.role === "owner" ? "owner-command" : values.origin?.kind ?? "agent-proposal", reference_at: now,
        state: "pending", armed: arm, review_reason: limit ?? (arm ? undefined : "Explicit owner review required"),
        history: [{ at: now, actor: principal.actor_id, operation: "create", before_revision: 0, after_revision: 0, reason: "create" }],
      });
      if (arm && await taskDecisionStatus(ctx, task)) throw new TaskStoreError("conflict", "decision binding requires review");
      s.tasks.push(task);
    });
    if (duplicateId) return { ...view(store, findTask(store, duplicateId, principal)), duplicate: true };
    return archived && !store.tasks.some(t=>t.id===id) ? {...view(archived.snapshot,archived.task),archived:true,archive_id:archived.entry.id} : view(store, findTask(store, id, principal));
  }
  const input = operation === "task_edit" ? editInput.parse(raw)
    : operation === "task_review" ? mutationInput.parse(raw) : lifecycleInput.parse(raw);
  const store = await transactTaskStore(ctx.path, undefined, async s => {
    const task = findTask(s, input.id, principal);
    if (taskRevision(s, task) !== input.expected_revision) throw new TaskStoreError("conflict", "task revision changed or recovered");
    if (operation === "task_edit") {
      const patch = editInput.parse(input).patch;
      if (principal.role === "agent" && patch.action_level && patch.action_level !== task.action_level) requireTaskOwner(principal);
      if (patch.schedule) {
        const kind = patch.schedule.kind === "event" ? s.sources.find(src=>patch.schedule!.kind === "event" && src.id === patch.schedule!.source_id)?.kind : undefined;
        await normalizeSchedule(ctx.path, patch.schedule, kind);
      }
      if (principal.role !== "owner" && (task.creator !== principal.actor_id || task.armed || task.state !== "pending"))
        requireTaskOwner(principal);
      if (patch.owner_domains) requireTaskDomains(principal, patch.owner_domains);
      const triggerChanged = ["schedule", "timezone", "recurrence", "decision", "evidence", "owner_domains", "scope", "action_level"]
        .some(key => key in patch && canonical(patch[key as keyof typeof patch]) !== canonical(task[key as keyof Task]));
      Object.assign(task, patch); delete task.reminder_fingerprint;
      if (triggerChanged) {
        task.generation++; delete task.snoozed_until; task.last_event_sequence = s.events.at(-1)?.sequence ?? 0; delete task.last_material_hash; delete task.slots_checked; delete task.next_slot;
        if (!["resolved", "cancelled", "expired"].includes(task.state)) task.state = "pending";
      } task.armed = false; task.review_reason = "Edited binding requires explicit owner review";
      audit(task, principal, "edit", now);
      taskSchema.parse(task);
      return;
    }
    if (operation === "task_review") {
      requireTaskOwner(principal);
      if (["resolved", "cancelled", "expired"].includes(task.state)) throw new TaskServiceError("conflict", "terminal task requires rearm first");
      if (task.action_level === "execute" && !(await ctx.approvalRegistry)?.protected_boundary) throw new TaskServiceError("protected_boundary_required", "execute monitoring requires protected owner configuration");
      if (task.schedule.kind === "event") validateEventBinding(s, task.schedule, task.owner_domains);
      if (await taskDecisionStatus(ctx, task)) throw new TaskStoreError("conflict", "decision binding requires review");
      task.last_event_sequence = s.events.at(-1)?.sequence ?? 0;
      task.armed = true; delete task.agent_snooze_deadline; delete task.review_reason; audit(task, principal, "review", now); return;
    }
    const op = operation.slice(5) as TaskLifecycleOperation;
    if (op === "rearm" || (["acknowledge", "resolve"].includes(op) && task.action_level !== "notify")) requireTaskOwner(principal);
    const args = lifecycleInput.parse(input);
    if (op === "snooze" && (args.until === undefined || args.until <= now)) throw Object.assign(new TaskServiceError("validation","Future snooze required"),{reason:"snooze_past"});
    if (op === "snooze" && principal.role === "agent" && task.action_level !== "notify") {
      const ceiling = task.agent_snooze_deadline ?? now + 24 * 60 * 60 * 1000;
      if (args.until === undefined || args.until > ceiling) throw new TaskServiceError("validation", "agent snooze exceeds the fixed 24-hour window");
      task.agent_snooze_deadline = ceiling;
    }
    const relevant = s.occurrences.filter(o => o.task_id === task.id && o.generation === task.generation);
    if (op === "acknowledge") {
      if (!args.occurrence_id) throw new TaskServiceError("validation", "acknowledgement requires occurrence_id");
      const occurrence = relevant.find(o => o.id === args.occurrence_id);
      if (!occurrence) throw new TaskServiceError("not_found", "occurrence absent in current generation");
      occurrence.acknowledgement ??= { at: now, actor: principal.actor_id, proof_id: principal.credential_id };
    }
    if (op === "resolve") for (const o of relevant) o.resolution ??= { at: now, actor: principal.actor_id, reason: principal.role === "owner" ? "Explicit owner resolution" : "Conversational notify resolution" };
    const next = transitionTask(task, op, principal.actor_id, now, args.until);
    if (op === "rearm") next.last_event_sequence = s.events.at(-1)?.sequence ?? 0;
    s.tasks[s.tasks.indexOf(task)] = next;
  }, operation === "task_edit" || operation === "task_review" || operation === "task_rearm" ? "normal" : "control");
  return view(store, findTask(store, input.id, principal));
}

export const TASK_INPUT_SCHEMAS = {task_recover:taskRecoverInput, task_archive: taskArchiveInput, task_archive_restore:z.strictObject({archive_id:z.string().uuid()}), ...TASK_EXECUTION_INPUTS, task_status: taskStatusInput, task_controls: taskControlsInput, ...TASK_ACTION_INPUTS,
  task_reconsider: taskReconsiderInput, task_due: taskDueInput, task_source_register: taskSourceInput, task_event: taskEventInput, task_reconcile: z.strictObject({}),
  task_create: taskCreateInputSchema, task_list: z.strictObject({}), task_get: getInput,
  task_review: mutationInput, task_edit: editInput, task_snooze: lifecycleInput,
  task_acknowledge: lifecycleInput, task_resolve: lifecycleInput, task_cancel: lifecycleInput, task_rearm: lifecycleInput,
};

export async function callTaskCrud(ctx: TaskServiceContext, authorization: string | undefined,
  operation: TaskCrudOperation, raw: unknown): Promise<unknown> {
  const result = await callTaskCrudInner(ctx, authorization, operation, raw);
  requestTaskReconciliation(ctx.path); // queue work; never evaluate sources on a caller's hot path
  return publicTaskResult(result);
}
