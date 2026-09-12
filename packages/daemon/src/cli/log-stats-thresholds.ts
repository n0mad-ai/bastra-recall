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
 * Verdicts are withheld below MIN_CALLS_FOR_VERDICT: a lane with three calls
 * can show 33% and mean nothing, and a gate that swings on n=3 is worse than
 * no gate.
 */
import {
  ASSERTION_P90_TARGET_MS,
  FAST_LANE_P90_TARGET_MS,
  PROMPT_ASSERTION_BUDGET_MS,
  PROMPT_QUIET_P90_TARGET_MS,
  RECALL_BUDGET_MS,
} from "../hook-budgets.js";
import type { LaneStats } from "./log-stats.js";

export interface LaneThreshold {
  budgetMs: number;
  p90TargetMs: number;
  /** Share of calls (0–1) allowed to end as timeout or error. */
  maxFailureRate: number;
}

/** Below this, a lane's rate is noise and no verdict is reported. */
export const MIN_CALLS_FOR_VERDICT = 30;

const QUIET_PROMPT: LaneThreshold = {
  budgetMs: RECALL_BUDGET_MS,
  p90TargetMs: PROMPT_QUIET_P90_TARGET_MS,
  maxFailureRate: 0.02,
};

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
};

export type Verdict = "pass" | "fail" | "insufficient-data" | "no-threshold";

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
  if (lane.calls < MIN_CALLS_FOR_VERDICT) return { ...base, verdict: "insufficient-data" };
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

export function releaseVerdicts(lanes: LaneStats[]): LaneVerdict[] {
  return lanes.map(laneVerdict);
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
    if (v.verdict === "insufficient-data") {
      out.push(`${head} — no verdict (${v.calls} call(s), needs ${MIN_CALLS_FOR_VERDICT})`);
      continue;
    }
    out.push(`${head} — ${v.verdict.toUpperCase()}${v.reasons.length > 0 ? `: ${v.reasons.join("; ")}` : ""}`);
  }
  out.push(`    gate: ${releaseGateMet(verdicts) ? "MET" : "NOT MET"}`);
  return out;
}
