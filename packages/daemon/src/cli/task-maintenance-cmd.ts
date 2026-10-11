import { ownerTaskAuthorization } from "./task-owner-access.js";
import { recoverTasks,quarantineOfflineTaskLock } from "../task-maintenance.js";
import { archiveTasks,restoreTaskArchive } from "../task-archive.js";
import { tasksPath,readTaskStore } from "../task-store.js";
import { taskAuthPath } from "../task-auth.js";
import { confirm } from "./prompt.js";
export async function ownerTaskMaintenance(sub:string,words:string[],options:Record<string,string|boolean>,json=false){
 const authorization=await ownerTaskAuthorization(),ctx={path:tasksPath(),authPath:taskAuthPath()};let result:unknown;
 if(sub==="recover"){
   if(!await confirm("Backup wiederherstellen? Alle Aufgaben werden unscharf, Ausführung gestoppt; Original wird privat gesichert. Vorher alle Task-Prozesse stoppen."))throw Object.assign(new Error("Owner declined recovery"),{code:"forbidden",reason:"owner_declined"});
   if(options.lock){if(!await confirm("Auch unbekannte Sperre privat sichern? Ich bestätige ausdrücklich: ALLE Task-Prozesse sind beendet. Bekannte lebende lokale Besitzer werden trotzdem abgewiesen."))throw Object.assign(new Error("Owner declined lock recovery"),{code:"forbidden",reason:"owner_declined"});quarantineOfflineTaskLock(ctx.path);}
   result=await recoverTasks(ctx,authorization,{});
 }else if(sub==="archive-restore"){
   if(!options.archive&&!words[0])throw Object.assign(new Error("Archive ID required"),{code:"validation"});
   if(!await confirm("Archiv für lesbaren Verlauf/Rollback wieder aufnehmen? Bleibt unscharf, Ausführung gestoppt."))throw Object.assign(new Error("Owner declined restore"),{code:"forbidden",reason:"owner_declined"});result=await restoreTaskArchive(ctx,authorization,String(options.archive??words[0]));
 }else{
   const s=await readTaskStore(ctx.path),ids=words.length?words:String(options.id??"").split(",").filter(Boolean);
   if(!ids.length)throw Object.assign(new Error("Use archive task-id [task-id]"),{code:"validation"});
   if(!await confirm(`Abgeschlossene Aufgaben ${ids.join(", ")} privat archivieren? Offene Vorkommen/unklare Wirkungen bleiben aktiv; Idempotenz, History und verbrauchte Freigaben bleiben erhalten.`))throw Object.assign(new Error("Owner declined archive"),{code:"forbidden",reason:"owner_declined"});result=await archiveTasks(ctx,authorization,{task_ids:ids,expected_revision:s.revision,recovery_epoch:s.recovery_epoch});
 }
 process.stdout.write((json?JSON.stringify(result):sub==="recover"?`Älteres Backup wiederhergestellt, Original gesichert. Änderungen seit dem Backup können fehlen; archivierte Aufgaben können wieder aktiv im Verlauf stehen. ${(result as any).recovered_archive_exports} kalte Archiv-Exporte abgeglichen und indiziert. Alle Aufgaben unscharf, Ausführung gestoppt. Daemon neu starten; Original/Archive und Wirkungen prüfen, Owner muss neu prüfen.`:sub==="archive-restore"?"Archiv wieder aufgenommen. Historie und Quittungen erhalten; Ausführung gestoppt, keine Freigabe erneuert.":`Abgeschlossene Aufgaben archiviert; offene Arbeit unverändert. Archiv-ID ${(result as any).archive_id}. Verlauf/Rollback: bastra tasks archive-restore ${(result as any).archive_id}.`)+"\n");
}
