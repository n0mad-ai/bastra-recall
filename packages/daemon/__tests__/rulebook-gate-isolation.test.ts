import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {performance} from "node:perf_hooks";
import {runGateLane} from "../src/gate-lane.js";
import {beginRulebookRound} from "../src/rulebook-check.js";
import {bookPendingMustLoad,mutateSessionState,loadSessionState} from "../src/session-state.js";
import type {KernelCandidates} from "../src/rulebook-catalog.js";
import type {Memory} from "@bastra-recall/core";
const catalog:KernelCandidates={entries:[{id:"fixture-rule",title:"Fixture",group:"explicit",revision:"r",updated:null,stale_status:"unknown",body:"",rulebook:"on-demand",applies_when:"Fixture"}],omitted:0};
const p=(session_id:string)=>({session_id,bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"fixture_send_message",tool_input:{}});
const denied=(out:string)=>JSON.parse(out).hookSpecificOutput?.permissionDecision==="deny";
const reflex={fm:{id:"fixture-reflex",title:"Fixture",summary:"Fixture",type:"workflow",scope:"all-projects",recall_mode:"reflex",write_origin:"user-directed",salience:0.9,recall_when:["fixture_send_message"]},body:"Fixture reflex body."} as Memory;
let root:string;
before(async()=>{root=await mkdtemp(join(tmpdir(),"rulebook-isolation-"));process.env.BASTRA_HOOK_STATE_DIR=root;process.env.BASTRA_TELEMETRY="off";});
after(()=>rm(root,{recursive:true,force:true}));
for(const failure of ["throw","slow","never","control"] as const) test(`fix3: legacy pending/reflex survives ${failure} catalog`,{timeout:1500},async()=>{
 const sid=`catalog-${failure}`;
 await mutateSessionState(sid,s=>bookPendingMustLoad(s,["fixture-pending"],"fixture"));
 const start=performance.now();
 const out=await runGateLane(p(sid),{reflexPool:()=>[reflex],kernel:async()=>{
  if(failure==="throw")throw Error("catalog unavailable");
  if(failure==="slow")await new Promise(r=>setTimeout(r,600));
  if(failure==="never")await new Promise(()=>{});
  return catalog;
 }});
 assert.equal(denied(out),true,out);
 assert.match(out,/fixture-pending/);assert.match(out,/fixture-reflex/);
 assert.ok(performance.now()-start<500,"C must leave legacy time within its 500ms budget");
 assert.deepEqual((await loadSessionState(sid)).deniedReflex,["fixture-reflex"]);
});
test("fix3: expired calls do not consume C denial allowance",async()=>{
 const sid="c-expired",deps={reflexPool:()=>[],kernel:async()=>catalog};
 for(let i=0;i<2;i++)assert.equal(await runGateLane(p(sid),{...deps,deadline:Date.now()-1}),"{}");
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 assert.equal(denied(await runGateLane(p(sid),deps)),false);
});
test("fix3: late gate telemetry restores C allowance as well as legacy claims",async t=>{
 const sid="c-late",deps={reflexPool:()=>[],kernel:async()=>catalog};
 let now=Date.now();t.mock.method(Date,"now",()=>now);
 for(let i=0;i<2;i++){
  await mutateSessionState(sid,s=>bookPendingMustLoad(s,[`hint-${i}`],"fixture"));
  assert.equal(await runGateLane(p(sid),{...deps,telemetry:async()=>{now+=60000;}}),"{}");
 }
 await mutateSessionState(sid,s=>{delete s.pendingMustLoad;});
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 assert.equal(denied(await runGateLane(p(sid),deps)),false);
});

test("fix3: failure of the later gate write releases the earlier C reservation",async()=>{
 const {chmodSync}=await import("node:fs");
 const sid="c-later-write-failure";
 await beginRulebookRound(p(sid),catalog);
 const deps={kernel:async()=>catalog,reflexPool:()=>[]};
 try {
  const out=await runGateLane(p(sid),{...deps,reflexPool:()=>{chmodSync(root,0o500);return [];},telemetry:async fields=>{
   if(fields.non_conformance==="state_write_failed")chmodSync(root,0o700);
  }});
  assert.equal(out,"{}");
 }finally{chmodSync(root,0o700);}
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 assert.equal(denied(await runGateLane(p(sid),deps)),false);
});

test("fix3: a timed-out catalog completing late cannot spend a C attempt",async t=>{
 const sid="c-late-catalog";let resolve!:(value:KernelCandidates)=>void;
 const pending=new Promise<KernelCandidates>(r=>{resolve=r;});
 const out=await runGateLane(p(sid),{reflexPool:()=>[],kernel:()=>pending});
 assert.equal(out,"{}");
 resolve(catalog);await new Promise(r=>setImmediate(r));
 const now=Date.now();t.mock.method(Date,"now",()=>now+5100);
 const deps={reflexPool:()=>[],kernel:async()=>catalog};
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 assert.equal(denied(await runGateLane(p(sid),deps)),false);
});

test("fix3: rolling back an old round cannot reduce the current round allowance",async()=>{
 const {rulebookBoundary}=await import("../src/rulebook-check.js");
 const sid="c-round-rollback";let settle!:(delivered:boolean)=>Promise<void>;
 await rulebookBoundary(p(sid),catalog,"action",{onDenial:s=>{settle=s;}});
 await beginRulebookRound(p(sid),catalog);
 const deps={reflexPool:()=>[],kernel:async()=>catalog};
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 await settle(false);
 assert.equal(denied(await runGateLane(p(sid),deps)),true);
 assert.equal(denied(await runGateLane(p(sid),deps)),false);
});
