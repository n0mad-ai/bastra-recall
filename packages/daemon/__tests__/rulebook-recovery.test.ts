import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import fs,{mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {parseMemory,type VaultEvent} from "@bastra-recall/core";
import {cachedRulebookCatalog,startupRulebookCatalog,listRulesHandler} from "../src/rulebook-catalog.js";
import {rulebookCheckHandler,catalogFor} from "../src/rulebook-check.js";
let root:string;
const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const opts={project:null,active:[],floors:async()=>[]};
before(async()=>{root=await mkdtemp(join(tmpdir(),"rulebook-recovery-"));process.env.BASTRA_HOOK_STATE_DIR=join(root,"state");process.env.BASTRA_TELEMETRY="off";});
after(()=>rm(root,{recursive:true,force:true}));
async function fixture(id:string){
 const path=join(root,`${id}.md`),raw=`---\nid: ${id}\ntitle: Fixture\nsummary: Fixture\ntype: workflow\nscope: all-projects\nwrite_origin: user-directed\nrulebook: always\napplies_when: Fixture\ntags: []\ntopic_path: [fixture]\nrecall_when: [fixture]\n---\nFixture body`;
 await writeFile(path,raw);const m=parseMemory(raw,path,0);let scans=0,fire=()=>{};
 const vault={get:()=>m,list:()=>{scans++;return [m];},on:(fn:(e:VaultEvent)=>void)=>{fire=()=>fn({kind:"change",memory:m});return ()=>{};}};
 return {vault,m,path,raw,fire:()=>fire(),scans:()=>scans};
}
test("fix6: a hung file is skipped, repeated events do not accumulate its reads",{timeout:2500},async t=>{
 const f=await fixture("hung"),good=await fixture("healthy"),original=fs.readFile;let reads=0,release!:(s:string)=>void;
 t.mock.method(fs,"readFile",(...args:any[])=>{if(args[0]===f.path){reads++;return new Promise<string>(r=>{release=r;});}return (original as any)(...args);});
 f.vault.list=()=>[f.m,good.m];
 const first=await cachedRulebookCatalog(f.vault,{...opts,budgetMs:350});
 assert.deepEqual(first.entries.map(e=>e.id),["healthy"]);
 for(let i=0;i<4;i++){f.fire();await cachedRulebookCatalog(f.vault,{...opts,budgetMs:350});}
 assert.equal(reads,1,"one unresolved OS read per path, even after invalidation");
 f.vault.list=()=>[good.m];f.fire();
 assert.deepEqual((await cachedRulebookCatalog(f.vault,{...opts,budgetMs:350})).entries.map(e=>e.id),["healthy"]);
 release(f.raw);await wait(0);
});
test("fix6: scan deadline releases single-flight and a late old build cannot overwrite replacement",{timeout:2500},async t=>{
 const f=await fixture("late"),original=fs.readFile;let release!:(s:string)=>void;
 t.mock.method(fs,"readFile",(...args:any[])=>args[0]===f.path?new Promise<string>(r=>{release=r;}):(original as any)(...args));
 const old=cachedRulebookCatalog(f.vault,{...opts,budgetMs:350});
 await wait(20);f.vault.list=()=>[];f.fire();
 await old.catch(()=>{});
 assert.equal((await cachedRulebookCatalog(f.vault,{...opts,budgetMs:350})).entries.length,0);
 release(f.raw);await wait(20);
 assert.equal((await cachedRulebookCatalog(f.vault,opts)).entries.length,0);
});
test("fix6: event storms coalesce and IDs remain available while content waits for clean bytes",{timeout:3000},async t=>{
 const f=await fixture("storm"),original=fs.readFile;
 await cachedRulebookCatalog(f.vault,opts);
 t.mock.method(fs,"readFile",async(...args:any[])=>{if(args[0]===f.path)await wait(90);return (original as any)(...args);});
 const timer=setInterval(()=>f.fire(),30);f.fire();
 try{
  for(let i=0;i<5;i++){
   const out=await Promise.all(Array.from({length:4},()=>cachedRulebookCatalog(f.vault,{...opts,mode:"ids",budgetMs:150})));
   assert.ok(out.every(c=>c.entries.length===1));await wait(70);
  }
  assert.ok(f.scans()<12,"events are batched rather than restarting every scan");
  await assert.rejects(cachedRulebookCatalog(f.vault,{...opts,budgetMs:150}),/timeout/);
 }finally{clearInterval(timer);}
 await writeFile(f.path,f.raw.replace("scope: all-projects","sensitivity: private\nscope: all-projects"));f.fire();
 assert.equal((await cachedRulebookCatalog(f.vault,opts)).entries.length,0);
});
test("fix6: startup uses the caller budget including fallback",{timeout:1000},async()=>{
 const f=await fixture("startup-budget"),start=performance.now();
 const c=await startupRulebookCatalog(f.vault,{...opts,budgetMs:70,floors:()=>new Promise(()=>{})});
 assert.equal(c.fallback,true);assert.ok(performance.now()-start<180,"small session budgets cannot pay fixed 800+300ms");
});
test("fix6: check reloads once when the stale IDs view misses a visible rule",async t=>{
 const f=await fixture("old-id"),fresh=await fixture("new-id");
 await cachedRulebookCatalog(f.vault,opts);
 const now=Date.now();t.mock.method(Date,"now",()=>now+2100);
 f.vault.list=()=>[f.m,fresh.m];
 // list_rules starts independently, as in two parallel MCP requests.
 const check=rulebookCheckHandler({vault:f.vault} as any,{applicable:["new-id"],session_id:"fresh-check"});
 assert.equal((await listRulesHandler({vault:f.vault} as any,{})).total,2);
 assert.equal((await check).ok,true);
 assert.equal((await rulebookCheckHandler({vault:f.vault} as any,{applicable:["missing"],session_id:"fresh-check"})).ok,false);
});
test("fix6: hook check paths request IDs, periodic kernels still require content",async()=>{
 let requested:string|undefined;
 await catalogFor({session_id:"ids-consumer"},async(_active,_project,mode)=>{requested=mode;return {entries:[],omitted:0};});
 assert.equal(requested,"ids");
 const {runGateLane}=await import("../src/gate-lane.js");
 const {mutateSessionState}=await import("../src/session-state.js");
 await mutateSessionState("content-consumer",s=>{s.toolCalls=24;});
 await runGateLane({session_id:"content-consumer",bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"Read",tool_input:{}},{
  reflexPool:()=>[],kernel:async(_active,_project,mode)=>{requested=mode;return {entries:[],omitted:0};}
 });
 assert.equal(requested,"content","a periodic kernel renders texts and cannot use IDs-only SWR");
});

test("fix6: the shared build has its own deadline and cannot publish after replacement",{timeout:2500},async t=>{
 const f=await fixture("build-deadline"),original=fs.readFile;
 const many=Array.from({length:224},(_,i)=>({...f.m,filePath:join(root,`slow-${i}.md`)}));
 f.vault.list=()=>many;
 t.mock.method(fs,"readFile",async(...args:any[])=>{if(String(args[0]).includes("slow-")){await wait(90);return f.raw;}return (original as any)(...args);});
 await assert.rejects(cachedRulebookCatalog(f.vault,{...opts,budgetMs:1500}),/rulebook_build_timeout/);
 f.vault.list=()=>[];f.fire();
 assert.equal((await cachedRulebookCatalog(f.vault,{...opts,budgetMs:150})).entries.length,0);
 await wait(130);
 assert.equal((await cachedRulebookCatalog(f.vault,opts)).entries.length,0);
});

test("fix6: dirty IDs have a fixed upper age even if every scan sees events",async t=>{
 const f=await fixture("dirty-bound"),original=fs.readFile;
 await cachedRulebookCatalog(f.vault,opts);
 f.fire();
 const now=Date.now();t.mock.method(Date,"now",()=>now+30001);
 t.mock.method(fs,"readFile",async(...args:any[])=>{if(args[0]===f.path)f.fire();return (original as any)(...args);});
 await assert.rejects(cachedRulebookCatalog(f.vault,{...opts,mode:"ids",budgetMs:40}),/timeout/);
});


test("fix6: blocked OS reads stay capped across replacement scans",{timeout:1500},async t=>{
 const f=await fixture("saturation"),original=fs.readFile;let calls=0;
 const releases:Array<(s:string)=>void>=[];
 f.vault.list=()=>Array.from({length:64},(_,i)=>({...f.m,filePath:join(root,`blocked-${i}.md`)}));
 t.mock.method(fs,"readFile",(...args:any[])=>{
  if(String(args[0]).includes("blocked-")){calls++;return new Promise<string>(r=>releases.push(r));}
  return (original as any)(...args);
 });
 try{
  for(let i=0;i<4;i++){
   f.fire();const c=await cachedRulebookCatalog(f.vault,{...opts,budgetMs:350});
   assert.equal(c.entries.length,0);assert.equal(c.unavailable_sources,64);
  }
  assert.equal(calls,16,"timed-out operations still occupy their slots");
 }finally{for(const release of releases)release(f.raw);await wait(0);}
});
