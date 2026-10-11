/** Commitment persistence contract (#403); independent of memory/draft schemas. */
import { proposalSchema, challengeSchema, approvalSchema, leaseSchema, intentSchema, receiptSchema } from "./task-action-schema.js";
import { z } from "zod";

export const TASK_STORE_VERSION = 3;
export const TASK_MAX_BYTES = 4 * 1024 * 1024;
export const TASK_MAX_ROWS = 1000;
const instant = z.number().int().nonnegative().safe();
const revision = z.number().int().nonnegative().safe();
const id = z.string().min(1).max(160);
/** Identity fields are opaque machine IDs, never prose, paths or credentials. */
export const taskIdentitySchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,95}$/);
const text = z.string().min(1).max(4096);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const domains = z.array(taskIdentitySchema).min(1).max(32).refine(v => new Set(v).size === v.length, "duplicate owner domains");

export const taskReferenceSchema = z.strictObject({
  source_id: id, id, revision: id, hash: hash.optional(),
  observed_at: instant, state_updated_at: instant.optional(),
  max_age_ms: instant, provenance: z.enum(["attributable", "unknown", "contested"]),
});

export const taskScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("instant"), at: instant }),
  z.strictObject({ kind: z.literal("duration"), reference_at: instant, duration_ms: instant, at: instant }),
  z.strictObject({
    kind: z.literal("calendar"), local_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
    timezone: z.string().min(1).max(128), gap: z.literal("reject"),
    overlap: z.literal("earlier"), at: instant, offset_minutes: z.number().int().min(-840).max(840),
  }),
  z.strictObject({
    kind: z.literal("event"), source_id: id,
    predicate: z.enum(["equals", "content-version", "git-ref", "premise"]),
    expected: text, expected_hash: hash.optional(), verifier_id: id.optional(),
  }),
]);

export const taskDecisionSchema = z.strictObject({
    id, revision: id, option: text, reason: text, assumption_id: id,
    assumption_revision: id, premise: text, alternatives: z.array(text).max(20),
});

export const taskSchema = z.strictObject({
  id, revision, generation: revision, creation_hash: hash.optional(),
  created_at: instant, updated_at: instant,
  original_request: text, request_source: id, request_reference: id.optional(),
  creator: taskIdentitySchema, actor: taskIdentitySchema, owner_domains: domains,
  scope: z.strictObject({ kind: z.enum(["personal", "project", "team"]), name: taskIdentitySchema }),
  sensitivity: z.enum(["public", "private", "restricted"]),
  goal: text, resolution_condition: text,
  state: z.enum(["pending", "due", "snoozed", "resolved", "cancelled", "expired"]),
  armed: z.boolean(), review_reason: z.string().max(4096).optional(),
  schedule: taskScheduleSchema,
  timezone: z.string().min(1).max(128), reference_at: instant,
  recurrence: z.strictObject({
    kind: z.enum(["elapsed", "calendar"]), interval: z.number().int().positive().safe(),
    count: z.number().int().positive().max(10000).optional(), until: instant.optional(),
    catch_up: z.literal("latest"),
  }).refine(r => r.count !== undefined || r.until !== undefined, "recurrence must be bounded").optional(),
  action_level: z.enum(["notify", "prepare", "execute"]),
  notification_policy: z.strictObject({
    muted: z.boolean(), retry_interval_ms: z.number().int().positive().safe(),
    max_attempts: z.number().int().positive().max(100),
  }),
  budget: z.strictObject({
    poll_interval_ms: z.number().int().min(60000).safe(),
    timeout_ms: z.number().int().positive().max(1000),
    max_source_bytes: z.number().int().positive().max(1024 * 1024),
  }),
  evidence: z.array(taskReferenceSchema).max(100),
  decision: taskDecisionSchema.optional(),
  decision_change: z.strictObject({ id, actor: taskIdentitySchema, binding_hash: hash, expected_memory_revision: id, new_body_hash: hash, new_memory_hash: hash.optional(), updated_date: z.string().optional(), new_option: text, new_reason: text, status: z.enum(["pending", "applied"]), resulting_revision: id.optional() }).optional(),
  last_material_hash: hash.optional(), last_event_sequence: revision.optional(), slots_checked: revision.optional(), next_slot: z.strictObject({ at: instant, index: revision, key: id, local_time: text.optional(), offset_minutes: z.number().optional() }).optional(),
  next_check_at: instant.optional(), snoozed_until: instant.optional(), agent_snooze_deadline: instant.optional(),
  verification: z.lazy(() => taskVerificationSchema).optional(),
  last_failure: z.strictObject({ at: instant, code: id, message: text }).optional(),
  history: z.array(z.strictObject({
    at: instant, actor: taskIdentitySchema, operation: id,
    before_revision: revision, after_revision: revision, reason: text,
    decision_snapshot: z.strictObject({ decision: taskDecisionSchema, evidence: z.array(taskReferenceSchema).max(100) }).optional(),
  })).max(10000),
}).superRefine((task, ctx) => {
  if (["resolved", "cancelled", "expired"].includes(task.state) && task.armed)
    ctx.addIssue({ code: "custom", message: "terminal task cannot be armed" });
  if (task.state === "snoozed" && task.snoozed_until === undefined)
    ctx.addIssue({ code: "custom", message: "snoozed task requires an instant" });
  if (task.schedule.kind === "duration" && task.schedule.at !== task.schedule.reference_at + task.schedule.duration_ms)
    ctx.addIssue({ code: "custom", message: "duration instant disagrees with reference" });
  if (task.recurrence && ((task.schedule.kind === "event") || (task.recurrence.kind === "calendar" && task.schedule.kind !== "calendar")))
    ctx.addIssue({ code: "custom", message: "recurrence kind and schedule disagree" });
  if (task.schedule.kind === "event" && task.schedule.predicate === "premise" && !task.schedule.verifier_id)
    ctx.addIssue({ code: "custom", message: "premise requires a registered verifier" });
  try { new Intl.DateTimeFormat("en", { timeZone: task.timezone }); }
  catch { ctx.addIssue({ code: "custom", message: "invalid timezone" }); }
  if (task.schedule.kind === "calendar" && task.schedule.timezone !== task.timezone)
    ctx.addIssue({ code: "custom", message: "calendar and task timezone disagree" });
});

