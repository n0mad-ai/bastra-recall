/** P7 preparation, exact owner proof and local leases. No execution adapter. */
import { z } from "zod";
import { randomUUID, randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { authenticateTask, requireTaskDomains, requireTaskOwner, type TaskPrincipal } from "./task-auth.js";
import { taskIdentitySchema as id, type TaskStore, type Task } from "./task-schema.js";
import { readTaskStore, transactTaskStore, cleanText, TaskStoreError } from "./task-store.js";
import { taskBindingHash, boundedTaskRead, assessTaskFreshness } from "./task-freshness.js";
import { taskDecisionStatus } from "./task-reconsideration.js";
import { actionHash, bytesHash, registryHash, actionClock, readApprovalRegistry, pinnedApprovalRegistry, verifyTaskApproval, type ApprovalRegistry } from "./task-approval-keys.js";
import type { TaskServiceContext } from "./task-service.js";
type Proposal = TaskStore["proposals"][number];
type Challenge = TaskStore["challenges"][number];
const proposalInput = z.strictObject({ proposal_id: id });
export const TASK_ACTION_INPUTS = {
  task_prepare: z.strictObject({ id, expected_revision: z.string().regex(/^[a-z0-9._-]+:\d+$/), target_id: id, payload: z.string().max(16384) }),
  task_proposal: proposalInput,
  task_challenge: proposalInput.extend({ domain: id }),
  task_approval: z.strictObject({ challenge_id: id, decision: z.enum(["approve", "deny"]), signature: z.string().min(1).max(256) }),
  task_revoke_approval: z.strictObject({ approval_id: id }),
  task_lease: proposalInput,
  task_release: z.strictObject({ lease_id: id, holder_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), fence: z.number().int().nonnegative().safe().optional() }),
};
export type TaskActionOperation = keyof typeof TASK_ACTION_INPUTS;
export class TaskApprovalError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new TaskApprovalError(code, message); };
export function requireTaskActionEnabled(store: TaskStore) {
  if (!store.controls.enabled) fail("feature_disabled", "Task feature disabled");
  if (store.controls.execution_stopped) fail("execution_stopped", "Owner execution stop active");
  if (store.controls.adapters["local-artifact-v1"]?.enabled !== true) fail("adapter_disabled", "Adapter is not explicitly enabled");
}
const conflict = (message: string): never => { throw new TaskStoreError("conflict", message); };
export async function taskActionRegistry(ctx: TaskServiceContext) {
  const registry = await (ctx.approvalRegistry ?? pinnedApprovalRegistry());
  if (!registry) return conflict("Owner target/key configuration absent; preparation needs a registered target");
  if (ctx.approvalRegistryPath) {
    const current = await readApprovalRegistry(ctx.approvalRegistryPath);
    if (!current || registryHash(current) !== registryHash(registry)) return fail("approval_stale", "Owner registry changed; process restart required");
  }
  return registry;
}
export function requireReversiblePayload(payload: string) {
  if (payload.length > 16384 || cleanText(payload) !== payload || /[\p{Cc}\p{Cf}]/u.test(payload.replaceAll("\n", "")))
    fail("adapter_not_reversible", "Reference adapter requires rollback-safe bounded clean UTF-8 before-state");
}
export async function readTaskTarget(registry: ApprovalRegistry, targetId: string) {
  const target = registry.targets.find(t => t.id === targetId); if (!target) return conflict("Target is not registered");
  const root = await realpath(target.root), path = resolve(root, target.path), rel = relative(root, path);
  if (root !== target.root || !rel || rel.startsWith("..") || isAbsolute(rel) || await realpath(path) !== path) return conflict("Target boundary changed");
  const payload = await boundedTaskRead(path, 1024 * 1024, true).catch(error => { if (error instanceof TypeError) return fail("adapter_not_reversible", "Target must be exact UTF-8"); throw error; });
  const mode = (await lstat(path)).mode & 0o777;
  return { target, path, payload, hash: bytesHash(payload), mode };
}
function findProposal(store: TaskStore, proposalId: string, principal: TaskPrincipal): Proposal {
  const proposal = store.proposals.find(p => p.id === proposalId);
  if (!proposal || !proposal.required_domains.some(d => principal.domains.includes(d))) throw Object.assign(new Error("Proposal absent"), { code: "not_found" });
  return proposal;
}
function clock(ctx: TaskServiceContext) { return (ctx.actionClock ?? actionClock)(); }
export function liveActionDeadline(ctx: TaskServiceContext, row: { expires_at: number; boot_id: string; monotonic_deadline: number }): boolean {
  const c = clock(ctx); return c.boot_id !== "unsupported" && c.boot_id === row.boot_id && (ctx.now ?? Date.now)() < row.expires_at && c.monotonic < row.monotonic_deadline;
}
export function approvalBinding(proposal: Proposal, challenge: Challenge, decision: "approve" | "deny") {
  return { protocol: "bastra-task-approval-v1", proposal, challenge: { id: challenge.id, domain: challenge.domain, nonce: challenge.nonce,
    binding_hash: challenge.binding_hash, expires_at: challenge.expires_at, boot_id: challenge.boot_id, monotonic_deadline: challenge.monotonic_deadline }, decision };
}
export async function validateTaskProposal(ctx: TaskServiceContext, store: TaskStore, proposal: Proposal, registry: ApprovalRegistry): Promise<Task> {
  if (proposal.status === "stale" || !proposal.task_binding) return fail("approval_stale", "Private binding retired; prepare again");
  const task = store.tasks.find(t => t.id === proposal.task_id);
  if (!task || (!proposal.rollback_of && (!task.armed || ["cancelled", "resolved", "expired"].includes(task.state) || (task.state === "snoozed" && task.snoozed_until! > (ctx.now ?? Date.now)())))) return conflict("Task is inactive");
  if (proposal.status === "denied") return fail("approval_denied", "Proposal denied");
  if (proposal.status === "revoked") return fail("approval_revoked", "Proposal revoked");
  if (task.revision !== proposal.task_revision || task.generation !== proposal.generation
    || proposal.recovery_epoch !== store.recovery_epoch || proposal.task_binding !== taskBindingHash(task) || registryHash(registry) !== proposal.registry_hash
    || bytesHash(proposal.payload) !== proposal.payload_hash) return fail("approval_stale", "Proposal binding changed");
  for (const source of proposal.source_revisions) if (!store.sources.some(s => s.id === source.id && s.enabled && String(s.revision) === source.revision)) return conflict("Proposal source changed");
  if ((await readTaskTarget(registry, proposal.target_id)).hash !== proposal.target_hash) return fail("approval_stale", "Target changed; prepare again");
  if (proposal.rollback_of) {
    const receipt = store.receipts.find(r => r.id === proposal.rollback_of && ["succeeded", "reconciled"].includes(r.outcome));
    const original = receipt && store.proposals.find(p => p.id === receipt.proposal_id);
    if (!receipt || !original || original.target_id !== proposal.target_id || receipt.after_hash !== proposal.target_hash || receipt.before_hash !== proposal.payload_hash)
      return fail("approval_stale", "Rollback receipt binding changed");
    return task; // new proof/CAS, independent of old trigger/evidence/lifecycle
  }
  if (await taskDecisionStatus(ctx, task)) return conflict("Decision binding changed");
  if (task.evidence.length || (task.schedule.kind === "event" && task.schedule.predicate === "premise")) {
    const verification = task.verification, now = (ctx.now ?? Date.now)();
    if (!verification || !["verified", "refuted"].includes(verification.outcome) || verification.binding_hash !== taskBindingHash(task)
      || verification.state_updated_at === undefined || verification.state_updated_at > now || now - verification.state_updated_at > verification.max_age_ms) return conflict("Evidence is not current");
  }
  return task;
}
export function taskApprovalStatus(ctx: TaskServiceContext, store: TaskStore, proposal: Proposal, registry: ApprovalRegistry) {
  const approvals = proposal.required_domains.map(domain => store.approvals.filter(a => a.proposal_id === proposal.id && a.domain === domain).slice(-1).find(a => a.decision === "approve"
    && a.signature !== undefined && a.revoked_at === undefined && !store.consumed_approval_ids.includes(a.id) && a.registry_hash === registryHash(registry) && liveActionDeadline(ctx, a) && a.binding_hash === actionHash(proposal)
    && store.challenges.some(c => c.id === a.challenge_id && c.proposal_id === proposal.id && c.domain === domain && c.consumed_at !== undefined
      && c.expires_at === a.expires_at && c.monotonic_deadline === a.monotonic_deadline && liveActionDeadline(ctx, c)
      && registry.keys.some(k => k.id === a.key_id && k.domain === domain && verifyTaskApproval(k.public_key, approvalBinding(proposal, c, "approve"), a.signature!)))));
  const domain_status = proposal.required_domains.map(domain => {
    const rows = store.approvals.filter(a => a.proposal_id === proposal.id && a.domain === domain), latest = rows.at(-1);
    const reason = proposal.status === "stale" ? "approval_stale" : proposal.status === "denied" ? "approval_denied" : proposal.status === "revoked" ? "approval_revoked" : !latest ? "approval_missing"
      : latest.revoked_at !== undefined ? "approval_revoked" : store.consumed_approval_ids.includes(latest.id) ? "approval_consumed" : !liveActionDeadline(ctx, latest) ? "approval_expired"
      : !approvals[proposal.required_domains.indexOf(domain)] ? "approval_stale" : "approved";
    return { domain, reason };
  });
  return { domain_status, approved: registry.protected_boundary && proposal.status === "prepared" && approvals.every(Boolean), missing_domains: proposal.required_domains.filter((_, i) => !approvals[i]), approval_ids: approvals.filter(Boolean).map(a => a!.id), protected_boundary: registry.protected_boundary };
}
export async function callTaskAction(ctx: TaskServiceContext, authorization: string | undefined, operation: TaskActionOperation, raw: unknown) {
  const principal = await authenticateTask(authorization, ctx.authPath), now = (ctx.now ?? Date.now)();
  raw = TASK_ACTION_INPUTS[operation].parse(raw); const registry = ["task_release", "task_revoke_approval"].includes(operation)
    ? { schema_version: 1 as const, revision: 0, protected_boundary: false, keys: [], targets: [] }
    : await taskActionRegistry(ctx); let result: unknown;
  if (!["task_release", "task_revoke_approval"].includes(operation)) {
    const snapshot = await readTaskStore(ctx.path); const input = raw as { id?: string; proposal_id?: string; challenge_id?: string };
    const taskId = input.id ?? snapshot.proposals.find(p => p.id === (input.proposal_id ?? snapshot.challenges.find(c => c.id === input.challenge_id)?.proposal_id))?.task_id;
    if (taskId && snapshot.tasks.some(t => t.id === taskId && t.owner_domains.every(d => principal.domains.includes(d)))) await assessTaskFreshness(ctx, new Set([taskId]));
  }
  await transactTaskStore(ctx.path, undefined, async store => {
    const current = await authenticateTask(authorization, ctx.authPath);
    if (current.actor_id !== principal.actor_id || current.credential_id !== principal.credential_id) return conflict("Credential changed");
    if (operation === "task_prepare") {
      const input = TASK_ACTION_INPUTS.task_prepare.parse(raw);
      const task = store.tasks.find(t => t.id === input.id && t.owner_domains.every(d => principal.domains.includes(d)));
      if (!task) throw Object.assign(new Error("Task absent"), { code: "not_found" });
      if (`${store.recovery_epoch}:${task.revision}` !== input.expected_revision) return fail("approval_stale", "Freshness advanced task revision; fetch current task and prepare again");
      if (!store.controls.enabled || !task.armed || task.action_level === "notify") return conflict("Task is not reviewed for preparation");
      if (cleanText(input.payload) !== input.payload || /[\p{Cc}\p{Cf}]/u.test(input.payload.replaceAll("\n", "").replaceAll("\t", ""))) throw Object.assign(new Error("Exact payload cannot be safely previewed"), { code: "validation" });
      const target = registry.targets.find(t => t.id === input.target_id); if (!target) return conflict("Target absent");
      const sourceIds = new Set([...task.evidence.map(e => e.source_id), ...(task.schedule.kind === "event" ? [task.schedule.source_id] : [])]);
      const sources = store.sources.filter(s => sourceIds.has(s.id)); if (sources.length !== sourceIds.size || sources.some(s => !s.enabled)) return conflict("Source unavailable");
      const domains = [...new Set([...task.owner_domains, ...target.owner_domains, ...sources.flatMap(s => s.owner_domains)])].sort(); requireTaskDomains(principal, domains);
      if ((target.sensitivity === "restricted" && task.sensitivity !== "restricted") || sources.some(s => s.sensitivity === "restricted" && task.sensitivity !== "restricted")) return conflict("Sensitivity boundary incomplete");
      const observed = await readTaskTarget(registry, input.target_id); requireReversiblePayload(observed.payload);
      const body = { revision: 0, task_id: task.id, task_revision: task.revision, generation: task.generation, recovery_epoch: store.recovery_epoch,
        actor: principal.actor_id, target_id: input.target_id, target_hash: observed.hash, operation: "replace-utf8" as const, payload: input.payload, payload_hash: bytesHash(input.payload),
        task_binding: taskBindingHash(task), binding_version: 2 as const, registry_hash: registryHash(registry), required_domains: domains,
        source_revisions: sources.map(s => ({ id: s.id, revision: String(s.revision) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), scope: task.scope, sensitivity: task.sensitivity, status: "prepared" as const };
      const proposal = { ...body, id: actionHash(["task-proposal-v1", body]), created_at: now };
      await validateTaskProposal(ctx, store, proposal, registry);
      const existing = store.proposals.find(p => p.id === proposal.id); if (!existing) store.proposals.push(proposal);
      result = { proposal: existing ?? proposal, preview: { before: observed.payload, after: input.payload }, executes: false }; return;
    }
    if (operation === "task_revoke_approval") {
      const input = TASK_ACTION_INPUTS.task_revoke_approval.parse(raw); requireTaskOwner(principal);
      const approval = store.approvals.find(a => a.id === input.approval_id); if (!approval) throw Object.assign(new Error("Approval absent"), { code: "not_found" });
      requireTaskDomains(principal, [approval.domain]); approval.revoked_at ??= now; result = { revoked: true }; return;
    }
    if (operation === "task_release") {
      const input = TASK_ACTION_INPUTS.task_release.parse(raw); const lease = store.leases.find(l => l.id === input.lease_id && l.actor === principal.actor_id);
      if (!lease) return conflict("Lease holder mismatch");
      const proposal = store.proposals.find(p => p.id === lease.proposal_id);
      if (principal.role === "owner" && input.holder_token === undefined && input.fence === undefined) {
        if (!proposal) return conflict("Proposal absent");
        requireTaskDomains(principal, proposal.required_domains);
      } else if (lease.fence !== input.fence || !input.holder_token || lease.holder_token_hash !== bytesHash(input.holder_token)) return conflict("Lease holder mismatch");
      if (lease.state !== "active" || !liveActionDeadline(ctx, lease)) return fail("lease_expired", "Lease expired or released");
      lease.state = "released"; result = { released: true }; return;
    }
    if (operation === "task_approval") {
      const input = TASK_ACTION_INPUTS.task_approval.parse(raw); requireTaskOwner(principal);
      const challenge = store.challenges.find(c => c.id === input.challenge_id); if (!challenge) throw Object.assign(new Error("Challenge absent"), { code: "not_found" });
      requireTaskDomains(principal, [challenge.domain]); const proposal = findProposal(store, challenge.proposal_id, principal);
      await validateTaskProposal(ctx, store, proposal, registry);
      if (challenge.consumed_at !== undefined) return fail("approval_consumed", "Challenge consumed");
      if (!liveActionDeadline(ctx, challenge)) return fail("approval_expired", "Challenge expired");
      if (challenge.binding_hash !== actionHash(proposal)) return fail("approval_stale", "Challenge binding stale");
      const key = registry.keys.find(k => k.domain === challenge.domain);
      if (!key || !verifyTaskApproval(key.public_key, approvalBinding(proposal, challenge, input.decision), input.signature)) return conflict("Owner signature required");
      challenge.consumed_at = now;
      const approval = { id: randomUUID(), proposal_id: proposal.id, domain: challenge.domain, challenge_id: challenge.id, key_id: key.id,
        binding_hash: challenge.binding_hash, registry_hash: registryHash(registry), signature: input.signature, decision: input.decision, created_at: now,
        expires_at: challenge.expires_at, boot_id: challenge.boot_id, monotonic_deadline: challenge.monotonic_deadline };
      store.approvals.push(approval); if (input.decision === "deny") proposal.status = "denied";
      result = { approval_id: approval.id, ...taskApprovalStatus(ctx, store, proposal, registry) }; return;
    }
    const input = (operation === "task_challenge" ? TASK_ACTION_INPUTS.task_challenge : proposalInput).parse(raw);
    const proposal = findProposal(store, input.proposal_id, principal);
    if (operation === "task_proposal") {
      if (principal.role !== "owner") requireTaskDomains(principal, proposal.required_domains);
      if (proposal.status === "stale") {
        result = { proposal: { id: proposal.id, task_id: proposal.task_id, target_id: proposal.target_id, status: "stale" },
          binding_status: "approval_stale", review_reason: "Private binding retired; prepare again", ...taskApprovalStatus(ctx,store,proposal,registry) }; return;
      }
      let binding_status = "current";
      try { await validateTaskProposal(ctx, store, proposal, registry); } catch (error) { binding_status = (error as {code?:string}).code ?? "approval_stale"; }
      const target = await readTaskTarget(registry, proposal.target_id);
      result = { proposal, binding_status, preview: { before: target.payload, after: proposal.payload }, ...taskApprovalStatus(ctx, store, proposal, registry) }; return;
    }
    await validateTaskProposal(ctx, store, proposal, registry);
    const observed = await readTaskTarget(registry, proposal.target_id); if (observed.hash !== proposal.target_hash) return fail("approval_stale", "Target changed; prepare again");
    if (operation === "task_challenge") {
      if (!store.controls.enabled) return fail("feature_disabled", "Task feature disabled");
      const domain = TASK_ACTION_INPUTS.task_challenge.parse(raw).domain; requireTaskOwner(principal); requireTaskDomains(principal, [domain]);
      if (!proposal.required_domains.includes(domain) || !registry.keys.some(k => k.domain === domain)) return conflict("Owner domain has no enrolled key");
      const c = clock(ctx); if (c.boot_id === "unsupported") return conflict("Boot clock unsupported");
      const challenge = { id: randomUUID(), proposal_id: proposal.id, domain, nonce: randomBytes(32).toString("base64url"), binding_hash: actionHash(proposal), created_at: now, expires_at: now + 300000, boot_id: c.boot_id, monotonic_deadline: c.monotonic + 300000 };
      const existing = store.challenges.find(c => c.proposal_id === proposal.id && c.domain === domain && c.binding_hash === challenge.binding_hash && c.consumed_at === undefined && liveActionDeadline(ctx, c));
      if (!existing) store.challenges.push(challenge); result = { challenge: existing ?? challenge, proposal, task_goal: store.tasks.find(t => t.id === proposal.task_id)?.goal, preview: { before: observed.payload, after: proposal.payload } }; return;
    }
    requireTaskDomains(principal, proposal.required_domains); requireTaskActionEnabled(store);
    const approvalState = taskApprovalStatus(ctx, store, proposal, registry);
    const missing = approvalState.domain_status.find(d => d.reason !== "approved");
    if (missing) fail(missing.reason, "All exact owner approvals required");
    if ((!proposal.rollback_of && store.tasks.find(t => t.id === proposal.task_id)?.action_level !== "execute") || proposal.actor !== principal.actor_id || !store.controls.enabled || store.controls.execution_stopped || !taskApprovalStatus(ctx, store, proposal, registry).approved) return conflict("All exact owner approvals and execution enabled are required for a lease");
    const active = store.leases.find(l => l.proposal_id === proposal.id && l.state === "active");
    if (active && liveActionDeadline(ctx, active)) return fail("lease_busy", "Active lease already held");
    if (active) active.state = "expired";
    const holderToken = randomBytes(32).toString("base64url"), c = clock(ctx);
    const lease = { id: randomUUID(), task_id: proposal.task_id, proposal_id: proposal.id, actor: principal.actor_id,
      holder_token_hash: bytesHash(holderToken), fence: ++store.fencing_counter, expires_at: now + 30000, boot_id: c.boot_id, monotonic_deadline: c.monotonic + 30000, state: "active" as const };
    store.leases.push(lease); result = { lease, holder_token: holderToken };
  }, operation === "task_revoke_approval" || operation === "task_release" ? "control" : "normal");
  return result;
}
