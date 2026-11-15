/**
 * `RRF_K` on a public corpus — BEIR/NFCorpus, so the number is shareable by
 * construction and anyone can rerun it.
 *
 * The damping constant in `fuseRRF` decides how much a RANK is worth against
 * mere presence in both arms. At the TREC default of 60 the denominator swamps
 * the rank on pools this size — a document at rank 20 in both arms outscores a
 * document at rank 1 in one. That is arithmetic, not a corpus property (the
 * unit test `core/__tests__/rrf-damping.test.ts` pins it on synthetic lists),
 * but arithmetic does not tell you whether it costs anything in practice. This
 * does, on data that has nothing to do with anyone's vault.
 *
 * Setup — deliberately the production path, not a re-implementation:
 *   - lexical arm: the real `SearchIndex` (its tokenizer, its field weights)
 *     over a vault built from the corpus, one memory per document
 *   - dense arm: the real `EmbeddingIndex` + `OllamaEmbeddingProvider`
 *   - fusion: the real `fuseRRF`, k swept
 * Only k varies. Both arm lists are computed ONCE per query and reused for
 * every k, so nothing but the combination can move the numbers.
 *
 * NFCorpus is the honest choice for this question rather than a friendly one:
 * it is a hard BEIR task (nDCG@10 in the 0.3s for strong retrievers), the
 * queries are real, graded, and often have many relevant documents — the
 * opposite of a single-gold personal vault. If the constant only helped on
 * single-gold data, this is where that would show.
 *
 * Get the data (BEIR, CC BY-SA 4.0):
 *   curl -sLO https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip && unzip -q nfcorpus.zip
 *
 * Run:
 *   npx tsx src/rrf-k-beir.ts --data /path/to/nfcorpus --split test
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Vault, SearchIndex, EmbeddingIndex, OllamaEmbeddingProvider, fuseRRF } from "@bastra-recall/core";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(n);
  return i === -1 ? d : (argv[i + 1] ?? d);
};

/** BEIR ids are arbitrary strings; memory ids have to be path-safe slugs. */
const slug = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

