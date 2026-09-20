/**
 * The delivered-block measurement, checked before it costs anything (#606).
 *
 * Three kinds of failure are covered, and all three are SILENT ones — the only
 * kind that matters here, because a measurement that fails loudly is a
 * measurement nobody believes by mistake:
 *
 *   1. The registration stops deciding. Arm ids and thresholds are read off
 *      `code-awareness-delivered.json`, so a number changed in the file and not
 *      in the code would otherwise go unnoticed in whichever direction the
 *      duplicate happened to be stale.
 *   2. Arm D stops being the product's block. The rendering goes through
 *      `packages/daemon/dist`, so a test that asserts the text would pass
 *      against a reconstruction; what is asserted instead is that the harness
 *      narrows the way the product narrows and prints the product's own lead.
 *   3. The v6 report stops reproducing. Making the pipeline registration-driven
 *      touched `select.mjs`, `run-arms-v3.mjs` and `build-pin.mjs`, all three of
 *      which the FINISHED v6 measurement depends on. The last test re-scores
 *      that archive and compares the result with the report on disk.
 *
 * Run: npx tsx --test packages/eval/__tests__/code-roi-delivered.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Module-scope `writableOut()` in the runner and the scorer: the archive is
// stated here rather than inherited from whatever the shell had. Nothing in
// this file writes into it.
process.env.CODE_ROI_OUT ??= mkdtempSync(join(tmpdir(), "code-roi-delivered-test-"));

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const V6_ARCHIVE = join(process.env.HOME ?? "", ".bastra", "eval", "code-roi-v4-bastra-io");

const {
  DEFAULT_REGISTRATION_ID,
  V6_ARM_IDS,
  armIdsOf,
  excludedPilotCommitsOf,
  loadRegistrationById,
  resolveRegistrationId,
} = await import("../code-roi/v2/registration.mjs");
const { ARMS } = await import("../code-roi/v2/run-arms-v3.mjs");
const { blockUse, blindSpotOf, blindSpotReport, judge } = await import(
  "../code-roi/v2/evaluate-delivered.mjs"
);
const { checkBuildPin, frozenSurfaceMismatches, frozenSurfaceOf, preflightBuild } = await import(
  "../code-roi/v2/build-pin.mjs"
);

const DELIVERED = loadRegistrationById("code-awareness-delivered");
const V6 = loadRegistrationById(DEFAULT_REGISTRATION_ID);

// ─── The registration decides ────────────────────────────────────

describe("the arms and the thresholds come from the registration", () => {
  test("the runner runs the arms the registration names, and defines every one of them", () => {
    assert.deepEqual(armIdsOf(DELIVERED, "code-awareness-delivered"), ["A", "D", "P"]);
    for (const id of armIdsOf(DELIVERED, "code-awareness-delivered")) {
      assert.ok(ARMS[id] !== undefined, `the runner defines arm ${id}`);
    }
  });

  test("the v6 arms are unchanged, and come from the same call", () => {
    assert.deepEqual(armIdsOf(V6), V6_ARM_IDS);
    assert.deepEqual(V6_ARM_IDS, ["A", "B", "prefilled"]);
  });

  test("a registration that lists no arms is refused rather than given a default", () => {
    assert.throws(
      () => armIdsOf({ arms: {} }, "some-other-registration"),
      /lists no arms\.ids/,
      "a measurement whose arms are not written down is a measurement the runner chose",
    );
  });

  test("each arm is the thing this registration claims it is", () => {
    // D: the block, and NOTHING else — no MCP server, no prefilled tool answer.
    assert.equal(ARMS.D.graph, false, "arm D attaches no MCP server: nothing had to be called");
    assert.equal(ARMS.D.prefill, false);
    assert.equal(ARMS.D.delivered, true);
    // A: the shared control, byte-identical to v6's.
    assert.equal(ARMS.A.graph, false);
    assert.equal(ARMS.A.delivered, false);
    assert.equal(ARMS.A.prefill, false);
    // P: the full tool answer, reported and never gated.
    assert.equal(ARMS.P.prefill, true);
    assert.equal(ARMS.P.graph, false);
    assert.equal(DELIVERED.arms.P.gated, false);
    assert.equal(DELIVERED.arms.D.gated, true);
  });

  test("the thresholds are exactly the ones decided on 2026-09-19", () => {
    assert.deepEqual(
      {
        context_cost_max_ratio: DELIVERED.thresholds.context_cost_max_ratio,
        context_ci_upper_max: DELIVERED.thresholds.context_ci_upper_max,
        block_use_min: DELIVERED.thresholds.block_use_min,
        precision_loss_max: DELIVERED.thresholds.precision_loss_max,
        recall_guard_ci_lower: DELIVERED.thresholds.recall_guard_ci_lower,
      },
      {
        context_cost_max_ratio: 0.97,
        context_ci_upper_max: 1.0,
        block_use_min: 0.5,
        precision_loss_max: 0.05,
        recall_guard_ci_lower: 0,
      },
    );
    assert.equal(DELIVERED.registration_version, 3);
    // The population has been mined, adjudicated and frozen, so the pending
    // state is gone. What must stay true is that the frozen population is
    // named rather than promised — `code-roi-population-freeze.test.ts` holds
    // both that and the gate the pending state used to trip.
    // #607: the run itself finished 2026-09-20 and `status` moved on again,
    // to the terminal `run_completed` (see `result` at the end of the
    // registration and BEFUND.md, "Zustellung v3 Endergebnis").
    assert.equal(DELIVERED.status, "run_completed");
    assert.equal(DELIVERED.sample.min_scenarios, 37);
    assert.equal(DELIVERED.sample.min_context_pairs, 37);
    assert.equal(DELIVERED.sample.min_use_blocks, 37);
    // The use minimum is the measured ceiling, not a number beside it: every
    // block the frozen product emits has to be observed. If the base rate is
    // ever re-measured, the minimum moves with it or the verdict is impossible
    // by construction again — the exact thing version 3 was amended to fix.
    assert.equal(DELIVERED.sample.min_use_blocks, DELIVERED.arms.D.delivered_block_base_rate.delivered);
    // Guard AND switch: `selectionSize` only keeps all 44 frozen scenarios
    // while the registration actually asks for it, so the flag belongs here
    // next to the floor it protects against.
    assert.equal(DELIVERED.sample.run_all_accepted, true);
    assert.equal(DELIVERED.statistics.seed, 20260918);
    assert.equal(DELIVERED.statistics.cluster_key, "connected component of shared repo + truth file");
    assert.equal(DELIVERED.statistics.population_clusters, 22);
    assert.equal(DELIVERED.run_conditions.cost_ceiling_usd, 40);
    assert.match(DELIVERED.run_conditions.build_pin.start_command, /^npm run build && /);
  });

  test("both verdicts carry the two guards, and neither guard is a verdict of its own", () => {
    assert.deepEqual(Object.keys(DELIVERED.verdicts).filter((k) => !k.startsWith("$")), [
      "context",
      "use",
    ]);
    for (const verdict of ["context", "use"]) {
      const criteria = DELIVERED.verdicts[verdict].criteria as string[];
      assert.ok(criteria.includes("precision_loss_max"), `${verdict} carries the precision guard`);
      assert.ok(criteria.includes("recall_guard_ci_lower"), `${verdict} carries the recall guard`);
    }
  });

  test("the pilot exclusion is this registration's, not the other one's", () => {
    const mine = excludedPilotCommitsOf(DELIVERED);
    assert.equal(mine.size, 2);
    assert.ok(mine.has("197f9b10f05ca24fa72a09daf98fcdb8d7ffef6c"));
    // Same two commits, and — unlike in registration 6 — the same repository,
    // so here the exclusion actually binds.
    assert.deepEqual([...mine].sort(), [...excludedPilotCommitsOf(V6)].sort());
    assert.equal(DELIVERED.sample.excluded_pilot.repository, "bastra-recall");
  });

  test("an archive without a scenario file is the registration it predates", () => {
    const empty = mkdtempSync(join(tmpdir(), "code-roi-empty-"));
    try {
      delete process.env.CODE_ROI_REGISTRATION;
      assert.equal(resolveRegistrationId(empty), DEFAULT_REGISTRATION_ID);
      writeFileSync(join(empty, "scenarios.json"), JSON.stringify({ registration: "x", scenarios: [] }));
      assert.equal(resolveRegistrationId(empty), "x", "the archive names its own registration");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ─── The frozen surface, and the pin ─────────────────────────────

describe("the build pin knows which registration it pinned", () => {
  test("the delivered frozen surface matches what dist emits", async (t) => {
    if (DELIVERED.status === "run_completed") {
      // #607: `no_further_changes` freezes the registration's OWN fields —
      // the reported numbers and the frozen hashes as a historical record of
      // what arm D was actually served. It does not freeze
      // `packages/daemon/src/code-graph` itself: development continues on
      // this very run's findings (BEFUND.md, "Zustellung v3 Endergebnis"),
      // starting with the default-off gate #607 asks for, which touches
      // `prompt-impact.ts` — one of the files this hash covers. The guard
      // that still has to hold is that no NEW arm can start under this id,
      // checked below via `preflightBuild`.
      t.skip("registration_version 3 is run_completed — dist is expected to move on from its pin");
      return;
    }
    const built = await frozenSurfaceOf(DELIVERED);
    assert.deepEqual(
      frozenSurfaceMismatches(built, DELIVERED),
      [],
      "run `npm run build` — arm D would otherwise be served a block this registration never froze",
    );
    // Every `*_sha256` field of the registration is checked, so a field added
    // to the registration cannot be silently ignored by the comparison.
    assert.ok(Object.keys(built).includes("block_template_sha256"));
    assert.ok(Object.keys(built).includes("code_graph_bundle_sha256"));
    assert.equal(Object.keys(built).length, 2);
  });

  test("#607: preflightBuild refuses a new arm once the registration is run_completed", async () => {
    assert.equal(DELIVERED.status, "run_completed", "this test only means something once the run is done");
    const verdict = await preflightBuild({ registrationId: "code-awareness-delivered", registration: DELIVERED });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "run_completed");
  });

  test("the v6 frozen surface still matches — a second registration changed nothing", async () => {
    assert.deepEqual(frozenSurfaceMismatches(await frozenSurfaceOf(V6), V6), []);
  });

  test("an archive resumed under another registration aborts", () => {
    const pin = {
      headSha: "a".repeat(40),
      distRevision: { revision: "a".repeat(40), dirty: false },
      frozenSurface: { x_sha256: "1" },
      artifactHashes: {},
      registrationId: "code-awareness-delivered",
      registrationVersion: 1,
    };
    assert.deepEqual(checkBuildPin(pin, pin), { ok: true, write: false, diff: [] });
    const other = { ...pin, registrationId: DEFAULT_REGISTRATION_ID };
    const verdict = checkBuildPin(pin, other);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.write, false, "a mismatch never re-pins itself");
    assert.equal(verdict.diff[0].field, "registrationId");
  });

  test("a pin written before the field existed is not a mismatch", () => {
    // The v6 archive's build-pin.json has no `registrationId`. Reading its
    // absence as a difference would abort every future helping of a finished
    // measurement.
    const recorded = {
      headSha: "b".repeat(40),
      distRevision: { revision: "b".repeat(40), dirty: false },
      frozenSurface: {},
      artifactHashes: {},
      registrationVersion: 6,
    };
    assert.equal(checkBuildPin(recorded, { ...recorded, registrationId: DEFAULT_REGISTRATION_ID }).ok, true);
  });
});

// ─── Arm D's block ───────────────────────────────────────────────

describe("arm D is rendered by the product's prompt lane", () => {
  const FILE_A = "packages/a/src/thing.ts";
  const FILE_B = "packages/b/src/user.ts";
  const FILE_C = "packages/c/src/consumer.ts";

  const THING_SOURCE = [
    "export function keep() {",
    "  return 1;",
    "}",
    "export function touched() {",
    "  return 2;",
    "}",
    "export function unrelated() {",
    "  return 3;",
    "}",
    "",
  ].join("\n");

  /** A parent -> commit diff, the shape a scenario's `diff` field carries. */
  const FORWARD_DIFF = [
    `diff --git a/${FILE_A} b/${FILE_A}`,
    "index 1111111..2222222 100644",
    `--- a/${FILE_A}`,
    `+++ b/${FILE_A}`,
    "@@ -5,1 +5,1 @@ export function touched() {",
    "-  return 2;",
    "+  return 99;",
  ].join("\n");

  const node = (id: string, label: string, file: string, line: number) => ({
    id,
    label,
    file_type: "code",
    source_file: file,
    source_location: `L${line}`,
    community: 0,
    _origin: "ast",
  });
  const edge = (source: string, target: string, relation: string) => ({
    source,
    target,
    relation,
    confidence: "EXTRACTED",
    confidence_score: 0.85,
    _origin: "ast",
  });

  const GRAPH = {
    directed: true,
    multigraph: false,
    graph: {},
    built_at_commit: "0".repeat(40),
    nodes: [
      node("a_keep", "keep()", FILE_A, 1),
      node("a_touched", "touched()", FILE_A, 4),
      node("a_unrelated", "unrelated()", FILE_A, 7),
      node("b_use", "useTouched()", FILE_B, 1),
      node("c_use", "useUnrelated()", FILE_C, 1),
    ],
    links: [edge("b_use", "a_touched", "calls"), edge("c_use", "a_unrelated", "calls")],
    hyperedges: [],
  };

  async function fixture() {
    const { graphDirOf, GRAPH_FILE_NAME } = await import("../../daemon/src/code-graph/reader.js");
    const tree = mkdtempSync(join(tmpdir(), "code-roi-delivered-tree-"));
    const graphRoot = mkdtempSync(join(tmpdir(), "code-roi-delivered-graph-"));
    for (const [path, body] of [
      [FILE_A, THING_SOURCE],
      [FILE_B, "export function useTouched() {\n  return 1;\n}\n"],
      [FILE_C, "export function useUnrelated() {\n  return 1;\n}\n"],
    ]) {
      mkdirSync(join(tree, path, ".."), { recursive: true });
      writeFileSync(join(tree, path), body);
    }
    mkdirSync(graphDirOf(graphRoot), { recursive: true });
    writeFileSync(join(graphDirOf(graphRoot), GRAPH_FILE_NAME), JSON.stringify(GRAPH));
    return { tree, graphRoot };
  }

  test("the registered question reaches the intent gate even when the diff exceeds its 4k scan cap", async () => {
    const { promptFor } = await import("../code-roi/v2/run-arms.mjs");
    const { changeImpactIntent } = await import("../../daemon/dist/code-graph/impact-intent.js");
    const prompt = promptFor({
      file: FILE_A,
      subject: "large change",
      diff: `--- a/${FILE_A}\n+++ b/${FILE_A}\n+${"x".repeat(6_000)}`,
    });
    const intent = changeImpactIntent(prompt);
    assert.equal(intent.asked, true);
    assert.ok(intent.paths.includes(FILE_A));
  });

  test("the block narrows to the symbol the prompt names, through the real intent gate", async () => {
    const { deliveredBlockFor, promptWithDeliveredBlock } = await import(
      "../code-roi/v2/delivered-block.mjs"
    );
    const { MAX_IMPACT_FILES } = await import("../../daemon/dist/code-graph/impact-block.js");
    const { tree, graphRoot } = await fixture();
    try {
      const task = `What breaks if I change \`touched\` in ${FILE_A}?`;
      const block = await deliveredBlockFor(
        { file: FILE_A, diff: FORWARD_DIFF },
        tree,
        graphRoot,
        task,
      );
      assert.ok(block !== null, "the graph indexes the file and something depends on it");
      assert.equal(block.basis, "symbols", "the prompt named the symbol inside the named file");
      assert.deepEqual(block.changedSymbols, ["touched"]);
      assert.deepEqual(
        block.listed,
        [FILE_B],
        "consumer.ts depends on unrelated(), which this diff does not touch — the whole point of narrowing",
      );
      assert.match(block.note, /You asked what a change here would affect/);
      assert.match(block.note, /^<code-impact file="packages\/a\/src\/thing\.ts" basis="symbols" files="1"/);
      assert.equal(block.displayCap, MAX_IMPACT_FILES);
      assert.equal(block.displayCap, DELIVERED.arms.frozen_surface.display_cap);

      // Delivered ahead of the question, and unannounced: the lane says nothing
      // about the block and neither may the harness.
      const prompt = promptWithDeliveredBlock(task, block);
      assert.ok(prompt.startsWith(block.note), "the block arrives before the question");
      assert.ok(prompt.endsWith(task));
      assert.equal(
        prompt.replace(block.note, "").trim(),
        task,
        "nothing is added around the block — an instruction here would measure an instruction the product does not give",
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(graphRoot, { recursive: true, force: true });
    }
  });

  test("a file-only impact question gets the prompt lane's honest whole-file answer", async () => {
    const { deliveredBlockFor } = await import("../code-roi/v2/delivered-block.mjs");
    const { tree, graphRoot } = await fixture();
    try {
      const block = await deliveredBlockFor(
        { file: FILE_A, diff: FORWARD_DIFF },
        tree,
        graphRoot,
        `What breaks if I change ${FILE_A}?`,
      );
      assert.ok(block !== null);
      assert.equal(block.basis, "whole_file");
      assert.deepEqual(block.listed.sort(), [FILE_B, FILE_C]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(graphRoot, { recursive: true, force: true });
    }
  });

  test("a candidate the graph knows no line for is still a file the block PRINTED", async () => {
    const { listedFilesOf } = await import("../code-roi/v2/delivered-block.mjs");
    const { displayOrder, renderImpactBlock } = await import(
      "../../daemon/dist/code-graph/impact-block.js"
    );
    // A PACKAGE_IMPORT hit is `location: importer` — no `:line` (affected.ts),
    // and so is any symbol the graph has no line for. Reading the block with a
    // pattern that demands `:\d+` dropped exactly those, and a block made of
    // nothing else parsed as an empty list, which `blockUse` scores as "no
    // block was delivered" rather than as a block nobody used.
    const hits = [
      { file: FILE_B, location: `${FILE_B}:12`, via: "touched", relation: "calls", depth: 1 },
      { file: FILE_C, location: FILE_C, via: "@bastra-recall/core", relation: "imports the package", depth: 1 },
    ];
    const note = renderImpactBlock({
      file: FILE_A,
      basis: "symbols",
      changed: ["touched"],
      hits: displayOrder(hits),
      total: hits.length,
      stale: false,
      lead: "L.",
    });
    assert.deepEqual(listedFilesOf(note), [FILE_B, FILE_C]);

    const packageOnly = renderImpactBlock({
      file: FILE_A,
      basis: "whole_file",
      changed: [],
      hits: [hits[1]],
      total: 1,
      stale: false,
      lead: "L.",
    });
    assert.deepEqual(listedFilesOf(packageOnly), [FILE_C]);
    assert.equal(blockUse(listedFilesOf(packageOnly), [FILE_C]), 1);
  });

  test("the trailing lines of the block are not read as candidates", async () => {
    const { listedFilesOf } = await import("../code-roi/v2/delivered-block.mjs");
    const { renderImpactBlock } = await import("../../daemon/dist/code-graph/impact-block.js");
    // The "… and N more" line, the staleness sentence and the closing caveat
    // all live in the same body; only the candidate lines may be read out of it.
    const note = renderImpactBlock({
      file: FILE_A,
      basis: "symbols",
      changed: ["touched"],
      hits: [{ file: FILE_B, location: `${FILE_B}:12`, via: "touched", relation: "calls", depth: 1 }],
      total: 7,
      stale: true,
      lead: "L.",
    });
    assert.deepEqual(listedFilesOf(note), [FILE_B]);
  });

  test("the kill switch aborts arm D instead of being measured as product silence", async () => {
    const { deliveredBlockFor } = await import("../code-roi/v2/delivered-block.mjs");
    const { tree, graphRoot } = await fixture();
    const before = process.env.BASTRA_CODE_AWARENESS;
    process.env.BASTRA_CODE_AWARENESS = "off";
    try {
      await assert.rejects(
        () =>
          deliveredBlockFor(
            { file: FILE_A, diff: FORWARD_DIFF },
            tree,
            graphRoot,
            `What breaks if I change \`touched\` in ${FILE_A}?`,
          ),
        /BASTRA_CODE_AWARENESS=off/,
      );
    } finally {
      if (before === undefined) delete process.env.BASTRA_CODE_AWARENESS;
      else process.env.BASTRA_CODE_AWARENESS = before;
      rmSync(tree, { recursive: true, force: true });
      rmSync(graphRoot, { recursive: true, force: true });
    }
  });

  test("a file the graph does not index is silence, not an empty block", async () => {
    const { deliveredBlockFor, promptWithDeliveredBlock } = await import(
      "../code-roi/v2/delivered-block.mjs"
    );
    const { tree, graphRoot } = await fixture();
    try {
      const block = await deliveredBlockFor(
        { file: "packages/z/src/unknown.ts", diff: FORWARD_DIFF },
        tree,
        graphRoot,
        "What breaks if I change packages/z/src/unknown.ts?",
      );
      assert.equal(block, null, "the product is silent here, so the arm gets the bare prompt");
      assert.equal(promptWithDeliveredBlock("THE TASK", null), "THE TASK");
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(graphRoot, { recursive: true, force: true });
    }
  });
});

