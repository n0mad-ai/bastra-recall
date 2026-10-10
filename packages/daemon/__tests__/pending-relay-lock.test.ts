import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, writeFile, unlink, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathLockFilePath } from "../src/path-lock.js";
import { takePendingRelay, writePendingFromHook } from "../src/pending-suggestions.js";
import { purgeDrafts } from "../src/draft-store.js";
import { cmdDrafts } from "../src/cli/drafts-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { runStopLane, evaluateHeuristics } from "../src/stop-lane.js";
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(work:(path:string,drafts:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"relay-lock-")),path=join(dir,"pending.json"),drafts=join(dir,"drafts.json");
 const env={BASTRA_PENDING_SUGGESTIONS_PATH:path,BASTRA_DRAFTS_PATH:drafts,BASTRA_PENDING_RELAY:"1",BASTRA_SESSION_HARVEST:"0",BASTRA_TELEMETRY:"off"};
 const prev=new Map(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 try{await work(path,drafts);}finally{for(const[k,v]of prev)if(v===undefined)delete process.env[k];else process.env[k]=v;await rm(dir,{recursive:true,force:true});}
}
test("busy relay reads skip immediately, preserve bytes, and deliver on the next attempt without diagnostics",t=>fixture(async path=>{
 const original=JSON.stringify([{ts:Date.now(),blocks:"Invented retained relay observation"}]);await writeFile(path,original);await writeFile(pathLockFilePath(path),"held fixture lock");
 const before=(await stat(path)).mtimeMs,start=performance.now();assert.deepEqual(await takePendingRelay(),{recency:[],trends:[]});
 t.diagnostic(`busy read returned in ${(performance.now()-start).toFixed(1)} ms`);
 assert.ok(performance.now()-start<100,"busy read must not wait for the five-second lease");await delay(100);assert.equal(await readFile(path,"utf8"),original);assert.equal((await stat(path)).mtimeMs,before);
 await unlink(pathLockFilePath(path));assert.equal((await takePendingRelay()).recency.length,1);
}));
test("busy hook writes return immediately and the deferred write persists after unlock without losing old entries",t=>fixture(async path=>{
 const original=JSON.stringify([{ts:Date.now(),blocks:"Invented old relay observation"}]);await writeFile(path,original);await writeFile(pathLockFilePath(path),"held fixture lock");
 let warnings="";t.mock.method(process.stderr,"write",(s:unknown)=>{warnings+=String(s);return true;});
 try{
  const start=performance.now();await writePendingFromHook("Invented new relay observation");assert.ok(performance.now()-start<100);await delay(100);assert.equal(await readFile(path,"utf8"),original);
 }finally{await unlink(pathLockFilePath(path));}
 const deadline=Date.now()+2000;while(Date.now()<deadline){const rows=JSON.parse(await readFile(path,"utf8"));if(rows.length===2)break;await delay(20);}
 const rows=JSON.parse(await readFile(path,"utf8"));assert.deepEqual(rows.map((r:{blocks:string})=>r.blocks),["Invented old relay observation","Invented new relay observation"]);assert.equal(warnings,"");
}));
test("the actual Stop response skips busy relay contention and writes later",()=>fixture(async path=>{
 const turns=[{role:"assistant",content:"We compared queue and polling."},{role:"user",content:"we compared both options. decided: we go with the queue, not polling"}];
 assert.ok(evaluateHeuristics(turns).length>0);await writeFile(path,"[]");await writeFile(pathLockFilePath(path),"held fixture lock");
 const start=performance.now();try{assert.equal(await runStopLane({hook_event_name:"Stop",cwd:"/tmp",transcript:turns},"http://127.0.0.1:1"),"{}");assert.ok(performance.now()-start<500);assert.equal(await readFile(path,"utf8"),"[]");}
 finally{await unlink(pathLockFilePath(path));}
 const deadline=Date.now()+2000;while(Date.now()<deadline){if(JSON.parse(await readFile(path,"utf8")).length)break;await delay(20);}
 assert.match(await readFile(path,"utf8"),/architecture-decision/);
}));
test("draft deletion failure leaves the validated relay unchanged",t=>fixture(async(path,drafts)=>{
 const original=JSON.stringify([{ts:Date.now(),blocks:"Invented retained relay observation"}]);await writeFile(path,original);await writeFile(drafts,"draft fixture");
 const real=fs.unlink;t.mock.method(fs,"unlink",async(p:Parameters<typeof fs.unlink>[0])=>{if(String(p)===drafts)throw Object.assign(new Error("fixture draft deletion denied"),{code:"EACCES"});return real(p);});syncBuiltinESMExports();
 try{await assert.rejects(purgeDrafts(),/draft deletion denied/);assert.equal(await readFile(path,"utf8"),original);assert.equal(await readFile(drafts,"utf8"),"draft fixture");}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
}));
test("purge accepts an empty relay, keeps it private, and reports an absent relay honestly",()=>fixture(async(path,drafts)=>{
 await writeFile(path,"");await writeFile(drafts,"draft fixture");assert.deepEqual(await purgeDrafts(),{pendingRelay:true});assert.deepEqual(JSON.parse(await readFile(path,"utf8")),[]);
 if(process.platform!=="win32")assert.equal((await stat(path)).mode&0o777,0o600);
 await unlink(path);await writeFile(drafts,"draft fixture");assert.deepEqual(await purgeDrafts(),{pendingRelay:false});await assert.rejects(stat(path),{code:"ENOENT"});
}));

test("purge reports a relay access error separately from draft-store errors",t=>fixture(async(path,drafts)=>{
 await writeFile(path,"{invalid fixture");await writeFile(drafts,"draft fixture");let stderr="";t.mock.method(process.stderr,"write",(chunk:unknown)=>{stderr+=String(chunk);return true;});
 assert.equal(await cmdDrafts(parseArgs(["drafts","purge"])),1);assert.match(stderr,/cannot clear pending relay; original preserved/);assert.doesNotMatch(stderr,/cannot access local drafts|invalid fixture/);assert.equal(await readFile(drafts,"utf8"),"draft fixture");
}));
