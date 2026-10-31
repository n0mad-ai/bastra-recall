import {countCopyUnits,validateCopyBlocks} from "@bastra-recall/core";
import {roundCorrespondence,claimRoundRepair,type RulebookPayload} from './rulebook-check.js';
import {taskValidators} from './task-validators.js';
import {spoolRulebookFailure} from "./rulebook-spool.js";
import {envOff} from "./env.js";
import {hookClientEvidence} from "./hook-surface.js";
import {loadTranscript,type TranscriptTurn,type ClaudeStopPayload} from "./stop-transcript.js";
import {loadSessionState,mutateSessionState,type ReadonlySessionState} from "./session-state.js";
import {repairCutoff,repairWindow} from "./stop-repair-window.js";
import {ownerPromptText} from "./system-turn.js";

/** Agent-reported tasks never establish user approval. Receipts remain bound to
 * task/generation, not the bytes of later edits (#1325). */
export const REPAIR_MAX_ATTEMPTS=2;
export type RepairDecision=
 | {action:"request";attempt:number;reason:"overlength"|"missing-receipt";ruleIds:string[]}
 | {action:"exhausted";taskId:string;generation:number;attempts:number;roundId?:string}
 | {action:"observed";roundId:string};

export async function checkStopRepair(payload:ClaudeStopPayload,suppliedTurns?:readonly TranscriptTurn[]):Promise<RepairDecision|null>{
 const deadline=Date.now()+900;
 const sessionId=typeof payload.session_id==="string"?payload.session_id:"";
 if(!sessionId)return null;
 const codex=hookClientEvidence(payload)==="codex";
 if(envOff("BASTRA_STOP_SAME_TURN")&&!codex)return null;
 const turns=suppliedTurns??await loadTranscript(payload).catch(()=>[]);
 const snapshot=await loadSessionState(sessionId),task=snapshot.activeTask;
 const actor=payload.agent_id||"main";
 const taskBound=!payload.agent_id&&task&&task.kind!=="none"&&taskValidators(snapshot).length>0;
 // An unpersisted rulebook context gets a random key on every read; legacy
 // tasks still require a stable repair watermark across Stops.
 const scope=snapshot.rulebookCheck?roundCorrespondence(snapshot,payload).key:`legacy:${task?.id??"none"}:${task?.generation??0}:${actor}`;
 const responsesFor=(state:ReadonlySessionState)=>currentAssistantTexts(turns,repairCutoff(state.repairWindows?.[actor],scope,turns));
 const oversizedRules=(state:ReadonlySessionState)=>{
  const responses=responsesFor(state),prose=!payload.agent_id&&state.activeTask?.kind==="approved-copy";
  return validatorsFor(state,payload).filter(v=>{
   const contract=validateCopyBlocks({text:"",channel:v.channel,limit:v.limit,unit:v.unit,normalize:"none"});
   return responses.some((response,i)=>countCopyUnits(deliveredCopy(response,contract.unit_applied,prose&&i===responses.length-1),contract.unit_applied)>contract.limit);
  });
 };
 const oversized=(state:ReadonlySessionState)=>oversizedRules(state).length>0;
 const repairDetails=(state:ReadonlySessionState)=>{
  const over=oversizedRules(state),rules=over.length?over:validatorsFor(state,payload);
  const {sources}=validatorSources(state,payload);
  const ruleIds=[...new Set(sources.filter(r=>r.validator&&rules.some(v=>v.channel===r.validator!.channel&&v.unit===r.validator!.unit&&v.limit===r.validator!.limit)).map(r=>r.id))];
  return {reason:over.length?'overlength' as const:'missing-receipt' as const,ruleIds};
 };
 const needsRepair=(state:ReadonlySessionState)=>oversized(state)||(!payload.agent_id&&state.activeTask?.kind==="approved-copy"&&!taskReceiptSatisfied(state,payload));
 if(!validatorsFor(snapshot,payload).length||!(codex?oversized(snapshot):needsRepair(snapshot)))return null;
 const round=roundCorrespondence(snapshot,payload);
 if(codex||snapshot.rulebookCheck||!taskBound){
  if(round.repairs>REPAIR_MAX_ATTEMPTS)return null;
  let decision:RepairDecision|null=null;
  const persisted=await mutateSessionState(sessionId,s=>{
   if(!(codex?oversized(s):needsRepair(s)))return;
   const count=claimRoundRepair(s,payload,round.key,codex);if(count===null)return;
   const details=repairDetails(s);
   (s.repairWindows??={})[actor]=repairWindow(scope,turns);
   decision=codex?{action:"observed",roundId:round.key}:count<REPAIR_MAX_ATTEMPTS?{action:"request",attempt:count+1,...details}:{action:"exhausted",taskId:round.key,generation:round.round,attempts:count,roundId:round.key};
  },{noQueue:true,deadline});
  if(!persisted)void spoolRulebookFailure(sessionId).catch(()=>{});
  return persisted?decision:null;
 }
 let decision:RepairDecision|null=null;
 const persisted=await mutateSessionState(sessionId,s=>{
  const t=s.activeTask;
  if(!t||t.kind==="none"||t.id!==task.id||t.generation!==task.generation||!validatorsFor(s,payload).length||!needsRepair(s))return;
  const old=s.repairAttempts;
  let count=old&&old.taskId===t.id&&old.generation===t.generation?old.count:0;
  if(count>REPAIR_MAX_ATTEMPTS)return;
  s.repairAttempts={taskId:t.id,generation:t.generation,count:count+1};
  const details=repairDetails(s);
   (s.repairWindows??={})[actor]=repairWindow(scope,turns);
  decision=count<REPAIR_MAX_ATTEMPTS?{action:"request",attempt:count+1,...details}:{action:"exhausted",taskId:t.id,generation:t.generation,attempts:count};
 },{noQueue:true,deadline});
 return persisted?decision:null;
}

