/**
 * Score the three-arm change-impact run against the registration (#582, v4).
 *
 * `evaluate.mjs` stays exactly as it is: it is the scorer the v3 report was
 * produced with, it reads the v3 registration, and it must keep reproducing
 * that report from the frozen archive. This is its successor, not its
 * replacement, and it differs in four ways that the v3 scorer could not have:
 *
 *   1. THREE ARMS. A (grep), B (tools offered), prefilled (the answer already
 *      in the prompt). Adoption comes from B alone, effect from prefilled
 *      against A; B against A is reported and explicitly NOT gated, because it
 *      multiplies the two and that is what made the v3 report unreadable.
 *
 *   2. BOTH TOOLS ARE COUNTED, SEPARATELY. `find_code` is not a substitute for
 *      `find_affected_files` in the adoption threshold: an agent that locates a
 *      symbol has not asked what breaks. The v3 scorer only knew `find_code`.
 *
 *   3. CONTEXT IS INPUT TOKENS, NOT TOOL-RESULT CHARACTERS. v3 counted the
 *      characters of tool results, which is blind to everything else in the
 *      window — and the prefilled arm's block arrives IN THE PROMPT, so under
 *      that rule the one arm that spends the most context would have looked
 *      free. What is summed instead, per arm, is the run's own accounting:
 *
 *          result.modelUsage[<run model>].inputTokens
 *        + result.modelUsage[<run model>].cacheReadInputTokens
 *        + result.modelUsage[<run model>].cacheCreationInputTokens
 *
 *      All three, because a cached token is a token the model read; leaving
 *      cache reads out would score a long run as a short one. Side models
 *      (the client's own haiku calls for titles and the like) are excluded:
 *      they are not the agent's context and they differ between arms at
 *      random. If `modelUsage` is missing, the run-level `usage` block is
 *      summed the same way and the row is marked `usageFallback`.
 *
 *   4. THE COST OF THE RUN is summed from `total_cost_usd` and reported
 *      against the registered ceiling.
 *
 * Usage: CODE_ROI_OUT=<dir> node evaluate-v4.mjs   → prints the report, writes report.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { score } from "./evaluate.mjs";
import { rng } from "./select.mjs";
import { writableOut } from "./archive.mjs";

const OUT = writableOut();
const REG = JSON.parse(
  readFileSync(new URL("../../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
);
const ARMS = ["A", "B", "prefilled"];
const EFFECT_ARM = "prefilled";
const CONTROL_ARM = "A";
const ADOPTION_ARM = "B";
const SOLVED = 0.8;
const RESAMPLES = 10_000;

const AFFECTED_TOOL = "mcp__code__find_affected_files";
const FIND_CODE_TOOL = "mcp__code__find_code";

/**
 * The input tokens one run really read, from its `result` event.
 *
 * Deliberately NOT summed over the assistant events: their `usage` blocks
 * repeat for a message with several content blocks, and summing them
 * double-counts (measured on the v3 archive: 342 636 against the run's own
 * 191 610). The run-level accounting is the one that adds up.
 */
export function inputTokensOf(result, model) {
  const usage = result?.modelUsage;
  if (usage && typeof usage === "object") {
    const rows = Object.entries(usage).filter(
      ([name, v]) => name === model || v?.canonicalModel === model,
    );
    if (rows.length > 0) {
      return {
        tokens: rows.reduce(
          (a, [, v]) =>
            a + (v.inputTokens ?? 0) + (v.cacheReadInputTokens ?? 0) + (v.cacheCreationInputTokens ?? 0),
          0,
        ),
        fallback: false,
      };
    }
  }
  const u = result?.usage;
  if (u && typeof u === "object") {
    return {
      tokens:
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      fallback: true,
    };
  }
  return { tokens: 0, fallback: true };
}

