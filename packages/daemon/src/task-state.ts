/** Persisted task identity and provenance; independent of session IO/locks. */
import type { TaskKind } from "./prompt-classify.js";

export interface ActiveTask {
  id: string;
  kind: TaskKind;
  /** Read-only legacy metadata; never an approval assertion in current output. */
  approvalSource?: "user-turn";
  /** Legacy persisted channel, retained for backwards-compatible reads. */
  validatorChannel?: string;
  since: number;
  generation: number;
}

export function taskIdFor(kind: TaskKind, since: number): string {
  return `${kind}@${since}`;
}

const TASK_KINDS: ReadonlySet<string> = new Set<TaskKind>(["translate-only", "draft-for-review", "approved-copy", "none"]);
export function decodeActiveTask(value: unknown): ActiveTask | undefined {
  if (!value || typeof value !== "object") return;
  const task = value as Record<string, unknown>;
  if (typeof task.kind !== "string" || !TASK_KINDS.has(task.kind) || typeof task.since !== "number" || typeof task.generation !== "number") return;
  return {
    id: typeof task.id === "string" ? task.id : taskIdFor(task.kind as TaskKind, task.since),
    kind: task.kind as TaskKind, since: task.since, generation: task.generation,
    ...(typeof task.validatorChannel==='string'&&task.validatorChannel?{validatorChannel:task.validatorChannel}:{}),
    ...(task.approvalSource === "user-turn" ? {approvalSource: "user-turn" as const} : {}),
  };
}
