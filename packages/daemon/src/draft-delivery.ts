/** In-memory receipts for draft IDs rendered by this daemon, never client claims. */
import { draftsPath, draftSearchSnapshot } from './draft-store.js';
import { draftNovelTokens, recordDraftHints } from './draft-use.js';
import { cleanDraftField } from './draft-text.js';
import { ACTED_ON_WINDOW_MS } from './telemetry-join-state.js';
const delivered=new Map<string,Map<string,{at:number;novel:string[]}>>();
const key=(session:string)=>`${draftsPath()}:${cleanDraftField(session)}`;
export function markDraftDelivery(session:string,ids:string[],input:string):void {
 if(!session||!input.trim())return;
 const now=Date.now();for(const[k,rows]of delivered){for(const[id,r]of rows)if(now-r.at>ACTED_ON_WINDOW_MS)rows.delete(id);if(!rows.size)delivered.delete(k);}
 const k=key(session);while(delivered.size>=500&&!delivered.has(k))delivered.delete(delivered.keys().next().value!);
 const rows=delivered.get(k)??new Map(),snapshot=draftSearchSnapshot().rows;
 for(const id of ids.slice(0,2)){const row=snapshot.find(r=>r.id===id);if(row)rows.set(id,{at:now,novel:draftNovelTokens(row,input)});}
 while(rows.size>32)rows.delete(rows.keys().next().value!);delivered.set(k,rows);
}
export async function recordDeliveredDraftHints(ids:string[],session:string|null,input:string|null):Promise<number>{
 if(!session||!input?.trim())return 0;
 const rows=delivered.get(key(session)),novel=new Map<string,string[]>();
 for(const id of ids.slice(0,2)){const receipt=rows?.get(id);if(receipt&&Date.now()-receipt.at<=ACTED_ON_WINDOW_MS)novel.set(id,receipt.novel);}
 return novel.size?recordDraftHints([...novel.keys()],session,input,Date.now(),novel):0;
}
