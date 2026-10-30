import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import fs,{mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Vault,parseMemory,memoryRevision,type Memory,type VaultEvent} from "@bastra-recall/core";
import {cachedRulebookCatalog,startupRulebookCatalog,listRulesHandler,rulebookPage} from "../src/rulebook-catalog.js";
import {rulebookCheckHandler} from "../src/rulebook-check.js";
import {renderRuleKernel} from "../src/rule-kernel.js";
let root:string;
const opts={project:null,active:[],floors:async()=>[]};
const raw=(id:string)=>`---\nid: ${id}\ntitle: Fixture\nsummary: Fixture\ntype: workflow\nscope: all-projects\nwrite_origin: user-directed\nrulebook: always\napplies_when: Fixture\ntags: []\ntopic_path: [fixture]\nrecall_when: [fixture]\n---\nComplete indexed body ${id}`;
before(async()=>{root=await mkdtemp(join(tmpdir(),"rulebook-index-"));process.env.BASTRA_HOOK_STATE_DIR=join(root,"state");process.env.BASTRA_TELEMETRY="off";});
after(()=>rm(root,{recursive:true,force:true}));
function fixture(count=1){
 let memories=Array.from({length:count},(_,i)=>parseMemory(raw(`rule-${i}`),join(root,`rule-${i}.md`),0));
 let scans=0,fire=()=>{};
 const vault={get:(id:string)=>memories.find(m=>m.fm.id===id),list:()=>{scans++;return memories;},on:(fn:(e:VaultEvent)=>void)=>{fire=()=>fn({kind:"change",memory:memories[0]});return ()=>{};}};
 return {vault,scans:()=>scans,fire:()=>fire(),set:(next:Memory[])=>{memories=next;fire();},all:()=>memories};
}
test("fix7: index alone supplies the complete catalog and kernel with all disk reads blocked",async t=>{
 const f=fixture(1500);let reads=0;
 t.mock.method(fs,"readFile",()=>{reads++;return Promise.reject(Error("fixture unavailable disk"));});
 for(const mode of ["ids","content"] as const){
  const out=await Promise.all(Array.from({length:4},()=>cachedRulebookCatalog(f.vault,{...opts,mode,budgetMs:150})));
  assert.ok(out.every(c=>c.entries.length===1500));
  if(mode==="content")assert.match(renderRuleKernel(out[0],{trigger:"fixture"}).text,/Complete indexed body/);
  else {assert.doesNotMatch(JSON.stringify(out),/Complete indexed body|Fixture/);assert.throws(()=>rulebookPage(out[0]),/IDs.only/);assert.throws(()=>renderRuleKernel(out[0],{trigger:"fixture"}),/IDs.only/);}
 }
 assert.equal(reads,0);assert.equal(f.scans(),1);
 assert.equal((await listRulesHandler({vault:f.vault} as any,{})).total,1500);
 assert.equal((await startupRulebookCatalog(f.vault,opts)).entries.length,1500);
});
test("fix7: index refresh updates authority, metadata, scope, privacy and membership together",async()=>{
 const f=fixture(),first=await cachedRulebookCatalog(f.vault,opts);
 const m=parseMemory(raw("rule-0").replace("Fixture\ntags", "Changed condition\ntags"),"",0);
 m.body="Changed indexed body";f.set([m]);
 const fresh=await cachedRulebookCatalog(f.vault,opts);
 assert.notEqual(fresh.catalog_hash,first.catalog_hash);assert.equal(fresh.entries[0].applies_when,"Changed condition");
 assert.equal(fresh.entries[0].body,"Changed indexed body");
 m.fm.sensitivity="private";f.set([m]);assert.equal((await cachedRulebookCatalog(f.vault,opts)).entries.length,0);
});
test("fix7: vault indexing preserves rule fields, body and exact byte revision across reindex/reconcile",async t=>{
 const path=join(root,"indexed.md"),text=raw("indexed");await writeFile(path,text);
 const vault=new Vault(root);await vault.init();t.after(()=>vault.stop());
 assert.equal((vault.get("indexed") as any)?.revision,memoryRevision(text));
 const c=await cachedRulebookCatalog(vault,opts);assert.equal(c.entries[0].revision,memoryRevision(text));
 const changed=text.replace("Complete indexed body", "Changed complete indexed body");await writeFile(path,changed);await vault.reconcile();
 const refreshed=await cachedRulebookCatalog(vault,opts);
 assert.equal(refreshed.entries[0].revision,memoryRevision(changed));assert.match(refreshed.entries[0].body,/Changed complete/);
 const privateText=changed.replace("scope: all-projects","sensitivity: private\nscope: all-projects");
 await writeFile(path,privateText);await vault.reindexFile(path);
 assert.equal((await cachedRulebookCatalog(vault,opts)).entries.length,0);
});
test("fix7: an event during async floors cannot publish the old index privacy projection",async()=>{
 const f=fixture();let once=false;
 const c=await cachedRulebookCatalog(f.vault,{...opts,floors:async()=>{if(!once){once=true;const m={...f.all()[0],fm:{...f.all()[0].fm,sensitivity:"private" as const}};f.set([m]);}return [];}});
 assert.equal(c.entries.length,0);
});
test("fix7: event storms never restart disk scans or hide indexed rules",async()=>{
 const f=fixture(50);
 for(let n=0;n<20;n++){f.fire();const c=await cachedRulebookCatalog(f.vault,{...opts,mode:"ids",budgetMs:150});assert.equal(c.entries.length,50);}
});
test("fix7: empty body keeps its valid index row without an unavailable warning",async()=>{
 const f=fixture();f.all()[0].body="";
 const c=await cachedRulebookCatalog(f.vault,opts),r=renderRuleKernel(c,{trigger:"fixture"});
 assert.equal(c.entries.length,1);assert.equal(rulebookPage(c).rules[0].id,"rule-0");
 assert.equal(c.unavailable_sources,0);assert.doesNotMatch(r.text,/source check incomplete|Always overflow/);assert.match(r.text,/rule-0/);
});
test("fix7: a failed unknown-ID refresh returns the IDs answer rather than throwing",async()=>{
 let calls=0;
 const vault={get:()=>undefined,list:()=>{if(++calls===1)return [];throw Error("refresh unavailable");}};
 const result=await rulebookCheckHandler({vault} as any,{applicable:["missing"],session_id:"refresh-failure"});
 assert.equal(result.ok,false);assert.match(result.reason??"",/Unknown rule IDs/);assert.equal(calls,2);
});
test("fix7: startup fallback fits a small supplied budget",{timeout:1000},async()=>{
 const f=fixture(),start=performance.now();
 const c=await startupRulebookCatalog(f.vault,{...opts,budgetMs:70,floors:()=>new Promise(()=>{})});
 assert.equal(c.fallback,true);assert.equal(c.entries.length,1);assert.match(c.entries[0].body,/Complete indexed body/);assert.ok(performance.now()-start<180);
});


test("fix7: shared index views preserve independent scope/floor/active projections",async()=>{
 const f=fixture();delete f.all()[0].fm.rulebook;
 const floor={memory_id:"rule-0",condition:"fixture",reason:"Fixture",floored_at:"2026-10-30",last_affirmed:"2026-10-30"};
 const [active,pinned,plain]=await Promise.all([
  cachedRulebookCatalog(f.vault,{...opts,project:"first",active:[{id:"rule-0",revision:null,setAt:1}]}),
  cachedRulebookCatalog(f.vault,{...opts,project:"second",floors:async()=>[floor]}),
  cachedRulebookCatalog(f.vault,{...opts,project:"third"})
 ]);
 assert.equal(f.scans(),1);assert.equal(active.entries[0].group,"active-convention");assert.equal(pinned.entries[0].group,"floor");assert.equal(plain.entries.length,0);
});
