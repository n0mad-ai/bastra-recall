/** Owner decision 2026-10-11: conversational notify, never execute authority. */
import { createHash } from "node:crypto";
import type { Task, TaskStore } from "./task-schema.js";
import { canonicalTaskValue } from "./task-canonical.js";
type ReminderDefinition = Pick<Task, "origin" | "goal" | "original_request" | "resolution_condition" | "schedule" | "timezone" | "recurrence" | "owner_domains" | "scope" | "sensitivity" | "evidence" | "decision">;
/** Hash actual pre-scrub content; identical redaction placeholders are not equality. */
export function reminderFingerprint(input: ReminderDefinition): string | undefined {
  if (!input.origin) return;
  return createHash("sha256").update(canonicalTaskValue({
    goal: input.goal, request: input.original_request, resolution: input.resolution_condition,
    origin: { kind: input.origin.kind, context: input.origin.context },
    schedule: input.schedule, timezone: input.timezone, recurrence: input.recurrence ?? null,
    domains: [...input.owner_domains].sort(), scope: input.scope, sensitivity: input.sensitivity,
    evidence: input.evidence, decision: input.decision ?? null,
  })).digest("hex");
}
export function reminderDuplicate(store: TaskStore, input: ReminderDefinition): Task | undefined {
  const fingerprint = reminderFingerprint(input); if (!fingerprint) return;
  // Old/edited rows have no recoverable raw content: prefer a separate reminder.
  return store.tasks.find(t => t.action_level === "notify" && !["resolved", "cancelled", "expired"].includes(t.state)
    && t.reminder_fingerprint === fingerprint);
}
