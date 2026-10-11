/** Private per-store comparison material. Never part of a task export or transport. */
import { constants } from "node:fs";
import { open, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { withPathLock } from "./path-lock.js";
import { atomicWrite, TaskStoreError, decodeTaskStore } from "./task-store.js";
import { canonicalTaskValue } from "./task-canonical.js";
const prefix = "hmac-v1:";
export const privateComparisonPath = (path: string) => `${path}.comparison-key`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const isPrivateComparison = (value: unknown): value is string => typeof value === "string" && /^hmac-v1:[a-f0-9]{64}$/.test(value);
export async function privateTaskComparison(path: string, purpose: string, value: unknown): Promise<string> {
  const keyPath = privateComparisonPath(path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withPathLock(keyPath, async ownership => {
    let key: Buffer;
    try {
      const fd = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const info = await fd.stat(); if (!info.isFile() || info.mode & 0o077 || info.size !== 64 || (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe key");
        const raw = await fd.readFile("utf8"); if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error("invalid key"); key = Buffer.from(raw,"hex");
      } finally { await fd.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new TaskStoreError("corrupt", "Private task comparison key unavailable; original preserved");
      // A lost key must not silently replace the identity of existing comparisons.
      for (const candidate of [path,`${path}.backup`]) {
        try { const s=JSON.parse(await readFile(candidate,"utf8")); if (s.tasks?.some((t:any)=>isPrivateComparison(t.reminder_fingerprint)||isPrivateComparison(t.creation_hash)) || s.archives?.some((a:any)=>Object.values(a.creation_bindings??{}).some(isPrivateComparison)))
          throw new TaskStoreError("corrupt","Private task comparison key missing; restore its private original");
        } catch(e) { if(e instanceof TaskStoreError)throw e;if((e as NodeJS.ErrnoException).code!=="ENOENT")throw new TaskStoreError("corrupt","Private comparison state unavailable"); }
      }
      key = randomBytes(32); await atomicWrite(keyPath,key.toString("hex"),ownership);
    }
    return prefix + createHmac("sha256",key).update(canonicalTaskValue(["bastra-task-comparison-v1",purpose,value])).digest("hex");
  }, { strictLocal: true });
}
/** Drop unsafe legacy verifiers; raw secrets cannot be recovered for migration. */
export function dropLegacyTaskComparisons(store: any): void {
  for (const t of store.tasks ?? []) {
    if (typeof t.reminder_fingerprint === "string" && /^[a-f0-9]{64}$/.test(t.reminder_fingerprint)) delete t.reminder_fingerprint;
    if (typeof t.creation_hash === "string" && /^[a-f0-9]{64}$/.test(t.creation_hash)) delete t.creation_hash;
  }
}
export function publicTaskResult<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicTaskResult) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key])=>!["reminder_fingerprint","creation_hash","creation_bindings"].includes(key)).map(([k,v])=>[k,publicTaskResult(v)])) as T;
  return value;
}
export function exportTaskComparisons(store: any): void {
  for (const t of store.tasks ?? []) { delete t.reminder_fingerprint; delete t.creation_hash; }
  for (const a of store.archives ?? []) delete a.creation_bindings;
}
const migrated = new Set<string>();
/** Existing store lock, resumable archive/index cleanup; no task/authority changes. */
export async function migrateTaskComparisons(path: string): Promise<void> {
  if (migrated.has(path)) return;
  const marker = `${path}.comparison-migration`, archiveDir = join(dirname(path),"task-archives");
  let main: string | undefined, backup: string | undefined;
  try { main=await readFile(path,"utf8"); } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e; }
  try { backup=await readFile(`${path}.backup`,"utf8"); } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e; }
  // Missing stores are the pre-feature state. No new directory/write in idle reads.
  if(main===undefined&&backup===undefined)return;
  await withPathLock(path, async ownership => {
    const plan: Array<{id:string;before:string;after:string}> = [];
    try { const saved=JSON.parse(await readFile(marker,"utf8")); if(!Array.isArray(saved)||saved.length>1000||saved.some(p=>!/^[-a-f0-9]{36}$/.test(p.id)||!/^([a-f0-9]{64})$/.test(p.before)||!/^([a-f0-9]{64})$/.test(p.after)))throw new Error();plan.push(...saved); }
    catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT")throw new TaskStoreError("corrupt","Private comparison migration cannot resume safely"); }
    let names:string[]=[];try{names=await readdir(archiveDir);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    if(names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).length>1000)throw new TaskStoreError("capacity","Private archive migration budget exceeded");
    const archiveChanges:Array<{id:string;payload:string;bindings:Record<string,string>}> = [];
    for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))) {
      const id=name.slice(0,-5),file=join(archiveDir,name),fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:string;
      try{const info=await fd.stat();if(!info.isFile()||info.mode&0o077||info.size>4195328)throw new Error();raw=await fd.readFile("utf8");}finally{await fd.close();}
      const b=JSON.parse(raw);if(b.schema_version!==1||b.id!==id||!b.snapshot?.tasks)throw new TaskStoreError("corrupt","Private archive migration invalid");
      decodeTaskStore(JSON.stringify(b.snapshot));
      const bindings:Record<string,string>={};for(const t of b.snapshot.tasks)if(isPrivateComparison(t.creation_hash))bindings[t.id]=t.creation_hash;
      const original=sha(raw);const pending=plan.find(p=>p.id===id);if(pending&&original!==pending.before&&original!==pending.after)throw new TaskStoreError("corrupt","Private archive changed during migration");
      exportTaskComparisons(b.snapshot);const payload=JSON.stringify(b),after=sha(payload);
      if(raw!==payload){if(!pending)plan.push({id,before:original,after});else if(after!==pending.after)throw new TaskStoreError("corrupt","Private archive migration differs");archiveChanges.push({id,payload,bindings});}
    }
    if(plan.length)await atomicWrite(marker,JSON.stringify(plan),ownership);
    // Save the private create bindings into live indices before removing them from exports.
    for(const candidate of [path,`${path}.backup`]) {
      let raw:string;try{raw=await readFile(candidate,"utf8");}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}
      let s:any;try{decodeTaskStore(raw);s=JSON.parse(raw);}catch{continue;}if(!Array.isArray(s.tasks))continue;
      dropLegacyTaskComparisons(s);
      for(const a of s.archives??[]) {const p=plan.find(p=>p.id===a.id);if(p){if(a.hash!==p.before&&a.hash!==p.after)throw new TaskStoreError("corrupt","Private archive index drift");a.hash=p.after;const changed=archiveChanges.find(c=>c.id===a.id);if(changed&&Object.keys(changed.bindings).length)a.creation_bindings=changed.bindings;}}
      const payload=JSON.stringify(s);if(payload!==raw)await atomicWrite(candidate,payload,ownership);
    }
    for(const a of archiveChanges)await atomicWrite(join(archiveDir,`${a.id}.json`),a.payload,ownership);
    if(plan.length)await unlink(marker);
    migrated.add(path);
  }, {strictLocal:true});
}
