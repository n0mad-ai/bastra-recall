import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runStopLane} from "../src/stop-lane.js";
import {runPromptLane} from "../src/prompt-lane.js";
import {runGateLane} from "../src/gate-lane.js";
import {rulebookBoundary,recordRulebookCheck} from "../src/rulebook-check.js";
import {mutateSessionState,loadSessionState,sessionStateDir} from "../src/session-state.js";
import {withPathLock} from "../src/path-lock.js";
import type {KernelCandidates} from "../src/rulebook-catalog.js";
const catalog:KernelCandidates={entries:[{id:"fixture-rule",title:"Fixture",group:"explicit",revision:"r",updated:null,stale_status:"unknown",body:"Fixture body",rulebook:"on-demand",applies_when:"Fixture"}],omitted:0};
let root:string;
before(async()=>{root=await mkdtemp(join(tmpdir(),"hook-budget-"));Object.assign(process.env,{BASTRA_HOOK_STATE_DIR:join(root,"state"),BASTRA_TELEMETRY:"off",BASTRA_HARVEST_QUEUE_PATH:join(root,"queue.json"),BASTRA_SESSION_HARVEST:"on",BASTRA_STOP_SAME_TURN:"on"});});
after(()=>rm(root,{recursive:true,force:true}));
const kernel=(mode:string)=>async()=>{if(mode==="throw")throw Error("fixture catalog failure");if(mode==="slow")await new Promise(r=>setTimeout(r,600));if(mode==="never")await new Promise(()=>{});return catalog;};
for(const mode of ["slow","never","throw"])test(`fix4: ${mode} catalog preserves ordinary Stop harvest and repair`,{timeout:1500},async()=>{
 const sid=`stop-${mode}`,path=join(root,`${sid}.jsonl`);await writeFile(path,JSON.stringify({role:"user",content:"Fixture prompt"})+"\n");
 await mutateSessionState(sid,s=>{s.activeTask={id:"fixture-task",kind:"approved-copy",since:1,generation:0};s.activeConventions=[{id:"fixture-rule",revision:"r",setAt:1,validator:{tool:"validate_artifact",channel:"fixture",limit:100,unit:"utf16"}}];});
 const started=performance.now();
 const payload={session_id:sid,bastra_client:"claude-code",hook_event_name:"Stop",transcript_path:path};
 const out=await runStopLane(payload,"http://127.0.0.1:1",{kernel:kernel(mode)});
 assert.ok(performance.now()-started<500,"new catalog stage cannot consume the legacy Stop budget");
 assert.match(out,/copy-repair/);
 assert.ok(JSON.parse(await readFile(join(root,"queue.json"),"utf8")).some((r:any)=>r.session_id===sid));
});
for(const mode of ["slow","never","throw"])test(`fix4: ${mode} catalog preserves prompt task hints and expires the preceding receipt`,{timeout:1500},async()=>{
 const sid=`prompt-${mode}`;await recordRulebookCheck(sid,{applicable:[]},catalog);
 await mutateSessionState(sid,s=>{s.activeTask={id:"fixture-task",kind:"draft-for-review",since:1,generation:0};s.activeConventions=[{id:"fixture-rule",revision:"r",setAt:1}];});
 const started=performance.now();
 const payload={session_id:sid,bastra_client:"claude-code",hook_event_name:"UserPromptSubmit",prompt:"ok"};
 const out=await runPromptLane(payload,null,"http://127.0.0.1:1",undefined,()=>[],{kernel:kernel(mode)});
 assert.ok(performance.now()-started<500);
 assert.match(out,/fixture-rule/);
 assert.equal(JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors.some((a:any)=>a.checked),false);
});
test("fix4: timed-out periodic kernel delivery stays due for the next call",{timeout:1500},async()=>{
 const sid="retry-kernel",p={session_id:sid,bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"Read",tool_input:{}};
 await mutateSessionState(sid,s=>{s.toolCalls=24;});
 const started=performance.now();
 assert.equal(await runGateLane(p,{reflexPool:()=>[],kernel:kernel("slow")}),"{}");
 assert.ok(performance.now()-started<500);
 assert.ok((await loadSessionState(sid)).toolCalls!>=25);
 assert.match(await runGateLane(p,{reflexPool:()=>[],kernel:kernel("ok")}),/rule-kernel/);
 assert.equal((await loadSessionState(sid)).toolCalls,0);
});
test("fix4: C rollback does not wait for a held state lock in the response path",{timeout:1500},async()=>{
 const sid="rollback-lock";let settle!:(delivered:boolean)=>Promise<void>;
 await rulebookBoundary({session_id:sid,bastra_client:"claude-code"},catalog,"action",{onDenial:receipt=>{settle=receipt;}});
 let release!:()=>void,ready!:()=>void;const entered=new Promise<void>(r=>ready=r),hold=new Promise<void>(r=>release=r);
 const lock=withPathLock(join(sessionStateDir(),`${sid}.json`),async()=>{ready();await hold;});await entered;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {assert.equal(await Promise.race([settle(false).then(()=>"returned"),new Promise(r=>{timer=setTimeout(()=>r("blocked"),200);})]),"returned");}
 finally {if(timer)clearTimeout(timer);release();await lock;}
 for(let i=0;i<50;i++){const a=JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors[0];if(a.denies===0)return;await new Promise(r=>setTimeout(r,5));}
 assert.fail("background rollback did not complete");
});


test("fix4: the catalog cache itself bounds a stuck cold source",{timeout:1000},async()=>{
 const {cachedRulebookCatalog}=await import("../src/rulebook-catalog.js");
 const started=performance.now();
 await assert.rejects(cachedRulebookCatalog({get:()=>undefined,list:()=>[],on:()=>()=>{}},{project:null,active:[],floors:()=>new Promise(()=>{})}),/rulebook_catalog_timeout/);
 assert.ok(performance.now()-started<500);
});