export const taskClaimSchema = z.strictObject({
  claim_id: id, claim_revision: id, value_hash: hash, evidence_id: id, evidence_revision: id,
});
export const taskVerificationSchema = z.strictObject({
  outcome: z.enum(["verified", "refuted", "stale", "unavailable", "inconclusive"]),
  reason: id, source_id: id, source_revision: id, event_id: id,
  binding_hash: hash, refuted_value: text.optional(), observed_at: instant, state_updated_at: instant.optional(),
  max_age_ms: instant, timeout_ms: instant, checked_at: instant,
});
const eventSchema = z.strictObject({
  sequence: revision, id, dedup_key: id, source_id: id, source_revision: id,
  actor: taskIdentitySchema, owner_domains: domains, observed_at: instant,
  state_updated_at: instant.optional(), sensitivity: z.enum(["public", "private", "restricted"]),
  value: text, value_hash: hash.optional(), claim: taskClaimSchema.optional(), observation_bytes:instant.optional(), observation_ms:instant.optional(),
});

const occurrenceSchema = z.strictObject({
  id, task_id: id, task_revision: revision, generation: revision,
  event_key: id, new_premise: text.optional(), due_at: instant, why: text, missed_count: revision,
  attempts: z.array(z.strictObject({ attempt_id: id.optional(), count: revision.optional(), first_at: instant.optional(), actor: taskIdentitySchema.optional(), role: z.enum(["owner", "agent"]).optional(), last_session: taskIdentitySchema.optional(), last_action_key: hash.optional(), channel: id.optional(), at: instant, client: id, outcome: id })).max(100),
  compacted_attempts: revision.optional(),
  acknowledgement: z.strictObject({ at: instant, actor: taskIdentitySchema, proof_id: id }).optional(),
  resolution: z.strictObject({ at: instant, actor: taskIdentitySchema, reason: text }).optional(),
});

export const taskSourceSchema = z.strictObject({
  schema_version: z.literal(1), id: taskIdentitySchema, revision: revision,
  owner_domains: domains, sensitivity: z.enum(["public", "private", "restricted"]),
  kind: z.enum(["event", "file", "git", "memory"]), producer_actor: taskIdentitySchema,
  root: z.string().min(1).max(4096).optional(), path: z.string().min(1).max(4096).optional(),
  ref: z.string().regex(/^refs\/(heads|tags)\/[a-zA-Z0-9._/-]+$/).max(256).optional(),
  memory_id: id.optional(), max_age_ms: instant, enabled: z.boolean(),
  observation_number: revision.default(0), last_value_hash: hash.optional(),
}).superRefine((s, ctx) => {
  if ((s.kind === "file" && (!s.root || !s.path)) || (s.kind === "git" && (!s.root || !s.ref)) || (s.kind === "memory" && !s.memory_id))
    ctx.addIssue({ code: "custom", message: "source registration incomplete" });
});
export type TaskSource = z.infer<typeof taskSourceSchema>;

