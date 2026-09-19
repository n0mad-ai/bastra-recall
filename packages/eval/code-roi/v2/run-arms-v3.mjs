/**
 * Arm runner for the change-impact measurement, registration v4 (#582).
 *
 * v3 answered one question and raised another. It measured `find_code` offered
 * against no tool at all and found the agent never called it (0 of 44 runs), so
 * the comparison was two runs of the same grep behaviour. Two things were
 * confounded there and this runner separates them:
 *
 *   A          grep      no MCP server at all — text search and reads only
 *   B          offered   `find_code` + `find_affected_files` offered, nothing
 *                        else changed. Whether the agent CALLS them is the
 *                        observation.
 *   prefilled            arm A's setup — NO MCP server either — plus the
 *                        `find_affected_files` answer for the planned change
 *                        already in the prompt. It carries the answer, not the
 *                        tools: with the server attached as well, a gain could
 *                        not be told apart from arm B's (#582 review).
 *
 * The third arm is called `prefilled`, not `forced`: the information is
 * guaranteed to have been SHOWN, and nothing makes the agent use it. Whether
 * it does is part of what the arm measures, and a name that claims otherwise
 * would be read into the result.
 *
 * ADOPTION is read off B alone (tool calls per scenario). EFFECT is prefilled
 * against A. B against A measures the two together and is not the effect
 * question — reporting it as one is what made v3 unreadable.
 *
 * Everything else is v2's setup, deliberately unchanged: the scenario tree is
 * a `git archive` of the commit's parent (no `.git`, so no arm can read the
 * historical commit), the graph is built from that tree and moved out of it,
 * and every transcript is kept for re-scoring.
 *
 * FRESH SCENARIOS ARE REQUIRED. The 44 scenarios of v3 were used to develop
 * the query this runner measures; a number from them is a training number.
 * Mine a new sample into a new output directory first:
 *
 *   CODE_ROI_OUT=~/.bastra/eval/code-roi-v4 node mine.mjs --since <the v3 range_end>
 *   CODE_ROI_OUT=~/.bastra/eval/code-roi-v4 node evidence.mjs
 *   CODE_ROI_OUT=~/.bastra/eval/code-roi-v4 node select.mjs
 *   # adjudicate by hand, THEN register thresholds, THEN run this
 *
 * A COST CEILING IS ENFORCED, not documented: the registration caps the main
 * run, and every arm's cost is added up — the aborted ones too, from their own
 * `result` event where there is one and from an estimate where there is not.
 * The next arm only starts while the ceiling is still out of reach at the mean
 * cost of the arms that FINISHED; otherwise the run stops and says how far it
 * got. The accounting lives in `arm-cost.mjs`.
 *
 * A BUILD PREFLIGHT RUNS FIRST, every invocation (#582, Codex counter-review
 * 4): `dist/.build-revision` must name HEAD, the tracked build inputs must be
 * clean, and the four `arms.frozen_surface` hashes must match the
 * registration when recomputed from `dist` — a helping that fails any of
 * these stops before touching an arm. What passes is then pinned into
 * `build-pin.json` in the archive on the first helping and checked on every
 * later one; a mismatch aborts with the differing fields, never a silent
 * re-pin. See `build-pin.mjs`.
 *
 * Usage: npm run build && CODE_ROI_OUT=… node run-arms-v3.mjs [--only S01,S02] [--arms A,B,prefilled]
 *        CODE_ROI_OUT=… node run-arms-v3.mjs --preflight-only   (checks only, starts no arm)
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildGraph, promptFor } from "./run-arms.mjs";
import { execFileSync } from "node:child_process";
import { scenarioRoot } from "./scenario-root.mjs";
import { writableOut } from "./archive.mjs";
import { ARM_IDS } from "./select.mjs";
import { DEFAULT_REGISTRATION_ID, armIdsOf, resolveRegistration } from "./registration.mjs";
import { deliveredBlockFor, promptWithDeliveredBlock } from "./delivered-block.mjs";
import { diffForTree } from "./diff-side.mjs";
import {
  buildPinPath,
  checkBuildPin,
  formatBuildPinDiff,
  pinSignature,
  preflightBuild,
  readBuildPin,
} from "./build-pin.mjs";
import {
  abortedArmCharge,
  armCostUsd,
  armEstimateUsdOf,
  costCeilingUsdOf,
  finalisable,
  nextArmEstimateUsd,
  resultEventOf,
  spendOnDisk,
  successfulResult,
  withinCeiling,
} from "./arm-cost.mjs";
import { ALL_TOOL_DEFS } from "../../../daemon/dist/tool-defs.js";

const OUT = writableOut();
/** This repository — the one `prepareTree` from the v2 runner knows. */
const REPO_SELF = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const RUNS = join(OUT, "runs");
const MCP_SERVER = new URL("./code-tools-mcp.mjs", import.meta.url).pathname;
const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;

