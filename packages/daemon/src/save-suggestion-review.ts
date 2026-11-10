/** #1389: explicit, reversible decisions on exact save proposals; local state only. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { bastraDataDir } from './platform-paths.js';
import { readAppRecord, writeAppRecord } from './app-record-store.js';
import { withPathLock } from './path-lock.js';
import type { SaveSuggestion } from './stop-heuristics.js';
const Row=z.object({id:z.string(),project:z.string(),rejected:z.boolean()});
const Rows=z.array(Row);
const path=()=>process.env.BASTRA_SAVE_SUGGESTIONS_PATH??join(bastraDataDir(),'save-suggestions.json');
function read(){try{return Rows.parse(JSON.parse(readAppRecord('save-suggestions',path(),text=>{Rows.parse(JSON.parse(text));})));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}}
function write(rows:z.infer<typeof Rows>){writeAppRecord('save-suggestions',path(),JSON.stringify(rows),text=>{Rows.parse(JSON.parse(text));});}
export const ReviewSaveSuggestionArgs=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['reject','reset']),write_origin:z.literal('user-directed'),evidence:z.string().trim().min(1).max(2000).optional()}).superRefine((v,c)=>{if(v.decision==='reject'&&!v.evidence)c.addIssue({code:'custom',message:'Explicit user rejection evidence is required',path:['evidence']});});
export async function identifySaveSuggestions(project:string|null,suggestions:SaveSuggestion[],evidence:string):Promise<SaveSuggestion[]>{
 if(!project||!suggestions.length)return suggestions;
 return withPathLock(path(),async()=>{const rows=read();const identified=suggestions.map(s=>{
 const id=createHash('sha256').update(JSON.stringify([project,s.heuristic,s.proposal_evidence??evidence])).digest('hex');
 if(!rows.some(r=>r.id===id&&r.project===project))rows.push({id,project,rejected:false});
 return {...s,proposal_id:id};});write(rows);return identified;},{crossProcess:true,requireLock:true});
}
export async function visibleSaveSuggestions(project:string|null,suggestions:SaveSuggestion[]):Promise<SaveSuggestion[]>{
 if(!project||!suggestions.some(s=>s.proposal_id))return suggestions;
 const rejected=new Set(read().filter(r=>r.project===project&&r.rejected).map(r=>r.id));
 return suggestions.filter(s=>!s.proposal_id||!rejected.has(s.proposal_id));
}
export async function filterPendingSaveSuggestions(project:string|null,blocks:string):Promise<string>{
 if(!project)return blocks;
 const rejected=new Set(read().filter(r=>r.project===project&&r.rejected).map(r=>r.id));
 return blocks.replace(/<save-eval proposal_id="([a-f0-9]{64})">[\s\S]*?<\/save-eval>/g,(block,id:string)=>rejected.has(id)?'':block);
}
export async function reviewSaveSuggestion(project:string|null,input:unknown){
 const args=ReviewSaveSuggestionArgs.parse(input);if(!project)throw new Error('A known project is required');
 return withPathLock(path(),async()=>{const rows=read(),row=rows.find(r=>r.id===args.id&&r.project===project);
 if(!row)throw new Error('Unknown save suggestion in this project');row.rejected=args.decision==='reject';write(rows);
 return {id:row.id,project:row.project,state:row.rejected?'suppressed':'available',attestation:'agent-reported user direction; not independent authentication'};
 },{crossProcess:true,requireLock:true});
}
export const saveSuggestionTools=[{name:'review_save_suggestion',description:'Only after the user explicitly rejects a displayed save proposal: pass its proposal_id, decision:reject, write_origin:user-directed and evidence quoting the explicit rejection. Suppresses only this exact proposal in the current project. Silence, not saving, or an agent assessment are never rejection. Use decision:reset after the user asks to restore it. No rule or trigger weights change. This is an agent attestation, not independent user authentication.',inputSchema:{type:'object' as const,properties:{id:{type:'string'},decision:{type:'string',enum:['reject','reset']},write_origin:{type:'string',enum:['user-directed']},evidence:{type:'string',description:'Explicit rejection evidence, required for reject; never inferred from silence'}},required:['id','decision','write_origin']}}];
