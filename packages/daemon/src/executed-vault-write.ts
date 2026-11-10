/** Successful daemon executions, bound before entry to their caller's round.
 * Source strings and returned aggregate exec output never enter this ledger. */
import { loadSessionState, mutateSessionState } from './session-state.js';
import { actionRulebookScope } from './rulebook-check.js';
import { hookAgent } from './hook-surface.js';
import type { ClaudeStopPayload } from './stop-transcript.js';
import { z } from 'zod';

/** Transport-only fields: stripped before any persisted memory projection. */
export const VaultWriteAttribution=z.object({session_id:z.string().min(1).max(200).optional(),agent_id:z.string().min(1).max(200).optional()});

export interface ExecutedVaultWrite { scope:string; actor:string; id:string; at:number; sequence:number }
function read(raw:string|undefined):ExecutedVaultWrite[]{
 try {const value:unknown=JSON.parse(raw??'[]');return Array.isArray(value)?value.filter((r):r is ExecutedVaultWrite=>!!r&&typeof r==='object'&&typeof r.scope==='string'&&typeof r.actor==='string'&&typeof r.id==='string'&&Number.isFinite(r.at)&&Number.isSafeInteger(r.sequence)):[];}catch{return [];}
}
export async function withExecutedVaultWrite<T>(tool:string,caller:{ccSessionId?:string|null;agentId?:string|null},execute:()=>Promise<T>,args:Record<string,unknown>={}):Promise<T>{
 if(!['save_memory','edit_memory'].includes(tool))return execute();
 const attribution=VaultWriteAttribution.parse(args);
 const session=caller.ccSessionId??attribution.session_id;
 const agent=caller.agentId!==undefined?caller.agentId:attribution.agent_id??(attribution.session_id?null:undefined);
 if(!session||agent===undefined||!['save_memory','edit_memory'].includes(tool))return execute();
 const state=await loadSessionState(session).catch(()=>({shown:{},rulebookCheck:undefined}));
 if(!state.rulebookCheck)return execute();
 const scope=actionRulebookScope(state),actor=agent===null?'main':`agent:${agent}`;
 const result=await execute();
 // Holds and conflict diversions did not perform the requested write.
 const r=result as Record<string,unknown>;
 if(!r||typeof r.id!=='string'||typeof r.file_path!=='string'||r.conflict_marked===true||r.hold===true)return result;
 const at=Date.now();
 await mutateSessionState(session,s=>{
  if(!s.rulebookCheck||actionRulebookScope(s)!==scope)return;
  const previous=read(s.executedVaultWrites),sequence=(previous.at(-1)?.sequence??0)+1;
  s.executedVaultWrites=JSON.stringify([...previous.filter(w=>w.scope===scope),{scope,actor,id:r.id,at,sequence}].slice(-32));
 }).catch(()=>false); // Missing advisory evidence must never turn a completed write into a retry.
 return result;
}
export async function currentExecutedVaultWrites(p:ClaudeStopPayload):Promise<ExecutedVaultWrite[]>{
 if(!p.session_id)return [];
 const state=await loadSessionState(p.session_id);if(!state.rulebookCheck)return [];
 const actor=p.agent_id?`agent:${p.agent_id}`:hookAgent(p)==='main'?'main':'unattributed';
 const scope=actionRulebookScope(state);
 return read(state.executedVaultWrites).filter(w=>w.scope===scope&&w.actor===actor);
}
