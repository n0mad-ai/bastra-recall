/** One owned CLI connection and its actual app server. The task channel is
 * separate from UI input, so task traffic can never renew human activity. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { appendFile, chmod, lstat, mkdtemp, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

export interface CodexBridgeSession {
 sessionId:string;generation:string;socketPath:string;token:string;transcriptPath:string;source?:'resume'|'fork';
}
export interface CodexBridgeOptions {
 backendSocket:string;dir:string;token?:string;
 onRegister:(session:CodexBridgeSession)=>Promise<void>;
 onClose:(sessionId:string,generation:string)=>Promise<void>;
}
interface RpcMessage {id?:string|number;method?:string;params?:Record<string,any>;result?:any;error?:unknown}
const MAX_FRAME=2*1024*1024;
const nativeMessageId=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const equal=(a:unknown,b:string)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function parse(raw:RawData|string):RpcMessage {return JSON.parse(String(raw)) as RpcMessage;}
async function privateDirectory(path:string):Promise<void> {
 const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid()))throw Error('unsafe_codex_bridge_directory');
}

/** Resolve only the endpoint newly created at our private requested pathname.
 * Codex may publish a symlink to its private hashed control socket. */
export async function resolveCodexBackendSocket(requested:string):Promise<string> {
 if(!isAbsolute(requested))throw Error('unsafe_codex_app_server');
 await privateDirectory(dirname(requested));
 const alias=await lstat(requested);
 if((!alias.isSocket()&&!alias.isSymbolicLink())||(process.getuid&&alias.uid!==process.getuid()))throw Error('unsafe_codex_app_server');
 const canonical=await realpath(requested);
 await privateDirectory(dirname(canonical));
 const target=await lstat(canonical),current=await lstat(requested);
 if(!target.isSocket()||target.isSymbolicLink()||(target.mode&0o077)!==0||(process.getuid&&target.uid!==process.getuid())||current.dev!==alias.dev||current.ino!==alias.ino)throw Error('unsafe_codex_app_server');
 return canonical;
}

