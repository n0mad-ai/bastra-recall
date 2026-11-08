import test from "node:test";
import assert from "node:assert/strict";
import {createServer,request} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {githubConventionGate} from "../src/github-conventions-lane.js";
import {beginRulebookRound,recordRulebookCheck,recordRulebookLoad,requireActionRules,resetRulebookContext} from "../src/rulebook-check.js";
import {createLaneDelivery} from "../src/lane-delivery.js";
import {loadSessionState} from "../src/session-state.js";
import type {KernelCandidates} from "../src/rulebook-catalog.js";

const ref=(id:string,revision="r1")=>({id,revision});
const loadedSource={revision:"r1",rulebookMetadata:{rulebook:"on-demand" as const,applies_when:"Invented action"}};
const catalog:KernelCandidates={entries:["rule-a","rule-b"].map(id=>({...ref(id),title:id,body:"Invented rule",group:"explicit",updated:null,stale_status:"unknown",rulebook:"on-demand"})),omitted:0};
async function fixture(run:(f:{payload:(sid:string,agent_id?:string)=>any;check:(sid:string,agent_id?:string,unattributed?:boolean)=>Promise<any>;select:(id:string,revision?:string)=>void})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),"github-budget-context-")),old=process.env.BASTRA_HOOK_STATE_DIR;
 process.env.BASTRA_HOOK_STATE_DIR=root;
 let selected="rule-a",revision="r1";
 const server=createServer((q,r)=>{q.resume();q.on("end",()=>r.end(JSON.stringify(q.url==="/hook/action-conventions"?{
  hits:[{id:selected,title:selected,type:"workflow",scope:"all-projects",summary:"Invented current convention",write_origin:"user-directed",rule_categories:["github-issues-prs"],revision}],rule_ids:["rule-a","rule-b"]
 }:{hits:[],score_kind:"rrf"})));});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const payload=(session_id:string,agent_id?:string)=>({session_id,bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:`gh issue create --title ${selected}`},...(agent_id?{agent_id}:{})});
 try{await run({payload,select:(id,rev="r1")=>{selected=id;revision=rev;},check:async(sid,agent,unattributed)=>{const input=payload(sid,agent);if(unattributed)delete (input as {bastra_client?:string}).bastra_client;return JSON.parse(await githubConventionGate(input,base,Date.now()+3000)??"{}").hookSpecificOutput;}});}
 finally{await new Promise<void>(r=>server.close(()=>r()));if(old===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=old;await rm(root,{recursive:true,force:true});}
}
const denied=(value:any)=>value?.permissionDecision==="deny";
async function spend(f:Parameters<Parameters<typeof fixture>[0]>[0],sid:string,agent?:string){
 await beginRulebookRound(f.payload(sid,agent),catalog);
 f.select("rule-a");assert.equal(denied(await f.check(sid,agent)),true);assert.equal(denied(await f.check(sid,agent)),true);
}

test("#1396 a new rule arrives after two denials without another denial or stale obligation",async()=>fixture(async f=>{
 const sid="budget-new-rule";await spend(f,sid);f.select("rule-b");
 // Applicability is only a self-report, not the concrete full-load evidence.
 await recordRulebookCheck(sid,{applicable:["rule-b"]},catalog);
 const result=await f.check(sid);
 assert.equal(denied(result),false);assert.match(result?.additionalContext??"",/rule-b/);assert.doesNotMatch(result.additionalContext,/rule-a/);
 const state=await loadSessionState(sid),actor=JSON.parse(state.rulebookCheck!).actors.find((a:any)=>a.key==="main");
 assert.equal(actor.denies,2);assert.ok(!actor.required.some((r:any)=>r.id==="rule-b"));assert.ok(!state.claimedMustLoad?.includes("rule-b"));
 assert.equal(await f.check(sid),undefined,"a confirmed context is not repeatedly requested");
}));

