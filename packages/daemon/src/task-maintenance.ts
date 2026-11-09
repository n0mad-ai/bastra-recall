import { constants, fstatSync, readSync, renameSync, openSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticateTask, requireTaskOwner, requireTaskDomains } from "./task-auth.js";
import { recoverTaskStore, decodeTaskStore } from "./task-store.js";
import { readTaskSnapshotText } from "./task-database.js";
import { pathLockFilePath, PathLockUnavailableError } from "./path-lock.js";
import type { TaskServiceContext } from "./task-service.js";
export const taskRecoverInput=z.strictObject({});
export async function recoverTasks(ctx:TaskServiceContext,authorization:string|undefined,raw:unknown){
 taskRecoverInput.parse(raw);const owner=await authenticateTask(authorization,ctx.authPath);requireTaskOwner(owner);
 const backup=decodeTaskStore(readTaskSnapshotText(`${ctx.path}.backup`));
 requireTaskDomains(owner,[...new Set([...backup.tasks.flatMap(t=>t.owner_domains),...backup.proposals.flatMap(p=>p.required_domains),...backup.archives.flatMap(a=>a.owner_domains)])]);
 const recovered=await recoverTaskStore(ctx.path,owner.actor_id,async candidate=>{const current=await authenticateTask(authorization,ctx.authPath);requireTaskOwner(current);requireTaskDomains(current,[...new Set([...candidate.tasks.flatMap(t=>t.owner_domains),...candidate.proposals.flatMap(p=>p.required_domains),...candidate.archives.flatMap(a=>a.owner_domains)])]);});
 return {recovered:true,quarantined:recovered.quarantine!==null,tasks:recovered.store.tasks.length,recovery_epoch:recovered.store.recovery_epoch,unarmed:true,execution_stopped:true,changes_may_be_missing:recovered.changes_may_be_missing,recovered_archive_exports:recovered.recovered_archive_exports,original_readable:recovered.original_readable};
}
/** A lock-family file, read through its descriptor: never a FIFO, a symlink or more than 4 KiB (#1213). */
function readLockFile(file:string):{raw:string;ino:number;dev:number}|null{
 let fd:number;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|(constants.O_NONBLOCK??0));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw new PathLockUnavailableError();}
 try{const info=fstatSync(fd);if(!info.isFile()||info.size>4096)throw new PathLockUnavailableError();const bytes=Buffer.alloc(4097),read=readSync(fd,bytes,0,bytes.length,0);if(read>4096)throw new PathLockUnavailableError();return{raw:bytes.subarray(0,read).toString("utf8"),ino:info.ino,dev:info.dev};}
 finally{closeSync(fd);}
}
function quarantineLockFile(file:string):boolean{
 const seen=readLockFile(file);if(!seen)return false;
 let body:any;try{body=JSON.parse(seen.raw);}catch{/* unknown needs explicit offline attestation */}
 if(body?.host===hostname()&&Number.isSafeInteger(body.pid)&&body.pid>0){try{process.kill(body.pid,0);throw new PathLockUnavailableError();}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw new PathLockUnavailableError();}}
 const again=readLockFile(file);if(!again||again.ino!==seen.ino||again.dev!==seen.dev||again.raw!==seen.raw)throw new PathLockUnavailableError();
 renameSync(file,`${file}.quarantine-${randomUUID()}`);return true;
}
/** Explicit OFFLINE operator recovery. Never clears a known live local owner. */
export function quarantineOfflineTaskLock(path:string):{quarantined:number}{
 const lock=pathLockFilePath(path),mark=`${lock}.operator`,cleanup=`${lock}.reclaim.cleanup`;let fd:number;
 try{fd=openSync(mark,"wx",0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,host:hostname(),token:randomUUID()}));}catch{throw new PathLockUnavailableError();}
 let count=0,cleanupFd:number|undefined;
 try{
  // The ownerless marker of an interrupted reclaim is quarantined first; then this
  // recovery holds it exactly like reclaimDeadLocal's cleanup does (#1213).
  if(quarantineLockFile(cleanup))count++;
  try{cleanupFd=openSync(cleanup,"wx",0o600);}catch{throw new PathLockUnavailableError();}
  for(const file of [lock,`${lock}.reclaim`])if(quarantineLockFile(file))count++;
  return{quarantined:count};
 }finally{if(cleanupFd!==undefined){closeSync(cleanupFd);unlinkSync(cleanup);}closeSync(fd);unlinkSync(mark);}
}