/** Explicit fences and quotes count at every stage. Only the last text's prose
 * additionally counts when the agent reports approved-copy. */
function deliveredCopy(text:string,unit:Parameters<typeof countCopyUnits>[1],proseIsCopy=false):string{
 const blocks:string[]=[],prose:string[]=[];
 let fence="",body:string[]=[],quote:string[]=[];
 const flushQuote=()=>{if(quote.length)blocks.push(quote.join("\n"));quote=[];};
 for(const line of text.split("\n")){
  if(fence){
   if(new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`,"u").test(line)){if(body.join("\n").trim())blocks.push(body.join("\n"));fence="";body=[];}
   else body.push(line);
   continue;
  }
  const open=/^\s*(`{3,}|~{3,})[^\n]*$/u.exec(line);
  if(open){flushQuote();fence=open[1];continue;}
  const quoted=/^\s*> ?(.*)$/u.exec(line);
  if(quoted)quote.push(quoted[1]);else{flushQuote();prose.push(line);}
 }
 flushQuote();
 if(proseIsCopy&&prose.join("\n").trim())blocks.push(prose.join("\n").trim());
 if(fence)blocks.push(body.join("\n"));
 let largest="",size=-1;
 for(const block of blocks){const count=countCopyUnits(block,unit);if(count>size){largest=block;size=count;}}
 return largest;
}
function validatorSources(state:ReadonlySessionState,p:RulebookPayload){
 const round=roundCorrespondence(state,p),dismissed=new Set(round.dismissed);
 const inherited={...state,activeConventions:state.activeConventions?.filter(c=>!dismissed.has(c.id)),loadedConventions:state.loadedConventions?.filter(c=>!dismissed.has(c.id))};
 const task=!p.agent_id&&state.activeTask&&state.activeTask.kind!=="none"?inherited:undefined;
 return {round,task,sources:[...round.rules,...(task?.activeConventions??[]),...(task?.loadedConventions??[])]};
}
function validatorsFor(state:ReadonlySessionState,p:RulebookPayload){
 const {round,task}=validatorSources(state,p);
 const all=[...(task?taskValidators(task).map(v=>v.validator):[]),...round.rules.flatMap(r=>r.validator?[r.validator]:[])];
 const channel=state.activeTask?.validatorChannel;
 return channel&&all.some(v=>v.channel===channel)?all.filter(v=>v.channel===channel):all;
}
function taskReceiptSatisfied(state:ReadonlySessionState,payload:RulebookPayload):boolean{
 const task=state.activeTask;if(task?.kind!=="approved-copy")return false;
 const validators=validatorsFor(state,payload);
 return validators.length>0&&validators.every(v=>{
  const contract=validateCopyBlocks({text:"",channel:v.channel,limit:v.limit,unit:v.unit,normalize:"none"});
  return(state.receipts??[]).some(r=>r.taskId===task.id&&r.generation===task.generation&&r.channel===contract.channel&&r.limit<=contract.limit&&(r.unit===contract.unit_applied||r.unit==="max(codepoints,utf16)"));
 });
}
/** Tool results and harness-written user rows do not end the owner's round. */
function currentAssistantTexts(turns:readonly TranscriptTurn[],after=0):string[]{
 let boundary=-1;
 for(let i=turns.length-1;i>=0;i--){
  const turn=turns[i]!;
  const owner=!turn.isMeta&&!turn.stop_hook_active&&[turn.source,turn.origin].every(source=>{
   if(source===undefined)return true;const kind=typeof source==="object"?source?.kind:source;return kind==="user"||kind==="human"||kind==="typed";
  });
  if(turn.ownerBoundary||(turn.role==="user"&&owner&&(ownerPromptText(turn.content)!==null||!turn.content.trim()))){boundary=i;break;}
 }
 return turns.slice(Math.max(boundary+1,after)).filter(turn=>turn.role==="assistant"&&turn.content.trim()).map(turn=>turn.content);
}
