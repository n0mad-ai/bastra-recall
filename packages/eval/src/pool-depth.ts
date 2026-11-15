/**
 * Where does the right memory actually sit — and in which arm?
 *
 * `absence-honesty` says recall returns the gold in the top 5 for 23 of 37
 * held-out paraphrases. That number alone cannot tell a RETRIEVAL failure (the
 * memory is nowhere near the top of either arm — nothing downstream can rescue
 * it) from a RANKING failure (it is in the pool at depth 8, and only the cut at
 * k=5 hides it). The two have different fixes, and only one of them is cheap.
 *
 * So: one index, one pass, and for every case the gold's rank in
 *   - the BM25 arm alone
 *   - the dense arm alone
 *   - the fused hybrid list
 * measured to depth 50 instead of 5.
 *
 *   BASTRA_VAULT_PATH=/path/to/vault npx tsx src/pool-depth.ts \
 *     --cases goldset/held-out-paraphrases.example.json --depth 50
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Vault, SearchIndex, EmbeddingIndex, OllamaEmbeddingProvider } from "@bastra-recall/core";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string, d: string): string => {
    const i = argv.indexOf(n);
    return i === -1 ? d : (argv[i + 1] ?? d);
  };
  const vaultRoot = (process.env.BASTRA_VAULT_PATH ?? arg("--vault", "")).replace(/^~/, os.homedir());
  const depth = Number.parseInt(arg("--depth", "50"), 10);
  const casesPath = arg("--cases", "");
  const outPath = arg("--out", "");
  if (!vaultRoot || !casesPath) {
    console.error("FATAL: set BASTRA_VAULT_PATH (or --vault) and --cases <file>");
    process.exit(2);
  }
  const embSrc = path.join(vaultRoot, ".bastra", "embeddings.json");
  if (!(await fs.stat(embSrc).catch(() => null))) {
    console.error(
      `FATAL: ${embSrc} not found — this harness reads the vectors a daemon already built. ` +
        "Run the daemon once on this vault, or use absence-honesty.ts, which seeds them itself."
    );
    process.exit(2);
  }
  const cases = JSON.parse(await fs.readFile(casesPath, "utf8")) as { gold: string; query: string }[];

  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const provider = new OllamaEmbeddingProvider({
    baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
    keepAlive: "10m",
  });
  // Work off a COPY of the persisted vectors: start() prunes orphans and
  // backfills, both of which persist. The vault is an input here, not a target.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "pool-depth-"));
  const embWork = path.join(work, "embeddings.json");
  await fs.copyFile(embSrc, embWork);
  const emb = new EmbeddingIndex(vault, provider, embWork, path.join(work, "cache.json"));
  await emb.start();
  search.useEmbeddings(emb);
  console.error(`vault ${vault.size()} memories, ${emb.size()} vectors, depth ${depth}`);

  const rows: {
    gold: string;
    query: string;
    hybrid: number | null;
    bm25: number | null;
    dense: number | null;
    bm25_ids: string[];
    dense_ids: string[];
    hybrid_ids: string[];
  }[] = [];
  for (const c of cases) {
    const hybrid = await search.recallHybrid(c.query, { k: depth });
    const bm25 = search.recall(c.query, { k: depth });
    const dense = await emb.search(c.query, depth);
    const rank = (arr: { id: string }[]): number | null => {
      const i = arr.findIndex((h) => h.id === c.gold);
      return i === -1 ? null : i + 1;
    };
    rows.push({
      gold: c.gold,
      query: c.query,
      hybrid: rank(hybrid),
      bm25: rank(bm25),
      dense: rank(dense),
      // the two ranked lists themselves, so alternative fusions can be swept
      // offline instead of re-running the arms per variant
      bm25_ids: bm25.map((h) => h.id),
      dense_ids: dense.map((h) => h.id),
      hybrid_ids: hybrid.map((h) => h.id),
    });
    process.stderr.write(
      `${c.gold.slice(0, 46).padEnd(46)} hybrid=${rows.at(-1)!.hybrid ?? "-"} bm25=${rows.at(-1)!.bm25 ?? "-"} dense=${rows.at(-1)!.dense ?? "-"}\n`
    );
  }

  const within = (v: number | null, n: number): boolean => v !== null && v <= n;
  const count = (f: (r: (typeof rows)[number]) => boolean): number => rows.filter(f).length;
  const n = rows.length;
  console.log(`\n── where the gold sits (n=${n}) ──`);
  for (const cut of [1, 3, 5, 10, 20, 30, 50]) {
    console.log(
      `  top-${String(cut).padStart(2)}   hybrid ${String(count((r) => within(r.hybrid, cut))).padStart(2)}/${n}` +
        `   bm25 ${String(count((r) => within(r.bm25, cut))).padStart(2)}/${n}` +
        `   dense ${String(count((r) => within(r.dense, cut))).padStart(2)}/${n}` +
        `   either arm ${String(count((r) => within(r.bm25, cut) || within(r.dense, cut))).padStart(2)}/${n}`
    );
  }
  console.log(
    `\n  gold in the hybrid pool at depth ${depth} but outside top-5: ` +
      `${count((r) => within(r.hybrid, depth) && !within(r.hybrid, 5))}/${n}  ← rescuable by reranking`
  );
  console.log(
    `  gold nowhere in either arm at depth ${depth}: ` +
      `${count((r) => !within(r.bm25, depth) && !within(r.dense, depth))}/${n}  ← retrieval, not ranking`
  );

  await emb.stop();
  search.stop();
  await vault.stop();
  if (outPath) await fs.writeFile(outPath, JSON.stringify(rows, null, 2));
}

void main();
