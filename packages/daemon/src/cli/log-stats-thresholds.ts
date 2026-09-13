/**
 * The release threshold for automatic hook delivery (#305).
 *
 * #305 asks for "an explicit release threshold the packed client has to meet".
 * Until now that existed as prose — a single 600ms budget in a comment, and a
 * 200ms target in an issue title — which is why the gate could be argued about
 * instead of read off. A threshold nothing measures against is not a threshold.
 *
 * So it lives here, per lane, as numbers the readout checks on every run:
 *
 *  · `budgetMs`        — the wall clock the lane actually enforces. Mirrors
 *                        hook-budgets.ts; if the two drift, the readout would
 *                        report headroom against a ceiling nobody enforces.
 *  · `p90TargetMs`     — where the lane is expected to sit. This is what became
 *                        of #305's "cut the ceiling to 200ms": a target for the
 *                        fast lanes, which hold it, instead of one number the
 *                        slowest lane was never going to meet.
 *  · `maxFailureRate`  — the share of calls allowed to time out or error. A
 *                        timed-out hook returns nothing and the turn continues
 *                        as if there had been nothing to say, so this is the
 *                        number the "misses the release bar" claim is about.
 *
 * The values are set from seven days of real use (2026-09-05 → 2026-09-12,
 * `~/.bastra/logs`, restart windows excluded, client rows folded), not chosen
 * to be comfortably passed:
 *
 *   | lane       |   n |   p90 | failure | threshold |
 *   |------------|-----|-------|---------|-----------|
 *   | pretooluse | 723 |  87ms |   0.1%  |  200ms/2% |
 *   | none       | 351 | 245ms |   0.9%  |  300ms/2% |
 *   | assertion  | 273 | 731ms |  23.4%  |  900ms/5% |
 *
 * The assertion lane is the one that fails today, and it fails on the failure
 * rate, not on latency — which is the whole finding of #305 restated as a
 * number: it was being cut off at 600ms while the daemon went on to finish the
 * call. At the 1000ms budget, the same week's calls reconstruct to 99.3–100%
 * delivered.
 *
 * Below MIN_CALLS_FOR_VERDICT a lane is reported NOT EVALUABLE — stated, not
 * withheld: a lane with three calls can show 33% and mean nothing, and a gate
 * that swings on n=3 is worse than no gate, but a lane that quietly leaves the
 * list is how five of the seven automatic lanes went unmeasured for a whole
 * release. Same rule and same word as #437's arms (`stats-arms.ts`).
 *
 * The three lanes above were the whole table until the counter-review pointed
 * out that plan, SessionStart, Bash pre/post and Stop could not turn the gate
 * red at all. RELEASE_THRESHOLDS below carries all of them now, with the
 * measurement each new threshold was read off.
 */
import {
  ASSERTION_P90_TARGET_MS,
  FAST_BUDGET_MS,
  FAST_LANE_P90_TARGET_MS,
  PROMPT_ASSERTION_BUDGET_MS,
  PROMPT_QUIET_P90_TARGET_MS,
  RECALL_BUDGET_MS,
  STOP_BUDGET_MS,
} from "../hook-budgets.js";
import type { LaneStats } from "./log-stats.js";

/**
 * #305 — every automatic lane the product advertises, and the event kind it
 * writes. The prompt hook is not in here because it splits into trigger
 * classes (`detected_mode`) rather than forming one lane.
 *
 * Until this map existed, `aggregate()` knew two kinds. Plan, SessionStart,
 * Bash pre/post and Stop fell into `otherKinds` — an orientation line at the
 * bottom of the readout — so the release gate could not turn red for five of
 * the seven lanes that fire on their own. A gate that structurally cannot fail
 * for most of what it gates is not a gate.
 */
export const GATE_LANE_BY_KIND: Record<string, string> = {
  hook_call: "pretooluse",
  todo_hook_call: "plan",
  session_hook_call: "session",
  bash_hook_call: "bash-pre",
  bash_fail_hook_call: "bash-post",
  save_eval_call: "stop",
};

/** The lanes a window must contain to be judged at all — one per hook
 *  registration. A trigger class of the prompt lane is NOT one of these: which
 *  classes appear depends on what the user typed, so an absent `retrieval` is
 *  a quiet week, while an absent `stop` is a lane that did not run. */
export const REQUIRED_LANES: string[] = Object.values(GATE_LANE_BY_KIND);

export interface LaneThreshold {
  budgetMs: number;
  p90TargetMs: number;
  /** Share of calls (0–1) allowed to end as timeout or error. */
  maxFailureRate: number;
}

