import { TASK_MAX_BYTES,type TaskStore } from "./task-schema.js";
import { constants, readFileSync, statSync, renameSync, openSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticateTask, requireTaskOwner, requireTaskDomains } from "./task-auth.js";
import { recoverTaskStore, decodeTaskStore } from "./task-store.js";
import { pathLockFilePath, PathLockUnavailableError } from "./path-lock.js";
import type { TaskServiceContext } from "./task-service.js";
export const taskRecoverInput=z.strictObject({});
export async function recoverTasks(ctx:TaskServiceContext,authorization:string|undefined,raw:unknown){
 taskRecoverInput.parse(raw);const owner=await authenticateTask(authorization,ctx.authPath);requireTaskOwner(owner);
 const fd=await open(`${ctx.path}.backup`,constants.O_RDONLY|constants.O_NOFOLLOW);let backup:TaskStore;
 try{const info=await fd.stat();if(!info.isFile()||info.mode&0o077||info.size>TASK_MAX_BYTES)throw Object.assign(new Error("Unsafe backup"),{code:"invalid_backup"});const bytes=Buffer.alloc(TASK_MAX_BYTES+1),read=await fd.read(bytes,0,bytes.length,0);if(read.bytesRead>TASK_MAX_BYTES)throw Object.assign(new Error("Backup too large"),{code:"invalid_backup"});backup=decodeTaskStore(bytes.subarray(0,read.bytesRead).toString("utf8"));}finally{await fd.close();}
 requireTaskDomains(owner,[...new Set([...backup.tasks.flatMap(t=>t.owner_domains),...backup.proposals.flatMap(p=>p.required_domains),...backup.archives.flatMap(a=>a.owner_domains)])]);
 const recovered=await recoverTaskStore(ctx.path,owner.actor_id,async candidate=>{const current=await authenticateTask(authorization,ctx.authPath);requireTaskOwner(current);requireTaskDomains(current,[...new Set([...candidate.tasks.flatMap(t=>t.owner_domains),...candidate.proposals.flatMap(p=>p.required_domains),...candidate.archives.flatMap(a=>a.owner_domains)])]);});
 return {recovered:true,quarantined:recovered.quarantine!==null,tasks:recovered.store.tasks.length,recovery_epoch:recovered.store.recovery_epoch,unarmed:true,execution_stopped:true,changes_may_be_missing:recovered.changes_may_be_missing,recovered_archive_exports:recovered.recovered_archive_exports,original_readable:recovered.original_readable};
}
/** Explicit OFFLINE operator recovery. Never clears a known live local owner. */
export function quarantineOfflineTaskLock(path:string):{quarantined:number}{
 const lock=pathLockFilePath(path),mark=`${lock}.operator`;let fd:number;
 try{fd=openSync(mark,"wx",0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,host:hostname(),token:randomUUID()}));}catch{throw new PathLockUnavailableError();}
 let count=0;
 try{for(const file of [lock,`${lock}.reclaim`,`${lock}.reclaim.cleanup`]){
   let raw:string,info:ReturnType<typeof statSync>;try{info=statSync(file);raw=readFileSync(file,"utf8");}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}
   if(!info.isFile()||info.size>4096)throw new PathLockUnavailableError();
   let body:any;try{body=JSON.parse(raw);}catch{/* unknown needs explicit offline attestation */}
   if(body?.host===hostname()&&Number.isSafeInteger(body.pid)&&body.pid>0){try{process.kill(body.pid,0);throw new PathLockUnavailableError();}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw new PathLockUnavailableError();}}
   if(statSync(file).ino!==info.ino||readFileSync(file,"utf8")!==raw)throw new PathLockUnavailableError();
   renameSync(file,`${file}.quarantine-${randomUUID()}`);count++;
 }return{quarantined:count};}finally{closeSync(fd);unlinkSync(mark);}
}
