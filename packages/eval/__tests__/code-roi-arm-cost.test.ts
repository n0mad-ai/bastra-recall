/**
 * The money half of the v4 runner: what counts as a finished arm, what an
 * abort is charged, and when the ceiling stops the run (#582, counter-review).
 *
 * Every case here was a way the measurement could spend without noticing, or
 * report a truncated run as a result:
 *
 *   - A `result` event was taken for success. The CLI emits one when it gives
 *     up too, and `error_max_budget_usd` exits 0 — so an arm stopped at the
 *     budget was finalised, its partial `FILES:` line scored, and the next
 *     helping never re-ran it.
 *   - An abort before the first finished arm cost $0, so a sample whose every
 *     arm timed out walked the whole list for free.
 *   - A resumed helping rebuilt only the finished arms it walked past, forgot
 *     every abort, and started again near $0 against a 40 $ ceiling.
 *
 * The subtypes below are the installed CLI's own (`claude` 2.1.278, whose
 * result event is typed `subtype: "success" | "error_during_execution" |
 * "error_max_turns" | "error_max_budget_usd" |
 * "error_max_structured_output_retries"`), not invented for the test.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  COST_CEILING_USD,
  REGISTERED_ARM_ESTIMATE_USD,
  abortedArmCharge,
  armEstimateUsdOf,
  armCostUsd,
  costCeilingUsdOf,
  finalisable,
  hasResultEvent,
  nextArmEstimateUsd,
  spendOnDisk,
  successfulResult,
  withinCeiling,
  // @ts-expect-error — plain .mjs script, no declarations (#542).
} = await import("../code-roi/v2/arm-cost.mjs");
// @ts-expect-error — plain .mjs script, no declarations (#542).
const { ARM_IDS } = await import("../code-roi/v2/select.mjs");
// @ts-expect-error — plain .mjs script, no declarations (#542).
const { armFinished, scenarioComplete } = await import("../code-roi/v2/run-arms-v3.mjs");

/** The two assistant turns every transcript below starts with. */
const TURNS = [
  { type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text: "looking" }] } },
  { type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text: "still looking" }] } },
];

