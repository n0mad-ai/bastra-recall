/** P7 preparation, exact owner proof and local leases. No execution adapter. */
import { z } from "zod";
import { randomUUID, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { authenticateTask, requireTaskDomains, requireTaskOwner, type TaskPrincipal } from "./task-auth.js";
import { taskIdentitySchema as id, type TaskStore, type Task } from "./task-schema.js";
import { readTaskStore, transactTaskStore, cleanText, TaskStoreError } from "./task-store.js";
import { taskBindingHash, boundedTaskRead, assessTaskFreshness } from "./task-freshness.js";
import { taskDecisionStatus } from "./task-reconsideration.js";
import { actionHash, bytesHash, registryHash, actionClock, pinnedApprovalRegistry, verifyTaskApproval, type ApprovalRegistry } from "./task-approval-keys.js";
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
  task_release: z.strictObject({ lease_id: id, holder_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), fence: z.number().int().nonnegative().safe() }),
};
export type TaskActionOperation = keyof typeof TASK_ACTION_INPUTS;
const conflict = (message: string): never => { throw new TaskStoreError("conflict", message); };
export async function taskActionRegistry(ctx: TaskServiceContext) {
  const registry = await (ctx.approvalRegistry ?? pinnedApprovalRegistry());
  if (!registry) return conflict("Owner target/key configuration absent; preparation needs a registered target");
  return registry;
}
export async function readTaskTarget(registry: ApprovalRegistry, targetId: string) {
  const target = registry.targets.find(t => t.id === targetId); if (!target) return conflict("Target is not registered");
  const root = await realpath(target.root), path = resolve(root, target.path), rel = relative(root, path);
  if (root !== target.root || !rel || rel.startsWith("..") || isAbsolute(rel) || await realpath(path) !== path) return conflict("Target boundary changed");
  const payload = await boundedTaskRead(path, 1024 * 1024);
  if (payload.includes("\ufffd")) return conflict("Target must be exact UTF-8");
  return { target, path, payload, hash: bytesHash(payload) };
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
  const task = store.tasks.find(t => t.id === proposal.task_id);
  if (store.controls.adapters["local-artifact-v1"]?.enabled === false) return conflict("Action adapter disabled");
  if (!task || !task.armed || ["cancelled", "resolved", "expired"].includes(task.state) || (task.state === "snoozed" && task.snoozed_until! > (ctx.now ?? Date.now)())) return conflict("Task is inactive");
  if (proposal.status !== "prepared" || task.revision !== proposal.task_revision || task.generation !== proposal.generation
    || proposal.recovery_epoch !== store.recovery_epoch || proposal.task_binding !== taskBindingHash(task) || registryHash(registry) !== proposal.registry_hash
    || bytesHash(proposal.payload) !== proposal.payload_hash) return conflict("Proposal binding changed");
  for (const source of proposal.source_revisions) if (!store.sources.some(s => s.id === source.id && s.enabled && String(s.revision) === source.revision)) return conflict("Proposal source changed");
  if ((await readTaskTarget(registry, proposal.target_id)).hash !== proposal.target_hash) return conflict("Target changed; prepare again");
  if (await taskDecisionStatus(ctx, task)) return conflict("Decision binding changed");
  if (task.evidence.length || (task.schedule.kind === "event" && task.schedule.predicate === "premise")) {
    const verification = task.verification, now = (ctx.now ?? Date.now)();
    if (!verification || !["verified", "refuted"].includes(verification.outcome) || verification.binding_hash !== taskBindingHash(task)
      || verification.state_updated_at === undefined || verification.state_updated_at > now || now - verification.state_updated_at > verification.max_age_ms) return conflict("Evidence is not current");
  }
  return task;
}
export function taskApprovalStatus(ctx: TaskServiceContext, store: TaskStore, proposal: Proposal, registry: ApprovalRegistry) {
  const approvals = proposal.required_domains.map(domain => store.approvals.find(a => a.proposal_id === proposal.id && a.domain === domain && a.decision === "approve"
    && a.revoked_at === undefined && !store.consumed_approval_ids.includes(a.id) && a.registry_hash === registryHash(registry) && liveActionDeadline(ctx, a) && a.binding_hash === actionHash(proposal)
    && store.challenges.some(c => c.id === a.challenge_id && c.proposal_id === proposal.id && c.domain === domain && c.consumed_at !== undefined
      && c.expires_at === a.expires_at && c.monotonic_deadline === a.monotonic_deadline && liveActionDeadline(ctx, c)
      && registry.keys.some(k => k.id === a.key_id && k.domain === domain && verifyTaskApproval(k.public_key, approvalBinding(proposal, c, "approve"), a.signature)))));
  return { approved: registry.protected_boundary && proposal.status === "prepared" && approvals.every(Boolean), missing_domains: proposal.required_domains.filter((_, i) => !approvals[i]), approval_ids: approvals.filter(Boolean).map(a => a!.id), protected_boundary: registry.protected_boundary };
}
export async function callTaskAction(ctx: TaskServiceContext, authorization: string | undefined, operation: TaskActionOperation, raw: unknown) {
  const principal = await authenticateTask(authorization, ctx.authPath), now = (ctx.now ?? Date.now)();
  raw = TASK_ACTION_INPUTS[operation].parse(raw); const registry = ["task_release", "task_revoke_approval"].includes(operation)
    ? { schema_version: 1 as const, revision: 0, protected_boundary: false, keys: [], targets: [] }
    : await taskActionRegistry(ctx); let result: unknown;
  if (!["task_release", "task_revoke_approval"].includes(operation)) {
    const snapshot = await readTaskStore(ctx.path); const input = raw as { id?: string; proposal_id?: string; challenge_id?: string };
    const taskId = input.id ?? snapshot.proposals.find(p => p.id === (input.proposal_id ?? snapshot.challenges.find(c => c.id === input.challenge_id)?.proposal_id))?.task_id;
    if (taskId) await assessTaskFreshness(ctx, new Set([taskId]));
  }
  await transactTaskStore(ctx.path, undefined, async store => {
    const current = await authenticateTask(authorization, ctx.authPath);
    if (current.actor_id !== principal.actor_id || current.credential_id !== principal.credential_id) return conflict("Credential changed");
    if (operation === "task_prepare") {
      const input = TASK_ACTION_INPUTS.task_prepare.parse(raw);
      const task = store.tasks.find(t => t.id === input.id && t.owner_domains.every(d => principal.domains.includes(d)));
      if (!task) throw Object.assign(new Error("Task absent"), { code: "not_found" });
      if (!store.controls.enabled || !task.armed || `${store.recovery_epoch}:${task.revision}` !== input.expected_revision || task.action_level === "notify") return conflict("Task is not reviewed for preparation");
      if (cleanText(input.payload) !== input.payload || /[\p{Cc}\p{Cf}]/u.test(input.payload.replaceAll("\n", "").replaceAll("\t", ""))) throw Object.assign(new Error("Exact payload cannot be safely previewed"), { code: "validation" });
      const target = registry.targets.find(t => t.id === input.target_id); if (!target) return conflict("Target absent");
      const sourceIds = new Set([...task.evidence.map(e => e.source_id), ...(task.schedule.kind === "event" ? [task.schedule.source_id] : [])]);
      const sources = store.sources.filter(s => sourceIds.has(s.id)); if (sources.length !== sourceIds.size || sources.some(s => !s.enabled)) return conflict("Source unavailable");
      const domains = [...new Set([...task.owner_domains, ...target.owner_domains, ...sources.flatMap(s => s.owner_domains)])].sort(); requireTaskDomains(principal, domains);
      if ((target.sensitivity === "restricted" && task.sensitivity !== "restricted") || sources.some(s => s.sensitivity === "restricted" && task.sensitivity !== "restricted")) return conflict("Sensitivity boundary incomplete");
      const observed = await readTaskTarget(registry, input.target_id);
      const body = { revision: 0, task_id: task.id, task_revision: task.revision, generation: task.generation, recovery_epoch: store.recovery_epoch,
        actor: principal.actor_id, target_id: input.target_id, target_hash: observed.hash, operation: "replace-utf8" as const, payload: input.payload, payload_hash: bytesHash(input.payload),
        task_binding: taskBindingHash(task), registry_hash: registryHash(registry), required_domains: domains,
        source_revisions: sources.map(s => ({ id: s.id, revision: String(s.revision) })).sort((a, b) => a.id.localeCompare(b.id)), scope: task.scope, sensitivity: task.sensitivity, status: "prepared" as const };
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
      if (!lease || lease.fence !== input.fence || lease.holder_token_hash !== bytesHash(input.holder_token)) return conflict("Lease holder mismatch");
      lease.state = "released"; result = { released: true }; return;
    }
    if (operation === "task_approval") {
      const input = TASK_ACTION_INPUTS.task_approval.parse(raw); requireTaskOwner(principal);
      const challenge = store.challenges.find(c => c.id === input.challenge_id); if (!challenge) throw Object.assign(new Error("Challenge absent"), { code: "not_found" });
      requireTaskDomains(principal, [challenge.domain]); const proposal = findProposal(store, challenge.proposal_id, principal);
      await validateTaskProposal(ctx, store, proposal, registry);
      if (challenge.consumed_at !== undefined || !liveActionDeadline(ctx, challenge) || challenge.binding_hash !== actionHash(proposal)) return conflict("Challenge consumed, expired or stale");
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
    const proposal = findProposal(store, input.proposal_id, principal); await validateTaskProposal(ctx, store, proposal, registry);
    const observed = await readTaskTarget(registry, proposal.target_id); if (observed.hash !== proposal.target_hash) return conflict("Target changed; prepare again");
    if (operation === "task_proposal") { result = { proposal, preview: { before: observed.payload, after: proposal.payload }, ...taskApprovalStatus(ctx, store, proposal, registry) }; return; }
    if (operation === "task_challenge") {
      const domain = TASK_ACTION_INPUTS.task_challenge.parse(raw).domain; requireTaskOwner(principal); requireTaskDomains(principal, [domain]);
      if (!proposal.required_domains.includes(domain) || !registry.keys.some(k => k.domain === domain)) return conflict("Owner domain has no enrolled key");
      const c = clock(ctx); if (c.boot_id === "unsupported") return conflict("Boot clock unsupported");
      const challenge = { id: randomUUID(), proposal_id: proposal.id, domain, nonce: randomBytes(32).toString("base64url"), binding_hash: actionHash(proposal), created_at: now, expires_at: now + 300000, boot_id: c.boot_id, monotonic_deadline: c.monotonic + 300000 };
      store.challenges.push(challenge); result = { challenge, proposal, preview: { before: observed.payload, after: proposal.payload } }; return;
    }
    requireTaskDomains(principal, proposal.required_domains);
    if (store.tasks.find(t => t.id === proposal.task_id)?.action_level !== "execute" || proposal.actor !== principal.actor_id || !store.controls.enabled || store.controls.execution_stopped || !taskApprovalStatus(ctx, store, proposal, registry).approved) return conflict("All exact owner approvals and execution enabled are required for a lease");
    const active = store.leases.find(l => l.proposal_id === proposal.id && l.state === "active");
    if (active && liveActionDeadline(ctx, active)) return conflict("Active lease already held");
    if (active) active.state = "expired";
    const holderToken = randomBytes(32).toString("base64url"), c = clock(ctx);
    const lease = { id: randomUUID(), task_id: proposal.task_id, proposal_id: proposal.id, actor: principal.actor_id,
      holder_token_hash: bytesHash(holderToken), fence: ++store.fencing_counter, expires_at: now + 30000, boot_id: c.boot_id, monotonic_deadline: c.monotonic + 30000, state: "active" as const };
    store.leases.push(lease); result = { lease, holder_token: holderToken };
  }, operation === "task_revoke_approval" || operation === "task_release" ? "control" : "normal");
  return result;
}