// From the registration — not tunable here.
const ARM_TIMEOUT_MS = 20 * 60_000;
/**
 * The built-in tools every arm gets — Read, Grep, Glob and nothing that runs a
 * command.
 *
 * Bash used to be allow-listed for grep/find/cat/sed. That was the leak the
 * review found: `--allowedTools "Bash(cat:*)"` bounds the COMMAND, not the
 * path, so `cat ../../scenarios.json` was one call away from the truth file,
 * the prefilled block and every earlier transcript. Grep and Glob still answer
 * the text-search half of the task, and `--restricted` confines them to the
 * working directory.
 */
const ALLOWED_TOOLS = ["Read", "Grep", "Glob"];
/**
 * The MCP tools arm B may call: the product's whole surface, not just the two
 * code ones. The instructions the arm is given ask for `recall` first, so an
 * allow-list without it would deny the very call the product asks for.
 */
export const GRAPH_TOOLS = ALL_TOOL_DEFS.map((d) => `mcp__code__${d.name}`);
const DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit", "Agent", "Workflow", "Skill", "WebFetch", "WebSearch"];

/**
 * The CATALOGUE of arms this runner can serve, and what each one changes.
 * `graph` = the MCP server is attached.
 *
 * WHICH of them a run uses is the registration's decision, not this file's:
 * `armIdsOf()` reads `arms.ids` off the archive's registration and the runner
 * refuses an id that is not in here. An arm defined and never registered runs
 * never; an arm registered and not defined aborts loudly, which is the failure
 * #582 made impossible in one direction and #606 closes in the other.
 */
export const ARMS = {
  A: { id: "A", name: "grep", graph: false, prefill: false, delivered: false },
  B: { id: "B", name: "offered", graph: true, prefill: false, delivered: false },
  // NO MCP server, no instructions: the prefilled arm is the ANSWER handed
  // over, nothing else. With the server attached it also carried the product
  // surface, and a gain could not be told apart from arm B's (#582 review).
  prefilled: { id: "prefilled", name: "prefilled", graph: false, prefill: true, delivered: false },
  // #606. The product's own UserPromptSubmit block, rendered from `dist` and
  // put where that lane puts it: before the first search, unannounced, capped
  // at `MAX_IMPACT_FILES`. No MCP server — the whole point of this arm is that
  // nothing had to be called for the answer to arrive.
  D: { id: "D", name: "delivered", graph: false, prefill: false, delivered: true },
  // #606, reported and never gated: the FULL `find_affected_files` answer in
  // the prompt, byte-identically the `prefilled` arm of registration 6. It is
  // what separates "the block is too small" from "the answer does not help" —
  // without it a failing D says only that D failed.
  P: { id: "P", name: "prefilled_full", graph: false, prefill: true, delivered: false },
};

/**
 * The prefilled arm's block: the product's own `find_affected_files` answer for
 * exactly the planned change, rendered as the agent would have received it.
 *
 * The symbols come from the scenario's diff through the product's
 * `changedSymbolsOf`, not from a hand-written list — the agent in arm B has
 * the same diff in its prompt, so both graph arms start from the same
 * information.
 *
 * THE DIFF IS TURNED AROUND FIRST (`diff-side.mjs`). The tree is the PARENT
 * commit and `s.diff` runs parent → commit, so the tree is the diff's old side
 * while `changedLines` reads the new one. Reversing it makes the parent the new
 * side, which is the tree that is actually there.
 */
