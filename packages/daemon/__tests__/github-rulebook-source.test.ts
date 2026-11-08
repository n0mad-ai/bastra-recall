/** #1377: a GitHub write may oblige only current rulebook entries; other search hits stay advisory. */
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {parseMemory} from "@bastra-recall/core";
import {indexedActionConventions} from "../src/action-conventions.js";
import {githubConventionGate} from "../src/github-conventions-lane.js";
import {recordRulebookLoad} from "../src/rulebook-check.js";
import {clearShown,loadSessionState} from "../src/session-state.js";

const memory=(id:string,extra:string)=>parseMemory(`---\nid: ${id}\ntitle: Invented\nsummary: Invented summary\ntype: workflow\nscope: all-projects\nwrite_origin: agent-session\n${extra}tags: [fixture]\ntopic_path: [fixture]\nrecall_when: [fixture]\n---\nInvented body`,`/unreadable/${id}`,0);
const hit=(id:string)=>({id,title:"Invented",type:"workflow",scope:"all-projects",summary:"Invented summary",score:150,matched_recall_when:true,anchor_strength:"strong"});

test("the structured lookup reports catalog membership, an ordinary note is not a member",async()=>{
 const rule=memory("invented-catalog-rule","rulebook: on-demand\napplies_when: Invented situation\n"),note=memory("invented-plain-note","");
 const vault={list:()=>[rule,note],get:(id:string)=>[rule,note].find(m=>m.fm.id===id)};
 const result=await indexedActionConventions(vault as never,null,"github-issues-prs");
 assert.deepEqual(result.rule_ids,["invented-catalog-rule"]);
 assert.deepEqual(result.hits,[],"no entry carries the github-issues-prs category");
});

test("a legacy search hit outside the rulebook never denies; a catalog rule still does",async t=>{
 const root=await mkdtemp(join(tmpdir(),"github-rulebook-source-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const saved=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=root;t.after(()=>{if(saved===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=saved;});
 let ruleIds=["invented-catalog-rule"];
 const server=createServer((q,r)=>{q.resume();q.on("end",()=>{
  if(q.url==="/hook/action-conventions"){r.end(JSON.stringify({hits:[],rule_ids:ruleIds,score_kind:"rrf"}));return;}
  r.end(JSON.stringify({hits:[hit("invented-catalog-rule"),hit("invented-plain-note")],score_kind:"rrf"}));
 });});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const payload=(sid:string)=>({session_id:sid,bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"gh issue create --title fixture"}});
 const run=async(sid:string)=>JSON.parse((await githubConventionGate(payload(sid),base,Date.now()+3000))??"{}").hookSpecificOutput;
 const required=async(sid:string)=>JSON.parse((await loadSessionState(sid)).rulebookCheck??'{"actors":[]}').actors.flatMap((a:{required:{id:string}[]})=>a.required.map(r=>r.id));

 const first=await run("mixed");
 assert.equal(first?.permissionDecision,"deny");
 assert.match(first.permissionDecisionReason,/invented-catalog-rule/);
 assert.doesNotMatch(first.permissionDecisionReason,/invented-plain-note/);
 assert.match(first.additionalContext,/invented-plain-note/,"the ordinary note still reaches the agent as advice");
 assert.deepEqual(await required("mixed"),["invented-catalog-rule"]);
 await recordRulebookLoad("mixed","invented-catalog-rule",null);
 assert.notEqual((await run("mixed"))?.permissionDecision,"deny");

 // Empty catalog: the same hits are only advice.
 ruleIds=[];
 const advisory=await run("empty-catalog");
 assert.notEqual(advisory?.permissionDecision,"deny");
 assert.match(advisory.additionalContext,/invented-catalog-rule/);
 assert.doesNotMatch(advisory.additionalContext,/MUST-LOAD/);
 assert.deepEqual(await required("empty-catalog"),[]);

 // A rule retired between two writes no longer obliges the next one.
 ruleIds=["invented-catalog-rule"];
 assert.equal((await run("retired"))?.permissionDecision,"deny");
 ruleIds=[];
 assert.notEqual((await run("retired"))?.permissionDecision,"deny");
});

test("#1391: non-rule GitHub advice is delivered once per session, including after context loss",async t=>{
 const root=await mkdtemp(join(tmpdir(),"github-advisory-once-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const saved=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=root;t.after(()=>{if(saved===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=saved;});
 const server=createServer((q,r)=>{q.resume();q.on("end",()=>r.end(JSON.stringify(q.url==="/hook/action-conventions"
  ?{hits:[],rule_ids:[]}:{hits:[hit("invented-advisory")],score_kind:"rrf"})));});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const run=async(session_id:string,agent_id?:string)=>JSON.parse((await githubConventionGate({session_id,agent_id,bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"gh issue edit 1 --title fixture"}},base,Date.now()+3000))??"{}").hookSpecificOutput;
 const first=await run("advice-session");assert.match(first.additionalContext,/invented-advisory/);assert.doesNotMatch(first.additionalContext,/MUST-LOAD/);
 assert.equal(await run("advice-session"),undefined,"a second write does not repeat the ordinary note");
 assert.equal(await run("advice-session","other-worker"),undefined,"the note policy is once per session, not per actor");
 await clearShown("advice-session");
 assert.equal(await run("advice-session"),undefined,"compact clears rule context but does not restart session advice");
 assert.match((await run("new-advice-session")).additionalContext,/invented-advisory/,"a different session still receives useful advice");
 const state=await loadSessionState("advice-session");
 assert.deepEqual(state.claimedMustLoad??[],[],"advice never creates must-load claims");
});

test("#1391: categorized language, milestone and completion rules arrive with empty legacy search",async t=>{
 const root=await mkdtemp(join(tmpdir(),"github-structured-three-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const saved=process.env.BASTRA_HOOK_STATE_DIR;process.env.BASTRA_HOOK_STATE_DIR=root;t.after(()=>{if(saved===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=saved;});
 const ids=["invented-language-rule","invented-milestone-rule","invented-completion-rule"];
 const memories=ids.map(id=>memory(id,"rulebook: on-demand\napplies_when: Invented GitHub writes\nrule_categories: [github-issues-prs]\n"));
 const vault={list:()=>memories,get:(id:string)=>memories.find(m=>m.fm.id===id)};
 const server=createServer((q,r)=>{q.resume();q.on("end",()=>{void (async()=>{
  r.end(JSON.stringify(q.url==="/hook/action-conventions"?await indexedActionConventions(vault as never,null,"github-issues-prs"):{hits:[],score_kind:"rrf"}));
 })();});});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const result=JSON.parse((await githubConventionGate({session_id:"structured-three",bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"gh issue close 1"}},base,Date.now()+3000))??"{}");
 assert.equal(result.hookSpecificOutput?.permissionDecision,"deny");
 for(const id of ids)assert.match(result.hookSpecificOutput.permissionDecisionReason,new RegExp(id));
 const state=JSON.parse((await loadSessionState("structured-three")).rulebookCheck??'{"actors":[]}');
 assert.deepEqual(state.actors.flatMap((a:{required:{id:string}[]})=>a.required.map(r=>r.id)).sort(),ids.sort());
});
