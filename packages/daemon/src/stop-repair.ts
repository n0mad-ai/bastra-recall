import {countCopyUnits,validateCopyBlocks} from "@bastra-recall/core";
import {roundCorrespondence,claimRoundRepair,type RulebookPayload} from './rulebook-check.js';
import {taskValidators} from './task-validators.js';
/** Bounded Stop repair for declared round validators and legacy review/copy tasks.
 * Answer formatting never creates a task or user approval.
 * Receipts retain the known task/generation (not later byte-exact) limitation.
 * At most two requests per repair scope; a model task report cannot reset it.
 */
import {spoolRulebookFailure} from "./rulebook-spool.js";
import { envOff } from "./env.js";
import { hookClientEvidence } from "./hook-surface.js";
import { loadTranscript, type TranscriptTurn } from "./stop-transcript.js";
import { loadSessionState, mutateSessionState, type ReadonlySessionState } from "./session-state.js";
import { hasReviewDraft } from "./stop-task.js";
import { ownerPromptText } from "./system-turn.js";
import type { ClaudeStopPayload } from "./stop-transcript.js";

/** Repair requests per task and generation; the next Stop records non-conformance. */
export const REPAIR_MAX_ATTEMPTS = 2;

export type RepairDecision =
  | { action: "request"; attempt: number }
  | { action: "exhausted"; taskId: string; generation: number; attempts: number; roundId?:string }
  | { action: "observed"; roundId: string };

/** Count a needed repair only after its bounded state mutation persisted. */
export async function checkStopRepair(payload: ClaudeStopPayload, suppliedTurns?: readonly TranscriptTurn[]): Promise<RepairDecision | null> {
  // Leave headroom for formatting/localization in the 1000 ms Stop budget.
  const deadline = Date.now() + 900;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return null;
  const codex=hookClientEvidence(payload)==="codex";
  if (envOff("BASTRA_STOP_SAME_TURN")&&!codex) return null;
  const snapshot = await loadSessionState(sessionId);
  const task = snapshot.activeTask;
  const turns = suppliedTurns ?? await loadTranscript(payload).catch(() => []);
  const responses = currentAssistantTexts(turns);
  // Only actual output, never a model task declaration, establishes that the
  // owner had something to review. Bound it to the same task/generation.
  if (!payload.agent_id && task?.kind === "draft-for-review" && !task.draftPresented && currentAssistantTexts(turns, task.since).some(text => hasReviewDraft(text))) {
    await mutateSessionState(sessionId, s => {
      if (s.activeTask?.kind === "draft-for-review" && s.activeTask.id === task.id && s.activeTask.generation === task.generation) s.activeTask.draftPresented = true;
    }, { noQueue: true, deadline });
  }
  const legacyTask=!(payload as RulebookPayload).agent_id&&task&&["draft-for-review","approved-copy"].includes(task.kind)&&taskValidators(snapshot).length>0;
  if(codex||!legacyTask){
    const round=roundCorrespondence(snapshot,payload);
    if(!round.rules.some(r=>r.validator))return null;
    const oversized=(state:ReadonlySessionState)=>roundValidators(state,payload).some(v=>{
      const contract=validateCopyBlocks({text:"",channel:v.channel,limit:v.limit,unit:v.unit,normalize:"none"});
      return responses.some(response=>countCopyUnits(deliveredCopy(response,contract.unit_applied,includeProse(state,payload)),contract.unit_applied)>contract.limit);
    });
    if(!oversized(snapshot)||round.repairs>2)return null;
    let decision:RepairDecision|null=null;
    const persisted=await mutateSessionState(sessionId,s=>{
      if(!oversized(s))return;
      const count=claimRoundRepair(s,payload,round.key,codex,0,includeProse(s,payload));if(count===null)return;
      decision=codex?{action:"observed",roundId:round.key}:count<2?{action:"request",attempt:count+1}:{action:"exhausted",taskId:round.key,generation:round.round,attempts:count,roundId:round.key};
    },{noQueue:true,deadline});
    if(!persisted)void spoolRulebookFailure(sessionId).catch(()=>{});
    return persisted?decision:null;
  }
  if (!task) return null;
  if (!taskValidators(snapshot).length) return null;
  const hasReceipt = (state: ReadonlySessionState) => {
    // A model task report cannot weaken this round's declared constraints.
    const validators = [...taskValidators(state).map(({validator}) => validator), ...roundValidators(state, payload)];
    if (!validators.length) return false;
    return validators.every(v=>{
    const contract = validateCopyBlocks({text: "", channel: v.channel, limit: v.limit, unit: v.unit, normalize: "none"});
    const withinLimit = responses.every(response => countCopyUnits(deliveredCopy(response, contract.unit_applied, includeProse(state, payload)), contract.unit_applied) <= contract.limit);
    return withinLimit && (state.activeTask?.kind !== "approved-copy" || (state.receipts ?? []).some(r =>
      r.taskId === task.id && r.generation === task.generation && r.channel === contract.channel && r.limit <= contract.limit &&
      (r.unit === contract.unit_applied || r.unit === "max(codepoints,utf16)")));
    });
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
    if (!taskValidators(s).length) return;
    if (hasReceipt(s)) return;
    const r = s.repairAttempts;
    let count = r && r.taskId === t.id && r.generation === t.generation ? r.count : 0;
    const round=roundCorrespondence(s,payload);
    if(s.rulebookCheck&&round.rules.some(r=>r.validator)){
      const claimed=claimRoundRepair(s,payload,round.key,false,count,includeProse(s,payload));if(claimed===null)return;count=claimed;
    }
    if (count > REPAIR_MAX_ATTEMPTS) return;
    s.repairAttempts = { taskId: t.id, generation: t.generation, count: count + 1 };
    decision = count < REPAIR_MAX_ATTEMPTS
      ? { action: "request", attempt: count + 1 }
      : { action: "exhausted", taskId: t.id, generation: t.generation, attempts: count };
  }, { noQueue: true, deadline });
  return persisted ? decision : null;
}

