/**
 * Does the fusion constant matter MORE on a bigger corpus, and LESS on a more
 * diverse one?
 *
 * Both are mechanical predictions, not preferences:
 *
 *   size      — the constant only decides anything when the two arms DISAGREE
 *               about rank. On a tiny corpus both arms return nearly the same
 *               handful of documents and there is nothing to decide. The bigger
 *               the pool, the further the arms drift apart, so the effect of
 *               how you combine them should grow with corpus size.
 *   diversity — if every document is obviously distinct, both arms find the
 *               right one and the combination rule is irrelevant. If the corpus
 *               is full of near-duplicates of the answer, ranking is the whole
 *               problem and the rule decides. So a HARDER (less diverse,
 *               confusable) corpus should show a bigger effect than a random
 *               one of the same size.
 *
 * Method: one embedding pass over the full BEIR corpus, then rebuild the arms
 * per configuration. The BM25 arm is re-indexed for each subset — IDF is a
 * corpus statistic, so filtering results from a full index would be a lie. The
 * dense arm is the same vectors restricted to the subset, which is exactly
 * right: cosine is per-document.
 *
 * Scored single-gold (reciprocal rank of one right document) rather than nDCG
 * over the full qrels: NFCorpus judges ~38 documents per query, so pinning
 * every relevant one fixes the corpus at ~3 000 and the size knob does nothing.
 * Single-gold is also the shape a personal vault has — one note is the note.
 * The gold is pinned into every subset; the rest is filled either at random
 * (the diverse condition) or with the documents nearest to the golds (the
 * confusable condition).
 *
 *   npx tsx src/rrf-k-scale.ts --data ./nfcorpus --split test --queries 200
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
const slug = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** mulberry32 — see rrf-k-beir.ts for why the textbook LCG is not usable here. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function readJsonl<T>(p: string): Promise<T[]> {
  return (await fs.readFile(p, "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

interface Stat {
  mean: number;
  lo: number;
  hi: number;
  p: number;
  wins: number;
  losses: number;
}

function pairedStat(diffs: number[], seed = 42): Stat {
  const rnd = rng(seed);
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const means: number[] = [];
  for (let b = 0; b < 10_000; b++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rnd() * diffs.length)]!;
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  const crossings = means.filter((m) => (mean > 0 ? m <= 0 : m >= 0)).length;
  return {
    mean,
    lo: means[Math.floor(0.025 * means.length)]!,
    hi: means[Math.floor(0.975 * means.length)]!,
    p: Math.min(1, (2 * crossings) / means.length),
    wins: diffs.filter((d) => d > 1e-12).length,
    losses: diffs.filter((d) => d < -1e-12).length,
  };
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function main(): Promise<void> {
  const data = arg("--data", "");
  const split = arg("--split", "test");
  const nQueries = Number.parseInt(arg("--queries", "200"), 10);
  const depth = Number.parseInt(arg("--depth", "50"), 10);
  const outPath = arg("--out", "");
  /** `{ "<voice>": { "<query id>": "the same question in that voice" } }` —
   *  same shape as fixtures/personas.json. When supplied, every gold is asked
   *  once per voice and the per-gold delta is the MEAN over voices: more
   *  measurements per cluster tightens the estimate without pretending the
   *  paraphrases are independent observations. */
  const personasPath = arg("--personas", "");
  if (!data) {
    console.error("FATAL: --data /path/to/nfcorpus");
    process.exit(2);
  }

  const qrelsText = await fs.readFile(path.join(data, "qrels", `${split}.tsv`), "utf8");
  const qrels = new Map<string, Map<string, number>>();
  for (const line of qrelsText.split("\n").slice(1)) {
    const [qid, did, score] = line.split("\t");
    if (!qid || !did) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid)!.set(slug(did), Number.parseInt(score ?? "0", 10) || 0);
  }
  const corpus = await readJsonl<{ _id: string; title: string; text: string }>(path.join(data, "corpus.jsonl"));
  const personas: Record<string, Record<string, string>> = personasPath
    ? (JSON.parse(await fs.readFile(personasPath, "utf8")) as { personas: Record<string, Record<string, string>> })
        .personas
    : {};
  const voices = Object.keys(personas);
  let queries = (await readJsonl<{ _id: string; text: string }>(path.join(data, "queries.jsonl"))).filter((q) =>
    qrels.has(q._id)
  );
  if (voices.length > 0) {
    // only the queries every voice has rephrased, so the arms compare like for like
    const covered = new Set(Object.keys(personas[voices[0]!]!));
    for (const v of voices.slice(1)) for (const id of covered) if (!(id in personas[v]!)) covered.delete(id);
    queries = queries.filter((q) => covered.has(q._id));
  }
  queries = queries.slice(0, nQueries);

  // ── one vault, one embedding pass, reused by every configuration ──────────
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rrf-k-scale-"));
  const fullRoot = path.join(work, "full");
  await fs.mkdir(path.join(fullRoot, "memories"), { recursive: true });
  const esc = (s: string): string => JSON.stringify(s.replace(/\s+/g, " ").trim());
  const docText = new Map<string, string>();
  for (const d of corpus) {
    const id = slug(d._id);
    const md =
      `---\nid: ${id}\ntitle: ${esc(d.title || id)}\ntype: reference\n` +
      `summary: ${esc((d.text || "").slice(0, 200))}\ntopic_path: [beir]\ntags: [beir]\n` +
      `scope: beir\nrecall_when: []\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n\n${d.text ?? ""}\n`;
    docText.set(id, md);
    await fs.writeFile(path.join(fullRoot, "memories", `${id}.md`), md);
  }
  const fullVault = new Vault(fullRoot);
  const { loaded } = await fullVault.init();
  const provider = new OllamaEmbeddingProvider({
    baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
    keepAlive: "30m",
  });
  const embPath = path.join(work, "embeddings.json");
  const fullEmb = new EmbeddingIndex(fullVault, provider, embPath, path.join(work, "cache.json"));
  await fullEmb.start();
  let stalled = Date.now();
  let last = -1;
  while (fullEmb.size() < loaded) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stderr.write(`\rembedding ${fullEmb.size()}/${loaded}`);
    if (fullEmb.size() !== last) {
      last = fullEmb.size();
      stalled = Date.now();
    }
    if (Date.now() - stalled > 120_000) {
      console.error("\nFATAL: embedding stalled — is Ollama reachable?");
      process.exit(3);
    }
  }
  process.stderr.write("\n");
  const vectors = new Map(fullEmb.snapshot());
  const queryVecs = new Map<string, Float32Array>();
  for (let i = 0; i < queries.length; i += 32) {
    const batch = queries.slice(i, i + 32);
    const vecs = await provider.embed(batch.map((q) => q.text));
    batch.forEach((q, j) => queryVecs.set(q._id, vecs[j]!));
  }
  // one embedding pass for every voice of every question
  const voiceVecs = new Map<string, Float32Array>();
  if (voices.length > 0) {
    const pending: { key: string; text: string }[] = [];
    for (const q of queries)
      for (const v of voices) pending.push({ key: `${q._id}|${personas[v]![q._id]!}`, text: personas[v]![q._id]! });
    for (let i = 0; i < pending.length; i += 32) {
      const batch = pending.slice(i, i + 32);
      const vecs = await provider.embed(batch.map((b) => b.text));
      batch.forEach((b, j) => voiceVecs.set(b.key, vecs[j]!));
    }
    console.error(`embedded ${voiceVecs.size} persona queries across ${voices.length} voices`);
  }
  await fullEmb.stop();
  await fullVault.stop();
  console.error(`corpus ${loaded} docs · ${queries.length} queries · ${vectors.size} vectors`);

  // NFCorpus judges ~38 documents per query, so pinning every relevant one
  // fixes the corpus at ~3 000 and the size knob does nothing. Pin ONE gold per
  // query — the highest-graded judged document — and score single-gold. That is
  // also the shape a personal vault has: one note is the right note.
  const goldOf = new Map<string, string>();
  for (const q of queries) {
    const best = [...qrels.get(q._id)!.entries()]
      .filter(([id, g]) => g > 0 && vectors.has(id))
      .sort((a, b) => b[1] - a[1])[0];
    if (best) goldOf.set(q._id, best[0]);
  }
  const relevantIds = new Set(goldOf.values());
  const otherIds = [...vectors.keys()].filter((id) => !relevantIds.has(id));
  console.error(`${relevantIds.size} judged-relevant docs are pinned into every subset`);

  /** Documents most similar to the relevant set — the confusable filler. */
  const nearestToRelevant = (): string[] => {
    const rel = [...relevantIds].map((id) => vectors.get(id)!);
    return otherIds
      .map((id) => {
        const v = vectors.get(id)!;
        let best = -2;
        for (const r of rel) best = Math.max(best, cosine(v, r));
        return { id, best };
      })
      .sort((a, b) => b.best - a.best)
      .map((x) => x.id);
  };

  const configs: { label: string; size: number; filler: "random" | "hard" }[] = [];
  for (const size of [300, 600, 1200, 2400, 3633]) configs.push({ label: `random ${size}`, size, filler: "random" });
  configs.push({ label: `confusable 600`, size: 600, filler: "hard" });
  configs.push({ label: `confusable 1200`, size: 1200, filler: "hard" });
  configs.push({ label: `confusable 2400`, size: 2400, filler: "hard" });

  const hardOrder = nearestToRelevant();
  const results: Record<string, unknown>[] = [];

  for (const cfg of configs) {
    const need = Math.max(0, cfg.size - relevantIds.size);
    let filler: string[];
    if (cfg.filler === "hard") {
      filler = hardOrder.slice(0, need);
    } else {
      const rnd = rng(7);
      const pool = [...otherIds];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      filler = pool.slice(0, need);
    }
    const subset = new Set([...relevantIds, ...filler]);

    // BM25 has to be re-indexed: IDF is a corpus statistic.
    const subRoot = path.join(work, `sub-${cfg.label.replace(/\s+/g, "-")}`);
    await fs.mkdir(path.join(subRoot, "memories"), { recursive: true });
    for (const id of subset) await fs.writeFile(path.join(subRoot, "memories", `${id}.md`), docText.get(id)!);
    const vault = new Vault(subRoot);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();

    const diffs: number[] = [];
    let nd5 = 0;
    let nd60 = 0;
    let ndBm = 0;
    let ndDn = 0;
    for (const q of queries) {
      const gold = goldOf.get(q._id);
      if (!gold) continue;
      const bm25 = search.recall(q.text, { k: depth }).map((h) => h.id);
      const qv = queryVecs.get(q._id)!;
      const dense = [...subset]
        .map((id) => ({ id, s: cosine(qv, vectors.get(id)!) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, depth)
        .map((x) => x.id);
      // Every voice of the same question, averaged into ONE per-gold number.
      const asked = voices.length > 0 ? voices.map((v) => personas[v]![q._id]!) : [q.text];
      let a = 0;
      let b = 0;
      let bm = 0;
      let dn = 0;
      for (const text of asked) {
        const bmIds = text === q.text ? bm25 : search.recall(text, { k: depth }).map((h) => h.id);
        const qvv = text === q.text ? qv : voiceVecs.get(`${q._id}|${text}`)!;
        const dnIds =
          text === q.text
            ? dense
            : [...subset]
                .map((id) => ({ id, s: cosine(qvv, vectors.get(id)!) }))
                .sort((x, y) => y.s - x.s)
                .slice(0, depth)
                .map((x) => x.id);
        const rankOf = (k: number): string[] =>
          [...fuseRRF(bmIds, dnIds, k).entries()].sort((x, y) => y[1].score - x[1].score).map(([id]) => id);
        const rrOf = (order: string[]): number => {
          const i = order.indexOf(gold);
          return i === -1 ? 0 : 1 / (i + 1);
        };
        a += rrOf(rankOf(5));
        b += rrOf(rankOf(60));
        bm += rrOf(bmIds);
        dn += rrOf(dnIds);
      }
      a /= asked.length;
      b /= asked.length;
      nd5 += a;
      nd60 += b;
      ndBm += bm / asked.length;
      ndDn += dn / asked.length;
      diffs.push(a - b);
    }
    search.stop();
    await vault.stop();
    await fs.rm(subRoot, { recursive: true, force: true });

    const st = pairedStat(diffs);
    results.push({
      config: cfg.label,
      docs: subset.size,
      mrr_k5: nd5 / diffs.length,
      mrr_k60: nd60 / diffs.length,
      mrr_bm25: ndBm / diffs.length,
      mrr_dense: ndDn / diffs.length,
      ...st,
    });
    console.error(
      `${cfg.label.padEnd(17)} docs=${String(subset.size).padStart(4)} n=${diffs.length} ` +
        `Δ=${st.mean >= 0 ? "+" : ""}${st.mean.toFixed(4)} p=${st.p.toFixed(4)} (${st.wins}/${st.losses})`
    );
  }

  console.log(`\n── does the fusion constant matter more at scale? (n=${queries.length} queries) ──`);
  console.log(`   ${"corpus".padEnd(17)} | docs | bm25   | dense  | k=60   | k=5    | Δ       | 95% CI            | p`);
  console.log("   " + "-".repeat(110));
  for (const r of results as {
    config: string;
    docs: number;
    mrr_k5: number;
    mrr_k60: number;
    mrr_bm25: number;
    mrr_dense: number;
    mean: number;
    lo: number;
    hi: number;
    p: number;
  }[]) {
    console.log(
      `   ${r.config.padEnd(17)} | ${String(r.docs).padStart(4)} | ${r.mrr_bm25.toFixed(4)} | ` +
        `${r.mrr_dense.toFixed(4)} | ${r.mrr_k60.toFixed(4)} | ` +
        `${r.mrr_k5.toFixed(4)} | ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(4)} | ` +
        `[${r.lo.toFixed(4)}, ${r.hi.toFixed(4)}] | ${r.p.toFixed(4)}`
    );
  }
  if (outPath) await fs.writeFile(outPath, JSON.stringify(results, null, 2));
}

void main();
