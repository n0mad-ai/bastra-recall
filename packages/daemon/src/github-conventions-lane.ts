/** #1330: action-time GitHub convention lookup, using the shared one-shot gate.
 * No private IDs, language rules, milestone IDs or GitHub writes live here. */
import {createHash} from "node:crypto";
import {githubWriteActions} from "./bash-pre-analysis.js";
import {hookCaller,hookGateAvailable,hookAgent} from "./hook-surface.js";
import {isGatedHint,isUnfused,type HookRecallResponse} from "./hook-recall-response.js";
import {projectForLane} from "./scope-filter.js";
import {postLane} from "./thin-client.js";
import {runGateLane,actionConventionFrame,type GatePayload} from "./gate-lane.js";
const PART="github-action-conventions-v2";
export async function githubConventionGate(payload:GatePayload,selfBaseUrl:string,deadline:number):Promise<string|null>{
 try{
  if(payload.hook_event_name!=="PreToolUse"||payload.tool_name!=="Bash"||!payload.session_id)return null;
  const command=typeof payload.tool_input?.command==="string"?payload.tool_input.command:"";
  const actions=await githubWriteActions(command);if(!actions.length)return null;
  const project=payload.cwd?projectForLane(payload.cwd):null;
  const remaining=deadline-Date.now();if(remaining<=0)return null;
  const resp=JSON.parse(await postLane(selfBaseUrl,"/hook/recall",{
   query:`${actions.join("; ")} issue PR conventions milestone labels bilingual English first Deutsch danach`,
   convention_revisions:true,project,scope:project??"all-projects",topics:["github","issues","conventions"],k:5,
   tool_name:"Bash",tool_input_excerpt:actions.join("; "),...hookCaller(payload),hook_source:"bash-pre",
  },remaining))as HookRecallResponse;
  const hits=resp.hits?.filter(h=>isGatedHint(h)&&h.matched_recall_when===true&&h.anchor_strength==="strong"&&
   (isUnfused(resp)||h.score>=100)&&[project,"all-projects","user-preference"].includes(h.scope)).slice(0,5)??[];
  if(!hits.length||Date.now()>=deadline)return null;
  const contextFor=(selected:typeof hits)=>actionConventionFrame(selected.map(h=>h.id),new Map(selected.map(h=>[h.id,h.summary])),new Map(selected.map(h=>[h.id,h.write_origin])));
  const context=contextFor(hits);
  if(!hookGateAvailable(payload))return JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:context.replace("MUST-LOAD","Relevant conventions (host cannot gate)")}});
  const subagent=hookAgent(payload)==="subagent";
  const part=subagent?PART+":"+createHash("sha256").update(payload.agent_id??"").digest("hex").slice(0,16):PART;
  let ids:readonly string[]=[];
  // Selection, once-only claim and persistence happen in the same gate mutation.
  // No pending hint may remain after a failed claim or leak to an unrelated tool.
  const result=JSON.parse(await runGateLane(payload,{reflexPool:()=>[],deadline,countTool:false,
   actionMustLoad:{ids:hits.map(h=>h.id),key:part,summaries:new Map(hits.map(h=>[h.id,h.summary])),origins:new Map(hits.map(h=>[h.id,h.write_origin])),revisions:new Map(hits.map(h=>[h.id,h.revision??null])),onClaim:selected=>{ids=selected;}}}));
  if(result.hookSpecificOutput?.permissionDecision!=="deny")return null;
  if(ids.length){
   const selected=hits.filter(h=>ids.includes(h.id));
   result.hookSpecificOutput.additionalContext=contextFor(selected);
  }
  return JSON.stringify(result);
 }catch{return null;} // retrieval/state failures preserve the lane's fail-open contract
}