/** Review/translation prose is not delivered copy. An already observed overlong
 * copy stays subject to repair if a later model report starts a review task.
 * Neither the new task nor its receipt policy may erase a round violation.
 * Known #1351: a model draft declared before the first measurement excludes
 * unmarked prose too. Without an authoritative user-origin task discriminator,
 * enforcing that prose would also reject the real index131 review/translation.
 */
function includeProse(state: ReadonlySessionState, payload: RulebookPayload): boolean {
  const kind = state.activeTask?.kind;
  return (kind !== "draft-for-review" && kind !== "translate-only") || roundCorrespondence(state, payload).repairProse;
}

/** Pick explicit copy regions structurally, independent of language/channel names.
 * Approved/no-task responses also consider all remaining prose, preventing decoys.
 * In review/translation, an unclosed fence still contributes its body as copy.
 */
function deliveredCopy(text: string, unit: Parameters<typeof countCopyUnits>[1], proseIsCopy = true): string {
  const blocks: string[] = [], prose: string[] = [];
  let fence = "", body: string[] = [], quote: string[] = [];
  const flushQuote = () => { if (proseIsCopy && quote.length) blocks.push(quote.join("\n")); quote = []; };
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
  if (proseIsCopy && prose.join("\n").trim()) blocks.push(prose.join("\n").trim());
  if (fence) {
    if (proseIsCopy) return text;
    blocks.push(body.join("\n"));
  }
  if (!blocks.length) return proseIsCopy ? text : "";
  let largest = "", size = -1;
  for (const block of blocks) {
    const count = countCopyUnits(block, unit);
    if (count > size) { largest = block; size = count; }
  }
  return largest;
}

function roundValidators(state:ReadonlySessionState,p:RulebookPayload){
 const all=roundCorrespondence(state,p).rules.flatMap(r=>r.validator?[r.validator]:[]);
 const channel=state.activeTask?.validatorChannel??state.userValidatorChannel;
 return channel&&all.some(v=>v.channel===channel)?all.filter(v=>v.channel===channel):all;
}

/** Tool results and harness-written user rows do not end the owner's round. */
function currentAssistantTexts(turns: readonly TranscriptTurn[], since?: number): string[] {
  let boundary = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const sources = [turn.source, turn.origin];
    const owner = !turn.isMeta && !turn.stop_hook_active && sources.every(source => {
      if (source === undefined) return true;
      const kind = typeof source === "object" ? source?.kind : source;
      return kind === "user" || kind === "human" || kind === "typed";
    });
    if (turn.role === "user" && owner && ownerPromptText(turn.content) !== null) { boundary = i; break; }
  }
  return turns.slice(boundary + 1).filter(turn => turn.role === "assistant" && (since === undefined || turn.at === undefined || turn.at >= since)).map(turn => turn.content);
}
