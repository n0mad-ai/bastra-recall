import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, type EmbeddingProvider } from "@bastra-recall/core";
import { draftNovelTokens, recordDraftHints, recordDraftUse, draftUseProof } from "../src/draft-use.js";
import { ACTED_ON_WINDOW_MS } from "../src/telemetry-join-state.js";
import { captureDraft, listDrafts, draftFingerprint, draftId, transactDrafts, type Draft } from "../src/draft-store.js";
import { runDraftPromote, draftVaultId, undoDraftPromotion } from "../src/draft-promote.js";
import { runDraftShadow } from "../src/draft-shadow.js";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { reportHinted } from "../src/hook-hinted.js";
const local={baseURL:"http://127.0.0.1:11434",model:"fixture"};
const quote="The spectrometer calibration uses packet7.conf and tungsten reference lamps";
const clock=Date.now();
async function isolated(fn:(vault:Vault,row:Draft,dir:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"bastra-e-use-")),root=join(dir,"vault");await mkdir(root);
 const env={BASTRA_DRAFTS_PATH:join(dir,"drafts.json"),BASTRA_VAULT_PATH:root,BASTRA_LOG_PATH:join(dir,"logs"),BASTRA_HOOK_STATE_DIR:join(dir,"sessions"),BASTRA_DRAFT_HINTS:"1",BASTRA_DRAFT_PROMOTE:"1",BASTRA_TELEMETRY:"0"};
 const previous=new Map(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 const vault=new Vault(root);await vault.init();const fp=draftFingerprint(quote);
 const row:Draft={id:draftId("origin",0,fp),fp,quote,kind:"typed",vault_id:await draftVaultId(root),evidence:[{session_id:"origin",turn:0,ts:clock}],created:clock,last_touched:clock,state:"open",surfaced:[],context:"How do we calibrate the fixture instrument?",situation:{before:["cat secret-before9.cfg"],after:["cat packet7.conf"],reads:[],lits:["cat","packet7.conf"]}};
 await captureDraft(row,clock);
 try{await fn(vault,row,dir);}finally{await vault.stop();for(const[k,v]of previous)if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
const provider:EmbeddingProvider={id:"ollama-fixture",dim:2,embed:async texts=>texts.map(()=>new Float32Array([1,0]))};
function options(vault:Vault){return{vault,provider,ollama:local,vaultVectors:()=>({provider:provider.id,dim:2,vectors:new Map(vault.list().map(n=>[n.fm.id,new Float32Array([0,1])]))})};}
async function hinted(row:Draft,input="spectrometer calibration",session="reader"){return recordDraftHints([row.id],session,input,clock+10);}
async function acted(excerpt="cat packet7.conf",session="reader",exitCode:number|null=0,now=clock+20){return recordDraftUse({sessionId:session,toolName:"Bash",excerpt,exitCode,now});}
async function tree(root:string):Promise<unknown>{return Promise.all((await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)).map(async e=>[e.name,e.isDirectory()?await tree(join(root,e.name)):(await readFile(join(root,e.name))).toString("hex")]));}

test("E novel tokens use quote/after commands, exclude input and never before commands",()=>isolated(async(_v,row)=>{
 const novel=draftNovelTokens(row,"spectrometer calibration packet7.conf");
 assert.ok(!novel.includes("packet7.conf"));assert.ok(!novel.includes("secret-before9.cfg"));assert.ok(novel.includes("tungsten"));
}));
test("E one displayed draft and later successful novel literal promote exactly one audited use note",()=>isolated(async(vault,row)=>{
 assert.equal(await hinted(row),1);assert.equal(await acted(),1);assert.equal(vault.size(),0,"hook only books local evidence");
 await runDraftShadow({provider,ollama:local,vault});assert.equal((await runDraftPromote(options(vault))).promoted,1);
 const note=vault.list()[0];assert.deepEqual(note.fm.tags,["derived"]);assert.equal(note.fm.write_origin,"capture-review");assert.match(note.body,/derived from successful use/);assert.match(note.body,/Use evidence:/);assert.match(note.body,/session reader/);
 assert.equal((await runDraftPromote(options(vault))).promoted,0);assert.equal(vault.size(),1);
 assert.match(await readFile(join(vault.root,".bastra/audit-log.ndjson"),"utf8"),/draft:use-promotion/);
}));
test("E triggering literal already present cannot count as use",()=>isolated(async(_v,row)=>{
 await hinted(row,"spectrometer calibration packet7.conf");assert.equal(await acted(),0);assert.equal(draftUseProof((await listDrafts())[0]),undefined);
}));
test("E origin, parallel session and missing session cannot open/close use proof",()=>isolated(async(_v,row)=>{
 assert.equal(await hinted(row,"calibration","origin"),0);assert.equal(await recordDraftHints([row.id],null,"calibration",clock),0);
 await hinted(row);assert.equal(await acted("cat packet7.conf","parallel"),0);assert.equal(await acted("cat packet7.conf","origin"),0);
}));
test("E nonzero/unknown exit, earlier/same timestamp and expired window do not qualify",()=>isolated(async(_v,row)=>{
 await hinted(row);
 for(const [exit,at]of [[1,clock+20],[null,clock+20],[0,clock+9],[0,clock+10],[0,clock+11+ACTED_ON_WINDOW_MS]] as const)assert.equal(await acted("cat packet7.conf","reader",exit,at),0);
 assert.equal(await acted(),1);
}));
test("E requires three distinct novel words or one exact technical literal, without substring matches",()=>isolated(async(_v,row)=>{
 await hinted(row);assert.equal(await acted("cat prefix-packet7.conf"),0);assert.equal(await acted("echo tungsten lamps"),0);
 assert.equal(await acted("echo tungsten tungsten lamps"),0);assert.equal(await acted("echo tungsten reference lamps"),1);
}));
test("E replay cannot reset novel/window and each successful use is booked once",()=>isolated(async(_v,row)=>{
 await hinted(row,"calibration packet7.conf");const before=JSON.stringify((await listDrafts())[0].surfaced);
 assert.equal(await recordDraftHints([row.id],"reader","different",clock+100),0);assert.equal(JSON.stringify((await listDrafts())[0].surfaced),before);
 assert.equal(await acted(),0);assert.equal(await acted("echo tungsten reference lamps"),1);assert.equal(await acted("echo tungsten reference lamps"),0);
}));
test("E dry-run preserves vault and draft bytes despite valid use",()=>isolated(async(vault,row)=>{
 await hinted(row);await acted();await runDraftShadow({provider,ollama:local,vault});delete process.env.BASTRA_DRAFT_PROMOTE;
 const before=await tree(vault.root),draft=await readFile(process.env.BASTRA_DRAFTS_PATH!,"utf8");
 const result=await runDraftPromote(options(vault));assert.equal(result.wouldPromote,1);assert.deepEqual(await tree(vault.root),before);assert.equal(await readFile(process.env.BASTRA_DRAFTS_PATH!,"utf8"),draft);
}));
test("E existing semantic note and undo tombstone prevent another use note",()=>isolated(async(vault,row)=>{
 await hinted(row);await acted();await runDraftShadow({provider,ollama:local,vault});await runDraftPromote(options(vault));
 await undoDraftPromotion(vault,row.id);
 const other={...row,id:draftId("other-origin",0,draftFingerprint(quote+" differently")),fp:draftFingerprint(quote+" differently"),quote:quote+" differently",evidence:[{session_id:"other-origin",turn:0,ts:clock}],surfaced:[]};
 await captureDraft(other,clock+100);await recordDraftHints([other.id],"other-reader","calibration",clock+110);await acted("cat packet7.conf","other-reader",0,clock+120);await runDraftShadow({provider,ollama:local,vault});
 assert.equal((await runDraftPromote(options(vault))).promoted,0);assert.equal(vault.size(),0);
}));
test("E missing/cloud provider and foreign vault provenance keep use in probe",()=>isolated(async(vault,row)=>{
 await hinted(row);await acted();await runDraftShadow({provider,ollama:local,vault});
 assert.equal((await runDraftPromote({...options(vault),provider:null})).promoted,0);
 assert.equal((await runDraftPromote({...options(vault),provider:{...provider,id:"openai-fixture"}})).promoted,0);
 await transactDrafts(async rows=>{rows[0].vault_id="f".repeat(64);});assert.equal((await runDraftPromote(options(vault))).promoted,0);assert.equal(vault.size(),0);
}));
test("E persisted proof cannot rely on absent or fabricated novel matches",()=>isolated(async(_v,row)=>{
 await hinted(row);await transactDrafts(async rows=>{rows[0].surfaced[0].used={ts:clock+20,tool:"Bash",exit_code:0,matched:["never-novel.cfg"]};});
 assert.equal(draftUseProof((await listDrafts())[0]),undefined);
}));
test("E redaction markers never become novel evidence",()=>isolated(async(_v,row)=>{
 row.quote="The fixture password is [REDACTED] and the prefix is x[REDACTED]y";const novel=draftNovelTokens(row,"fixture");
 assert.ok(!novel.some(word=>word.includes("redacted")));
}));

test("E actual hinted/act endpoints store separate drafts and preserve full triggering input",()=>isolated(async(vault,row)=>{
 const search=new SearchIndex(vault);search.start();const telemetry=new Telemetry();
 const server=await startHttpServer({port:0,vault,search,telemetry,version:"fixture",toolDeps:{vault,search,telemetry,vaultPath:vault.root},documentWriteEnabled:false,embedding:{on:false,providerId:null,source:"none"}});
 const url=`http://127.0.0.1:${server.port}`;
 try{
  await (await fetch(url+"/hook/recall",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:"spectrometer calibration",session_id:"reader"})})).json();
  await reportHinted(url,[],"reader",500,{ids:[row.id],input:"spectrometer calibration"});
  const response=await fetch(url+"/hook/act",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session_id:"reader",tool_name:"Bash",tool_input_excerpt:"cat packet7.conf",exit_code:0})});
  assert.equal(response.status,200);assert.equal((await response.json() as {drafts_used:number}).drafts_used,1);assert.equal(vault.size(),0);
  const longInput="x ".repeat(3000)+"packet7.conf";
  await (await fetch(url+"/hook/recall",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:"spectrometer calibration",session_id:"long-reader"})})).json();
  await reportHinted(url,[],"long-reader",500,{ids:[row.id],input:longInput});
  assert.equal(await acted("cat packet7.conf","long-reader",0,Date.now()+1),0,"input suffix must not be truncated into novelty");
 }finally{await server.close();search.stop();}
}));


