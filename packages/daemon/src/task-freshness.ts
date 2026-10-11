import { canonicalTaskValue } from "./task-canonical.js";
/** Registered bounded evidence only; verify_cmd is never executable. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { relative, resolve, isAbsolute } from "node:path";
import { z } from "zod";
import matter from "gray-matter";
import { memoryRevision, scanVaultForIdAsync, occupantOfRaw, parseMemoryWith } from "@bastra-recall/core";
import type { ToolDeps } from "./tool-deps.js";
import type { Task, TaskStore, TaskSource } from "./task-schema.js";
import { readTaskStore, transactTaskStore } from "./task-store.js";
import type { TaskServiceContext } from "./task-service.js";
import { taskValueHash } from "./task-events.js";
export type TaskEvent = TaskStore["events"][number];
export type Verification = NonNullable<Task["verification"]>;
export interface TaskMemorySnapshot { id: string; revision: string; raw: string; body: string; sensitivity: string }
export function taskBindingHash(task: Task): string {
  return taskValueHash(canonicalTaskValue({ generation: task.generation, schedule: task.schedule, evidence: task.evidence, decision: task.decision, domains: task.owner_domains }));
}
export async function boundedTaskRead(path: string, max: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > max) throw new Error("source byte budget");
    const bytes = Buffer.alloc(max + 1); const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > max) throw new Error("source byte budget");
    return bytes.subarray(0, result.bytesRead).toString("utf8");
  } finally { await handle.close(); }
}
export function taskMemoryReader(deps: Pick<ToolDeps, "vault" | "vaultPath">) {
  return async (id: string): Promise<TaskMemorySnapshot> => {
    const indexed = deps.vault.get(id);
    if (indexed && indexed.fm.id !== id) throw new Error("memory cache identity disagreement");
    const located = await scanVaultForIdAsync(deps.vaultPath, id, undefined, { maxBytes: 1024 * 1024, maxFiles: 1000, deadline: Date.now() + 1000 });
    if (located.kind !== "unique") throw new Error("memory binding unresolved");
    const root = await realpath(deps.vaultPath); const target = await realpath(located.filePath);
    const rel = relative(root, target); if (rel.startsWith("..") || isAbsolute(rel) || target !== resolve(root, relative(resolve(deps.vaultPath), resolve(located.filePath)))) throw new Error("memory escaped");
    const raw = await boundedTaskRead(target, 1024 * 1024);
    const occupant = occupantOfRaw(raw, target); if (occupant.kind !== "memory" || occupant.id !== id) throw new Error("memory rebound");
    const memory = parseMemoryWith(matter, raw, target, Date.now());
    return { id, raw, body: memory.body, revision: memoryRevision(raw), sensitivity: memory.fm.sensitivity ?? "public" };
  };
}
function result(task: Task, event: TaskEvent, source: TaskSource | undefined, now: number, outcome: Verification["outcome"], reason: string): Verification {
  return { outcome, reason, source_id: event.source_id, source_revision: event.source_revision, event_id: event.id,
    binding_hash: taskBindingHash(task), observed_at: event.observed_at, state_updated_at: event.state_updated_at,
    max_age_ms: source?.max_age_ms ?? 0, timeout_ms: task.budget.timeout_ms, checked_at: now };
}
export function verifyTaskEvent(task: Task, event: TaskEvent, store: TaskStore, now: number): Verification {
  const source = store.sources.find(s => s.id === event.source_id);
  const out = (outcome: Verification["outcome"], reason: string) => result(task, event, source, now, outcome, reason);
  if (!source?.enabled) return out("unavailable", "source_disabled_or_missing");
  if (event.source_revision !== String(source.revision) || event.actor !== source.producer_actor
    || !source.owner_domains.every(d => task.owner_domains.includes(d))) return out("inconclusive", "source_identity_drift");
  if (event.state_updated_at === undefined || event.state_updated_at > event.observed_at || event.observed_at > now)
    return out("inconclusive", "unattributable_state_age");
  if (now - event.state_updated_at > source.max_age_ms) return out("stale", "state_too_old");
  if (task.evidence.some(e => e.state_updated_at !== undefined && (e.state_updated_at > now || e.state_updated_at > e.observed_at))) return out("inconclusive", "unattributable_state_age");
  if (task.evidence.some(e => e.provenance !== "attributable")) return out("inconclusive", "unknown_or_contested_evidence");
  if (task.evidence.some(e => e.observed_at > now || now - (e.state_updated_at ?? e.observed_at) > e.max_age_ms)) return out("stale", "evidence_too_old");
  if (task.schedule.kind !== "event" || !task.schedule.expected_hash || !event.value_hash) return out("inconclusive", "missing_comparison_hash");
  if (task.schedule.predicate === "premise") return out("inconclusive", "premise_requires_evidence_verifier");
  return out(task.schedule.expected_hash === event.value_hash ? "verified" : "refuted", "exact_versioned_value");
}
const claimEvidence = z.strictObject({ claim_id: z.string(), claim_revision: z.string(), value: z.string(), state_updated_at: z.number().int().nonnegative().safe(), provenance: z.enum(["attributable", "contested", "unknown"]) });
type ReadContext = TaskServiceContext & {
  deadline?: number; sourceCache?: Map<string, Promise<{raw: string; body: string; revision: string}>>;
  sourceReads?: Map<string, number>;
};
async function evidenceSnapshot(ctx: ReadContext, source: TaskSource, max: number): Promise<{ raw: string; body: string; revision: string }> {
  if (ctx.deadline !== undefined && Date.now() >= ctx.deadline) throw new Error("source timeout");
  const key = `${source.id}:${source.revision}:${max}`;
  const cached = ctx.sourceCache?.get(key); if (cached) return cached;
  if ((ctx.sourceReads?.get(source.id) ?? 0) >= 10 || (ctx.sourceReads && [...ctx.sourceReads.values()].reduce((a, b) => a + b, 0) >= 100)) throw new Error("source budget");
  ctx.sourceReads?.set(source.id, (ctx.sourceReads.get(source.id) ?? 0) + 1);
  const pending = (async () => {
  if (source.kind === "memory" && ctx.memoryRead) {
    const snap = await ctx.memoryRead(source.memory_id!);
    if (Buffer.byteLength(snap.raw) > max || (snap.sensitivity !== "public" && source.sensitivity === "public")) throw new Error("evidence disclosure denied");
    return snap;
  }
  if (source.kind !== "file") throw new Error("unsupported evidence source");
  const root = await realpath(source.root!); const path = resolve(root, source.path!); const rel = relative(root, path);
  if (root !== source.root || rel.startsWith("..") || isAbsolute(rel) || await realpath(path) !== path) throw new Error("evidence path escaped");
  const raw = await boundedTaskRead(path, max); return { raw, body: raw, revision: taskValueHash(raw) };
  })();
  ctx.sourceCache?.set(key, pending);
  const snapshot = await pending;
  if (ctx.deadline !== undefined && Date.now() >= ctx.deadline) throw new Error("source timeout");
  return snapshot;
}
async function verifyBoundEvidence(ctx: ReadContext, task: Task, store: TaskStore, now: number): Promise<{ outcome: Verification["outcome"]; reason: string }> {
  if (task.evidence.length > 10) return { outcome: "unavailable", reason: "source_budget" };
  for (const reference of task.evidence) {
    if (reference.state_updated_at !== undefined && (reference.state_updated_at > now || reference.state_updated_at > reference.observed_at)) return { outcome: "inconclusive", reason: "unattributable_state_age" };
    if (reference.provenance !== "attributable") return { outcome: "inconclusive", reason: "unknown_or_contested_evidence" };
    if (reference.observed_at > now || now - (reference.state_updated_at ?? reference.observed_at) > reference.max_age_ms)
      return { outcome: "stale", reason: "evidence_too_old" };
    const source = store.sources.find(s => s.id === reference.source_id && s.enabled);
    if (!source || !source.owner_domains.every(d => task.owner_domains.includes(d))) return { outcome: "unavailable", reason: "evidence_unavailable" };
    try {
      const snap = await evidenceSnapshot(ctx, source, task.budget.max_source_bytes);
      if (snap.revision !== reference.revision || (reference.hash && taskValueHash(snap.raw) !== reference.hash))
        return { outcome: "stale", reason: "evidence_revision_drift" };
    } catch { return { outcome: "unavailable", reason: "evidence_read_failed" }; }
  }
  return { outcome: "verified", reason: "bound_sources_verified" };
}
export async function verifyTaskSource(ctx: ReadContext, task: Task, event: TaskEvent, store: TaskStore, now: number): Promise<Verification> {
  ctx = { ...ctx, deadline: ctx.deadline ?? Date.now() + task.budget.timeout_ms };
  const basic = verifyTaskEvent(task, event, store, now);
  if (task.schedule.kind !== "event" || task.schedule.predicate !== "premise" || basic.reason !== "premise_requires_evidence_verifier") {
    if (["verified", "refuted"].includes(basic.outcome) && task.evidence.length) {
      const evidence = await verifyBoundEvidence(ctx, task, store, now);
      if (evidence.outcome !== "verified") return { ...basic, ...evidence };
    }
    return basic;
  }
  const out = (outcome: Verification["outcome"], reason: string): Verification => ({ ...basic, outcome, reason });
  if (task.schedule.verifier_id !== "versioned-value-v1" || !task.decision || !event.claim) return out("inconclusive", "unregistered_claim_verifier");
  const allEvidence = await verifyBoundEvidence(ctx, task, store, now);
  if (allEvidence.outcome !== "verified") return out(allEvidence.outcome, allEvidence.reason);
  const claim = event.claim;
  if (claim.claim_id !== task.decision.assumption_id || claim.claim_revision !== task.decision.assumption_revision) return out("inconclusive", "irrelevant_claim");
  const reference = task.evidence.find(e => e.id === claim.evidence_id && e.revision === claim.evidence_revision && e.provenance === "attributable");
  const source = reference && store.sources.find(s => s.id === reference.source_id && s.enabled);
  if (!source || !source.owner_domains.every(d => task.owner_domains.includes(d))) return out("unavailable", "evidence_unavailable");
  try {
    const snap = await evidenceSnapshot(ctx, source, task.budget.max_source_bytes);
    if (snap.revision !== claim.evidence_revision || (reference?.hash && reference.hash !== taskValueHash(snap.raw))) return out("stale", "evidence_revision_drift");
    const data = claimEvidence.safeParse(JSON.parse(snap.body));
    if (!data.success || data.data.provenance !== "attributable") return out("inconclusive", "evidence_not_attributable");
    if (data.data.state_updated_at > now || data.data.state_updated_at > event.observed_at || data.data.state_updated_at > reference!.observed_at) return out("inconclusive", "unattributable_state_age");
    if (now - data.data.state_updated_at > reference!.max_age_ms) return out("stale", "producer_state_too_old");
    if (data.data.claim_id !== claim.claim_id || data.data.claim_revision !== claim.claim_revision || taskValueHash(data.data.value) !== claim.value_hash)
      return out("inconclusive", "claim_evidence_mismatch");
    return { ...out(claim.value_hash === task.schedule.expected_hash ? "verified" : "refuted", "verified_claim_snapshot"), state_updated_at: data.data.state_updated_at, max_age_ms: Math.min(basic.max_age_ms, reference!.max_age_ms) };
  } catch { return out("unavailable", "evidence_read_failed"); }
}
function verificationChanged(before: Verification | undefined, after: Verification): boolean {
  const stable = (v: Verification) => ({ ...v, checked_at: 0, observed_at: v.event_id === "clock" ? 0 : v.observed_at });
  return !before || canonicalTaskValue(stable(before)) !== canonicalTaskValue(stable(after));
}
/** Off-path cache, re-bound on every read; no command strings or model attestations. */
export async function assessTaskFreshness(ctx: TaskServiceContext): Promise<void> {
  const store = await readTaskStore(ctx.path); if (!store.controls.enabled) return;
  const sourceCache: ReadContext["sourceCache"] = new Map(); const sourceReads = new Map<string, number>();
  const started = Date.now(); const updates: Array<{ id: string; verification: Verification }> = [];
  for (const task of store.tasks.filter(t => t.armed && (t.schedule.kind === "event" || t.evidence.length)).slice(0, 100)) {
    if (Date.now() - started >= 5000) break;
    const event = [...store.events].reverse().find(e => task.schedule.kind === "event" && e.source_id === task.schedule.source_id);
    if (!event && task.schedule.kind === "event") continue;
    const observed = event ?? { id: "clock", dedup_key: "clock", sequence: 0, source_id: "clock", source_revision: "clock", actor: "task-source-reader", owner_domains: task.owner_domains, sensitivity: task.sensitivity, observed_at: (ctx.now ?? Date.now)(), state_updated_at: (ctx.now ?? Date.now)(), value: "clock" };
    const boundedCtx: ReadContext = { ...ctx, deadline: Date.now() + task.budget.timeout_ms, sourceCache, sourceReads };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = { ...verifyTaskEvent(task, observed, store, (ctx.now ?? Date.now)()), outcome: "unavailable" as const, reason: "source_timeout" };
    const verification = await Promise.race([task.schedule.kind === "event" ? verifyTaskSource(boundedCtx, task, observed, store, (ctx.now ?? Date.now)())
      : verifyBoundEvidence(boundedCtx, task, store, (ctx.now ?? Date.now)()).then(evidence => ({ ...unavailable, ...evidence, source_id: "clock", event_id: "clock", state_updated_at: Math.min(...task.evidence.map(e => e.state_updated_at ?? e.observed_at)), max_age_ms: Math.min(...task.evidence.map(e => e.max_age_ms)) })),
      new Promise<Verification>(resolve => { timer = setTimeout(() => resolve(unavailable), task.budget.timeout_ms); })]);
    if (timer) clearTimeout(timer);
    if (verificationChanged(task.verification, verification)) updates.push({ id: task.id, verification });
  }
  if (!updates.length) return;
  await transactTaskStore(ctx.path, undefined, s => {
    for (const update of updates) {
      const task = s.tasks.find(t => t.id === update.id); if (!task || taskBindingHash(task) !== update.verification.binding_hash) continue;
      if (!verificationChanged(task.verification, update.verification)) continue;
      const before = task.revision++; task.verification = update.verification; task.updated_at = update.verification.checked_at;
      task.history.push({ at: task.updated_at, actor: "task-source-reader", operation: "freshness", before_revision: before, after_revision: task.revision, reason: update.verification.reason });
    }
  });
}
