/** Only synthetic fixture manipulation inside the verified disposable demo. */
import {readFile,writeFile,realpath} from "node:fs/promises";
import {homedir} from "node:os";
import {join,basename} from "node:path";
import {randomUUID,createHash} from "node:crypto";
const root=await realpath(process.env.BASTRA_DEMO_ROOT??"/missing-demo-root");
if(!basename(root).startsWith("proactive-owner-demo-")||!process.env.BASTRA_TEST_RUN_ROOT||await realpath(homedir())!==await realpath(join(process.env.BASTRA_TEST_RUN_ROOT,"home"))||process.env.BASTRA_TASKS_PATH!==join(root,"data","tasks.json")||process.env.BASTRA_VAULT_PATH!==join(root,"vault")||!process.stdin.isTTY)throw new Error("Nur in der isolierten Demo-Shell möglich");
const {memoryRevision}=await import("../packages/core/dist/index.js"),{ownerTaskAuthorization}=await import("../packages/daemon/dist/cli/task-owner-access.js"),{taskCliCall}=await import("../packages/daemon/dist/cli/tasks-cmd.js");
const authorization=await ownerTaskAuthorization(),base=process.env.BASTRA_DAEMON_URL;if(!base||new URL(base).hostname!=="127.0.0.1"||new URL(base).port==="6723")throw new Error("Own demo port required");
const call=(name,input={})=>taskCliCall(name,input,authorization,base),statePath=join(root,"data","demo-reconsideration.json"),decisionPath=join(root,"vault","demo-decision.md"),assumptionPath=join(root,"vault","demo-assumption.md");
const sha=s=>createHash("sha256").update(s).digest("hex");
if(process.argv[2]==="prepare"){
 const now=Date.now(),decision='---\nid: demo-decision\ntitle: Demo-Entscheidung\ntype: decision\nsummary: A wegen hoher Wartungskosten\nscope: demo\nsensitivity: private\n---\nOption A gewählt, weil die Wartungskosten hoch sind.\n',assumption='---\nid: demo-assumption\ntitle: Demo-Annahme\ntype: reference\nsummary: Wartungskosten hoch\nscope: demo\nsensitivity: private\n---\ncostly\n';
 await writeFile(decisionPath,decision);await writeFile(assumptionPath,assumption);const revision=memoryRevision(assumption),after=JSON.stringify({claim_id:"demo-assumption",claim_revision:revision,value:"cheap",state_updated_at:now,provenance:"attributable"}),before=after.replace('"cheap"','"costly"');await writeFile(join(root,"work","premise-evidence.json"),before);
 const suffix=randomUUID(),sourceId=`demo-change-${suffix}`,evidenceId=`demo-evidence-${suffix}`;
 const common={producer_actor:"demo-owner",owner_domains:["personal"],sensitivity:"private",max_age_ms:86400000,enabled:true};await call("source-register",{...common,id:sourceId,kind:"event"});await call("source-register",{...common,id:evidenceId,kind:"file",producer_actor:"task-source-reader",root:join(root,"work"),path:"premise-evidence.json"});
 const task=await call("create",{idempotency_key:suffix,original_request:"Erfundene Demo: A neu bewerten, wenn Wartung günstiger wird",goal:"Demo-Entscheidung neu bewerten",resolution_condition:"Owner wählt ausdrücklich",timezone:"Europe/Madrid",scope:{kind:"personal",name:"demo"},owner_domains:["personal"],arm:true,schedule:{kind:"event",source_id:sourceId,predicate:"premise",expected:"costly",verifier_id:"versioned-value-v1"},decision:{id:"demo-decision",revision:memoryRevision(decision),option:"A",reason:"Bisher hohe Wartungskosten",assumption_id:"demo-assumption",assumption_revision:revision,premise:"costly",alternatives:["B"]},evidence:[{source_id:evidenceId,id:"demo-evidence",revision:sha(after),hash:sha(after),observed_at:now,state_updated_at:now,max_age_ms:86400000,provenance:"attributable"}]});
 await writeFile(statePath,JSON.stringify({task_id:task.id,sourceId,evidenceId,revision,after,at:now,key:suffix}),{mode:0o600});process.stdout.write(`Erfundene Dateien vorbereitet, Aufgabe ${task.id} scharf. Noch keine neue Prämisse. Jetzt: demo-reconsider simulate, dann Browser aktualisieren/Karten anzeigen.\n`);
}else if(process.argv[2]==="simulate"){
 const state=JSON.parse(await readFile(statePath,"utf8"));await writeFile(join(root,"work","premise-evidence.json"),state.after);await call("event",{source_id:state.sourceId,source_revision:0,dedup_key:state.key,value:"Erfundene Wartungskosten jetzt günstiger",state_updated_at:state.at,claim:{claim_id:"demo-assumption",claim_revision:state.revision,value:"cheap",evidence_id:"demo-evidence",evidence_revision:sha(state.after)}});process.stdout.write("Nur Demo-Datei/Ereignis geändert: costly → cheap. Keine automatische Umkehr. Beim nächsten Kontakt erscheint Neubewertung mit Beibehalten/Ändern/Zurückstellen/Beenden.\n");
}else if(process.argv[2]==="check"){
 const state=JSON.parse(await readFile(statePath,"utf8"));const until=Date.now()+10000;let found;
 while(Date.now()<until){const data=await call("due");found=data.cards.find(c=>c.task_id===state.task_id&&c.reconsideration?.new_premise==="cheap");if(found)break;await new Promise(r=>setTimeout(r,100));}
 if(!found)throw new Error("Demo-Karte noch nicht vorhanden; Status/Quellenprüfung prüfen");
 process.stdout.write("Neubewertungskarte sichtbar im Standardbudget: costly → cheap; Owner-Wahlen vorhanden.\n");
}else throw new Error("Syntax: demo-reconsider prepare|simulate|check");
