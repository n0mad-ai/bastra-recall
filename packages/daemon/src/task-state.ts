/** Persisted task identity and provenance; independent of session IO/locks. */
import type { TaskKind } from "./prompt-classify.js";
import type { ConventionValidator } from "@bastra-recall/core";

export interface TaskValidatorBinding { id: string; validator: ConventionValidator }

export interface ActiveTask {
  id: string;
  kind: TaskKind;
  approvalSource?: "user-turn";
  /** Rule that started this copy task; later unrelated loads cannot retarget it. */
  validatorRuleId?: string;
  /** Frozen constraints, not pointers to mutable load/catalog metadata. */
  validatorBindings?: TaskValidatorBinding[];
  validatorBindingSource?: "user-turn" | "model";
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
    ...(task.approvalSource === "user-turn" ? {approvalSource: "user-turn" as const} : {}),
    ...(typeof task.validatorRuleId === "string" && task.validatorRuleId ? {validatorRuleId: task.validatorRuleId} : {}),
    ...(Array.isArray(task.validatorBindings) ? {validatorBindings: task.validatorBindings.filter((v):v is TaskValidatorBinding =>
      !!v && typeof v === "object" && typeof v.id === "string" && !!v.validator && typeof v.validator === "object")} : {}),
    ...(task.validatorBindingSource === "user-turn" || task.validatorBindingSource === "model" ? {validatorBindingSource:task.validatorBindingSource} : {}),
  };
}
