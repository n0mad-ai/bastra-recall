import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const ARC = path.join(process.env.HOME, ".bastra", "rerank-501-runs", "2026-09-09");
const sha = (f) => execFileSync("shasum", ["-a", "256", path.join(ARC, f)], { encoding: "utf8" }).split(" ")[0];
const rd = (f) => JSON.parse(fs.readFileSync(path.join(ARC, f), "utf8"));
const g = rd("rerank-501-gold-v2.json"), g1 = rd("rerank-501-gold.json"), l = rd("rerank-501-lme.json"), c = rd("pool-coverage-kind.json");
const arm = (r) => ({
  model: r.model, passage: r.passage, n: r.n, ...(r.primary ? { primary: true } : {}),
  r3_baseline: r.at["r@3"].baseline, r3_reranked: r.at["r@3"].reranked,
  r3_delta: r.at["r@3"].paired.delta, r3_ci95: r.at["r@3"].paired.ci95, r3_p: r.at["r@3"].paired.p,
  r5_delta: r.at["r@5"].paired.delta, recall_any_at_n: r.recall_any_at_n, rank_regression_share: r.rank_regression_share,
});
const P = g.reports.find((r) => r.primary);
let best = null;
for (const r of g.reports) { const d = r.at["r@3"].paired; if (!best || d.delta > best.d.delta) best = { r, d }; }
let cells = 0, total = 0, up = 0;
for (const r of g.reports) for (const k of ["r@1", "r@3", "r@5"]) {
  total++; const a = r.at[k].reranked, b = r.at_no_floor_upper_bound[k].reranked;
  if (a !== b) { cells++; if (a > b) up++; }
}
const slice = (v) => (v.at ? { n: v.n, delta: v.at["r@3"].delta, ci95: v.at["r@3"].ci95 } : { n: v.n, not_evaluable: v.not_evaluable });
const out = {
  $comment: "Committed excerpt of the #501 rerank measurement, so its numbers can be checked without the raw artifacts. `rerank-decision.json` carries the DECISION; this file carries the EVIDENCE it rests on, with a sha256 per file. `__tests__/rerank-results.test.ts` keeps the two in step. Generated from the artifacts by tools/gen-rerank-results.mjs, never typed by hand.",
  schema_version: 1,
  issue: 501,
  archive: {
    directory: "~/.bastra/rerank-501-runs/2026-09-09",
    $comment_not_eval_runs: "Deliberately NOT ~/.bastra/eval-runs (#446), which holds the registered M0/M1 baselines cited by path from m1-tolerances.json. A sibling directory keeps these artifacts durable without mixing a decision measurement into the internal baselines. No code under packages/eval/src resolves a home-directory path: the harness writes only to its --out, and the copy was made by hand.",
    $comment_rerun_is_not_a_substitute: "A re-run cannot replace these files. The gold pass measured a LIVE vault, and two runs over the same set already differed by one case at depth 30 because two memories were written between them (1171 to 1173 vectors). A determinism check over this set can prove same vault, same result; never same number tomorrow.",
  },
  runs: [
    {
      id: "gold-final", file: "rerank-501-gold-v2.json", file_sha256: sha("rerank-501-gold-v2.json"),
      role: "DECIDES the recommendation",
      cases: g.cases, production_k: g.production_k, score_floor: g.score_floor,
      primary_endpoint: g.primary_endpoint, interval_count: g.interval_count,
      pool_split: g.pool_split, dense_arm_health: g.dense_arm_health, batch_invariance: g.batch_invariance,
      vault_fingerprint: null,
      $comment_vault_fingerprint: "NOT recorded: this run predates d383f22, which introduced the fingerprint. The vault held 1173 vectors when a determinism probe ran shortly afterwards, and 1171 during the first run, but the exact identity of the vault THIS run saw cannot be reconstructed. That gap is itself the reason a re-run is not a substitute, and the reason the field exists from d383f22 onward.",
      primary_result: {
        delta: P.at["r@3"].paired.delta, ci95: P.at["r@3"].paired.ci95, p: P.at["r@3"].paired.p,
        better: P.at["r@3"].paired.better, worse: P.at["r@3"].paired.worse, unchanged: P.at["r@3"].paired.unchanged,
        baseline: P.at["r@3"].baseline, n: P.at["r@3"].paired.n,
      },
      best_exploratory: {
        arm: `${best.r.model}/${best.r.passage}`, n: best.r.n, delta: best.d.delta, ci95: best.d.ci95,
        clears_point_threshold: best.d.delta >= 0.02, ci_lower_above_zero: best.d.ci95[0] > 0,
        $comment: "It clears the 2.0 pp point threshold and fails only on the interval. The registered bar requires both.",
      },
      robustness: {
        in_pool_only: slice(P.in_pool_only),
        by_kind: Object.fromEntries(Object.entries(P.by_kind).map(([k, v]) => [k, slice(v)])),
        by_lang: Object.fromEntries(Object.entries(P.by_lang).map(([k, v]) => [k, slice(v)])),
        weak_result: { n: P.weak_result.n, not_evaluable: P.weak_result.not_evaluable },
      },
      floor_effect: {
        cells_differing: cells, cells_total: total, differing_that_raise_hit_rate: up,
        by_n: Object.fromEntries([10, 20, 30].map((n) => [String(n), g.reports.filter((r) => r.n === n).reduce((acc, r) => acc + ["r@1", "r@3", "r@5"].filter((k) => r.at[k].reranked !== r.at_no_floor_upper_bound[k].reranked).length, 0)])),
      },
      arms: g.reports.map(arm),
    },
    {
      id: "gold-preliminary", file: "rerank-501-gold.json", file_sha256: sha("rerank-501-gold.json"),
      role: "DISCARDED, kept because an earlier draft of the report quoted its table",
      $comment: "It scored bge with a single deep pass although bge is not batch-invariant, so its N=10/20 rows describe a procedure nobody would ship. The primary row is bit-identical to the final run; recall_any@30 differs by one case because the vault changed between the two.",
      interval_count: g1.interval_count,
      primary_result: { delta: g1.reports.find((r) => r.primary).at["r@3"].paired.delta },
    },
    {
      id: "longmemeval-control", file: "rerank-501-lme.json", file_sha256: sha("rerank-501-lme.json"),
      role: l.role, questions: l.questions, k: l.k, score_floor: l.score_floor,
      protocol_baseline_recall_any: l.protocol_baseline_recall_any,
      $comment_protocol_baseline: "recall_any@20 over the raw ranked list, which is the protocol #500 used; checkable against its published 0.996. The deltas below use served-k plus floor, so they stay comparable to the gold pass.",
      pool_split: l.pool_split, batch_invariance: l.batch_invariance, interval_count: l.interval_count,
      all_rows_ci_below_zero: l.reports.every((r) => r.at["r@3"].paired.ci95[1] < 0),
      arms: l.reports.map(arm),
    },
    {
      id: "pool-coverage", file: "pool-coverage-kind.json", file_sha256: sha("pool-coverage-kind.json"),
      role: "The ceiling on anything a reranker can do. Retrieval only, no model involved.",
      total: c.total,
      per_file: c.per_file.map((f) => ({ file: f.file, cases: f.cases, in_pool_at_40: f.in_pool_at["@40"], absent_from_pool: f.absent_from_pool })),
    },
    {
      id: "pool-coverage-first", file: "pool-coverage.json", file_sha256: sha("pool-coverage.json"),
      role: "The same measurement before the cue-axis split existed; superseded by pool-coverage-kind.json.",
    },
  ],
};
fs.writeFileSync("packages/eval/registrations/rerank-results.json", JSON.stringify(out, null, 2) + "\n");
console.log(`written: ${out.runs.length} runs, floor ${cells}/${total} differing, ${up} of them raising`);
