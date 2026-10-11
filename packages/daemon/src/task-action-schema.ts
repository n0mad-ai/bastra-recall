/** P7 action objects are versioned and strict; no unchecked capability payload. */
import { z } from "zod";
const id = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,95}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const number = z.number().int().nonnegative().safe();
export const proposalSchema = z.strictObject({ id, revision: number, task_id: id, task_revision: number, generation: number,
  recovery_epoch: z.string().min(1).max(160), actor: id, created_at: number, target_id: id, target_hash: hash,
  operation: z.literal("replace-utf8"), rollback_of: id.optional(), payload: z.string().max(16384), payload_hash: hash,
  task_binding: hash, registry_hash: hash, required_domains: z.array(id).min(1).max(32),
  source_revisions: z.array(z.strictObject({ id: z.string().max(160), revision: z.string().max(160) })).max(100),
  scope: z.strictObject({ kind: z.enum(["personal", "project", "team"]), name: id }), sensitivity: z.enum(["public", "private", "restricted"]),
  status: z.enum(["prepared", "denied", "revoked"]),
});
export const challengeSchema = z.strictObject({ id, proposal_id: id, domain: id, nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  binding_hash: hash, created_at: number, expires_at: number, boot_id: z.string().max(160), monotonic_deadline: z.number().nonnegative(),
  consumed_at: number.optional() });
export const approvalSchema = z.strictObject({ id, proposal_id: id, domain: id, challenge_id: id, key_id: id,
  binding_hash: hash, registry_hash: hash, signature: z.string().max(256), decision: z.enum(["approve", "deny"]),
  created_at: number, expires_at: number, boot_id: z.string().max(160), monotonic_deadline: z.number().nonnegative(), revoked_at: number.optional() });
export const leaseSchema = z.strictObject({ id, task_id: id, proposal_id: id, actor: id, holder_token_hash: hash,
  fence: number, expires_at: number, boot_id: z.string().max(160), monotonic_deadline: z.number().nonnegative(), state: z.enum(["active", "released", "expired"]) });
export const intentSchema = z.strictObject({ id, proposal_id: id, task_id: id, actor: id, lease_id: id, fence: number,
  approval_ids: z.array(id).min(1).max(32), idempotency_key: id, created_at: number, recovery_epoch: z.string().max(160),
  before_hash: hash, after_hash: hash, backup_id: id, temp_cleanup_pending: z.boolean().optional(), state: z.enum(["pending", "succeeded", "unknown", "failed"]), receipt_id: id.optional() });
export const receiptSchema = z.strictObject({ id, intent_id: id, proposal_id: id, task_id: id, actor: id, fence: number, at: number,
  outcome: z.enum(["succeeded", "reconciled", "unknown", "failed"]), target_hash: hash.optional(), before_hash: hash, after_hash: hash, backup_id: id, error_code: id.optional() });
