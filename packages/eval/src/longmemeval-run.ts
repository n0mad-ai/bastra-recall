#!/usr/bin/env tsx
/**
 * LongMemEval — the fourth arm, and the first one that is EXTERNAL to us (#500).
 *
 * The other three arms answer "did this change help?". They cannot answer "are
 * we good?", because every one of them is built from our own vault: the gold
 * sets are harvested from it, the persona queries are generated out of our own
 * `title` + `summary`, and the arms are compared against each other.
 * `rrf-k-beir.ts` is the one outside anchor we had, and BEIR is generic IR —
 * passages and topical relevance. It says nothing about long-horizon MEMORY
 * retrieval, which is what this product is.
 *
 * LongMemEval (ICLR 2025, arXiv:2410.10813, MIT) is the yardstick the field
 * settled on. Two systems published headline retrieval numbers on it that this
 * run is built to be placed next to — see `registrations/foreign-figures.json`
 * for the citation and the caveats:
 *
 *   MemPalace    96.6% R@5   (raw semantic search, no heuristics, no LLM)
 *   agentmemory  95.2% R@5   (BM25 + vector, all-MiniLM-L6-v2)
 *   agentmemory  86.2% R@5   (BM25 only — the arm our `bm25` arm answers)
 *
 * ── The protocol, matched to those two on purpose ──────────────────────────
 * Both reference runs do the same five things, and so does this one:
 *
 *   1. corpus `longmemeval_s_cleaned.json` — 500 questions, ~48 sessions each
 *   2. a FRESH index per question over that question's own haystack
 *   3. one document per SESSION (`--turns` decides how its turns flatten)
 *   4. the raw question text as the query, no rewriting, no LLM, no reranker
 *   5. `recall_any@k` — does ANY gold session appear in the top k
 *
 * What differs is the retriever, which is the point. Nothing here reimplements
 * retrieval: the lexical arm is the production `SearchIndex.recall`, the hybrid
 * arm is the production `SearchIndex.recallHybrid` — real BM25, real
 * `EmbeddingIndex` over the real Ollama provider, real `fuseRRF`, real
 * staleness pass. Same rule as #103. A number produced any other way would
 * describe a retriever we do not ship.
 *
 * ── survival on a corpus with no authored triggers ─────────────────────────
 * `persona-lift.ts` reports `survival = lift(far) / lift(near)`: the fraction
 * of a lever's benefit that holds when the recall-time query drifts off the
 * save-time wording. LongMemEval sessions carry no `recall_when` — nobody
 * wrote a trigger for a chat log — so the lever that metric ablates DOES NOT
 * EXIST on this corpus, and the recall_when survival number is not computable
 * here. Do not read the figure below as that one.
 *
 * The formula is kept, the lever is stated: control is the lexical arm,
 * treatment is the hybrid arm, so
 *
 *   survival(dense) = [R@k(hybrid,far) - R@k(bm25,far)]
 *                   / [R@k(hybrid,near) - R@k(bm25,near)]
 *
 * — how much of the dense arm's benefit survives when the question shares
 * little vocabulary with its gold session. That is the same question #103 asked
 * of the far slice, asked on data that is not ours. `far_retention`, reported
 * beside it, is the plain descriptive: R@k(far) / R@k(near) per arm.
 *
 * near/far is split at the MEDIAN coverage by default, not at persona-lift's
 * 0.30. That cut was calibrated against a handful of trigger phrases; against
 * whole session transcripts almost every question clears it, and a split with
 * one empty side reports nothing. A median split is fixed by construction
 * rather than chosen after looking at the recall numbers. `--near <number>`
 * takes a fixed cut instead.
 *
 * ── This run does NOT enter the private eval-run archive (#446) ────────────
 * `~/.bastra/eval-runs` holds the registered M0/M1 baselines that
 * `m1-tolerances.json` cites by path. Nothing here writes there, ever: the
 * only output path is the one `--out` names. `__tests__/longmemeval-dataset.test.ts`
 * pins that.
 *
 * ── Get the data ──────────────────────────────────────────────────────────
 *   packages/eval/scripts/fetch-longmemeval.sh        (MIT, ~265 MB)
 *
 * ── Run ───────────────────────────────────────────────────────────────────
 *   npm run longmemeval --workspace=@bastra-recall/eval -- \
 *     --corpus ~/.cache/longmemeval/longmemeval_s_cleaned.json \
 *     --arms bm25,hybrid --out /tmp/longmemeval.json
 *
 *   # loader smoke on the committed fixture, no Ollama needed:
 *   npm run longmemeval --workspace=@bastra-recall/eval -- --arms bm25 --limit 3 \
 *     --corpus fixtures/longmemeval-sample.json
 *
 * Exit code: 0 on a completed measurement, 2 on a usage/corpus error, 3 when
 * the embedding backfill stalls. A measurement, not a pass/fail gate — a bad
 * number exits 0.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OllamaEmbeddingProvider,
} from "@bastra-recall/core";
import {
  haystackMemories,
  isoDate,
  loadLongMemEval,
  longMemEvalDatasetHash,
  sessionText,
  type LongMemEvalQuestion,
  type SessionMemory,
  type TurnMode,
} from "./longmemeval-dataset.js";

// ── CLI ────────────────────────────────────────────────────────

const ARM_NAMES = ["bm25", "hybrid"] as const;
type ArmName = (typeof ARM_NAMES)[number];

interface Args {
  corpus: string;
  arms: ArmName[];
  turns: TurnMode;
  /** Retrieval depth handed to the production recall call. */
  k: number;
  /** Cut for the near/far split, or null for the median split. */
  near: number | null;
  limit: number;
  out: string | null;
}

