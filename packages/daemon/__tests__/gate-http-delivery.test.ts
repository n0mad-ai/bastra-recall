import test from "node:test";
import assert from "node:assert/strict";
import {createServer,request} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {dispatchLaneRoutes} from "../src/http-lane-routes.js";
import {bookPendingMustLoad,mutateSessionState,loadSessionState} from "../src/session-state.js";
import type {Memory} from "@bastra-recall/core";
import type {KernelCandidates} from "../src/rulebook-catalog.js";
const catalog:KernelCandidates={entries:[{id:"fixture-rule",title:"Fixture",group:"explicit",revision:"r",updated:null,stale_status:"unknown",body:"",rulebook:"on-demand",applies_when:"Fixture"}],omitted:0};
const reflex={fm:{id:"fixture-reflex",title:"Fixture",summary:"Fixture",type:"workflow",scope:"all-projects",recall_mode:"reflex",write_origin:"user-directed",salience:0.9,recall_when:["fixture_send_message"]},body:"Fixture body"} as Memory;
test("fix4: actual /hook/gate disconnect releases C and legacy; finished deny remains spent",{timeout:6000},async t=>{
 const root=await mkdtemp(join(tmpdir(),"gate-http-delivery-"));process.env.BASTRA_HOOK_STATE_DIR=root;process.env.BASTRA_TELEMETRY="off";t.after(()=>rm(root,{recursive:true,force:true}));
 const sid="http-gate",payload={payload:{session_id:sid,bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"fixture_send_message",tool_input:{}}};
 await mutateSessionState(sid,s=>bookPendingMustLoad(s,["fixture-pending"],"fixture"));
 let holdResponse=true,produced!:()=>void,release!:()=>void,closed!:()=>void;
 let ready=new Promise<void>(r=>produced=r),hold=new Promise<void>(r=>release=r),gone=new Promise<void>(r=>closed=r);
 const server=createServer((req,res)=>{
  if(holdResponse){res.once("close",closed);const end=res.end.bind(res);res.end=((...args:any[])=>{produced();void hold.then(()=>{if(!res.destroyed)(end as any)(...args);});return res;}) as typeof res.end;}
  if(!dispatchLaneRoutes(req,res,"POST","/hook/gate",undefined,undefined,undefined,()=>[reflex],async()=>catalog))res.end("{}");
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>{server.closeAllConnections();server.close();});
 const port=(server.address() as {port:number}).port;
 const interrupted=request({host:"127.0.0.1",port,path:"/hook/gate",method:"POST",headers:{"Content-Type":"application/json"}});interrupted.on("error",()=>{});interrupted.end(JSON.stringify(payload));
 await ready;interrupted.destroy();await gone;release();holdResponse=false;
 let restored=false;
 for(let i=0;i<80;i++){const s=await loadSessionState(sid);const denies=JSON.parse(s.rulebookCheck??"{}").actors?.[0]?.denies;restored=denies===0&&s.pendingMustLoad?.some(e=>e.id==="fixture-pending")===true&&!s.deniedReflex?.includes("fixture-reflex");if(restored)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(restored,true,"undelivered C, pending and reflex claims must all recover");
 const get=async()=>{const r=await fetch(`http://127.0.0.1:${port}/hook/gate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});return r.json() as Promise<any>;};
 const first=await get();assert.equal(first.hookSpecificOutput?.permissionDecision,"deny");assert.match(first.hookSpecificOutput.permissionDecisionReason,/fixture-pending/);assert.match(first.hookSpecificOutput.permissionDecisionReason,/fixture-reflex/);
 assert.equal((await get()).hookSpecificOutput?.permissionDecision,"deny");
 assert.notEqual((await get()).hookSpecificOutput?.permissionDecision,"deny");
 // Periodic context uses the same response scope, but does not need a deny.
 payload.payload.tool_name="Read";
 await mutateSessionState(sid,s=>{s.toolCalls=24;});
 ready=new Promise<void>(r=>produced=r);hold=new Promise<void>(r=>release=r);gone=new Promise<void>(r=>closed=r);holdResponse=true;
 const contextCall=request({host:"127.0.0.1",port,path:"/hook/gate",method:"POST",headers:{"Content-Type":"application/json"}});contextCall.on("error",()=>{});contextCall.end(JSON.stringify(payload));
 await ready;contextCall.destroy();await gone;release();holdResponse=false;
 assert.ok((await loadSessionState(sid)).toolCalls!>=25,"a disconnected context remains due");
 assert.match((await get()).hookSpecificOutput?.additionalContext??"",/rule-kernel/);
 for(let i=0;i<80;i++){if((await loadSessionState(sid)).toolCalls===0)return;await new Promise(r=>setTimeout(r,5));}
 assert.fail("confirmed context did not reset the cadence");
});