/** One arm's transcript, reduced to what the registration scores. */
export function parseArm(text, treePrefix, model = REG.arms.model) {
  let affectedCalls = 0;
  let findCodeCalls = 0;
  let affectedEmpty = 0;
  let final = null;
  const pendingAffected = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "tool_use") continue;
        if (c.name === AFFECTED_TOOL) {
          affectedCalls++;
          pendingAffected.add(c.id);
        } else if (c.name === FIND_CODE_TOOL) {
          // Counted, and deliberately NOT added to the adoption figure: a
          // locator call is not the change-impact question.
          findCodeCalls++;
        }
      }
    } else if (ev.type === "user") {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const body =
          typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("");
        if (pendingAffected.has(c.tool_use_id) && /"status":\s*"(no_answer|unavailable)"/.test(body)) {
          affectedEmpty++;
        }
      }
    } else if (ev.type === "result") {
      final = ev;
    }
  }

  const answer = typeof final?.result === "string" ? final.result : "";
  const lines = answer.split("\n").filter((l) => /^\s*FILES:/.test(l));
  let named = [];
  let noAnswer = final === null || final.is_error === true || lines.length === 0;
  if (!noAnswer) {
    try {
      const arr = JSON.parse(lines[lines.length - 1].replace(/^\s*FILES:\s*/, ""));
      named = Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch {
      noAnswer = true;
    }
  }
  named = [...new Set(named.map((p) => normalize(p, treePrefix)))];
  const { tokens, fallback } = inputTokensOf(final, model);
  return {
    named,
    noAnswer,
    inputTokens: tokens,
    usageFallback: fallback,
    costUsd: typeof final?.total_cost_usd === "number" ? final.total_cost_usd : 0,
    turns: final?.num_turns ?? null,
    affectedCalls,
    affectedEmpty,
    findCodeCalls,
  };
}