export async function createCodexChatBridge(options:CodexBridgeOptions) {
 await privateDirectory(options.dir);
 const backendStat=await lstat(options.backendSocket);
 if(!backendStat.isSocket()||backendStat.isSymbolicLink()||(process.getuid&&backendStat.uid!==process.getuid()))throw Error('unsafe_codex_app_server');
 await privateDirectory(join(options.backendSocket,'..'));
 const token=options.token??randomBytes(32).toString('hex');
 const socketPath=join(options.dir,'delivery.sock');
 const http=createHttpServer((_req,res)=>{res.writeHead(404);res.end();});
 const proxy=new WebSocketServer({noServer:true,maxPayload:MAX_FRAME});
 const httpSockets=new Set<import('node:net').Socket>();
 http.on('connection',socket=>{httpSockets.add(socket);socket.on('close',()=>httpSockets.delete(socket));});
 let ui:WebSocket|undefined,upstream:WebSocket|undefined,session:CodexBridgeSession|undefined,activeTurn:string|undefined;
 let closed=false,occupied=false,processing=false,queue:Promise<void>=Promise.resolve();
 const cliPending=new Map<string|number,{method:string;params:Record<string,any>}>();
 const internal=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
 const peers=new Map<string,{uuid:string;content:string}[]>();
 const enqueue=(work:()=>Promise<void>)=>{queue=queue.then(work).catch(()=>{ui?.terminate();upstream?.terminate();});return queue;};
 async function journal(event:Record<string,unknown>) {
  if(!session)throw Error('codex_thread_closed');
  const h=await open(session.transcriptPath,'a',0o600);try{await h.writeFile(JSON.stringify({...event,timestamp:new Date().toISOString()})+'\n');await h.sync();}finally{await h.close();}
 }
 async function endSession() {
  const old=session;session=undefined;activeTurn=undefined;peers.clear();
  if(old)await options.onClose(old.sessionId,old.generation).catch(()=>undefined);
 }
 async function register(threadId:string,method:string) {
  await endSession();
  const generation=randomUUID(),transcriptPath=join(options.dir,generation+'.jsonl');
  await appendFile(transcriptPath,'',{flag:'wx',mode:0o600});
  session={sessionId:threadId,generation,socketPath,token,transcriptPath,
   ...(method==='thread/resume'?{source:'resume' as const}:method==='thread/fork'?{source:'fork' as const}:{})};
  await options.onRegister(session);
 }
 function call(method:string,params:Record<string,unknown>={}):Promise<any> {
  if(upstream?.readyState!==WebSocket.OPEN||ui?.readyState!==WebSocket.OPEN)return Promise.reject(Error('codex_ui_closed'));
  const id='bastra-'+randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{internal.delete(id);reject(Error('codex_rpc_timeout'));},2000);timer.unref();
   internal.set(id,{resolve,reject,timer});upstream!.send(JSON.stringify({id,method,params}));
  });
 }
 async function isLive(expected:CodexBridgeSession) {
  if(closed||!session||session.generation!==expected.generation||session.sessionId!==expected.sessionId||ui?.readyState!==WebSocket.OPEN||upstream?.readyState!==WebSocket.OPEN)return false;
  const stat=await lstat(options.backendSocket);
  if(stat.dev!==backendStat.dev||stat.ino!==backendStat.ino)return false;
  const loaded=await call('thread/loaded/list');
  return session===expected&&Array.isArray(loaded.data)&&loaded.data.includes(expected.sessionId);
 }
 http.on('upgrade',(req,socket,head)=>{
  if(closed||occupied||req.headers.origin||!equal(req.headers.authorization,'Bearer '+token)) {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  occupied=true;
  proxy.handleUpgrade(req,socket,head,ws=>proxy.emit('connection',ws));
 });
 proxy.on('connection',client=>{
  ui=client;const backend=new WebSocket('ws+unix://'+options.backendSocket+':/',{maxPayload:MAX_FRAME});upstream=backend;
  const waiting:string[]=[];let waitingBytes=0;
  const forward=(raw:string)=>{if(backend.readyState===WebSocket.OPEN)backend.send(raw);else {waitingBytes+=Buffer.byteLength(raw);if(waitingBytes>MAX_FRAME){client.terminate();return;}waiting.push(raw);}};
  backend.on('open',()=>{for(const raw of waiting)backend.send(raw);waiting.length=0;});
  client.on('message',raw=>{void enqueue(async()=>{
   const m=parse(raw);if(m.id!==undefined&&typeof m.method==='string'){
    if(cliPending.size>=1024)throw Error('codex_request_limit');
    cliPending.set(m.id,{method:m.method,params:m.params??{}});
    if((m.method==='turn/start'||m.method==='turn/steer')&&session&&m.params?.threadId===session.sessionId
      &&Array.isArray(m.params.input)&&m.params.input.some((v:any)=>v&&['text','image','localImage'].includes(v.type))) {
     // The CLI also generates title/model inputs. Only native user-turn
     // metadata proves human activity; absence remains an unknown barrier.
     const human=nativeMessageId(m.params.clientUserMessageId)&&(m.method==='turn/steer'||m.params.turnTrigger==='user');
     await journal({type:'user',uuid:randomUUID(),origin:{kind:human?'human':'unknown'},
      ...(human?{turnOrigin:'human',promptSource:'typed'}:{}),message:{content:[]}});
    }
    if(m.method==='thread/unsubscribe'&&m.params?.threadId===session?.sessionId)await endSession();
   }
   forward(String(raw));
  });});
  backend.on('message',raw=>{
   // RPC answers must resolve outside the journal queue: delivery can await
   // them while processing a task. They never reach the TUI as user input.
   let m:RpcMessage;try{m=parse(raw);}catch{client.terminate();return;}
   if(typeof m.id==='string'&&internal.has(m.id)){
    const pending=internal.get(m.id)!;clearTimeout(pending.timer);internal.delete(m.id);
    if(m.error)pending.reject(Error('codex_rpc_failed'));else pending.resolve(m.result);return;
   }
   void enqueue(async()=>{
    const request=m.id===undefined?undefined:cliPending.get(m.id);
    if(m.id!==undefined)cliPending.delete(m.id);
    // A CLI title request creates a separate ephemeral thread. It must not
    // replace the UI's user thread, its generation, or its human history.
    const userThread=request&&['thread/start','thread/resume','thread/fork'].includes(request.method)
     &&m.result?.thread?.ephemeral===false&&request.params.ephemeral!==true
     &&(request.method!=='thread/start'||request.params.threadSource==='user');
    if(userThread&&typeof m.result?.thread?.id==='string')await register(m.result.thread.id,request!.method);
    const params=m.params??{};
    if(params.threadId===session?.sessionId){
     if(m.method==='turn/started'&&typeof params.turn?.id==='string')activeTurn=params.turn.id;
     if(m.method==='turn/completed'){peers.delete(params.turn?.id);if(params.turn?.id===activeTurn)activeTurn=undefined;}
     if(m.method==='thread/closed'||m.method==='thread/archived')await endSession();
     if(m.method==='item/completed'&&params.item?.type==='agentMessage'&&typeof params.item.id==='string'&&typeof params.item.text==='string') {
      for(const peer of peers.get(params.turnId)??[])await journal({type:'assistant',uuid:params.item.id,parentUuid:peer.uuid,message:{content:[{type:'text',text:params.item.text}]}});
     }
    }
    // ws delivers text frames as Buffers too. Preserve JSON text on the wire;
    // the official CLI expects JSON text responses.
    if(client.readyState===WebSocket.OPEN)client.send(String(raw));
   });
  });
  let disconnected=false;
  const disconnect=()=>{
   if(disconnected)return;disconnected=true;client.terminate();backend.terminate();
   for(const p of internal.values()){clearTimeout(p.timer);p.reject(Error('codex_ui_closed'));}internal.clear();
   void enqueue(async()=>{await endSession();cliPending.clear();occupied=false;});
  };
  client.on('close',disconnect);backend.on('close',disconnect);
  client.on('error',()=>client.terminate());backend.on('error',()=>backend.terminate());
 });
 const delivery=createNetServer({allowHalfOpen:true},socket=>{
  let raw='',handled=false;socket.setTimeout(2500,()=>socket.destroy());socket.on('error',()=>{});
  socket.on('data',b=>{
   if(handled)return;raw+=b.toString('utf8');if(Buffer.byteLength(raw)>16384){socket.destroy();return;}if(!raw.includes('\n'))return;handled=true;
   queue=queue.then(async()=>{
    let ok=false;
    try {
     const input=JSON.parse(raw.slice(0,raw.indexOf('\n')));
     const expected=session;
     if(!processing&&expected&&equal(input.token,token)&&input.generation===expected.generation&&input.sessionId===expected.sessionId&&['validate','deliver'].includes(input.action)){
      processing=true;
      try {
       if(await isLive(expected)){
        if(input.action==='validate')ok=true;
        else if(typeof input.content==='string'&&Buffer.byteLength(input.content)<=8192){
         const thread=await call('thread/read',{threadId:expected.sessionId,includeTurns:true});
         const turns=thread.thread?.turns;
         const running=Array.isArray(turns)?turns.filter((v:any)=>v.status==='inProgress'):[];
         const status=thread.thread?.status?.type;
         const turnId=running[0]?.id??activeTurn;
         if(session===expected&&(status==='idle'||status==='active')&&(status!=='active'||typeof turnId==='string')){
          const method=status==='active'?'turn/steer':'turn/start';
          const result=await call(method,{threadId:expected.sessionId,...(method==='turn/steer'?{expectedTurnId:turnId}:{}),input:[{type:'text',text:input.content}]});
          const accepted=method==='turn/steer'?result.turnId:result.turn?.id;
          if(typeof accepted==='string'){
           const peer={uuid:randomUUID(),content:input.content};
           const entries=peers.get(accepted)??[];entries.push(peer);peers.set(accepted,entries);
           await journal({type:'user',uuid:peer.uuid,origin:{kind:'peer'},message:{content:input.content}});ok=true;
          }
         }
        }
       }
      }finally{processing=false;}
     }
    }catch{/* A race/unknown outcome must never be replayed. */}
    socket.end(JSON.stringify({ok})+'\n');
   }).catch(()=>{socket.destroy();});
  });
 });
 try {
  await new Promise<void>((resolve,reject)=>{delivery.once('error',reject);delivery.listen(socketPath,resolve);});await chmod(socketPath,0o600);
  await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve);});
 }catch(error){delivery.close();http.close();throw error;}
 const address=http.address();if(!address||typeof address==='string')throw Error('codex_proxy_address');
 return {url:'ws://127.0.0.1:'+address.port,token,socketPath,async close(){
  if(closed)return;closed=true;ui?.terminate();upstream?.terminate();await queue;await endSession();
  for(const p of internal.values()){clearTimeout(p.timer);p.reject(Error('codex_bridge_closed'));}internal.clear();
  for(const s of proxy.clients)s.terminate();for(const s of httpSockets)s.destroy();
  await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>http.close(()=>r())),new Promise<void>(r=>delivery.close(()=>r()))]);
 }};
}

