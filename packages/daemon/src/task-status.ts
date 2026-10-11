import { taskBindingHash } from "./task-freshness.js";
import { TaskApprovalError, taskActionRegistry, taskApprovalStatus } from "./task-actions.js";
import { z } from "zod";
import { authenticateTask, requireTaskOwner, requireTaskDomains } from "./task-auth.js";
import { readTaskStore, transactTaskStore } from "./task-store.js";
import { taskRuntime } from "./task-runtime.js";
import { taskIdentitySchema as id } from "./task-schema.js";
import type { TaskServiceContext } from "./task-service.js";
export const taskStatusInput = z.strictObject({});
export const taskControlsInput = z.strictObject({ enabled: z.boolean().optional(), muted: z.boolean().optional(), execution_stopped: z.boolean().optional(),
  source: z.strictObject({ id, enabled: z.boolean() }).optional(), adapter: z.strictObject({ id: z.literal("local-artifact-v1"), enabled: z.boolean() }).optional() }).refine(i => Object.keys(i).length > 0);
export async function taskStatus(ctx: TaskServiceContext, authorization: string | undefined, raw: unknown) {
  taskStatusInput.parse(raw); const principal = await authenticateTask(authorization, ctx.authPath), store = await readTaskStore(ctx.path), registry = await ctx.approvalRegistry;
  const tasks = store.tasks.filter(t => t.owner_domains.every(d => principal.domains.includes(d))), job = taskRuntime(ctx.path);
  return { coverage: "next-contact-only", controls: store.controls, role: principal.role, domains: principal.domains,
    tasks: tasks.map(t => ({ ...t, expected_revision: `${store.recovery_epoch}:${t.revision}`, deliveries: store.occurrences.filter(o => o.task_id === t.id && o.generation === t.generation).map(o => ({ occurrence_id: o.id, due_at: o.due_at, acknowledged: !!o.acknowledgement, resolved: !!o.resolution, last_attempt: o.attempts.at(-1)?.at, attempt_count: o.attempts.reduce((n, a) => n + (a.count ?? 1), o.compacted_attempts ?? 0) })) })),
    sources: store.sources.filter(s => s.owner_domains.every(d => principal.domains.includes(d))),
    adapters: registry?.targets.filter(t => t.owner_domains.every(d => principal.domains.includes(d))).map(t => ({ id: t.id, adapter: t.adapter, enabled: store.controls.adapters[t.adapter]?.enabled === true })) ?? [],
    capacity: { intents: store.intents.length, intent_limit: 1000, receipts: store.receipts.length, receipt_limit: 10000, proposals: store.proposals.length, proposal_limit: 1000, review_required: store.intents.filter(i => ["pending", "unknown"].includes(i.state)).length },
    intents: store.intents.filter(i => tasks.some(t => t.id === i.task_id)).slice(-100).map(i => ({ id: i.id, task_id: i.task_id, state: i.state, at: i.created_at, target_id: store.proposals.find(p => p.id === i.proposal_id)?.target_id, before_hash: i.before_hash, after_hash: i.after_hash, review_hint: ["pending", "unknown"].includes(i.state) ? "Abgleich nötig" : undefined })),
    receipts: store.receipts.filter(r => tasks.some(t => t.id === r.task_id)).slice(-100).map(r => ({ id: r.id, intent_id: r.intent_id, task_id: r.task_id, outcome: r.outcome, at: r.at, target_id: store.proposals.find(p => p.id === r.proposal_id)?.target_id, before_hash: r.before_hash, after_hash: r.after_hash, rollback_available: ["succeeded", "reconciled"].includes(r.outcome), review_hint: r.outcome === "unknown" ? "Abgleich nötig" : undefined })),
    proposals: store.proposals.filter(p => tasks.some(t => t.id === p.task_id)).map(p => ({ id: p.id, task_id: p.task_id, status: p.status, target_id: p.target_id, binding_current: tasks.some(t => t.id === p.task_id && t.armed && t.revision === p.task_revision && t.generation === p.generation && taskBindingHash(t) === p.task_binding && store.recovery_epoch === p.recovery_epoch), target_check: "on-demand", required_domains: p.required_domains, ...(registry ? taskApprovalStatus(ctx, store, p, registry) : { approved: false, missing_domains: p.required_domains }) })),
    leases: store.leases.filter(l => tasks.some(t => t.id === l.task_id)).map(l => ({ id: l.id, task_id: l.task_id, state: l.state, fence: l.fence, expires_at: l.expires_at })),
    approval: { configured: !!registry, protected_boundary: registry?.protected_boundary ?? false, enrolled_domains: registry?.keys.filter(k => principal.domains.includes(k.domain)).map(k => k.domain) ?? [] },
    runtime: job ? { running: true, last_tick: job.lastTick, next_tick: job.nextTick, last_error: job.lastError, backoff_ms: job.backoff } : { running: false },
  };
}
export async function taskControls(ctx: TaskServiceContext, authorization: string | undefined, raw: unknown) {
  const input = taskControlsInput.parse(raw), principal = await authenticateTask(authorization, ctx.authPath); requireTaskOwner(principal);
  if (input.execution_stopped === false) {
    const registry = await taskActionRegistry(ctx).catch(error => { if (error.code === "approval_stale") throw error; throw new TaskApprovalError("protected_boundary_required", "Protected owner configuration required; prepare/notify remain usable"); });
    if (!registry.protected_boundary) throw new TaskApprovalError("protected_boundary_required", "Protected owner configuration required; prepare/notify remain usable");
  }
  const store = await transactTaskStore(ctx.path, undefined, s => {
    if (input.enabled !== undefined || input.muted !== undefined || input.execution_stopped !== undefined || input.adapter) requireTaskDomains(principal, [...new Set(s.tasks.flatMap(t => t.owner_domains))]);
    for (const key of ["enabled", "muted", "execution_stopped"] as const) if (input[key] !== undefined) s.controls[key] = input[key]!;
    if (input.source) {
      const source = s.sources.find(source => source.id === input.source!.id); if (!source) throw Object.assign(new Error("Source absent"), { code: "not_found" }); requireTaskDomains(principal, source.owner_domains);
      if (source.enabled !== input.source.enabled) { source.enabled = input.source.enabled; source.revision++; }
    }
    if (input.adapter) s.controls.adapters[input.adapter.id] = { enabled: input.adapter.enabled, coverage: "registered local artifacts only" };
    // Resume never changes approvals, lease expiry, task generations or spent IDs.
  }, "control");
  return { controls: store.controls, resumed_authority: false };
}
