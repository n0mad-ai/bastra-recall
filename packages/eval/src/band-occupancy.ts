/**
 * Band occupancy at the shipped constants — the t0 for #302's open door.
 *
 * #302 closed with the wording fixed and the cuts left where they were, because
 * #335 moved the scale under them (RRF_K 60 -> 5). The maintainer left one
 * thing open: "if the occupancy still reads wrong after #335 has run against a
 * real vault for a while, that door is open."
 *
 * That check needs a BEFORE. This is it: the same split #302 measured
 * (dropped <30 / OPTIONAL 30..99 / REQUIRED >=100, plus the bash-fail floor at
 * 50), re-run on a real vault at the constants actually shipped, with the arm
 * decomposition read from `RecallHit.rrf` rather than inferred from `mode`.
 *
 * WHAT THIS IS NOT: the queries are each memory's own declared `recall_when`
 * phrase. That is circular by construction — the same upper bound the eval
 * README flags on the M0 baseline — so the OCCUPANCY here is the friendliest
 * case the bands will ever see. It is a valid t0 only against itself: the
 * comparison later must re-run this same script, not a different query source.
 * Live hook traffic is the honest denominator and this is not it.
 *
 *   BASTRA_VAULT_PATH=~/vault npx tsx src/band-occupancy.ts --n 400 --out t0.json
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Vault, SearchIndex, EmbeddingIndex, OllamaEmbeddingProvider, RRF_K, RRF_SCALE } from "@bastra-recall/core";

/** Same semantics as `daemon/src/env.ts`, replicated because `@bastra-recall/eval`
 *  depends on `core` only — pulling in `daemon` for two numbers is the larger
 *  evil. Keep in step with `envInt` there if that ever changes. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// The bands are NOT constants in the hook — they are env-tunable there
// (`hook.ts:66,70`), so hardcoding the defaults here would measure the shipped
// numbers on a machine that runs different ones. That is the same mistake this
// harness exists to correct, one level up: the measurement has to take the
// shape the hook actually has, and on this machine that shape includes the
// environment. Whoever raised BASTRA_RECALL_FLOOR gets their floor measured.
const FLOOR = envInt("BASTRA_RECALL_FLOOR", 30);
const MUST_LOAD = envInt("BASTRA_MUST_LOAD_SCORE", 100);
// Not env-tunable: `bash-fail-hook.ts:44` hardcodes it. Literal on purpose.
const BASH_FAIL_FLOOR = 50;

interface Row {
  query: string;
  k: number;
  id: string;
  score: number;
  rank_bm25: number | null;
  rank_vector: number | null;
  band: "dropped" | "optional" | "required";
  arms: 1 | 2 | 0;
  /** A seed of the fused list, or a one-hop neighbour appended after the cut. */
  hop: "direct" | "1-hop";
  /** 1-based position in the list the caller received, seeds first. */
  pos: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string, d: string): string => {
    const i = argv.indexOf(n);
    return i === -1 ? d : (argv[i + 1] ?? d);
  };
  const n = Number.parseInt(arg("--n", "400"), 10);
  // Default stops at 10 because `/hook/recall` clamps there (`http.ts`). A run
  // at k=30 measures a call the hook cannot make — the very thing the --hops
  // switch below exists to stop doing. Higher values stay available on the flag
  // for the question "what does the tail look like", which is a different one.
  const ks = arg("--k", "3,10")
    .split(",")
    .map((s) => Number.parseInt(s, 10));
  const outPath = arg("--out", "");
  // A BEIR corpus directory (corpus.jsonl + queries.jsonl) instead of a personal
  // vault. The occupancy of a band is a corpus property, so a number measured on
  // a private vault can open a question and cannot close one — the same reason
  // `rrf-k-beir.ts` settles the constant on NFCorpus rather than on anyone's
  // notes. Same code path, same constants, a corpus the reader can download.
  const corpusDir = arg("--corpus", "").replace(/^~/, os.homedir());
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "band-occupancy-"));

  let vaultRoot = (process.env.BASTRA_VAULT_PATH ?? arg("--vault", "")).replace(/^~/, os.homedir());
  let embSeed: string | null = null;
  if (corpusDir) {
    // Vault build copied from rrf-k-beir.ts, so both harnesses measure the same
    // documents the same way. No recall_when: a public corpus has no
    // author-written triggers and inventing them would test doc2query.
    const slug = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const esc = (s: string): string => JSON.stringify(s.replace(/\s+/g, " ").trim());
    const corpus = (await fs.readFile(path.join(corpusDir, "corpus.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { _id: string; title: string; text: string });
    vaultRoot = path.join(work, "vault");
    await fs.mkdir(path.join(vaultRoot, "memories"), { recursive: true });
    for (const doc of corpus) {
      const id = slug(doc._id);
      await fs.writeFile(
        path.join(vaultRoot, "memories", `${id}.md`),
        `---\nid: ${id}\ntitle: ${esc(doc.title || id)}\ntype: reference\n` +
          `summary: ${esc((doc.text || "").slice(0, 200))}\ntopic_path: [beir]\ntags: [beir]\n` +
          `scope: beir\nrecall_when: []\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n\n${doc.text ?? ""}\n`
      );
    }
    console.error(`corpus ${corpus.length} docs -> ${vaultRoot}`);
  } else {
    if (!vaultRoot) {
      console.error("FATAL: set BASTRA_VAULT_PATH (or --vault), or pass --corpus <beir dir>");
      process.exit(2);
    }
    embSeed = path.join(vaultRoot, ".bastra", "embeddings.json");
    if (!(await fs.stat(embSeed).catch(() => null))) {
      console.error(`FATAL: ${embSeed} not found — run the daemon once on this vault first.`);
      process.exit(2);
    }
  }

  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const provider = new OllamaEmbeddingProvider({
    baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
    keepAlive: "10m",
  });
  // Same discipline as pool-depth.ts: work off a COPY, the vault is an input.
  const embWork = path.join(work, "embeddings.json");
  if (embSeed) await fs.copyFile(embSeed, embWork);
  const emb = new EmbeddingIndex(vault, provider, embWork, path.join(work, "cache.json"));
  await emb.start();
  // start() kicks the backfill off without awaiting it (same trap rrf-k-beir.ts
  // documents). Querying before it lands measures the BM25 arm alone and reports
  // it as hybrid: no `rrf` field, scores in the hundreds, 100% REQUIRED. Wait.
  const embedDeadline = Date.now() + Number(process.env.BASTRA_EMBED_TIMEOUT_MS ?? 3_600_000);
  let lastSize = -1;
  let stalledSince = Date.now();
  while (emb.size() < vault.size()) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stderr.write(`\rembedding ${emb.size()}/${vault.size()}`);
    if (emb.size() !== lastSize) {
      lastSize = emb.size();
      stalledSince = Date.now();
    }
    if (Date.now() - stalledSince > 120_000 || Date.now() > embedDeadline) {
      console.error(`\nFATAL: embedding stalled at ${emb.size()}/${vault.size()}.`);
      process.exit(3);
    }
  }
  process.stderr.write("\n");
  search.useEmbeddings(emb);

  // Two query sources, and which one is used IS the angle (blocker-protocol 4a).
  //
  //   default  — one trigger phrase per memory. A query the vault CAN answer.
  //              Circular, friendliest case, and the angle #302 already took.
  //   --queries — a file of one query per line, off-vault by intent. The angle
  //              #230/#239 establish: an absolute cut only means something if
  //              the score means something when there is nothing to find. The
  //              floor exists for exactly this case, so this is where it has to
  //              be measured. Re-running the default is not a second look.
  const queriesFile = arg("--queries", "");
  const queries = queriesFile
    ? (await fs.readFile(queriesFile, "utf8"))
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("#"))
        .slice(0, n)
        .map((q) => ({ id: q, q }))
    : corpusDir
      ? // BEIR: the corpus ships real user queries with graded relevance. These
        // are answerable by construction and, unlike a memory's own trigger,
        // nobody wrote them against these documents.
        (await fs.readFile(path.join(corpusDir, "queries.jsonl"), "utf8"))
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as { _id: string; text: string })
          .slice(0, n)
          .map((q) => ({ id: q._id, q: q.text }))
      : vault
          .list()
          .map((m) => ({ id: m.fm.id, q: m.fm.recall_when?.[0] ?? "" }))
          .filter((x) => x.q.trim().length > 0)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, n);

  console.error(
    `vault ${vault.size()} memories, ${emb.size()} vectors, ${queries.length} queries` +
      `, RRF_K=${RRF_K} RRF_SCALE=${RRF_SCALE.toFixed(2)}`
  );
  // A band report that does not name its own cuts is unreadable the moment the
  // cuts are tunable — the reader cannot tell 30 from a raised floor.
  console.error(
    `  bands: floor ${FLOOR}${FLOOR === 30 ? "" : " (BASTRA_RECALL_FLOOR)"}` +
      `, must-load ${MUST_LOAD}${MUST_LOAD === 100 ? "" : " (BASTRA_MUST_LOAD_SCORE)"}` +
      `, bash-fail ${BASH_FAIL_FLOOR}`
  );
  // The inversion #302 shipped, printed so the bands can be read as ranks.
  for (const cut of [FLOOR, BASH_FAIL_FLOOR, MUST_LOAD]) {
    console.error(
      `  cut ${String(cut).padStart(3)} -> two-armed to rank ${Math.floor((2 * RRF_SCALE) / cut - RRF_K)}` +
        `, one-armed to rank ${Math.floor(RRF_SCALE / cut - RRF_K)}`
    );
  }

  // The shape of the call IS part of the measurement. `/hook/recall` defaults
  // expand_hops to 1 (http.ts:1000) and appends up to k one-hop neighbours to
  // the k seeds, each scored `seed.score * 0.5 * link.score` (search.ts:568) —
  // half a seed at best. Those neighbours are the only hits that can land under
  // the floor at 30 on this path, so a run with hops off measures a call the
  // hook never makes and reports the floor as inert.
  const hops: 0 | 1 = arg("--hops", "1") === "0" ? 0 : 1;
  console.error(`  expand_hops=${hops} (the hook's own default is 1)`);

  const rows: Row[] = [];
  for (const k of ks) {
    for (const { q } of queries) {
      const hits = await search.recallHybrid(q, { k, expand_hops: hops });
      for (const h of hits) {
        const rb = h.rrf?.rank_bm25 ?? null;
        const rv = h.rrf?.rank_vector ?? null;
        const arms = ((rb !== null ? 1 : 0) + (rv !== null ? 1 : 0)) as 0 | 1 | 2;
        rows.push({
          query: q,
          k,
          id: h.id,
          score: h.score,
          rank_bm25: rb,
          rank_vector: rv,
          band: h.score >= MUST_LOAD ? "required" : h.score >= FLOOR ? "optional" : "dropped",
          arms,
          hop: h.hop ?? "direct",
          pos: hits.indexOf(h) + 1,
        });
      }
    }
  }

  const pct = (a: number, b: number): string => (b === 0 ? "  n/a" : `${((100 * a) / b).toFixed(1)}%`);
  for (const k of ks) {
    const r = rows.filter((x) => x.k === k);
    const req = r.filter((x) => x.band === "required");
    const opt = r.filter((x) => x.band === "optional");
    const drop = r.filter((x) => x.band === "dropped");
    console.log(`\n── k=${k}  (${r.length} hits over ${queries.length} queries) ──`);
    console.log(
      `  REQUIRED >=100   ${pct(req.length, r.length).padStart(6)}` +
        `   — ${pct(req.filter((x) => x.arms === 2).length, req.length)} found by BOTH arms` +
        `, ${pct(req.filter((x) => x.arms === 1).length, req.length)} by one`
    );
    console.log(
      `  OPTIONAL 30..99  ${pct(opt.length, r.length).padStart(6)}` +
        `   — ${pct(opt.filter((x) => x.arms === 1).length, opt.length)} found by ONE arm`
    );
    console.log(
      `  dropped   <30    ${pct(drop.length, r.length).padStart(6)}` +
        `   — ${pct(drop.filter((x) => x.hop === "1-hop").length, drop.length)} of them one-hop neighbours`
    );
    console.log(`  above bash-fail floor (>=50): ${pct(r.filter((x) => x.score >= BASH_FAIL_FLOOR).length, r.length)}`);
    const seeds = r.filter((x) => x.hop === "direct");
    const neigh = r.filter((x) => x.hop === "1-hop");
    if (neigh.length) {
      console.log(
        `  hits per query ${(r.length / queries.length).toFixed(1)} ` +
          `(${(seeds.length / queries.length).toFixed(1)} seeds + ${(neigh.length / queries.length).toFixed(1)} hops)` +
          `   hop hits under the floor: ${pct(neigh.filter((x) => x.score < FLOOR).length, neigh.length)}`
      );
    }
    // Two different medians, labelled as what they are. The all-hits median is
    // NOT the median top hit — printing one under the other's name manufactures
    // a finding out of a column heading.
    const med = (xs: number[]): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
    const perQuery = new Map<string, Row[]>();
    for (const x of r) perQuery.set(x.query, [...(perQuery.get(x.query) ?? []), x]);
    const tops = [...perQuery.values()].map((v) => Math.max(...v.map((x) => x.score)));
    console.log(
      `  score median over ALL served hits ${med(r.map((x) => x.score)).toFixed(1)}` +
        `   ·   median of each query's TOP hit ${med(tops).toFixed(1)}` +
        `   ·   max ${Math.max(...r.map((x) => x.score), 0).toFixed(1)}`
    );
    const allReq = [...perQuery.values()].filter((v) => v.every((x) => x.band === "required")).length;
    const anyOpt = [...perQuery.values()].filter((v) => v.some((x) => x.band === "optional")).length;
    console.log(`  queries where EVERY served hit is REQUIRED: ${pct(allReq, perQuery.size)}`);
    console.log(`  queries with any OPTIONAL hit at all:       ${pct(anyOpt, perQuery.size)}`);
  }

  await emb.stop();
  search.stop();
  await vault.stop();
  if (outPath) {
    await fs.writeFile(
      outPath,
      JSON.stringify({ at: new Date().toISOString(), rrf_k: RRF_K, rrf_scale: RRF_SCALE, rows }, null, 2)
    );
    console.error(`\nwrote ${outPath}`);
  }
}

void main();