test("#1396 full-loaded and explicitly excepted current rules stay answered",async()=>fixture(async f=>{
 for(const answer of ["load","exception"]){
  const sid="budget-answered-"+answer;await spend(f,sid);f.select("rule-b");
  if(answer==="load")await recordRulebookLoad(sid,"rule-b",null,loadedSource);
  else{await requireActionRules(f.payload(sid),[ref("rule-b")]);assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[{id:"rule-b",reason:"This rule does not apply to this invented action."}]},catalog)).ok,true);}
  assert.equal(await f.check(sid),undefined,answer);
 }
}));

test("#1396 a new source revision is delivered after the prior one was loaded",async()=>fixture(async f=>{
 const sid="budget-revision";await spend(f,sid);f.select("rule-b");
 assert.match((await f.check(sid))?.additionalContext??"",/rule-b/);
 await recordRulebookLoad(sid,"rule-b",null,loadedSource);assert.equal(await f.check(sid),undefined);
 f.select("rule-b","r2");assert.match((await f.check(sid))?.additionalContext??"",/rule-b/);assert.equal(await f.check(sid),undefined);
}));

test("#1396 worker delivery and full loads stay independent of main",async()=>fixture(async f=>{
 const sid="budget-worker";await spend(f,sid,"worker");
 await recordRulebookLoad(sid,"rule-b",null,loadedSource);f.select("rule-b");
 assert.match((await f.check(sid,"worker"))?.additionalContext??"",/rule-b/);
 assert.equal(await f.check(sid),undefined,"main already loaded this revision");
 await recordRulebookLoad(sid,"rule-b","worker",loadedSource);assert.equal(await f.check(sid,"worker"),undefined);
}));

test("#1396 an unattributed actor cannot spend main's delivery history",async()=>fixture(async f=>{
 const sid="budget-unattributed";await spend(f,sid);f.select("rule-b");assert.match((await f.check(sid))?.additionalContext??"",/rule-b/);
 f.select("rule-a");assert.equal(denied(await f.check(sid,undefined,true)),true);assert.equal(denied(await f.check(sid,undefined,true)),true);
 f.select("rule-b");assert.match((await f.check(sid,undefined,true))?.additionalContext??"",/rule-b/);
}));

test("#1396 a previous round/context delivery does not answer the next action",async()=>fixture(async f=>{
 for(const context of [false,true]){
  const sid="budget-scope-"+context;await spend(f,sid);f.select("rule-b");assert.match((await f.check(sid))?.additionalContext??"",/rule-b/);
  if(context)await resetRulebookContext(sid);
  await spend(f,sid);f.select("rule-b");assert.match((await f.check(sid))?.additionalContext??"",/rule-b/);
 }
}));

test("#1396 a dropped HTTP context response leaves the next delivery available",async()=>fixture(async f=>{
 const sid="budget-http";await spend(f,sid);f.select("rule-b");
 let ready!:()=>void,release!:()=>void,closed!:()=>void;
 const produced=new Promise<void>(r=>ready=r),hold=new Promise<void>(r=>release=r),gone=new Promise<void>(r=>closed=r);
 const server=createServer((q,r)=>{q.resume();r.once("close",closed);const delivery=createLaneDelivery(r);void delivery.run(async()=>{const output=await f.check(sid);ready();await hold;delivery.answer(JSON.stringify({hookSpecificOutput:output}));});});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 try{
  const interrupted=request({host:"127.0.0.1",port:(server.address() as {port:number}).port,path:"/context"});interrupted.on("error",()=>{});interrupted.end();
  await produced;interrupted.destroy();await gone;release();
  let released=false;
  for(let i=0;i<100;i++){
   const state=await loadSessionState(sid);released=!Object.keys(state.constants??{}).some(k=>k.endsWith(":attempt:rule-b"));if(released)break;
   await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(released,true);
  const retry=await f.check(sid);assert.equal(denied(retry),false);assert.match(retry?.additionalContext??"",/rule-b/);
  assert.equal(await f.check(sid),undefined);
 }finally{release();await new Promise<void>(r=>server.close(()=>r()));}
}));
