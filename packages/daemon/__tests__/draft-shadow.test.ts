import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, rename } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, EmbeddingIndex, type EmbeddingProvider } from "@bastra-recall/core";
import { runDraftShadow, draftVectorsPath, type DraftShadowEvent } from "../src/draft-shadow.js";
import { draftFingerprint, draftId, upsertDraft, listDrafts, expireDrafts, purgeDrafts, type Draft } from "../src/draft-store.js";
import { runSessionHarvestTick } from "../src/daemon-jobs.js";
import { noteSessionForHarvest } from "../src/session-harvest.js";
import { resolveEmbeddingChoice } from "../src/settings.js";
import { cloudEmbeddingProvider } from "../src/embedding-cloud.js";

const now = Date.UTC(2026, 9, 7, 9);
const local = { baseURL: "http://127.0.0.1:11434", model: "fixture" };
const firstQuote = "Staging uses its own isolated database for every fixture deployment.";
const repeatedQuote = "Every testing deployment needs a separate staging database for the fixture.";
function draft(quote: string, session: string, turn = 0): Draft {
  const fp = draftFingerprint(quote);
  return { id: draftId(session, turn, fp), fp, kind: "typed", quote, created: now, last_touched: now, state: "open", evidence: [{ session_id: session, turn, ts: now }], surfaced: [], situation: { before: [], after: [], reads: [], lits: [] } };
}
async function tree(path: string): Promise<unknown> {
  const entries = await readdir(path, { withFileTypes: true });
  return Promise.all(entries.sort((a,b) => a.name.localeCompare(b.name)).map(async entry => [entry.name, entry.isDirectory() ? await tree(join(path,entry.name)) : (await readFile(join(path,entry.name))).toString('hex')]));
}
async function isolated(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-b3-shadow-"));
  const env = { BASTRA_DRAFTS_PATH: join(dir, "drafts.json"), BASTRA_VAULT_PATH: join(dir, "vault"), BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"), BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"), BASTRA_LOG_PATH: join(dir, "logs"), BASTRA_TELEMETRY: "1" };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  await mkdir(env.BASTRA_VAULT_PATH);
  try { await fn(dir); } finally {
    for (const [key,value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
}
function providerFor(vectorFor: (text: string) => Float32Array): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return { id: "ollama-fixture", dim: 2, calls, async embed(texts) { calls.push(texts); return texts.map(vectorFor); } };
}
async function notes(dir: string, privateFirst = false): Promise<Vault> {
  const bodies = ["The production and staging databases must stay isolated for fixture deployments.", "The garden grows vegetables beside the wooden fence.", "The weather forecast describes clouds above the northern coastline."];
  for (let i = 0; i < 3; i++) await writeFile(join(dir,"vault",`note-${i}.md`), `---\nid: ${privateFirst && i === 0 ? 'private-fixture-note' : `note-${i}`}\ntitle: Synthetic note ${i}\ntype: project-fact\nsummary: Synthetic fixture\nscope: fixture\ntopic_path: [fixture]\ntags: [fixture]\nrecall_when: [fixture]\nsensitivity: ${privateFirst && i === 0 ? 'private' : 'team'}\ncreated: 2026-10-07\nupdated: 2026-10-07\n---\n${bodies[i]}\n`);
  const vault = new Vault(join(dir,"vault"));
  await vault.init();
  return vault;
}

test("B3 logs Dice and cosine once for cross-session drafts, persists private vectors, never merges drafts", () => isolated(async dir => {
  await upsertDraft(draft(firstQuote,"one"),now);
  await upsertDraft(draft(repeatedQuote,"two"),now);
  const before = await readFile(join(dir,"drafts.json"),"utf8");
  const provider = providerFor(() => new Float32Array([1,0]));
  const events: DraftShadowEvent[] = [];
  const result = await runDraftShadow({ provider, ollama: local, now, emit: event => events.push(event) });
  assert.equal(result.embedded,2);
  assert.equal(result.pairs,1);
  const pair = events.find(event => event.kind === "draft_repeat_shadow");
  assert.ok(pair && pair.kind === "draft_repeat_shadow");
  assert.ok(pair.dice >= 0.6);
  assert.equal(pair.cosine,1);
  assert.equal(await readFile(join(dir,"drafts.json"),"utf8"),before);
  assert.equal((await listDrafts(now)).length,2);
  if (process.platform !== 'win32') assert.equal((await stat(draftVectorsPath())).mode & 0o777,0o600);
  assert.doesNotMatch(await readFile(draftVectorsPath(),"utf8"),/Staging uses|Every testing/);
  await runDraftShadow({ provider, ollama: local, now, emit: event => events.push(event) });
  assert.equal(provider.calls.length,1);
  assert.equal(events.length,1);
}));

test("B3 scores a paraphrase and unrelated topic against existing same-model note vectors without vault writes", () => isolated(async dir => {
  const unrelated = "Painting supplies belong beside the artist easel and the canvas.";
  const vault = await notes(dir);
  try {
    await upsertDraft(draft(repeatedQuote,"one"),now);
    await upsertDraft(draft(unrelated,"two"),now);
    const provider = providerFor(text => new Float32Array(text === unrelated ? [0,1] : [1,0]));
    const events: DraftShadowEvent[] = [];
    const before = await tree(join(dir,"vault"));
    const store = await readFile(join(dir,"drafts.json"),"utf8");
    await runDraftShadow({ provider, ollama: local, now, vault, vaultVectors: () => ({ provider: provider.id, dim: 2, vectors: new Map([['note-0',new Float32Array([1,0])],['note-1',new Float32Array([-1,0])],['note-2',new Float32Array([0,-1])]]) }), emit: event => events.push(event) });
    const matches = events.filter(event => event.kind === 'draft_vault_shadow');
    assert.equal(matches.length,2);
    assert.ok(matches.every(event => typeof event.containment === 'number' && typeof event.cosine === 'number'));
    assert.equal(matches.find(event => event.draft_id === draft(repeatedQuote,'one').id)?.cosine,1);
    assert.equal(matches.find(event => event.draft_id === draft(unrelated,'two').id)?.cosine,0);
    assert.deepEqual(await tree(join(dir,"vault")),before);
    assert.equal(await readFile(join(dir,"drafts.json"),"utf8"),store);
    assert.equal(provider.calls.flat().length,2,"existing notes are never sent to the provider");
  } finally { await vault.stop(); }
}));

test("B3 suppresses private note IDs and skips incompatible vault models", () => isolated(async dir => {
  const vault = await notes(dir,true);
  try {
    const d = draft(repeatedQuote,'private-match');
    await upsertDraft(d,now);
    const provider = providerFor(() => new Float32Array([1,0]));
    const events: DraftShadowEvent[] = [];
    await runDraftShadow({ provider, ollama: local, now, vault, vaultVectors: () => ({ provider: provider.id, dim:2, vectors:new Map([['private-fixture-note',new Float32Array([1,0])]]) }), emit:event=>events.push(event) });
    assert.equal(events.filter(e=>e.kind==='draft_vault_shadow').length,1);
    assert.equal(events.find(e=>e.kind==='draft_vault_shadow')?.memory_id,null);
    assert.doesNotMatch(JSON.stringify(events),/private-fixture-note/);
    await upsertDraft(draft("A different fixture question explains the staging configuration.",'other'),now);
    const mismatch: DraftShadowEvent[] = [];
    await runDraftShadow({ provider, ollama:local, now, vault, vaultVectors:()=>({provider:'ollama-other-model',dim:2,vectors:new Map([['note-0',new Float32Array([1,0])]])}), emit:e=>mismatch.push(e) });
    assert.equal(mismatch.filter(e=>e.kind==='draft_vault_shadow').length,0);
  } finally { await vault.stop(); }
}));

test("B3 effective cloud/none choices cannot send draft text or create vector files; recorder has a positive control", () => isolated(async dir => {
  await upsertDraft(draft(firstQuote,'no-egress'),now);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => { calls.push(String(init?.body)); return new Response(JSON.stringify({data:[{embedding:new Array(1536).fill(1)}]}),{status:200}); }) as typeof fetch;
  try {
    const env = { BASTRA_EMBEDDING_PROVIDER:'openai',OPENAI_API_KEY:'fixture-credential' };
    const choice = await resolveEmbeddingChoice({path:join(dir,'settings.json'),env});
    const cloud = cloudEmbeddingProvider(choice,env)!;
    await cloud.embed(['Synthetic recorder positive control']);
    assert.equal(calls.length,1);
    calls.length=0;
    for (const provider of [cloud,null]) {
      const result=await runDraftShadow({provider,ollama:null,now});
      assert.equal(result.enabled,false);
      await assert.rejects(stat(draftVectorsPath()),{code:'ENOENT'});
    }
    assert.deepEqual(calls,[]);
  } finally { globalThis.fetch=realFetch; }
}));