// ─── The scorer ──────────────────────────────────────────────────

describe("block use is measured against what the block PRINTED", () => {
  test("one used candidate makes this scenario used", () => {
    assert.equal(blockUse(["a.ts", "b.ts", "c.ts", "d.ts"], ["a.ts"]), 1);
    assert.equal(blockUse(["a.ts"], ["a.ts"]), 1);
    assert.equal(blockUse(["a.ts", "b.ts"], ["x.ts"]), 0);
  });

  test("a file the answer named that the block never printed does not count", () => {
    assert.equal(
      blockUse(["a.ts"], ["a.ts", "b.ts", "c.ts"]),
      1,
      "the denominator is the block, not the answer — this measures use of the block",
    );
  });

  test("no block is null, never 0 — silence is not an ignored block", () => {
    assert.equal(blockUse([], ["a.ts"]), null);
    assert.equal(blockUse(undefined, ["a.ts"]), null);
  });
});

describe("the blind-spot split is per scenario, and says when it cannot be", () => {
  test("a scenario all of whose broken tests are blind spots is wholly one", () => {
    const s = {
      truth: ["t1.test.ts", "t2.test.ts"],
      blindSpotTests: ["t1.test.ts", "t2.test.ts"],
    };
    assert.deepEqual(blindSpotOf(s), {
      isBlindSpot: true,
      partial: false,
      blindTests: 2,
      blindTruth: ["t1.test.ts", "t2.test.ts"],
      reachableTruth: [],
    });
  });

  test("a mixed scenario is partitioned exactly under tests/v2", () => {
    const s = { truth: ["t1.test.ts", "t2.test.ts"], blindSpotTests: ["t1.test.ts"] };
    assert.deepEqual(blindSpotOf(s), {
      isBlindSpot: true,
      partial: true,
      blindTests: 1,
      blindTruth: ["t1.test.ts"],
      reachableTruth: ["t2.test.ts"],
    });
  });

  test("no blind spots at all", () => {
    assert.deepEqual(blindSpotOf({ truth: ["t.test.ts"] }), {
      isBlindSpot: false,
      partial: false,
      blindTests: 0,
      blindTruth: [],
      reachableTruth: ["t.test.ts"],
    });
  });

  test("recall is reported for both halves and gated in neither", () => {
    const reachable = (id: string) => ({
      id, repo: null, file: `${id}.ts`, blindSpot: false, blindSpotPartial: false,
      blindTruthFiles: [], reachableTruthFiles: ["r.test.ts"],
      A: { named: ["r.test.ts"], recall: 1, precision: 1 },
      D: { named: ["r.test.ts"], recall: 1, precision: 1 },
    });
    const blind = {
      id: "S3", repo: null, file: "S3.ts", blindSpot: true, blindSpotPartial: false,
      blindTruthFiles: ["b1.test.ts", "b2.test.ts"], reachableTruthFiles: [],
      A: { named: ["b1.test.ts"], recall: 0.5, precision: 1 },
      D: { named: [], recall: 0, precision: 1 },
    };
    const report = blindSpotReport(
      [reachable("S1"), reachable("S2"), blind],
      ["A", "D"],
    );
    assert.deepEqual(report.blindSpotScenarios, ["S3"]);
    assert.equal(report.graphReachableScenarios, 2);
    assert.deepEqual(report.partialBlindSpotScenarios, []);
    assert.equal(report.recall.A.graphReachable, 1);
    assert.equal(report.recall.A.blindSpot, 0.5);
    assert.equal(report.recall.D.blindSpot, 0);
  });
});