async function prefillFor(s, tree, graphRoot) {
  const { loadGraph } = await import(`${DIST}reader.js`);
  const { changedSymbolsOf } = await import(`${DIST}affected.js`);
  const { findAffectedFiles } = await import(`${DIST}find-affected-files.js`);
  const { CodeGraphCache } = await import(`${DIST}cache.js`);
  const repo = scenarioRoot(tree, graphRoot);
  const loaded = await loadGraph(repo);
  if (!loaded.ok) throw new Error(`prefill: graph ${loaded.reason}`);
  const symbols = changedSymbolsOf(loaded.graph, s.file, diffForTree(s.diff, "old")).map((c) => c.name);
  const cache = new CodeGraphCache();
  await cache.ensureLoaded(repo);
  const result = await findAffectedFiles(cache, { file: s.file, symbols, repo });
  return { symbols, result };
}

function promptWithPrefill(s, prefill) {
  return [
    promptFor(s),
    "",
    "A code-graph tool was already run for this change. Its answer:",
    "",
    "```json",
    JSON.stringify(prefill.result, null, 2),
    "```",
    "",
    "Treat it as candidates, not as the answer: verify before you rely on it, " +
      "and add anything it missed.",
  ].join("\n");
}

/**
 * Run one arm and put what it cost on disk, finished or not.
 *
 * `spend` is what the run has measured SO FAR on arms that finished — the basis
 * for charging an abort that reported nothing. It is read here rather than
 * afterwards because an abort's cost has to be written down at the moment it
 * happens: its transcript is renamed out of the way and never read again, so
 * the `.failed…meta.json` beside it is the only record a later helping has.
 *
 * `buildPinSignature` is written into the meta beside it regardless of
 * outcome, finished or aborted: `evaluate-v4.mjs` reads it back off every
 * meta in the archive to report `mixed_builds` when a stretched run's
 * helpings were not all served by the pinned build.
 */
function runArm(
  arm,
  prompt,
  tree,
  graphRoot,
  dir,
  budgetUsd,
  spend,
  buildPinSignature,
  model,
  maxTurns,
  registeredEstimateUsd,
) {
  const transcript = join(dir, `${arm.id}.jsonl`);
  const mcpConfig = join(dir, `${arm.id}-mcp.json`);
  const servers = arm.graph
    ? { code: { command: process.execPath, args: [MCP_SERVER, tree, graphRoot] } }
    : {};
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }));
  const allowed = arm.graph ? [...ALLOWED_TOOLS, ...GRAPH_TOOLS] : ALLOWED_TOOLS;
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--max-turns",
    String(maxTurns),
    // The isolation, in four flags that were verified against `claude --help`:
    // `--restricted` drops every command-running tool and CONFINES the file
    // tools to the working directory, `--tools` names the three that remain,
    // `--permission-prompts none` denies anything that would ask instead of
    // waiting, and `--max-budget-usd` stops a runaway arm at what is left of
    // the ceiling.
    "--restricted",
    "--tools",
    ALLOWED_TOOLS.join(","),
    "--permission-prompts",
    "none",
    "--max-budget-usd",
    budgetUsd.toFixed(2),
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ...allowed,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
  ];
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const out = createWriteStream(`${transcript}.partial`);
    const child = spawn("claude", args, { cwd: tree, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out);
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, ARM_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end(() => {
        // FINALISATION IS EARNED, NOT AUTOMATIC (#582 review). The rename used
        // to happen unconditionally, so a timed-out, budget-stopped or crashed
        // arm became a `.jsonl` like any other: `scenarioComplete` counted it,
        // the next helping never re-ran it, the scorer read no `FILES:` line
        // and recorded recall 0, and `armCostUsd` found no `result` and
        // recorded $0. An aborted arm that scores as a cheap failure is the
        // worst possible shape for a measurement to fail in.
        const body = readFileSync(`${transcript}.partial`, "utf8");
        const finished = finalisable(code, body);
        const stamp = Date.now();
        const kept = finished ? transcript : `${transcript}.failed-${stamp}`;
        renameSync(`${transcript}.partial`, kept);
        const result = resultEventOf(body);
        const charge = finished
          ? { usd: armCostUsd(body), source: "result_event" }
          : abortedArmCharge(body, spend.finishedCostUsd, spend.finishedArms, registeredEstimateUsd);
        writeFileSync(
          // The meta of an abort carries the same stamp as its transcript. A
          // fixed `<arm>.failed.meta.json` was overwritten by the next attempt,
          // and with it the only record of what the first one burned.
          join(dir, finished ? `${arm.id}.meta.json` : `${arm.id}.failed-${stamp}.meta.json`),
          JSON.stringify(
            {
              arm: arm.id,
              name: arm.name,
              // Which build this attempt ran under, finished or not — read
              // back by `evaluate-v4.mjs` to report `mixed_builds` (#582
              // preflight).
              buildPin: buildPinSignature,
              exitCode: code,
              finished,
              ...(finished
                ? {}
                : {
                    reason: timedOut
                      ? "timeout"
                      : result !== null
                        ? `result_${result.subtype ?? "unknown"}`
                        : code === 0
                          ? "no_result_event"
                          : `exit_${code}`,
                  }),
              // What this attempt is charged against the ceiling, and where the
              // number came from. `registered_estimate` and
              // `mean_of_finished_arms` are estimates and say so; only
              // `result_event` is measured.
              chargedUsd: charge.usd,
              chargedFrom: charge.source,
              transcript: kept.split("/").slice(-1)[0],
              wallMs: Date.now() - startedAt,
              stderr: stderr.slice(-4000),
            },
            null,
            2,
          ),
        );
        resolve({ code, finished, charge });
      });
    });
  });
}

