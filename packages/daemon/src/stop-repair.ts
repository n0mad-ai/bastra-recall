import {ConventionValidatorSchema,countCopyUnits,validateCopyBlocks} from "@bastra-recall/core";
/** Bounded Stop repair for review/approved tasks with loaded or active validators.
 * Answer formatting never creates a task or user approval.
 * Receipts retain the known task/generation (not later byte-exact) limitation.
 * At most two requests per task/generation, then one exhaustion observation.
 */
import { envOff } from "./env.js";
import { hookClientEvidence } from "./hook-surface.js";
import { loadTranscript, type TranscriptTurn } from "./stop-transcript.js";
import { loadSessionState, mutateSessionState, type ReadonlySessionState } from "./session-state.js";
import type { ClaudeStopPayload } from "./stop-transcript.js";

/** Repair requests per task and generation; the next Stop records non-conformance. */
export const REPAIR_MAX_ATTEMPTS = 2;

export type RepairDecision =
  | { action: "request"; attempt: number }
  | { action: "exhausted"; taskId: string; generation: number; attempts: number };

/** Count a needed repair only after its bounded state mutation persisted. */
export async function checkStopRepair(payload: ClaudeStopPayload, suppliedTurns?: readonly TranscriptTurn[]): Promise<RepairDecision | null> {
  // Leave headroom for formatting/localization in the 1000 ms Stop budget.
  const deadline = Date.now() + 900;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return null;
  if (hookClientEvidence(payload) === "codex") return null;
  if (envOff("BASTRA_STOP_SAME_TURN")) return null;
  const snapshot = await loadSessionState(sessionId);
  const task = snapshot.activeTask;
  if (!task || !["draft-for-review", "approved-copy"].includes(task.kind)) return null;
  if (!validators(snapshot).length) return null;
  const turns = suppliedTurns ?? await loadTranscript(payload).catch(() => []);
  const latest = turns.at(-1);
  const copy = latest?.role === "assistant" ? deliveredCopy(latest.content) : "";
  const hasReceipt = (state: ReadonlySessionState) => validators(state).every(v => {
    const contract = validateCopyBlocks({text: "", channel: v.channel, limit: v.limit, unit: v.unit, normalize: "none"});
    return countCopyUnits(copy, contract.unit_applied) <= contract.limit && (state.receipts ?? []).some(r =>
      r.taskId === task.id && r.generation === task.generation && r.channel === contract.channel && r.limit <= contract.limit &&
      (r.unit === contract.unit_applied || r.unit === "max(codepoints,utf16)"));
  });
  // Receipts are task/generation evidence, not byte-exact proof for later edits.
  if (hasReceipt(snapshot)) return null;
  const seen = snapshot.repairAttempts;
  if (seen && seen.taskId === task.id && seen.generation === task.generation && seen.count > REPAIR_MAX_ATTEMPTS) {
    return null;
  }
  let decision: RepairDecision | null = null;
  const persisted = await mutateSessionState(sessionId, (s) => {
    // Re-checked under the lock: a receipt or task change that landed since
    // the snapshot wins.
    const t = s.activeTask;
    if (!t || !["draft-for-review", "approved-copy"].includes(t.kind) || t.id !== task.id || t.generation !== task.generation) return;
    if (!validators(s).length) return;
    if (hasReceipt(s)) return;
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

/** A full load is sufficient validator activation; newer loaded metadata wins per ID. */
function validators(state: ReadonlySessionState) {
  const rules = new Map<string, {validator?: unknown}>((state.activeConventions ?? []).map(c => [c.id, c]));
  for (const c of state.loadedConventions ?? []) rules.set(c.id, c);
  return [...rules.values()].flatMap(c => {
    const parsed = ConventionValidatorSchema.safeParse(c.validator);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Pick explicit copy regions structurally, independent of language/channel names.
 * With multiple fences/quotes the largest region wins; without one, use the answer.
 * An unclosed fence is ambiguous and falls back to the complete answer.
 */
function deliveredCopy(text: string): string {
  const blocks: string[] = [];
  let fence = "", body: string[] = [], quote: string[] = [];
  const flushQuote = () => { if (quote.length) blocks.push(quote.join("\n")); quote = []; };
  for (const line of text.split("\n")) {
    if (fence) {
      if (new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`, "u").test(line)) {
        if (body.join("\n").trim()) blocks.push(body.join("\n"));
        fence = ""; body = [];
      } else body.push(line);
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})[^\n]*$/u.exec(line);
    if (open) { flushQuote(); fence = open[1]; continue; }
    const quoted = /^\s*> ?(.*)$/u.exec(line);
    if (quoted) quote.push(quoted[1]); else flushQuote();
  }
  flushQuote();
  return fence || !blocks.length ? text : blocks.reduce((a, b) => b.length > a.length ? b : a);
}