// v2 introduces preparation/signatures/local leases; execution records remain empty.
export const taskStoreSchema = z.strictObject({
  schema_version: z.literal(TASK_STORE_VERSION), revision, recovery_epoch: id, fencing_counter: revision, evaluation_cursor: revision.default(0),
  sources: z.array(taskSourceSchema).max(1000).default([]),
  tasks: z.array(taskSchema).max(TASK_MAX_ROWS), events: z.array(eventSchema).max(10000),
  checkpoint: revision, occurrences: z.array(occurrenceSchema).max(10000),
  proposals: z.array(proposalSchema).max(1000), challenges: z.array(challengeSchema).max(10000), approvals: z.array(approvalSchema).max(10000),
  leases: z.array(leaseSchema).max(1000), intents: z.array(intentSchema).max(1000), receipts: z.array(receiptSchema).max(10000),
  consumed_approval_ids: z.array(id).max(10000),
  archives: z.array(z.strictObject({id:z.string().uuid(),hash,at:instant,actor:taskIdentitySchema,task_ids:z.array(id).min(1).max(1000),intent_keys:z.array(hash).max(1000),owner_domains:domains})).max(1000).default([]),
  recovery_history: z.array(z.strictObject({
    id, at: instant, from_revision: revision, actor: id, reason: text,
  })).max(1000),
  controls: z.strictObject({
    enabled: z.boolean(), muted: z.boolean(), execution_stopped: z.boolean(),
    adapters: z.record(id, z.strictObject({ enabled: z.boolean(), coverage: z.string().max(256) })),
  }),
}).superRefine((store, ctx) => {
  for (const rows of [store.tasks, store.events, store.occurrences, store.sources, store.proposals, store.challenges, store.approvals, store.leases, store.intents, store.receipts]) {
    if (new Set(rows.map(row => row.id)).size !== rows.length)
      ctx.addIssue({ code: "custom", message: "duplicate record identity" });
  }
  const proposalIds = new Set(store.proposals.map(p => p.id));
  if (store.proposals.some(p => !store.tasks.some(t => t.id === p.task_id)) || store.challenges.some(c => !proposalIds.has(c.proposal_id)) || store.approvals.some(a => !proposalIds.has(a.proposal_id) || !store.challenges.some(c => c.id === a.challenge_id)) || store.leases.some(l => !proposalIds.has(l.proposal_id)))
    ctx.addIssue({ code: "custom", message: "orphan action record" });
  if (new Set(store.consumed_approval_ids).size !== store.consumed_approval_ids.length) ctx.addIssue({ code: "custom", message: "duplicate spent approval" });
  if (store.intents.some(i => !proposalIds.has(i.proposal_id) || !store.leases.some(l => l.id === i.lease_id) || i.approval_ids.some(id => !store.approvals.some(a => a.id === id))) || store.receipts.some(r => !store.intents.some(i => i.id === r.intent_id)))
    ctx.addIssue({ code: "custom", message: "orphan intent/receipt" });
  const taskIds = new Set(store.tasks.map(t => t.id));
  if (store.occurrences.some(o => !taskIds.has(o.task_id)))
    ctx.addIssue({ code: "custom", message: "orphan occurrence" });
  if (store.checkpoint > (store.events.at(-1)?.sequence ?? 0))
    ctx.addIssue({ code: "custom", message: "checkpoint beyond journal" });
  for (let i = 1; i < store.events.length; i++) {
    if (store.events[i].sequence <= store.events[i - 1].sequence)
      ctx.addIssue({ code: "custom", message: "non-contiguous journal" });
  }
});

export type Task = z.infer<typeof taskSchema>;
export type TaskStore = z.infer<typeof taskStoreSchema>;

/** ENOENT is the pre-feature migration: memories and drafts remain untouched. */
export function emptyTaskStore(): TaskStore {
  return { schema_version: TASK_STORE_VERSION, revision: 0, recovery_epoch: "initial", fencing_counter: 0, evaluation_cursor: 0,
    sources: [], tasks: [], events: [], checkpoint: 0, occurrences: [], proposals: [],
    challenges: [], approvals: [], leases: [], intents: [], receipts: [], consumed_approval_ids: [], archives: [], recovery_history: [],
    controls: { enabled: true, muted: false, execution_stopped: true, adapters: {} } };
}