/**
 * Below this, a lane's rate is noise and no verdict is reported.
 *
 * ONE number for every lane, deliberately. A 2% ceiling starts to mean
 * something around n=30 and not before; a lane-specific smaller n would be a
 * number chosen so that a thin lane can pass, which is the opposite of a gate.
 * The plan lane is the live example — 7 calls in the measured week — and it is
 * reported NOT EVALUABLE rather than given a min-N it can clear.
 */
export const MIN_CALLS_FOR_VERDICT = 30;

const QUIET_PROMPT: LaneThreshold = {
  budgetMs: RECALL_BUDGET_MS,
  p90TargetMs: PROMPT_QUIET_P90_TARGET_MS,
  maxFailureRate: 0.02,
};

/**
 * Every automatic lane, with the budget it enforces and the bar it must hold.
 *
 * The five lanes below the prompt/write pair were added in the same pass that
 * found them missing: plan, SessionStart, Bash pre/post and Stop are
 * advertised as automatic, and none of them could turn the gate red. Their
 * budgets are the ones hook-budgets.ts already fixes; their p90 targets are
 * derived from the readout itself over seven days (2026-09-06 → 2026-09-13,
 * `~/.bastra/logs`, restart windows excluded, client rows folded):
 *
 *   | lane       |   n | median |   p90 |   max | failures |
 *   |------------|-----|--------|-------|-------|----------|
 *   | pretooluse | 847 |   51ms |  87ms | 605ms |    0.1%  |
 *   | stop       | 585 |   28ms |  52ms | 150ms |    0%    |
 *   | none       | 409 |   77ms | 607ms | 683ms |   17.1%  |
 *   | bash-post  | 291 |   78ms | 103ms | 262ms |    0%    |
 *   | assertion  | 285 |  424ms | 726ms |1017ms |   14.4%  |
 *   | session    | 144 |   84ms | 142ms | 569ms |    0%    |
 *   | bash-pre   |  54 |   72ms |  83ms |  97ms |    0%    |
 *   | plan       |   7 |    8ms |  78ms |  78ms |    0%    |
 *
 * (`none` carries client rows written by the pre-#305 stub, which stamped no
 * usable session and therefore no longer fold — see log-stats-phases.ts. That
 * lane's number is only honest again on a window measured with the fixed
 * client.)
 *
 * The rule used for the new five: take the fast-lane target (200ms) unless the
 * lane's tail says that would be a coin flip rather than a bar. Four of them
 * hold 200ms with room to spare — stop at a twentieth of its budget, bash-pre
 * and bash-post at half the target, plan far under it. Two get the
 * quiet-prompt 300ms instead: `session`, whose p90 sits at 142ms but whose max
 * is 569ms because SessionStart runs several queries at the one moment the
 * embedding arm is reliably cold; and `plan`, because 7 calls are not a
 * measurement to tighten anything on, so it inherits the target of the recall
 * lane it behaves like. Failure ceilings stay at 2%; only the assertion lane,
 * which pays a cold dense arm by construction, was granted 5%.
 */
export const RELEASE_THRESHOLDS: Record<string, LaneThreshold> = {
  pretooluse: { budgetMs: RECALL_BUDGET_MS, p90TargetMs: FAST_LANE_P90_TARGET_MS, maxFailureRate: 0.02 },
  none: QUIET_PROMPT,
  retrieval: QUIET_PROMPT,
  generic: QUIET_PROMPT,
  assertion: {
    budgetMs: PROMPT_ASSERTION_BUDGET_MS,
    p90TargetMs: ASSERTION_P90_TARGET_MS,
    maxFailureRate: 0.05,
  },
  // TodoWrite / update_plan: a recall lane like the quiet prompt classes.
  plan: { budgetMs: RECALL_BUDGET_MS, p90TargetMs: PROMPT_QUIET_P90_TARGET_MS, maxFailureRate: 0.02 },
  session: { budgetMs: FAST_BUDGET_MS, p90TargetMs: PROMPT_QUIET_P90_TARGET_MS, maxFailureRate: 0.02 },
  "bash-pre": { budgetMs: FAST_BUDGET_MS, p90TargetMs: FAST_LANE_P90_TARGET_MS, maxFailureRate: 0.02 },
  "bash-post": { budgetMs: FAST_BUDGET_MS, p90TargetMs: FAST_LANE_P90_TARGET_MS, maxFailureRate: 0.02 },
  // The Stop lane is allowed a full second because it scans a transcript; it
  // spends a twentieth of it, so its target is the fast one it actually holds.
  stop: { budgetMs: STOP_BUDGET_MS, p90TargetMs: FAST_LANE_P90_TARGET_MS, maxFailureRate: 0.02 },
};

