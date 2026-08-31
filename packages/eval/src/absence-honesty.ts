/**
 * Absence honesty — does recall say "I don't have it" when it doesn't have it?
 *
 * The operational claim every MCP client is given is "call recall before any
 * other lookup tool". Against `grep` that claim has two halves:
 *
 *   1. on a fact the vault HOLDS, recall should find it where a literal search
 *      would not (paraphrase, synonym, other language);
 *   2. on a fact the vault does NOT hold, recall should say so — because grep
 *      does. `grep -q` exits 1 and the caller knows to look elsewhere. A
 *      ranked list always has a first element, so recall has to signal absence
 *      explicitly or the caller cannot tell a hit from a rank-1-of-nothing.
 *
 * Half 2 is what this harness measures, by leave-one-out: for each sampled
 * memory the SAME query (its own declared `recall_when` trigger) is run twice
 * against the same corpus, differing on exactly one bit —
 *
 *   present : the memory is in the vault      → the flags must stay silent
 *   absent  : the memory is held out          → `weak_result` / `no_home` must fire
 *
 * The query being the memory's own trigger makes the ABSENT arm the strongest
 * case the flag will ever see: if the declared trigger of a memory that is not
 * there does not read as absence, nothing will. The PRESENT arm's hit rate is
 * circular by construction (README: "queries each memory with its own
 * recall_when phrase — an upper bound") and is reported only as the control
 * that the harness indexes what it thinks it indexes.
 *
 * The grep baseline is the same corpus searched literally: AND over the query's
 * content words is the "did it match at all" signal (grep's exit code), OR
 * ranked by distinct-term coverage is what an agent actually does when the AND
 * comes back empty.
 *
 * Run:
 *   BASTRA_VAULT_PATH=/path/to/vault npx tsx src/absence-honesty.ts --n 40
 *   … --out honesty.json --k 5
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OllamaEmbeddingProvider,
  isWeakResult,
  isNoHome,
} from "@bastra-recall/core";

// The two predicates under test used to be copied in here, because they lived
// in packages/daemon and eval does not depend on that workspace. They moved to
// core with the M1 measurement (#262), so the harness now measures the code
// that ships instead of a copy of it — and the drift guard that watched the
// copy (__tests__/absence-honesty-parity.test.ts) retired with it.

// ── grep baseline ───────────────────────────────────────────────────────────
/** A lexical baseline needs a stoplist, and a stoplist is corpus-dependent.
 *  These are the project's own languages; point `--stopwords <file>` (one term
 *  per line) at your own for a vault written in something else. Getting this
 *  wrong makes the baseline weaker, i.e. flatters recall — so it is worth
 *  getting right before quoting the comparison. */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "not", "but", "was", "are", "its",
  "from", "into", "when", "what", "which", "you", "your", "has", "had", "have",
  "der", "die", "das", "und", "oder", "aber", "nicht", "ist", "sind", "war",
  "eine", "einen", "einem", "einer", "den", "dem", "des", "mit", "auf", "für",
]);

/** Extra stopwords from `--stopwords <file>`, one per line. */
async function loadStopwords(file: string): Promise<void> {
  if (!file) return;
  for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
    const t = line.trim().toLowerCase();
    if (t && !t.startsWith("#")) STOP.add(t);
  }
}

function contentTerms(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.-]+/u)
        .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    ),
  ];
}

interface GrepResult {
  /** files matching EVERY content term — the `grep -q` signal */
  and: string[];
  /** top-k by distinct-term coverage, then raw count */
  ranked: string[];
}

function grepBaseline(corpus: Map<string, string>, query: string, k: number): GrepResult {
  const terms = contentTerms(query);
  if (terms.length === 0) return { and: [], ranked: [] };
  const scored: { id: string; distinct: number; total: number }[] = [];
  for (const [id, text] of corpus) {
    let distinct = 0;
    let total = 0;
    for (const t of terms) {
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      const n = (text.match(re) ?? []).length;
      if (n > 0) {
        distinct += 1;
        total += n;
      }
    }
    if (distinct > 0) scored.push({ id, distinct, total });
  }
  scored.sort((a, b) => b.distinct - a.distinct || b.total - a.total);
  return {
    and: scored.filter((s) => s.distinct === terms.length).map((s) => s.id),
    ranked: scored.slice(0, k).map((s) => s.id),
  };
}