test("B3 refuses remote Ollama even with opt-in and prunes expired vectors without an embedding call", () => isolated(async () => {
  const d=draft(firstQuote,'expiry');
  await upsertDraft(d,now);
  const provider=providerFor(()=>new Float32Array([1,0]));
  const previous=process.env.BASTRA_ALLOW_REMOTE_OLLAMA;
  process.env.BASTRA_ALLOW_REMOTE_OLLAMA='1';
  try {
    await runDraftShadow({provider,ollama:{...local,baseURL:'https://provider.invalid'},now});
    assert.equal(provider.calls.length,0);
    await assert.rejects(stat(draftVectorsPath()),{code:'ENOENT'});
  } finally { if(previous===undefined)delete process.env.BASTRA_ALLOW_REMOTE_OLLAMA;else process.env.BASTRA_ALLOW_REMOTE_OLLAMA=previous; }
  await runDraftShadow({provider,ollama:local,now});
  await expireDrafts({now:now+7*24*60*60*1000});
  await runDraftShadow({provider:null,ollama:null,now:now+7*24*60*60*1000});
  await assert.rejects(stat(draftVectorsPath()),{code:'ENOENT'});
  assert.equal(provider.calls.length,1);
}));

test("B3 failed local provider does not interrupt the actual harvest tick", () => isolated(async dir => {
  const vault=await notes(dir);
  const search=new SearchIndex(vault);search.start();
  try {
    const path=join(dir,'session.jsonl');
    await writeFile(path,JSON.stringify({type:'user',message:{role:'user',content:'Please inspect this synthetic routing problem because the fixture requires an alternate gateway.'}}));
    await noteSessionForHarvest({session_id:'offline',transcript_path:path,ended:true,now});
    const provider:EmbeddingProvider={id:'ollama-fixture',dim:2,async embed(){throw new Error('Synthetic failure body must never appear in logs')}};
    const result=await runSessionHarvestTick({vault,search,embIdx:()=>null,ollama:local,rawProvider:provider},now+1);
    assert.equal(result?.harvest.harvested,1);
    assert.equal(result?.shadow.errors,1);
    assert.equal((await listDrafts(now+1)).length,1);
    assert.equal((await listDrafts(now+1))[0].state,'open');
  } finally {search.stop();await vault.stop();}
}));

