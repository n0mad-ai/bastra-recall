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
import {loadSessionState} from "../src/session-state.js";

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
