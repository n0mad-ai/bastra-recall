/** Text-free draft lifecycle telemetry. Observability never blocks a write/hook. */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { envOff } from "./env.js";
import { logDirFor } from "./telemetry.js";
import { evalRunMark } from "./training-signal.js"; // #1128-capture
export async function writeDraftEvent(event: {kind:"draft_expired"|"draft_notice"|"draft_undone"|"draft_review_shown"|"draft_review_confirmed"|"draft_review_rejected"; count:number; draft_ids?:string[]}):Promise<void> {
 if(envOff("BASTRA_TELEMETRY","NEXUS_TELEMETRY"))return;
 try{const dir=logDirFor();await mkdir(dir,{recursive:true});const ts=new Date().toISOString();await appendFile(join(dir,`events-${ts.slice(0,10)}.jsonl`),JSON.stringify({...event,ts,...evalRunMark()})+"\n","utf8");}catch{}
}
