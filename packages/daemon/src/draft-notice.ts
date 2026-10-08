/** One durable claim per promoted memory; reuse the existing user save line. */
import { transactDrafts, draftSearchSnapshot } from "./draft-store.js";
import { formatSaveNotice } from "./save-notice.js";
import { getPrimaryLanguage } from "./settings.js";
import { hookAgent, hookClientEvidence } from "./hook-surface.js";
import { envFirst, envOff, isOnValue } from "./env.js";
import type { SaveNoticePayload } from "./save-notice-lane.js";
import { writeDraftEvent } from "./draft-events.js";
type Entry={title:string;type:string;sensitivity?:string;source?:string;write_origin?:string};
export async function appendDraftNotice(stdout:string,payload:SaveNoticePayload,lookup:(id:string)=>Entry|undefined,language=getPrimaryLanguage,isConnected=()=>true):Promise<string> {
 if(!["PostToolUse","Stop","SessionStart"].includes(payload.hook_event_name??"")||envOff("BASTRA_SAVE_NOTICE")||hookAgent(payload)==="subagent")return stdout;
 if(!isConnected()||!draftSearchSnapshot().rows.some(row=>row.state==="promoted"&&row.announce))return stdout;
 try{
  const envelope=JSON.parse(stdout) as Record<string,unknown>;
  if(!envelope||typeof envelope!=="object"||Array.isArray(envelope))return stdout;
  const lang=await language().catch(()=>undefined);
  const colour=hookClientEvidence(payload)!=="codex"||isOnValue(envFirst("BASTRA_SAVE_NOTICE_COLOR"));
  const claimed=await transactDrafts(async rows=>{
   if(!isConnected())return null;
   for(const row of rows){
    if(row.state!=="promoted"||!row.announce||!row.memory_id||!row.evidence_key)continue;
    const entry=lookup(row.memory_id);
    if(entry?.sensitivity==="private"){
     for(const related of rows)if(related.memory_id===row.memory_id)related.announce=false;
     continue;
    }
    if(!entry||entry.sensitivity==="private"||entry.write_origin!=="capture-review"||entry.source!==`draft:${row.evidence_key}`)continue;
    const line=formatSaveNotice({action:"promoted",title:entry.title,type:entry.type},lang,colour);
    for(const related of rows)if(related.memory_id===row.memory_id&&related.state==="promoted")related.announce=false;
    return {line,ids:rows.filter(item=>item.memory_id===row.memory_id).map(item=>item.id)};
   }
   return null;
  },Date.now(),true,true);
  if(!claimed)return stdout;
  envelope.systemMessage=typeof envelope.systemMessage==="string"&&envelope.systemMessage?`${envelope.systemMessage}\n${claimed.line}`:claimed.line;
  void writeDraftEvent({kind:"draft_notice",count:1,draft_ids:claimed.ids});
  return JSON.stringify(envelope);
 }catch{return stdout;}
}
