import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {runGateLane} from "../src/gate-lane.js";
import {mutateSessionState,loadSessionState} from "../src/session-state.js";
let root:string;
before(async()=>{root=await mkdtemp(join(tmpdir(),"kernel-concurrency-"));process.env.BASTRA_HOOK_STATE_DIR=join(root,"state");process.env.BASTRA_TELEMETRY="off";});
after(()=>rm(root,{recursive:true,force:true}));
const catalog={entries:[{id:"fixture-rule",title:"Fixture",group:"explicit",revision:"r",updated:null,stale_status:"unknown",body:"",rulebook:"on-demand",applies_when:"Fixture"}],omitted:0} as any;
const p=(session_id:string)=>({session_id,bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"Read",tool_input:{}});
test("fix5: one periodic delivery claim leaves the other parallel calls counted",async()=>{
 const sid="parallel-kernel";await mutateSessionState(sid,s=>{s.toolCalls=24;});
 const out=await Promise.all(Array.from({length:4},()=>runGateLane(p(sid),{reflexPool:()=>[],kernel:async()=>catalog})));
 assert.equal(out.filter(o=>o.includes("<rule-kernel")).length,1);assert.equal((await loadSessionState(sid)).toolCalls,3);
});
test("fix5: failed periodic catalog backs off rather than delaying every read",async t=>{
 const sid="kernel-backoff";await mutateSessionState(sid,s=>{s.toolCalls=24;});let scans=0;
 const deps={reflexPool:()=>[],kernel:async()=>{scans++;throw Error("fixture outage");}};
 for(let i=0;i<4;i++)assert.equal(await runGateLane(p(sid),deps),"{}");
 assert.equal(scans,1);
 const now=Date.now();t.mock.method(Date,"now",()=>now+5100);
 assert.match(await runGateLane(p(sid),{...deps,kernel:async()=>catalog}),/rule-kernel/);
});

test("fix5: asynchronous C rollback after a legacy overrun is observed by polling",async t=>{
 const sid="overrun-async",{rulebookBoundary}=await import("../src/rulebook-check.js");
 // Advance the deadline in the callback rather than burning CPU for 560 ms.
 let now=Date.now();t.mock.method(Date,"now",()=>now);
 const write={...p(sid),tool_name:"Write"};
 for(let i=0;i<3;i++){
  assert.equal(await runGateLane(write,{reflexPool:()=>[],kernel:async()=>catalog,actionMustLoad:{key:"fixture-overrun",ids:["fixture-hint"],onClaim:()=>{now+=560;}}}),"{}");
  let restored=false;
  for(let n=0;n<80;n++){const s=await loadSessionState(sid),a=JSON.parse(s.rulebookCheck??"{}").actors?.find((a:any)=>a.key==="main");if(a?.denies===0){restored=true;break;}await new Promise(r=>setTimeout(r,5));}
  assert.equal(restored,true);
 }
 assert.match(await rulebookBoundary(write,catalog,"action")??"",/deny/);
});
