import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDraftNotice } from "../src/draft-notice.js";
import { upsertDraft, listDrafts, draftId, draftFingerprint, expireDrafts, DRAFT_UNCONFIRMED_AGE_MS, type Draft } from "../src/draft-store.js";
import { aggregateDrafts, renderDrafts } from "../src/draft-stats.js";
import { aggregate, renderStats } from "../src/cli/log-stats.js";
const key="abcdef123456",memory="draft-"+key;
const entry={title:"Fixture deployment needs a tunnel",type:"project-fact",source:"draft:"+key,write_origin:"capture-review",sensitivity:"team"};
async function isolated(fn:(row:Draft,dir:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"bastra-f-notice-"));const env={BASTRA_DRAFTS_PATH:join(dir,"drafts.json"),BASTRA_LOG_PATH:join(dir,"logs"),BASTRA_SAVE_NOTICE:"1",BASTRA_TELEMETRY:"0"};const previous=new Map(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 const now=Date.now(),fp=draftFingerprint("A fictional deployment uses its tunnel");const row:Draft={id:draftId("origin",0,fp),fp,kind:"typed",quote:"A fictional deployment uses its tunnel",situation:{before:[],after:[],reads:[],lits:[]},evidence:[{session_id:"origin",turn:0,ts:now}],created:now,last_touched:now,state:"promoted",memory_id:memory,evidence_key:key,announce:true,surfaced:[]};
 await upsertDraft(row);try{await fn(row,dir);}finally{for(const[k,v]of previous)if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
const payload={hook_event_name:"PostToolUse",bastra_client:"claude-code"} as const;
test("F one saved memory with two draft rows gets one line across concurrent hooks",()=>isolated(async(row)=>{
 await upsertDraft({...row,id:draftId("other",0,row.fp),evidence:[{session_id:"other",turn:0,ts:row.created}]});
 const outputs=await Promise.all(Array.from({length:8},()=>appendDraftNotice('{"hookSpecificOutput":{"additionalContext":"kept"}}',payload,()=>entry,async()=>"de")));
 const shown=outputs.filter(out=>JSON.parse(out).systemMessage);assert.equal(shown.length,1);assert.match(JSON.parse(shown[0]).systemMessage,/aus Entwurf gespeichert/);
 assert.equal(JSON.parse(shown[0]).hookSpecificOutput.additionalContext,"kept");assert.ok((await listDrafts()).every(d=>d.announce===false));
 assert.equal(await appendDraftNotice("{}",payload,()=>entry),"{}");
}));
test("F Codex is plain, Claude uses the existing badge; an earlier system line stays",()=>isolated(async()=>{
 const out=JSON.parse(await appendDraftNotice('{"systemMessage":"earlier"}',{hook_event_name:"Stop",bastra_client:"codex"},()=>entry,async()=>"en"));
 assert.match(out.systemMessage,/^earlier\nbastra-recall saved from draft:/);assert.ok(!out.systemMessage.includes("\x1b"));
}));
test("F off, subagent, wrong event, missing/private/foreign note never consume a notice",()=>isolated(async()=>{
 process.env.BASTRA_SAVE_NOTICE="off";assert.equal(await appendDraftNotice("{}",payload,()=>entry),"{}");process.env.BASTRA_SAVE_NOTICE="1";
 for(const [p,lookup]of [[{...payload,agent_id:"worker"},()=>entry],[{...payload,hook_event_name:"PreToolUse"},()=>entry],[payload,()=>undefined],[payload,()=>({...entry,source:"manual"})]] as const)assert.equal(await appendDraftNotice("{}",p,lookup),"{}");
 assert.equal((await listDrafts())[0].announce,true);
}));
test("F malformed output and a foreign lock leave baseline bytes and receipt intact",()=>isolated(async()=>{
 assert.equal(await appendDraftNotice("not JSON",payload,()=>entry),"not JSON");
 await writeFile(process.env.BASTRA_DRAFTS_PATH!+".lock","foreign fixture");assert.equal(await appendDraftNotice(" { } ",payload,()=>entry)," { } ");assert.equal((await listDrafts())[0].announce,true);
}));
test("F expiry records committed removals once without text",()=>isolated(async(row,dir)=>{
 process.env.BASTRA_TELEMETRY="1";const now=Date.now();await upsertDraft({...row,state:"open",announce:false,last_touched:now-DRAFT_UNCONFIRMED_AGE_MS-1},now-DRAFT_UNCONFIRMED_AGE_MS-1);
 await expireDrafts({now});await expireDrafts({now});
 let rows:Record<string,unknown>[]=[];const file=join(dir,"logs",`events-${new Date().toISOString().slice(0,10)}.jsonl`);
 for(let i=0;i<100;i++){rows=(await readFile(file,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));if(rows.length)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(rows.filter(e=>e.kind==="draft_expired").reduce((n,e)=>n+Number(e.count),0),1);assert.ok(!JSON.stringify(rows).includes("fictional deployment"));
}));
test("F lifecycle stats separate recorded notes, deliveries and dry decisions",()=>{
 const events=[{kind:"session_harvest",draft_count:4,draft_evidence_count:2,draft_evicted_count:1,draft_error:true},{kind:"draft_expired",count:3},{kind:"draft_hint",draft_count:2},{kind:"draft_promoted",draft_ids:["d-a","d-b"]},{kind:"draft_would_promote"},{kind:"draft_duplicate_blocked"},{kind:"draft_would_block",reason:"existing-note-or-quote-tombstone"},{kind:"draft_would_block",reason:"routine-vocabulary"},{kind:"draft_notice",count:1}];
 const stats=aggregateDrafts(events)!;assert.equal(stats.captured,4);assert.equal(stats.expired,3);assert.equal(stats.promoted,1);assert.equal(stats.shown,2);assert.equal(stats.wouldPromote,1);assert.equal(stats.duplicateBlocked,1);assert.equal(stats.wouldDuplicateBlock,1);assert.equal(stats.captureErrors,1);
 assert.match(renderStats(aggregate(events),500),/promoted 1, would promote 1/);assert.equal(aggregateDrafts([{kind:"session_harvest",candidate_count:4}]),null);assert.deepEqual(renderDrafts(null),[]);
});

test("F a new process observes the consumed promotion receipt",()=>isolated(async()=>{
 const {spawnSync}=await import("node:child_process");
 const notice=new URL("../src/draft-notice.ts",import.meta.url).href,store=new URL("../src/draft-store.ts",import.meta.url).href;
 const code=`const {listDrafts}=await import(${JSON.stringify(store)});const {appendDraftNotice}=await import(${JSON.stringify(notice)});await listDrafts();console.log(await appendDraftNotice('{}',{hook_event_name:'Stop',bastra_client:'codex'},()=>(${JSON.stringify(entry)}),async()=>'en'));`;
 const run=()=>spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",code],{env:process.env,encoding:"utf8"});
 const first=run();assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/saved from draft/);
 const second=run();assert.equal(second.status,0,second.stderr);assert.equal(second.stdout.trim(),"{}");
}));
test("F actual post-tool route delivers a pending line once for Codex",()=>isolated(async(_row,dir)=>{
 const {Vault,SearchIndex}=await import("@bastra-recall/core"),{startHttpServer}=await import("../src/http.js"),{Telemetry}=await import("../src/telemetry.js");
 const root=join(dir,"vault");const {mkdir}=await import("node:fs/promises");await mkdir(root);
 const vault=new Vault(root);await vault.init();const search=new SearchIndex(vault);search.start();const telemetry=new Telemetry();
 const {draftVaultId,runDraftPromote}=await import("../src/draft-promote.js"),{runDraftShadow}=await import("../src/draft-shadow.js");
 await upsertDraft({..._row,state:"open",announce:false,memory_id:undefined,evidence_key:undefined,vault_id:await draftVaultId(root),evidence:[..._row.evidence,{session_id:"second",turn:0,ts:_row.created}]});
 const provider={id:"ollama-fixture",dim:2,embed:async(texts:string[])=>texts.map(()=>new Float32Array([1,0]))},ollama={baseURL:"http://127.0.0.1:11434",model:"fixture"};
 await runDraftShadow({provider,ollama,vault});const previous=process.env.BASTRA_DRAFT_PROMOTE;process.env.BASTRA_DRAFT_PROMOTE="1";
 try{assert.equal((await runDraftPromote({provider,ollama,judge:{model:"fixture-chat",chat:async()=>"durable"},vault,vaultVectors:()=>({provider:provider.id,dim:2,vectors:new Map()})})).promoted,1);}finally{if(previous===undefined)delete process.env.BASTRA_DRAFT_PROMOTE;else process.env.BASTRA_DRAFT_PROMOTE=previous;}
 const server=await startHttpServer({port:0,vault,search,telemetry,version:"fixture",toolDeps:{vault,search,telemetry,vaultPath:root},documentWriteEnabled:false,embedding:{on:false,providerId:null,source:"none"}});
 try{const post=()=>fetch(`http://127.0.0.1:${server.port}/hook/bash-fail`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({payload:{hook_event_name:"PostToolUse",bastra_client:"codex",session_id:"reader",tool_name:"Bash",tool_input:{command:"echo fixture"},tool_response:{exit_code:0}}})});
 const first=await post(),body=await first.json() as {systemMessage?:string};assert.equal(first.status,200);assert.match(body.systemMessage??"",/bastra-recall/);assert.ok(!body.systemMessage!.includes("\x1b"));
 const second=await post();assert.equal((await second.json() as {systemMessage?:string}).systemMessage,undefined);
 }finally{await server.close();search.stop();await vault.stop();}
}));

test('notice skips a busy local writer rather than queuing the hook response',()=>isolated(async()=>{
 const {withPathLock}=await import('../src/path-lock.js');let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);const writer=withPathLock(process.env.BASTRA_DRAFTS_PATH!,async()=>{entered();await new Promise<void>(r=>release=r);});await ready;
 let result:string|undefined;const pending=appendDraftNotice('{}',payload,()=>entry,async()=>'en').then(out=>result=out);
 try{await new Promise(r=>setImmediate(r));assert.equal(result,'{}');assert.equal((await listDrafts())[0].announce,true);}finally{release();await writer;await pending;}
}));
test('a private pending note is permanently retired without announcing',()=>isolated(async()=>{
 assert.equal(await appendDraftNotice('{}',payload,()=>({...entry,sensitivity:'private'}),async()=>'en'),'{}');assert.equal((await listDrafts())[0].announce,false);
}));
test('disconnected clients never consume a notice before claim',()=>isolated(async()=>{
 const out=await appendDraftNotice('{}',payload,()=>entry,async()=>'en',()=>false);assert.equal(out,'{}');assert.equal((await listDrafts())[0].announce,true);
}));
test('undo has its own recorded counter',()=>{const stats=aggregateDrafts([{kind:'draft_undone',count:1}]);assert.equal(stats?.undone,1);});
