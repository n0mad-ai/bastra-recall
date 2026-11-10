/** Stop evidence is protocol/structure, never natural-language intent. */
import {countCopyUnits} from '@bastra-recall/core';
import type {TranscriptTurn} from './stop-transcript.js';
import {ownerPromptText} from './system-turn.js';

export function isOwnerBoundary(turn:TranscriptTurn):boolean{
 const owner=!turn.isMeta&&!turn.isCompactSummary&&!turn.stop_hook_active&&[turn.source,turn.origin].every(source=>{
  if(source===undefined)return true;const kind=typeof source==='object'?source?.kind:source;return kind==='user'||kind==='human'||kind==='typed';
 });
 return owner&&(turn.ownerBoundary===true||(turn.role==='user'&&(ownerPromptText(turn.content)!==null||!turn.content.trim())));
}
export function lastOwnerBoundary(turns:readonly TranscriptTurn[]):number{
 for(let i=turns.length-1;i>=0;i--)if(isOwnerBoundary(turns[i]))return i;
 return -1;
}
export function currentRoundTurns(turns:readonly TranscriptTurn[]):TranscriptTurn[]{
 return turns.slice(lastOwnerBoundary(turns)+1);
}
/** Only known external message operations; internal agent messaging is not correspondence. */
export function isCorrespondenceTool(name:string,input?:Record<string,unknown>):boolean{
 if(/(?:^|__)(?:send_email|draft_email|reply_to_email|forward_email)$/u.test(name))return true;
 if(!/(?:^|__)(?:gmail|outlook|slack|discord|teams|email|github)(?:__|_)/u.test(name))return false;
 if(/(?:^|_)(?:update_issue|update_issue_comment|update_pull_request)$/u.test(name))return typeof input?.body==='string'&&input.body.trim().length>0;
 return /(?:^|_)(?:send_email|draft_email|create_draft|update_draft|send_draft|reply_to_email|forward_email|send_message|post_message|add_comment_to_issue|add_issue_comment|create_issue|create_pull_request|post_reply)$/u.test(name);
}
export function hasCorrespondenceEvidence(turns:readonly TranscriptTurn[],reportedTask:boolean,hasValidator:boolean):boolean{
 if(reportedTask)return true;
 const current=currentRoundTurns(turns);
 return current.some(t=>t.role==='assistant'&&((t.calls??[]).some(c=>isCorrespondenceTool(c.name,c.input))||(t.tools??[]).some(name=>isCorrespondenceTool(name))))||
  (hasValidator&&current.some(t=>t.role==='assistant'&&deliveredCopy(t.content,'utf16').trim().length>0));
}

/** Largest explicit fence/quote, optionally including final approved-copy prose.
 * Shared by evidence and repair so the same structural candidate is measured. */
export function deliveredCopy(text:string,unit:Parameters<typeof countCopyUnits>[1],proseIsCopy=false):string{
 const blocks:string[]=[],prose:string[]=[];
 let fence='',body:string[]=[],quote:string[]=[];
 const flushQuote=()=>{if(quote.length)blocks.push(quote.join('\n'));quote=[];};
 for(const line of text.split('\n')){
  if(fence){
   if(new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`,'u').test(line)){if(body.join('\n').trim())blocks.push(body.join('\n'));fence='';body=[];}
   else body.push(line);
   continue;
  }
  const open=/^\s*(`{3,}|~{3,})[^\n]*$/u.exec(line);
  if(open){flushQuote();fence=open[1];continue;}
  const quoted=/^\s*> ?(.*)$/u.exec(line);
  if(quoted)quote.push(quoted[1]);else{flushQuote();prose.push(line);}
 }
 flushQuote();
 if(proseIsCopy&&prose.join('\n').trim())blocks.push(prose.join('\n').trim());
 if(fence)blocks.push(body.join('\n'));
 let largest='',size=-1;
 for(const block of blocks){const count=countCopyUnits(block,unit);if(count>size){largest=block;size=count;}}
 return largest;
}

/** IDs come only from successful native results of current save/edit calls. */
export function currentVaultWriteIds(turns:readonly TranscriptTurn[]):Set<string>{
 const pending=new Set<string>(),ids=new Set<string>();
 for(const turn of currentRoundTurns(turns)){
  for(const call of turn.role==='assistant'?turn.calls??[]:[])if(call.id&&/(?:^|__)(?:save_memory|edit_memory)$/u.test(call.name))pending.add(call.id);
  for(const result of turn.role==='tool'?turn.results??[]:[]){
   if(!result.id||!pending.delete(result.id)||result.failed)continue;
   try{const response=JSON.parse(result.content);if(typeof response.id==='string'&&typeof response.file_path==='string'&&response.conflict_marked!==true&&response.hold!==true)ids.add(response.id);}catch{}
  }
 }
 return ids;
}
