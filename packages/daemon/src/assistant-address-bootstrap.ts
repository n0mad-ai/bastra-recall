/** Self-contained socket bootstrap: stays outside version directories so missing
 * modules produce an HTTP error, rather than leaving a listening socket queued. */
import { createServer, type Server } from "node:http";
import { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const arg=(key:string)=>process.argv[process.argv.indexOf(key)+1];
if(process.argv.includes("--assistant-address-bootstrap")){
 const root=arg("--runtime-dir"),statePath=join(root,"current.json"),listening=process.env.BASTRA_ASSISTANT_ADDRESS_LISTEN==="1";
 let server:Server|undefined,observed:string|null=null;
 let retiring=false;
 const finish=()=>{
  if(retiring)return;retiring=true;
  server?.closeIdleConnections();
  if(listening&&server?.listening)server.close(()=>process.exit(0));
  // Let a request already forwarding an approved setup finish before retiring.
  const grace=setTimeout(()=>{server?.closeAllConnections();process.exit(0);},230000);grace.unref();
 };
 const monitor=()=>{const timer=setInterval(()=>{void readFile(statePath,"utf8").then(text=>{if(text!==observed)finish();},()=>{if(observed!==null)finish();});},250);timer.unref();};
 try{
  observed=await readFile(statePath,"utf8");const state=JSON.parse(observed);
  if(state.protocol!==2||!/^[a-f0-9]{64}$/.test(state.version)||!/^\d+$/.test(state.owner))throw Error("runtime protocol mismatch");
  const module=await import(pathToFileURL(join(root,"versions",state.version,"assistant-address-gateway.js")).href);
  if(module.ASSISTANT_SOCKET_PROTOCOL!==2||typeof module.startAssistantSocket!=="function")throw Error("runtime protocol mismatch");
  server=await module.startAssistantSocket({settingsPath:state.settingsPath,hostsPath:state.hostsPath,daemonUrl:state.daemonUrl,owner:state.owner,runtimeStatePath:statePath,runtimeVersion:state.version},listening);
  monitor();
 }catch{
  // Wait=false jobs arrive with an already accepted socket. Compatibility for
  // earlier Wait=true installs drains queued requests with a persistent error page.
  server=createServer((_req,res)=>{res.writeHead(503,{"Content-Type":"text/plain; charset=utf-8",Connection:"close","Cache-Control":"no-store"});res.end("Bastra-Adresse derzeit nicht verfügbar. Bitte bastra address setup --yes ausführen.\n");});
  if(listening){server.on("error",()=>{process.stderr.write("Bastra socket unavailable; run bastra address setup --yes\n");process.exitCode=1;});server.listen({fd:0});monitor();}
  else try{const socket=new Socket({fd:0,readable:true,writable:true});socket.setTimeout(5000,()=>socket.destroy());socket.on("error",()=>socket.destroy());socket.on("close",()=>process.exit(0));server.emit("connection",socket);socket.resume();}catch{process.exitCode=1;}
 }
}