test("B3 can read same-model vectors through the real index identity/snapshot without invoking its provider", () => isolated(async dir => {
  const vault=await notes(dir);
  let calls=0;
  const provider:EmbeddingProvider={id:'ollama-fixture',dim:2,async embed(){calls++;throw new Error('No vault reembedding allowed')}};
  const path=join(dir,'vault','.bastra','embeddings.json');
  await mkdir(join(dir,'vault','.bastra'));
  const encoded=Buffer.from(new Float32Array([1,0]).buffer).toString('base64');
  await writeFile(path,JSON.stringify({provider:provider.id,dim:2,vectors:{'note-0':encoded,'note-1':encoded,'note-2':encoded}}));
  const index=new EmbeddingIndex(vault,provider,path);
  try {
    await index.start();
    assert.deepEqual(index.providerIdentity(),{id:provider.id,dim:2});
    assert.equal(index.snapshot().size,3);
    assert.equal(calls,0);
  } finally {await index.stop();await vault.stop();}
}));


test("B3 purge removes vectors immediately and an in-flight embed cannot resurrect them", () => isolated(async () => {
  await upsertDraft(draft(firstQuote,'purge-race'),now);
  let release!: () => void;
  let begun!: () => void;
  const ready=new Promise<void>(resolve=>{begun=resolve});
  const wait=new Promise<void>(resolve=>{release=resolve});
  const provider:EmbeddingProvider={id:'ollama-fixture',dim:2,async embed(texts){begun();await wait;return texts.map(()=>new Float32Array([1,0]))}};
  const shadow=runDraftShadow({provider,ollama:local,now,emit:()=>{}});
  await ready;
  await purgeDrafts();
  release();
  await shadow;
  await assert.rejects(stat(draftVectorsPath()),{code:'ENOENT'});
  assert.deepEqual(await listDrafts(now),[]);
  const again=providerFor(()=>new Float32Array([1,0]));
  await upsertDraft(draft(firstQuote,'purge-existing'),now);
  await runDraftShadow({provider:again,ollama:local,now,emit:()=>{}});
  assert.ok((await stat(draftVectorsPath())).size>0);
  await purgeDrafts();
  await assert.rejects(stat(draftVectorsPath()),{code:'ENOENT'});
}));

