/** Private cold snapshots retain idempotency and audit; nothing unresolved is evicted. */
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { taskStoreSchema, TASK_MAX_BYTES, type TaskStore } from "./task-schema.js";
import { canonicalTaskValue } from "./task-canonical.js";
import { TaskStoreError, atomicWrite, withTaskStoreGuard } from "./task-store.js";
import { authenticateTask, requireTaskOwner, requireTaskDomains } from "./task-auth.js";
import type { TaskServiceContext } from "./task-service.js";
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
export const archiveIntentKey=(actor:string,key:string)=>sha(canonicalTaskValue(["archive-intent-v1",actor,key]));
const bundleSchema=z.strictObject({schema_version:z.literal(1),id:z.string().uuid(),snapshot:taskStoreSchema});
export function taskArchivePath(path:string,id:string){return join(dirname(path),"task-archives",`${z.string().uuid().parse(id)}.json`);}
export async function readTaskArchive(path:string,entry:TaskStore["archives"][number]):Promise<TaskStore>{
  try {
    const fd=await open(taskArchivePath(path,entry.id),constants.O_RDONLY|constants.O_NOFOLLOW);let raw:string;
    try{const info=await fd.stat();if(!info.isFile()||info.mode&0o077||info.size>TASK_MAX_BYTES+1024)throw new Error("unsafe archive");const bytes=Buffer.alloc(TASK_MAX_BYTES+1025),read=await fd.read(bytes,0,bytes.length,0);if(read.bytesRead>TASK_MAX_BYTES+1024)throw new Error("archive too large");raw=bytes.subarray(0,read.bytesRead).toString("utf8");}finally{await fd.close();}
    if(sha(raw)!==entry.hash)throw new Error("archive hash differs");const b=bundleSchema.parse(JSON.parse(raw));
    if(b.id!==entry.id||canonicalTaskValue(b.snapshot.tasks.map(t=>t.id).sort())!==canonicalTaskValue([...entry.task_ids].sort()))throw new Error("archive index differs");
    return b.snapshot;
  }catch{throw new TaskStoreError("corrupt","Private task archive missing or altered; no idempotency reuse");}
}
export async function archivedTask(path:string,s:TaskStore,id:string){
  const entry=[...s.archives].reverse().find(a=>a.task_ids.includes(id));if(!entry)return;
  const snapshot=await readTaskArchive(path,entry);return {entry,snapshot,task:snapshot.tasks.find(t=>t.id===id)!};
}
export async function archivedIntent(path:string,s:TaskStore,actor:string,key:string){
  const digest=archiveIntentKey(actor,key),entry=[...s.archives].reverse().find(a=>a.intent_keys.includes(digest));if(!entry)return;
  const snapshot=await readTaskArchive(path,entry),intent=snapshot.intents.find(i=>i.actor===actor&&i.idempotency_key===key);
  if(!intent)throw new TaskStoreError("corrupt","Archived intent index differs");return {entry,snapshot,intent};
}
const groupRows=["tasks","occurrences","proposals","challenges","approvals","leases","intents","receipts"] as const;
function selectGroup(s:TaskStore,ids:Set<string>):TaskStore{
  const group=structuredClone(s);group.archives=[];group.tasks=s.tasks.filter(t=>ids.has(t.id));
  group.proposals=s.proposals.filter(p=>ids.has(p.task_id));const proposals=new Set(group.proposals.map(p=>p.id));
  group.occurrences=s.occurrences.filter(o=>ids.has(o.task_id));group.challenges=s.challenges.filter(c=>proposals.has(c.proposal_id));group.approvals=s.approvals.filter(a=>proposals.has(a.proposal_id));
  group.leases=s.leases.filter(l=>ids.has(l.task_id));group.intents=s.intents.filter(i=>ids.has(i.task_id));group.receipts=s.receipts.filter(r=>ids.has(r.task_id));
  const sources=new Set(group.tasks.flatMap(t=>[...t.evidence.map(e=>e.source_id),...(t.schedule.kind==="event"?[t.schedule.source_id]:[])]));
  group.events=s.events.filter(e=>sources.has(e.source_id)||group.occurrences.some(o=>o.event_key===`event:${e.id}`));group.sources=s.sources.filter(src=>sources.has(src.id));group.checkpoint=0;group.evaluation_cursor=0;group.recovery_history=[];
  return taskStoreSchema.parse(group);
}
/** Called by the guard, never trusted merely because a caller supplies archive kind. */
export async function validateTaskArchivePrune(path:string,before:TaskStore,after:TaskStore):Promise<TaskStore>{
  if(after.archives.length!==before.archives.length+1||canonicalTaskValue(after.archives.slice(0,-1))!==canonicalTaskValue(before.archives))throw new TaskStoreError("conflict","Archive index append required");
  const entry=after.archives.at(-1)!,archived=await readTaskArchive(path,entry),ids=new Set(entry.task_ids),expected=selectGroup(before,ids);
  if(!before.controls.execution_stopped || expected.tasks.some(t=>t.armed||!["resolved","cancelled","expired"].includes(t.state)||t.decision_change?.status==="pending")||expected.occurrences.some(o=>!o.resolution)||expected.intents.some(i=>["pending","unknown"].includes(i.state)||i.temp_cleanup_pending)||expected.leases.some(l=>l.state==="active")) throw new TaskStoreError("conflict","Unresolved work cannot be archived");
  if(canonicalTaskValue(archived)!==canonicalTaskValue(expected))throw new TaskStoreError("conflict","Archive is not exact committed predecessor");
  const comparison=structuredClone(before);
  for(const name of groupRows){const removed=new Set(archived[name].map(r=>r.id));(comparison[name] as {id:string}[])=(comparison[name] as {id:string}[]).filter(r=>!removed.has(r.id));}
  comparison.archives=after.archives;
  if(canonicalTaskValue(comparison)!==canonicalTaskValue(after))throw new TaskStoreError("conflict","Only exact archived rows may be retired");
  return comparison;
}
export const taskArchiveInput=z.strictObject({task_ids:z.array(z.string().min(1).max(160)).min(1).max(100),expected_revision:z.number().int().nonnegative().safe(),recovery_epoch:z.string().min(1).max(160)});
export async function archiveTasks(ctx:TaskServiceContext,authorization:string|undefined,raw:unknown){
  const input=taskArchiveInput.parse(raw),owner=await authenticateTask(authorization,ctx.authPath);requireTaskOwner(owner);
  return withTaskStoreGuard(ctx.path,async guard=>{
    const s=guard.snapshot();if(s.revision!==input.expected_revision||s.recovery_epoch!==input.recovery_epoch)throw new TaskStoreError("conflict","Archive snapshot changed");
    const current=await authenticateTask(authorization,ctx.authPath);requireTaskOwner(current);const ids=new Set(input.task_ids),group=selectGroup(s,ids);
    if(group.tasks.length!==ids.size)throw Object.assign(new Error("Task absent"),{code:"not_found"});
    const domains=[...new Set([...group.tasks.flatMap(t=>t.owner_domains),...group.proposals.flatMap(p=>p.required_domains),...group.events.flatMap(e=>e.owner_domains),...group.sources.flatMap(src=>src.owner_domains)])];requireTaskDomains(current,domains);
    if(!s.controls.execution_stopped||group.tasks.some(t=>t.armed||!["resolved","cancelled","expired"].includes(t.state)||t.decision_change?.status==="pending")||group.occurrences.some(o=>!o.resolution)||group.intents.some(i=>i.state==="pending"||i.state==="unknown"||i.temp_cleanup_pending)||group.leases.some(l=>l.state==="active"))throw new TaskStoreError("conflict","Stop execution; unresolved occurrences/intents/leases stay active");
    if(s.archives.length>=1000)throw new TaskStoreError("capacity","Archive index limit; no unsafe eviction");
    const id=randomUUID(),rawBundle=JSON.stringify(bundleSchema.parse({schema_version:1,id,snapshot:group}));if(Buffer.byteLength(rawBundle)>TASK_MAX_BYTES+1024)throw new TaskStoreError("capacity","Archive too large");
    const entry={id,hash:sha(rawBundle),at:(ctx.now??Date.now)(),actor:current.actor_id,task_ids:[...ids],intent_keys:group.intents.map(i=>archiveIntentKey(i.actor,i.idempotency_key)),owner_domains:domains};
    await mkdir(dirname(taskArchivePath(ctx.path,id)),{recursive:true,mode:0o700});await atomicWrite(taskArchivePath(ctx.path,id),rawBundle,guard.assertOwnership);
    // An interrupted pre-index export is harmless: active data still owns every ID.
    await guard.commit(next=>{next.archives.push(entry);for(const name of groupRows){const remove=new Set(group[name].map(r=>r.id));(next[name] as {id:string}[])=(next[name] as {id:string}[]).filter(r=>!remove.has(r.id));}},"archive");
    return {archive_id:id,task_count:ids.size,history_retained:true,spent_approvals_retained:true};
  });
}
export async function restoreTaskArchive(ctx:TaskServiceContext,authorization:string|undefined,archiveId:string){
 const owner=await authenticateTask(authorization,ctx.authPath);requireTaskOwner(owner);
 return withTaskStoreGuard(ctx.path,async guard=>{const s=guard.snapshot(),entry=s.archives.find(a=>a.id===archiveId);if(!entry)throw Object.assign(new Error("Archive absent"),{code:"not_found"});
 const current=await authenticateTask(authorization,ctx.authPath);requireTaskOwner(current);requireTaskDomains(current,entry.owner_domains);const archived=await readTaskArchive(ctx.path,entry);
 if(entry.task_ids.every(id=>s.tasks.some(t=>t.id===id)))return{restored:false,archive_id:entry.id};
 if(entry.task_ids.some(id=>s.tasks.some(t=>t.id===id)))throw new TaskStoreError("conflict","Partial archive restore forbidden");
 await guard.commit(next=>{for(const name of groupRows){for(const row of archived[name]){if((next[name] as {id:string}[]).some(r=>r.id===row.id))throw new TaskStoreError("conflict","Archived identity reused");(next[name] as unknown[]).push(structuredClone(row));}}next.controls.execution_stopped=true;},"control");
 return{restored:true,archive_id:entry.id,unarmed:true,execution_stopped:true};});
}