function normalize(p, treePrefix) {
  let n = p.trim().replace(/\\/g, "/");
  if (treePrefix && n.startsWith(`${treePrefix}/`)) n = n.slice(treePrefix.length + 1);
  return n.replace(/^\.\//, "");
}

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs) => {
  if (xs.length === 0) return NaN;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Paired bootstrap over the changed FILE, as registered. */
export function bootstrapCI(rows, values, seed = REG.statistics.seed) {
  const clusters = new Map();
  rows.forEach((r, i) => {
    if (!clusters.has(r.file)) clusters.set(r.file, []);
    clusters.get(r.file).push(values[i]);
  });
  const groups = [...clusters.values()];
  if (groups.length === 0) return null;
  const next = rng(seed);
  const means = [];
  for (let i = 0; i < RESAMPLES; i++) {
    const sample = [];
    for (let j = 0; j < groups.length; j++) sample.push(...groups[Math.floor(next() * groups.length)]);
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[Math.floor(0.025 * RESAMPLES)],
    hi: means[Math.floor(0.975 * RESAMPLES) - 1],
    clusters: groups.length,
  };
}

/**
 * The two verdicts, kept apart (#582).
 *
 * ADOPTION and EFFECT are different questions with different failure modes,
 * and a single "all must hold" status hides which one failed behind one word.
 * A tool nobody calls whose answer would have helped, and a tool everyone
 * calls whose answer does not, are opposite findings that need opposite work
 * — so each gets its own pass / fail / underpowered and there is deliberately
 * NO combined status to quote.
 */
export function judge(
  rows,
  thresholds = REG.thresholds,
  minScenarios = REG.sample.min_scenarios,
  adoptionRows = rows,
) {
  const n = rows.length;
  const adoptionN = adoptionRows.length;
  const verdictFor = (checks, count) => {
    if (count === 0) return "not_evaluable";
    if (count < minScenarios) return "underpowered";
    return Object.values(checks).every((c) => c.pass) ? "pass" : "fail";
  };
  const verdict = (checks) => verdictFor(checks, n);

  const adopted = adoptionRows.filter((r) => r[ADOPTION_ARM].affectedCalls > 0).length;
  const adoptionRate = adoptionN === 0 ? 0 : adopted / adoptionN;
  const adoptionChecks = {
    adoption: {
      value: adoptionRate,
      required: `>= ${thresholds.adoption_min_share} of B scenarios call find_affected_files (find_code does not count)`,
      pass: adoptionRate >= thresholds.adoption_min_share,
    },
  };

  const dRecall = rows.map((r) => r[EFFECT_ARM].recall - r[CONTROL_ARM].recall);
  const dPrecision = rows.map((r) => r[EFFECT_ARM].precision - r[CONTROL_ARM].precision);
  const ci = bootstrapCI(rows, dRecall);
  const bothSolved = rows.filter(
    (r) => r[CONTROL_ARM].recall >= SOLVED && r[EFFECT_ARM].recall >= SOLVED,
  );
  const ctxRatio =
    median(bothSolved.map((r) => r[EFFECT_ARM].inputTokens)) /
    median(bothSolved.map((r) => r[CONTROL_ARM].inputTokens));
  // The same ratio over EVERY scenario, gated by nothing. The registered
  // figure is restricted to scenarios both arms solved so that a cheap wrong
  // answer cannot win on cost; this one says what the run cost in total.
  const ctxRatioAll =
    median(rows.map((r) => r[EFFECT_ARM].inputTokens)) /
    median(rows.map((r) => r[CONTROL_ARM].inputTokens));
  const effectChecks = {
    recall_gain: {
      value: mean(dRecall),
      required: `>= ${thresholds.recall_gain_min}`,
      pass: mean(dRecall) >= thresholds.recall_gain_min,
    },
    recall_ci_lower: { value: ci?.lo, required: "> 0", pass: (ci?.lo ?? -1) > 0 },
    precision_loss: {
      value: mean(dPrecision),
      required: `>= -${thresholds.precision_loss_max}`,
      pass: mean(dPrecision) >= -thresholds.precision_loss_max,
    },
    context: {
      value: ctxRatio,
      required: `<= ${1 + thresholds.context_increase_max_ratio} (median input tokens, ${bothSolved.length} solved in both)`,
      pass: bothSolved.length > 0 && ctxRatio <= 1 + thresholds.context_increase_max_ratio,
    },
  };

  return {
    n,
    adoption: {
      status: verdictFor(adoptionChecks, adoptionN),
      checks: adoptionChecks,
      adopted,
      n: adoptionN,
    },
    effect: { status: verdict(effectChecks), checks: effectChecks, ci, bothSolved: bothSolved.length },
    contextRatioAllScenarios: ctxRatioAll,
  };
}

/** Per-repository figures for a pooled sample. Never gated. */
export function perRepo(rows) {
  const out = {};
  for (const row of rows) {
    const key = row.repo ?? "(unknown)";
    (out[key] ??= []).push(row);
  }
  return Object.fromEntries(
    Object.entries(out).map(([repo, rs]) => [
      repo,
      {
        n: rs.length,
        recall: Object.fromEntries(ARMS.map((a) => [a, mean(rs.map((r) => r[a].recall))])),
        precision: Object.fromEntries(ARMS.map((a) => [a, mean(rs.map((r) => r[a].precision))])),
        adoptionShare: rs.filter((r) => r[ADOPTION_ARM].affectedCalls > 0).length / rs.length,
      },
    ]),
  );
}

export function buildReport(scenarios, readArm) {
  const rows = [];
  const adoptionRows = [];
  const missing = [];
  const planned = scenarios.filter((s) => !s.excluded);
  for (const s of planned) {
    const arms = {};
    for (const arm of ARMS) {
      const text = readArm(s, arm);
      if (text === null) {
        missing.push(`${s.id}/${arm}`);
        continue;
      }
      const parsed = parseArm(text, join(OUT, "runs", s.id, "tree"));
      arms[arm] = { ...parsed, ...score(parsed.named, s.truth, s.file) };
    }
    // ADOPTION only needs arm B, so a scenario whose B has run counts for it
    // even while the run is mid-helping. The EFFECT is paired and needs the
    // whole triple — half a scenario is not a comparison.
    if (arms[ADOPTION_ARM] !== undefined) {
      adoptionRows.push({ id: s.id, repo: s.repo ?? null, file: s.file, [ADOPTION_ARM]: arms[ADOPTION_ARM] });
    }
    if (ARMS.some((a) => arms[a] === undefined)) continue;
    rows.push({ id: s.id, repo: s.repo ?? null, file: s.file, truth: s.truth.length, ...arms });
  }

  const verdict = judge(rows, undefined, undefined, adoptionRows);
  const incomplete = rows.length < planned.length;
  const per = (arm, pick) => mean(rows.map((r) => pick(r[arm])));
  const costUsd = rows.reduce((a, r) => a + ARMS.reduce((b, arm) => b + r[arm].costUsd, 0), 0);
  return {
    registration_version: REG.registration_version,
    // TWO verdicts, no third one. There is deliberately no combined `status`:
    // it would be the single word everyone quotes, and it would hide which of
    // the two questions failed.
    verdicts: {
      adoption: verdict.adoption.status,
      effect: verdict.effect.status,
      $comment:
        "Separate on purpose. A tool nobody calls whose answer would help, and " +
        "a tool everyone calls whose answer does not, need opposite work.",
    },
    n: verdict.n,
    // A run taken in helpings across several subscription windows: the report
    // says how far it got, so a partial number is never read as the result.
    progress: {
      scenariosComplete: rows.length,
      scenariosPlanned: planned.length,
      armBComplete: adoptionRows.length,
      incomplete,
      label: incomplete ? `incomplete (${rows.length}/${planned.length})` : "complete",
    },
    missing,
    means: Object.fromEntries(
      ARMS.map((arm) => [
        arm,
        {
          recall: per(arm, (a) => a.recall),
          precision: per(arm, (a) => a.precision),
          inputTokensMedian: median(rows.map((r) => r[arm].inputTokens)),
        },
      ]),
    ),
    adoption: {
      arm: ADOPTION_ARM,
      status: verdict.adoption.status,
      n: verdict.adoption.n,
      scenariosCallingFindAffectedFiles: verdict.adoption.adopted,
      scenariosCallingFindCode: adoptionRows.filter((r) => r[ADOPTION_ARM].findCodeCalls > 0).length,
      affectedCalls: adoptionRows.reduce((a, r) => a + r[ADOPTION_ARM].affectedCalls, 0),
      affectedEmpty: adoptionRows.reduce((a, r) => a + r[ADOPTION_ARM].affectedEmpty, 0),
      $comment: "find_code calls are reported but do not count towards the adoption threshold.",
    },
    effect: {
      status: verdict.effect.status,
      ciRecall: verdict.effect.ci,
      scenariosSolvedInBothArms: verdict.effect.bothSolved,
    },
    checks: { ...verdict.adoption.checks, ...verdict.effect.checks },
    notGated: {
      b_vs_a_recall: per("B", (a) => a.recall) - per("A", (a) => a.recall),
      context_ratio_all_scenarios: verdict.contextRatioAllScenarios,
      $comment_context:
        "The gated context ratio covers only scenarios BOTH arms solved (recall >= 0.8), " +
        "so that a cheap wrong answer cannot win on cost — the rule registration 3 used. " +
        "This one covers every scenario and is reported for completeness.",
      $comment:
        "B against A mixes adoption and effect: an agent that never calls the tool makes B equal to A. Reported, never gated.",
    },
    cost: {
      usd: costUsd,
      ceiling_usd: REG.run_conditions.cost_ceiling_usd,
      withinCeiling: costUsd <= REG.run_conditions.cost_ceiling_usd,
    },
    // A pooled sample describes no single repository, so the breakdown is
    // reported next to the pooled verdicts. It is DESCRIPTIVE: no threshold
    // reads it, and a repository that looks worse here has not failed anything.
    byRepo: perRepo(rows),
    usageFallbackRows: rows.filter((r) => ARMS.some((a) => r[a].usageFallback)).map((r) => r.id),
    rows,
  };
}

function main() {
  const { scenarios } = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
  const report = buildReport(scenarios, (s, arm) => {
    const f = join(OUT, "runs", s.id, `${arm}.jsonl`);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  });
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ ...report, rows: undefined }, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
