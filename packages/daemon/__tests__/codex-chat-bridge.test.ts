import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { createCodexChatBridge, resolveCodexBackendSocket, type CodexBridgeSession } from '../src/codex-chat-bridge.js';

async function fixture(t:TestContext) {
 const dir=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'cb-'));const server=createServer();const path=join(dir,'backend.sock');
 const backend=new WebSocketServer({server});server.listen(path);await once(server,'listening');
 let busy:string|undefined;const calls:string[]=[];let socket:WebSocket|undefined;
 backend.on('connection',s=>{socket=s;s.on('message',raw=>{const m=JSON.parse(String(raw));calls.push(m.method);if(m.id===undefined)return;
  let result:unknown={};
  if(m.method==='thread/start'||m.method==='thread/resume'||m.method==='thread/fork')result={thread:{id:m.params?.ephemeral?'thread-title':m.params?.threadId??'thread-a',ephemeral:m.params?.ephemeral===true}};
  if(m.method==='thread/loaded/list')result={data:['thread-a']};
  if(m.method==='thread/read')result={thread:{id:'thread-a',status:{type:busy?'active':'idle'},turns:busy?[{id:busy,status:'inProgress'}]:[]}};
  if(m.method==='turn/start'){busy='turn-'+calls.length;result={turn:{id:busy}};}
  if(m.method==='turn/steer'){assert.equal(m.params.expectedTurnId,busy);result={turnId:busy};}
  s.send(JSON.stringify({id:m.id,result}));
  if(m.method==='turn/start')s.send(JSON.stringify({method:'turn/started',params:{threadId:'thread-a',turn:{id:busy,status:'inProgress'}}}));
 });});
 const sessions:CodexBridgeSession[]=[];const closed:string[]=[];
 const bridge=await createCodexChatBridge({backendSocket:path,dir,onRegister:async s=>{sessions.push(s);},onClose:async(id,g)=>{closed.push(id+g);}}).catch(error=>{server.close();backend.close();throw error;});
 t.after(async()=>{await bridge.close();for(const s of backend.clients)s.terminate();await new Promise<void>(r=>backend.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));});
 const ui=new WebSocket(bridge.url,{headers:{Authorization:'Bearer '+bridge.token}});await once(ui,'open');
 const frameTypes:boolean[]=[];ui.on('message',(_raw,isBinary)=>frameTypes.push(isBinary));
 let id=0;const rpc=async(method:string,params:unknown={})=>{const next=++id;const p=new Promise<any>(r=>{const f=(raw:any)=>{const m=JSON.parse(String(raw));if(m.id===next){ui.off('message',f);r(m);}};ui.on('message',f);});ui.send(JSON.stringify({id:next,method,params}));return p;};
 await rpc('initialize',{});ui.send(JSON.stringify({method:'initialized'}));await rpc('thread/start',{ephemeral:false,threadSource:'user'});
 return {bridge,ui,rpc,sessions,closed,calls,frameTypes,socket:()=>socket!,complete:(text:string)=>{socket!.send(JSON.stringify({method:'item/completed',params:{threadId:'thread-a',turnId:busy,item:{type:'agentMessage',id:'visible-item',text}}}));socket!.send(JSON.stringify({method:'turn/completed',params:{threadId:'thread-a',turn:{id:busy,status:'completed'}}}));busy=undefined;}};
}
async function delivery(s:CodexBridgeSession,action:'validate'|'deliver',content?:string) {
 const c=createConnection(s.socketPath);const p=new Promise<any>((r,j)=>{let raw='';c.on('data',b=>{raw+=b;if(raw.includes('\n')){r(JSON.parse(raw));c.destroy();}});c.on('error',j);});
 c.on('connect',()=>c.end(JSON.stringify({token:s.token,generation:s.generation,sessionId:s.sessionId,action,content})+'\n'));return p;
}
const until=async(f:()=>boolean)=>{const end=Date.now()+2000;while(!f()){if(Date.now()>end)throw Error('condition timeout');await new Promise(r=>setTimeout(r,5));}};