/**
 * `not_evaluable` is #437's word, not a second one for the same idea: a lane
 * under its min-N is reported as not evaluable rather than as a null result
 * (§18.1, and `stats-arms.ts` for the experiment arms). It is not a pass and
 * it is not silence — a lane that simply did not appear in the window gets one
 * of these too, because a missing row is exactly what this gate kept mistaking
 * for a healthy one.
 */
export type Verdict = "pass" | "fail" | "not_evaluable" | "no-threshold";

export interface LaneVerdict {
  mode: string;
  verdict: Verdict;
  calls: number;
  failureRate: number;
  p90: number | null;
  threshold: LaneThreshold | null;
  /** Why it failed, in the order the checks run. Empty on a pass. */
  reasons: string[];
}

export function laneVerdict(lane: LaneStats): LaneVerdict {
  const threshold = RELEASE_THRESHOLDS[lane.mode] ?? null;
  const failures = lane.timeouts + lane.errors;
  const failureRate = lane.calls > 0 ? failures / lane.calls : 0;
  const p90 = lane.latency?.p90 ?? null;
  const base = { mode: lane.mode, calls: lane.calls, failureRate, p90, threshold, reasons: [] as string[] };
  if (!threshold) return { ...base, verdict: "no-threshold" };
  if (lane.calls < MIN_CALLS_FOR_VERDICT) return { ...base, verdict: "not_evaluable" };
  const reasons: string[] = [];
  if (failureRate > threshold.maxFailureRate) {
    reasons.push(
      `${failures}/${lane.calls} calls returned nothing (${(failureRate * 100).toFixed(1)}% > ${(threshold.maxFailureRate * 100).toFixed(0)}%)`,
    );
  }
  if (p90 !== null && p90 > threshold.p90TargetMs) {
    reasons.push(`p90 ${p90}ms > ${threshold.p90TargetMs}ms`);
  }
  return { ...base, verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

/** An empty lane — a lane the gate covers that the window never saw. */
function absentLane(mode: string): LaneStats {
  return { mode, calls: 0, withHits: 0, suppressed: 0, gated: 0, timeouts: 0, errors: 0, latency: null };
}

/**
 * A verdict for every lane the gate covers, plus every lane the window saw.
 *
 * The second half is what the readout always did. The first is the fix: a lane
 * that produced no rows used to leave no line at all, and a gate reads
 * "nothing here" as "nothing wrong". Five of the seven automatic lanes were in
 * that position permanently, because nothing even counted their events.
 */
export function releaseVerdicts(lanes: LaneStats[]): LaneVerdict[] {
  const seen = new Set(lanes.map((l) => l.mode));
  const absent = REQUIRED_LANES.filter((mode) => !seen.has(mode)).map((mode) => laneVerdict(absentLane(mode)));
  return [...lanes.map(laneVerdict), ...absent];
}

/** The gate itself: no lane may fail. Lanes without enough calls do not pass
 *  it either — "we did not measure" is not "it works", so the caller is told
 *  to widen the window rather than handed a green light. */
export function releaseGateMet(verdicts: LaneVerdict[]): boolean {
  return verdicts.every((v) => v.verdict === "pass" || v.verdict === "no-threshold");
}

export function renderReleaseGate(verdicts: LaneVerdict[]): string[] {
  const judged = verdicts.filter((v) => v.verdict !== "no-threshold");
  if (judged.length === 0) return [];
  const out: string[] = ["  release gate (#305) — per-lane budget, p90 target, failure ceiling"];
  for (const v of judged) {
    const t = v.threshold!;
    const head = `    ${v.mode.padEnd(11)} ${t.budgetMs}ms budget · p90 ≤ ${t.p90TargetMs}ms · fail ≤ ${(t.maxFailureRate * 100).toFixed(0)}%`;
    if (v.verdict === "not_evaluable") {
      // #437's wording: under the min-N a lane is NOT EVALUABLE — never a
      // null result, and never absent from the list.
      out.push(`${head} — NOT EVALUABLE (${v.calls} call(s) of the min-N ${MIN_CALLS_FOR_VERDICT})`);
      continue;
    }
    out.push(`${head} — ${v.verdict.toUpperCase()}${v.reasons.length > 0 ? `: ${v.reasons.join("; ")}` : ""}`);
  }
  out.push(`    gate: ${releaseGateMet(verdicts) ? "MET" : "NOT MET"}`);
  return out;
}
