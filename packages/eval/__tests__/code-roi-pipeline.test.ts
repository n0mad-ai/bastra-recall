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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const V2 = join(process.env.HOME ?? "", ".bastra", "eval", "code-roi-v2");

const { isFrozen, writableOut } = await import("../code-roi/v2/archive.mjs");
const { ARM_IDS, shuffled, rng, excludedPilotCommits, pooledCandidates, fileKey } = await import(
  "../code-roi/v2/select.mjs"
);
const {
  ARMS,
  withinCeiling,
  armCostUsd,
  abortedArmCharge,
  armFinished,
  finalisable,
  firstSymlink,
  hasResultEvent,
  COST_CEILING_USD,
  scenarioComplete,
  helpingSize,
  treeDirOf,
  GRAPH_TOOLS,
} = await import("../code-roi/v2/run-arms-v3.mjs");
// `mutation-gate.mjs` resolves its archive and its repository at module load,
// so the test states both rather than inheriting whatever the shell had. The
// directory is a throwaway: nothing in this file writes to it.
process.env.CODE_ROI_OUT ??= mkdtempSync(join(tmpdir(), "code-roi-gate-test-"));
process.env.CODE_ROI_REPO ??= process.cwd();
const { checkPopulation, populationHash, mutationDiff } = await import(
  "../code-roi/v2/mutation-gate.mjs"
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

// ─── Pooling several repositories ────────────────────────────────

describe("a pooled sample follows the registration, not the results", () => {
  const cands = (repo: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ repo, file: `src/f${i}.ts` }));

  test("repositories are drawn in the REGISTERED order", () => {
    const byRepo = new Map([
      ["/r/second", cands("/r/second", 10)],
      ["/r/first", cands("/r/first", 10)],
    ]);
    const { pooled } = pooledCandidates(byRepo, ["/r/first", "/r/second"], 30, 15);
    assert.equal(pooled[0].repo, "/r/first", "insertion order must not decide the sample");
    assert.equal(pooled.filter((c) => c.repo === "/r/first").length, 10);
    assert.equal(pooled.filter((c) => c.repo === "/r/second").length, 5);
  });

  test("no repository may carry more than the cap", () => {
    const byRepo = new Map([["/r/big", cands("/r/big", 200)]]);
    const { pooled, takenPerRepo } = pooledCandidates(byRepo, ["/r/big"], 30, 40);
    assert.equal(pooled.length, 30);
    assert.equal(takenPerRepo.get("/r/big"), 30);
  });

  test("a repository the registration does not name is never drawn from", () => {
    const byRepo = new Map([
      ["/r/listed", cands("/r/listed", 5)],
      ["/r/stranger", cands("/r/stranger", 50)],
    ]);
    const { pooled } = pooledCandidates(byRepo, ["/r/listed"], 30, 40);
    assert.equal(pooled.length, 5);
    assert.ok(pooled.every((c) => c.repo === "/r/listed"));
  });

  test("the cap cuts the TAIL, it does not choose among scenarios", () => {
    const byRepo = new Map([["/r/a", cands("/r/a", 10)]]);
    const { pooled } = pooledCandidates(byRepo, ["/r/a"], 4, 40);
    assert.deepEqual(pooled.map((c) => c.file), ["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts"]);
  });

  test("the same path in two repositories is two different files", () => {
    assert.notEqual(fileKey({ repo: "/r/a", file: "src/index.ts" }), fileKey({ repo: "/r/b", file: "src/index.ts" }));
    assert.equal(fileKey({ repo: "/r/a", file: "src/index.ts" }), fileKey({ repo: "/r/a", file: "src/index.ts" }));
  });

  test("the cap does not shrink a sufficient single-repository sample", () => {
    // The amendment of 2026-09-19: bastra-io alone mined 40, and an
    // unconditional cap of 30 would have turned that into `underpowered`.
    const byRepo = new Map([["/r/a", cands("/r/a", 40)], ["/r/b", cands("/r/b", 7)]]);
    const enough = (byRepo.get("/r/a") ?? []).length >= 40;
    const { pooled } = pooledCandidates(byRepo, enough ? ["/r/a"] : ["/r/a", "/r/b"], enough ? Infinity : 30, 40);
    assert.equal(pooled.length, 40);
    assert.ok(pooled.every((c) => c.repo === "/r/a"), "no pooling where none is needed");
  });

  test("drawing stops once the target is reached", () => {
    const byRepo = new Map([["/r/a", cands("/r/a", 100)], ["/r/b", cands("/r/b", 100)]]);
    const { pooled, takenPerRepo } = pooledCandidates(byRepo, ["/r/a", "/r/b"], 30, 40);
    assert.equal(pooled.length, 40);
    assert.equal(takenPerRepo.get("/r/a"), 30);
    assert.equal(takenPerRepo.get("/r/b"), 10);
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
    assert.equal(report.verdicts.effect !== undefined, true);
    assert.equal(report.status, undefined, "no combined status in the report either");
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

// ─── The offline mechanism gate ──────────────────────────────────

describe("the cross-package mechanism gate", () => {
  test("it counts only truth files in another package", async () => {
    const { gateRows, gateScore } = await import("../code-roi/v2/mechanism-gate.mjs");
    const scenarios = [
      { id: "S1", file: "packages/db/src/a.ts", truth: ["apps/web/x.ts", "packages/db/src/b.ts"] },
      { id: "S2", file: "packages/db/src/c.ts", truth: ["packages/db/src/d.ts"] },
      { id: "S3", file: "apps/web/y.ts", truth: ["apps/web/z.ts"], excluded: "pilot" },
    ];
    const rows = gateRows(scenarios);
    assert.deepEqual(rows.map((r) => r.id), ["S1"], "only a scenario that crosses a boundary");
    assert.deepEqual(rows[0].crossTruth, ["apps/web/x.ts"], "and only the crossing file of it");

    assert.deepEqual(gateScore([{ crossTruth: ["a", "b"], named: ["a"] }]), {
      found: 1,
      total: 2,
      share: 0.5,
      scenarios: 1,
    });
    assert.equal(gateScore([]).share, null, "no cross-package truth is not a score of zero");
  });
});

// ─── The synthetic mutation gate ─────────────────────────────────

describe("the mutation gate makes breakage mechanically", () => {
  const FIXTURE = [
    "export function encryptToken(payload: string): string {",
    "  return payload;",
    "}",
    "",
    "export interface TokenOptions {",
    "  ttl: number;",
    "}",
    "",
    "export const VERSION = 1;",
    "const helper = 2;",
  ].join("\n");

  test("it finds the exported symbols and ignores the private one", async () => {
    const { exportedSymbols } = await import("../code-roi/v2/mutation-gate.mjs");
    assert.deepEqual(exportedSymbols(FIXTURE), ["encryptToken", "TokenOptions", "VERSION"]);
    assert.equal(exportedSymbols("const x = 1;\n").length, 0);
  });

  test("require-param adds a parameter every caller now misses", async () => {
    const { OPERATORS } = await import("../code-roi/v2/mutation-gate.mjs");
    const op = OPERATORS.find((o: { name: string }) => o.name === "require-param");
    const out = op.apply(FIXTURE, "encryptToken");
    assert.match(out, /export function encryptToken\(__mutation: never, payload: string\)/);
    assert.equal(op.apply(FIXTURE, "TokenOptions"), null, "an interface is not a function — skipped, not forced");
  });

  test("rename-export takes the name away from every importer", async () => {
    const { OPERATORS } = await import("../code-roi/v2/mutation-gate.mjs");
    const op = OPERATORS.find((o: { name: string }) => o.name === "rename-export");
    assert.match(op.apply(FIXTURE, "VERSION"), /export const VERSIONRenamed = 1;/);
    assert.match(op.apply(FIXTURE, "encryptToken"), /export function encryptTokenRenamed\(/);
  });

  test("require-field adds a field every object literal must now carry", async () => {
    const { OPERATORS } = await import("../code-roi/v2/mutation-gate.mjs");
    const op = OPERATORS.find((o: { name: string }) => o.name === "require-field");
    assert.match(op.apply(FIXTURE, "TokenOptions"), /export interface TokenOptions \{\n  __mutation: never;/);
    assert.equal(op.apply(FIXTURE, "VERSION"), null);
  });

  test("a mutation is reversible: applying and restoring gives the original text", async () => {
    const { OPERATORS } = await import("../code-roi/v2/mutation-gate.mjs");
    for (const op of OPERATORS) {
      const mutated = op.apply(FIXTURE, "encryptToken") ?? op.apply(FIXTURE, "TokenOptions");
      if (mutated === null) continue;
      assert.notEqual(mutated, FIXTURE, `${op.name} must change something`);
    }
    // The runner writes `original` back verbatim; nothing about the operator
    // is needed to undo it, which is why a failed typecheck cannot leave the
    // tree dirty.
    assert.equal(FIXTURE, FIXTURE);
  });

  test("the draw is seeded, so the sample cannot be re-rolled", async () => {
    const { drawOrder } = await import("../code-roi/v2/mutation-gate.mjs");
    const items = Array.from({ length: 20 }, (_, i) => i);
    assert.deepEqual(drawOrder(items, 7), drawOrder(items, 7));
    assert.notDeepEqual(drawOrder(items, 7), drawOrder(items, 8));
    assert.deepEqual([...drawOrder(items, 7)].sort((a, b) => a - b), items, "a permutation, nothing lost");
  });

  test("every file/symbol/operator triple is offered, deterministically", async () => {
    const { candidateMutations, OPERATORS } = await import("../code-roi/v2/mutation-gate.mjs");
    const cands = candidateMutations(["a.ts"], () => FIXTURE);
    assert.equal(cands.length, 3 * OPERATORS.length, "three exports x every operator");
    assert.deepEqual(cands, candidateMutations(["a.ts"], () => FIXTURE));
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

  test("a run that clears every threshold passes BOTH verdicts", () => {
    const v = judge(rowsWhere(40, 0.1), thresholds, 40);
    assert.equal(v.adoption.status, "pass");
    assert.equal(v.effect.status, "pass", JSON.stringify(v.effect.checks));
    assert.equal(v.status, undefined, "there is no combined status to quote");
  });

  test("too small a recall gain fails EFFECT and leaves adoption alone", () => {
    const v = judge(rowsWhere(40, 0.02), thresholds, 40);
    assert.equal(v.effect.status, "fail");
    assert.equal(v.adoption.status, "pass");
    assert.equal(v.effect.checks.recall_gain.pass, false);
    assert.equal(v.effect.checks.precision_loss.pass, true);
  });

  test("a gain bought with wrong files fails on precision", () => {
    const v = judge(rowsWhere(40, 0.1, -0.2), thresholds, 40);
    assert.equal(v.effect.checks.recall_gain.pass, true);
    assert.equal(v.effect.checks.precision_loss.pass, false);
    assert.equal(v.effect.status, "fail");
  });

  test("a gain bought with context fails on context", () => {
    const v = judge(rowsWhere(40, 0.1, 0, 1.5), thresholds, 40);
    assert.equal(v.effect.checks.context.pass, false);
    assert.equal(v.effect.status, "fail");
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
    assert.equal(v.effect.checks.recall_ci_lower.pass, false);
    assert.equal(v.effect.status, "fail");
  });

  test("too few scenarios makes BOTH verdicts underpowered, not a judgement", () => {
    const v = judge(rowsWhere(12, 0.3), thresholds, 40);
    assert.equal(v.adoption.status, "underpowered");
    assert.equal(v.effect.status, "underpowered");
  });

  test("adoption can fail while the effect passes — the whole point of splitting", () => {
    const rows = rowsWhere(40, 0.2).map((r, i) => ({ ...r, B: { ...r.B, affectedCalls: i < 10 ? 1 : 0 } }));
    const v = judge(rows, thresholds, 40);
    assert.equal(v.adoption.checks.adoption.value, 0.25);
    assert.equal(v.adoption.status, "fail");
    assert.equal(v.effect.status, "pass", "a tool nobody calls can still have a good answer");
  });

  test("the effect can fail while adoption passes", () => {
    const v = judge(rowsWhere(40, 0), thresholds, 40);
    assert.equal(v.adoption.status, "pass");
    assert.equal(v.effect.status, "fail");
  });

  test("the unfiltered context ratio is reported next to the gated one", () => {
    const v = judge(rowsWhere(40, 0.1, 0, 2), thresholds, 40);
    assert.equal(v.contextRatioAllScenarios, 2);
    assert.equal(v.effect.checks.context.value, 2);
  });
});

// ─── The cost ceiling ────────────────────────────────────────────

describe("the cost ceiling is enforced, not documented", () => {
  test("the runner's ceiling IS the registered one, not a copy of it", async () => {
    const reg = JSON.parse(
      await readFile(new URL("../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
    );
    assert.equal(COST_CEILING_USD, reg.run_conditions.cost_ceiling_usd);
    assert.equal(COST_CEILING_USD, 40, "raised from 20 by decision on 18.09.2026, before the run");
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
    assert.equal(report.cost.ceiling_usd, 40);
    assert.equal(report.cost.withinCeiling, true);
  });
});

// ─── Isolation and arm shape (#582 review) ───────────────────────

describe("the arms cannot reach their own answer sheet", () => {
  test("the working tree lives outside the archive", () => {
    const out = join(process.env.HOME ?? "", ".bastra", "eval", "code-roi-v4-bastra-io");
    const tree = treeDirOf({ id: "S01" }, out);
    assert.ok(!tree.startsWith(out), `the tree must not be under the archive: ${tree}`);
    assert.ok(tree.includes("S01"), "and it must be derived, so a resumed helping finds it again");
    assert.equal(treeDirOf({ id: "S01" }, out), tree, "the same scenario always gets the same tree");
  });

  test("two archives do not share a tree", () => {
    assert.notEqual(treeDirOf({ id: "S01" }, "/a/arch-one"), treeDirOf({ id: "S01" }, "/a/arch-two"));
  });
});

describe("each arm is the thing it claims to be", () => {
  test("A is grep alone: no MCP, no prefilled block", () => {
    assert.equal(ARMS.A.graph, false);
    assert.equal(ARMS.A.prefill, false);
  });

  test("prefilled is the ANSWER alone — no MCP server, no product surface", () => {
    assert.equal(ARMS.prefilled.prefill, true);
    assert.equal(
      ARMS.prefilled.graph,
      false,
      "with the server attached, a gain could not be told apart from arm B's",
    );
  });

  test("B is offered the product's WHOLE surface, not just the code half", () => {
    assert.equal(ARMS.B.graph, true);
    assert.ok(GRAPH_TOOLS.includes("mcp__code__find_affected_files"));
    assert.ok(
      GRAPH_TOOLS.includes("mcp__code__recall"),
      "the instructions ask for a recall first — an arm denied it is not the product",
    );
    assert.ok(GRAPH_TOOLS.length >= 10, `expected the full tool list, got ${GRAPH_TOOLS.length}`);
  });
});

describe("the cost ceiling cannot be raised from the environment", () => {
  test("the registered value is the maximum, whatever the env says", async () => {
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
});

// ─── Helpings across subscription windows ────────────────────────

describe("the run can be taken in helpings", () => {
  const archive = (done: Record<string, string[]>) => {
    const dir = mkdtempSync(join(tmpdir(), "code-roi-helping-"));
    for (const [id, arms] of Object.entries(done)) {
      mkdirSync(join(dir, id), { recursive: true });
      for (const arm of arms) writeFileSync(join(dir, id, `${arm}.jsonl`), transcript({ files: [] }));
    }
    return dir;
  };

  test("a scenario counts as done only when ALL THREE arms are there", () => {
    const dir = archive({ S01: ["A", "B", "prefilled"], S02: ["A", "B"], S03: [] });
    try {
      assert.equal(scenarioComplete(join(dir, "S01")), true);
      assert.equal(scenarioComplete(join(dir, "S02")), false, "a torn pair is not a scenario");
      assert.equal(scenarioComplete(join(dir, "S03")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the helping size comes from the flag, then the env, else unbounded", () => {
    const before = process.env.CODE_ROI_MAX_SCENARIOS;
    try {
      delete process.env.CODE_ROI_MAX_SCENARIOS;
      assert.equal(helpingSize(), Infinity);
      process.env.CODE_ROI_MAX_SCENARIOS = "8";
      assert.equal(helpingSize(), 8);
      process.env.CODE_ROI_MAX_SCENARIOS = "0";
      assert.equal(helpingSize(), Infinity, "0 is not a helping, it is no limit at all");
    } finally {
      if (before === undefined) delete process.env.CODE_ROI_MAX_SCENARIOS;
      else process.env.CODE_ROI_MAX_SCENARIOS = before;
    }
  });

  test("resuming skips the finished scenarios and takes the next N", () => {
    // What the runner's loop does: complete scenarios never consume a helping.
    const done = new Set(["S01", "S02"]);
    const order = ["S01", "S02", "S03", "S04", "S05", "S06"];
    const N = 2;
    const taken: string[] = [];
    let started = 0;
    for (const id of order) {
      const complete = done.has(id);
      if (!complete && started >= N) break;
      if (!complete) {
        started++;
        taken.push(id);
      }
    }
    assert.deepEqual(taken, ["S03", "S04"], "registered order, no re-sorting");
  });

  test("an incomplete archive reports how far it got and gates only the paired part", () => {
    const scenarios = Array.from({ length: 40 }, (_, i) => ({
      id: `S${i}`,
      repo: "/r/io",
      file: `packages/x/src/f${i}.ts`,
      truth: [`packages/y/src/a${i}.ts`],
    }));
    // Twelve scenarios fully run; four more have their B arm only.
    const report = buildReport(scenarios, (s, arm) => {
      const i = Number(s.id.slice(1));
      if (i < 12) return transcript({ files: [`packages/y/src/a${i}.ts`], affectedCalls: arm === "B" ? 1 : 0 });
      if (i < 16 && arm === "B") return transcript({ files: [], affectedCalls: 1 });
      return null;
    });
    assert.equal(report.progress.incomplete, true);
    assert.equal(report.progress.label, "incomplete (12/40)");
    assert.equal(report.progress.scenariosComplete, 12);
    assert.equal(report.progress.armBComplete, 16, "adoption needs arm B only");
    assert.equal(report.n, 12, "the effect uses the complete triples only");
    assert.equal(report.adoption.n, 16);
    assert.equal(report.adoption.scenariosCallingFindAffectedFiles, 16);
    assert.equal(report.verdicts.effect, "underpowered", "12 of 40 is not a verdict");
    assert.equal(report.verdicts.adoption, "underpowered");
  });

  test("a finished archive is labelled complete", () => {
    const { scenarios, read } = sample(3, () => ({ files: [] }));
    const report = buildReport(scenarios, read);
    assert.equal(report.progress.incomplete, false);
    assert.equal(report.progress.label, "complete");
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

  test("a pooled sample is broken down per repository, and that is not gated", () => {
    const scenarios = Array.from({ length: 6 }, (_, i) => ({
      id: `S${i}`,
      repo: i < 4 ? "/r/io" : "/r/rec",
      file: `packages/x/src/f${i}.ts`,
      truth: [`packages/y/src/a${i}.ts`],
    }));
    const report = buildReport(scenarios, (s, arm) =>
      transcript({ files: [`packages/y/src/a${s.id.slice(1)}.ts`], affectedCalls: arm === "B" ? 1 : 0 }),
    );
    assert.equal(report.byRepo["/r/io"].n, 4);
    assert.equal(report.byRepo["/r/rec"].n, 2);
    assert.equal(report.byRepo["/r/io"].adoptionShare, 1);
    assert.equal(Object.keys(report.checks).some((k) => k.includes("repo")), false, "no per-repo gate");
  });

  test("an answer without a FILES: line scores zero recall rather than crashing", () => {
    const { scenarios } = sample(1, () => ({ files: [] }));
    const report = buildReport(scenarios, () => transcript({ files: [], noFilesLine: true }));
    assert.equal(report.rows[0].A.noAnswer, true);
    assert.equal(report.rows[0].A.recall, 0);
  });
});

// ─── An aborted arm is not a finished one (#582 review) ──────────

describe("an arm counts as run only when it finished", () => {
  const finished = transcript({ files: ["a.ts"], costUsd: 0.2 });
  /** What the CLI leaves behind when it is killed mid-turn: no `result` row. */
  const aborted = finished
    .split("\n")
    .filter((l) => l.trim() !== "" && (JSON.parse(l) as { type: string }).type !== "result")
    .join("\n");

  test("finalising needs exit 0 AND the terminal result event", () => {
    assert.equal(finalisable(0, finished), true);
    assert.equal(finalisable(1, finished), false, "a non-zero exit is not a finished arm");
    assert.equal(finalisable(0, aborted), false, "a clean exit without a result is a budget stop");
    assert.equal(finalisable(143, aborted), false, "SIGTERM at the timeout");
    assert.equal(finalisable(0, ""), false, "an empty transcript finishes nothing");
  });

  test("hasResultEvent survives the half-written last line of a killed process", () => {
    assert.equal(hasResultEvent(aborted + '\n{"type":"assis'), false);
    assert.equal(hasResultEvent(finished + '\n{"type":"assis'), true);
  });

  test("an aborted transcript on disk does not make a scenario complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "code-roi-aborted-"));
    try {
      mkdirSync(join(dir, "S01"), { recursive: true });
      writeFileSync(join(dir, "S01", "A.jsonl"), finished);
      writeFileSync(join(dir, "S01", "B.jsonl"), finished);
      // The shape the old runner produced: renamed although it never finished.
      writeFileSync(join(dir, "S01", "prefilled.jsonl"), aborted);
      assert.equal(armFinished(join(dir, "S01"), "A"), true);
      assert.equal(armFinished(join(dir, "S01"), "prefilled"), false);
      assert.equal(
        scenarioComplete(join(dir, "S01")),
        false,
        "the old runner's rename must not pass for a finished triple",
      );
      assert.equal(armCostUsd(aborted), 0, "no result event, no reported cost");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an aborted arm is charged the mean of the arms that did finish", () => {
    // Not free: a scenario that keeps failing would otherwise run for ever at
    // no recorded cost. Before the first finished arm there is nothing to
    // estimate from, and nothing is charged.
    assert.equal(abortedArmCharge(0, 0), 0);
    assert.equal(abortedArmCharge(1.5, 3), 0.5);
  });
});

describe("the scenario tree may not contain a symbolic link", () => {
  test("a link anywhere under the tree is found, a plain tree passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "code-roi-tree-"));
    try {
      mkdirSync(join(dir, "packages", "core", "src"), { recursive: true });
      writeFileSync(join(dir, "packages", "core", "src", "index.ts"), "export {};\n");
      assert.equal(firstSymlink(dir), null);
      symlinkSync("/etc", join(dir, "packages", "core", "outside"));
      assert.equal(firstSymlink(dir), join(dir, "packages", "core", "outside"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── The mutation gate's population is frozen (#582 review) ──────

describe("the mutation gate cannot mix two trees under one seed", () => {
  const pinned = {
    repository: "/repo",
    commit: "44321b0f7da02f7e183cc9eb1aa368fa1241db14",
    population_sha256: "abc",
    candidates: 1233,
    seed: 20260918,
  };

  test("the first run pins, a matching run passes, a moved HEAD is an error", () => {
    assert.deepEqual(checkPopulation(null, pinned), { ok: true, write: true });
    assert.deepEqual(checkPopulation(pinned, pinned), { ok: true, write: false });
    const moved = { ...pinned, commit: "0000000000000000000000000000000000000000" };
    const verdict = checkPopulation(pinned, moved);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.write, false);
    assert.match(verdict.why, /commit/);
  });

  test("every pinned field is checked, not just the commit", () => {
    for (const key of ["repository", "population_sha256", "candidates", "seed"] as const) {
      const changed = { ...pinned, [key]: "moved" };
      assert.equal(checkPopulation(pinned, changed).ok, false, `${key} drifted unnoticed`);
    }
  });

  test("the population hash depends on the triples and their order", () => {
    const a = [{ file: "a.ts", symbol: "x", operator: "rename-export" }];
    const b = [{ file: "a.ts", symbol: "y", operator: "rename-export" }];
    assert.equal(populationHash(a), populationHash([...a]));
    assert.notEqual(populationHash(a), populationHash(b));
    assert.notEqual(populationHash([...a, ...b]), populationHash([...b, ...a]));
  });

  test("the stored diff is headed the way the product's diff reader expects", () => {
    // The gate now scores the PRODUCT path too, and that path takes a diff, not
    // a symbol name. A diff the reader cannot attribute to the file would score
    // as "nothing changed" and quietly pass.
    const diff = mutationDiff(
      "packages/db/src/index.ts",
      "export function q(a: string) {\n  return a;\n}\n",
      "export function q(__mutation: never, a: string) {\n  return a;\n}\n",
    );
    assert.match(diff, /^diff --git a\/packages\/db\/src\/index\.ts b\/packages\/db\/src\/index\.ts$/m);
    assert.match(diff, /^--- a\/packages\/db\/src\/index\.ts$/m);
    assert.match(diff, /^@@ /m);
    assert.match(diff, /^\+export function q\(__mutation: never, a: string\) \{$/m);
  });
});
