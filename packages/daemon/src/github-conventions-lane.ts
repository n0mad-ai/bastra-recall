/** #1330: action-time GitHub convention lookup, using the shared one-shot gate.
 * No private IDs, language rules, milestone IDs or GitHub writes live here. */
import {createHash} from "node:crypto";
import {HINT_FRAME_NOTE,stripFenceMarkers} from "@bastra-recall/core/scrub";
import {githubWriteActions} from "./bash-pre-analysis.js";
import {hookCaller,hookGateAvailable,hookAgent} from "./hook-surface.js";
import {isGatedHint,isUnfused,type HookRecallResponse} from "./hook-recall-response.js";
import {projectForLane} from "./scope-filter.js";
import {postLane} from "./thin-client.js";
import {runGateLane,type GatePayload} from "./gate-lane.js";
const PART="github-action-conventions";
export async function githubConventionGate(payload:GatePayload,selfBaseUrl:string,deadline:number):Promise<string|null>{
 try{
  if(payload.hook_event_name!=="PreToolUse"||payload.tool_name!=="Bash"||!payload.session_id)return null;
  const command=typeof payload.tool_input?.command==="string"?payload.tool_input.command:"";
  const actions=githubWriteActions(command);if(!actions.length)return null;
  const project=payload.cwd?projectForLane(payload.cwd):null;
  const remaining=deadline-Date.now();if(remaining<=0)return null;
  const resp=JSON.parse(await postLane(selfBaseUrl,"/hook/recall",{
   query:`${actions.join("; ")} issue PR conventions milestone labels bilingual English first Deutsch danach`,
   project,scope:project??"all-projects",topics:["github","issues","conventions"],k:5,
   tool_name:"Bash",tool_input_excerpt:actions.join("; "),...hookCaller(payload),hook_source:"bash-pre",
  },remaining))as HookRecallResponse;
  const hits=resp.hits?.filter(h=>isGatedHint(h)&&h.matched_recall_when===true&&h.anchor_strength==="strong"&&
   (isUnfused(resp)||h.score>=100)&&[project,"all-projects","user-preference"].includes(h.scope)).slice(0,5)??[];
  if(!hits.length||Date.now()>=deadline)return null;
  const contextFor=(selected:typeof hits)=>[`<recall-hints trigger="github-write">`,HINT_FRAME_NOTE,
   "MUST-LOAD — saved issue/PR conventions apply before this GitHub write. load_memory(id) before deciding:",
   ...selected.map(h=>stripFenceMarkers(`- ${h.id}: ${h.summary.slice(0,300)}`)),"</recall-hints>"].join("\n");
  const context=contextFor(hits);
  if(!hookGateAvailable(payload))return JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:context.replace("MUST-LOAD","Relevant conventions (host cannot gate)")}});
  const subagent=hookAgent(payload)==="subagent";
  const part=subagent?PART+":"+createHash("sha256").update(payload.agent_id??"").digest("hex").slice(0,16):PART;
  let ids:readonly string[]=[];
  // Selection, once-only claim and persistence happen in the same gate mutation.
  // No pending hint may remain after a failed claim or leak to an unrelated tool.
  const result=JSON.parse(await runGateLane(payload,{reflexPool:()=>[],deadline,countTool:false,
   actionMustLoad:{ids:hits.map(h=>h.id),key:part,onClaim:selected=>{ids=selected;}}}));
  if(result.hookSpecificOutput?.permissionDecision!=="deny")return null;
  if(ids.length)result.hookSpecificOutput.additionalContext=contextFor(hits.filter(h=>ids.includes(h.id)));
  return JSON.stringify(result);
 }catch{return null;} // retrieval/state failures preserve the lane's fail-open contract
}
