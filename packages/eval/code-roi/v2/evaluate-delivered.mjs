/**
 * Score the delivered-block run against its registration (#606).
 *
 * A SEPARATE SCORER, deliberately. `evaluate.mjs` reproduces the v3 report and
 * `evaluate-v4.mjs` the v6 one; both read the change-impact registration and
 * must keep reading it. This one reads `code-awareness-delivered.json` and
 * answers a different question with a different arm set, so it is a third file
 * rather than a fourth branch inside the second.
 *
 * WHAT IS GATED, and what each check is guarding against:
 *
 *   context   median input tokens of D against A over the scenarios BOTH arms
 *             solved, with a bootstrap interval. A block that is cheaper on
 *             average but not repeatably cheaper is noise, and the upper bound
 *             is what says which it was.
 *   use       the share of the block's own listed files that the final answer
 *             names, averaged over the scenarios that GOT a block. This is what
 *             stops the run passing on a cost saving while the block is
 *             uniformly ignored — a cheaper agent that ignored the block is a
 *             cheaper agent, not a working feature.
 *
 * and two guards that belong to BOTH verdicts, because a cost saving bought
 * with correctness is the failure this design is shaped around:
 *
 *   precision D must not lose more than the registered floor against A
 *   recall    D must not lose recall at all — the lower bound of a bootstrap
 *             interval on the paired difference has to stay at or above 0
 *
 * BLIND SPOTS ARE SPLIT OUT AND NEVER GATED. 13 of the 45 scenarios carry at
 * least one truth file whose breakage ran over something no import graph holds
 * — a route, an event name, a template string. Pooling them into one recall
 * makes the graph look worse on a class of edge it never claimed; pooling them
 * out makes the sample easier than the repository is. So the headline recall is
 * the pooled one and the split is reported beside it.
 *
 * Usage: CODE_ROI_OUT=<dir> node evaluate-delivered.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { score } from "./evaluate.mjs";
import { rng } from "./select.mjs";
import { writableOut } from "./archive.mjs";
import { parseArm } from "./evaluate-v4.mjs";
import { treeDirOf } from "./run-arms-v3.mjs";
import { armMetaRows, mixedBuildsReport } from "./evaluate-v4.mjs";
import { armIdsOf, resolveRegistration } from "./registration.mjs";
import { pinSignature, readBuildPin } from "./build-pin.mjs";

const OUT = writableOut();
const RUNS = join(OUT, "runs");
const SOLVED = 0.8;
const RESAMPLES = 10_000;

export const CONTROL_ARM = "A";
export const DELIVERED_ARM = "D";

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs) => {
  if (xs.length === 0) return NaN;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * A bootstrap interval for ANY statistic of a set of rows, resampling whole
 * clusters with replacement.
 *
 * The cluster key is `repo + file`, as registered: a pooled sample can hold the
 * same path in two repositories and clustering on the path alone would treat
 * them as one unit. The statistic is passed in rather than fixed, because the
 * two intervals this scorer needs are of different shapes — a mean of paired
 * differences and a RATIO OF MEDIANS, which is not a mean of anything and
 * cannot be bootstrapped by resampling per-scenario values.
 */
