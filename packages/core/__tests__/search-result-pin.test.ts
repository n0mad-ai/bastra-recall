/**
 * #1039 — the result set of the recall pipeline, pinned.
 *
 * `search.ts` was split into five modules (types, anchor, pipeline, hybrid,
 * staleness) without changing behaviour. The other tests pin single effects;
 * this one pins the WHOLE served order: 20 fixed queries over a 1000-memory
 * fixture vault, through `recall()` (BM25) and `recallHybrid()` (BM25 + a
 * deterministic hash embedding, RRF), with the option mix the callers use
 * (scope/type/private filters, hops, k, the #362 BM25 knobs, authored_query).
 * The ordered ids of all 20 results are hashed per path.
 *
 * A red hash after a refactor means the refactor changed ranking. After a
 * DELIBERATE ranking change, update the hash and say why in the commit.
 *
 * Runner: node --import tsx --test packages/core/__tests__/search-result-pin.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex, type RecallOptions } from "../src/search.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";

/** Bag of words hashed into 64 dims, L2-normalised — deterministic, no model. */
class HashProvider implements EmbeddingProvider {
  readonly id = "hash-pin";
  readonly dim = 64;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(64);
      for (const w of t.toLowerCase().split(/\W+/)) {
        if (w) v[createHash("md5").update(w).digest()[0] % 64] += 1;
      }
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      return v.map((x) => x / n);
    });
  }
}

const QUERIES: [string, RecallOptions][] = [
  ["vault hook", {}],
  ["recall anchor budget", { k: 10 }],
  ["deploy daemon", { scope: "alpha" }],
  ["staleness cache", { expand_hops: 1 }],
  ["embedding ollama fusion", { k: 8, allow_private: true }],
  ["statusline telemetry", { type: "lesson" }],
  ["curator bridge refile", { k: 12 }],
  ["trash scope token", { scope: "delta" }],
  ["vault21 hook42", {}],
  ["recall63Config", { k: 10 }],
  ["anchr budgt", {}],
  ["daemon deploy hook vault recall", { expand_hops: 1, k: 6 }],
  ["fusion", { type: "doc" }],
  ["cache cache cache staleness", {}],
  ["bridge88 refile109", { k: 20 }],
  ["token scope scope", { authored_query: "token scope" }],
  ["telemetry statusline curator", { bm25_query_max_chars: 20 }],
  ["embedding ollama", { bm25_no_fuzzy: true }],
  ["recall vault", { bm25_fuzzy_rare_df_max: 5 }],
  ["hook budget deploy", { scope: "beta", k: 15 }],
];

/** 1000 memories from a seeded LCG: mixed types, scopes (one mixed-case),
 *  ages (fresh / 200 days), private, obsolete, related_via and camelCase triggers. */
async function writeFixture(dir: string): Promise<void> {
  let seed = 1039;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const base = ["vault", "hook", "recall", "anchor", "deploy", "daemon", "budget", "scope", "token", "fusion",
    "staleness", "embedding", "ollama", "cache", "statusline", "telemetry", "curator", "bridge", "refile", "trash"];
  const words = Array.from({ length: 240 }, (_, i) => base[i % 20] + (i < 20 ? "" : String(i)));
  const types = ["lesson", "decision", "project-fact", "reference", "preference", "doc", "workflow"];
  const scopes = ["alpha", "beta", "gamma", "Delta"];
  const pick = () => words[Math.floor(rnd() * rnd() * words.length)];
  const phrase = (n: number) => Array.from({ length: n }, pick).join(" ");
  for (let i = 0; i < 1000; i++) {
    const ageDays = i % 5 === 0 ? 200 : i % 3;
    const ts = new Date(Date.now() - ageDays * 86400_000).toISOString();
    const related = i % 7 === 0 ? `related_via:\n  - id: m${(i * 31) % 1000}\n    reason: test\n    score: 0.8` : "";
    const lines = [
      "---", `id: m${i}`, `title: ${phrase(3)} ${i}`, `type: ${types[i % types.length]}`, `summary: ${phrase(6)}`,
      "topic_path:", `  - ${pick()}`, `tags: [${pick()}, ${pick()}]`, `scope: ${scopes[i % scopes.length]}`,
      "recall_when:", `  - ${phrase(2)}`, `  - ${pick()}${i % 11 === 0 ? "Config" : ""}`,
      ...(i % 13 === 0 ? ["sensitivity: private"] : []), ...(i % 17 === 0 ? ["obsolete: true"] : []),
      `created: ${ts}`, `updated: ${ts}`, related, "---", "", phrase(40), "",
    ];
    await writeFile(join(dir, `m${i}.md`), lines.filter((l) => l !== "").join("\n"), "utf8");
  }
}

const hashIds = (results: { id: string }[][]): string =>
  createHash("sha256").update(results.map((r) => r.map((h) => h.id).join(",")).join("\n")).digest("hex").slice(0, 16);

test("#1039: 20 fixed queries serve the pinned result order on the BM25 and the hybrid path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-result-pin-"));
  await writeFixture(dir);

  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  const emb = new EmbeddingIndex(vault, new HashProvider(), join(dir, ".bastra", "embeddings.json"));
  // Drain the embedding index BEFORE the temp dir goes (see ranking-order.test.ts).
  t.after(async () => {
    await emb.stop();
    idx.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await emb.start();
  // #542: white-box drain of the backfill queue, repeated until every memory has a vector.
  for (let prev = -1; prev !== emb.size(); ) {
    prev = emb.size();
    await (emb as unknown as { flushQueue(): Promise<void> }).flushQueue();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(emb.size(), 1000);
  idx.useEmbeddings(emb);

  const bm25: { id: string }[][] = [];
  const hybrid: { id: string }[][] = [];
  for (const [q, o] of QUERIES) {
    idx.setDemotions([]); // empties the query cache: every call takes the cold path
    bm25.push(idx.recall(q, o));
    idx.setDemotions([]);
    hybrid.push(await idx.recallHybrid(q, o));
  }

  assert.deepEqual(bm25.map((r) => r.length), [5, 10, 5, 8, 8, 5, 12, 5, 5, 4, 5, 7, 5, 5, 20, 5, 5, 5, 5, 15]);
  assert.deepEqual(hybrid.map((r) => r.length), [5, 10, 5, 7, 8, 5, 12, 5, 5, 10, 5, 9, 5, 5, 20, 5, 5, 5, 5, 15]);
  assert.ok(hybrid.flat().some((h) => (h as { mode?: string }).mode === "hybrid"), "the dense arm took part");
  assert.equal(hashIds(bm25), "3fbeef07735841ac", "BM25 result order changed");
  assert.equal(hashIds(hybrid), "47c642b146ad6be7", "hybrid result order changed");
});
