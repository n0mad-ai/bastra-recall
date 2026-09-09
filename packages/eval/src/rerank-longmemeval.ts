#!/usr/bin/env tsx
/**
 * #501's control pass: the same rerank question, asked of a corpus that is not
 * ours.
 *
 * The gold set carries the recommendation; this does not. Its job is narrower
 * and stated in `registrations/rerank-decision.json`: an externally comparable
 * figure, plus the probe of whether the bilingual arm costs quality on English.
 * #500 exists because every recall number we owned was self-referential, and a
 * rerank decision resting only on our own vault would have the same defect.
 *
 * ── Why the two sets can disagree without contradicting ────────────────────
 * They are differently shaped, and #500 measured how. On LongMemEval the
 * hybrid arm already reaches R@20 = 99.6 % — nearly everything is in the top 20
 * before anyone reranks. On our gold set the ceiling is 84.8 % R@3 on the
 * descriptive axis and the pool misses the gold entirely in 29.5 % of cases.
 * A reranker that moves one and not the other is a statement about the two
 * corpora, not about the reranker. If that happens, it is reported as such and
 * the decision stays with the gold set — picking whichever set looks better
 * afterwards is the exact failure the pre-registration exists to prevent.
 *
 * ── Nothing is reimplemented, twice over ───────────────────────────────────
 * The per-question vault, the embedding backfill wait and the corpus loader
 * come from `longmemeval-run.ts` (#500) by import, so this pass measures the
 * same haystack that produced the published figures. The retrieval is
 * production `recallHybrid`, the rerank window is `onCandidatePool`, and the
 * scoring, slicing and resampling are the same `rerank-*` modules the gold pass
 * uses. Two numbers computed by two code paths would not be comparable.
 *
 * ── Two baselines on purpose ───────────────────────────────────────────────
 * `recall_any@k` over the raw ranked list reproduces #500's protocol, so the
 * baseline here can be checked against the figure that was published. The
 * DELTA is measured the way the gold pass measures it — served k, then the
 * score floor — because the two deltas have to be comparable to each other.
 * Both travel in the artifact; neither is silently substituted for the other.
 *
 *   BASTRA_VAULT_PATH is NOT used. The corpus is the vault here.
 *   npx tsx src/rerank-longmemeval.ts \
 *     --corpus ~/.cache/longmemeval/longmemeval_s_cleaned.json \
 *     --models en-de --out /tmp/rerank-lme.json
 */
import { promises as fs } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EmbeddingIndex, OllamaEmbeddingProvider, SearchIndex, Vault, isWeakResult } from "@bastra-recall/core";
import type { RecallHit } from "@bastra-recall/core";
import { haystackMemories, loadLongMemEval, type TurnMode } from "./longmemeval-dataset.js";
import { awaitBackfill, writeQuestionVault } from "./longmemeval-run.js";
import { SCORE_FLOOR } from "./goldset-run.js";
import { MODELS, loadCrossEncoder, type PassageMode } from "./rerank-model.js";
import { NS, PRIMARY, rankArm, checkBatchInvariance } from "./rerank-replay.js";
import { recallAny } from "./rerank-metrics.js";
import { assignPoolBuckets, countIntervals, reportArm, served, type ArmReport, type CaseRow } from "./rerank-report.js";

/** #500's default, and the k its published figures were produced at. */
const LME_K = 20;
const PASSAGE_MODES: readonly PassageMode[] = ["short", "body"];

