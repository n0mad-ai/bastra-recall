/** Local structured snapshots. No polling adapter promises unobserved transitions. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import matter from "gray-matter";
import { canonicalTaskValue } from "./task-canonical.js";
import { boundedTaskRead } from "./task-freshness.js";
import { safeNode } from "./code-graph/validate.js";
import { CODE_FILE_TYPE } from "./code-graph/limits.js";
import type { TaskSource, TaskStore } from "./task-schema.js";
import type { TaskServiceContext } from "./task-service.js";
const exec = promisify(execFile);
const structured=(value:unknown)=>canonicalTaskValue(JSON.parse(JSON.stringify(value)));
export const LOCAL_TASK_STATE_COVERAGE = {
  project: "Current Git HEAD, branch and porcelain working-directory status; no remote operations",
  worktree: "Current local Git worktree registry, including branch, detached, locked and prunable state",
  "task-phase": "Current lifecycle state (or paused) of one task within the registered owner domains",
  symbol: "Exact code node metadata in a registered local Graphify graph; graph refresh required, no live-code claim",
  entity: "Exact own frontmatter field of one uniquely bound local memory; no natural-language extraction",
  document: "Frontmatter metadata of one uniquely bound type=doc memory; no original-file/OCR change claim",
} as const;
export function isLocalTaskState(kind: string): kind is keyof typeof LOCAL_TASK_STATE_COVERAGE {
  return Object.hasOwn(LOCAL_TASK_STATE_COVERAGE, kind);
}
export async function readLocalTaskState(ctx: TaskServiceContext, source: TaskSource, store: TaskStore, max: number, timeout: number): Promise<{value:string;bytes:number}> {
  let bytes=0;
  const count=(raw:string)=>{ bytes+=Buffer.byteLength(raw); if(bytes>max) throw Object.assign(new Error("source byte budget"),{code:"source_budget"}); return raw; };
  let value:string;
  if(source.kind==="task-phase") {
    const task=store.tasks.find(t=>t.id===source.task_id);
    if(!task || !task.owner_domains.every(d=>source.owner_domains.includes(d))) throw new Error("task domain denied");
    if((task.sensitivity!=="public" && source.sensitivity==="public") || (task.sensitivity==="restricted" && source.sensitivity!=="restricted")) throw new Error("task sensitivity drift");
    value=count(task.paused ? "paused" : task.state);
  } else if(source.kind==="entity" || source.kind==="document") {
    if(!ctx.memoryRead) throw new Error("memory reader unavailable");
    const memory=await ctx.memoryRead(source.memory_id!,{max_bytes:max,timeout_ms:timeout}); count(memory.raw);
    if(memory.id!==source.memory_id || (memory.sensitivity!=="public" && source.sensitivity==="public")
      || (memory.sensitivity==="restricted" && source.sensitivity!=="restricted")) throw new Error("memory sensitivity or identity drift");
    const metadata=matter(memory.raw).data;
    if(metadata.id!==source.memory_id) throw new Error("memory identity drift");
    if(source.kind==="document") {
      if(metadata.type!=="doc") throw new Error("document type drift");
      value=structured(metadata);
    } else {
      if(!Object.hasOwn(metadata,source.field!)) throw new Error("entity field unavailable");
      value=structured(metadata[source.field!]);
    }
  } else {
    const root=await realpath(source.root!); if(root!==source.root) throw new Error("registered root changed");
    if(source.kind==="symbol") {
      const path=resolve(root,source.path!), rel=relative(root,path);
      if(rel.startsWith("..") || isAbsolute(rel) || (await lstat(path)).isSymbolicLink() || await realpath(path)!==path) throw new Error("graph path containment");
      const graph=JSON.parse(count(await boundedTaskRead(path,max,true,true)));
      if(!Array.isArray(graph.nodes) || !Array.isArray(graph.links)) throw new Error("invalid graph");
      const matches=graph.nodes.filter((n:unknown)=>n && typeof n==="object" && (n as {id?:unknown}).id===source.symbol_id);
      if(matches.length>1) throw new Error("ambiguous symbol");
      const node=matches.length?safeNode(matches[0],CODE_FILE_TYPE):null;
      if(matches.length && !node) throw new Error("invalid symbol");
      value=canonicalTaskValue(node); // null is confirmed absence from this graph snapshot only.
    } else {
      const git=async(args:string[])=>count((await exec("git",["--no-optional-locks","-c","core.fsmonitor=false","-C",root,...args],{timeout,maxBuffer:Math.max(1,max-bytes),env:{...process.env,GIT_TERMINAL_PROMPT:"0"}})).stdout);
      value=source.kind==="worktree" ? canonicalTaskValue(await git(["worktree","list","--porcelain","-z"]))
        : canonicalTaskValue({head:(await git(["rev-parse","--verify","HEAD"])).trim(),status:await git(["status","--porcelain=v1","--branch","-z","--untracked-files=normal"])});
    }
  }
  if(Buffer.byteLength(value)>4096) throw Object.assign(new Error("source value budget"),{code:"source_budget"});
  return {value,bytes};
}