test("B3 keeps same-session pairs out and both threshold arms can log a pair", () => isolated(async () => {
  const provider=providerFor(text=>new Float32Array(text===firstQuote?[1,0]:[-1,0]));
  await upsertDraft(draft(firstQuote,'same',0),now);
  await upsertDraft(draft(repeatedQuote,'same',1),now);
  const same:DraftShadowEvent[]=[];
  await runDraftShadow({provider,ollama:local,now,emit:e=>same.push(e)});
  assert.equal(same.length,0);
  await purgeDrafts();
  await upsertDraft(draft(firstQuote,'one'),now);
  await upsertDraft(draft(repeatedQuote,'two'),now);
  const lexical:DraftShadowEvent[]=[];
  await runDraftShadow({provider,ollama:local,now,emit:e=>lexical.push(e)});
  const pair=lexical.find(e=>e.kind==='draft_repeat_shadow');
  assert.ok(pair&&pair.kind==='draft_repeat_shadow');
  assert.ok(pair.dice>=0.6);
  assert.equal(pair.cosine,-1);
  await purgeDrafts();
  const a='テスト環境には必ず別のデータベースを使ってください本番とは絶対に共有しません';
  const b='بيئة الاختبار تحتاج قاعدة بيانات منفصلة عن الإنتاج دائما';
  await upsertDraft(draft(a,'japanese'),now);
  await upsertDraft(draft(b,'arabic'),now);
  const semantic:DraftShadowEvent[]=[];
  await runDraftShadow({provider:providerFor(()=>new Float32Array([1,0])),ollama:local,now,emit:e=>semantic.push(e)});
  const sem=semantic.find(e=>e.kind==='draft_repeat_shadow');
  assert.ok(sem&&sem.kind==='draft_repeat_shadow');
  assert.equal(sem.dice,0);
  assert.equal(sem.cosine,1);
}));

