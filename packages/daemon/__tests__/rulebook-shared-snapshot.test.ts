import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {parseMemory,type VaultEvent} from "@bastra-recall/core";
import * as catalogs from "../src/rulebook-catalog.js";
import {rulebookCheckHandler} from "../src/rulebook-check.js";
import {runGateLane} from "../src/gate-lane.js";
import {mutateSessionState,loadSessionState} from "../src/session-state.js";
let root:string;
before(async()=>{root=await mkdtemp(join(tmpdir(),"shared-snapshot-"));process.env.BASTRA_HOOK_STATE_DIR=join(root,"state");process.env.BASTRA_TELEMETRY="off";});
after(()=>rm(root,{recursive:true,force:true}));
async function fixture(id:string){
 const path=join(root,`${id}.md`),raw=`---\nid: ${id}\ntitle: Secret fixture title\nsummary: Fixture description\ntype: workflow\nscope: all-projects\nwrite_origin: user-directed\nrulebook: always\napplies_when: Secret description\ntags: []\ntopic_path: [fixture]\nrecall_when: [fixture]\n---\nSecret fixture body`;
 await writeFile(path,raw);const m=parseMemory(raw,path,0);let scans=0,changed=()=>{};
 const vault={get:()=>m,list:()=>{scans++;return [m];},on:(fn:(event:VaultEvent)=>void)=>{changed=()=>fn({kind:"change",memory:m});return ()=>{};}};
 return {vault,path,raw,scans:()=>scans,event:()=>changed()};
}
test("fix5: four scopes, memberships and floor sets share one source scan",async()=>{
 const f=await fixture("shared-rule");
 const out=await Promise.all(Array.from({length:4},(_,i)=>catalogs.cachedRulebookCatalog(f.vault,{project:`project-${i}`,active:[{id:`active-${i}`,revision:null,setAt:1}],floors:async()=>[]})));
 assert.equal(f.scans(),1);assert.ok(out.every(c=>c.entries.length===1));
});
test("fix5: only IDs can use bounded stale data; content and events force freshness",async t=>{
 const f=await fixture("stale-rule"),opts={project:null,active:[],floors:async()=>[]};
 await catalogs.cachedRulebookCatalog(f.vault,opts);
 await writeFile(f.path,f.raw.replace("scope: all-projects","sensitivity: private\nscope: all-projects"));
 const now=Date.now();t.mock.method(Date,"now",()=>now+2100);
 const stale=await catalogs.cachedRulebookCatalog(f.vault,{...opts,mode:"ids"} as any);
 assert.equal(stale.entries.length,1);assert.doesNotMatch(JSON.stringify(stale),/Secret fixture|Secret description/);
 assert.throws(()=>catalogs.rulebookPage(stale),/IDs.only/);
 assert.equal((await catalogs.cachedRulebookCatalog(f.vault,opts)).entries.length,0);
 await writeFile(f.path,f.raw);f.event();
 assert.equal((await catalogs.cachedRulebookCatalog(f.vault,{...opts,mode:"ids"} as any)).entries.length,1);
});
test("fix5: MCP tools have a larger budget than hooks and share the cold build",async()=>{
 const f=await fixture("tools-rule"),list=f.vault.list;
 f.vault.list=()=>{const until=performance.now()+190;while(performance.now()<until){}return list();};
 const deps={vault:f.vault} as any;
 const [page,check]=await Promise.all([catalogs.listRulesHandler(deps,{}, {project:"first"}),rulebookCheckHandler(deps,{applicable:[],session_id:"tool-budget"},{project:"second"})]);
 assert.equal(page.total,1);assert.equal(check.ok,true);assert.equal(f.scans(),1);
});
test("fix5: startup failure restores a freshly checked kernel rather than null",async()=>{
 const f=await fixture("startup-rule"),list=f.vault.list;let first=true;
 f.vault.list=()=>{if(first){first=false;throw Error("snapshot failed");}return list();};
 const startup=(catalogs as any).startupRulebookCatalog;
 assert.equal(typeof startup,"function");
 const kernel=await startup(f.vault,{project:null,active:[],floors:async()=>[]});
 assert.equal(kernel.fallback,true);assert.match(kernel.entries[0].body,/Secret fixture body/);
});
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

