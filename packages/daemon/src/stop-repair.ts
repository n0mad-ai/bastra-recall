/**
 * #1311 — bounded repair in the Stop lane for approved-copy tasks.
 *
 * When the session is in an `approved-copy` task (#1306) and at least one
 * active convention names a validator, the deliverable should carry a
 * `validate_artifact` receipt (#1310) for the running task and generation. A
 * Stop without one gets a same-turn instruction to validate — at most
 * {@link REPAIR_MAX_ATTEMPTS} times per task and generation. The Stop after
 * that records non-conformance and stays silent; later Stops of the same task
 * run the lane as before.
 *
 * The count is per task, not per artifact hash: an edit must not reset the
 * cap. It expires with the task like the receipts do (receipt-store.ts,
 * `bumpTaskGeneration`). Nothing is read from the transcript — the scrubbed
 * text cannot reproduce a byte-exact hash — the receipt store is the only
 * evidence. The check is one state read, plus one write when it counts.
 *
 * Same-turn only: Codex, a payload without a session id and
 * `BASTRA_STOP_SAME_TURN=0` get no repair (host-capabilities.ts).
 */
import { envOff } from "./env.js";
import { hookClientEvidence } from "./hook-surface.js";
import { findReceipt } from "./receipt-store.js";
import { loadSessionState, mutateSessionState } from "./session-state.js";
import type { ClaudeStopPayload } from "./stop-transcript.js";

/** Repair requests per task and generation; the next Stop records non-conformance. */
export const REPAIR_MAX_ATTEMPTS = 2;

export type RepairDecision =
  | { action: "request"; attempt: number }
  | { action: "exhausted"; taskId: string; generation: number; attempts: number };

/**
 * What this Stop owes the repair contract: a request, the one-time
 * exhaustion, or null when repair does not apply (no approved-copy task, no
 * validator required, a valid receipt, the cap already recorded, not a
 * same-turn host, or a counter that could not be persisted — an uncounted
 * request could repeat without bound).
 */
export async function checkStopRepair(payload: ClaudeStopPayload): Promise<RepairDecision | null> {
  // Leave headroom for formatting/localization in the 1000 ms Stop budget.
  const deadline = Date.now() + 900;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return null;
  if (hookClientEvidence(payload) === "codex") return null;
  if (envOff("BASTRA_STOP_SAME_TURN")) return null;
  const snapshot = await loadSessionState(sessionId);
  const task = snapshot.activeTask;
  if (!task || task.kind !== "approved-copy") return null;
  if (!(snapshot.activeConventions ?? []).some((c) => c.validator)) return null;
  if (findReceipt(snapshot, { taskId: task.id, generation: task.generation })) return null;
  const seen = snapshot.repairAttempts;
  if (seen && seen.taskId === task.id && seen.generation === task.generation && seen.count > REPAIR_MAX_ATTEMPTS) {
    return null;
  }
  let decision: RepairDecision | null = null;
  const persisted = await mutateSessionState(sessionId, (s) => {
    // Re-checked under the lock: a receipt or task change that landed since
    // the snapshot wins.
    const t = s.activeTask;
    if (!t || t.kind !== "approved-copy" || t.id !== task.id || t.generation !== task.generation) return;
    if (!(s.activeConventions ?? []).some((c) => c.validator)) return;
    if (findReceipt(s, { taskId: t.id, generation: t.generation })) return;
    const r = s.repairAttempts;
    const count = r && r.taskId === t.id && r.generation === t.generation ? r.count : 0;
    if (count > REPAIR_MAX_ATTEMPTS) return;
    s.repairAttempts = { taskId: t.id, generation: t.generation, count: count + 1 };
    decision = count < REPAIR_MAX_ATTEMPTS
      ? { action: "request", attempt: count + 1 }
      : { action: "exhausted", taskId: t.id, generation: t.generation, attempts: count };
  }, { noQueue: true, deadline });
  return persisted ? decision : null;
}
