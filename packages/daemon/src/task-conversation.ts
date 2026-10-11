/** Owner decision 2026-10-11: conversational notify, never execute authority. */
import { privateTaskComparison } from "./task-private-comparison.js";
import type { Task, TaskStore } from "./task-schema.js";
type ReminderDefinition = Pick<Task, "origin" | "goal" | "original_request" | "resolution_condition" | "schedule" | "timezone" | "recurrence" | "owner_domains" | "scope" | "sensitivity" | "evidence" | "decision">;
/** Hash actual pre-scrub content; identical redaction placeholders are not equality. */
export async function reminderFingerprint(path: string, input: ReminderDefinition): Promise<string | undefined> {
  if (!input.origin) return;
  return privateTaskComparison(path,"reminder",{
    goal: input.goal, request: input.original_request, resolution: input.resolution_condition,
    origin: { kind: input.origin.kind, context: input.origin.context },
    schedule: input.schedule, timezone: input.timezone, recurrence: input.recurrence ?? null,
    domains: [...input.owner_domains].sort(), scope: input.scope, sensitivity: input.sensitivity,
    evidence: input.evidence, decision: input.decision ?? null,
  });
}
export async function reminderDuplicate(path: string, store: TaskStore, input: ReminderDefinition, legacyInput?: ReminderDefinition): Promise<Task | undefined> {
  const fingerprint = await reminderFingerprint(path,input); if (!fingerprint) return;
  // Old/edited rows have no recoverable raw content: prefer a separate reminder.
  const find = (value: string | undefined) => value && store.tasks.find(t => t.action_level === "notify" && !["resolved", "cancelled", "expired"].includes(t.state)
    && t.reminder_fingerprint === value);
  return find(fingerprint) || (legacyInput ? find(await reminderFingerprint(path,legacyInput)) : undefined) || undefined;
}
