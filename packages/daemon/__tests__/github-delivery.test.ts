import test from "node:test";
import assert from "node:assert/strict";
import {createServer,request} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createLaneDelivery} from "../src/lane-delivery.js";
import {runBashPreLane} from "../src/bash-pre-lane.js";
import {recordRulebookLoad} from "../src/rulebook-check.js";
import {loadSessionState} from "../src/session-state.js";
test("#1330: a disconnected HTTP response never spends its GitHub convention delivery",{timeout:10000},async t=>{
 const root=await mkdtemp(join(tmpdir(),"github-delivery-"));t.after(()=>rm(root,{recursive:true,force:true}));const prior=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=root;t.after(()=>{if(prior===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=prior;});
 let produced!:()=>void,release!:()=>void,closed!:()=>void;const gone=new Promise<void>(r=>closed=r);const ready=new Promise<void>(r=>produced=r),hold=new Promise<void>(r=>release=r);let delay=true;
 const server=createServer((q,r)=>{if(q.url==="/hook/action-conventions"){q.resume();r.end(JSON.stringify({hits:[]}));return;}if(q.url==="/hook/recall"){q.resume();r.end(JSON.stringify({score_kind:"rrf",hits:[{id:"fixture-issue-rule",type:"workflow",scope:"all-projects",summary:"Milestone, labels, English first then Deutsch",score:150,matched_recall_when:true,anchor_strength:"strong"}]}));return;}
 if(delay)r.once("close",closed);
 const delivery=createLaneDelivery(r);
 void delivery.run(async()=>{let raw="";for await(const c of q)raw+=c;const input=JSON.parse(raw);const out=await runBashPreLane(input.payload,`http://127.0.0.1:${q.socket.localPort}`);if(delay){produced();await hold;}delivery.answer(out);});});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));const port=(server.address()as {port:number}).port;
 const payload={payload:{session_id:"fixture-http-delivery",bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"gh issue create --title fixture"}}};
 const interrupted=request({host:"127.0.0.1",port,path:"/hook/bash-pre",method:"POST",headers:{"Content-Type":"application/json"}});interrupted.on("error",()=>{});interrupted.end(JSON.stringify(payload));await ready;interrupted.destroy();await gone;release();delay=false;
 await new Promise(r=>setTimeout(r,30));
 const get=async()=>{const r=await fetch(`http://127.0.0.1:${port}/hook/bash-pre`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});return r.json()as Promise<any>;};
 const first=await get();
 assert.equal(first.hookSpecificOutput?.permissionDecision,"deny","next action must still receive the convention after an undelivered response");
 assert.match(first.hookSpecificOutput?.permissionDecisionReason??"",/fixture-issue-rule/);assert.match(first.hookSpecificOutput?.permissionDecisionReason??"",/must.load/i);
 let confirmed=false;
 for(let i=0;i<100;i++){const state=await loadSessionState("fixture-http-delivery"),constants=state.constants??{};confirmed=JSON.parse(constants["github-action-conventions-v2"]??"[]").includes("fixture-issue-rule")&&!Object.keys(constants).some(k=>k.includes(":attempt:"));if(confirmed)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(confirmed,true,"completed HTTP deny compacts its confirmed delivery and removes the attempt");
 assert.ok((await loadSessionState("fixture-http-delivery")).claimedMustLoad?.includes("fixture-issue-rule"));
 await recordRulebookLoad("fixture-http-delivery","fixture-issue-rule",null);
 const now=Date.now();t.mock.method(Date,"now",()=>now+60000);
 assert.notEqual((await get()).hookSpecificOutput?.permissionDecision,"deny","a confirmed delivery remains spent after its reservation deadline");
});
