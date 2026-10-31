/** Render and refresh the workflow stage explicitly reported by the agent.
 * Prompt words and recall hits never create tasks, select channels or change stages.
 */
import type {Vault} from '@bastra-recall/core';
import {vaultConventionOf,type ConventionSource} from './convention-source.js';
import {formatActiveConventionsBlock,type ActiveConventionsView} from './prompt-format.js';
import {currentReceipt} from './receipt-store.js';
import {mutateSessionState,type ReadonlySessionState} from './session-state.js';

export interface TaskStepInput {
 sessionId:string;
 snapshot:ReadonlySessionState;
 revisionOf?:(id:string)=>Promise<string|null>;
 conventionOf?:(id:string)=>Promise<ConventionSource>;
 surface:string;
 now?:number;
}
export function vaultRevisionOf(vault:Pick<Vault,'get'>):(id:string)=>Promise<string|null>{
 const source=vaultConventionOf(vault);
 return async id=>(await source(id)).revision;
}
function view(state:ReadonlySessionState,changed:string[]=[]):ActiveConventionsView{
 return {task:state.activeTask?.kind??'none',approvalSource:state.activeTask?.approvalSource,
  generation:state.activeTask?.generation??0,conventions:state.activeConventions??[],changed,receipt:currentReceipt(state)};
}
export async function runTaskStep(input:TaskStepInput):Promise<string|null>{
 try{return await step(input);}catch{return null;}
}
async function step(input:TaskStepInput):Promise<string|null>{
 const {snapshot,sessionId}=input;
 if(!sessionId)return null;
 const active=snapshot.activeConventions??[];
 if(!active.length&&(!snapshot.activeTask||snapshot.activeTask.kind==='none'))return null;
 if(!input.conventionOf&&!input.revisionOf)return formatActiveConventionsBlock(view(snapshot),input.surface);
 // Authoritative indexed metadata only; no matching against the user's text.
 const entries=await Promise.all(active.map(async(c):Promise<[string,ConventionSource]>=>{
  const source:ConventionSource=input.conventionOf?
   await input.conventionOf(c.id).catch(()=>({revision:null})):
   {revision:await input.revisionOf!(c.id).catch(()=>null)};
  return [c.id,source];
 }));
 const sources=new Map<string,ConventionSource>(entries);
 const drift=active.some(c=>{const source=sources.get(c.id)!;return c.revision!==source.revision||
  (input.conventionOf!==undefined&&JSON.stringify(c.validator)!==JSON.stringify(source.validator));});
 if(!drift)return formatActiveConventionsBlock(view(snapshot),input.surface);
 let updated:ActiveConventionsView|null=null;
 const persisted=await mutateSessionState(sessionId,s=>{
  const changed:string[]=[];
  for(const c of s.activeConventions??[]){
   const source=sources.get(c.id);if(!source)continue;
   if(c.revision!==source.revision&&c.revision!==null)changed.push(c.id);
   const revisionChanged=c.revision!==source.revision;c.revision=source.revision;
   if(input.conventionOf){if(source.validator)c.validator=source.validator;else delete c.validator;}
   else if(revisionChanged)delete c.validator;
  }
  delete s.receipts;
  updated=view(s,changed);
 });
 return formatActiveConventionsBlock(persisted&&updated?updated:view(snapshot),input.surface);
}
