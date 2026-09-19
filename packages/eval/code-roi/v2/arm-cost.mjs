/**
 * What an arm cost, what counts as a finished arm, and when the run stops (#582).
 *
 * Split out of `run-arms-v3.mjs` because it is one question — how much has this
 * measurement already spent, and may it spend more — and because it is the part
 * that is tested on synthetic transcripts rather than by running an arm. The
 * runner keeps the arms; this keeps the money.
 *
 * Three rules hold everything else together:
 *
 *   1. A `result` event does not mean success. The CLI emits one when it gives
 *      up too, and a budget stop exits 0. Only `is_error === false` with a
 *      success subtype is a finished arm.
 *   2. Cost is read from the `result` event and nowhere else. Assistant events
 *      repeat their usage, so summing them double-counts (342 636 tokens where
 *      191 610 were spent, measured on the v3 archive).
 *   3. An abort is never free. What it burned is charged against the ceiling
 *      even though no arm came of it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The registration this measurement runs under. The ceiling and the per-arm
 * estimate are READ from it, never repeated here: a number in two places is a
 * number that ends up different in one of them, and these two decide when a
 * paid run stops.
 */
const REGISTRATION = JSON.parse(
  readFileSync(new URL("../../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
);
const REGISTERED_CEILING_USD = Number(REGISTRATION.run_conditions.cost_ceiling_usd);

export function costCeilingUsdOf(registration, env = process.env) {
  const registered = Number(registration?.run_conditions?.cost_ceiling_usd);
  if (!Number.isFinite(registered) || registered <= 0) {
    throw new Error("run_conditions.cost_ceiling_usd must be a positive number");
  }
  const raw = Number(env.CODE_ROI_COST_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, registered) : registered;
}

/**
 * The ceiling this run honours. The environment may only LOWER it: a variable
 * that can raise a registered spending limit is not a limit, it is a default.
 */
export const COST_CEILING_USD = (() => {
  const raw = Number(process.env.CODE_ROI_COST_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, REGISTERED_CEILING_USD) : REGISTERED_CEILING_USD;
})();

export function armEstimateUsdOf(registration) {
  const explicit = Number(registration?.run_conditions?.arm_estimate_usd);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const prose = String(registration?.run_conditions?.cost_estimate ?? "");
  const m = /mean \$([0-9]+(?:\.[0-9]+)?) per arm/.exec(prose);
  if (m !== null) return Number(m[1]);
  throw new Error(
    "run_conditions must provide arm_estimate_usd or state a “mean $X per arm” cost estimate",
  );
}

/**
 * What the registration expects ONE arm to cost, in US dollars.
 *
 * Read out of `run_conditions.cost_estimate`, where the v4 pilot's mean per arm
 * was written down before the run. It is what an abort is charged before any
 * arm has finished — with nothing measured yet, the registered expectation is
 * the only honest figure, and $0 is a wrong one. If the sentence is ever
 * reworded this throws rather than quietly falling back to zero: a cost floor
 * that silently becomes free is the failure this module exists to prevent.
 */
export const REGISTERED_ARM_ESTIMATE_USD = (() => {
  const prose = String(REGISTRATION.run_conditions.cost_estimate ?? "");
  const m = /mean \$([0-9]+(?:\.[0-9]+)?) per arm/.exec(prose);
  if (m === null) {
    throw new Error(
      "run_conditions.cost_estimate no longer states a “mean $X per arm”. The runner " +
        "charges an aborted arm with that number before any arm has finished; without it an " +
        "abort would cost $0 and the ceiling would not bind. Restore the phrase, or amend the " +
        "registration and this reader together.",
    );
  }
  return Number(m[1]);
})();

/**
 * The terminal `result` event of this transcript, or null.
 *
 * The last one wins: a half-written line after it is not a result, and neither
 * is anything the CLI printed before it.
 */
export function resultEventOf(transcript) {
  let found = null;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "result") found = ev;
    } catch {
      /* a half-written line is not a result */
    }
  }
  return found;
}

/**
 * What one arm cost, from its transcript's `result` event.
 *
 * Every `result` carries `total_cost_usd`, the failing subtypes included — so
 * an arm stopped at `--max-budget-usd` reports what it really burned and is
 * charged that, not an estimate. Only a transcript with NO `result` at all
 * (killed at the timeout, crashed before the first turn) reports 0, and the
 * caller then falls back to `abortedArmCharge`.
 */
export function armCostUsd(transcript) {
  const ev = resultEventOf(transcript);
  return ev !== null && typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0;
}

/**
 * The `result` subtypes that mean the CLI finished its own turn.
 *
 * Verified against the installed `claude` 2.1.278, whose result event is typed
 * `subtype: "success" | "error_during_execution" | "error_max_turns" |
 * "error_max_budget_usd" | "error_max_structured_output_retries"`, and against
 * every archived transcript under ~/.bastra/eval (107 result events across
 * code-roi-v2, both pilots and the adoption run — all `subtype:"success"` with
 * `is_error:false`). Anything outside this set is an arm that stopped early,
 * however cleanly the process exited.
 */
export const SUCCESS_RESULT_SUBTYPES = new Set(["success"]);

/** Does this transcript carry the terminal `result` event at all, success or not? */
export function hasResultEvent(transcript) {
  return resultEventOf(transcript) !== null;
}