const DEFAULT_CORPUS = path.resolve(import.meta.dirname, "../fixtures/longmemeval-sample.json");

function usage(): never {
  console.error(
    "longmemeval-run — LongMemEval as an external arm (#500)\n" +
      "\n" +
      "  --corpus <path>   LongMemEval JSON (default: the committed fixture)\n" +
      "  --arms  a,b       bm25 | hybrid (default: bm25,hybrid)\n" +
      "  --turns all|user  how a session flattens into one document (default: all)\n" +
      "  --k <n>           retrieval depth (default: 20)\n" +
      "  --near <x>        fixed near/far coverage cut (default: median split)\n" +
      "  --limit <n>       only the first n questions (0 = all)\n" +
      "  --out <path>      write the run JSON here (nothing is written otherwise)\n",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    corpus: DEFAULT_CORPUS,
    arms: ["bm25", "hybrid"],
    turns: "all",
    k: 20,
    near: null,
    limit: 0,
    out: null,
  };
  const req = (v: string | undefined, flag: string): string => {
    if (v === undefined) {
      console.error(`FATAL: ${flag} needs a value`);
      usage();
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--corpus") args.corpus = req(argv[++i], "--corpus");
    else if (a === "--out") args.out = req(argv[++i], "--out");
    else if (a === "--turns") {
      const t = req(argv[++i], "--turns");
      if (t !== "all" && t !== "user") {
        console.error(`FATAL: --turns is all or user, not \`${t}\``);
        usage();
      }
      args.turns = t;
    } else if (a === "--arms") {
      args.arms = req(argv[++i], "--arms").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
        if (!(ARM_NAMES as readonly string[]).includes(s)) {
          console.error(`FATAL: unknown arm \`${s}\` — known: ${ARM_NAMES.join(", ")}`);
          usage();
        }
        return s as ArmName;
      });
      if (args.arms.length === 0) usage();
    } else if (a === "--k") args.k = Number.parseInt(req(argv[++i], "--k"), 10);
    else if (a === "--limit") args.limit = Number.parseInt(req(argv[++i], "--limit"), 10);
    else if (a === "--near") args.near = Number.parseFloat(req(argv[++i], "--near"));
    else if (a === "-h" || a === "--help") usage();
    else {
      console.error(`FATAL: unknown flag \`${a}\``);
      usage();
    }
  }
  if (!Number.isFinite(args.k) || args.k < 1) {
    console.error("FATAL: --k must be a positive integer");
    usage();
  }
  return args;
}

