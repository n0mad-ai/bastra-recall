import type { Task, TaskStore } from "./task-schema.js";

/** Validity is independent of a due time, recurrence end or snooze. */
export function taskValidityExpired(task: Task, now: number): boolean {
  return task.expires_at !== undefined && task.expires_at <= now;
}
export function isTaskExpiryNotice(task: Task, occurrence: TaskStore["occurrences"][number]): boolean {
  return task.state === "expired" && occurrence.kind === "expired" && task.generation === occurrence.generation;
}
