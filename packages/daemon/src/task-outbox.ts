/** Durable occurrences own delivery attempts; relay consumption owns nothing here. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { TaskStore } from "./task-schema.js";
import { taskIdentitySchema } from "./task-schema.js";
import type { TaskPrincipal } from "./task-auth.js";
import { transactTaskStore } from "./task-store.js";
import { taskRuntime } from "./task-runtime.js";
export const taskDueInput = z.strictObject({ session: taskIdentitySchema.default("unknown"),
  channel: z.enum(["mcp", "http", "cli", "session", "prompt", "ui"]).default("http"),
  max_bytes: z.number().int().min(256).max(16384).default(2048), include_acknowledged: z.boolean().default(false) });
export type DueInput = z.infer<typeof taskDueInput>;
export function taskDueProjection(store: TaskStore, principal: TaskPrincipal, input: DueInput, now: number) {
  const client = createHash("sha256").update(JSON.stringify(["task-client-v1", principal.actor_id, input.session, input.channel])).digest("hex");
  const candidates = store.controls.enabled && !store.controls.muted ? store.occurrences.filter(o => {
    const task = store.tasks.find(t => t.id === o.task_id);
    return task?.armed && task.generation === o.generation && !["resolved", "cancelled", "expired"].includes(task.state)
      && !(task.state === "snoozed" && task.snoozed_until! > now) && !task.notification_policy.muted
      && !o.resolution && (input.include_acknowledged || !o.acknowledgement)
      && task.owner_domains.every(d => principal.domains.includes(d));
  }) : [];
  const attemptCount = (id: string) => store.occurrences.find(o => o.id === id)!.attempts.filter(a => a.client === client);
  candidates.sort((a, b) => (attemptCount(a.id).at(-1)?.at ?? 0) - (attemptCount(b.id).at(-1)?.at ?? 0) || a.id.localeCompare(b.id));
  const cards: Array<Record<string, unknown>> = []; const occurrenceIds: string[] = [];
  let bytes = 0; let retryBlocked = 0; let overflow = 0;
  for (const occurrence of candidates) {
    const task = store.tasks.find(t => t.id === occurrence.task_id)!; const attempts = attemptCount(occurrence.id);
    if (attempts.length >= task.notification_policy.max_attempts || occurrence.attempts.length >= 100
      || (attempts.length > 0 && now - attempts.at(-1)!.at < task.notification_policy.retry_interval_ms)) { retryBlocked++; continue; }
    const card = { occurrence_id: occurrence.id, task_id: task.id, expected_revision: `${store.recovery_epoch}:${task.revision}`,
      goal: task.goal.slice(0, 200), original_request: task.original_request.slice(0, 300), why_now: occurrence.why.slice(0, 200),
      due_at: occurrence.due_at, timezone: task.timezone, action_level: task.action_level, acknowledged: !!occurrence.acknowledgement,
      source_status: task.verification?.outcome ?? "clock", evidence: task.evidence.slice(0, 3).map(e => ({ id: e.id, revision: e.revision, observed_at: e.observed_at, state_updated_at: e.state_updated_at })),
      controls: ["acknowledge", "snooze", "resolve", "cancel"],
    };
    const size = Buffer.byteLength(JSON.stringify(card));
    if (cards.length >= 3 || bytes + size > input.max_bytes - 256) { overflow++; continue; }
    cards.push(card); occurrenceIds.push(occurrence.id); bytes += size;
  }
  return { coverage: "next-contact-only", cards, pending: candidates.length, overflow, retry_blocked: retryBlocked, client, occurrenceIds };
}
export function taskDueText(projection: ReturnType<typeof taskDueProjection>): string {
  return projection.cards.length ? `<bastra-due coverage="next-contact-only">${JSON.stringify({ cards: projection.cards, overflow: projection.overflow })}</bastra-due>` : "";
}
export async function recordTaskDelivery(path: string, principal: TaskPrincipal, client: string, occurrenceIds: string[], now: number): Promise<void> {
  if (!occurrenceIds.length) return;
  await transactTaskStore(path, undefined, store => {
    for (const id of occurrenceIds) {
      const occurrence = store.occurrences.find(o => o.id === id); const task = occurrence && store.tasks.find(t => t.id === occurrence.task_id);
      if (!occurrence || !task || !task.owner_domains.every(d => principal.domains.includes(d)) || task.generation !== occurrence.generation || !task.armed
        || ["resolved", "cancelled", "expired"].includes(task.state) || occurrence.resolution || occurrence.acknowledgement || occurrence.attempts.length >= 100) continue;
      occurrence.attempts.push({ attempt_id: randomUUID(), at: now, client, outcome: "attempted" });
    }
  }, "control");
}
export function cachedTaskSnapshot(path: string): TaskStore | undefined { const runtime = taskRuntime(path);
  return runtime?.lastError === "task_store_unavailable" || runtime?.lastError === "task_job_unavailable" ? undefined : runtime?.snapshot; }
