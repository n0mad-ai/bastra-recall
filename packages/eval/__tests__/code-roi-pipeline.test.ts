/**
 * The v4 measurement pipeline, checked on synthetic transcripts (#582).
 *
 * Every failure these cover was found by a counter-review, not by a test, and
 * every one of them was SILENT: `select.mjs` wrote arm names the runner did
 * not know and the runner skipped them without a word; `mine.mjs` ignored
 * `CODE_ROI_OUT` and would have overwritten the frozen v3 archive; the scorer
 * knew two arms and one tool; and the context metric counted tool-result
 * characters, under which the prefilled arm's block — which arrives in the
 * prompt — costs nothing at all.
 *
 * A measurement that fails silently reports a number instead of an error, so
 * these are not plumbing tests. They are the reason the next report can be
 * believed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const V2 = join(process.env.HOME ?? "", ".bastra", "eval", "code-roi-v2");

const { isFrozen, writableOut } = await import("../code-roi/v2/archive.mjs");
const { ARM_IDS, shuffled, rng, excludedPilotCommits } = await import("../code-roi/v2/select.mjs");
const { ARMS, withinCeiling, armCostUsd, COST_CEILING_USD } = await import(
  "../code-roi/v2/run-arms-v3.mjs"
);
const { parseArm, inputTokensOf, judge, buildReport } = await import(
  "../code-roi/v2/evaluate-v4.mjs"
);

// ─── Synthetic transcripts ───────────────────────────────────────

interface ArmShape {
  files: string[];
  affectedCalls?: number;
  findCodeCalls?: number;
  affectedStatus?: string;
  inputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  costUsd?: number;
  noFilesLine?: boolean;
}

/** A stream-json transcript in the shape `claude -p --output-format stream-json` writes. */
function transcript(shape: ArmShape): string {
  const lines: unknown[] = [];
  const calls = shape.affectedCalls ?? 0;
  for (let i = 0; i < calls; i++) {
    lines.push({
      type: "assistant",
      message: {
        model: "claude-sonnet-5",
        content: [
          { type: "tool_use", id: `aff${i}`, name: "mcp__code__find_affected_files", input: {} },
        ],
      },
    });
    lines.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `aff${i}`,
            content: `{"status": "${shape.affectedStatus ?? "ok"}", "files": []}`,
          },
        ],
      },
    });
  }
  for (let i = 0; i < (shape.findCodeCalls ?? 0); i++) {
    lines.push({
      type: "assistant",
      message: {
        model: "claude-sonnet-5",
        content: [{ type: "tool_use", id: `fc${i}`, name: "mcp__code__find_code", input: {} }],
      },
    });
  }
  lines.push({
    type: "result",
    is_error: false,
    num_turns: 4,
    total_cost_usd: shape.costUsd ?? 0.25,
    result: shape.noFilesLine
      ? "I could not determine this."
      : `Here is what I found.\nFILES: ${JSON.stringify(shape.files)}`,
    usage: {
      input_tokens: 1,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: shape.inputTokens ?? 100,
        cacheReadInputTokens: shape.cacheRead ?? 1000,
        cacheCreationInputTokens: shape.cacheCreation ?? 500,
        canonicalModel: "claude-sonnet-5",
      },
      "claude-haiku-4-5-20251001": {
        inputTokens: 5000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        canonicalModel: "claude-haiku-4-5",
      },
    },
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** One scenario plus the three arms it was run through. */
function sample(
  n: number,
  shape: (i: number, arm: string) => ArmShape,
): { scenarios: Array<{ id: string; file: string; truth: string[] }>; read: (s: { id: string }, arm: string) => string | null } {
  const scenarios = Array.from({ length: n }, (_, i) => ({
    id: `S${String(i + 1).padStart(2, "0")}`,
    file: `packages/core/src/f${i}.ts`,
    truth: [`packages/daemon/src/a${i}.ts`, `packages/daemon/src/b${i}.ts`],
  }));
  const byId = new Map(scenarios.map((s, i) => [s.id, i]));
  return {
    scenarios,
    read: (s, arm) => transcript(shape(byId.get(s.id) as number, arm)),
  };
}

// ─── The frozen archive ──────────────────────────────────────────

describe("the v3 archive is write-protected", () => {
  test("isFrozen recognises the archive and anything inside it", () => {
    assert.equal(isFrozen(V2), true);
    assert.equal(isFrozen(join(V2, "runs", "S01")), true);
    assert.equal(isFrozen(join(V2, "..", "code-roi-v4")), false);
  });

  test("writableOut refuses it and names why", () => {
    const before = process.env.CODE_ROI_OUT;
    process.env.CODE_ROI_OUT = V2;
    try {
      assert.throws(() => writableOut(), /frozen v3 archive/);
    } finally {
      if (before === undefined) delete process.env.CODE_ROI_OUT;
      else process.env.CODE_ROI_OUT = before;
    }
  });

  test("writableOut accepts a fresh directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "code-roi-out-"));
    const before = process.env.CODE_ROI_OUT;
    process.env.CODE_ROI_OUT = dir;
    try {
      assert.equal(writableOut(), dir);
    } finally {
      if (before === undefined) delete process.env.CODE_ROI_OUT;
      else process.env.CODE_ROI_OUT = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── select → run handover ───────────────────────────────────────

describe("select hands the runner arm names it knows", () => {
  test("every id select writes is an arm the runner defines", () => {
    for (const id of ARM_IDS) {
      assert.ok(ARMS[id] !== undefined, `the runner has no arm "${id}"`);
    }
    assert.deepEqual([...ARM_IDS].sort(), ["A", "B", "prefilled"]);
  });

  test("the old v3 names are NOT arms any more", () => {
    assert.equal(ARMS.control, undefined);
    assert.equal(ARMS.treatment, undefined);
  });

  test("the shuffled arm order is a permutation, and seeded", () => {
    const order = shuffled(ARM_IDS, rng(20260918));
    assert.deepEqual([...order].sort(), [...ARM_IDS].sort());
    assert.deepEqual(order, shuffled(ARM_IDS, rng(20260918)));
  });

  test("the pilot commits are excluded mechanically, from the registration", () => {
    const excluded = excludedPilotCommits();
    assert.equal(excluded.size, 2, "the two pilot scenarios");
    for (const sha of excluded) assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(excludedPilotCommits({ sample: {} }).size, 0, "absent list is empty, not a crash");
  });

  test("exactly one arm is the prefilled one", () => {
    const prefilling = Object.values(ARMS).filter((a) => (a as { prefill: boolean }).prefill);
    assert.equal(prefilling.length, 1);
    assert.equal((prefilling[0] as { id: string }).id, "prefilled");
  });
});

// ─── Tool counting ───────────────────────────────────────────────

describe("tool calls are counted per tool", () => {
  test("find_affected_files calls are counted", () => {
    const t = parseArm(transcript({ files: [], affectedCalls: 3 }), "");
    assert.equal(t.affectedCalls, 3);
  });

  test("find_code does NOT count as find_affected_files", () => {
    const t = parseArm(transcript({ files: [], affectedCalls: 0, findCodeCalls: 5 }), "");
    assert.equal(t.affectedCalls, 0, "a locator call is not the change-impact question");
    assert.equal(t.findCodeCalls, 5, "but it is still reported");
  });

  test("an empty answer from the tool is counted separately", () => {
    const ok = parseArm(transcript({ files: [], affectedCalls: 2 }), "");
    const empty = parseArm(
      transcript({ files: [], affectedCalls: 2, affectedStatus: "unavailable" }),
      "",
    );
    assert.equal(ok.affectedEmpty, 0);
    assert.equal(empty.affectedEmpty, 2);
  });

  test("adoption counts scenarios, and find_code alone is not adoption", () => {
    const { scenarios, read } = sample(10, (i, arm) => ({
      files: [`packages/daemon/src/a${i}.ts`],
      // Only four of ten B scenarios call the change-impact tool; all ten call
      // the locator. Adoption must read 40 %, not 100 %.
      affectedCalls: arm === "B" && i < 4 ? 1 : 0,
      findCodeCalls: arm === "B" ? 2 : 0,
    }));
    const report = buildReport(scenarios, read);
    assert.equal(report.adoption.scenariosCallingFindAffectedFiles, 4);
    assert.equal(report.adoption.scenariosCallingFindCode, 10);
    assert.equal(report.checks.adoption.value, 0.4);
    assert.equal(report.checks.adoption.pass, false);
  });
});

// ─── Context as input tokens ─────────────────────────────────────

describe("context is the input tokens the run really read", () => {
  test("input, cache read and cache creation are all summed", () => {
    const t = parseArm(
      transcript({ files: [], inputTokens: 100, cacheRead: 1000, cacheCreation: 500 }),
      "",
    );
    assert.equal(t.inputTokens, 1600);
    assert.equal(t.usageFallback, false);
  });

  test("side models are not the agent's context", () => {
    const t = parseArm(transcript({ files: [] }), "");
    assert.ok(t.inputTokens < 5000, "the haiku row must not be in the figure");
  });

  test("a run without modelUsage falls back to the run-level usage and says so", () => {
    const { tokens, fallback } = inputTokensOf(
      { usage: { input_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 2 } },
      "claude-sonnet-5",
    );
    assert.equal(tokens, 20);
    assert.equal(fallback, true);
  });

  test("the prefilled block is NOT free: it shows up in the arm's tokens", () => {
    // The prefilled arm makes no tool call at all — under the v3 rule (tool
    // result characters) its context would have been zero.
    const { scenarios, read } = sample(40, (i, arm) => ({
      files: [`packages/daemon/src/a${i}.ts`, `packages/daemon/src/b${i}.ts`],
      affectedCalls: arm === "B" ? 1 : 0,
      cacheCreation: arm === "prefilled" ? 9000 : 500,
    }));
    const report = buildReport(scenarios, read);
    assert.ok(
      report.means.prefilled.inputTokensMedian > report.means.A.inputTokensMedian,
      "the arm that was handed a block of JSON must read more tokens than the one that was not",
    );
    assert.equal(report.checks.context.pass, false, "and that cost is gated");
  });
});

// ─── The verdict ─────────────────────────────────────────────────

describe("the registration's thresholds decide", () => {
  const thresholds = {
    adoption_min_share: 0.7,
    recall_gain_min: 0.05,
    precision_loss_max: 0.05,
    context_increase_max_ratio: 0.25,
  };
  const row = (
    id: string,
    a: { recall: number; precision: number; inputTokens: number },
    p: { recall: number; precision: number; inputTokens: number },
    bCalls: number,
  ) => ({
    id,
    file: `f${id}.ts`,
    A: { ...a, affectedCalls: 0, findCodeCalls: 0 },
    B: { ...a, affectedCalls: bCalls, findCodeCalls: 0 },
    prefilled: { ...p, affectedCalls: 0, findCodeCalls: 0 },
  });

  const rowsWhere = (n: number, gain: number, dPrecision = 0, ctx = 1) =>
    Array.from({ length: n }, (_, i) =>
      row(
        `S${i}`,
        { recall: 0.85, precision: 0.9, inputTokens: 10_000 },
        { recall: 0.85 + gain, precision: 0.9 + dPrecision, inputTokens: 10_000 * ctx },
        1,
      ),
    );

  test("a run that clears every threshold passes", () => {
    const v = judge(rowsWhere(40, 0.1), thresholds, 40);
    assert.equal(v.status, "pass", JSON.stringify(v.checks));
    for (const [name, c] of Object.entries(v.checks)) assert.equal(c.pass, true, name);
  });

  test("too small a recall gain fails on that criterion alone", () => {
    const v = judge(rowsWhere(40, 0.02), thresholds, 40);
    assert.equal(v.status, "fail");
    assert.equal(v.checks.recall_gain.pass, false);
    assert.equal(v.checks.precision_loss.pass, true);
    assert.equal(v.checks.adoption.pass, true);
  });

  test("a gain bought with wrong files fails on precision", () => {
    const v = judge(rowsWhere(40, 0.1, -0.2), thresholds, 40);
    assert.equal(v.checks.recall_gain.pass, true);
    assert.equal(v.checks.precision_loss.pass, false);
    assert.equal(v.status, "fail");
  });

  test("a gain bought with context fails on context", () => {
    const v = judge(rowsWhere(40, 0.1, 0, 1.5), thresholds, 40);
    assert.equal(v.checks.context.pass, false);
    assert.equal(v.status, "fail");
  });

  test("an interval that touches zero fails even with a mean gain", () => {
    // Half the scenarios gain, half lose the same amount: mean positive by a
    // hair, interval straddling zero.
    const rows = Array.from({ length: 40 }, (_, i) =>
      row(
        `S${i}`,
        { recall: 0.5, precision: 0.9, inputTokens: 10_000 },
        { recall: i % 2 === 0 ? 1 : 0.06, precision: 0.9, inputTokens: 10_000 },
        1,
      ),
    );
    const v = judge(rows, thresholds, 40);
    assert.equal(v.checks.recall_ci_lower.pass, false);
    assert.equal(v.status, "fail");
  });

  test("too few scenarios is underpowered, not a verdict", () => {
    const v = judge(rowsWhere(12, 0.3), thresholds, 40);
    assert.equal(v.status, "underpowered");
  });

  test("adoption below the share fails even when the effect is there", () => {
    const rows = rowsWhere(40, 0.2).map((r, i) => ({ ...r, B: { ...r.B, affectedCalls: i < 10 ? 1 : 0 } }));
    const v = judge(rows, thresholds, 40);
    assert.equal(v.checks.adoption.value, 0.25);
    assert.equal(v.checks.adoption.pass, false);
    assert.equal(v.checks.recall_gain.pass, true);
    assert.equal(v.status, "fail");
  });
});

// ─── The cost ceiling ────────────────────────────────────────────

describe("the cost ceiling is enforced, not documented", () => {
  test("the registered ceiling is what the runner uses", () => {
    assert.equal(COST_CEILING_USD, 20);
  });

  test("an arm may start while the ceiling is out of reach", () => {
    assert.equal(withinCeiling(0, 0, 20), true);
    assert.equal(withinCeiling(10, 10, 20), true);
  });

  test("it stops BEFORE the arm that would cross it", () => {
    // Nine arms at $2.11 each: the tenth would land at $21.
    assert.equal(withinCeiling(19, 9, 20), false);
    assert.equal(withinCeiling(20, 10, 20), false);
    assert.equal(withinCeiling(25, 10, 20), false);
  });

  test("cost comes from the transcript's result event, and a dead run costs nothing", () => {
    assert.equal(armCostUsd(transcript({ files: [], costUsd: 1.5 })), 1.5);
    assert.equal(armCostUsd('{"type":"assistant","message":{"content":[]}}\n'), 0);
    assert.equal(armCostUsd("not json at all\n"), 0);
  });

  test("the report sums the cost of all three arms against the ceiling", () => {
    const { scenarios, read } = sample(2, () => ({ files: [], costUsd: 1 }));
    const report = buildReport(scenarios, read);
    assert.equal(report.cost.usd, 6, "2 scenarios x 3 arms x $1");
    assert.equal(report.cost.ceiling_usd, 20);
    assert.equal(report.cost.withinCeiling, true);
  });
});

// ─── Scoring across three arms ───────────────────────────────────

describe("the report covers three arms", () => {
  test("a missing arm keeps the scenario out and is named", () => {
    const { scenarios } = sample(3, () => ({ files: [] }));
    const report = buildReport(scenarios, (s, arm) =>
      arm === "prefilled" && s.id === "S02" ? null : transcript({ files: [] }),
    );
    assert.equal(report.n, 2);
    assert.deepEqual(report.missing, ["S02/prefilled"]);
  });

  test("B against A is reported but carries no threshold", () => {
    const { scenarios, read } = sample(40, (i, arm) => ({
      files: arm === "A" ? [`packages/daemon/src/a${i}.ts`] : [`packages/daemon/src/a${i}.ts`, `packages/daemon/src/b${i}.ts`],
      affectedCalls: arm === "B" ? 1 : 0,
    }));
    const report = buildReport(scenarios, read);
    assert.ok(report.notGated.b_vs_a_recall > 0);
    assert.equal(
      Object.keys(report.checks).includes("b_vs_a"),
      false,
      "B vs A must never become a gate",
    );
  });

  test("an answer without a FILES: line scores zero recall rather than crashing", () => {
    const { scenarios } = sample(1, () => ({ files: [] }));
    const report = buildReport(scenarios, () => transcript({ files: [], noFilesLine: true }));
    assert.equal(report.rows[0].A.noAnswer, true);
    assert.equal(report.rows[0].A.recall, 0);
  });
});
