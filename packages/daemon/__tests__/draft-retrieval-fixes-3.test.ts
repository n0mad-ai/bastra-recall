import test from "node:test";
import assert from "node:assert/strict";
import { prepareDraftSearch } from "../src/draft-search.js";
import { draftRetrievalCorpus } from "./fixtures/draft-retrieval-corpus.js";
import { independentDraftCorpus } from "./fixtures/draft-retrieval-independent.js";
import { syntheticDraftLanguageVault } from "./fixtures/draft-vault-language.js";

test("C3 usable vault vocabulary restores repeated-topic recall in both frozen corpora",t=>{
 const {notes,vocabulary}=syntheticDraftLanguageVault();assert.equal(notes.length,150);
 for(const [name,build] of [["original",draftRetrievalCorpus],["independent",independentDraftCorpus]] as const) {
  const corpus=build();
  for(const count of [40,100,200])for(const words of [{count:0,df:new Map<string,number>()},vocabulary]) {
   const rows=corpus.rows.slice(0,count),topics=new Set(rows.map(r=>corpus.topicOf.get(r.id)));
   const find=prepareDraftSearch(rows,Date.now(),words);
   const stats={topical:{total:0,right:0},unrelated:{total:0,hits:0},short:{total:0,hits:0}};
   for(const query of corpus.queries) {
    if(query.topic&&!topics.has(query.topic))continue;
    const hits=find(query.text).hits;
    if(query.kind==="topical") {stats.topical.total++;if(hits[0]&&corpus.topicOf.get(hits[0].id)===query.topic)stats.topical.right++;}
    else {stats[query.kind].total++;if(hits.length)stats[query.kind].hits++;}
   }
   t.diagnostic(JSON.stringify({corpus:name,drafts:count,vault:words.count,...stats}));
   assert.ok(stats.unrelated.hits/stats.unrelated.total<=0.02);
   assert.ok(stats.short.hits/stats.short.total<=0.02);
   if(words.count>=50)assert.ok(stats.topical.right/stats.topical.total>0.60);
  }
 }
});

test("C3 common vault words do not anchor the three unit tests counterexample",()=>{
 const {vocabulary}=syntheticDraftLanguageVault();
 const original=draftRetrievalCorpus().rows[0];
 const rows=[{...original,quote:"germination tests every three years",situation:{before:[],after:[],reads:[],lits:[]}}];
 assert.equal(prepareDraftSearch(rows,Date.now(),vocabulary)("Please write three unit tests for the new discount calculation").hits.length,0);
});

test("C3 an often explained topic is eligible, while a topic common in vault notes is not an anchor",()=>{
 const {vocabulary}=syntheticDraftLanguageVault(),corpus=draftRetrievalCorpus();
 assert.ok(prepareDraftSearch(corpus.rows,Date.now(),vocabulary)("purpurdrucker zyanpatronen").hits.length);
 const common={count:150,df:new Map(vocabulary.df)};common.df.set("purpurdrucker",120);common.df.set("zyanpatronen",120);
 assert.equal(prepareDraftSearch(corpus.rows,Date.now(),common)("purpurdrucker zyanpatronen",[{body:corpus.rows[0].quote}]).hits.length,0);
});

test("C3 rarity scales with vault language size and small vocabularies use the draft fallback",()=>{
 const corpus=draftRetrievalCorpus(),row=corpus.rows[0];
 const df=new Map([["purpurdrucker",2],["zyanpatronen",2]]);
 assert.equal(prepareDraftSearch([row],Date.now(),{count:60,df})("purpurdrucker zyanpatronen").hits.length,0);
 assert.equal(prepareDraftSearch([row],Date.now(),{count:2000,df})("purpurdrucker zyanpatronen").hits.length,1);
 assert.equal(prepareDraftSearch(corpus.rows,Date.now(),{count:49,df:new Map()})("purpurdrucker zyanpatronen").hits.length,0);
});