/** No Codex configuration edits. This invocation owns the backend and UI. */
export async function startCodexChatBridge(options:{binary:string;args:string[];onRegister:CodexBridgeOptions['onRegister'];onClose:CodexBridgeOptions['onClose'];env?:NodeJS.ProcessEnv}):Promise<number> {
 if(process.platform==='win32')throw Error('Codex active-chat bridge currently requires Unix sockets');
 if(options.args.some(a=>a==='--remote'||a.startsWith('--remote=')||a==='--remote-auth-token-env'||a.startsWith('--remote-auth-token-env=')))throw Error('The Recall launcher owns its remote endpoint');
 const dir=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'bastra-codex-'));await chmod(dir,0o700);
 const backendSocket=join(dir,'app.sock');
 const token=randomBytes(32).toString('hex');
 const childEnv={...(options.env??process.env),BASTRA_CODEX_CHAT_TOKEN:token,BASTRA_CODEX_CHAT_BRIDGE:'1'};
 const backend=spawn(options.binary,['app-server','--listen','unix://'+backendSocket],{env:childEnv,stdio:['ignore','ignore','inherit']});
 let backendError:Error|undefined;backend.on('error',e=>{backendError=e;});
 let bridge:Awaited<ReturnType<typeof createCodexChatBridge>>|undefined;
 let cli:ReturnType<typeof spawn>|undefined;
 let canonicalSocket:string|undefined;
 const stop=()=>{cli?.kill('SIGTERM');backend.kill('SIGTERM');};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try {
  const deadline=Date.now()+10000;
  while(true){
   if(backendError)throw backendError;
   if(backend.exitCode!==null||backend.signalCode!==null)throw Error('Codex app server exited');
   try{canonicalSocket=await resolveCodexBackendSocket(backendSocket);break;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(Date.now()>deadline)throw Error('Codex app server startup timed out');
   await new Promise(r=>setTimeout(r,25));
  }
  bridge=await createCodexChatBridge({backendSocket:canonicalSocket,dir,token,onRegister:options.onRegister,onClose:options.onClose});
  cli=spawn(options.binary,['--remote',bridge.url,'--remote-auth-token-env','BASTRA_CODEX_CHAT_TOKEN',...options.args],{stdio:'inherit',env:childEnv});
  return await new Promise<number>((resolve,reject)=>{cli!.once('error',reject);cli!.once('exit',(code)=>resolve(code??1));backend.once('exit',()=>cli?.kill('SIGTERM'));});
 }finally{process.off('SIGTERM',stop);process.off('SIGINT',stop);stop();await bridge?.close();await Promise.all([reapCodexChild(backend),...(cli?[reapCodexChild(cli)]:[])]);}
}

async function reapCodexChild(child:ReturnType<typeof spawn>):Promise<void>{
 if(child.exitCode!==null||child.signalCode!==null||!child.pid)return;
 await new Promise<void>(resolve=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},1500);
  child.once('exit',()=>{clearTimeout(timer);resolve();});
 });
}
