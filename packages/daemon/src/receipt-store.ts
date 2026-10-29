/**
 * #1310 — per-session store of successful `validate_artifact` receipts.
 *
 * A receipt is a positive claim ("these bytes passed these checks for this
 * task"), so it is written only into the session that called, bound to the
 * running task (`activeTask.id`) and its generation. Nothing is guessed: a call
 * without a known session stores nothing (unlike the pending clear of #1301,
 * which may safely touch every session).
 *
 * Receipts expire with their task: when the kind goes to `none` or changes
 * (a new task id), and when the generation rises on compact/clear/fork
 * (`bumpTaskGeneration`). Only hashes and parameters are kept, never text.
 *
 * `findReceipt` is the read side for the Stop lane (#1311).
 */
import type { CopyBlocksResult } from "@bastra-recall/core";
import { mutateSessionState, type ArtifactReceipt, type ReadonlySessionState, type SessionState } from "./session-state.js";

/** Bound on receipts one session keeps; the oldest go first. */
export const RECEIPTS_CAP = 20;

/** The newest receipt of task `taskId` in `generation` (and of artifact `hash`, when given), or null. */
export function findReceipt(
  state: ReadonlySessionState | SessionState,
  query: { taskId: string; generation: number; hash?: string },
): Readonly<ArtifactReceipt> | null {
  const receipts = state.receipts ?? [];
  for (let i = receipts.length - 1; i >= 0; i--) {
    const r = receipts[i]!;
    if (r.taskId !== query.taskId || r.generation !== query.generation) continue;
    if (query.hash !== undefined && r.hash !== query.hash) continue;
    return r;
  }
  return null;
}

/** The newest receipt for the task the state is in right now, or null. */
export function currentReceipt(state: ReadonlySessionState | SessionState): Readonly<ArtifactReceipt> | null {
  const task = state.activeTask;
  if (!task || task.kind === "none") return null;
  return findReceipt(state, { taskId: task.id, generation: task.generation });
}

/** Drop every receipt — and the #1311 repair counter — that does not belong
 *  to the running task and generation (mutates in place). */
export function expireReceipts(state: SessionState): void {
  const task = state.activeTask;
  const running = task && task.kind !== "none" ? task : null;
  const kept = running
    ? (state.receipts ?? []).filter((r) => r.taskId === running.id && r.generation === running.generation)
    : [];
  if (kept.length > 0) state.receipts = kept;
  else delete state.receipts;
  const repair = state.repairAttempts;
  if (repair && !(running && repair.taskId === running.id && repair.generation === running.generation)) {
    delete state.repairAttempts;
  }
}

export type StoreOutcome = "stored" | "no_task" | "task_mismatch" | "not_persisted";

/**
 * Store a successful result in session `sessionId`, bound to its running task.
 * `task` is the task state the caller validated under, when it named one: it
 * must be the session's current kind and generation, or the receipt would
 * claim a binding it never had.
 */
export async function storeReceipt(
  sessionId: string,
  result: Pick<CopyBlocksResult, "artifact_sha256" | "channel" | "limit" | "unit_applied"> & { receipt: string },
  task: { kind: string; generation: number } | undefined,
  now: number = Date.now(),
): Promise<StoreOutcome> {
  let outcome: StoreOutcome = "not_persisted";
  const persisted = await mutateSessionState(sessionId, (s) => {
    const current = s.activeTask;
    if (!current || current.kind === "none") {
      outcome = "no_task";
      return;
    }
    if (task && (task.kind !== current.kind || task.generation !== current.generation)) {
      outcome = "task_mismatch";
      return;
    }
    expireReceipts(s);
    const receipts = s.receipts ?? [];
    receipts.push({
      taskId: current.id,
      generation: current.generation,
      hash: result.artifact_sha256,
      receipt: result.receipt,
      channel: result.channel,
      limit: result.limit,
      unit: result.unit_applied,
      at: now,
    });
    s.receipts = receipts.slice(-RECEIPTS_CAP);
    outcome = "stored";
  });
  // The assignment happens inside the callback, which control flow does not follow.
  const decided = outcome as StoreOutcome;
  return persisted || decided !== "stored" ? decided : "not_persisted";
}
