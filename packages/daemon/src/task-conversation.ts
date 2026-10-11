/** Owner decision 2026-10-11: conversational notify, never execute authority. */
import type { Task, TaskStore } from "./task-schema.js";
import { canonicalTaskValue } from "./task-canonical.js";
import { cleanText } from "./task-store.js";
export function reminderDuplicate(store: TaskStore, input: Pick<Task, "origin" | "schedule" | "recurrence" | "owner_domains" | "scope">): Task | undefined {
  if (!input.origin) return;
  return store.tasks.find(t => t.action_level === "notify" && !["resolved", "cancelled", "expired"].includes(t.state)
    && t.origin?.kind === input.origin!.kind && cleanText(t.origin.context) === cleanText(input.origin!.context)
    && canonicalTaskValue(t.schedule) === canonicalTaskValue(input.schedule)
    && canonicalTaskValue(t.recurrence ?? null) === canonicalTaskValue(input.recurrence ?? null)
    && canonicalTaskValue([...t.owner_domains].sort()) === canonicalTaskValue([...input.owner_domains].sort())
    && canonicalTaskValue(t.scope) === canonicalTaskValue(input.scope));
}