// ── corpus staging ──────────────────────────────────────────────────────────
/** Hardlink every memory that HAS a persisted vector into a work dir.
 *  Hardlinks, not symlinks: the vault walker counts dirents, and a symlink is
 *  not a file. Restricting to vector-carrying memories keeps EmbeddingIndex
 *  from backfilling — a backfill would re-embed on every round and the arms
 *  would not share a dense leg. */
async function stageCorpus(
  vaultRoot: string,
  workRoot: string,
  keepIds: Set<string>,
): Promise<Map<string, string>> {
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(workRoot, "memories"), { recursive: true });
  const corpus = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(vaultRoot, rel);
    for (const d of await fs.readdir(abs, { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue;
      const childRel = path.join(rel, d.name);
      if (d.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!d.name.endsWith(".md")) continue;
      const text = await fs.readFile(path.join(vaultRoot, childRel), "utf8");
      const id = /^id:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
      if (!id || !keepIds.has(id)) continue;
      await fs.mkdir(path.join(workRoot, path.dirname(childRel)), { recursive: true });
      const src = path.join(vaultRoot, childRel);
      const dst = path.join(workRoot, childRel);
      try {
        await fs.link(src, dst);
      } catch (err) {
        // tmpdir is usually a different filesystem than the vault
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        await fs.copyFile(src, dst);
      }
      corpus.set(id, text);
    }
  };
  await walk("memories");
  return corpus;
}

interface Arm {
  /** enough per-hit detail to re-derive candidate predicates offline without
   *  paying for another 80 index builds — see predicate-sweep.ts */
  hits: {
    id: string;
    title: string;
    score: number;
    matched_terms: string[];
    matched_recall_when: boolean;
    rank_bm25: number | null;
    rank_vector: number | null;
  }[];
  weak_result: boolean;
  no_home: boolean;
  gold_rank: number | null;
}

