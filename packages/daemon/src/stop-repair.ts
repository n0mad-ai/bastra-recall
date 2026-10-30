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
  if (!taskValidator(snapshot)) return null;
  const turns = suppliedTurns ?? await loadTranscript(payload).catch(() => []);
  const latest = turns.at(-1);
  const response = latest?.role === "assistant" ? latest.content : "";
  const hasReceipt = (state: ReadonlySessionState) => {
    const v = taskValidator(state);
    if (!v) return false;
    const contract = validateCopyBlocks({text: "", channel: v.channel, limit: v.limit, unit: v.unit, normalize: "none"});
    const copy = deliveredCopy(response, contract.unit_applied);
    return countCopyUnits(copy, contract.unit_applied) <= contract.limit && (state.receipts ?? []).some(r =>
      r.taskId === task.id && r.generation === task.generation && r.channel === contract.channel && r.limit <= contract.limit &&
      (r.unit === contract.unit_applied || r.unit === "max(codepoints,utf16)"));
  };
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
    if (!taskValidator(s)) return;
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

/** Prefer the task's triggering rule; otherwise the latest loaded/active source.
 * Compare real activation timestamps, never answer labels or natural-language cues.
 */
function taskValidator(state: ReadonlySessionState) {
  const rules = new Map<string, {id: string; at: number; validator?: unknown}>();
  for (const c of state.activeConventions ?? []) rules.set(c.id, {...c, at: c.setAt});
  for (const c of state.loadedConventions ?? []) {
    if (c.loadedAt >= (rules.get(c.id)?.at ?? -Infinity)) rules.set(c.id, {...c, at: c.loadedAt});
  }
  const valid = [...rules.values()].flatMap(c => {
    const parsed = ConventionValidatorSchema.safeParse(c.validator);
    return parsed.success ? [{id: c.id, at: c.at, validator: parsed.data}] : [];
  });
  const bound = valid.find(c => c.id === state.activeTask?.validatorRuleId);
  return (bound ?? valid.reverse().sort((a, b) => b.at - a.at)[0])?.validator;
}

/** Pick explicit copy regions structurally, independent of language/channel names.
 * Fences, quotes and all remaining prose are competing copy candidates.
 * An unclosed fence is ambiguous and falls back to the complete answer.
 */
function deliveredCopy(text: string, unit: Parameters<typeof countCopyUnits>[1]): string {
  const blocks: string[] = [], prose: string[] = [];
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
    if (quoted) quote.push(quoted[1]); else { flushQuote(); prose.push(line); }
  }
  flushQuote();
  if (prose.join("\n").trim()) blocks.push(prose.join("\n").trim());
  if (fence || !blocks.length) return text;
  let largest = "", size = -1;
  for (const block of blocks) {
    const count = countCopyUnits(block, unit);
    if (count > size) { largest = block; size = count; }
  }
  return largest;
}
