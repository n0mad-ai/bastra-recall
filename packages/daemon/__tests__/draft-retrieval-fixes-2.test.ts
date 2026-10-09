import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDraftSearch, appendLaneDrafts } from "../src/draft-search.js";
import { captureDrafts, listDrafts, draftFingerprint, draftId, type Draft } from "../src/draft-store.js";
import { draftRetrievalCorpus } from "./fixtures/draft-retrieval-corpus.js";
import { independentDraftCorpus } from "./fixtures/draft-retrieval-independent.js";
import { tokens } from "../src/save-similarity.js";
import { draftVocabularySnapshot, startDraftVocabulary } from "../src/draft-vocabulary.js";
import type { Vault, VaultEvent } from "@bastra-recall/core";
import { captureTypedDrafts } from "../src/draft-capture.js";

function row(quote: string, i = 0, lits: string[] = []): Draft {
  const fp = draftFingerprint(quote);
  return { id: draftId(`origin-${i}`, i, fp), fp, quote, kind: "typed", evidence: [{ session_id: `origin-${i}`, turn: i, ts: Date.now() }],
    created: Date.now(), last_touched: Date.now(), state: "open", surfaced: [], situation: { before: [], after: [], reads: [], lits } };
}
async function isolated(fn: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-c-review-2-"));
  const env = { BASTRA_DRAFTS_PATH: join(dir,"drafts.json"), BASTRA_HOOK_STATE_DIR: join(dir,"sessions"), BASTRA_DRAFT_HINTS:"1", BASTRA_TELEMETRY:"0" };
  const prior = new Map(Object.keys(env).map(k=>[k,process.env[k]])); Object.assign(process.env,env);
  try { await fn(); } finally { for (const [k,v] of prior) if(v===undefined)delete process.env[k];else process.env[k]=v; }
}

test("C2 vault vocabulary rejects common linguistic anchors; empty vault limit remains explicit", () => {
  const rows = [row("germination tests are repeated every three years")];
  const vocabulary = { count: 150, df: new Map([["tests",30],["three",20]]) };
  assert.equal(prepareDraftSearch(rows, Date.now(), vocabulary)("Please write three unit tests for the new discount calculation").hits.length,0);
  assert.equal(prepareDraftSearch(rows)("Please write three unit tests for the new discount calculation").hits.length,1,"known empty-vault vocabulary limitation");
});

test("C2 draft rarity stays capped as the store grows", () => {
  const rows = [0,1,2].map(i=>row(`germination tests every three years sample ${i}`,i));
  for(let i=3;i<200;i++)rows.push(row(`unrelated specimen${i} measuring${i} apparatus${i}`,i));
  assert.equal(prepareDraftSearch(rows)("three tests").hits.length,0);
});

test("C2 small stores reject everyday commands but retain technical situations", () => {
  for(const count of [5,20,200]) {
    const rows = [row("This is a stored fact about operating equipment",0,["git","status","npm","test","dock7.invalid","srv/dock7"]),
      ...Array.from({length:count-1},(_,i)=>row(`unrelated specimen${i+1} measuring${i+1}`,i+1))];
    const find=prepareDraftSearch(rows);
    assert.equal(find("git status").hits.length,0); assert.equal(find("npm test").hits.length,0);
    assert.equal(find("ssh dock7.invalid /srv/dock7").hits.length,1);
  }
});

test("C2 anchor length counts characters in Cyrillic",()=>{
  assert.equal(prepareDraftSearch([row("из во отделения двигателей")])("из во").hits.length,0);
});

test("C2 5 parallel sessions times 6 rounds book all 30 displayed drafts",()=>isolated(async()=>{
  const rows=Array.from({length:30},(_,i)=>row(`Equipment specimen${i} follows measurement${i}`,i,[`dock${i}.invalid`,`srv/dock${i}`]));
  for(let i=0;i<rows.length;i++) rows[i].situation.before=[`ssh dock${i}.invalid /srv/dock${i}`];
  await captureDrafts(rows);
  let displayed=0;
  for(let round=0;round<6;round++) await Promise.all(Array.from({length:5},async(_,session)=>{
    const i=round*5+session;
    const out=await appendLaneDrafts("{}","PreToolUse",`ssh dock${i}.invalid /srv/dock${i}`,`reader-${session}`);
    if(out.includes("<draft-hints>"))displayed++;
  }));
  assert.equal(displayed,30);
  let booked=0;
  for(let attempt=0;attempt<150;attempt++) { booked=(await listDrafts()).reduce((n,r)=>n+r.surfaced.length,0); if(booked===30)break; await new Promise(r=>setTimeout(r,10)); }
  assert.equal(booked,30);
}));

