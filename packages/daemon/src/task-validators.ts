/** Task-local validator snapshots. Constraints combine by conjunction: different
 * units/channels have no safe scalar ordering. A smaller-limit receipt can
 * satisfy several constraints on the same channel without extra validation. */
import {ConventionValidatorSchema} from '@bastra-recall/core';
import type {ActiveTask,TaskValidatorBinding} from './task-state.js';
import type {ReadonlySessionState} from './session-state.js';

export function mergeTaskValidators(...sets: readonly (readonly {id:string;validator?:unknown}[])[]):TaskValidatorBinding[]{
 const bindings=new Map<string,TaskValidatorBinding>();
 for(const set of sets)for(const ref of set){
  const parsed=ConventionValidatorSchema.safeParse(ref.validator);if(!parsed.success)continue;
  const v=parsed.data,key=JSON.stringify([ref.id,v.channel,v.unit]);
  const old=bindings.get(key);
  if(!old||old.validator.limit>v.limit)bindings.set(key,{id:ref.id,validator:{...v}});
 }
 return [...bindings.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function taskValidators(state:ReadonlySessionState):TaskValidatorBinding[]{
 const task=state.activeTask;if(!task||!['draft-for-review','approved-copy'].includes(task.kind))return [];
 let frozen:TaskValidatorBinding[]=[];
 if(task.validatorBindings!==undefined){
  frozen=mergeTaskValidators(task.validatorBindings);
  // A genuine empty snapshot freezes an empty task. Invalid persisted bindings
  // use the conservative legacy path, never a newest-load fallback.
  if((frozen.length&&(!task.validatorRuleId||frozen.some(v=>v.id===task.validatorRuleId)))||
    (task.validatorBindings.length===0&&!task.validatorRuleId))return frozen;
 }
 const eligible=mergeTaskValidators(
  (state.activeConventions??[]).filter(c=>c.setAt<=task.since),
  (state.loadedConventions??[]).filter(c=>c.loadedAt<=task.since));
 if(task.validatorBindings!==undefined)return mergeTaskValidators(frozen,eligible);
 const bound=eligible.filter(c=>c.id===task.validatorRuleId);
 return bound.length?bound:eligible;
}

export function freezeTaskValidators(task:ActiveTask,bindings:readonly TaskValidatorBinding[],source:'user-turn'|'model'){
 task.validatorBindings=mergeTaskValidators(bindings);
 task.validatorBindingSource=source;
 // Compatibility/provenance only. Model order can never choose this ID.
 const ids=[...new Set(task.validatorBindings.map(b=>b.id))];
 if(source==='model'){
  if(ids.length===1)task.validatorRuleId=ids[0];else delete task.validatorRuleId;
 }
}

/** A model may tighten a user-selected channel, never switch it to unrelated
 * loaded correspondence channels. Model-origin sets can only grow/strengthen. */
export function modelTaskValidators(state:ReadonlySessionState,incoming:readonly {id:string;validator?:unknown}[]){
 const running=state.activeTask&&['draft-for-review','approved-copy'].includes(state.activeTask.kind);
 const named=mergeTaskValidators(incoming);
 const previous=running?taskValidators(state):named.length?[]:taskValidators({...state,activeTask:{id:'starting',kind:'draft-for-review',since:Date.now(),generation:0}});
 // Old validatorRuleId alone did not distinguish a user turn from a model's
 // first applicable ID. Unknown provenance cannot grant channel-selection power.
 const source=state.activeTask?.validatorBindingSource??'model';
 const channels=new Set(previous.map(b=>b.validator.channel));
 const additions=named.filter(b=>source!=='user-turn'||channels.size===0||channels.has(b.validator.channel));
 return {bindings:mergeTaskValidators(previous,additions),source};
}