export function bootstrapStat(rows, stat, seed, resamples = RESAMPLES) {
  const clusters = new Map();
  for (const r of rows) {
    const key = `${r.repo ?? ""}|${r.file}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(r);
  }
  const groups = [...clusters.values()];
  if (groups.length === 0) return null;
  const next = rng(seed);
  const values = [];
  for (let i = 0; i < resamples; i++) {
    const sample = [];
    for (let j = 0; j < groups.length; j++) sample.push(...groups[Math.floor(next() * groups.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return {
    lo: values[Math.floor(0.025 * values.length)],
    hi: values[Math.max(0, Math.floor(0.975 * values.length) - 1)],
    clusters: groups.length,
    resamplesUsed: values.length,
  };
}

/**
 * How much of the delivered block the answer used.
 *
 * |block files ∩ files the answer names| / |block files|, per scenario. The
 * denominator is what the block PRINTED, not every candidate it found: a file
 * the cap kept off the page cannot have been used, and counting it would
 * measure the cap.
 *
 * `null` where no block was delivered — the product is silent on a file it does
 * not index or a change nothing depends on, and a silence scored as 0 would
 * read as "the block was ignored".
 */
export function blockUse(listed, named) {
  if (!Array.isArray(listed) || listed.length === 0) return null;
  const answer = new Set(named);
  return listed.filter((f) => answer.has(f)).length / listed.length;
}

/**
 * Is this a blind-spot scenario, and is it wholly one?
 *
 * THE SPLIT IS PER SCENARIO, not per truth file, and the reason is what the
 * miner records. `blindSpotTests` lists broken TEST files whose break ran over
 * something no import graph holds — the changed file is not in the test's
 * static import closure. A test file is never a truth file, so intersecting the
 * two lists would always be empty; what a blind-spot test contributes is the
 * truth files IT attributed, and the miner does not store the attribution per
 * test.
 *
 * On the frozen population that costs nothing: in all 13 blind-spot scenarios
 * EVERY broken test is a blind spot, so the whole truth set is blind-spot
 * truth and a per-scenario split is exact. `partial` says when that stops being
 * true — a scenario with some blind and some reachable tests has a truth set
 * this cannot divide, and the report names it instead of splitting it wrongly.
 */
export function blindSpotOf(scenario) {
  const blind = new Set(scenario.blindSpotTests ?? []);
  const broken = scenario.brokenTests ?? [];
  const hit = broken.filter((t) => blind.has(t));
  return {
    isBlindSpot: blind.size > 0,
    partial: hit.length > 0 && hit.length < broken.length,
    blindTests: blind.size,
  };
}

/** The two verdicts and the two guards that belong to both. */
export function judge(rows, registration) {
  const t = registration.thresholds;
  const minScenarios = registration.sample.min_scenarios;
  const seed = registration.statistics.seed;
  const n = rows.length;

  const dRecall = rows.map((r) => r[DELIVERED_ARM].recall - r[CONTROL_ARM].recall);
  const dPrecision = rows.map((r) => r[DELIVERED_ARM].precision - r[CONTROL_ARM].precision);
  const recallCi = bootstrapStat(
    rows,
    (sample) => mean(sample.map((r) => r[DELIVERED_ARM].recall - r[CONTROL_ARM].recall)),
    seed,
  );

  const bothSolved = rows.filter(
    (r) => r[CONTROL_ARM].recall >= SOLVED && r[DELIVERED_ARM].recall >= SOLVED,
  );
  const ratioOf = (sample) =>
    median(sample.map((r) => r[DELIVERED_ARM].inputTokens)) /
    median(sample.map((r) => r[CONTROL_ARM].inputTokens));
  const contextRatio = ratioOf(bothSolved);
  const contextCi = bothSolved.length === 0 ? null : bootstrapStat(bothSolved, ratioOf, seed);

  const uses = rows.map((r) => r.blockUse).filter((u) => u !== null);
  const useMean = mean(uses);

  const precision = {
    value: mean(dPrecision),
    required: `>= -${t.precision_loss_max} (mean precision D − A)`,
    pass: mean(dPrecision) >= -t.precision_loss_max,
  };
  const recall = {
    value: recallCi?.lo,
    mean: mean(dRecall),
    required: `>= ${t.recall_guard_ci_lower} (lower bound of the 95 % bootstrap CI on recall D − A)`,
    pass: (recallCi?.lo ?? -1) >= t.recall_guard_ci_lower,
  };

  const contextChecks = {
    context_ratio: {
      value: contextRatio,
      required: `<= ${t.context_cost_max_ratio} (median input tokens, ${bothSolved.length} solved in both)`,
      pass: bothSolved.length > 0 && contextRatio <= t.context_cost_max_ratio,
    },
    context_ci_upper: {
      value: contextCi?.hi,
      required: `< ${t.context_ci_upper_max}`,
      pass: (contextCi?.hi ?? Infinity) < t.context_ci_upper_max,
    },
    precision,
    recall,
  };
  const useChecks = {
    block_use: {
      value: useMean,
      required: `>= ${t.block_use_min} (mean over the ${uses.length} scenarios that got a block)`,
      pass: uses.length > 0 && useMean >= t.block_use_min,
    },
    precision,
    recall,
  };

  const verdictFor = (checks, count) => {
    if (count === 0) return "not_evaluable";
    if (count < minScenarios) return "underpowered";
    return Object.values(checks).every((c) => c.pass) ? "pass" : "fail";
  };

  return {
    n,
    context: { status: verdictFor(contextChecks, n), checks: contextChecks, ci: contextCi, bothSolved: bothSolved.length },
    use: { status: verdictFor(useChecks, n), checks: useChecks, scenariosWithBlock: uses.length },
    recallCi,
  };
}

/** The blind-spot split, by scenario. Reported, never gated. */
export function blindSpotReport(rows, arms) {
  const blind = rows.filter((r) => r.blindSpot);
  const reachable = rows.filter((r) => !r.blindSpot);
  const recallOf = (subset, arm) => (subset.length === 0 ? null : mean(subset.map((r) => r[arm].recall)));
  return {
    blindSpotScenarios: blind.map((r) => r.id),
    graphReachableScenarios: reachable.length,
    partialBlindSpotScenarios: rows.filter((r) => r.blindSpotPartial).map((r) => r.id),
    recall: Object.fromEntries(
      arms.map((arm) => [
        arm,
        { graphReachable: recallOf(reachable, arm), blindSpot: recallOf(blind, arm) },
      ]),
    ),
    precision: Object.fromEntries(
      arms.map((arm) => [
        arm,
        {
          graphReachable: reachable.length === 0 ? null : mean(reachable.map((r) => r[arm].precision)),
          blindSpot: blind.length === 0 ? null : mean(blind.map((r) => r[arm].precision)),
        },
      ]),
    ),
    $comment:
      "Split per SCENARIO, because a blind spot is recorded against a broken TEST and the miner " +
      "does not store which truth files that test attributed. On this population every blind-spot " +
      "scenario is wholly one, so the split is exact; `partialBlindSpotScenarios` is where that " +
      "would stop being true and is empty here. Gated by nothing: pooling a route or an event name " +
      "into the graph's recall measures the graph on an edge it never claimed, and leaving them out " +
      "measures an easier repository than the real one.",
  };
}

export function buildReport(scenarioFile, readArm, readDelivered, registration, registrationId) {
  const arms = armIdsOf(registration, registrationId);
  const rows = [];
  const missing = [];
  const planned = scenarioFile.scenarios.filter((s) => !s.excluded);
  for (const s of planned) {
    const parsed = {};
    for (const arm of arms) {
      const text = readArm(s, arm);
      if (text === null) {
        missing.push(`${s.id}/${arm}`);
        continue;
      }
      const a = parseArm(text, treeDirOf(s, OUT), registration.arms.model);
      parsed[arm] = { ...a, ...score(a.named, s.truth, s.file) };
    }
    if (arms.some((a) => parsed[a] === undefined)) continue;
    const block = readDelivered(s);
    const blind = blindSpotOf(s);
    rows.push({
      id: s.id,
      repo: s.repo ?? null,
      file: s.file,
      truth: s.truth.length,
      blindSpot: blind.isBlindSpot,
      blindSpotPartial: blind.partial,
      blindSpotTests: blind.blindTests,
      blockDelivered: block !== null,
      blockFiles: block?.listed?.length ?? 0,
      blockBasis: block?.basis ?? null,
      blockTokensEst: block?.tokensEst ?? null,
      blockTruncated: block?.truncated ?? null,
      blockUse: block === null ? null : blockUse(block.listed, parsed[DELIVERED_ARM].named),
      ...parsed,
    });
  }

  const verdict = judge(rows, registration);
  const incomplete = rows.length < planned.length;
  const per = (arm, pick) => mean(rows.map((r) => pick(r[arm])));
  const costUsd = rows.reduce((a, r) => a + arms.reduce((b, arm) => b + r[arm].costUsd, 0), 0);
  return {
    registration: registrationId,
    registration_version: registration.registration_version,
    // TWO verdicts, as registered, and no third one to quote. `precision` and
    // `recall` are checks inside both and never a verdict of their own: they
    // are what a pass is not allowed to have been bought with.
    verdicts: {
      context: verdict.context.status,
      use: verdict.use.status,
      $comment:
        "Separate on purpose. A block that is free and ignored, and a block that is used and " +
        "expensive, need opposite work.",
    },
    n: verdict.n,
    progress: {
      scenariosComplete: rows.length,
      scenariosPlanned: planned.length,
      incomplete,
      label: incomplete ? `incomplete (${rows.length}/${planned.length})` : "complete",
    },
    missing,
    arms,
    means: Object.fromEntries(
      arms.map((arm) => [
        arm,
        {
          recall: per(arm, (a) => a.recall),
          precision: per(arm, (a) => a.precision),
          inputTokensMedian: median(rows.map((r) => r[arm].inputTokens)),
        },
      ]),
    ),
    context: {
      status: verdict.context.status,
      ratio: verdict.context.checks.context_ratio.value,
      ci: verdict.context.ci,
      scenariosSolvedInBothArms: verdict.context.bothSolved,
    },
    use: {
      status: verdict.use.status,
      mean: verdict.use.checks.block_use.value,
      scenariosWithBlock: verdict.use.scenariosWithBlock,
      scenariosWithoutBlock: rows.filter((r) => !r.blockDelivered).map((r) => r.id),
      basisDistribution: rows.reduce((a, r) => {
        if (r.blockBasis !== null) a[r.blockBasis] = (a[r.blockBasis] ?? 0) + 1;
        return a;
      }, {}),
      blockTokensMedian: median(rows.map((r) => r.blockTokensEst).filter((x) => x !== null)),
    },
    recallGuard: { ci: verdict.recallCi, mean: verdict.context.checks.recall.mean },
    checks: { context: verdict.context.checks, use: verdict.use.checks },
    blindSpots: blindSpotReport(rows, arms),
    notGated: {
      // The third arm, where it ran: the FULL tool answer against the block.
      // It says whether a failing D failed because the block is small or
      // because the answer does not help. Reported, gated by nothing.
      p_vs_a_recall: arms.includes("P") ? per("P", (a) => a.recall) - per("A", (a) => a.recall) : null,
      p_vs_d_context: arms.includes("P")
        ? median(rows.map((r) => r.P.inputTokens)) / median(rows.map((r) => r[DELIVERED_ARM].inputTokens))
        : null,
      context_ratio_all_scenarios:
        median(rows.map((r) => r[DELIVERED_ARM].inputTokens)) /
        median(rows.map((r) => r[CONTROL_ARM].inputTokens)),
      $comment:
        "The gated context ratio covers only scenarios BOTH arms solved (recall >= 0.8), so that a " +
        "cheap wrong answer cannot win on cost. These cover everything and are reported for completeness.",
    },
    cost: {
      usd: costUsd,
      ceiling_usd: registration.run_conditions.cost_ceiling_usd,
      withinCeiling: costUsd <= registration.run_conditions.cost_ceiling_usd,
    },
    usageFallbackRows: rows.filter((r) => arms.some((a) => r[a].usageFallback)).map((r) => r.id),
    rows,
  };
}

function main() {
  const scenarioFile = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
  const { id: registrationId, registration } = resolveRegistration(OUT);
  const report = buildReport(
    scenarioFile,
    (s, arm) => {
      const f = join(RUNS, s.id, `${arm}.jsonl`);
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    },
    (s) => {
      const f = join(RUNS, s.id, "delivered.json");
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
    },
    registration,
    registrationId,
  );
  const recordedPin = readBuildPin(OUT);
  const buildPin =
    recordedPin === null
      ? null
      : {
          headSha: recordedPin.headSha,
          distRevision: recordedPin.distRevision.revision,
          registrationId: recordedPin.registrationId ?? null,
          registrationVersion: recordedPin.registrationVersion,
          signature: pinSignature(recordedPin),
        };
  const full = {
    ...report,
    build_pin: buildPin,
    mixed_builds: mixedBuildsReport(armMetaRows(RUNS), buildPin?.signature ?? null),
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(full, null, 2));
  process.stdout.write(JSON.stringify({ ...full, rows: undefined }, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