test("fix5: IDs expire after thirty seconds and cannot render a kernel",async t=>{
 const f=await fixture("age-bound"),opts={project:null,active:[],floors:async()=>[]};
 await catalogs.cachedRulebookCatalog(f.vault,opts);
 await writeFile(f.path,f.raw.replace("scope: all-projects","sensitivity: private\nscope: all-projects"));
 const now=Date.now();t.mock.method(Date,"now",()=>now+30001);
 assert.equal((await catalogs.cachedRulebookCatalog(f.vault,{...opts,mode:"ids"})).entries.length,0);
 await writeFile(f.path,f.raw);f.event();
 const ids=await catalogs.cachedRulebookCatalog(f.vault,{...opts,mode:"ids"});
 const {renderRuleKernel}=await import("../src/rule-kernel.js");
 assert.throws(()=>renderRuleKernel(ids,{trigger:"fixture"}),/IDs.only/);
 await writeFile(f.path,f.raw.replace("scope: all-projects","sensitivity: private\nscope: all-projects"));f.event();
 assert.equal((await catalogs.cachedRulebookCatalog(f.vault,{...opts,mode:"ids"})).entries.length,0,"events immediately invalidate even young ID snapshots");
});
test("fix5: shared bytes retain independent floor and active membership projections",async()=>{
 const f=await fixture("projection-rule"),raw=f.raw.replace("rulebook: always\n","");
 await writeFile(f.path,raw);
 const floor={memory_id:"projection-rule",condition:"fixture",reason:"Fixture",floored_at:"2026-10-30",last_affirmed:"2026-10-30"};
 const out=await Promise.all([
  catalogs.cachedRulebookCatalog(f.vault,{project:null,active:[{id:"projection-rule",revision:null,setAt:1}],floors:async()=>[]}),
  catalogs.cachedRulebookCatalog(f.vault,{project:null,active:[],floors:async()=>[floor]}),
  catalogs.cachedRulebookCatalog(f.vault,{project:null,active:[],floors:async()=>[]})
 ]);
 assert.equal(f.scans(),1);assert.equal(out[0].entries[0].group,"active-convention");assert.equal(out[1].entries[0].group,"floor");assert.equal(out[2].entries.length,0);
});
test("fix5: startup fallback never exports cached text from a newly private source",async()=>{
 const f=await fixture("fallback-private"),list=f.vault.list;let first=true;
 await writeFile(f.path,f.raw.replace("scope: all-projects","sensitivity: private\nscope: all-projects"));
 f.vault.list=()=>{if(first){first=false;throw Error("snapshot failed");}return list();};
 const c=await catalogs.startupRulebookCatalog(f.vault,{project:null,active:[],floors:async()=>[]});
 assert.equal(c.fallback,true);assert.equal(c.entries.length,0);assert.doesNotMatch(JSON.stringify(c),/Secret/);
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

test("fix5: an event during a projection cannot publish the old privacy view",async()=>{
 const f=await fixture("projection-event");let once=false;
 const c=await catalogs.cachedRulebookCatalog(f.vault,{project:null,active:[],floors:async()=>{
  if(!once){once=true;await writeFile(f.path,f.raw.replace("scope: all-projects","sensitivity: private\nscope: all-projects"));f.event();}
  return [];
 }});
 assert.equal(c.entries.length,0);assert.doesNotMatch(JSON.stringify(c),/Secret/);
});

test("fix5: repeated invalidation obeys its budget and stops projection retries",{timeout:1000},async()=>{
 const f=await fixture("event-storm");let projections=0;
 await assert.rejects(catalogs.cachedRulebookCatalog(f.vault,{project:null,active:[],budgetMs:50,floors:async()=>{projections++;f.event();return [];}}),/rulebook_catalog_timeout/);
 await new Promise(r=>setTimeout(r,10));const stopped=projections;
 await new Promise(r=>setTimeout(r,20));assert.equal(projections,stopped);
});
