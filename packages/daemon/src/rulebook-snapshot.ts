/** One byte-consistent source scan per vault, shared by every session projection. */
import {readFile} from "node:fs/promises";
import {memoryRevision,parseMemory,type Memory,type Vault} from "@bastra-recall/core";
export interface RulebookSource {memory:Memory;revision:string|null;unavailable:boolean;}
interface Snapshot {sources:RulebookSource[];at:number;generation:number;}
interface Cache {generation:number;value?:Snapshot;pending?:Promise<Snapshot>;}
const caches=new WeakMap<object,Cache>();
export const RULEBOOK_SOURCE_TTL_MS=2000;
export const RULEBOOK_IDS_MAX_AGE_MS=30000;
export async function readRulebookSources(vault:Pick<Vault,"list">):Promise<RulebookSource[]>{
 const indexed=vault.list(),sources:RulebookSource[]=new Array(indexed.length);let next=0;
 await Promise.all(Array.from({length:Math.min(16,indexed.length)},async()=>{
  for(;;){const i=next++;if(i>=indexed.length)return;const m=indexed[i];
   if(!m.filePath){sources[i]={memory:m,revision:null,unavailable:false};continue;}
   try{const raw=await readFile(m.filePath,"utf8"),memory=parseMemory(raw,m.filePath,m.mtime??0);
    sources[i]={memory,revision:memoryRevision(raw),unavailable:memory.fm.id!==m.fm.id};
   }catch{sources[i]={memory:m,revision:null,unavailable:true};}
  }
 }));return sources;
}
export async function rulebookSources(vault:Pick<Vault,"list"> & Partial<Pick<Vault,"on">>,idsOnly=false):Promise<{sources:RulebookSource[];isCurrent:()=>boolean}>{
 if(!vault.on)return {sources:await readRulebookSources(vault),isCurrent:()=>true};
 let cache=caches.get(vault);
 if(!cache){cache={generation:0};caches.set(vault,cache);const own=cache;vault.on(()=>{own.generation++;});}
 const c=cache;
 const build=()=>{
  if(c.pending)return c.pending;
  const pending=(async()=>{
   // An event during a scan invalidates that scan. Rebuild serially, never alongside it.
   for(;;){const generation=c.generation,sources=await readRulebookSources(vault);
    if(generation!==c.generation)continue;
    return c.value={sources,at:Date.now(),generation};
   }
  })();c.pending=pending;
  void pending.finally(()=>{if(c.pending===pending)c.pending=undefined;}).catch(()=>{});
  return pending;
 };
 const view=(snapshot:Snapshot)=>({sources:snapshot.sources,isCurrent:()=>snapshot.generation===c.generation&&Date.now()-snapshot.at<(idsOnly?RULEBOOK_IDS_MAX_AGE_MS:RULEBOOK_SOURCE_TTL_MS)});
 const value=c.value,age=value?Date.now()-value.at:Infinity,current=value?.generation===c.generation;
 if(current&&age<RULEBOOK_SOURCE_TTL_MS)return view(value!);
 if(idsOnly&&current&&age<RULEBOOK_IDS_MAX_AGE_MS){void build().catch(()=>{});return view(value!);}
 return view(await build());
}