describe("the two verdicts, decided by the registered numbers", () => {
  /** n rows, all identical but for what the test moves. */
  function rows(n: number, over: Partial<Record<string, number>> = {}) {
    const {
      aRecall = 1,
      dRecall = 1,
      aPrecision = 0.8,
      dPrecision = 0.8,
      aTokens = 24_000,
      dTokens = 22_000,
      use = 1,
    } = over as Record<string, number>;
    return Array.from({ length: n }, (_, i) => ({
      id: `S${i}`,
      repo: null,
      file: `f${i}.ts`,
      blockUse: use,
      A: { recall: aRecall, precision: aPrecision, inputTokens: aTokens + i },
      D: { recall: dRecall, precision: dPrecision, inputTokens: dTokens + i },
    }));
  }

  test("a run that clears every threshold passes BOTH verdicts", () => {
    const v = judge(rows(45), DELIVERED);
    assert.equal(v.context.status, "pass");
    assert.equal(v.use.status, "pass");
  });

  test("a context ratio above 0.97 fails context and leaves use alone", () => {
    const v = judge(rows(45, { dTokens: 23_800 }), DELIVERED);
    assert.equal(v.context.status, "fail");
    assert.equal(v.context.checks.context_ratio.pass, false);
    assert.equal(v.use.status, "pass", "the block was still used; that is a different finding");
  });

  test("an interval that touches 1.0 fails context even with a mean saving", () => {
    // Half the scenarios cheap, half expensive: the point estimate clears 0.97
    // while the interval reaches over 1.0. This is the check that separates a
    // repeatable saving from sampling noise.
    const mixed = rows(45).map((r, i) => ({
      ...r,
      D: { ...r.D, inputTokens: i % 2 === 0 ? 8_000 : 40_000 },
    }));
    const v = judge(mixed, DELIVERED);
    assert.ok(v.context.ci.hi >= 1.0, `expected an interval reaching 1.0, got ${v.context.ci.hi}`);
    assert.equal(v.context.checks.context_ci_upper.pass, false);
    assert.equal(v.context.status, "fail");
  });

  test("an ignored block fails USE while the saving stands", () => {
    const v = judge(rows(45, { use: 0 }), DELIVERED);
    assert.equal(v.use.status, "fail");
    assert.equal(v.context.status, "pass", "cheap and ignored is a cheaper run, not a working feature");
  });

  test("a saving bought with precision fails BOTH — the guard is in both verdicts", () => {
    const v = judge(rows(45, { dPrecision: 0.7 }), DELIVERED);
    assert.equal(v.context.checks.precision.pass, false);
    assert.equal(v.context.status, "fail");
    assert.equal(v.use.status, "fail");
  });

  test("a saving bought with recall fails BOTH", () => {
    const v = judge(rows(45, { dRecall: 0.8 }), DELIVERED);
    assert.equal(v.context.checks.recall.pass, false);
    assert.equal(v.context.status, "fail");
    assert.equal(v.use.status, "fail");
    assert.ok(v.recallCi.lo < 0);
  });

  test("equal recall passes the guard: it forbids a loss, it does not ask for a gain", () => {
    const v = judge(rows(45), DELIVERED);
    assert.equal(v.context.checks.recall.value, 0);
    assert.equal(v.context.checks.recall.pass, true);
  });

  test("too few scenarios makes both verdicts underpowered, not a judgement", () => {
    const v = judge(rows(12), DELIVERED);
    assert.equal(v.context.status, "underpowered");
    assert.equal(v.use.status, "underpowered");
  });

  test("the exhausted population's reachable floor is 37 observations", () => {
    const v = judge(rows(37), DELIVERED);
    assert.equal(v.context.status, "pass");
    assert.equal(v.use.status, "pass");
  });

  test("an empty run is not_evaluable", () => {
    const v = judge([], DELIVERED);
    assert.equal(v.context.status, "not_evaluable");
    assert.equal(v.use.status, "not_evaluable");
  });

  test("the context ratio is gated on the scenarios BOTH arms solved", () => {
    // One arm wrong and cheap: it must not be allowed to win the ratio.
    const mixed = rows(45).map((r, i) =>
      i < 20 ? { ...r, D: { ...r.D, recall: 0.2, inputTokens: 100 } } : r,
    );
    const v = judge(mixed, DELIVERED);
    assert.equal(v.context.bothSolved, 25);
    assert.ok(v.context.checks.context_ratio.value > 0.5, "the cheap wrong answers are excluded");
    assert.equal(v.context.status, "underpowered", "25 solved pairs cannot satisfy a 37-pair minimum");
  });

  test("the use verdict needs the registered number of delivered blocks", () => {
    const sparse = rows(45).map((r, i) => ({ ...r, blockUse: i === 0 ? 1 : null }));
    const v = judge(sparse, DELIVERED);
    assert.equal(v.use.scenariosWithBlock, 1);
    assert.equal(v.use.status, "underpowered", "one used block among 45 scenarios is not a use result");
  });
});

