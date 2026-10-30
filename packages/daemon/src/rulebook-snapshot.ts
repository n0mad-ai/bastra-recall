/** One byte-consistent source scan per vault, shared by every session projection. */
import {constants} from "node:fs";
import fs from "node:fs/promises";
import {memoryRevision,parseMemory,type Memory,type Vault} from "@bastra-recall/core";
export interface RulebookSource {memory:Memory;revision:string|null;unavailable:boolean;}
interface Snapshot {sources:RulebookSource[];at:number;generation:number;}
interface Cache {generation:number;value?:Snapshot;pending?:Promise<Snapshot>;ticket:number;dirtyAt?:number;}
const caches=new WeakMap<object,Cache>();
export const RULEBOOK_SOURCE_TTL_MS=2000;
export const RULEBOOK_IDS_MAX_AGE_MS=30000;
export const RULEBOOK_BUILD_BUDGET_MS=800;
export const RULEBOOK_FILE_BUDGET_MS=100;
const MAX_READS=16;
// A timed-out OS operation can outlive its caller (e.g. a cloud placeholder).
// Keep it single-flight by path and count it until it actually settles. Neither
// replacement scans nor startup fallbacks can accumulate more than 16 reads.
const reads=new Map<string,Promise<string>>();
async function sourceBytes(path:string,signal?:AbortSignal):Promise<string>{
 const deadline=Date.now()+RULEBOOK_FILE_BUDGET_MS;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const controller=new AbortController();
 const abort=()=>controller.abort();signal?.addEventListener("abort",abort,{once:true});
 if(signal?.aborted)abort();
 try{return await Promise.race([
  (async()=>{
   // A previous generation may still be reading old bytes. Do not reuse that
   // result for current content: quarantine this path until the read settles.
   if(reads.has(path))throw Error("rulebook_source_pending");
   // Saturation is reported as unavailable, rather than attaching an unbounded
   // queue of waiters to OS reads that might never resolve.
   if(reads.size>=MAX_READS)throw Error("rulebook_reader_saturated");
   {
    if(controller.signal.aborted)throw Error("rulebook_file_timeout");
    // NONBLOCK prevents a FIFO from tying up a libuv worker at open/read.
    const pending=fs.readFile(path,{encoding:"utf8",flag:constants.O_RDONLY|(constants.O_NONBLOCK??0),signal:controller.signal});
    reads.set(path,pending);const own=pending;
    void pending.finally(()=>{if(reads.get(path)===own)reads.delete(path);}).catch(()=>{});
    return pending;
   }
  })(),
  new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("rulebook_file_timeout"));},Math.max(0,deadline-Date.now()));})
 ]);}finally{if(timer)clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
export async function readRulebookSources(vault:Pick<Vault,"list">,signal?:AbortSignal):Promise<RulebookSource[]>{
 const indexed=vault.list(),sources:RulebookSource[]=new Array(indexed.length);let next=0;
 await Promise.all(Array.from({length:Math.min(MAX_READS,indexed.length)},async()=>{
  for(;;){if(signal?.aborted)throw Error("rulebook_build_timeout");const i=next++;if(i>=indexed.length)return;const m=indexed[i];
   if(!m.filePath){sources[i]={memory:m,revision:null,unavailable:false};continue;}
   try{const raw=await sourceBytes(m.filePath,signal),memory=parseMemory(raw,m.filePath,m.mtime??0);
    sources[i]={memory,revision:memoryRevision(raw),unavailable:memory.fm.id!==m.fm.id};
   }catch{sources[i]={memory:m,revision:null,unavailable:true};}
  }
 }));return sources;
}
export async function rulebookSources(vault:Pick<Vault,"list"> & Partial<Pick<Vault,"on">>,idsOnly=false):Promise<{sources:RulebookSource[];isCurrent:()=>boolean}>{
 if(!vault.on)return {sources:await readRulebookSources(vault),isCurrent:()=>true};
 let cache=caches.get(vault);
 if(!cache){
  cache={generation:0,ticket:0};caches.set(vault,cache);const own=cache;
  vault.on(()=>{own.generation++;own.dirtyAt??=Date.now();});
 }
 const c=cache;
 const build=(followup=true):Promise<Snapshot>=>{
  if(c.pending)return c.pending;
  const generation=c.generation,ticket=++c.ticket,controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const pending=Promise.race([
   Promise.resolve().then(()=>readRulebookSources(vault,controller.signal)).then(sources=>{
    if(controller.signal.aborted||ticket!==c.ticket)throw Error("rulebook_build_timeout");
    const snapshot={sources,at:Date.now(),generation};
    c.value=snapshot;if(generation===c.generation)c.dirtyAt=undefined;
    return snapshot;
   }),
   new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("rulebook_build_timeout"));},RULEBOOK_BUILD_BUDGET_MS);})
  ]);
  c.pending=pending;
  void pending.then(snapshot=>{
   if(timer)clearTimeout(timer);
   if(c.pending!==pending)return;
   c.pending=undefined;
   // Complete this scan even under a storm, then schedule exactly one followup.
   // Later callers can request another cycle; no event creates parallel scans.
   if(followup&&snapshot.generation!==c.generation)void build(false).catch(()=>{});
  },()=>{
   if(timer)clearTimeout(timer);controller.abort();
   if(c.pending===pending){c.pending=undefined;++c.ticket;}
  });
  return pending;
 };
 const valid=(snapshot:Snapshot)=>{
  const now=Date.now(),age=now-snapshot.at;
  if(!idsOnly)return snapshot.generation===c.generation&&age<RULEBOOK_SOURCE_TTL_MS;
  return age<RULEBOOK_IDS_MAX_AGE_MS&&(snapshot.generation===c.generation||
   (c.dirtyAt!==undefined&&now-c.dirtyAt<RULEBOOK_IDS_MAX_AGE_MS));
 };
 const view=(snapshot:Snapshot)=>({sources:snapshot.sources,isCurrent:()=>valid(snapshot)});
 const value=c.value,age=value?Date.now()-value.at:Infinity,current=value?.generation===c.generation;
 if(current&&age<RULEBOOK_SOURCE_TTL_MS)return view(value!);
 if(idsOnly&&value&&valid(value)){void build().catch(()=>{});return view(value);}
 return view(await build());
}
