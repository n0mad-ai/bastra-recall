import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, EmbeddingIndex, type EmbeddingProvider } from "../src/index.js";

const provider: EmbeddingProvider = {
  id: "supersession-test", dim: 2,
  async embed(texts) { return texts.map(() => new Float32Array([1, 0])); },
};

async function fixture(t: TestContext, links: Record<string, string>, hybrid = false) {
  const dir = await mkdtemp(join(tmpdir(), "superseded-ranking-"));
  for (const [id, link] of Object.entries(links)) {
    await writeFile(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: Zebra migration\ntype: reference\nsummary: Zebra migration\nscope: test\ntopic_path: [test]\ntags: []\nrecall_when: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n${link}\n---\n\n${id === "a" ? "quartzlegacy" : "current"}\n`);
  }
  const vault = new Vault(dir); await vault.init();
  const search = new SearchIndex(vault); search.start();
  const emb = new EmbeddingIndex(vault, provider, join(dir, ".bastra", "vectors.json"));
  t.after(async () => { await emb.stop(); search.stop(); await rm(dir, { recursive: true, force: true }); });
  if (hybrid) {
    await emb.start();
    await (emb as unknown as { flushQueue(): Promise<void> }).flushQueue();
    assert.equal(emb.size(), Object.keys(links).length);
    search.useEmbeddings(emb);
  }
  return { search, dir };
}

for (const hybrid of [false, true]) {
  test(`superseded predecessor follows successor before top-k (${hybrid ? "hybrid" : "BM25"})`, async (t) => {
    const { search, dir } = await fixture(t, { a: "superseded_by: b", b: "replaces: a" }, hybrid);
    const before = await readFile(join(dir, "a.md"), "utf8");
    const recall = (k: number) => hybrid ? search.recallHybrid("zebra migration", { k }) : search.recall("zebra migration", { k });
    assert.deepEqual((await recall(1)).map(h => h.id), ["b"]);
    const hits = await recall(3);
    assert.deepEqual(hits.map(h => h.id), ["b", "a"]);
    assert.ok(hits[0].score > hits[1].score);
    assert.deepEqual(await recall(3), hits, "warm cache keeps the corrected ordering");
    assert.ok(search.loadFull("a")?.body.includes("quartzlegacy"));
    assert.equal(await readFile(join(dir, "a.md"), "utf8"), before);
    assert.equal(search.recall("quartzlegacy", { k: 1, bm25_no_fuzzy: true })[0]?.id, "a");
  });
}

test("replacement chains rank newest first", async (t) => {
  const { search } = await fixture(t, { a: "superseded_by: b", b: "superseded_by: c", c: "" });
  assert.deepEqual(search.recall("zebra migration", { k: 3 }).map(h => h.id), ["c", "b", "a"]);
});

test("promotion follows other multipliers, keeps unrelated scores and exposes the corrected pool", async (t) => {
  const { search } = await fixture(t, { a: "superseded_by: b", b: "superseded_by: c", c: "", d: "" });
  search.setDemotions(["c"]);
  const isolated = search.recall("quartzlegacy", { k: 1, bm25_no_fuzzy: true });
  assert.equal(isolated[0]?.id, "a", "a successor outside the pool cannot penalize a targeted search");
  let pool: { id: string; score: number }[] = [];
  const hits = search.recall("zebra migration", { k: 4, onCandidatePool: hits => { pool = hits; } });
  assert.deepEqual(hits.map(h => h.id), ["c", "b", "a", "d"]);
  assert.deepEqual(pool.map(h => h.id), hits.map(h => h.id));
  assert.ok(hits[1].score < hits[0].score && hits[2].score < hits[1].score);
  const { search: control } = await fixture(t, { a: "", b: "", c: "", d: "" });
  control.setDemotions(["c"]);
  const original = control.recall("zebra migration", { k: 4 });
  for (const id of ["a", "d"]) {
    assert.equal(hits.find(h => h.id === id)?.score, original.find(h => h.id === id)?.score);
  }
  assert.equal(isolated[0].score, control.recall("quartzlegacy", { k: 1, bm25_no_fuzzy: true })[0].score);
});

test("dangling, self and cyclic references leave the original ranking intact", async (t) => {
  for (const links of [{ a: "superseded_by: missing", b: "" }, { a: "superseded_by: a", b: "" }, { a: "superseded_by: b", b: "superseded_by: a" }]) {
    const { search } = await fixture(t, links);
    const hits = search.recall("zebra migration", { k: 3 });
    assert.deepEqual(hits.map(h => h.id), ["a", "b"]);
    assert.equal(hits[0].score, hits[1].score);
  }
});

test("targeted old value keeps both versions ahead of unrelated fillers", async (t) => {
  const { search, dir } = await fixture(t, { a: "superseded_by: b", b: "", ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, ""])) });
  await writeFile(join(dir, "a.md"), `---\nid: a\ntitle: Staging server port\ntype: reference\nsummary: Staging server port\nscope: test\ntopic_path: [test]\ntags: []\nrecall_when: []\nsuperseded_by: b\n---\nThe staging server listens on port 8080 legacyvalue.\n`);
  await writeFile(join(dir, "b.md"), `---\nid: b\ntitle: Update\ntype: reference\nsummary: Update\nscope: test\ntopic_path: [test]\ntags: []\nrecall_when: []\n---\nStaging moved to 9090.\n`);
  for (let i = 0; i < 8; i++) await writeFile(join(dir, `f${i}.md`), `---\nid: f${i}\ntitle: Staging server notes\ntype: reference\nsummary: Staging server notes\nscope: test\ntopic_path: [test]\ntags: []\nrecall_when: []\n---\nstaging server staging server port details\n`);
  // Explicit reload avoids timing assertions about the filesystem watcher.
  search.stop();
  const vault = new Vault(dir); await vault.init();
  const index = new SearchIndex(vault); index.start(); t.after(() => index.stop());
  assert.deepEqual(index.recall("8080 staging server port", { k: 2 }).map(h => h.id), ["b", "a"]);
});