test('Codex bridge registers only the actual UI thread; idle/busy dispatch and correlated visible journal receipt',async t=>{
 const f=await fixture(t);await until(()=>f.sessions.length===1);const s=f.sessions[0];
 assert.equal((await delivery(s,'validate')).ok,true);
 await f.rpc('turn/start',{threadId:'thread-a',turnTrigger:'user',clientUserMessageId:'f85462ae-ab64-40f7-9039-aa8297fb3203',input:[{type:'text',text:'typed'}]});f.complete('human response');
 await until(()=>f.calls.includes('turn/start'));
 await new Promise(r=>setTimeout(r,15));
 assert.equal((await delivery(s,'deliver','task-id-one')).ok,true);assert.equal(f.calls.at(-1),'turn/start');
 assert.equal((await delivery(s,'deliver','task-id-two')).ok,true);assert.equal(f.calls.at(-1),'turn/steer');
 f.complete('task-id-one task-id-two');await new Promise(r=>setTimeout(r,20));
 const events=(await readFile(s.transcriptPath,'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 assert.equal(events.filter(e=>e.origin?.kind==='human').length,1);
 assert.equal(events.filter(e=>e.origin?.kind==='peer').length,2);
 assert.equal(events.filter(e=>e.type==='assistant'&&e.message.content[0].text.includes('task-id-two')).length,2);
 assert.ok(events.filter(e=>e.type==='assistant'&&e.message.content[0].text.includes('task-id-two')).every(e=>events.some(p=>p.uuid===e.parentUuid&&p.origin.kind==='peer')));
});

test('Codex bridge rejects wrong generation/token and closed UI; resume rotates endpoint generation',async t=>{
 const f=await fixture(t);await until(()=>f.sessions.length===1);const old=f.sessions[0];
 assert.equal((await delivery({...old,token:'wrong'},'validate')).ok,false);
 assert.equal((await delivery({...old,generation:'wrong'},'deliver','no')).ok,false);
 await f.rpc('thread/resume',{threadId:'thread-a'});await until(()=>f.sessions.length===2);
 assert.notEqual(f.sessions[1].generation,old.generation);assert.equal((await delivery(old,'validate')).ok,false);
 f.ui.close();await until(()=>f.closed.length>=2);assert.equal((await delivery(f.sessions[1],'validate')).ok,false);
});

test('Codex bridge rejects unauthenticated, Origin and duplicate UI connections',async t=>{
 const f=await fixture(t);
 for(const headers of [{},{Authorization:'Bearer '+f.bridge.token,Origin:'http://evil.test'},{Authorization:'Bearer '+f.bridge.token}]){
  const s=new WebSocket(f.bridge.url,{headers});s.on('error',()=>{});const [code]=await once(s,'unexpected-response');assert.ok(code);s.terminate();
 }
});


test('Codex bridge tool/system traffic does not count as human and a disconnected backend fails validation',async t=>{
 const f=await fixture(t);await until(()=>f.sessions.length===1);const s=f.sessions[0];
 await f.rpc('thread/read',{threadId:'thread-a',includeTurns:true});
 f.socket().send(JSON.stringify({method:'item/completed',params:{threadId:'thread-a',turnId:'background',item:{type:'agentMessage',id:'unsolicited',text:'background'}}}));
 await f.rpc('turn/start',{threadId:'thread-a',input:[{type:'toolOutput',text:'tool data'}]});
 assert.equal((await readFile(s.transcriptPath,'utf8')).trim(),'');
 f.socket().terminate();await until(()=>f.closed.length===1);
 assert.equal((await delivery(s,'validate')).ok,false);
});


test('Codex bridge reconnect registers a fresh generation and never revives the old one',async t=>{
 const f=await fixture(t);await until(()=>f.sessions.length===1);const old=f.sessions[0];
 f.ui.close();await until(()=>f.closed.length===1);await new Promise(r=>setTimeout(r,10));
 const ui=new WebSocket(f.bridge.url,{headers:{Authorization:'Bearer '+f.bridge.token}});await once(ui,'open');
 const rpc=async(id:number,method:string,params:unknown)=>{const p=new Promise<any>(r=>{const fn=(raw:any)=>{const m=JSON.parse(String(raw));if(m.id===id){ui.off('message',fn);r(m);}};ui.on('message',fn);});ui.send(JSON.stringify({id,method,params}));return p;};
 await rpc(101,'initialize',{});ui.send(JSON.stringify({method:'initialized'}));
 await rpc(102,'thread/resume',{threadId:'thread-a'});await until(()=>f.sessions.length===2);
 const current=f.sessions[1];assert.equal(current.source,'resume');assert.notEqual(current.generation,old.generation);
 assert.equal((await delivery(old,'validate')).ok,false);assert.equal((await delivery(current,'validate')).ok,true);
 ui.close();
});


test('Codex owned backend alias resolves to its private canonical socket and rejects an unsafe target parent',async t=>{
 const root=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'cb-alias-'));
 const owned=join(root,'owned'),canonical=join(root,'canonical');await mkdir(owned,{mode:0o700});await mkdir(canonical,{mode:0o700});
 const path=join(canonical,'app.sock'),alias=join(owned,'requested.sock'),server=createServer();
 server.listen(path);await once(server,'listening');await chmod(path,0o600);
 t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 await symlink(path,alias);assert.equal(await resolveCodexBackendSocket(alias),path);
 await chmod(canonical,0o755);await assert.rejects(resolveCodexBackendSocket(alias),/unsafe_codex/);
});


test('Codex proxy preserves JSON text frame type for the real CLI initialize contract',async t=>{
 const f=await fixture(t);assert.ok(f.frameTypes.length>=2);assert.deepEqual(f.frameTypes,[false,false]);
});


test('Codex automatic title thread never replaces the open user chat or contributes human activity',async t=>{
 const f=await fixture(t);await until(()=>f.sessions.length===1);const user=f.sessions[0];
 await f.rpc('turn/start',{threadId:'thread-a',turnTrigger:'user',clientUserMessageId:'f85462ae-ab64-40f7-9039-aa8297fb3203',input:[{type:'text',text:'typed'}]});
 await f.rpc('thread/start',{ephemeral:true,threadSource:'thread_title'});
 await f.rpc('turn/start',{threadId:'thread-title',turnTrigger:null,clientUserMessageId:null,outputSchema:{title:'string'},input:[{type:'text',text:'synthetic title input'}]});
 assert.equal(f.sessions.length,1);assert.equal(f.closed.length,0);assert.equal((await delivery(user,'validate')).ok,true);
 const events=(await readFile(user.transcriptPath,'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 assert.equal(events.filter(e=>e.origin?.kind==='human').length,1);
});

test('Codex user thread input without native provenance is unknown and native steer counts as human',async t=>{
 const f=await fixture(t);await until(()=>f.sessions.length===1);const user=f.sessions[0];
 const started=await f.rpc('turn/start',{threadId:'thread-a',input:[{type:'text',text:'unknown source'}]});
 await f.rpc('turn/steer',{threadId:'thread-a',expectedTurnId:started.result.turn.id,clientUserMessageId:'483bf9cd-d955-40f7-946b-b10b0a678c52',input:[{type:'text',text:'typed while busy'}]});
 const events=(await readFile(user.transcriptPath,'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 assert.deepEqual(events.map(e=>e.origin?.kind),['unknown','human']);
});
