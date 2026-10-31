/** Current per-rule metadata only. Authority is enforced at the write source. */
import {ConventionValidatorSchema} from '@bastra-recall/core';
import type {ReadonlySessionState} from './session-state.js';
export function taskValidators(state:ReadonlySessionState){
 const byId=new Map<string,{at:number;validator?:unknown}>();
 for(const c of state.activeConventions??[])byId.set(c.id,{at:c.setAt,validator:c.validator});
 for(const c of state.loadedConventions??[])if(c.loadedAt>=(byId.get(c.id)?.at??-Infinity))byId.set(c.id,{at:c.loadedAt,validator:c.validator});
 const valid=[...byId.values()].flatMap(c=>{const p=ConventionValidatorSchema.safeParse(c.validator);return p.success?[p.data]:[];});
 const channel=state.activeTask?.validatorChannel;
 const selected=channel&&valid.some(v=>v.channel===channel)?valid.filter(v=>v.channel===channel):valid;
 const limits=new Map<string,typeof valid[number]>();
 for(const v of selected){const key=JSON.stringify([v.channel,v.unit]);if(!limits.has(key)||limits.get(key)!.limit>v.limit)limits.set(key,v);}
 return [...limits.values()].map(validator=>({validator}));
}