/**
 * Does this transcript carry a SUCCESSFUL terminal `result` event?
 *
 * Not merely a `result`. The CLI emits one when it gives up too: a budget stop
 * is `{"type":"result","subtype":"error_max_budget_usd","is_error":true}` and
 * the process exits 0. A runner that accepted any `result` would finalise that
 * truncated run as a finished arm, and the scorer would read whatever `FILES:`
 * line it had managed as the arm's answer — a measurement reporting a number
 * where it should report an error.
 *
 * Both halves are required, `is_error === false` AND a success subtype, because
 * either one alone is a field a future CLI could stop setting.
 */
export function successfulResult(transcript) {
  const ev = resultEventOf(transcript);
  if (ev === null) return false;
  return ev.is_error === false && SUCCESS_RESULT_SUBTYPES.has(ev.subtype);
}

/**
 * May this transcript be finalised as a finished arm?
 *
 * Exit 0 alone is not enough — a CLI stopped at `--max-budget-usd` exits
 * cleanly — and a successful `result` alone is not enough either, because a
 * non-zero exit says something went wrong after it.
 */
export function finalisable(exitCode, transcript) {
  return exitCode === 0 && successfulResult(transcript);
}

/** What the next arm is expected to cost: this run's own mean, else the registration's. */
export function nextArmEstimateUsd(finishedCostUsd, finishedArms, registeredEstimateUsd = REGISTERED_ARM_ESTIMATE_USD) {
  return finishedArms > 0 ? finishedCostUsd / finishedArms : registeredEstimateUsd;
}

/**
 * What an ABORTED arm is charged against the ceiling.
 *
 * An arm killed at the timeout, stopped by `--max-budget-usd` or crashed spent
 * real money on every turn it took, and counting it as free is how a run of
 * failures spends without limit.
 *
 *   1. Its own `result` event, when it has one. A budget stop and a turn limit
 *      both report `total_cost_usd`, and a measured number beats any estimate.
 *   2. Otherwise the mean of the arms that FINISHED — this run's own prices,
 *      not a per-token table nobody re-checks when it changes.
 *   3. Otherwise the registered per-arm estimate. This is the case the previous
 *      version got wrong: before the first finished arm it charged $0, so a
 *      sample whose every arm timed out walked the whole list for free.
 *
 * The mean in (2) is taken over FINISHED arms only. Feeding aborted charges
 * back into it would let each further abort re-charge the estimate it was
 * itself given, and a run of failures would talk its own ceiling reading up.
 */
export function abortedArmCharge(
  transcript,
  finishedCostUsd,
  finishedArms,
  registeredEstimateUsd = REGISTERED_ARM_ESTIMATE_USD,
) {
  const measured = armCostUsd(transcript ?? "");
  if (measured > 0) return { usd: measured, source: "result_event" };
  if (finishedArms > 0) return { usd: finishedCostUsd / finishedArms, source: "mean_of_finished_arms" };
  return { usd: registeredEstimateUsd, source: "registered_estimate" };
}

/**
 * May another arm start?
 *
 * `chargedUsd` is the WHOLE burden — finished arms plus what the aborts were
 * charged — because the ceiling is about money spent, and an abort spends it
 * without producing an arm. `estimateUsd` is what the next arm is expected to
 * cost: a ceiling checked only AFTER the spend is not a ceiling.
 */
export function withinCeiling(chargedUsd, estimateUsd, ceilingUsd = COST_CEILING_USD) {
  if (chargedUsd >= ceilingUsd) return false;
  return chargedUsd + estimateUsd <= ceilingUsd;
}

/**
 * Everything this archive has already been charged, read back off disk.
 *
 * The run is taken in helpings, so a resumed invocation starts with whatever
 * earlier ones spent — and that is not only the finished arms. An abort leaves
 * no transcript the runner will read again, so what it burned is written into
 * its `.failed…meta.json` at the time and summed from there afterwards.
 * Without this, a helping that aborted ten arms and was resumed would begin at
 * $0 and the 40 $ ceiling would bind on nothing.
 *
 * Every scenario directory is walked, not just the ones this invocation will
 * touch: money spent under `--only S01` is still money spent.
 */
export function spendOnDisk(runsDir, armIds) {
  const spend = { finishedCostUsd: 0, finishedArms: 0, abortedCostUsd: 0, abortedArms: 0 };
  if (!existsSync(runsDir)) return spend;
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(runsDir, entry.name);
    for (const armId of armIds) {
      const path = join(dir, `${armId}.jsonl`);
      if (!existsSync(path)) continue;
      const transcript = readFileSync(path, "utf8");
      if (!successfulResult(transcript)) continue;
      spend.finishedCostUsd += armCostUsd(transcript);
      spend.finishedArms++;
    }
    for (const file of readdirSync(dir)) {
      if (!/\.failed.*\.meta\.json$/.test(file)) continue;
      try {
        const meta = JSON.parse(readFileSync(join(dir, file), "utf8"));
        if (typeof meta.chargedUsd === "number") {
          spend.abortedCostUsd += meta.chargedUsd;
          spend.abortedArms++;
        }
      } catch {
        /* an unreadable meta charges nothing; the transcript beside it is gone anyway */
      }
    }
  }
  return spend;
}
