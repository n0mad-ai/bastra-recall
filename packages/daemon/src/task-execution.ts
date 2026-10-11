/** Reviewed local execution: one lock, durable spend, exact UTF-8 CAS, receipts. */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { constants, openSync, fstatSync, closeSync, lstatSync, realpathSync, readFileSync, renameSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { authenticateTask, requireTaskDomains, requireTaskOwner } from "./task-auth.js";
import { taskIdentitySchema as id, type TaskStore, type Task } from "./task-schema.js";
import { cleanText, withTaskStoreGuard, TaskStoreError } from "./task-store.js";
import { taskActionRegistry, requireTaskActionEnabled, validateTaskProposal, taskApprovalStatus, liveActionDeadline, readTaskTarget, TaskApprovalError } from "./task-actions.js";
import { bytesHash, actionHash } from "./task-approval-keys.js";
import { boundedTaskRead, verifyTaskSource, verifyBoundEvidence } from "./task-freshness.js";
import type { TaskServiceContext } from "./task-service.js";
export const TASK_EXECUTION_INPUTS = {
  task_execute: z.strictObject({ proposal_id: id, lease_id: id, holder_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), fence: z.number().int().positive().safe(), idempotency_key: id }),
  task_intent_reconcile: z.strictObject({ intent_id: id }),
  task_rollback_prepare: z.strictObject({ receipt_id: id }),
};
export type TaskExecutionOperation = keyof typeof TASK_EXECUTION_INPUTS;
export const isTaskExecution = (name: string): name is TaskExecutionOperation => Object.hasOwn(TASK_EXECUTION_INPUTS, name);
type Intent = TaskStore["intents"][number];
function fail(code: string, message: string): never { throw new TaskApprovalError(code, message); }
export function taskBackupPath(ctx: TaskServiceContext, backupId: string) { return join(dirname(ctx.path), "task-action-backups", `${id.parse(backupId)}.json`); }
async function writePrivateNew(path: string, payload: string, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const fd = await open(path, "wx", mode);
  try { await fd.writeFile(payload); await fd.chmod(mode); await fd.sync(); } finally { await fd.close(); }
  const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function freshSources(ctx: TaskServiceContext, task: Task, store: TaskStore) {
  const now = (ctx.now ?? Date.now)();
  ctx = { ...ctx, ...{ deadline: Date.now() + task.budget.timeout_ms } };
  if (task.schedule.kind === "event") {
    const event = [...store.events].reverse().find(e => task.schedule.kind === "event" && e.source_id === task.schedule.source_id);
    if (!event || task.last_event_sequence !== event.sequence) fail("approval_stale", "Unprocessed newer source event");
    const source = store.sources.find(s => s.id === event.source_id)!;
    if (source.kind === "file") {
      const root = realpathSync(source.root!), path = resolve(root, source.path!);
      if (root !== source.root || realpathSync(path) !== path || relative(root, path).startsWith("..")) fail("approval_stale", "Source boundary changed");
      if (bytesHash(await boundedTaskRead(path, task.budget.max_source_bytes)) !== event.value_hash) fail("approval_stale", "Source content changed");
    } else if (source.kind === "memory") {
      if (!ctx.memoryRead || (await ctx.memoryRead(source.memory_id!)).revision !== event.value) fail("approval_stale", "Memory source changed");
    } else if (source.kind === "git") {
      // Reuse fixed argv/no-shell source reader in this guard below.
      const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
      if (realpathSync(source.root!) !== source.root) fail("approval_stale", "Git root changed");
      const value = (await promisify(execFile)("git", ["-C", source.root!, "rev-parse", "--verify", "--end-of-options", source.ref!], { timeout: 1000, maxBuffer: 4096 })).stdout.trim();
      if (value !== event.value) fail("approval_stale", "Git source changed");
    }
    const verification = await verifyTaskSource(ctx, task, event, store, now);
    const matches = task.schedule.predicate === "equals" ? verification.outcome === "verified" : verification.outcome === "refuted";
    if (!matches) fail("approval_stale", "Trigger/evidence no longer verified");
  } else {
    if (task.schedule.at > now || task.state !== "due") fail("approval_stale", "Task is not due");
    if (task.evidence.length && (await verifyBoundEvidence(ctx, task, store, now)).outcome !== "verified") fail("approval_stale", "Evidence changed");
  }
}
/** No awaits between final CAS/ownership/expiry admission and the rename. */
function finalTargetCommit(ctx: TaskServiceContext, store: TaskStore, intent: Intent, holder: { token: string; fence: number }, path: string, tmp: string, assertOwnership: () => void) {
  requireTaskActionEnabled(store); const lease = store.leases.find(l => l.id === intent.lease_id);
  if (!lease || lease.state !== "active" || lease.actor !== intent.actor || lease.fence !== holder.fence || lease.holder_token_hash !== bytesHash(holder.token) || !liveActionDeadline(ctx, lease)) fail("lease_expired", "Lease admission expired");
  if (!intent.approval_ids.every(id => { const a = store.approvals.find(a => a.id === id); return a && a.revoked_at === undefined && liveActionDeadline(ctx, a); })) fail("approval_expired", "Reserved approvals expired or revoked");
  if (realpathSync(path) !== path || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 1024 * 1024) fail("approval_stale", "Target boundary changed");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (fstatSync(fd).size > 1024 * 1024 || bytesHash(readFileSync(fd, "utf8")) !== intent.before_hash) fail("approval_stale", "Target changed before CAS"); }
  finally { closeSync(fd); }
  assertOwnership(); renameSync(tmp, path);
}
export async function executeTaskAction(ctx: TaskServiceContext, authorization: string | undefined, operation: TaskExecutionOperation, raw: unknown) {
  if (!ctx.executionHost) fail("execution_host_required", "Only the running daemon executes; clients must forward");
  const principal = await authenticateTask(authorization, ctx.authPath); raw = TASK_EXECUTION_INPUTS[operation].parse(raw);
  const registry = await taskActionRegistry(ctx);
  return withTaskStoreGuard(ctx.path, async guard => {
    let store = guard.snapshot(); const now = (ctx.now ?? Date.now)();
    const actor = await authenticateTask(authorization, ctx.authPath);
    if (actor.credential_id !== principal.credential_id) fail("forbidden", "Credential changed");
    const present = (intent: Intent) => { const receipt = store.receipts.find(r => r.id === intent.receipt_id); return { intent_id: intent.id, state: intent.state, receipt }; };
    if (operation === "task_intent_reconcile") {
      const input = TASK_EXECUTION_INPUTS.task_intent_reconcile.parse(raw), intent = store.intents.find(i => i.id === input.intent_id);
      if (!intent) fail("not_found", "Intent absent");
      const proposal = store.proposals.find(p => p.id === intent.proposal_id)!; requireTaskDomains(principal, proposal.required_domains);
      if (principal.actor_id !== intent.actor) requireTaskOwner(principal);
      if (intent.state !== "pending") return present(intent);
      const target = await readTaskTarget(registry, proposal.target_id);
      // Read-only recovery never retries a target write, regardless of lease expiry.
      const outcome = target.hash === intent.after_hash && intent.recovery_epoch === store.recovery_epoch ? "reconciled" as const : "unknown" as const;
      const receipt = { id: randomUUID(), intent_id: intent.id, proposal_id: proposal.id, task_id: intent.task_id, actor: intent.actor, fence: intent.fence, at: now, outcome,
        target_hash: target.hash, before_hash: intent.before_hash, after_hash: intent.after_hash, backup_id: intent.backup_id };
      store = await guard.commit(s => { const row = s.intents.find(i => i.id === intent.id)!; row.state = outcome === "reconciled" ? "succeeded" : "unknown"; row.receipt_id = receipt.id; s.receipts.push(receipt); }, "control");
      return present(store.intents.find(i => i.id === intent.id)!);
    }
    if (operation === "task_rollback_prepare") {
      const input = TASK_EXECUTION_INPUTS.task_rollback_prepare.parse(raw), receipt = store.receipts.find(r => r.id === input.receipt_id);
      if (!receipt || !["succeeded", "reconciled"].includes(receipt.outcome)) fail("not_found", "Successful receipt required");
      const original = store.proposals.find(p => p.id === receipt.proposal_id)!; requireTaskDomains(principal, original.required_domains);
      const target = await readTaskTarget(registry, original.target_id); if (target.hash !== receipt.after_hash) fail("approval_stale", "Intervening edits prohibit rollback");
      const backup = JSON.parse(await boundedTaskRead(taskBackupPath(ctx, receipt.backup_id), 2 * 1024 * 1024));
      if (typeof backup.payload !== "string" || cleanText(backup.payload) !== backup.payload) fail("validation", "Rollback cannot be safely previewed");
      if (backup.intent_id !== receipt.intent_id || bytesHash(backup.payload) !== receipt.before_hash) fail("approval_stale", "Backup binding changed");
      const task = store.tasks.find(t => t.id === original.task_id)!;
      const proposal = { ...original, id: actionHash(["task-rollback-v1", receipt.id, principal.actor_id, receipt.after_hash]), actor: principal.actor_id, created_at: now,
        rollback_of: receipt.id, task_revision: task.revision, recovery_epoch: store.recovery_epoch, target_hash: receipt.after_hash, payload: backup.payload, payload_hash: receipt.before_hash, status: "prepared" as const };
      await validateTaskProposal(ctx, store, proposal, registry);
      store = await guard.commit(s => { if (!s.proposals.some(p => p.id === proposal.id)) s.proposals.push(proposal); });
      return { proposal, rollback_of: receipt.id, preview: { before: target.payload, after: backup.payload }, executes: false, new_owner_approvals_required: true };
    }
    const input = TASK_EXECUTION_INPUTS.task_execute.parse(raw);
    const proposal = store.proposals.find(p => p.id === input.proposal_id); if (!proposal) fail("not_found", "Proposal absent");
    requireTaskDomains(principal, proposal.required_domains);
    const existing = store.intents.find(i => i.actor === principal.actor_id && i.idempotency_key === input.idempotency_key);
    if (existing) {
      if (existing.proposal_id !== proposal.id || existing.lease_id !== input.lease_id || existing.fence !== input.fence) fail("conflict", "Idempotency binding differs");
      return present(existing); // pending => explicit read-only reconcile, never blind retry
    }
    requireTaskActionEnabled(store);
    const task = await validateTaskProposal(ctx, store, proposal, registry);
    if (proposal.actor !== principal.actor_id || task.action_level !== "execute" || task.state !== "due") fail("forbidden", "Actor/execute-level/due task required");
    await freshSources(ctx, task, store);
    const approvals = taskApprovalStatus(ctx, store, proposal, registry); if (!approvals.approved) fail(approvals.domain_status.find(d => d.reason !== "approved")?.reason ?? "approval_missing", "Every live owner approval required");
    const lease = store.leases.find(l => l.id === input.lease_id);
    if (!lease || lease.proposal_id !== proposal.id || lease.actor !== principal.actor_id || lease.fence !== input.fence || lease.holder_token_hash !== bytesHash(input.holder_token) || lease.state !== "active" || !liveActionDeadline(ctx, lease)) fail("lease_expired", "Current actor/holder/fence lease required");
    const target = await readTaskTarget(registry, proposal.target_id);
    const intent: Intent = { id: randomUUID(), proposal_id: proposal.id, task_id: task.id, actor: principal.actor_id, lease_id: lease.id, fence: lease.fence,
      approval_ids: approvals.approval_ids, idempotency_key: input.idempotency_key, created_at: now, recovery_epoch: store.recovery_epoch,
      before_hash: target.hash, after_hash: proposal.payload_hash, backup_id: randomUUID(), state: "pending" };
    if (store.receipts.length + store.intents.filter(i => i.state === "pending").length >= 9990) throw new TaskStoreError("capacity", "Receipt reserve reached");
    store = await guard.commit(s => { s.intents.push(intent); s.consumed_approval_ids.push(...intent.approval_ids); });
    // Spending + intent are durable BEFORE every adapter/backup/target effect.
    await writePrivateNew(taskBackupPath(ctx, intent.backup_id), JSON.stringify({ intent_id: intent.id, target_id: proposal.target_id, hash: intent.before_hash, payload: target.payload }));
    const tmp = join(dirname(target.path), `.bastra-task-${intent.id}.tmp`);
    await writePrivateNew(tmp, proposal.payload, target.mode);
    try {
      const currentRegistry = await taskActionRegistry(ctx); const currentTask = await validateTaskProposal(ctx, store, proposal, currentRegistry); await freshSources(ctx, currentTask, store);
      const current = await authenticateTask(authorization, ctx.authPath); if (current.actor_id !== intent.actor) fail("forbidden", "Credential revoked");
      const reserved = { ...store, consumed_approval_ids: store.consumed_approval_ids.filter(id => !intent.approval_ids.includes(id)) };
      const reservedState = taskApprovalStatus(ctx, reserved, proposal, currentRegistry);
      if (!reservedState.approved) fail(reservedState.domain_status.find(d => d.reason !== "approved")?.reason ?? "approval_stale", "Reserved owner proof no longer live");
      finalTargetCommit(ctx, store, intent, { token: input.holder_token, fence: input.fence }, target.path, tmp, guard.assertOwnership);
      const directory = await open(dirname(target.path), "r"); try { await directory.sync(); } finally { await directory.close(); }
      const receipt = { id: randomUUID(), intent_id: intent.id, proposal_id: proposal.id, task_id: task.id, actor: intent.actor, fence: intent.fence, at: (ctx.now ?? Date.now)(),
        outcome: "succeeded" as const, target_hash: proposal.payload_hash, before_hash: intent.before_hash, after_hash: intent.after_hash, backup_id: intent.backup_id };
      store = await guard.commit(s => { const row = s.intents.find(i => i.id === intent.id)!; row.state = "succeeded"; row.receipt_id = receipt.id; s.receipts.push(receipt); s.leases.find(l => l.id === lease.id)!.state = "released"; }, "control");
      return present(store.intents.find(i => i.id === intent.id)!);
    } finally { await unlink(tmp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  });
}
/** Startup/contact job recovery records observed state; it NEVER calls an adapter. */
export async function reconcilePendingTaskIntents(ctx: TaskServiceContext): Promise<void> {
  if (!ctx.executionHost) return;
  const registry = await taskActionRegistry(ctx);
  await withTaskStoreGuard(ctx.path, async guard => {
    const store = guard.snapshot(); let count = 0;
    for (const intent of store.intents) {
      if (intent.state !== "pending" || count++ >= 10) continue;
      const proposal = store.proposals.find(p => p.id === intent.proposal_id)!;
      let hash: string | undefined;
      try { if (proposal.registry_hash !== (await import("./task-approval-keys.js")).registryHash(registry)) throw new Error("Registry drift"); hash = (await readTaskTarget(registry, proposal.target_id)).hash; } catch { /* unknown retains an explicit review outcome */ }
      const outcome = hash === intent.after_hash && intent.recovery_epoch === store.recovery_epoch ? "reconciled" as const : "unknown" as const;
      const receipt = { id: randomUUID(), intent_id: intent.id, proposal_id: proposal.id, task_id: intent.task_id, actor: intent.actor, fence: intent.fence, at: (ctx.now ?? Date.now)(), outcome,
        ...(hash ? { target_hash: hash } : { error_code: "target_unavailable" }), before_hash: intent.before_hash, after_hash: intent.after_hash, backup_id: intent.backup_id };
      await guard.commit(s => { const row = s.intents.find(i => i.id === intent.id)!; row.state = outcome === "reconciled" ? "succeeded" : "unknown"; row.receipt_id = receipt.id; s.receipts.push(receipt); }, "control");
    }
  });
}