test("B3 retries the vault measurement when a compatible snapshot becomes available, reusing its draft vector", () => isolated(async dir => {
  const vault=await notes(dir);
  try {
    await upsertDraft(draft(repeatedQuote,'late-index'),now);
    const provider=providerFor(()=>new Float32Array([1,0]));
    const events:DraftShadowEvent[]=[];
    await runDraftShadow({provider,ollama:local,now,vault,vaultVectors:()=>null,emit:e=>events.push(e)});
    assert.equal(events.length,0);
    await runDraftShadow({provider,ollama:local,now,vault,vaultVectors:()=>({provider:provider.id,dim:2,vectors:new Map([['note-0',new Float32Array([1,0])]])}),emit:e=>events.push(e)});
    assert.equal(events.filter(e=>e.kind==='draft_vault_shadow').length,1);
    assert.equal(provider.calls.length,1);
  } finally {await vault.stop();}
}));


test("B3 default telemetry writes only scores/IDs and cache invalidates a changed model", () => isolated(async dir => {
  await upsertDraft(draft(firstQuote,'logged-one'),now);
  await upsertDraft(draft(repeatedQuote,'logged-two'),now);
  const provider=providerFor(()=>new Float32Array([1,0]));
  await runDraftShadow({provider,ollama:local,now});
  const text=(await Promise.all((await readdir(join(dir,'logs'))).map(name=>readFile(join(dir,'logs',name),'utf8')))).join('');
  const event=JSON.parse(text.trim());
  assert.equal(event.kind,'draft_repeat_shadow');
  assert.equal(event.provider_id,'ollama-fixture');
  assert.equal(event.dimensions,2);
  assert.equal(typeof event.dice,'number');
  assert.equal(typeof event.cosine,'number');
  assert.doesNotMatch(text,/Staging uses|Every testing|isolated database/);
  const changed={...provider,id:'ollama-changed'};
  await runDraftShadow({provider:changed,ollama:{...local,model:'changed'},now,emit:()=>{}});
  assert.equal(provider.calls.length,2);
  assert.equal(JSON.parse(await readFile(draftVectorsPath(),'utf8')).provider,'ollama-changed');
}));


test("B3 cache validates and reads the same opened file despite a pathname replacement", t => isolated(async dir => {
  const d=draft(firstQuote,'file-race');await upsertDraft(d,now);
  const path=draftVectorsPath();
  await writeFile(path,JSON.stringify({version:1,provider:'ollama-fixture',dim:2,rows:[{id:d.id,fp:d.fp,quoteHash:createHash('sha256').update(d.quote).digest('hex'),measured:true,vaultMeasured:true,vector:Buffer.from(new Float32Array([1,0]).buffer).toString('base64')}]}));
  const realStat=fs.stat,realOpen=fs.open;
  let swapped=false;
  const swap=async()=>{if(!swapped){swapped=true;await rename(path,join(dir,'original-cache.json'));await writeFile(path,JSON.stringify({version:99}));}};
  const statSpy=t.mock.method(fs,'stat',async(...args:Parameters<typeof realStat>)=>{const info=await realStat(...args);if(args[0]===path)await swap();return info;});
  const openSpy=t.mock.method(fs,'open',async(...args:Parameters<typeof realOpen>)=>{const handle=await realOpen(...args);if(args[0]===path){const checked=handle.stat.bind(handle);t.mock.method(handle,'stat',async()=>{const info=await checked();await swap();return info;});}return handle;});
  syncBuiltinESMExports();
  try {
    const provider=providerFor(()=>new Float32Array([1,0]));
    const result=await runDraftShadow({provider,ollama:local,now,emit:()=>{}});
    assert.equal(swapped,true);
    assert.equal(result.errors,0);
    assert.equal(provider.calls.length,0,'the validated original cache must be reused');
    assert.equal(JSON.parse(await readFile(path,'utf8')).version,99,'an unrelated replacement must not be rewritten');
  } finally {statSpy.mock.restore();openSpy.mock.restore();syncBuiltinESMExports();}
}));
