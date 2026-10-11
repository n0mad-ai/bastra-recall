import {normalizedOwnerTarget} from "./task-target-safety.js";
/** Owner-only offline registry changes; every edit stops execution and resets the declaration. */
import { resolve } from "node:path";
import { authenticateTask, requireTaskOwner, requireTaskDomains } from "../task-auth.js";
import { approvalRegistryPath, readApprovalRegistry, approvalRegistrySchema } from "../task-approval-keys.js";
import { readTaskTarget, requireReversiblePayload } from "../task-actions.js";
import { atomicWrite, tasksPath, transactTaskStore } from "../task-store.js";
import { withPathLock } from "../path-lock.js";
import { ownerTaskAuthorization } from "./task-owner-access.js";
import { confirm } from "./prompt.js";
export async function registerOwnerTaskTarget(authorization: string, input: unknown, replace=false) {
  const owner = await authenticateTask(authorization); requireTaskOwner(owner);
  const normalized=await normalizedOwnerTarget(input),{outside_current_workdir:_warning,execution_warning:_execution,...target}=normalized; requireTaskDomains(owner,target.owner_domains);
  // Stop before changing the registry, even if an overlapping edit later fails.
  await transactTaskStore(tasksPath(),undefined,s=>{s.controls.execution_stopped=true;},"control");
  await withPathLock(approvalRegistryPath(),async ownership=>{
    const current=await authenticateTask(authorization); requireTaskOwner(current);requireTaskDomains(current,target.owner_domains);
    const registry=await readApprovalRegistry()??{schema_version:1 as const,revision:0,protected_boundary:false,keys:[],targets:[]};
    const previous=registry.targets.find(t=>t.id===target.id);
    if(previous){requireTaskDomains(current,previous.owner_domains);if(!replace)throw Object.assign(new Error("Target already registered; use update"),{code:"conflict"});}
    else if(replace)throw Object.assign(new Error("Target absent"),{code:"not_found"});
    const checked=await normalizedOwnerTarget(target); // recheck after confirmation under registry lock
    if(checked.root!==target.root||checked.path!==target.path)throw Object.assign(new Error("Target changed after confirmation"),{code:"validation",reason:"target_boundary"});
    registry.targets=registry.targets.filter(t=>t.id!==target.id);registry.targets.push(target);requireReversiblePayload((await readTaskTarget(registry,target.id)).payload);
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
  if(words[0]==="remove") {
    if(!words[1])throw Object.assign(new Error("Target ID required"),{code:"validation",reason:"targets_syntax"});
    const registry=await readApprovalRegistry(),target=registry?.targets.find(t=>t.id===words[1]);if(!target)throw Object.assign(new Error("Target absent"),{code:"not_found"});requireTaskDomains(principal,target.owner_domains);
    process.stdout.write(`Ziel ${target.id}: ${resolve(target.root,target.path)}; Domänen ${target.owner_domains.join(",")}.\n`);
    if(!await confirm("Ziel entfernen? Ausführung stoppen, Grenzerklärung zurücksetzen; alte Freigaben werden veraltet."))throw Object.assign(new Error("Owner declined removal"),{code:"forbidden",reason:"owner_declined"});
    await removeOwnerTaskTarget(authorization,target.id);
    process.stdout.write(json?JSON.stringify({removed:true,id:target.id})+"\n":"Ziel entfernt; Ausführung gestoppt, Grenze zurückgesetzt. Task-Prozesse neu starten.\n");return;
  }
  if(!["register","update"].includes(words[0])||!words[1]||!options.root||!options.path||!options.domain)throw Object.assign(new Error("Targets syntax required"),{code:"validation",reason:"targets_syntax"});
  const input={id:words[1],root:String(options.root),path:String(options.path),owner_domains:String(options.domain).split(","),sensitivity:String(options.sensitivity??"private"),adapter:"local-artifact-v1"};
  const normalized=await normalizedOwnerTarget(input);requireTaskDomains(principal,normalized.owner_domains);
  process.stdout.write(`Lokales Ziel ${words[1]}: ${resolve(normalized.root,normalized.path)}; aufgelöster Arbeitsordner ${normalized.root}; Domänen ${options.domain}. Adapter ersetzt genau diese UTF-8-Datei, kein Anbieter.\n`);
  if(normalized.execution_warning)process.stdout.write(normalized.execution_warning+"\n");
  if(normalized.outside_current_workdir)process.stdout.write("WARNUNG: Dieser gewählte Arbeitsordner liegt außerhalb des aktuellen Projektordners. Nur ausdrücklich freigegebene Arbeitsdateien verwenden; Konfiguration, Schlüssel und Vault sind gesperrt.\n");
  if(!await confirm(`Dieses lokale Ziel ${words[0]==="update"?"ändern":"registrieren"}? Ausführung wird gestoppt, Grenzerklärung zurückgesetzt.`))throw Object.assign(new Error("Owner declined target"),{code:"forbidden",reason:"owner_declined"});
  const result=await registerOwnerTaskTarget(authorization,input,words[0]==="update");
  process.stdout.write((json?JSON.stringify(result):`Ziel ${result.id} ${words[0]==="update"?"geändert":"registriert"}. Ausführung gestoppt; Grenze erneut erklären und alle Task-Prozesse neu starten. Jede Wirkung braucht neue exakte Owner-Signaturen.`)+"\n");
}
export async function removeOwnerTaskTarget(authorization:string,id:string){
 const owner=await authenticateTask(authorization);requireTaskOwner(owner);
 await transactTaskStore(tasksPath(),undefined,s=>{s.controls.execution_stopped=true;},"control");
 await withPathLock(approvalRegistryPath(),async ownership=>{const current=await authenticateTask(authorization);requireTaskOwner(current);const registry=await readApprovalRegistry(),target=registry?.targets.find(t=>t.id===id);if(!registry||!target)throw Object.assign(new Error("Target absent"),{code:"not_found"});requireTaskDomains(current,target.owner_domains);
 registry.targets=registry.targets.filter(t=>t.id!==id);registry.protected_boundary=false;registry.revision++;await atomicWrite(approvalRegistryPath(),JSON.stringify(approvalRegistrySchema.parse(registry)),ownership);
 },{strictLocal:true});return{removed:true,id};
}
