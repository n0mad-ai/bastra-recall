/** #1058 supported exact-Flat backend subset; synthetic vectors, no model. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { Vault, EmbeddingIndex, hashEmbedContent, type EmbeddingProvider } from "@bastra-recall/core";

const args = new Map<string, string>(); for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const size = Number(args.get("--size")), out = args.get("--out");
if (![1403, 1000, 3000, 10000, 50000].includes(size) || !out) throw new Error("registered --size and --out required");
const dim = 768, id = (i: number): string => `entity-${String(i).padStart(6, "0")}`;
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
function randomVector(seed: number): Float32Array {
  let x = seed >>> 0; const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) { x = Math.imul(1664525, x) + 1013904223 >>> 0; v[i] = x / 4294967296 - 0.5; }
  return v;
}
function vector(i: number, noisy = false, revised = false): Float32Array {
  const group = i >= 512 ? i % 512 : i;
  const v = randomVector(group + 42), noise = randomVector(i + 1000000);
  const factor = revised ? 0.2 : noisy ? 0.12 : i >= 512 ? 0.04 : 0;
  for (let j = 0; j < dim; j++) v[j] += noise[j] * factor;
  return v;
}
let calls = 0;
const provider: EmbeddingProvider = { id: "eval-seeded-vector-v1", dim,
  async embed(texts) { calls += texts.length; return texts.map(text => {
    const match = /entity-(\d+)/.exec(text); if (!match) throw new Error("missing synthetic entity");
    return vector(Number(match[1]), text.includes("noisy"), text.includes("revision-two"));
  }); } };
const git = (args: string[]): string => execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
const coreDir = new URL("../../core/src/", import.meta.url), coreHash = createHash("sha256");
for (const f of readdirSync(coreDir).filter(f => f.endsWith(".ts")).sort()) coreHash.update(f).update("\0").update(readFileSync(new URL(f, coreDir)));
const engine = { repo_commit: git(["rev-parse", "HEAD"]), repo_dirty: !!git(["status", "--porcelain"]), core_src_sha256: coreHash.digest("hex") };
const reg = readFileSync(new URL("../registrations/flat-scale-subset.json", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "flat-scale-subset-"));
const vectorsFile = join(root, ".bastra", "vectors.json"), cacheFile = join(root, ".bastra", "embed-cache.json");
const rss = (): number => process.memoryUsage().rss;
const started = performance.now();
let emb: EmbeddingIndex | null = null;
try {
  await mkdir(join(root, "memories")); await mkdir(join(root, ".bastra"));
  let corpusBytes = 0; const corpusHash = createHash("sha256");
  for (let start = 0; start < size; start += 128) {
    const files = [];
    for (let i = start; i < Math.min(size, start + 128); i++) {
      const text = `---\nid: ${id(i)}\ntitle: Scale ${id(i)}\ntype: reference\nsummary: Retention for ${id(i)}.\nscope: synthetic-scale\ntopic_path: [eval]\ntags: []\nrecall_when: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nRetention for ${id(i)} is 30 days.\n`;
      corpusBytes += Buffer.byteLength(text); corpusHash.update(id(i)).update("\0").update(text);
      files.push(writeFile(join(root, "memories", `${id(i)}.md`), text));
    }
    await Promise.all(files);
  }
  const vault = new Vault(root); const beforeLoad = performance.now(); const info = await vault.init();
  const vaultLoadMs = performance.now() - beforeLoad;
  if (info.loaded !== size || info.skipped.length) throw new Error("incomplete scale corpus");
  const vectors: Record<string, string> = {}, entries: Record<string, { hash: string; vector_dim: number; embedded_at: string }> = {};
  for (const m of vault.list()) {
    const i = Number(m.fm.id.slice(7)), v = vector(i);
    vectors[m.fm.id] = Buffer.from(v.buffer).toString("base64");
    entries[m.fm.id] = { hash: hashEmbedContent(m), vector_dim: dim, embedded_at: "2026-01-01T00:00:00Z" };
  }
  const vecJson = JSON.stringify({ dim, provider: provider.id, vectors });
  const cacheJson = JSON.stringify({ version: 1, provider: provider.id, dim, entries });
  await writeFile(vectorsFile, vecJson); await writeFile(cacheFile, cacheJson);
  emb = new EmbeddingIndex(vault, provider, vectorsFile); const beforeStart = performance.now(); await emb.start();
  const vectorLoadMs = performance.now() - beforeStart;
  if (emb.size() !== size || calls !== 0) throw new Error("precomputed fixture unexpectedly backfilled");
  const rssAfterLoad = rss(), queries: { slice: string; target: string; hit1: boolean; hit10: boolean; ms: number }[] = [];
  for (const slice of ["exact", "noisy"]) for (let repeat = 0; repeat < 3; repeat++) for (let q = 0; q < 12; q++) {
    const target = id(q * 37), query = `${target} ${slice}`;
    const before = performance.now(), result = await emb.searchDetailed(query, 10), ms = performance.now() - before;
    if (result.outcome !== "hits" || result.hits.length !== 10) throw new Error("incomplete flat query");
    queries.push({ slice, target, hit1: result.hits[0].id === target, hit10: result.hits.some(h => h.id === target), ms });
  }
  const rssAfterQueries = rss();
  const updatePath = join(root, "memories", `${id(0)}.md`), prior = await readFile(updatePath, "utf8");
  const beforeUpdate = performance.now();
  let unsubscribe: (() => void) | undefined;
  const updated = new Promise<void>(resolve => { unsubscribe = emb!.onEmbed(key => { if (key === id(0)) { unsubscribe?.(); resolve(); } }); });
  await writeFile(updatePath, prior + "revision-two\n"); await vault.reindexFile(updatePath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([updated, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("update embed missing")), 120000); })]);
  if (timer) clearTimeout(timer);
  const updateMs = performance.now() - beforeUpdate;
  const afterUpdate = await emb.searchDetailed(`${id(0)} revision-two`, 10);
  const updateTargetHit1 = afterUpdate.hits[0]?.id === id(0);
  const beforeDelete = performance.now(); await unlink(updatePath); await vault.reconcile();
  const deleteMs = performance.now() - beforeDelete;
  const afterDelete = await emb.searchDetailed(id(0), 10);
  const deleteAbsent = !afterDelete.hits.some(h => h.id === id(0)) && emb.size() === size - 1 && !vault.get(id(0));
  await emb.stop(); emb = null;
  const quantile = (xs: number[], q: number): number => xs.slice().sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1];
  const slices = Object.fromEntries(["exact", "noisy"].map(slice => { const xs = queries.filter(q => q.slice === slice); return [slice, { n: xs.length,
    target_hit_at_1: xs.filter(q => q.hit1).length, target_hit_at_10: xs.filter(q => q.hit10).length,
    query_ms_p50: quantile(xs.map(q => q.ms), .5), query_ms_p95: quantile(xs.map(q => q.ms), .95) }]; }));
  const result = { schema_version: 1, issue: 1058, engine, registration_sha256: sha(reg), code_sha256: sha(readFileSync(new URL(import.meta.url))),
    dataset_sha256: corpusHash.digest("hex"), initial_vector_file_sha256: sha(vecJson), backend: "production exact Flat", provider: provider.id, dim, size,
    setup_and_total_ms: performance.now() - started, vault_load_ms: vaultLoadMs, vector_cache_load_ms: vectorLoadMs, slices,
    sampled_rss_bytes: { after_load: rssAfterLoad, after_queries: rssAfterQueries, after_mutations: rss() },
    disk_bytes: { initial_corpus: corpusBytes, initial_vectors: Buffer.byteLength(vecJson), initial_embed_cache: Buffer.byteLength(cacheJson), post_mutation_vectors: (await stat(vectorsFile)).size },
    update_ms: updateMs, update_target_hit_at_1: updateTargetHit1, delete_reconcile_ms: deleteMs, deleted_id_absent: deleteAbsent,
    fixture_provider_calls: calls, neural_model_calls: 0, queries,
    limitations: ["synthetic vectors are not a semantic model/gold-set test", "shared host and sampled RSS, not isolated latency or peak memory", "single update/delete per scale", "HNSW unavailable and unmeasured", "no production switch/recovery or M1 gate"],
    verdict: "supported Flat scaling subset measured; HNSW/M5 confirmation not evaluable" };
  await writeFile(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ size, slices, vaultLoadMs, vectorLoadMs, updateMs, deleteMs, deleteAbsent }, null, 2));
} finally { if (emb) await emb.stop(); await rm(root, { recursive: true, force: true }); }
