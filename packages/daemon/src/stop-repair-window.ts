/** Persisted transcript watermark for Stop repair; never retains message bytes. */
import {createHash} from 'node:crypto';
import type {TranscriptTurn} from './stop-transcript.js';

export interface RepairWindow {scope:string;length:number;tail:string;delivered?:string}
export type RepairWindows = Record<string, RepairWindow>;
export function parseRepairWindows(value:unknown):RepairWindows|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 return Object.fromEntries(Object.entries(value).filter((entry):entry is [string,RepairWindow]=>{
  const v=entry[1] as RepairWindow|null;
  return !!v&&typeof v.scope==='string'&&Number.isSafeInteger(v.length)&&v.length>=0&&typeof v.tail==='string'&&(v.delivered===undefined||typeof v.delivered==='string');
 }));
}
// Tools may be appended to the preceding Codex row after Stop. They are not
// a new text and must not invalidate a watermark for its existing content.
const digest=(turn:TranscriptTurn|undefined)=>createHash('sha256').update(JSON.stringify(turn?{role:turn.role,content:turn.content,at:turn.at}:null)).digest('hex');
export function repairCutoff(window:Readonly<RepairWindow>|undefined,scope:string,turns:readonly TranscriptTurn[]):number {
 if(!window||window.scope!==scope||window.length>turns.length)return 0;
 return digest(turns[window.length-1])===window.tail?window.length:0;
}
export function repairWindow(scope:string,turns:readonly TranscriptTurn[],delivered?:string):RepairWindow {
 return {scope,length:turns.length,tail:digest(turns.at(-1)),...(delivered?{delivered}:{})};
}
