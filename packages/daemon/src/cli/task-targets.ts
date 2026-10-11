/** Owner-only offline registry changes; every edit stops execution and resets the declaration. */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { authenticateTask, requireTaskOwner, requireTaskDomains } from "../task-auth.js";
import { approvalRegistryPath, readApprovalRegistry, approvalRegistrySchema, taskTargetSchema } from "../task-approval-keys.js";
import { readTaskTarget, requireReversiblePayload } from "../task-actions.js";
import { atomicWrite, tasksPath, transactTaskStore } from "../task-store.js";
import { withPathLock } from "../path-lock.js";
import { ownerTaskAuthorization } from "./task-owner-access.js";
import { confirm } from "./prompt.js";
export async function registerOwnerTaskTarget(authorization: string, input: unknown) {
  const owner = await authenticateTask(authorization); requireTaskOwner(owner);
  const target = taskTargetSchema.parse(input); requireTaskDomains(owner,target.owner_domains);
  const root = await realpath(resolve(target.root)), absolute = resolve(root,target.path), path = relative(root,absolute);
  if (path.startsWith("..") || isAbsolute(path) || !path || await realpath(absolute) !== absolute) throw Object.assign(new Error("Target boundary invalid"),{code:"validation"});
  target.root=root; target.path=path;
  // Stop before changing the registry, even if an overlapping edit later fails.
  await transactTaskStore(tasksPath(),undefined,s=>{s.controls.execution_stopped=true;},"control");
  await withPathLock(approvalRegistryPath(),async ownership=>{
    const current=await authenticateTask(authorization); requireTaskOwner(current);requireTaskDomains(current,target.owner_domains);
    const registry=await readApprovalRegistry()??{schema_version:1 as const,revision:0,protected_boundary:false,keys:[],targets:[]};
    if(registry.targets.some(t=>t.id===target.id))throw Object.assign(new Error("Target already registered; no silent replacement"),{code:"conflict"});
    registry.targets.push(target);requireReversiblePayload((await readTaskTarget(registry,target.id)).payload);
    registry.protected_boundary=false;registry.revision++;
    await atomicWrite(approvalRegistryPath(),JSON.stringify(approvalRegistrySchema.parse(registry)),ownership);
  },{strictLocal:true});
  return {id:target.id,root:target.root,path:target.path,execution_stopped:true,protected_boundary:false};
}
export async function ownerTaskTargets(words:string[], options:Record<string,string|boolean>,json=false) {
  const authorization=await ownerTaskAuthorization(),principal=await authenticateTask(authorization);requireTaskOwner(principal);
  if(words[0]==="list") {
    const registry=await readApprovalRegistry(),targets=registry?.targets.filter(t=>t.owner_domains.every(d=>principal.domains.includes(d)))??[];
    process.stdout.write((json?JSON.stringify({targets}):targets.map(t=>`${t.id}: ${resolve(t.root,t.path)} · ${t.owner_domains.join(",")} · ${t.sensitivity}`).join("\n")||"Keine Ziele registriert.")+"\n");return;
  }
  if(words[0]!=="register"||!words[1]||!options.root||!options.path||!options.domain)throw Object.assign(new Error("Use targets register id --root directory --path file --domain personal"),{code:"validation"});
  process.stdout.write(`Lokales Ziel ${words[1]}: ${resolve(String(options.root),String(options.path))}; Domänen ${options.domain}. Adapter ersetzt genau diese UTF-8-Datei, kein Anbieter.\n`);
  if(!await confirm("Dieses vorhandene reversible lokale Ziel registrieren? Ausführung wird gestoppt, Grenzerklärung zurückgesetzt."))throw Object.assign(new Error("Owner declined target"),{code:"forbidden"});
  const result=await registerOwnerTaskTarget(authorization,{id:words[1],root:String(options.root),path:String(options.path),owner_domains:String(options.domain).split(","),sensitivity:String(options.sensitivity??"private"),adapter:"local-artifact-v1"});
  process.stdout.write((json?JSON.stringify(result):`Ziel ${result.id} registriert. Ausführung gestoppt; Grenze erneut erklären und alle Task-Prozesse neu starten. Jede Wirkung braucht neue exakte Owner-Signaturen.`)+"\n");
}