test("C2 owner text before an unfinished band is captured without the band",()=>isolated(async()=>{
  const owner="The spectrometer calibration must happen before every sample batch";
  await captureTypedDrafts([{role:"user",content:owner+"\n<draft-hints>\nUnconfirmed fixture text that must never become the owner's quote"}],{session_id:"mixed-owner"},Date.now(),[]);
  assert.equal((await listDrafts())[0].quote,owner);
}));

test("C2 an already shown Bash draft avoids repeated note lookup",()=>isolated(async()=>{
  await captureDrafts([row("The spectrometer calibration uses tungsten lamps")]);
  let lookups=0;
  const notes=()=>{lookups++;return [];};
  const first=await appendLaneDrafts("{}","PreToolUse","spectrometer calibration","reader",[],1,false,notes);
  assert.match(first,/<draft-hints>/);
  assert.equal(await appendLaneDrafts("{}","PreToolUse","spectrometer calibration","reader",[],1,false,notes),"{}");
  assert.equal(lookups,1);
}));


test("C2 both frozen corpora report fallback rates with empty and undersized vocabularies",t=>{
  const df=new Map<string,number>();
  const common="please write three unit tests new calculation briefly explain remember later change continue richtig bitte weiter schon lassen vorher nachher immer nur nicht werden with before after always only using the and this that what how";
  for(const word of new Set(tokens(common))) df.set(word,30);
  for(const [name,build] of [["original",draftRetrievalCorpus],["independent",independentDraftCorpus]] as const) {
    const corpus=build();assert.equal(corpus.rows.length,200);
    for(const count of [40,100,200])for(const vocabulary of [undefined,{count:40,df}]) {
      const rows=corpus.rows.slice(0,count),topics=new Set(rows.map(r=>corpus.topicOf.get(r.id)));
      const find=prepareDraftSearch(rows,Date.now(),vocabulary);
      const stats={topical:{total:0,right:0},unrelated:{total:0,hits:0},short:{total:0,hits:0}};
      for(const query of corpus.queries) {
        if(query.topic&&!topics.has(query.topic))continue;
        const hits=find(query.text).hits;
        if(query.kind==="topical") {stats.topical.total++;if(hits[0]&&corpus.topicOf.get(hits[0].id)===query.topic)stats.topical.right++;}
        else {stats[query.kind].total++;if(hits.length)stats[query.kind].hits++;}
      }
      t.diagnostic(JSON.stringify({corpus:name,drafts:count,vault:vocabulary?.count??0,...stats}));
      assert.ok(stats.unrelated.hits/stats.unrelated.total<=0.02,`${name}/${count}/unrelated`);
      assert.ok(stats.short.hits/stats.short.total<=0.02,`${name}/${count}/short`);
      assert.ok(stats.topical.right>0,`${name}/${count}/topical`);
    }
  }
});

test("C2 vocabulary snapshot follows add/change/remove without rescan on query",()=>{
  let listener:((e:VaultEvent)=>void)|undefined,scans=0;
  const memory=(id:string,body:string)=>({fm:{id,title:"fixture",summary:"fixture",recall_when:[]},body});
  const memories=[memory("v1","germination tests every three years"),memory("v2","three tests"),memory("v3","three tests"),memory("v4","three tests"),...Array.from({length:146},(_,i)=>memory(`filler${i}`,"unrelated geometry"))];
  const vault={list:()=>{scans++;return memories;},on:(fn:typeof listener)=>{listener=fn;return ()=>{listener=undefined;};}} as unknown as Vault;
  startDraftVocabulary(vault);
  const find=prepareDraftSearch([row("germination tests every three years")]);
  assert.equal(find("three tests").hits.length,0);
  listener!({kind:"change",memory:memory("v4","different mechanics") as any});
  assert.equal(find("three tests").hits.length,1);
  listener!({kind:"add",memory:memory("extra","three tests") as any});
  assert.equal(find("three tests").hits.length,0);
  listener!({kind:"remove",id:"extra",filePath:"fixture"});
  assert.equal(draftVocabularySnapshot().count,150);
  assert.equal(find("three tests").hits.length,1);assert.equal(scans,1);
  // Leave later isolated tests with the empty-vault fallback.
  startDraftVocabulary({list:()=>[],on:()=>()=>{}} as unknown as Vault);
});
