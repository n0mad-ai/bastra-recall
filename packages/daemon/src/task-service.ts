import { taskStatus, taskControls, taskStatusInput, taskControlsInput } from "./task-status.js";
import { callTaskAction, TASK_ACTION_INPUTS } from "./task-actions.js";
import type { ApprovalRegistry } from "./task-approval-keys.js";
/** Canonical CRUD contract. Transport input never supplies a trusted principal. */
import { reconsiderTask, taskReconsiderInput, taskDecisionStatus, checkTaskDecisions } from "./task-reconsideration.js";
import { taskDueInput, taskDueProjection, recordTaskDelivery, cachedTaskSnapshot } from "./task-outbox.js";
import { requestTaskReconciliation } from "./task-runtime-signal.js";
import { assessTaskFreshness, type TaskMemorySnapshot } from "./task-freshness.js";
import { taskValueHash, observeTaskSources, registerTaskSource, submitTaskEvent, taskEventInput, taskSourceInput, reconcileTaskTime } from "./task-events.js";
import { resolveTaskCalendar } from "./task-clock.js";
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
  idempotency_key: identity, arm: z.boolean().default(false),
  sensitivity: fields.sensitivity.default("private"),
  action_level: fields.action_level.default("notify"), evidence: fields.evidence.default([]),
  notification_policy: fields.notification_policy.default({ muted: false, retry_interval_ms: 60000, max_attempts: 10 }),
  budget: fields.budget.default({ poll_interval_ms: 60000, timeout_ms: 1000, max_source_bytes: 1024 * 1024 }),
});
const getInput = z.strictObject({ id: identity });
const mutationInput = getInput.extend({ expected_revision: token });
const editInput = mutationInput.extend({ patch: editableSchema.partial().refine(p => Object.keys(p).length > 0) });
const lifecycleInput = mutationInput.extend({ until: instant.optional(), occurrence_id: identity.optional() });
export const TASK_CRUD_OPERATIONS = ["task_status", "task_controls", "task_prepare", "task_proposal", "task_challenge", "task_approval", "task_revoke_approval", "task_lease", "task_release", "task_reconsider", "task_due", "task_source_register", "task_event", "task_reconcile", "task_create", "task_list", "task_get", "task_review", "task_edit", "task_snooze", "task_acknowledge", "task_resolve", "task_cancel", "task_rearm"] as const;
export type TaskCrudOperation = typeof TASK_CRUD_OPERATIONS[number];
export class TaskServiceError extends Error {
  constructor(public readonly code: "not_found" | "validation" | "conflict", message: string) {
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
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function validateEventBinding(store: TaskStore, schedule: Extract<Task["schedule"], {kind: "event"}>, domains: string[]): void {
  const source = store.sources.find(s => s.id === schedule.source_id && s.enabled);
  if (!source || !source.owner_domains.every(d => domains.includes(d)) || !schedule.expected_hash)
    throw new TaskServiceError("validation", "Registered source and an exact owner-reviewed baseline are required");
}
function normalizeSchedule(schedule: Task["schedule"]): void {
  if (schedule.kind === "event") schedule.expected_hash = schedule.predicate === "content-version" && /^[a-f0-9]{64}$/.test(schedule.expected)
    ? schedule.expected : taskValueHash(schedule.expected);
  if (schedule.kind === "calendar") {
    try { Object.assign(schedule, resolveTaskCalendar(schedule.local_time, schedule.timezone)); }
    catch { throw new TaskServiceError("validation", "Calendar wall time is invalid or in a DST gap"); }
  }
}
export interface TaskServiceContext { path: string; authPath: string; now?: () => number; memoryRead?: (id: string) => Promise<TaskMemorySnapshot>; memoryChange?: (id: string, revision: string, body: string, changeId: string, expectedHash?: string, updatedDate?: string) => Promise<string>; approvalRegistry?: Promise<ApprovalRegistry | undefined>; actionClock?: () => { boot_id: string; monotonic: number }; memorySubscribe?: (listener: (id: string) => void) => () => void }
/** Resolve fresh credential mapping here for HTTP, MCP and CLI alike. */
async function callTaskCrudInner(ctx: TaskServiceContext, authorization: string | undefined,
  operation: TaskCrudOperation, raw: unknown): Promise<unknown> {
  const principal = await authenticateTask(authorization, ctx.authPath);
  const now = (ctx.now ?? Date.now)();
  if (operation === "task_status") return taskStatus(ctx, authorization, raw);
  if (operation === "task_controls") return taskControls(ctx, authorization, raw);
  if (Object.hasOwn(TASK_ACTION_INPUTS, operation)) return callTaskAction(ctx, authorization, operation as keyof typeof TASK_ACTION_INPUTS, raw);
  if (operation === "task_reconsider") return reconsiderTask(ctx, authorization, raw);
  if (operation === "task_due") {
    const input = taskDueInput.parse(raw);
    let store = cachedTaskSnapshot(ctx.path) ?? await readTaskStore(ctx.path);
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
    normalizeSchedule(input.schedule);
    requireTaskDomains(principal, input.owner_domains);
    if (input.arm) requireTaskOwner(principal);
    if (input.arm && input.action_level === "execute" && !(await ctx.approvalRegistry)?.protected_boundary) throw new TaskServiceError("conflict", "execute monitoring requires protected owner configuration");
    const id = hash({ actor: principal.actor_id, key: input.idempotency_key });
    const creationHash = hash(input);
    const store = await transactTaskStore(ctx.path, undefined, async s => {
      const existing = s.tasks.find(t => t.id === id);
      if (existing) {
        requireTaskDomains(principal, existing.owner_domains);
        if (existing.creation_hash !== creationHash) throw new TaskServiceError("conflict", "idempotency key already has a different request");
        return;
      }
      const { idempotency_key: _key, arm, ...values } = input;
      if (arm && values.schedule.kind === "event") validateEventBinding(s, values.schedule, values.owner_domains);
      const task = taskSchema.parse({ ...values, id, creation_hash: creationHash, revision: 0, generation: 0,
        last_event_sequence: s.events.at(-1)?.sequence ?? 0, created_at: now, updated_at: now, creator: principal.actor_id, actor: principal.actor_id,
        request_source: principal.role === "owner" ? "owner-command" : "agent-proposal", reference_at: now,
        state: "pending", armed: arm, review_reason: arm ? undefined : "Explicit owner review required",
        history: [{ at: now, actor: principal.actor_id, operation: "create", before_revision: 0, after_revision: 0, reason: "create" }],
      });
      if (arm && await taskDecisionStatus(ctx, task)) throw new TaskStoreError("conflict", "decision binding requires review");
      s.tasks.push(task);
    });
    return view(store, findTask(store, id, principal));
  }
  const input = operation === "task_edit" ? editInput.parse(raw)
    : operation === "task_review" ? mutationInput.parse(raw) : lifecycleInput.parse(raw);
  const store = await transactTaskStore(ctx.path, undefined, async s => {
    const task = findTask(s, input.id, principal);
    if (taskRevision(s, task) !== input.expected_revision) throw new TaskStoreError("conflict", "task revision changed or recovered");
    if (operation === "task_edit") {
      const patch = editInput.parse(input).patch;
      if (patch.schedule) normalizeSchedule(patch.schedule);
      if (principal.role !== "owner" && (task.creator !== principal.actor_id || task.armed || task.state !== "pending"))
        requireTaskOwner(principal);
      if (patch.owner_domains) requireTaskDomains(principal, patch.owner_domains);
      const triggerChanged = ["schedule", "timezone", "recurrence", "decision", "evidence", "owner_domains", "scope", "action_level"]
        .some(key => key in patch && canonical(patch[key as keyof typeof patch]) !== canonical(task[key as keyof Task]));
      Object.assign(task, patch);
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
      if (task.action_level === "execute" && !(await ctx.approvalRegistry)?.protected_boundary) throw new TaskServiceError("conflict", "execute monitoring requires protected owner configuration");
      if (task.schedule.kind === "event") validateEventBinding(s, task.schedule, task.owner_domains);
      if (await taskDecisionStatus(ctx, task)) throw new TaskStoreError("conflict", "decision binding requires review");
      task.last_event_sequence = s.events.at(-1)?.sequence ?? 0;
      task.armed = true; delete task.agent_snooze_deadline; delete task.review_reason; audit(task, principal, "review", now); return;
    }
    const op = operation.slice(5) as TaskLifecycleOperation;
    if (["acknowledge", "resolve", "rearm"].includes(op)) requireTaskOwner(principal);
    const args = lifecycleInput.parse(input);
    if (op === "snooze" && principal.role === "agent") {
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
    if (op === "resolve") for (const o of relevant) o.resolution ??= { at: now, actor: principal.actor_id, reason: "Explicit owner resolution" };
    const next = transitionTask(task, op, principal.actor_id, now, args.until);
    if (op === "rearm") next.last_event_sequence = s.events.at(-1)?.sequence ?? 0;
    s.tasks[s.tasks.indexOf(task)] = next;
  }, operation === "task_edit" || operation === "task_review" || operation === "task_rearm" ? "normal" : "control");
  return view(store, findTask(store, input.id, principal));
}

export const TASK_INPUT_SCHEMAS = { task_status: taskStatusInput, task_controls: taskControlsInput, ...TASK_ACTION_INPUTS,
  task_reconsider: taskReconsiderInput, task_due: taskDueInput, task_source_register: taskSourceInput, task_event: taskEventInput, task_reconcile: z.strictObject({}),
  task_create: taskCreateInputSchema, task_list: z.strictObject({}), task_get: getInput,
  task_review: mutationInput, task_edit: editInput, task_snooze: lifecycleInput,
  task_acknowledge: lifecycleInput, task_resolve: lifecycleInput, task_cancel: lifecycleInput, task_rearm: lifecycleInput,
};

export async function callTaskCrud(ctx: TaskServiceContext, authorization: string | undefined,
  operation: TaskCrudOperation, raw: unknown): Promise<unknown> {
  const result = await callTaskCrudInner(ctx, authorization, operation, raw);
  requestTaskReconciliation(ctx.path); // queue work; never evaluate sources on a caller's hot path
  return result;
}