test("E legacy duplicate novel words cannot manufacture the three-word quorum",()=>isolated(async(_v,row)=>{
 await hinted(row);await transactDrafts(async rows=>{rows[0].surfaced[0].novel=["tungsten","tungsten","lamps"];});
 assert.equal(await acted("echo tungsten lamps"),0);
}));
test("E foreign lock makes both feedback paths fail open without waiting",()=>isolated(async(_v,row)=>{
 await hinted(row);await writeFile(process.env.BASTRA_DRAFTS_PATH!+".lock","foreign fixture");
 const started=performance.now();assert.equal(await acted(),0);assert.equal(await recordDraftHints([row.id],"another","calibration",clock+30),0);
 assert.ok(performance.now()-started<500);assert.equal(draftUseProof((await listDrafts())[0]),undefined);
}));


test("E a private existing note in other words blocks used-draft promotion without leaking its id",()=>isolated(async(vault,row)=>{
 const path=join(vault.root,"private-fixture.md");
 await writeFile(path,"---\nid: private-existing-fixture\ntitle: A different private explanation\nsummary: Private fixture reference\ntype: project-fact\nscope: fixture\ntopic_path: [fixture]\ntags: [fixture]\nrecall_when: [private fixture reference]\nsensitivity: private\ncreated: 2026-10-08\nupdated: 2026-10-08\n---\nA differently worded fixture explanation.\n");await vault.reindexFile(path);
 await hinted(row);await acted();await runDraftShadow({provider,ollama:local,vault});
 const events:unknown[]=[];
 const result=await runDraftPromote({...options(vault),emit:event=>events.push(event),vaultVectors:()=>({provider:provider.id,dim:2,vectors:new Map(vault.list().map(n=>[n.fm.id,new Float32Array([1,0])]))})});
 assert.equal(result.promoted,0);assert.equal(result.duplicates,1);assert.equal(vault.size(),1);assert.ok(!JSON.stringify(events).includes("private-existing-fixture"));
}));

test("E an after-command literal qualifies while a before-command literal does not",()=>isolated(async(_v,row)=>{
 await transactDrafts(async rows=>{rows[0].situation.after=["cat after-only9.cfg"];});await hinted(row);
 assert.equal(await acted("cat secret-before9.cfg"),0);assert.equal(await acted("cat after-only9.cfg"),1);
}));