/**
 * Where a scenario's working tree lives — OUTSIDE the archive (#582 review).
 *
 * It used to sit at `runs/<id>/tree`, three levels under `scenarios.json`
 * (the truth), `prefill.json` (the graph's answer) and every earlier
 * transcript. Even confined to its working directory, an agent that walked up
 * from there would find the answer sheet. So the tree gets its own root under
 * the system temp directory, whose parents hold nothing but other trees, and
 * the archive keeps the graph and the results where no arm can reach them.
 *
 * The path is derived, not random, so a helping that resumes finds the tree a
 * previous helping extracted instead of rebuilding it.
 */
export function treeDirOf(s, outDir = OUT) {
  const archive = outDir.split("/").filter(Boolean).slice(-1)[0] ?? "code-roi";
  return join(tmpdir(), "code-roi-trees", archive, s.id, "tree");
}

/**
 * Is every arm of this scenario already on disk? A scenario is only "done"
 * when the whole triple is: the effect is measured PAIRED, so half a scenario
 * carries no result (#582).
 */
export function scenarioComplete(dir, armIds = ARM_IDS) {
  return armIds.every((arm) => armFinished(dir, arm));
}

/**
 * Is this arm's transcript a FINISHED arm?
 *
 * The file's existence is not enough: a transcript written by an older runner,
 * or copied in, may be an abort that was renamed anyway. So the SUCCESSFUL
 * terminal `result` event is checked on disk — the same rule the runner applies
 * when it decides whether to finalise at all, so a resumed run and a fresh one
 * agree, and a budget-stopped arm is re-run instead of scored.
 */
export function armFinished(dir, armId) {
  const path = join(dir, `${armId}.jsonl`);
  if (!existsSync(path)) return false;
  return successfulResult(readFileSync(path, "utf8"));
}

/**
 * How many not-yet-complete scenarios this invocation may start.
 *
 * The run is stretched over several subscription windows, so it is taken in
 * helpings. The budget counts SCENARIOS, not arms, and a scenario that gets
 * started is finished — all three arms — before the helping ends: an
 * unfinished triple would leave a scenario that the effect cannot use and
 * that the next helping would have to recognise and complete anyway.
 */