async function runRecall(
  workRoot: string,
  embSrc: string,
  embWork: string,
  query: string,
  goldId: string,
  k: number,
): Promise<Arm> {
  await fs.copyFile(embSrc, embWork);
  const vault = new Vault(workRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const provider = new OllamaEmbeddingProvider({
    baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
    keepAlive: "10m",
  });
  const emb = new EmbeddingIndex(vault, provider, embWork, path.join(path.dirname(embWork), "cache.json"));
  await emb.start();
  search.useEmbeddings(emb);
  // no score floor here: the floor lives in the handlers, and both arms have to
  // see the same list the predicates in the daemon see.
  const hits = await search.recallHybrid(query, { k });
  const hybridActive = emb.size() > 0;
  const goldIdx = hits.findIndex((h) => h.id === goldId);
  await emb.stop();
  search.stop();
  await vault.stop();
  return {
    hits: hits.map((h) => ({
      id: h.id,
      title: h.title,
      score: Math.round(h.score * 100) / 100,
      matched_terms: h.matched_terms ?? [],
      matched_recall_when: h.matched_recall_when === true,
      rank_bm25: h.rrf?.rank_bm25 ?? null,
      rank_vector: h.rrf?.rank_vector ?? null,
    })),
    weak_result: isWeakResult(hits, hybridActive),
    no_home: isNoHome(hits, hybridActive),
    gold_rank: goldIdx === -1 ? null : goldIdx + 1,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string, def: string): string => {
    const i = argv.indexOf(name);
    return i === -1 ? def : (argv[i + 1] ?? def);
  };
  const vaultRoot = (process.env.BASTRA_VAULT_PATH ?? arg("--vault", "")).replace(
    /^~/,
    os.homedir(),
  );
  if (!vaultRoot) {
    console.error("FATAL: set BASTRA_VAULT_PATH or pass --vault");
    process.exit(1);
  }
  const n = Number.parseInt(arg("--n", "40"), 10);
  const k = Number.parseInt(arg("--k", "5"), 10);
  const seed = Number.parseInt(arg("--seed", "20260804"), 10);
  const outPath = arg("--out", "");
  /** `[{ gold, query }]` — hand-written held-out paraphrases. Without them the
   *  third arm falls back to a sentence lifted from the body, which is a
   *  QUOTATION, not a paraphrase: a literal search wins it by construction and
   *  the arm says nothing about retrieval. */
  const casesPath = arg("--cases", "");
  await loadStopwords(arg("--stopwords", ""));
  const cases: { gold: string; query: string }[] = casesPath
    ? (JSON.parse(await fs.readFile(casesPath, "utf8")) as { gold: string; query: string }[])
    : [];
  const caseQuery = new Map(cases.map((c) => [c.gold, c.query]));

  // Vectors normally come from the daemon that already runs on this vault. A
  // vault nobody has served yet (the bundled fixture, a fresh clone) has none,
  // and staging "memories that have a vector" would then stage nothing — so
  // build them once into a scratch file instead of failing.
  let embSrc = path.join(vaultRoot, ".bastra", "embeddings.json");
  if (!(await fs.stat(embSrc).catch(() => null))) {
    const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), "absence-honesty-seed-"));
    embSrc = path.join(seedDir, "embeddings.json");
    console.error(`no persisted vectors in ${vaultRoot} — embedding it once into ${embSrc}`);
    const seedVault = new Vault(vaultRoot);
    const { loaded } = await seedVault.init();
    const seedIdx = new EmbeddingIndex(
      seedVault,
      new OllamaEmbeddingProvider({
        baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
        model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
        keepAlive: "10m",
      }),
      embSrc,
      path.join(seedDir, "cache.json"),
    );
    await fs.writeFile(embSrc, JSON.stringify({ dim: 0, provider: "seed", vectors: {} }));
    await seedIdx.start();
    while (seedIdx.size() < loaded) await new Promise((r) => setTimeout(r, 500));
    await seedIdx.stop();
    await seedVault.stop();
  }
  // base64-encoded Float32Array per id (embeddings.ts persist format); only
  // the key set is used here, but the type should not claim otherwise
  const persisted = JSON.parse(await fs.readFile(embSrc, "utf8")) as {
    vectors: Record<string, string>;
  };
  const withVectors = new Set(Object.keys(persisted.vectors));

  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "absence-honesty-"));
  const corpusRoot = path.join(workRoot, "vault");
  const embWork = path.join(workRoot, "embeddings.json");
  const corpus = await stageCorpus(vaultRoot, corpusRoot, withVectors);
  console.error(`corpus: ${corpus.size} memories (of ${withVectors.size} with vectors)`);

  // deterministic sample
  // mulberry32. The textbook `(s*1103515245+12345) & 0x7fffffff` LCG is wrong
  // in JS: the multiply reaches 2.4e18, past Number.MAX_SAFE_INTEGER, so the
  // low bits round away before the mask — period 10 466, 15 824 distinct
  // values. Deterministic either way, but a biased shuffle is a biased sample.
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let ids = [...corpus.keys()].sort();
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  if (cases.length > 0) ids = cases.map((c) => c.gold).filter((id) => corpus.has(id));

  const rows: unknown[] = [];
  let picked = 0;
  for (const goldId of ids) {
    if (picked >= n) break;
    const text = corpus.get(goldId)!;
    // first declared trigger, capped — the author's own phrasing
    const rw = /recall_when:\s*\n((?:\s+-.*\n|\s{4,}.*\n)+)/.exec(text)?.[1] ?? "";
    const trigger = rw
      .split("\n")
      .map((l) => l.replace(/^\s*-\s*>?-?\s*/, "").trim())
      .filter((l) => l && l !== ">-")
      .slice(0, 2)
      .join(" ")
      .replace(/\s+/g, " ")
      .split(" ")
      .slice(0, 14)
      .join(" ");
    if (trigger.length < 12) continue;

    // A second query for the SAME memory that is NOT the trigger. The trigger
    // arm is circular by construction — it asks each memory the question it
    // declared for itself — so it can neither measure retrieval nor produce an
    // honest false-positive rate for any anchor rule.
    //
    // `--cases` supplies hand-written held-out paraphrases: the same fact asked
    // in words the memory does not contain. Without them this falls back to a
    // sentence from the body, which is a QUOTATION — a literal search wins it
    // by construction, so that fallback is a plumbing check, not a result.
    const body = text.split(/^---\s*$/m).slice(2).join("---");
    const fallbackQuery = body
      .split(/\n/)
      .map((l) => l.replace(/^[#>\-*\s]+/, "").replace(/[`*_[\]]/g, "").trim())
      .filter((l) => l.length > 40 && !l.startsWith("id:") && !/^\w+:/.test(l))
      .slice(0, 1)
      .join(" ")
      .split(/\s+/)
      .slice(0, 14)
      .join(" ");
    const bodyQuery = caseQuery.get(goldId) ?? fallbackQuery;
    picked += 1;

    // locate the staged file for hold-out
    const file = await findFile(corpusRoot, goldId);
    if (!file) continue;

    const present = await runRecall(corpusRoot, embSrc, embWork, trigger, goldId, k);
    const paraphrase =
      bodyQuery.length >= 20
        ? await runRecall(corpusRoot, embSrc, embWork, bodyQuery, goldId, k)
        : null;

    const backup = `${file}.held`;
    await fs.rename(file, backup);
    const absent = await runRecall(corpusRoot, embSrc, embWork, trigger, goldId, k);
    await fs.rename(backup, file);

    const corpusMinus = new Map(corpus);
    corpusMinus.delete(goldId);
    const grepPresent = grepBaseline(corpus, trigger, k);
    const grepAbsent = grepBaseline(corpusMinus, trigger, k);
    const grepPara = paraphrase ? grepBaseline(corpus, bodyQuery, k) : null;

    rows.push({
      gold: goldId,
      query: trigger,
      body_query: bodyQuery,
      present: {
        recall: present,
        grep_and_hit: grepPresent.and.includes(goldId),
        grep_ranked_hit: grepPresent.ranked.includes(goldId),
        grep_and_count: grepPresent.and.length,
      },
      absent: {
        recall: absent,
        grep_and_count: grepAbsent.and.length,
      },
      paraphrase: paraphrase
        ? {
            recall: paraphrase,
            grep_and_hit: grepPara!.and.includes(goldId),
            grep_ranked_hit: grepPara!.ranked.includes(goldId),
            grep_and_count: grepPara!.and.length,
          }
        : null,
    });
    process.stderr.write(
      `${picked}/${n} ${goldId.slice(0, 42).padEnd(42)} present:r${present.gold_rank ?? "-"} ` +
        `absent:${absent.no_home ? "no_home" : absent.weak_result ? "weak" : "SILENT"} ` +
        `grep-and:${grepAbsent.and.length}\n`,
    );
  }

  const total = rows.length;
  const a = rows as {
    present: { recall: Arm; grep_and_hit: boolean; grep_ranked_hit: boolean };
    absent: { recall: Arm; grep_and_count: number };
    paraphrase: { recall: Arm; grep_and_hit: boolean; grep_ranked_hit: boolean } | null;
  }[];
  const para = a.filter((r) => r.paraphrase !== null);
  const pct = (x: number): string => `${((x / total) * 100).toFixed(1)}%`;
  const summary = {
    n: total,
    present: {
      recall_hit_at_k: a.filter((r) => r.present.recall.gold_rank !== null).length,
      grep_and_hit: a.filter((r) => r.present.grep_and_hit).length,
      grep_ranked_hit: a.filter((r) => r.present.grep_ranked_hit).length,
      recall_flag_false_positive: a.filter((r) => r.present.recall.weak_result).length,
    },
    absent: {
      recall_silent: a.filter((r) => !r.absent.recall.weak_result).length,
      weak_result_fired: a.filter((r) => r.absent.recall.weak_result).length,
      no_home_fired: a.filter((r) => r.absent.recall.no_home).length,
      grep_and_empty: a.filter((r) => r.absent.grep_and_count === 0).length,
    },
    paraphrase: {
      n: para.length,
      recall_hit_at_k: para.filter((r) => r.paraphrase!.recall.gold_rank !== null).length,
      grep_ranked_hit: para.filter((r) => r.paraphrase!.grep_ranked_hit).length,
      grep_and_hit: para.filter((r) => r.paraphrase!.grep_and_hit).length,
      recall_flag_false_positive: para.filter((r) => r.paraphrase!.recall.weak_result).length,
    },
  };

  console.log("\n── absence honesty ──────────────────────────────────────────");
  console.log(`n = ${total} leave-one-out pairs, k = ${k}, corpus ${corpus.size}`);
  console.log("\nPRESENT (control — the memory IS in the vault):");
  console.log(`  recall  gold in top-${k}      ${summary.present.recall_hit_at_k}/${total}  ${pct(summary.present.recall_hit_at_k)}`);
  console.log(`  grep    gold in ranked top-${k} ${summary.present.grep_ranked_hit}/${total}  ${pct(summary.present.grep_ranked_hit)}`);
  console.log(`  grep    gold in AND set      ${summary.present.grep_and_hit}/${total}  ${pct(summary.present.grep_and_hit)}`);
  console.log(`  weak_result false positives  ${summary.present.recall_flag_false_positive}/${total}`);
  console.log("\nABSENT (the memory is held out — the fact has no home):");
  console.log(`  grep    said nothing matched ${summary.absent.grep_and_empty}/${total}  ${pct(summary.absent.grep_and_empty)}`);
  console.log(`  recall  weak_result fired    ${summary.absent.weak_result_fired}/${total}  ${pct(summary.absent.weak_result_fired)}`);
  console.log(`  recall  no_home fired        ${summary.absent.no_home_fired}/${total}  ${pct(summary.absent.no_home_fired)}`);
  console.log(`  recall  SILENT (claims hits) ${summary.absent.recall_silent}/${total}  ${pct(summary.absent.recall_silent)}`);
  const pn = summary.paraphrase.n || 1;
  const ppct = (x: number): string => `${((x / pn) * 100).toFixed(1)}%`;
  console.log(
    `\nPARAPHRASE (same memory, asked ${casesPath ? "with a hand-written held-out query" : "with a sentence from its body — a quotation, not a paraphrase"}):`,
  );
  console.log(`  n = ${summary.paraphrase.n}`);
  console.log(`  recall  gold in top-${k}      ${summary.paraphrase.recall_hit_at_k}/${pn}  ${ppct(summary.paraphrase.recall_hit_at_k)}`);
  console.log(`  grep    gold in ranked top-${k} ${summary.paraphrase.grep_ranked_hit}/${pn}  ${ppct(summary.paraphrase.grep_ranked_hit)}`);
  console.log(`  grep    gold in AND set      ${summary.paraphrase.grep_and_hit}/${pn}  ${ppct(summary.paraphrase.grep_and_hit)}`);
  console.log(`  weak_result false positives  ${summary.paraphrase.recall_flag_false_positive}/${pn}`);

  if (outPath) {
    // the trigger field of every indexed memory, so a predicate sweep can ask
    // "how much of the query actually landed on an author-declared trigger"
    // without re-running the 2×n index builds this took.
    const triggers: Record<string, string> = {};
    for (const [id, text] of corpus) {
      const rw = /recall_when:\s*\n((?:\s+[-> ].*\n)+)/.exec(text)?.[1] ?? "";
      triggers[id] = rw.replace(/\s+/g, " ").trim();
    }
    await fs.writeFile(outPath, JSON.stringify({ summary, rows, triggers }, null, 2));
    console.log(`\nwrote ${outPath}`);
  }
  await fs.rm(workRoot, { recursive: true, force: true });
}

async function findFile(root: string, id: string): Promise<string | null> {
  const walk = async (dir: string): Promise<string | null> => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        const found = await walk(p);
        if (found) return found;
        continue;
      }
      if (!d.name.endsWith(".md")) continue;
      const text = await fs.readFile(p, "utf8");
      const fid = /^id:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
      if (fid === id) return p;
    }
    return null;
  };
  return walk(root);
}

void main();
