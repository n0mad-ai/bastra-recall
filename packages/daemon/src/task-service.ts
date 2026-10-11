/** Canonical CRUD contract. Transport input never supplies a trusted principal. */
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
export const TASK_CRUD_OPERATIONS = ["task_create", "task_list", "task_get", "task_review", "task_edit", "task_snooze", "task_acknowledge", "task_resolve", "task_cancel", "task_rearm"] as const;
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
export interface TaskServiceContext { path: string; authPath: string; now?: () => number }
/** Resolve fresh credential mapping here for HTTP, MCP and CLI alike. */
export async function callTaskCrud(ctx: TaskServiceContext, authorization: string | undefined,
  operation: TaskCrudOperation, raw: unknown): Promise<unknown> {
  const principal = await authenticateTask(authorization, ctx.authPath);
  const now = (ctx.now ?? Date.now)();
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
    const input = taskCreateInputSchema.parse(raw); requireTaskDomains(principal, input.owner_domains);
    if (input.arm) requireTaskOwner(principal);
    if (input.arm && input.action_level === "execute") throw new TaskServiceError("conflict", "execute monitoring requires action review");
    const id = hash({ actor: principal.actor_id, key: input.idempotency_key });
    const creationHash = hash(input);
    const store = await transactTaskStore(ctx.path, undefined, s => {
      const existing = s.tasks.find(t => t.id === id);
      if (existing) {
        requireTaskDomains(principal, existing.owner_domains);
        if (existing.creation_hash !== creationHash) throw new TaskServiceError("conflict", "idempotency key already has a different request");
        return;
      }
      const { idempotency_key: _key, arm, ...values } = input;
      s.tasks.push(taskSchema.parse({ ...values, id, creation_hash: creationHash, revision: 0, generation: 0,
        created_at: now, updated_at: now, creator: principal.actor_id, actor: principal.actor_id,
        request_source: principal.role === "owner" ? "owner-command" : "agent-proposal", reference_at: now,
        state: "pending", armed: arm, review_reason: arm ? undefined : "Explicit owner review required",
        history: [{ at: now, actor: principal.actor_id, operation: "create", before_revision: 0, after_revision: 0, reason: "create" }],
      }));
    });
    return view(store, findTask(store, id, principal));
  }
  const input = operation === "task_edit" ? editInput.parse(raw)
    : operation === "task_review" ? mutationInput.parse(raw) : lifecycleInput.parse(raw);
  const store = await transactTaskStore(ctx.path, undefined, s => {
    const task = findTask(s, input.id, principal);
    if (taskRevision(s, task) !== input.expected_revision) throw new TaskStoreError("conflict", "task revision changed or recovered");
    if (operation === "task_edit") {
      const patch = editInput.parse(input).patch;
      if (principal.role !== "owner" && (task.creator !== principal.actor_id || task.armed || task.state !== "pending"))
        requireTaskOwner(principal);
      if (patch.owner_domains) requireTaskDomains(principal, patch.owner_domains);
      Object.assign(task, patch); task.armed = false; task.review_reason = "Edited binding requires explicit owner review";
      audit(task, principal, "edit", now);
      taskSchema.parse(task);
      return;
    }
    if (operation === "task_review") {
      requireTaskOwner(principal);
      if (["resolved", "cancelled", "expired"].includes(task.state)) throw new TaskServiceError("conflict", "terminal task requires rearm first");
      if (task.action_level === "execute") throw new TaskServiceError("conflict", "execute monitoring requires action review");
      task.armed = true; delete task.review_reason; audit(task, principal, "review", now); return;
    }
    const op = operation.slice(5) as TaskLifecycleOperation;
    if (["acknowledge", "resolve", "rearm"].includes(op)) requireTaskOwner(principal);
    const args = lifecycleInput.parse(input);
    const relevant = s.occurrences.filter(o => o.task_id === task.id && o.generation === task.generation);
    if (op === "acknowledge") {
      if (!args.occurrence_id) throw new TaskServiceError("validation", "acknowledgement requires occurrence_id");
      const occurrence = relevant.find(o => o.id === args.occurrence_id);
      if (!occurrence) throw new TaskServiceError("not_found", "occurrence absent in current generation");
      occurrence.acknowledgement ??= { at: now, actor: principal.actor_id, proof_id: principal.credential_id };
    }
    if (op === "resolve") for (const o of relevant) o.resolution ??= { at: now, actor: principal.actor_id, reason: "Explicit owner resolution" };
    const next = transitionTask(task, op, principal.actor_id, now, args.until);
    s.tasks[s.tasks.indexOf(task)] = next;
  }, operation === "task_edit" || operation === "task_review" || operation === "task_rearm" ? "normal" : "control");
  return view(store, findTask(store, input.id, principal));
}
