import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import fs,{mkdtemp,rm} from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {parseMemory,type VaultEvent} from "@bastra-recall/core";
import {readRulebookSources,vaultConventionOf} from "../src/convention-source.js";
import {vaultRevisionOf} from "../src/prompt-task.js";
import {runGateLane} from "../src/gate-lane.js";
import {loadSessionState} from "../src/session-state.js";
import {cachedRulebookCatalog,collectRulebookCatalog} from "../src/rulebook-catalog.js";
import {renderRuleKernel} from "../src/rule-kernel.js";
let root:string;
const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const opts={project:null,active:[],floors:async()=>[]};
before(async()=>{root=await mkdtemp(join(tmpdir(),"hook-index-sources-"));process.env.BASTRA_HOOK_STATE_DIR=join(root,"state");process.env.BASTRA_TELEMETRY="off";});
after(()=>rm(root,{recursive:true,force:true}));
function fixture(){
 const m=parseMemory(`---\nid: fixture-rule\ntitle: Fixture\nsummary: Indexed summary\ntype: workflow\nscope: all-projects\nwrite_origin: user-directed\nrulebook: always\napplies_when: Fixture\nrecall_mode: reflex\nsalience: 0.9\ntags: []\ntopic_path: [fixture]\nrecall_when: [fixture_send_message]\nvalidator: {tool: validate_artifact, channel: fixture, limit: 100, unit: utf16}\n---\nIndexed rule body`,join(root,"blocked-rule.md"),0);
 m.revision="sha256:indexed-fixture";
 let fire=()=>{};
 return {m,vault:{get:(id:string)=>id===m.fm.id?m:undefined,list:()=>[m],on:(fn:(e:VaultEvent)=>void)=>{fire=()=>fn({kind:"change",memory:m});return ()=>{};}},fire:()=>fire()};
}
function block(t:any,path:string){
 let reads=0;const original=fs.readFile;
 t.mock.method(fs,"readFile",(...args:any[])=>{if(args[0]===path){reads++;return new Promise(()=>{});}return (original as any)(...args);});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});return ()=>reads;
}
test("fix8: recall hint sources use indexed revision, metadata and privacy with a hung rule file",async t=>{
 const f=fixture(),reads=block(t,f.m.filePath);
 const out=await Promise.race([readRulebookSources(f.vault,[f.m.fm.id]),wait(120).then(()=>null)]);
 assert.ok(out,"hint projection must not wait for rule-file IO");
 const source=out.get(f.m.fm.id)!;
 assert.equal(source.revision,f.m.revision);assert.equal(source.summary,f.m.fm.summary);assert.deepEqual(source.validator,f.m.fm.validator);
 assert.equal(source.rulebookMetadata?.rulebook,"always");assert.equal(reads(),0);
 f.m.fm.sensitivity="private";f.fire();
 assert.equal((await readRulebookSources(f.vault,[f.m.fm.id])).get(f.m.fm.id)?.hiddenFromPublic,true);
});
test("fix8: prompt convention/revision adapters and reflex gate never reopen the matched rule",async t=>{
 const f=fixture(),reads=block(t,f.m.filePath);
 const result=await Promise.race([(async()=>{
  assert.equal(await vaultRevisionOf(f.vault)(f.m.fm.id),f.m.revision);
  assert.deepEqual((await vaultConventionOf(f.vault)(f.m.fm.id)).validator,f.m.fm.validator);
  return runGateLane({session_id:"indexed-reflex",bastra_client:"claude-code",hook_event_name:"PreToolUse",tool_name:"fixture_send_message",tool_input:{}},{reflexPool:()=>[f.m]});
 })(),wait(150).then(()=>null)]);
 assert.ok(result,"hook adapters must not block on rule-file IO");assert.match(result,/deny/);
 assert.equal((await loadSessionState("indexed-reflex")).activeConventions?.[0].revision,f.m.revision);assert.equal(reads(),0);
});
test("fix8: direct catalog queries cannot invalidate concurrent hook projections",async()=>{
 const f=fixture();let queries=0,stop=false;
 const flood=(async()=>{while(!stop){await collectRulebookCatalog(f.vault,opts);queries++;await wait(10);}})();
 try{
  const result=await Promise.all(Array.from({length:4},()=>cachedRulebookCatalog(f.vault,{...opts,budgetMs:100,floors:async()=>{await wait(25);return [];}}).then(()=>true,()=>false)));
  assert.ok(queries>1);assert.ok(result.every(Boolean),"read-only queries must not bump the index generation");
 }finally{stop=true;await flood;}
});
test("fix8: an empty always body is valid, not an unavailable source or overflow",async()=>{
 const f=fixture();f.m.body="";
 const c=await cachedRulebookCatalog(f.vault,opts),r=renderRuleKernel(c,{trigger:"fixture"});
 assert.equal(c.unavailable_sources,0);assert.equal(c.entries[0].source_unavailable,undefined);
 assert.doesNotMatch(r.text,/source check incomplete|Always overflow/);assert.deepEqual(r.always_overflow,[]);
});

test("fix8: real /hook/recall returns indexed hints despite a blocked rule source",{timeout:3000},async t=>{
 const {Vault,SearchIndex,saveMemory,memoryRevision}=await import("@bastra-recall/core");
 const {Telemetry}=await import("../src/telemetry.js");
 const {startHttpServer}=await import("../src/http.js");
 const dir=await mkdtemp(join(root,"http-"));
 const file=await saveMemory(dir,{id:"http-rule",title:"Invented fixture convention",summary:"Fixture source",body:"Complete fixture body",type:"workflow",scope:"all-projects",tags:["fixture"],topic_path:["fixture"],recall_when:["fixture source"],write_origin:"user-directed",rulebook:"always",applies_when:"When inspecting fixtures"});
 const vault=new Vault(dir);await vault.init();const search=new SearchIndex(vault);search.start();
 const deps={vault,search,telemetry:new Telemetry(),vaultPath:dir};
 const http=await startHttpServer({port:0,vault,search,telemetry:deps.telemetry,version:"fixture",toolDeps:deps,documentWriteEnabled:false,embedding:{on:false,providerId:null,source:"none"}});
 t.after(async()=>{await http.close();search.stop();await vault.stop();});
 const bytes=await fs.readFile(file.file_path,"utf8"),reads=block(t,file.file_path);
 const response=await fetch(`http://127.0.0.1:${http.port}/hook/recall`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"fixture source",k:5,convention_revisions:true,lexical_only:true}),signal:AbortSignal.timeout(500)});
 assert.equal(response.status,200);const payload=await response.json() as any;
 const hit=payload.hits.find((h:any)=>h.id==="http-rule");assert.ok(hit);
 assert.equal(hit.revision,memoryRevision(bytes));assert.equal(hit.rulebook,"always");assert.equal(reads(),0);
});
