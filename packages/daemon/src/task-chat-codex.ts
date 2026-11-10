/** Private bridge protocol; endpoint and credential come only from the registry. */
import { createConnection } from 'node:net';
import type { ChatSession } from './task-chat-registry.js';

export async function codexChatRequest(target:ChatSession, action:'validate'|'deliver', content?:string):Promise<boolean> {
 if(target.client!=='codex'||!target.codexBridge||!target.socketPath||!target.token)return false;
 return new Promise<boolean>((resolve,reject)=>{
  const socket=createConnection(target.socketPath!);let data='',settled=false;
  const finish=(error?:Error,ok=false)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(ok);};
  socket.setTimeout(2500,()=>finish(new Error('codex_chat_timeout')));
  socket.once('error',error=>finish(error));socket.once('close',()=>finish());
  socket.once('connect',()=>socket.write(JSON.stringify({token:target.token,generation:target.generation,sessionId:target.sessionId,action,...(content===undefined?{}:{content})})+'\n'));
  socket.on('data',chunk=>{
   data+=chunk.toString('utf8');if(data.length>4096){finish();return;}
   if(!data.includes('\n'))return;
   try {finish(undefined,JSON.parse(data.slice(0,data.indexOf('\n'))).ok===true);}catch{finish();}
  });
 });
}
