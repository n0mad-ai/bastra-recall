import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {renderAssistantSocketPair,makeAddressAdminScript} from '../src/assistant-address-admin.js';

test('#1335: two Wait=true jobs admit at most one process each before any launcher executes',()=>{
 const pair=renderAssistantSocketPair({uid:'501',username:'fixture',home:'/fixture',launcher:'/fixture/launch.sh'});
 assert.equal(pair.length,2);
 for(const [i,xml] of pair.entries()){
  assert.match(xml,/<key>Wait<\/key><true\/>/);
  assert.equal((xml.match(/<key>SockNodeName<\/key>/g)??[]).length,1);
  assert.match(xml,/<key>BASTRA_ASSISTANT_ADDRESS_LISTEN<\/key><string>1<\/string>/);
  assert.match(xml,i===0?/<string>127\.0\.0\.1<\/string>/:/<string>::1<\/string>/);
 }
 assert.match(pair[1],/ai\.n0mad\.bastra-recall\.address\.501\.ipv6/);
});

test('#1335: a failed companion upgrade restores both previous jobs before hosts change',async t=>{
 const root=await mkdtemp(join(tmpdir(),'assistant-bound-admin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const helper=join(root,'helper'),companion=join(root,'ipv6'),hosts=join(root,'hosts'),ctl=join(root,'ctl'),calls=join(root,'calls');
 await writeFile(helper,'old-v4');await writeFile(companion,'old-v6');await writeFile(hosts,'old-hosts');
 await writeFile(ctl,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n[ "$1" = print ] && exit 0\nif [ "$1" = bootstrap ] && [ "$3" = '${companion}' ] && [ "$(cat '${companion}')" = new-v6 ]; then exit 1; fi\nexit 0\n`,{mode:0o755});
 const plan={hostsPath:hosts,hostsBefore:'old-hosts',hostsAfter:'new-hosts',helperPath:helper,helperBefore:'old-v4',helperAfter:'new-v4',label:'fixture',launchctl:ctl,rootOwnership:false,
  companion:{path:companion,before:'old-v6',after:'new-v6',label:'fixture.ipv6'}};
 const script=makeAddressAdminScript(plan);
 assert.throws(()=>execFileSync('/bin/sh',['-c',script],{stdio:'pipe'}));
 assert.equal(await readFile(hosts,'utf8'),'old-hosts');assert.equal(await readFile(helper,'utf8'),'old-v4');assert.equal(await readFile(companion,'utf8'),'old-v6');
 const log=await readFile(calls,'utf8');assert.match(log,/bootstrap system/);
});

import {mkdir} from 'node:fs/promises';
import {createServer as netServer,connect} from 'node:net';
import {createServer,request,Server,IncomingMessage,ServerResponse} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import ts from 'typescript';
import {ensureAssistantAddressRuntime} from '../src/assistant-address.js';

async function runtime(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'assistant-bound-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source');await mkdir(source);
 for(const name of ['assistant-address-bootstrap','assistant-address-gateway','assistant-address-name','assistant-address-files','http-auth']){
  const text=await readFile(new URL(`../src/${name}.ts`,import.meta.url),'utf8');await writeFile(join(source,name+'.js'),ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
 }
 const o={runtimeDir:join(root,'runtime'),runtimeSourceDir:source,runtimeNode:process.execPath,home:root,uid:String(process.getuid?.()??501),username:'fixture',settingsPath:join(root,'settings'),hostsPath:join(root,'hosts'),helperPath:join(root,'helper'),daemonUrl:'http://127.0.0.1:9'};
 await writeFile(o.settingsPath,JSON.stringify({ui:{enabled:true},assistant:{name:'jarvis'}}));await writeFile(o.hostsPath,'');return o;
}
async function call(port:number,host:string){return new Promise<number>((resolve,reject)=>{const q=request({host,port,path:'/ui/',headers:{Host:`jarvis.localhost:${port}`,Connection:'close'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode!));});q.on('error',reject);q.setTimeout(8000,()=>q.destroy(Error('fixture timeout')));q.end();});}

test('#1335: both inherited listeners use two real processes for 24 connections, overload and retirement',async t=>{
 const o=await runtime(t);let entered=0;const releases:Array<()=>void>=[];
 const backend=createServer((_q,r)=>{entered++;releases.push(()=>r.end('fixture-ui'));});await new Promise<void>(r=>backend.listen(0,'127.0.0.1',r));
 t.after(()=>{releases.splice(0).forEach(r=>r());backend.closeAllConnections();return new Promise<void>(r=>backend.close(()=>r()));});
 await ensureAssistantAddressRuntime({...o,daemonUrl:`http://127.0.0.1:${(backend.address()as any).port}`});
 const listeners=[netServer(),netServer()];await new Promise<void>(r=>listeners[0].listen(0,'127.0.0.1',r));const port=(listeners[0].address()as any).port;
 await new Promise<void>(r=>listeners[1].listen(port,'::1',r));
 const children=listeners.map(server=>spawn('/bin/sh',[join(o.runtimeDir,'launch.sh')],{stdio:[(server as any)._handle.fd,'ignore','pipe'],env:{...process.env,BASTRA_ASSISTANT_ADDRESS_LISTEN:'1',BASTRA_ASSISTANT_ADDRESS_PROTOCOL:'2'}}));
 t.after(async()=>{const exits=children.filter(c=>c.exitCode===null&&c.signalCode===null).map(c=>once(c,'exit'));for(const c of children)try{c.kill('SIGKILL');}catch{}await Promise.all(exits);});
 // Adversarial scheduling: pause the actual launchers before Node admission.
 children.forEach(c=>c.kill('SIGSTOP'));
 const rows=execFileSync('/bin/ps',['-ww','-p',children.map(c=>c.pid).join(','),'-o','pid=','-o','stat=','-o','args='],{encoding:'utf8'}).trim().split('\n');
 assert.equal(rows.length,2);assert.ok(rows.every(r=>/\sT\S*\s/.test(r)),rows.join('\n'));
 const results:number[]=[],pending=Array.from({length:24},(_,i)=>call(port,i%2?'::1':'127.0.0.1').then(code=>{results.push(code);return code;}));
 // Persistent jobs do not launch per connection; both listening descriptors stay reserved.
 children.forEach(c=>c.kill('SIGCONT'));await Promise.all(listeners.map(server=>new Promise<void>(r=>server.close(()=>r()))));
 for(const until=Date.now()+6000;Date.now()<until&&entered+results.length<24;)await new Promise(r=>setTimeout(r,20));
 assert.equal(entered,16);assert.equal(results.filter(c=>c===503).length,8);
 const processes=execFileSync('/bin/ps',['-ww','-p',children.map(c=>c.pid).join(','),'-o','args='],{encoding:'utf8'}).trim().split('\n');
 assert.equal(processes.length,2);assert.ok(processes.every(row=>row.startsWith(process.execPath+' ')),processes.join('\n'));
 releases.splice(0).forEach(r=>r());assert.equal((await Promise.all(pending)).filter(c=>c===200).length,16);
 const exits=children.map(c=>once(c,'exit'));await ensureAssistantAddressRuntime({...o,daemonUrl:'http://127.0.0.1:9'});
 await Promise.race([Promise.all(exits),new Promise((_,reject)=>setTimeout(()=>reject(Error('persistent jobs did not retire')),3000).unref())]);
 assert.ok(children.every(c=>c.exitCode===0),'a launchd job can restart only after its previous process exits');
});

test('#1335: confirmed legacy upgrade and removal carry both owned jobs through the lifecycle',async t=>{
 const o=await runtime(t),{setupAssistantAddress,removeAssistantAddress,assistantAddressStatus}=await import('../src/assistant-address.js');
 const {renderAssistantSocketPlist}=await import('../src/assistant-address-admin.js');
 const original=renderAssistantSocketPlist({uid:o.uid,username:o.username,home:o.home,launcher:join(o.runtimeDir,'launch.sh')});await writeFile(o.helperPath,original);
 // No live domain is consulted: fixture IO applies precisely the approved plan.
 const plans:any[]=[];let loaded=true;
 const options={...o,platform:'darwin' as const,systemConsent:true,machineNames:['fixture-host'],gatewayPort:9,runtimeProcesses:async()=>[],firefoxRunning:async()=>false,helperLoaded:async()=>loaded,runAdmin:async(p:any)=>{
  plans.push(p);await writeFile(p.hostsPath,p.hostsAfter);
  if(p.helperAfter===null)await rm(p.helperPath,{force:true});else await writeFile(p.helperPath,p.helperAfter);
  if(p.companion){if(p.companion.after===null)await rm(p.companion.path,{force:true});else await writeFile(p.companion.path,p.companion.after);}
  loaded=p.helperAfter!==null;
 }};
 await setupAssistantAddress({...options,name:'jarvis'});
 assert.equal(plans.length,1);assert.equal(plans[0].helperBefore,original);assert.equal(plans[0].companion.before,null);
 assert.equal((await assistantAddressStatus(options)).processBound,true);
 await removeAssistantAddress(options);assert.equal(plans.length,2);assert.equal(plans[1].companion.after,null);
 await assert.rejects(readFile(o.helperPath),{code:'ENOENT'});await assert.rejects(readFile(o.helperPath+'.ipv6.plist'),{code:'ENOENT'});
 // The preceding release can reinstall its old primary after current removal,
 // without a leftover IPv6 job retaining the second socket.
 await writeFile(o.helperPath,original);assert.equal(await readFile(o.helperPath,'utf8'),original);
});


test('#1335 CI: an overloaded socket cannot forward a request already parsed before close',async t=>{
 const o=await runtime(t);let forwarded=0,forwardAttempts=0;
 const backend=createServer((_q,r)=>{forwarded++;r.end('must-not-forward');});
 await new Promise<void>(r=>backend.listen(0,'127.0.0.1',r));
 t.after(()=>{backend.closeAllConnections();return new Promise<void>(r=>backend.close(()=>r()));});
 const {startAssistantSocket}=await import('../src/assistant-address-gateway.js');
 // The production inherited-listener branch is exercised on an isolated port,
 // without replacing this test process's stdin or consulting launchd.
 const originalListen=Server.prototype.listen;
 t.mock.method(Server.prototype,'listen',function(this:Server,...args:any[]){
  return args[0]?.fd===0?(originalListen as any).call(this,0,'127.0.0.1',args[1]):(originalListen as any).apply(this,args);
 });
 const server=await startAssistantSocket({...o,daemonUrl:`http://127.0.0.1:${(backend.address()as any).port}`},true);
 t.mock.restoreAll();
 t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
 const port=(server.address()as any).port;let connected=0,parsed=false;
 server.on('connection',socket=>{
  if(++connected!==9)return;
  // Reproduce Node's legitimate scheduling: a request event can follow the
  // connection hook's raw503/end before the socket has actually closed.
  const req=new IncomingMessage(socket);req.method='GET';req.url='/ui/';req.headers={host:'jarvis.localhost'};
  const originalPipe=req.pipe;
  t.mock.method(req,'pipe',function(this:IncomingMessage,...args:any[]){forwardAttempts++;return (originalPipe as any).apply(this,args);});
  const res=new ServerResponse(req);parsed=true;server.emit('request',req,res);req.push(null);
 });
 const holders=Array.from({length:8},()=>connect(port,'127.0.0.1'));holders.forEach(s=>{s.on('error',()=>{});s.resume();});
 t.after(()=>holders.forEach(s=>s.destroy()));
 for(const until=Date.now()+1000;connected<8;){assert.ok(Date.now()<until,'admitted connections not ready');await new Promise(r=>setTimeout(r,5));}
 const raw=await new Promise<string>((resolve,reject)=>{
  const socket=connect(port,'127.0.0.1');let text='';socket.on('error',reject);socket.on('data',chunk=>{text+=chunk;if(text.includes('\r\n\r\n')){socket.destroy();resolve(text);}});
  socket.setTimeout(1000,()=>socket.destroy(Error('overload waited for request headers')));
 });
 assert.match(raw,/HTTP\/1.1 503/);assert.match(raw,/Retry-After: 1/);assert.equal(parsed,true);
 await new Promise(r=>setTimeout(r,200));assert.equal(forwardAttempts,0,'rejected socket must not enter the forwarding path');assert.equal(forwarded,0,'raw503 does not authorize forwarding an already parsed rejected request');
});