async function readJsonl<T>(p: string): Promise<T[]> {
  const text = await fs.readFile(p, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

/** nDCG@k against graded qrels, with the ideal ranking as the denominator. */
function ndcg(ranked: string[], rel: Map<string, number>, k: number): number {
  const dcg = ranked
    .slice(0, k)
    .reduce((acc, id, i) => acc + (Math.pow(2, rel.get(id) ?? 0) - 1) / Math.log2(i + 2), 0);
  const ideal = [...rel.values()]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((acc, g, i) => acc + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

function recallAt(ranked: string[], rel: Map<string, number>, k: number): number {
  const relevant = [...rel.entries()].filter(([, g]) => g > 0).map(([id]) => id);
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

function hitAt(ranked: string[], rel: Map<string, number>, k: number): boolean {
  return ranked.slice(0, k).some((id) => (rel.get(id) ?? 0) > 0);
}

async function main(): Promise<void> {
  const data = arg("--data", "");
  const split = arg("--split", "test");
  const depth = Number.parseInt(arg("--depth", "50"), 10);
  const limit = Number.parseInt(arg("--limit", "0"), 10);
  const outPath = arg("--out", "");
  if (!data) {
    console.error("FATAL: --data /path/to/nfcorpus (corpus.jsonl, queries.jsonl, qrels/<split>.tsv)");
    process.exit(2);
  }

  // ── qrels first: only queries with judgements are worth embedding for ──────
  const qrelsText = await fs.readFile(path.join(data, "qrels", `${split}.tsv`), "utf8");
  const qrels = new Map<string, Map<string, number>>();
  for (const line of qrelsText.split("\n").slice(1)) {
    const [qid, did, score] = line.split("\t");
    if (!qid || !did) continue;
    const g = Number.parseInt(score ?? "0", 10);
    if (!Number.isFinite(g)) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid)!.set(slug(did), g);
  }

  const corpus = await readJsonl<{ _id: string; title: string; text: string }>(path.join(data, "corpus.jsonl"));
  const queries = await readJsonl<{ _id: string; text: string }>(path.join(data, "queries.jsonl"));
  const judged = queries.filter((q) => qrels.has(q._id));
  const testQueries = limit > 0 ? judged.slice(0, limit) : judged;
  console.error(`corpus ${corpus.length} docs · ${testQueries.length} judged queries (${split})`);

  // ── build a vault out of the corpus ───────────────────────────────────────
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rrf-k-beir-"));
  const vaultRoot = path.join(work, "vault");
  await fs.mkdir(path.join(vaultRoot, "memories"), { recursive: true });
  const esc = (s: string): string => JSON.stringify(s.replace(/\s+/g, " ").trim());
  for (const doc of corpus) {
    const id = slug(doc._id);
    // No recall_when: a public corpus has no author-written triggers, and
    // inventing them would test doc2query, not the fusion.
    const md =
      `---\nid: ${id}\ntitle: ${esc(doc.title || id)}\ntype: reference\n` +
      `summary: ${esc((doc.text || "").slice(0, 200))}\ntopic_path: [beir]\ntags: [beir]\n` +
      `scope: beir\nrecall_when: []\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n\n${doc.text ?? ""}\n`;
    await fs.writeFile(path.join(vaultRoot, "memories", `${id}.md`), md);
  }

  const vault = new Vault(vaultRoot);
  const { loaded, skipped } = await vault.init();
  console.error(`vault: ${loaded} loaded, ${skipped.length} skipped`);
  const search = new SearchIndex(vault);
  search.start();

  const emb = new EmbeddingIndex(
    vault,
    new OllamaEmbeddingProvider({
      baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
      model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
      keepAlive: "10m",
    }),
    path.join(work, "embeddings.json"),
    path.join(work, "cache.json")
  );
  await emb.start();
  // start() kicks the backfill off without awaiting it; the arms are only
  // comparable once every document has a vector.
  const embedDeadline = Date.now() + Number(process.env.BASTRA_EMBED_TIMEOUT_MS ?? 900_000);
  let lastSize = -1;
  let stalledSince = Date.now();
  while (emb.size() < loaded) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stderr.write(`\rembedding ${emb.size()}/${loaded}`);
    if (emb.size() !== lastSize) {
      lastSize = emb.size();
      stalledSince = Date.now();
    }
    // Ollama down or a document that never embeds would otherwise hang here
    // forever, which reads as "slow" and wastes the run.
    if (Date.now() - stalledSince > 120_000 || Date.now() > embedDeadline) {
      console.error(
        `\nFATAL: embedding stalled at ${emb.size()}/${loaded}. Is Ollama reachable at ` +
          `${process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434"}?`
      );
      process.exit(3);
    }
  }
  process.stderr.write("\n");
  search.useEmbeddings(emb);

  // ── one pass over the queries, both arm lists cached ──────────────────────
  const arms: { qid: string; bm25: string[]; dense: string[] }[] = [];
  for (const [i, q] of testQueries.entries()) {
    const bm25 = search.recall(q.text, { k: depth }).map((h) => h.id);
    const dense = (await emb.search(q.text, depth)).map((h) => h.id);
    arms.push({ qid: q._id, bm25, dense });
    if (i % 25 === 0) process.stderr.write(`\rquery ${i + 1}/${testQueries.length}`);
  }
  process.stderr.write("\n");

  const KS = [1, 3, 5, 10, 20, 30, 60, 100];
  const rows: Record<string, number>[] = [];
  console.log(`\n── NFCorpus/${split}: only the fusion constant varies (n=${arms.length}, depth ${depth}) ──`);
  console.log(`   ${"k".padStart(4)} | nDCG@10 | recall@10 | hit@5  | hit@10`);
  console.log("   " + "-".repeat(52));
  for (const k of KS) {
    let nd = 0;
    let rc = 0;
    let h5 = 0;
    let h10 = 0;
    for (const a of arms) {
      const rel = qrels.get(a.qid)!;
      const fused = fuseRRF(a.bm25, a.dense, k);
      const ranked = [...fused.entries()].sort((x, y) => y[1].score - x[1].score).map(([id]) => id);
      nd += ndcg(ranked, rel, 10);
      rc += recallAt(ranked, rel, 10);
      if (hitAt(ranked, rel, 5)) h5 += 1;
      if (hitAt(ranked, rel, 10)) h10 += 1;
    }
    const n = arms.length;
    rows.push({ k, ndcg10: nd / n, recall10: rc / n, hit5: h5 / n, hit10: h10 / n });
    console.log(
      `   ${String(k).padStart(4)} |  ${(nd / n).toFixed(4)} |    ${(rc / n).toFixed(4)} | ${((h5 / n) * 100).toFixed(1)}% | ${((h10 / n) * 100).toFixed(1)}%`
    );
  }

  // ── paired comparison, because a table of means can hide a coin flip ──────
  const [ka, kb] = arg("--paired", "5,60")
    .split(",")
    .map((s) => Number.parseInt(s, 10));
  if (Number.isFinite(ka) && Number.isFinite(kb)) {
    const rankFor = (a: (typeof arms)[number], k: number): string[] =>
      [...fuseRRF(a.bm25, a.dense, k).entries()].sort((x, y) => y[1].score - x[1].score).map(([id]) => id);
    const diffs = arms.map((a) => {
      const rel = qrels.get(a.qid)!;
      return ndcg(rankFor(a, ka), rel, 10) - ndcg(rankFor(a, kb), rel, 10);
    });
    const wins = diffs.filter((d) => d > 1e-12).length;
    const losses = diffs.filter((d) => d < -1e-12).length;
    const ties = diffs.length - wins - losses;
    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;

    // Paired bootstrap over queries. mulberry32, not the textbook
    // `(s*1103515245+12345) & 0x7fffffff` LCG: that multiply reaches 2.4e18,
    // past Number.MAX_SAFE_INTEGER, so the low bits are rounded away BEFORE
    // the mask ever sees them. The result has a period of 10 466 and 15 824
    // distinct values — 10k resamples then cycle the same sequence ~309 times
    // and the "bootstrap" is a fixed pattern with a 3x occupancy bias.
    let rngState = 42 >>> 0;
    const rnd = (): number => {
      rngState = (rngState + 0x6d2b79f5) >>> 0;
      let t = rngState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const means: number[] = [];
    for (let b = 0; b < 10_000; b++) {
      let s = 0;
      for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rnd() * diffs.length)]!;
      means.push(s / diffs.length);
    }
    means.sort((x, y) => x - y);
    const lo = means[Math.floor(0.025 * means.length)]!;
    const hi = means[Math.floor(0.975 * means.length)]!;
    // two-sided bootstrap p: how often the resampled mean crosses zero
    const crossings = means.filter((m) => (mean > 0 ? m <= 0 : m >= 0)).length;
    const p = Math.min(1, (2 * crossings) / means.length);
    // Sign-flip permutation as a second opinion — it makes no distributional
    // assumption and does not reuse the resampling machinery, so the two
    // failing together is informative.
    let ge = 0;
    for (let b = 0; b < 10_000; b++) {
      let s = 0;
      for (const d of diffs) s += rnd() < 0.5 ? -d : d;
      if (Math.abs(s / diffs.length) >= Math.abs(mean)) ge += 1;
    }
    const pPerm = (ge + 1) / 10_001;
    console.log(`\n── paired: k=${ka} vs k=${kb}, per-query nDCG@10 (n=${diffs.length}) ──`);
    console.log(
      `   mean Δ ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}   95% CI [${lo.toFixed(4)}, ${hi.toFixed(4)}]   bootstrap p=${p.toFixed(4)}   sign-flip p=${pPerm.toFixed(4)}`
    );
    console.log(`   better on ${wins} queries · worse on ${losses} · unchanged on ${ties}`);
    if (arg("--dump-diffs", "")) {
      await fs.writeFile(arg("--dump-diffs", ""), JSON.stringify(diffs));
    }
  }

  // single-arm references, so "the fusion helps at all" stays falsifiable
  let bmNd = 0;
  let dnNd = 0;
  for (const a of arms) {
    const rel = qrels.get(a.qid)!;
    bmNd += ndcg(a.bm25, rel, 10);
    dnNd += ndcg(a.dense, rel, 10);
  }
  console.log(`\n   bm25 arm alone   nDCG@10 ${(bmNd / arms.length).toFixed(4)}`);
  console.log(`   dense arm alone  nDCG@10 ${(dnNd / arms.length).toFixed(4)}`);

  await emb.stop();
  search.stop();
  await vault.stop();
  if (outPath) await fs.writeFile(outPath, JSON.stringify({ split, n: arms.length, rows }, null, 2));
}

void main();
