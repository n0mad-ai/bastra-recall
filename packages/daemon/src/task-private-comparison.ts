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
        try { const s=JSON.parse(await readFile(candidate,"utf8")); if (containsPrivateComparison(s))
          throw new TaskStoreError("corrupt","Private task comparison key missing; restore its private original");
        } catch(e) { if(e instanceof TaskStoreError)throw e;if((e as NodeJS.ErrnoException).code!=="ENOENT")throw new TaskStoreError("corrupt","Private comparison state unavailable"); }
      }
      key = randomBytes(32); await atomicWrite(keyPath,key.toString("hex"),ownership);
    }
    return prefix + createHmac("sha256",key).update(canonicalTaskValue(["bastra-task-comparison-v1",purpose,value])).digest("hex");
  }, { strictLocal: true });
}
function containsPrivateComparison(value: unknown): boolean {
  return isPrivateComparison(value) || !!value && typeof value === "object" && Object.values(value).some(containsPrivateComparison);
}
/** SHA is transient input only, so raw content and a client baseline digest agree. */
export async function privateContentComparison(path: string, value: string, digest = false): Promise<string> {
  if (digest && !/^[a-f0-9]{64}$/.test(value)) throw new TaskStoreError("corrupt", "Invalid content comparison baseline");
  return privateTaskComparison(path, "source-content", digest ? value : sha(value));
}
const privateFields = new Set(["reminder_fingerprint", "creation_hash", "creation_bindings", "expected_hash", "value_hash", "last_material_hash", "last_value_hash", "changed_value_hash", "new_body_hash"]);
/** Key legacy digests directly: equality survives even when the raw text was scrubbed. */
async function migrateContentComparisons(path: string, store: any): Promise<void> {
  for (const task of store.tasks ?? []) {
    if (task.schedule?.kind === "event") {
      const schedule = task.schedule;
      if (/^[a-f0-9]{64}$/.test(schedule.expected_hash ?? "")) {
        const old = schedule.expected_hash;
        schedule.expected_hash = await privateContentComparison(path, old, true);
        // The old cache binding contains the former public digest; discard it.
        delete task.verification;
      }
      if (/^[a-f0-9]{64}$/.test(schedule.expected) && privateBaseline(store,schedule)) schedule.expected = "Private content baseline";
    }
    if (/^[a-f0-9]{64}$/.test(task.decision_change?.new_body_hash ?? "")) task.decision_change.new_body_hash = await privateTaskComparison(path,"decision-body",task.decision_change.new_body_hash);
    if (/^[a-f0-9]{64}$/.test(task.last_material_hash ?? "")) task.last_material_hash = await privateContentComparison(path, task.last_material_hash, true);
  }
  for (const event of store.events ?? []) {
    if (/^[a-f0-9]{64}$/.test(event.value_hash ?? "")) event.value_hash = await privateContentComparison(path, event.value_hash, true);
    if (/^[a-f0-9]{64}$/.test(event.claim?.value_hash ?? "")) event.claim.value_hash = await privateContentComparison(path, event.claim.value_hash, true);
  }
  for (const source of store.sources ?? []) if (/^[a-f0-9]{64}$/.test(source.last_value_hash ?? "")) source.last_value_hash = await privateContentComparison(path, source.last_value_hash, true);
}
/** Legacy binding chains cannot become fresh authority. Preserve IDs/spending only. */
export function retireLegacyTaskProposals(store: any): void {
  const retired = new Set<string>();
  for (const proposal of store.proposals ?? []) {
    if (proposal.binding_version === 2 && proposal.status !== "stale") continue;
    const old = proposal.task_binding;
    proposal.status = "stale"; proposal.binding_version = 2; delete proposal.task_binding; retired.add(proposal.id);
    for (const task of store.tasks ?? []) if (old && task.verification?.binding_hash === old) delete task.verification;
  }
  for (const challenge of store.challenges ?? []) if (retired.has(challenge.proposal_id)) delete challenge.binding_hash;
  for (const approval of store.approvals ?? []) if (retired.has(approval.proposal_id)) { delete approval.binding_hash; delete approval.signature; }
}
function privateBaseline(store: any, schedule: any): boolean {
  return !store.sources?.some((source: any) => source.id === schedule.source_id && ["file", "git", "memory"].includes(source.kind));
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
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key])=>!privateFields.has(key)).map(([k,v])=>[k,publicTaskResult(v)])) as T;
  return value;
}
export function exportTaskComparisons(store: any): void {
  function strip(value: any): void {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) { if (privateFields.has(key)) delete value[key]; else strip(value[key]); }
  }
  // A supplied secret digest is not a display string. Versions remain displayable.
  for (const task of store.tasks ?? []) if (task.schedule?.kind === "event" && /^[a-f0-9]{64}$/.test(task.schedule.expected)
    && privateBaseline(store,task.schedule)) task.schedule.expected = "Private content baseline";
  retireLegacyTaskProposals(store);
  // Export stale IDs as tombstones, never the old reconstructible signing body.
  for (const proposal of store.proposals ?? []) if (proposal.status === "stale") {
    Object.assign(proposal,{task_revision:0,generation:0,recovery_epoch:"retired-private-binding",actor:"retired",created_at:0,
      target_hash:"0".repeat(64),payload:"",payload_hash:sha(""),registry_hash:"0".repeat(64),source_revisions:[]});
  }
  for (const task of store.tasks ?? []) delete task.verification;
  strip(store);
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
      await migrateContentComparisons(path, s);
      retireLegacyTaskProposals(s);
      for(const a of s.archives??[]) {const p=plan.find(p=>p.id===a.id);if(p){if(a.hash!==p.before&&a.hash!==p.after)throw new TaskStoreError("corrupt","Private archive index drift");a.hash=p.after;const changed=archiveChanges.find(c=>c.id===a.id);if(changed&&Object.keys(changed.bindings).length)a.creation_bindings=changed.bindings;}}
      const payload=JSON.stringify(s);if(payload!==raw)await atomicWrite(candidate,payload,ownership);
    }
    for(const a of archiveChanges)await atomicWrite(join(archiveDir,`${a.id}.json`),a.payload,ownership);
    if(plan.length)await unlink(marker);
    migrated.add(path);
  }, {strictLocal:true});
}
