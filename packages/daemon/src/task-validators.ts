/** Dynamic session constraints; model reports and load order never narrow them. */
import {ConventionValidatorSchema} from '@bastra-recall/core';
import type {ReadonlySessionState} from './session-state.js';

export function taskValidators(state:ReadonlySessionState){
 const constraints=new Map<string,ReturnType<typeof ConventionValidatorSchema.parse>>();
 const all=[...(state.validatorLimits??[]),...(state.activeConventions??[]).map(c=>c.validator),
  ...(state.loadedConventions??[]).map(c=>c.validator)];
 for(const value of all){
  const parsed=ConventionValidatorSchema.safeParse(value);if(!parsed.success)continue;
  const v=parsed.data;if(state.userValidatorChannel&&v.channel!==state.userValidatorChannel)continue;
  const key=JSON.stringify([v.channel,v.unit]);
  if(!constraints.has(key)||constraints.get(key)!.limit>v.limit)constraints.set(key,v);
 }
 return [...constraints.values()].map(validator=>({validator}));
}
