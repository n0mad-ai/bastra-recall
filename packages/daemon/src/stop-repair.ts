import {ConventionValidatorSchema,countCopyUnits,validateCopyBlocks} from "@bastra-recall/core";
/** Bounded Stop repair for loaded-channel copy blocks and legacy approved tasks.
 * Structural copy creates review/validation obligations, never user approval.
 * Receipts retain the known task/generation (not later byte-exact) limitation.
 * At most two requests per task/generation, then one exhaustion observation.
 */
import { envOff } from "./env.js";
import { hookClientEvidence } from "./hook-surface.js";
import { findReceipt } from "./receipt-store.js";
import { loadTranscript, type TranscriptTurn } from "./stop-transcript.js";
import { loadSessionState, mutateSessionState, taskIdFor } from "./session-state.js";
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
  let snapshot = await loadSessionState(sessionId);
  const turns=suppliedTurns??await loadTranscript(payload).catch(()=>[]);
  const latest=turns.at(-1);
  const loaded=(snapshot.loadedConventions??[]).flatMap(c=>{const v=ConventionValidatorSchema.safeParse(c.validator);return v.success?[{...c,validator:v.data}]:[];});
  const copies=latest?.role==="assistant"?fencedCopies(latest.content):[];
  const required=loaded.map(c=>({validator:c.validator!,blocks:copies.filter(b=>!b.label||b.label===c.validator!.channel).map(b=>b.text)})).filter(c=>c.blocks.length);
  const structural=required.length>0;
  if(structural&&(!snapshot.activeTask||snapshot.activeTask.kind==="none")){
    await mutateSessionState(sessionId,s=>{
      if(!s.activeTask||s.activeTask.kind==="none"){
        const now=Date.now();s.activeTask={id:taskIdFor("draft-for-review",now),kind:"draft-for-review",since:now,generation:s.activeTask?.generation??0};
        delete s.receipts;
      }
    },{noQueue:true,deadline});
    snapshot=await loadSessionState(sessionId);
  }
  const task = snapshot.activeTask;
  if (!task || (!structural&&task.kind!=="approved-copy")) return null;
  if (!structural&&!(snapshot.activeConventions??[]).some(c=>c.validator))return null;
  const contracts=required.map(c=>({...validateCopyBlocks({text:"",channel:c.validator.channel,limit:c.validator.limit,unit:c.validator.unit,normalize:"none"}),displayed:c.blocks}));
  const fits=contracts.every(c=>c.displayed.every(text=>countCopyUnits(text,c.unit_applied)<=c.limit));
  const hasReceipt=(state:typeof snapshot)=>structural?fits&&contracts.every(c=>(state.receipts??[]).some(r=>
    r.taskId===task.id&&r.generation===task.generation&&r.channel===c.channel&&r.limit<=c.limit&&
    (r.unit===c.unit_applied||r.unit==="max(codepoints,utf16)"))):!!findReceipt(state,{taskId:task.id,generation:task.generation});
  // Task receipts still do not prove byte-exact matching for a later edit.
  // They cannot excuse an oversized displayed block or a different channel.
  if(hasReceipt(snapshot))return null;
  const seen = snapshot.repairAttempts;
  if (seen && seen.taskId === task.id && seen.generation === task.generation && seen.count > REPAIR_MAX_ATTEMPTS) {
    return null;
  }
  let decision: RepairDecision | null = null;
  const persisted = await mutateSessionState(sessionId, (s) => {
    // Re-checked under the lock: a receipt or task change that landed since
    // the snapshot wins.
    const t = s.activeTask;
    if (!t || (!structural&&t.kind !== "approved-copy") || t.id !== task.id || t.generation !== task.generation) return;
    if (!structural&&!(s.activeConventions ?? []).some((c) => c.validator)) return;
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

/** Fences and exact channel labels are structure, never approval evidence. */
function fencedCopies(text:string):{text:string;label:string}[]{
 const blocks:{text:string;label:string}[]=[];let fence="",label="",body:string[]=[];
 for(const line of text.split("\n")){
  if(!fence){const open=/^\s*(`{3,}|~{3,})([^\n]*)$/u.exec(line);if(open){fence=open[1];label=open[2].trim();body=[];}continue;}
  if(new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`,"u").test(line)){
   const text=body.join("\n");if(text.trim())blocks.push({text,label});fence="";body=[];
  }else body.push(line);
 }
 return blocks;
}