// ── near/far coverage, the persona-lift definition ──────────────
// Same stop list and tokenizer as `persona-lift.ts`, so "far" means the same
// thing in both harnesses. Only the reference text differs: there it is the
// authored trigger, here it is the gold session itself.

const STOP = new Set(
  ("a an the to of in on at for and or but with without when how why is are be it its " +
    "into as my me i you your their them they not no than instead while per after before " +
    "does do that this so what which").split(" "),
);
function toks(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t && t.length > 1 && !STOP.has(t)),
  );
}
/** Fraction of the question's content tokens that occur in the reference text. */
function coverage(question: string, reference: Set<string>): number {
  const q = toks(question);
  if (q.size === 0) return 0;
  let hit = 0;
  for (const t of q) if (reference.has(t)) hit++;
  return hit / q.size;
}

// ── metrics ────────────────────────────────────────────────────

/** recall_any@k: did ANY gold session make the top k? The reference metric. */
function recallAny(ranked: string[], gold: ReadonlySet<string>, k: number): number {
  return ranked.slice(0, k).some((id) => gold.has(id)) ? 1 : 0;
}

function mrr(ranked: string[], gold: ReadonlySet<string>): number {
  const i = ranked.findIndex((id) => gold.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

function ndcg(ranked: string[], gold: ReadonlySet<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (gold.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  let ideal = 0;
  for (let i = 0; i < Math.min(k, gold.size); i++) ideal += 1 / Math.log2(i + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

const KS = [1, 3, 5, 10, 20] as const;

/** One scored question, per arm. */
interface QuestionResult {
  question_id: string;
  question_type: string;
  /** true when the question id ends in `_abs` — reported, never filtered. */
  abstention_id: boolean;
  coverage: number;
  /** arm -> the retrieved session ids, top `k`. */
  ranked: Record<ArmName, string[]>;
  gold: string[];
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const signed = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pp`;

function recallAt(rows: QuestionResult[], arm: ArmName, k: number): number {
  if (rows.length === 0) return 0;
  const gold = (r: QuestionResult): Set<string> => new Set(r.gold);
  return rows.reduce((s, r) => s + recallAny(r.ranked[arm], gold(r), k), 0) / rows.length;
}

// ── the vault one question's haystack becomes ──────────────────

const yaml = (s: string): string => JSON.stringify(s);

/**
 * Write one question's haystack as a vault of `reference` memories.
 *
 * `type: reference` never expires (`DEFAULT_EXPIRATION_DAYS`), so the staleness
 * pass returns `fresh` for every memory and its multiplier is 1.0 across the
 * board. That is deliberate: the corpus is from 2023, and letting our decay
 * policy demote the whole haystack uniformly would change no ranking while
 * making the run harder to reason about. `recall_when` stays empty for the
 * reason `rrf-k-beir.ts` states — a public corpus has no author-written
 * triggers, and inventing them would measure doc2query, not retrieval.
 */
async function writeQuestionVault(root: string, memories: SessionMemory[]): Promise<void> {
  const dir = path.join(root, "memories");
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    memories.map((m) => {
      const date = isoDate(m.date) ?? "2023-01-01";
      const md =
        `---\nid: ${m.id}\ntitle: ${yaml(m.title)}\ntype: reference\n` +
        `summary: ${yaml(m.summary)}\ntopic_path: [longmemeval]\ntags: [longmemeval]\n` +
        `scope: longmemeval\nrecall_when: []\ncreated: ${date}\nupdated: ${date}\n---\n\n${m.body}\n`;
      return fs.writeFile(path.join(dir, `${m.id}.md`), md);
    }),
  );
}

/**
 * Wait for the production backfill to vectorise every memory.
 *
 * `EmbeddingIndex.start()` kicks the backfill off without awaiting it — the
 * arms are only comparable once every session has a vector. The stall guard is
 * the one `rrf-k-beir.ts` carries and for the same reason: a down Ollama would
 * otherwise read as "slow" and waste an hour.
 */
async function awaitBackfill(emb: EmbeddingIndex, want: number, label: string): Promise<void> {
  let last = -1;
  let stalledSince = Date.now();
  while (emb.size() < want) {
    await new Promise((r) => setTimeout(r, 100));
    if (emb.size() !== last) {
      last = emb.size();
      stalledSince = Date.now();
    }
    if (Date.now() - stalledSince > 120_000) {
      console.error(
        `\nFATAL: ${label}: embedding stalled at ${emb.size()}/${want}. Is Ollama reachable at ` +
          `${process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434"}?`,
      );
      process.exit(3);
    }
  }
}

// ── the run ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corpus = path.resolve(args.corpus);

  let loaded: { questions: LongMemEvalQuestion[]; dropped: number };
  try {
    loaded = loadLongMemEval(corpus);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      console.error(
        `FATAL: no LongMemEval corpus at ${corpus}\n` +
          `\n` +
          `  This arm measures the PUBLIC corpus and will not substitute anything for it.\n` +
          `  Fetch it (MIT, ~265 MB):\n` +
          `\n` +
          `      packages/eval/scripts/fetch-longmemeval.sh\n` +
          `\n` +
          `  then point --corpus at the downloaded longmemeval_s_cleaned.json.\n`,
      );
      process.exit(2);
    }
    throw err;
  }

  const all = loaded.questions;
  const questions = args.limit > 0 ? all.slice(0, args.limit) : all;
  const datasetHash = longMemEvalDatasetHash(questions, args.turns);
  const codeHash = createHash("sha256")
    .update(readFileSync(new URL(import.meta.url), "utf8"))
    .update(readFileSync(new URL("./longmemeval-dataset.ts", import.meta.url), "utf8"))
    .digest("hex");

  console.error(
    `LongMemEval: ${questions.length}/${all.length} questions` +
      `${loaded.dropped ? ` (${loaded.dropped} abstention-typed dropped)` : ""}` +
      ` · arms ${args.arms.join("+")} · turns ${args.turns} · k=${args.k}`,
  );
  console.error(`dataset ${datasetHash.slice(0, 12)} · code ${codeHash.slice(0, 12)} · ${corpus}`);

  const wantHybrid = args.arms.includes("hybrid");
  const provider = wantHybrid
    ? new OllamaEmbeddingProvider({
        baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
        model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
        keepAlive: process.env.BASTRA_OLLAMA_KEEP_ALIVE ?? "10m",
      })
    : null;

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "longmemeval-"));
  const rows: QuestionResult[] = [];
  let duplicateSessions = 0;
  let sessionCount = 0;
  const started = Date.now();

  try {
    for (const [qi, q] of questions.entries()) {
      const { memories, duplicates } = haystackMemories(q, args.turns);
      duplicateSessions += duplicates;
      sessionCount += memories.length;

      const root = path.join(work, `q${qi}`);
      await writeQuestionVault(root, memories);
      const vault = new Vault(root);
      const { loaded: n, skipped } = await vault.init();
      if (skipped.length) {
        console.error(`\n${q.question_id}: ${skipped.length} memories failed to parse — ${skipped[0].err}`);
      }
      const search = new SearchIndex(vault);
      search.start();

      let emb: EmbeddingIndex | null = null;
      if (provider) {
        emb = new EmbeddingIndex(vault, provider, path.join(root, ".bastra", "embeddings.json"));
        await emb.start();
        await awaitBackfill(emb, n, q.question_id);
        search.useEmbeddings(emb);
      }

      const ranked = {} as Record<ArmName, string[]>;
      for (const arm of args.arms) {
        // The production call, unmodified. `allow_private` stays at its default
        // false, which is what an external MCP caller gets — the corpus carries
        // no `private` memory, so the filter removes nothing and the vector arm
        // simply asks for the deeper pool (#240/A8).
        const hits = arm === "hybrid"
          ? await search.recallHybrid(q.question, { k: args.k })
          : search.recall(q.question, { k: args.k });
        ranked[arm] = hits.map((h) => h.id);
      }

      // Coverage against the gold session the question is CLOSEST to: a
      // question is "near" if any of its golds shares its vocabulary — asking
      // the minimum over several golds would call a question far because a
      // second, differently worded gold exists.
      const goldIds = new Set(q.answer_session_ids);
      const goldTexts = q.haystack_sessions
        .filter((_, i) => goldIds.has(q.haystack_session_ids[i]))
        .map((s) => sessionText(s, args.turns));
      const cov = goldTexts.reduce((best, t) => Math.max(best, coverage(q.question, toks(t))), 0);

      rows.push({
        question_id: q.question_id,
        question_type: q.question_type,
        abstention_id: q.question_id.endsWith("_abs"),
        coverage: cov,
        ranked,
        gold: [...goldIds].map((id) => memories.find((m) => m.session_id === id)?.id ?? id),
      });

      if (emb) {
        await emb.stop();
        search.useEmbeddings(undefined);
      }
      search.stop();
      await vault.stop();
      // 500 haystacks are ~24k files and several GB of markdown; keeping them
      // all would fill the temp volume long before the run ends.
      await fs.rm(root, { recursive: true, force: true });

      if ((qi + 1) % 10 === 0 || qi + 1 === questions.length) {
        const arm = args.arms.includes("hybrid") ? "hybrid" : "bm25";
        const elapsed = (Date.now() - started) / 1000;
        process.stderr.write(
          `\r${qi + 1}/${questions.length} · running ${arm} R@5 ${pct(recallAt(rows, arm, 5))}` +
            ` · ${elapsed.toFixed(0)}s`,
        );
      }
    }
    process.stderr.write("\n");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }

  // ── report ──────────────────────────────────────────────────
  const covs = rows.map((r) => r.coverage).sort((a, b) => a - b);
  const median = covs.length ? covs[Math.floor(covs.length / 2)] : 0;
  const cut = args.near ?? median;
  const near = rows.filter((r) => r.coverage >= cut);
  const far = rows.filter((r) => r.coverage < cut);

  const L: string[] = [];
  L.push(`\n── LongMemEval · ${questions.length} questions · ${sessionCount} sessions indexed ──`);
  L.push(`   corpus ${path.basename(corpus)} · dataset ${datasetHash.slice(0, 12)} · turns ${args.turns}`);
  if (duplicateSessions) L.push(`   ${duplicateSessions} repeated session id(s) collapsed (identical content, never gold)`);
  L.push("");
  L.push(`   ${"arm".padEnd(8)} | ${KS.map((k) => `R@${k}`.padStart(6)).join(" | ")} | nDCG@10 |    MRR`);
  L.push("   " + "-".repeat(8 + 3 + KS.length * 9 + 20));
  const summary: Record<string, Record<string, number>> = {};
  for (const arm of args.arms) {
    const gold = (r: QuestionResult): Set<string> => new Set(r.gold);
    const nd = rows.reduce((s, r) => s + ndcg(r.ranked[arm], gold(r), 10), 0) / (rows.length || 1);
    const mr = rows.reduce((s, r) => s + mrr(r.ranked[arm], gold(r)), 0) / (rows.length || 1);
    const at: Record<string, number> = {};
    for (const k of KS) at[`r@${k}`] = recallAt(rows, arm, k);
    at["ndcg@10"] = nd;
    at.mrr = mr;
    summary[arm] = at;
    L.push(
      `   ${arm.padEnd(8)} | ${KS.map((k) => pct(at[`r@${k}`]).padStart(6)).join(" | ")}` +
        ` |  ${nd.toFixed(4)} | ${mr.toFixed(4)}`,
    );
  }

  // near/far, and the dense arm's survival across the drift
  L.push("");
  L.push(
    `   near/far cut ${cut.toFixed(3)}` +
      `${args.near === null ? " (median split)" : " (fixed)"}` +
      ` · near n=${near.length} · far n=${far.length}`,
  );
  L.push(`   ${"arm".padEnd(8)} | near R@5 |  far R@5 | far_retention`);
  L.push("   " + "-".repeat(50));
  const farRetention: Record<string, number> = {};
  for (const arm of args.arms) {
    const rn = recallAt(near, arm, 5);
    const rf = recallAt(far, arm, 5);
    farRetention[arm] = rn > 0 ? rf / rn : Number.NaN;
    L.push(
      `   ${arm.padEnd(8)} | ${pct(rn).padStart(8)} | ${pct(rf).padStart(8)} |` +
        `          ${Number.isFinite(farRetention[arm]) ? farRetention[arm].toFixed(2) : "n/a"}`,
    );
  }

  let survival: number | null = null;
  if (args.arms.includes("bm25") && args.arms.includes("hybrid")) {
    const liftNear = recallAt(near, "hybrid", 5) - recallAt(near, "bm25", 5);
    const liftFar = recallAt(far, "hybrid", 5) - recallAt(far, "bm25", 5);
    survival = liftNear > 0 ? liftFar / liftNear : Number.NaN;
    L.push("");
    L.push(`   dense lift: near ${signed(liftNear)} · far ${signed(liftFar)}`);
    L.push(
      `   **survival(dense) = lift(far)/lift(near) = ` +
        `${Number.isFinite(survival) ? survival.toFixed(2) : "n/a"}** — NOT the recall_when` +
        ` survival of #103; this corpus has no authored triggers to ablate.`,
    );
  }

  // by question type, because the reference runs publish that breakdown too
  const types = [...new Set(rows.map((r) => r.question_type))].sort();
  L.push("");
  L.push(`   ${"question type".padEnd(26)} |   n | ${args.arms.map((a) => `${a} R@5`.padStart(11)).join(" |")}`);
  L.push("   " + "-".repeat(30 + 6 + args.arms.length * 14));
  const byType: Record<string, Record<string, number>> = {};
  for (const t of types) {
    const sub = rows.filter((r) => r.question_type === t);
    byType[t] = { n: sub.length };
    for (const arm of args.arms) byType[t][arm] = recallAt(sub, arm, 5);
    L.push(
      `   ${t.padEnd(26)} | ${String(sub.length).padStart(3)} | ` +
        args.arms.map((a) => pct(byType[t][a]).padStart(11)).join(" | "),
    );
  }

  const absRows = rows.filter((r) => r.abstention_id);
  if (absRows.length) {
    L.push("");
    L.push(
      `   ${absRows.length} question ids end in \`_abs\` and are KEPT (neither reference run drops them):` +
        ` ${args.arms.map((a) => `${a} R@5 ${pct(recallAt(absRows, a, 5))}`).join(" · ")}`,
    );
  }

  console.log(L.join("\n"));

  if (args.out) {
    // The ONLY file this run writes. `~/.bastra/eval-runs` is the private
    // archive the M1 tolerances cite by path (#446) and is never touched.
    await fs.writeFile(
      path.resolve(args.out),
      JSON.stringify(
        {
          harness: "longmemeval-run",
          issue: 500,
          corpus: path.basename(corpus),
          dataset_hash: datasetHash,
          code_hash: codeHash,
          turns: args.turns,
          k: args.k,
          n_questions: questions.length,
          n_sessions: sessionCount,
          embedding_model: provider ? (process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma") : null,
          near_far: { cut, mode: args.near === null ? "median" : "fixed", near: near.length, far: far.length },
          summary,
          far_retention: farRetention,
          survival_dense: survival !== null && Number.isFinite(survival) ? survival : null,
          by_type: byType,
          questions: rows,
        },
        null,
        2,
      ),
    );
    console.error(`wrote ${args.out}`);
  }
}

void main();