interface Args {
  corpus: string;
  models: string[];
  turns: TurnMode;
  limit: number;
  out: string | null;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    corpus: path.join(os.homedir(), ".cache", "longmemeval", "longmemeval_s_cleaned.json"),
    models: ["en-de"],
    turns: "all",
    limit: 0,
    out: null,
    seed: 20260909,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--corpus") a.corpus = argv[++i];
    else if (f === "--models") a.models = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (f === "--turns") a.turns = argv[++i] as TurnMode;
    else if (f === "--limit") a.limit = Number(argv[++i]);
    else if (f === "--out") a.out = argv[++i];
    else if (f === "--seed") a.seed = Number(argv[++i]);
    else throw new Error(`unknown flag: ${f}`);
  }
  for (const m of a.models) if (!MODELS[m]) throw new Error(`unknown model ${JSON.stringify(m)}`);
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadLongMemEval(path.resolve(args.corpus));
  const questions = args.limit > 0 ? loaded.questions.slice(0, args.limit) : loaded.questions;
  console.error(`[rerank-lme] ${questions.length} questions · k=${LME_K} · models ${args.models.join(",")}`);

  const provider = new OllamaEmbeddingProvider({
    baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
    keepAlive: process.env.BASTRA_OLLAMA_KEEP_ALIVE ?? "10m",
  });

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rerank-lme-"));
  const rows: CaseRow[] = [];
  // Passages come from the per-question vault, which is discarded once the next
  // question is built — so they are captured here rather than looked up later.
  const passages = new Map<string, Map<string, { title: string; summary: string; body: string }>>();
  /** #500's protocol figure: recall_any@k over the raw ranked list, no floor. */
  const lmeBaseline: number[] = [];

  try {
    for (const [qi, q] of questions.entries()) {
      const { memories } = haystackMemories(q, args.turns);
      const root = path.join(work, `q${qi}`);
      await writeQuestionVault(root, memories);
      const vault = new Vault(root);
      const { loaded: n } = await vault.init();
      const search = new SearchIndex(vault);
      search.start();
      const emb = new EmbeddingIndex(vault, provider, path.join(root, ".bastra", "embeddings.json"));
      await emb.start();
      await awaitBackfill(emb, n, q.question_id);
      search.useEmbeddings(emb);

      let pool: RecallHit[] = [];
      const hits = await search.recallHybrid(q.question, {
        k: LME_K,
        onCandidatePool: (p) => {
          pool = p;
        },
      });
      const goldSessionIds = new Set(q.answer_session_ids);
      const gold = new Set(
        memories.filter((m) => goldSessionIds.has(m.session_id)).map((m) => m.id),
      );
      lmeBaseline.push(recallAny(hits.map((h) => h.id), gold, LME_K));

      const texts = new Map<string, { title: string; summary: string; body: string }>();
      for (const h of pool.slice(0, Math.max(...NS))) {
        const m = vault.get(h.id);
        if (m) texts.set(h.id, { title: m.fm.title, summary: m.fm.summary, body: m.body });
      }
      passages.set(q.question_id, texts);
      rows.push({
        id: q.question_id,
        query: q.question,
        // The corpus is English throughout; the cue axis does not exist here.
        lang: "en",
        kind: "descriptive",
        expected: gold,
        expectedAny: gold,
        baseline: pool,
        poolSize: pool.length,
        weakResult: isWeakResult(hits, true),
      });

      emb.stop();
      search.stop();
      await vault.stop();
      // The per-question vault is NOT removed here. `emb.stop()` does not wait
      // for the store write to land, so removing the directory raced it
      // (ENOTEMPTY on .bastra). #500's runner keeps every question directory
      // and drops the whole work root at the end; doing the same removes the
      // race instead of retrying around it.
      if ((qi + 1) % 10 === 0) process.stderr.write(`\r[rerank-lme] retrieved ${qi + 1}/${questions.length}`);
    }
    process.stderr.write(`\r[rerank-lme] retrieved ${questions.length}/${questions.length}\n`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }

  const poolSplit = assignPoolBuckets(rows, Math.max(LME_K * 4, 20));
  const memoryOf = (caseId: string) => (id: string) => {
    const t = passages.get(caseId)?.get(id);
    return t ? ({ fm: { title: t.title, summary: t.summary }, body: t.body } as never) : undefined;
  };

  const reports: ArmReport[] = [];
  const invariance: Record<string, Awaited<ReturnType<typeof checkBatchInvariance>>> = {};
  for (const modelKey of args.models) {
    const scorer = await loadCrossEncoder(modelKey);
    console.error(`[rerank-lme] ${scorer.id} loaded in ${scorer.loadMs} ms`);
    for (const mode of PASSAGE_MODES) {
      if (rows.length > 0) {
        invariance[`${modelKey}/${mode}`] = await checkBatchInvariance(scorer, mode, rows[0], memoryOf(rows[0].id));
      }
    }
    const stable = PASSAGE_MODES.every((m) => invariance[`${modelKey}/${m}`]?.orderStable !== false);
    for (const mode of PASSAGE_MODES) {
      const label = `${modelKey}/${mode}`;
      const merged = new Map<string, Record<number, RecallHit[]>>();
      for (const nSet of stable ? [[...NS]] : NS.map((n) => [n])) {
        // One call per question, because the passages live in that question's
        // own vault: session ids are unique inside a haystack but not across
        // haystacks, so one shared id->text map could collide silently.
        for (const [ri, row] of rows.entries()) {
          const part = await rankArm(scorer, mode, [row], memoryOf(row.id), "", nSet);
          merged.set(row.id, { ...(merged.get(row.id) ?? {}), ...part.get(row.id)! });
          if ((ri + 1) % 50 === 0) process.stderr.write(`\r[${label} N=${nSet.join(",")}] ${ri + 1}/${rows.length}`);
        }
        process.stderr.write(`\r[${label} N=${nSet.join(",")}] ${rows.length}/${rows.length}\n`);
      }
      for (const n of NS) {
        reports.push(
          reportArm({
            model: modelKey,
            passage: mode,
            n,
            primary: modelKey === PRIMARY.model && mode === PRIMARY.passage && n === PRIMARY.n,
            rows,
            rankings: merged,
            floor: SCORE_FLOOR,
            serveK: LME_K,
            seed: args.seed,
            poolSplit,
          }),
        );
      }
    }
    scorer.close();
  }

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const pp = (x: number): string => `${x * 100 >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
  const L: string[] = ["", `  #501 CONTROL — LongMemEval, ${rows.length} questions. Carries NO recommendation.`, ""];
  L.push(
    `  #500 protocol baseline, recall_any@${LME_K} over the raw ranked list: ` +
      `${pct(lmeBaseline.reduce((a, b) => a + b, 0) / Math.max(1, lmeBaseline.length))}`,
  );
  L.push("  (checkable against the figure #500 published; the deltas below use served-k + floor, as the gold pass does)");
  L.push("");
  L.push(`  ${"model/passage".padEnd(16)} | ${"N".padStart(3)} | ${"R@3".padStart(7)} | ${"ΔR@3".padStart(6)} | ${"95% CI".padStart(15)} | ${"ΔR@5".padStart(6)} | any@N`);
  for (const r of reports) {
    const c = r.at["r@3"].paired;
    L.push(
      `  ${`${r.model}/${r.passage}`.padEnd(16)}${r.primary ? "*" : " "}| ${String(r.n).padStart(3)} | ` +
        `${pct(r.at["r@3"].reranked).padStart(7)} | ${pp(c.delta).padStart(6)} | ` +
        `${`[${pp(c.ci95[0])}, ${pp(c.ci95[1])}]`.padStart(15)} | ${pp(r.at["r@5"].paired.delta).padStart(6)} | ${pct(r.recall_any_at_n)}`,
    );
  }
  L.push("");
  for (const [k, v] of Object.entries(invariance)) {
    L.push(`  batch invariance ${k}: max |Δlogit| ${v.maxAbsDelta.toExponential(2)}, order stable: ${v.orderStable}`);
  }
  L.push("");
  console.log(L.join("\n"));

  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true });
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          issue: 501,
          role: "CONTROL FIGURE — carries no recommendation; the gold set decides",
          questions: rows.length,
          k: LME_K,
          score_floor: SCORE_FLOOR,
          protocol_baseline_recall_any: lmeBaseline.reduce((a, b) => a + b, 0) / Math.max(1, lmeBaseline.length),
          pool_split: poolSplit,
          interval_count: countIntervals(reports),
          reports,
          batch_invariance: invariance,
          cases_baseline: rows.map((r) => ({
            id: r.id,
            pool_size: r.poolSize,
            weak_result: r.weakResult,
            rank_in_pool: r.baseline.findIndex((h) => r.expected.has(h.id)) + 1,
            served_rank: served(r.baseline, LME_K, SCORE_FLOOR).findIndex((id) => r.expected.has(id)) + 1,
          })),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.error(`[rerank-lme] wrote ${args.out}`);
  }
}

if (import.meta.filename === process.argv[1]) {
  main().catch((e: Error) => {
    console.error(`[rerank-lme] FATAL: ${e.message}`);
    process.exit(1);
  });
}