// ─── The v6 archive still scores the same ────────────────────────

describe("the finished v6 measurement is unaffected", () => {
  const stored = existsSync(join(V6_ARCHIVE, "report.json"))
    ? JSON.parse(readFileSync(join(V6_ARCHIVE, "report.json"), "utf8"))
    : null;

  test("its scorer reproduces its report from its archive", { skip: stored === null && "no v6 archive on this machine" }, () => {
    // Scored through a directory of SYMLINKS, never the archive itself: the
    // scorer writes report.json where it is pointed and the record on disk is
    // the thing being compared against. The last path segment is the archive's
    // own name because `treeDirOf` derives the tree root from it, and an answer
    // carrying an absolute tree path is normalised against that.
    const box = mkdtempSync(join(tmpdir(), "code-roi-v6-replay-"));
    const out = join(box, "code-roi-v4-bastra-io");
    try {
      mkdirSync(out);
      for (const entry of ["scenarios.json", "runs", "build-pin.json"]) {
        symlinkSync(join(V6_ARCHIVE, entry), join(out, entry));
      }
      execFileSync(
        "npx",
        ["tsx", "packages/eval/code-roi/v2/evaluate-v4.mjs"],
        { cwd: REPO_ROOT, env: { ...process.env, CODE_ROI_OUT: out }, encoding: "utf8", stdio: "pipe" },
      );
      const replayed = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
      assert.deepEqual(replayed.verdicts, stored.verdicts, "adoption pass, effect fail — unchanged");
      assert.equal(replayed.n, stored.n);
      assert.deepEqual(replayed.means, stored.means);
      assert.deepEqual(replayed.checks, stored.checks);
      assert.deepEqual(replayed.effect, stored.effect);
      assert.deepEqual(replayed.adoption, stored.adoption);
      assert.deepEqual(replayed.notGated, stored.notGated);
      assert.deepEqual(replayed.byRepo, stored.byRepo);
      assert.equal(replayed.cost.usd, stored.cost.usd);
      assert.equal(
        replayed.mixed_builds.mixed_builds,
        false,
        "adding registrationId outside the pin signature left every transcript's stamp intact",
      );
      assert.equal(replayed.build_pin.signature, stored.build_pin.signature);
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  test("its scenario file still names arms the runner knows", { skip: stored === null && "no v6 archive on this machine" }, () => {
    const { arms, registration } = JSON.parse(readFileSync(join(V6_ARCHIVE, "scenarios.json"), "utf8"));
    assert.deepEqual(arms, V6_ARM_IDS);
    assert.equal(registration, undefined, "v6's scenario file predates the field and must not need it");
    assert.equal(resolveRegistrationId(V6_ARCHIVE), DEFAULT_REGISTRATION_ID);
  });
});