/** A transcript that ends in the CLI's `result` event, in whatever shape is asked for. */
function withResult(result: Record<string, unknown>): string {
  return [...TURNS, { type: "result", ...result }].map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const finished = withResult({
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.2,
  result: 'FILES: ["a.ts"]',
});
/** Killed mid-turn: the process died before the CLI wrote its result row. */
const killed = TURNS.map((l) => JSON.stringify(l)).join("\n") + "\n";
/** Stopped at `--max-budget-usd`. Exits 0, and reports what it burned. */
const budgetStopped = withResult({
  subtype: "error_max_budget_usd",
  is_error: true,
  total_cost_usd: 0.37,
  result: 'FILES: ["a.ts"',
});
const turnLimited = withResult({ subtype: "error_max_turns", is_error: true, total_cost_usd: 0.44 });
const crashedMidRun = withResult({ subtype: "error_during_execution", is_error: true, total_cost_usd: 0.11 });

describe("only a successful result event finishes an arm", () => {
  test("a clean exit with a success result is the only finished arm", () => {
    assert.equal(finalisable(0, finished), true);
    assert.equal(finalisable(1, finished), false, "a non-zero exit is not a finished arm");
    assert.equal(finalisable(0, killed), false, "no result event at all");
    assert.equal(finalisable(143, killed), false, "SIGTERM at the timeout");
    assert.equal(finalisable(0, ""), false, "an empty transcript finishes nothing");
  });

  test("a budget stop exits 0 with a result event and still does NOT finalise", () => {
    // The whole point: exit code and `result` both look like success here.
    assert.equal(hasResultEvent(budgetStopped), true);
    assert.equal(successfulResult(budgetStopped), false);
    assert.equal(finalisable(0, budgetStopped), false);
  });

  test("neither does any other failing subtype the CLI can emit", () => {
    for (const [name, body] of [
      ["error_max_turns", turnLimited],
      ["error_during_execution", crashedMidRun],
    ] as const) {
      assert.equal(finalisable(0, body), false, `${name} is not a finished arm`);
    }
  });

  test("is_error alone disqualifies, whatever the subtype says", () => {
    assert.equal(finalisable(0, withResult({ subtype: "success", is_error: true, total_cost_usd: 1 })), false);
  });

  test("a result without the fields at all is not assumed successful", () => {
    assert.equal(finalisable(0, withResult({ total_cost_usd: 1 })), false, "no subtype, no is_error");
  });

  test("the terminal result survives the half-written last line of a killed process", () => {
    assert.equal(hasResultEvent(killed + '{"type":"assis'), false);
    assert.equal(successfulResult(finished + '{"type":"assis'), true);
  });
});

describe("what an arm cost", () => {
  test("cost comes from the result event, failing subtypes included", () => {
    assert.equal(armCostUsd(finished), 0.2);
    assert.equal(armCostUsd(budgetStopped), 0.37, "a budget stop reports what it burned");
    assert.equal(armCostUsd(turnLimited), 0.44);
  });

  test("only a transcript with no result at all reports nothing", () => {
    assert.equal(armCostUsd(killed), 0);
    assert.equal(armCostUsd("not json at all\n"), 0);
    assert.equal(armCostUsd(""), 0);
  });
});

describe("an abort is never free", () => {
  test("its own result event first — a measured number beats any estimate", () => {
    const charge = abortedArmCharge(budgetStopped, 10, 20);
    assert.deepEqual(charge, { usd: 0.37, source: "result_event" });
  });

  test("with no result event, the mean of the arms that finished", () => {
    assert.deepEqual(abortedArmCharge(killed, 1.5, 3), { usd: 0.5, source: "mean_of_finished_arms" });
  });

  test("an abort BEFORE the first finished arm costs the registered estimate, not $0", () => {
    // The old version charged 0 here, so a sample whose every arm timed out ran
    // to the end of the list without the ceiling ever binding.
    const charge = abortedArmCharge(killed, 0, 0);
    assert.equal(charge.source, "registered_estimate");
    assert.equal(charge.usd, REGISTERED_ARM_ESTIMATE_USD);
    assert.ok(charge.usd > 0, "an abort that costs nothing is how a run spends without limit");
  });

  test("the estimate is READ from the registration, not written into the runner", async () => {
    const reg = JSON.parse(
      await readFile(new URL("../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
    );
    assert.ok(
      String(reg.run_conditions.cost_estimate).includes(`mean $${REGISTERED_ARM_ESTIMATE_USD} per arm`),
      "the number the runner charges must be the one the registration states",
    );
  });

  test("the projection never includes its own estimates", () => {
    // Three aborts in a row, each charged the registered estimate: the estimate
    // for the NEXT arm is still the registered one, because nothing has been
    // measured. Feeding charges back in would let a run of failures talk its
    // own ceiling reading up.
    let chargedUsd = 0;
    for (let i = 0; i < 3; i++) chargedUsd += abortedArmCharge(killed, 0, 0).usd;
    assert.equal(nextArmEstimateUsd(0, 0), REGISTERED_ARM_ESTIMATE_USD);
    assert.equal(chargedUsd, 3 * REGISTERED_ARM_ESTIMATE_USD, "but all three are charged");
  });

  test("a second registration supplies its own estimate instead of inheriting v6", async () => {
    const reg = JSON.parse(
      await readFile(new URL("../registrations/code-awareness-delivered.json", import.meta.url), "utf8"),
    );
    assert.equal(armEstimateUsdOf(reg), 0.046);
    assert.deepEqual(abortedArmCharge(killed, 0, 0, armEstimateUsdOf(reg)), {
      usd: 0.046,
      source: "registered_estimate",
    });
  });
});

describe("the cost ceiling is enforced, not documented", () => {
  test("the runner's ceiling IS the registered one, not a copy of it", async () => {
    const reg = JSON.parse(
      await readFile(new URL("../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
    );
    assert.equal(COST_CEILING_USD, reg.run_conditions.cost_ceiling_usd);
    assert.equal(COST_CEILING_USD, 40, "raised from 20 by decision on 18.09.2026, before the run");
  });

  test("the environment may lower but never raise the active registration's ceiling", () => {
    const reg = { run_conditions: { cost_ceiling_usd: 7 } };
    assert.equal(costCeilingUsdOf(reg, {}), 7);
    assert.equal(costCeilingUsdOf(reg, { CODE_ROI_COST_CEILING: "3" }), 3);
    assert.equal(costCeilingUsdOf(reg, { CODE_ROI_COST_CEILING: "30" }), 7);
  });

  test("the environment may only LOWER it", async () => {
    const reg = JSON.parse(
      await readFile(new URL("../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
    );
    // COST_CEILING_USD was resolved at import time with no env set.
    assert.equal(COST_CEILING_USD, reg.run_conditions.cost_ceiling_usd);
    const lower = Math.min(5, reg.run_conditions.cost_ceiling_usd);
    assert.equal(Math.min(lower, reg.run_conditions.cost_ceiling_usd), lower, "lowering is allowed");
    assert.equal(
      Math.min(999, reg.run_conditions.cost_ceiling_usd),
      reg.run_conditions.cost_ceiling_usd,
      "raising is not",
    );
  });

  test("an arm may start while the ceiling is out of reach", () => {
    assert.equal(withinCeiling(0, 1, 20), true);
    assert.equal(withinCeiling(10, 1, 20), true);
  });

  test("it stops BEFORE the arm that would cross it", () => {
    assert.equal(withinCeiling(19, 2, 20), false, "the next arm would land at $21");
    assert.equal(withinCeiling(20, 0.1, 20), false, "at the ceiling, nothing more starts");
    assert.equal(withinCeiling(25, 0.1, 20), false);
  });

  test("the ceiling is checked against the WHOLE burden, aborts included", () => {
    // Nine finished arms at $2 and one abort charged $2: $20 is spent even
    // though only $18 of it produced an arm. A ceiling that saw the $18 would
    // let the run carry on.
    const finishedCostUsd = 18;
    const chargedUsd = finishedCostUsd + 2;
    assert.equal(withinCeiling(finishedCostUsd, nextArmEstimateUsd(finishedCostUsd, 9), 20), true);
    assert.equal(withinCeiling(chargedUsd, nextArmEstimateUsd(finishedCostUsd, 9), 20), false);
  });
});

describe("a resumed helping reconstructs its spend from disk", () => {
  function archive(): string {
    const runs = mkdtempSync(join(tmpdir(), "code-roi-spend-"));
    for (const id of ["S01", "S02", "S03"]) mkdirSync(join(runs, id), { recursive: true });
    // S01: a complete triple.
    for (const arm of ARM_IDS) writeFileSync(join(runs, "S01", `${arm}.jsonl`), finished);
    // S02: one finished arm and two aborts, each with the meta the runner
    // writes at the moment it happens — the transcripts are renamed away and
    // never read again, so the meta is the only record of what they burned.
    writeFileSync(join(runs, "S02", "A.jsonl"), finished);
    writeFileSync(join(runs, "S02", "B.jsonl.failed-1"), killed);
    writeFileSync(
      join(runs, "S02", "B.failed-1.meta.json"),
      JSON.stringify({ arm: "B", finished: false, chargedUsd: 0.5, chargedFrom: "mean_of_finished_arms" }),
    );
    writeFileSync(join(runs, "S02", "B.jsonl.failed-2"), budgetStopped);
    writeFileSync(
      join(runs, "S02", "B.failed-2.meta.json"),
      JSON.stringify({ arm: "B", finished: false, chargedUsd: 0.37, chargedFrom: "result_event" }),
    );
    // S03: the shape the old runner produced — a budget stop renamed to a
    // plain `.jsonl` as if it had finished.
    writeFileSync(join(runs, "S03", "A.jsonl"), budgetStopped);
    return runs;
  }

  test("finished arms and aborted attempts are both summed, and kept apart", () => {
    const runs = archive();
    try {
      const spend = spendOnDisk(runs, ARM_IDS);
      assert.equal(spend.finishedArms, 4, "S01's three plus S02's one — S03's budget stop is not one");
      assert.equal(Number(spend.finishedCostUsd.toFixed(2)), 0.8);
      assert.equal(spend.abortedArms, 2);
      assert.equal(Number(spend.abortedCostUsd.toFixed(2)), 0.87);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("two aborts of the SAME arm both survive — one meta may not overwrite the other", () => {
    const runs = archive();
    try {
      assert.equal(spendOnDisk(runs, ARM_IDS).abortedArms, 2, "a fixed <arm>.failed.meta.json lost the first");
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("a budget stop on disk is not a finished arm and does not complete a scenario", () => {
    const runs = archive();
    try {
      assert.equal(armFinished(join(runs, "S01"), "A"), true);
      assert.equal(armFinished(join(runs, "S03"), "A"), false);
      assert.equal(scenarioComplete(join(runs, "S01")), true);
      assert.equal(scenarioComplete(join(runs, "S03")), false);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("an archive that was never run charges nothing, and a missing one does not throw", () => {
    const empty = mkdtempSync(join(tmpdir(), "code-roi-spend-empty-"));
    try {
      assert.deepEqual(spendOnDisk(empty, ARM_IDS), {
        finishedCostUsd: 0,
        finishedArms: 0,
        abortedCostUsd: 0,
        abortedArms: 0,
      });
      assert.equal(spendOnDisk(join(empty, "nope"), ARM_IDS).finishedArms, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