export function helpingSize() {
  const fromArg = (() => {
    const i = process.argv.indexOf("--max-scenarios");
    return i > 0 ? process.argv[i + 1] : null;
  })();
  const raw = fromArg ?? process.env.CODE_ROI_MAX_SCENARIOS ?? "";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

/**
 * The scenario's tree, from the repository the scenario names.
 *
 * Read-only, `git archive` only, and never a git worktree in a repository this
 * measurement does not own. The v2 runner's `prepareTree` is not used any
 * more: it archived from bastra-recall only, and it put the tree inside the
 * archive.
 */
export function prepareTreeOf(s, dir) {
  const tree = treeDirOf(s);
  const graphRoot = join(dir, "graph");
  if (existsSync(join(graphRoot, "graphify-out", "graph.json")) && existsSync(tree)) {
    return { tree, graphRoot };
  }
  mkdirSync(tree, { recursive: true });
  mkdirSync(graphRoot, { recursive: true });
  const tar = execFileSync("git", ["archive", "--format=tar", s.parent], {
    cwd: s.repo ?? REPO_SELF,
    maxBuffer: 1024 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", tree], { input: tar, maxBuffer: 1024 * 1024 * 1024 });
  // No project settings may reach the agent — the registration says so.
  rmSync(join(tree, ".claude"), { recursive: true, force: true });
  const link = firstSymlink(tree);
  if (link !== null) {
    throw new Error(
      `${s.id}: the extracted tree contains a symbolic link (${relative(tree, link)}). ` +
        `The isolation argument rests on the agent's file tools being confined to this ` +
        `directory, and a link is a hole in that whose far side nobody checked. Refusing ` +
        `to run rather than following it silently.`,
    );
  }
  return { tree, graphRoot };
}

/**
 * The first symbolic link anywhere under `dir`, or null.
 *
 * `git archive` reproduces a repository's symlinks, and `--restricted` bounds
 * the agent's file tools by PATH, not by what a path resolves to. A committed
 * `node_modules` link, or a fixture pointing at an absolute path, would let an
 * arm read outside the tree without breaking any rule the runner states. Found
 * by a review; no scenario in either sample has one, which is why it had never
 * shown up (#582).
 */
export function firstSymlink(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) return full;
    if (entry.isDirectory()) {
      const deeper = firstSymlink(full);
      if (deeper !== null) return deeper;
    }
  }
  return null;
}

async function main() {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? process.argv[i + 1] : null;
  };
  const only = arg("--only") ? new Set(arg("--only").split(",")) : null;
  // WHICH REGISTRATION THIS ARCHIVE IS (#606) — off the archive's own scenario
  // file, before anything else, because it decides the arms AND what the
  // preflight checks as the frozen surface.
  const { id: registrationId, registration } = resolveRegistration(OUT);
  const registeredArms = armIdsOf(registration, registrationId);
  const model = registration?.arms?.model;
  const maxTurns = Number(registration?.arms?.max_turns);
  if (typeof model !== "string" || model.length === 0 || !Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new Error(`${registrationId}: arms.model and a positive integer arms.max_turns are required`);
  }
  const costCeilingUsd = costCeilingUsdOf(registration);
  const registeredEstimateUsd = armEstimateUsdOf(registration);
  const wantedIds = (arg("--arms") ?? registeredArms.join(",")).split(",").map((a) => a.trim());
  for (const id of wantedIds) {
    if (ARMS[id] === undefined) {
      throw new Error(
        `unknown arm "${id}" — this runner defines ${Object.keys(ARMS).join(", ")} and ` +
          `${registrationId} registers ${registeredArms.join(", ")}`,
      );
    }
    if (!registeredArms.includes(id)) {
      throw new Error(
        `arm "${id}" is not registered by ${registrationId} (${registeredArms.join(", ")}) — ` +
          `an arm the registration does not name is an arm nobody decided to run`,
      );
    }
  }

  // THE PREFLIGHT, before anything else touches the archive or spends a
  // dollar (#582, Codex counter-review 4). Checked before `scenarios.json` is
  // even read, so `--preflight-only` works against an archive that has not
  // been started yet.
  const preflight = await preflightBuild({ registrationId, registration });
  if (!preflight.ok) {
    process.stdout.write(`preflight failed (${preflight.reason}): ${preflight.message}\n`);
    process.exitCode = 1;
    return;
  }
  const preflightOnly = process.argv.includes("--preflight-only");
  let scenarioFile = null;
  if (!preflightOnly) {
    scenarioFile = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
    if (
      registrationId !== DEFAULT_REGISTRATION_ID &&
      scenarioFile.registration_version !== registration.registration_version
    ) {
      process.stdout.write(
        `preflight failed (scenario_registration_drift): scenarios.json is registration version ` +
          `${scenarioFile.registration_version ?? "missing"}, but ${registrationId} is version ` +
          `${registration.registration_version} — re-mine/select; never relabel an old population.\n`,
      );
      process.exitCode = 1;
      return;
    }
    const wrongTruth =
      registrationId === DEFAULT_REGISTRATION_ID
        ? []
        : (scenarioFile.scenarios ?? []).filter(
            (s) => s.truthRule !== undefined && s.truthRule !== registration.unit_and_truth?.truth_rule,
          );
    if (wrongTruth.length > 0) {
      process.stdout.write(
        `preflight failed (scenario_truth_drift): ${wrongTruth.length} scenarios carry a truth rule ` +
          `other than ${registration.unit_and_truth?.truth_rule} — re-mine/select.\n`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const pinVerdict = checkBuildPin(readBuildPin(OUT), preflight.pin);
  if (!pinVerdict.ok) {
    process.stdout.write(
      `preflight failed (build_pin_mismatch): this archive was pinned to a different build than ` +
        `the one on disk now — a resumed helping never re-pins itself, it aborts.\n` +
        `${formatBuildPinDiff(pinVerdict.diff)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (pinVerdict.write && !preflightOnly) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(buildPinPath(OUT), JSON.stringify(preflight.pin, null, 2) + "\n");
  }
  process.stdout.write(
    `preflight ok — build ${preflight.pin.headSha.slice(0, 7)} ` +
      `${pinVerdict.write ? (preflightOnly ? "would be pinned" : "pinned") : "matches the archive's pin"} ` +
      `at ${buildPinPath(OUT)}\n`,
  );
  if (preflightOnly) return;
  const buildPinSignature = pinSignature(preflight.pin);

  const { scenarios } = scenarioFile;
  const live = scenarios.filter((s) => !s.excluded && (!only || only.has(s.id)));
  const maxScenarios = helpingSize();
  // WHAT THIS ARCHIVE HAS ALREADY BEEN CHARGED, off disk — finished arms and
  // the aborts of every earlier helping. The old version rebuilt only the
  // finished arms it happened to walk past, so a resumed run forgot every abort
  // and, under `--only`, most of the finished arms too. The ceiling then bound
  // on a fraction of the real spend.
  const spend = spendOnDisk(RUNS, registeredArms);
  let finishedCostUsd = spend.finishedCostUsd;
  let finishedArms = spend.finishedArms;
  // The whole burden: what finished plus what the aborts were charged. The
  // ceiling is checked against THIS, while the per-arm projection comes from
  // the finished arms alone — an estimate that included its own estimates
  // would climb with every failure.
  let chargedUsd = finishedCostUsd + spend.abortedCostUsd;
  if (chargedUsd > 0) {
    process.stdout.write(
      `resuming: $${chargedUsd.toFixed(2)} already charged — ${finishedArms} finished arms ` +
        `($${finishedCostUsd.toFixed(2)}) and ${spend.abortedArms} aborted ` +
        `($${spend.abortedCostUsd.toFixed(2)})\n`,
    );
  }
  let started = 0;
  for (const s of live) {
    const dir = join(RUNS, s.id);
    // Scenario ORDER is the registered one and is never re-sorted; the helping
    // simply stops after N scenarios that still had work to do.
    const alreadyComplete = scenarioComplete(dir, wantedIds);
    if (!alreadyComplete && started >= maxScenarios) break;
    if (!alreadyComplete) started++;
    mkdirSync(dir, { recursive: true });
    const { tree, graphRoot } = prepareTreeOf(s, dir);
    await buildGraph(tree, graphRoot);
    writeFileSync(
      join(dir, "graph.sha256"),
      createHash("sha256").update(readFileSync(join(graphRoot, "graphify-out", "graph.json"))).digest("hex") + "\n",
    );

    let prefill = null;
    let delivered = null;
    // A scenario file written before the arms were renamed would silently run
    // nothing at all — the failure #582 was built to make impossible.
    const order = s.armOrder ?? wantedIds;
    for (const arm of order) {
      const spec = ARMS[arm];
      if (spec === undefined) {
        throw new Error(
          `${s.id}: armOrder contains "${arm}", which is not an arm. ` +
            `${registrationId} registers ${registeredArms.join(", ")} — re-run select.mjs for this sample.`,
        );
      }
      if (!wantedIds.includes(spec.id)) continue;
      // Already on disk and already counted by `spendOnDisk` — adding it again
      // here is what the old version did, and it double-charged every arm of a
      // resumed helping.
      if (armFinished(dir, spec.id)) continue;
      const estimateUsd = nextArmEstimateUsd(finishedCostUsd, finishedArms, registeredEstimateUsd);
      if (!withinCeiling(chargedUsd, estimateUsd, costCeilingUsd)) {
        process.stdout.write(
          `\nstopping before ${s.id} ${spec.id}: $${chargedUsd.toFixed(2)} charged of the ` +
            `$${costCeilingUsd.toFixed(2)} ceiling (${finishedArms} finished arms at ` +
            `$${finishedCostUsd.toFixed(2)}) — the next arm at $${estimateUsd.toFixed(2)} ` +
            `would risk crossing it. Raise CODE_ROI_COST_CEILING only by decision.\n`,
        );
        return;
      }
      let prompt = promptFor(s);
      if (spec.prefill) {
        prefill ??= await prefillFor(s, tree, graphRoot);
        writeFileSync(join(dir, "prefill.json"), JSON.stringify(prefill, null, 2));
        prompt = promptWithPrefill(s, prefill);
      }
      if (spec.delivered) {
        // Kept in the archive whether or not it was emitted: `null` is the
        // product being silent, and the scorer needs to tell that apart from a
        // block that was delivered and ignored.
        delivered ??= await deliveredBlockFor(s, tree, graphRoot, prompt);
        writeFileSync(join(dir, "delivered.json"), JSON.stringify(delivered, null, 2));
        prompt = promptWithDeliveredBlock(prompt, delivered);
      }
      process.stdout.write(`${s.id} ${spec.id} (${spec.name})\u2026 `);
      const { code, finished, charge } = await runArm(
        spec,
        prompt,
        tree,
        graphRoot,
        dir,
        Math.max(0.01, costCeilingUsd - chargedUsd),
        { finishedCostUsd, finishedArms },
        buildPinSignature,
        model,
        maxTurns,
        registeredEstimateUsd,
      );
      chargedUsd += charge.usd;
      if (finished) {
        finishedCostUsd += charge.usd;
        finishedArms++;
        process.stdout.write(`exit ${code}  $${charge.usd.toFixed(2)}  (charged $${chargedUsd.toFixed(2)})\n`);
      } else {
        // The arm stays unfinished and the next helping re-runs it \u2014 but what
        // it burned still counts, or a scenario that keeps failing would run
        // for ever at no recorded cost. It does NOT count towards the per-arm
        // projection: nothing was measured here.
        process.stdout.write(
          `exit ${code}  ABORTED, not finalised; charged $${charge.usd.toFixed(2)} ` +
            `(${charge.source}, total $${chargedUsd.toFixed(2)})\n`,
        );
      }
    }
  }
  const complete = live.filter((s) => scenarioComplete(join(RUNS, s.id), wantedIds)).length;
  process.stdout.write(
    `\n${complete} of ${live.length} scenarios complete, ${finishedArms} arms done ` +
      `at $${finishedCostUsd.toFixed(2)}, $${chargedUsd.toFixed(2)} charged of the ` +
      `$${costCeilingUsd.toFixed(2)} ceiling\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
