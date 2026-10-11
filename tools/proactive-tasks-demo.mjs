#!/usr/bin/env node
/** Interactive disposable demo. Must use the existing test-isolation preload. */
import {mkdtemp,mkdir,writeFile,realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
if(!process.env.BASTRA_TEST_RUN_ROOT||!process.stdin.isTTY||!process.stdout.isTTY){
 process.stderr.write("Demo nur im eigenen Terminal: node --import ./scripts/test-env.mjs tools/proactive-tasks-demo.mjs\n");process.exit(1);
}
const repo=fileURLToPath(new URL("../",import.meta.url)),root=await realpath(await mkdtemp(join(tmpdir(),"proactive-owner-demo-")));
await Promise.all(["data","work","owner","vault"].map(p=>mkdir(join(root,p),{mode:0o700})));
await writeFile(join(root,"work","artifact.txt"),"Vorher: synthetische Demo.\n",{mode:0o600});
const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=probe.address().port;await new Promise(r=>probe.close(r));if(port===6723)throw new Error("Demo refuses production port");
Object.assign(process.env,{BASTRA_TASKS_PATH:join(root,"data","tasks.json"),BASTRA_VAULT_PATH:join(root,"vault"),BASTRA_HTTP_PORT:String(port),BASTRA_DAEMON_URL:`http://127.0.0.1:${port}`,BASTRA_HTTP_URL:`http://127.0.0.1:${port}`,BASTRA_EMBEDDING_PROVIDER:"none",BASTRA_BM25_ONLY:"1",BASTRA_AUTO_UPDATE:"0",BASTRA_UPDATE_CHECK:"off",BASTRA_PENDING_RELAY:"0"});
const {mintTaskCredential}=await import("../packages/daemon/dist/task-auth.js"),{saveOwnerTaskAccess}=await import("../packages/daemon/dist/cli/task-owner-access.js");
const owner=await mintTaskCredential(join(root,"data","task-auth.json"),{actor_id:"demo-owner",role:"owner",domains:["personal"]});
await writeFile(join(root,"owner","task.token"),owner.token,{mode:0o600});await saveOwnerTaskAccess(`Bearer ${owner.token}`);
const quote=s=>`'${String(s).replaceAll("'","'\\''")}'`,rc=join(root,"demo-shell.rc");
await writeFile(rc,`task_demo_root=${quote(root)}\ntask_demo_node=${quote(process.execPath)}\ntask_demo_cli=${quote(join(repo,"packages/daemon/dist/cli.js"))}\nfunction bastra(){ "$task_demo_node" "$task_demo_cli" "$@"; }\nfunction demo-restart(){ kill -USR2 ${process.pid}; }\nHISTFILE=${quote(join(root,"demo-history"))}\nPS1='bastra-demo> '\n`,{mode:0o600});
let errors="",daemon,closed,restartQueue=Promise.resolve(),closing=false;
const stop=async()=>{if(daemon&&daemon.exitCode===null&&daemon.signalCode===null)daemon.kill("SIGTERM");await closed;};
const start=async()=>{errors="";daemon=spawn(process.execPath,[join(repo,"packages/daemon/dist/index.js")],{env:process.env,detached:true,stdio:["pipe","ignore","pipe"]});closed=once(daemon,"close");daemon.stderr.on("data",c=>{errors=(errors+c).slice(-2000);});};
const ready=async()=>{const until=Date.now()+15000;while(Date.now()<until){try{if((await fetch(process.env.BASTRA_DAEMON_URL+"/health")).ok)return;}catch{}await new Promise(r=>setTimeout(r,25));}throw new Error(errors||"Own demo daemon unavailable");};
const restart=()=>{if(!closing)restartQueue=restartQueue.then(async()=>{await stop();await start();await ready();process.stdout.write("Demo-Daemon wieder bereit; nur eigene Instanz neu gestartet.\n");}).catch(e=>{process.stderr.write(`Demo-Neustart fehlgeschlagen: ${e.message}\n`);});};
process.on("SIGUSR2",restart);await start();
try{
 await ready();
 process.stdout.write(`Nur Wegwerf-Daten, Port ${port}. Keine reale Owner-Anwesenheit oder OS-Grenze behauptet.\nIsolierter synthetischer Owner-Zugang ist vorbereitet; Signing bleibt interaktiv und getrennt.\nEigener Demo-Ordner: ${root}\nBefehle aus docs/design/proactive-tasks-demo.md in dieser Shell ausführen.\nFür versteckte Schlüssel-/Boundary-Abfrage den synthetischen Token aus $task_demo_root/owner/task.token lokal im Editor kopieren, nicht im Chat.\ndemo-restart startet nur diesen Daemon neu; auf „Demo-Daemon wieder bereit“ warten.\nexit beendet nur den eigenen Testdaemon; die bestehende Test-Isolation räumt ihre Wegwerf-Daten auf.\n`);
 const shell=spawn("/bin/bash",["--noprofile","--rcfile",rc,"-i"],{env:{...process.env,BASH_SILENCE_DEPRECATION_WARNING:"1"},stdio:"inherit"});const [code]=await once(shell,"exit");process.exitCode=code??1;
}finally{closing=true;process.off("SIGUSR2",restart);await restartQueue;await stop();}
