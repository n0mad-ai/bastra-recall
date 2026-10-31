/** Refresh only the rules loaded/active or declared in this round, from the current
 * in-memory index; never reopen Vault files. A deadline/outage retains prior evidence; late work cannot write. */
import {roundCorrespondence,refreshRoundValidators} from './rulebook-check.js';
import {withRulebookDeadline} from './rulebook-catalog.js';
import {loadSessionState,mutateSessionState} from './session-state.js';
import type {ConventionSource} from './convention-source.js';
export async function refreshStopValidators(sessionId:string,sourceOf:(id:string)=>Promise<ConventionSource>,deadline:number,p:import("./rulebook-check.js").RulebookPayload={bastra_client:"claude-code"}):Promise<void>{
   try { await withRulebookDeadline(async()=>{
    const state=await loadSessionState(sessionId);
    const ids=[...new Set([...(state.loadedConventions??[]).map(c=>c.id),...(state.activeConventions??[]).map(c=>c.id),...roundCorrespondence(state,p).rules.map(c=>c.id)])];
    const sources=new Map(await Promise.all(ids.map(async id=>[id,await sourceOf(id)] as const)));
    if(Date.now()>=deadline)return;
    if(ids.length)await mutateSessionState(sessionId,s=>{
      if(s.activeTask?.id!==state.activeTask?.id||s.activeTask?.generation!==state.activeTask?.generation)return;
      refreshRoundValidators(s,state,sources);
      for(const c of [...(s.loadedConventions??[]),...(s.activeConventions??[])]){
        const prior=[...(state.loadedConventions??[]),...(state.activeConventions??[])].find(p=>p.id===c.id&&p.revision===c.revision);
        if(!prior)continue;
        const source=sources.get(c.id);if(!source)continue;
        c.revision=source.revision;if(source.validator&&!source.hiddenFromPublic)c.validator=source.validator;else delete c.validator;
      }
    },{noQueue:true,deadline});
   },deadline); } catch { /* Keep the last observed source during an outage. */ }

}
