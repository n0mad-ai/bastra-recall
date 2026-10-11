import { privateTaskComparison } from "./task-private-comparison.js";
import { canonicalTaskValue } from "./task-canonical.js";
/** C-096: revision-bound reconsideration, never automatic decision inversion. */
import { z } from "zod";
import matter from "gray-matter";
import { createHash } from "node:crypto";
import { authenticateTask, requireTaskOwner } from "./task-auth.js";
import { taskIdentitySchema, type Task, type TaskStore } from "./task-schema.js";
import { TaskStoreError, cleanText, transactTaskStore } from "./task-store.js";
import type { TaskServiceContext } from "./task-service.js";
const digest = (value: unknown) => createHash("sha256").update(canonicalTaskValue(value)).digest("hex");
export const taskReconsiderInput = z.strictObject({
  id: taskIdentitySchema, expected_revision: z.string().regex(/^[a-z0-9._-]+:\d+$/), occurrence_id: taskIdentitySchema,
  choice: z.enum(["keep", "change", "snooze", "stop"]), until: z.number().int().nonnegative().safe().optional(),
  change: z.strictObject({ idempotency_key: taskIdentitySchema, expected_memory_revision: z.string().min(1).max(160),
    body: z.string().min(1).max(16384), option: z.string().min(1).max(4096), reason: z.string().min(1).max(4096) }).optional(),
}).superRefine((input, ctx) => {
  if ((input.choice === "change") !== !!input.change || (input.choice === "snooze") !== (input.until !== undefined))
    ctx.addIssue({ code: "custom", message: "choice requires its matching arguments" });
});
function audit(task: Task, actor: string, operation: string, now: number, snapshot = false) {
  const before = task.revision++; task.updated_at = now;
  task.history.push({ at: now, actor, operation, before_revision: before, after_revision: task.revision, reason: operation,
    ...(snapshot && task.decision ? { decision_snapshot: { decision: structuredClone(task.decision), evidence: structuredClone(task.evidence) } } : {}) });
}
export async function taskDecisionStatus(ctx: TaskServiceContext, task: Task): Promise<string | undefined> {
  if (!task.decision) return undefined;
  if (!ctx.memoryRead) return "decision_reader_unavailable";
  try {
    for (const [id, revision] of [[task.decision.id, task.decision.revision], [task.decision.assumption_id, task.decision.assumption_revision]]) {
      const snapshot = await ctx.memoryRead(id!);
      if (snapshot.id !== id || snapshot.revision !== revision) return "decision_binding_revised";
      if ((task.sensitivity === "public" && snapshot.sensitivity !== "public") || (task.sensitivity !== "restricted" && snapshot.sensitivity === "restricted")) return "decision_sensitivity_changed";
      const fm = matter(snapshot.raw).data;
      if (fm.superseded_by || ["cancelled", "canceled", "superseded", "archived", "expired"].includes(String(fm.status))) return "decision_binding_inactive";
    }
    return undefined;
  } catch { return "decision_binding_unavailable"; }
}
/** Called under the strict store lock immediately before evaluation. Bounded reads. */
export async function checkTaskDecisions(ctx: TaskServiceContext, store: TaskStore): Promise<void> {
  const started = Date.now(); let count = 0;
  for (const task of store.tasks) {
    if (!task.armed || !task.decision) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reason = ++count > 100 || Date.now() - started >= 5000 ? "decision_check_budget"
      : await Promise.race([taskDecisionStatus(ctx, task), new Promise<string>(resolve => { timer = setTimeout(() => resolve("decision_check_timeout"), task.budget.timeout_ms); })]);
    if (timer) clearTimeout(timer);
    if (!reason) continue;
    task.armed = false; task.review_reason = reason; task.last_failure = { at: (ctx.now ?? Date.now)(), code: reason, message: "Bound decision/assumption requires explicit owner review" };
    audit(task, "task-decision-reader", "decision-disarmed", (ctx.now ?? Date.now)(), true);
  }
}
export function reconsiderationCard(task: Task, occurrence: TaskStore["occurrences"][number], store: TaskStore) {
  if (!task.decision || task.schedule.kind !== "event" || task.schedule.predicate !== "premise") return undefined;
  const event = store.events.find(e => occurrence.event_key === `event:${e.id}`);
  if (!event?.claim) return undefined;
  return { kind: "reconsideration", decision: { ...task.decision, option: task.decision.option.slice(0, 160), reason: task.decision.reason.slice(0, 160), premise: task.decision.premise.slice(0, 160), alternatives: task.decision.alternatives.slice(0, 3).map(a => a.slice(0, 80)) }, old_premise: task.decision.premise.slice(0, 160), new_premise: occurrence.new_premise?.slice(0, 160),
    new_evidence: { id: event.claim.evidence_id, revision: event.claim.evidence_revision, observed_at: event.observed_at, state_updated_at: event.state_updated_at },
    old_evidence: task.evidence.slice(0, 3), uncertainty: "A verified premise change invites review; no replacement has been chosen", choices: ["keep", "change", "snooze", "stop"] };
}
export async function reconsiderTask(ctx: TaskServiceContext, authorization: string | undefined, raw: unknown) {
  const input = taskReconsiderInput.parse(raw); const principal = await authenticateTask(authorization, ctx.authPath); requireTaskOwner(principal);
  if (input.change) { input.change.option = cleanText(input.change.option); input.change.reason = cleanText(input.change.reason); }
  const now = (ctx.now ?? Date.now)();
  const changeId = input.change && digest(["decision-change-v1", principal.actor_id, input.id, input.change.idempotency_key]);
  const bodyHash = input.change && await privateTaskComparison(ctx.path,"decision-body",digest(input.change.body));
  const find = (store: TaskStore) => {
    const task = store.tasks.find(t => t.id === input.id && t.owner_domains.every(d => principal.domains.includes(d)));
    if (!task?.decision) throw Object.assign(new Error("Bound decision absent"), { code: "not_found" });
    const occurrence = store.occurrences.find(o => o.id === input.occurrence_id && o.task_id === task.id && o.generation === task.generation);
    if (!occurrence || !reconsiderationCard(task, occurrence, store)) throw Object.assign(new Error("Reconsideration absent"), { code: "not_found" });
    return { task, occurrence };
  };
  const store = await transactTaskStore(ctx.path, undefined, async s => {
    const { task, occurrence } = find(s);
    if (input.choice === "change" && task.decision_change?.id === changeId) {
      const intent = task.decision_change!;
      if (intent.new_body_hash !== bodyHash || intent.expected_memory_revision !== input.change!.expected_memory_revision || intent.new_option !== input.change!.option || intent.new_reason !== input.change!.reason)
        throw new TaskStoreError("conflict", "change idempotency payload differs");
      return;
    }
    if (`${s.recovery_epoch}:${task.revision}` !== input.expected_revision || !task.armed || occurrence.resolution)
      throw new TaskStoreError("conflict", "reconsideration changed or inactive");
    if (await taskDecisionStatus(ctx, task)) throw new TaskStoreError("conflict", "decision binding changed");
    if (input.choice === "change") {
      if (!ctx.memoryChange || input.change!.expected_memory_revision !== task.decision!.revision) throw new TaskStoreError("conflict", "exact decision revision required");
      const updatedDate = new Date().toISOString().slice(0, 10);
      const snap = await ctx.memoryRead!(task.decision!.id);
      const planned = matter.stringify(input.change!.body, { ...matter(snap.raw).data, updated: updatedDate });
      const newMemoryHash = createHash("sha256").update(planned).digest("hex");
      audit(task, principal.actor_id, "decision-change-intent", now, true);
      task.decision_change = { id: changeId!, actor: principal.actor_id, expected_memory_revision: input.change!.expected_memory_revision, binding_hash: digest([task.generation, task.decision, task.evidence, task.owner_domains]),
        new_body_hash: bodyHash!, new_memory_hash: newMemoryHash, updated_date: updatedDate, new_option: input.change!.option, new_reason: input.change!.reason, status: "pending" };
      task.armed = false; task.review_reason = "Confirmed decision change pending; old watch disarmed";
    } else if (input.choice === "keep") {
      occurrence.resolution = { at: now, actor: principal.actor_id, reason: "Keep original decision for this material event" };
      task.state = "pending"; task.armed = false; task.review_reason = "Kept decision; further premise changes require owner rebinding"; audit(task, principal.actor_id, "decision-keep", now, true);
    } else if (input.choice === "stop") {
      task.armed = false; task.state = "cancelled"; audit(task, principal.actor_id, "decision-stop", now, true);
    } else {
      if (input.until! <= now) throw Object.assign(new Error("future snooze required"), { code: "validation" });
      task.state = "snoozed"; task.snoozed_until = input.until; audit(task, principal.actor_id, "decision-snooze", now);
    }
  }, "control");
  if (input.choice !== "change") return { choice: input.choice, task: find(store).task };
  // Persisted intent precedes memory write. A crash is retryable with the same payload,
  // and the persisted exact planned-byte hash recognizes precisely our prior write.
  const result = await transactTaskStore(ctx.path, undefined, async s => {
    const current = await authenticateTask(authorization, ctx.authPath); requireTaskOwner(current);
    const { task, occurrence } = find(s); const intent = task.decision_change;
    if (!intent || intent.id !== changeId || intent.status === "applied") return;
    if (["cancelled", "resolved", "expired"].includes(task.state)) throw new TaskStoreError("conflict", "decision change was stopped");
    if (intent.binding_hash !== digest([task.generation, task.decision, task.evidence, task.owner_domains])) throw new TaskStoreError("conflict", "decision change binding drifted");
    const revision = await ctx.memoryChange!(task.decision!.id, intent.expected_memory_revision, input.change!.body, intent.id, intent.new_memory_hash, intent.updated_date);
    intent.status = "applied"; intent.resulting_revision = revision;
    occurrence.resolution = { at: now, actor: principal.actor_id, reason: "Owner confirmed new decision revision" };
    task.review_reason = "Decision changed; old binding retained, new monitoring requires owner review";
    audit(task, principal.actor_id, "decision-change-applied", now);
  }, "control");
  return { choice: "change", task: find(result).task, revision: find(result).task.decision_change?.resulting_revision };
}
