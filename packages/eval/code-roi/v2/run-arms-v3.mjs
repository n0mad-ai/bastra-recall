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
 *   prefilled            the same tools, plus the `find_affected_files` answer
 *                        for the planned change already in the prompt.
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
 * run, and every finished arm's `total_cost_usd` is added up. The next arm
 * only starts while the ceiling is still out of reach at the running average
 * cost per arm; otherwise the run stops and says how far it got.
 *
 * Usage: CODE_ROI_OUT=… node run-arms-v3.mjs [--only S01,S02] [--arms A,B,prefilled]
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
import { ALL_TOOL_DEFS } from "../../../daemon/dist/tool-defs.js";

const OUT = writableOut();
/** This repository — the one `prepareTree` from the v2 runner knows. */
const REPO_SELF = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const RUNS = join(OUT, "runs");
const MCP_SERVER = new URL("./code-tools-mcp.mjs", import.meta.url).pathname;
const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;

// From the registration — not tunable here.
const MODEL = "claude-sonnet-5";
const MAX_TURNS = 30;
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

/** The arms, and what each one changes. `graph` = the MCP server is attached. */
export const ARMS = {
  A: { id: "A", name: "grep", graph: false, prefill: false },
  B: { id: "B", name: "offered", graph: true, prefill: false },
  // NO MCP server, no instructions: the prefilled arm is the ANSWER handed
  // over, nothing else. With the server attached it also carried the product
  // surface, and a gain could not be told apart from arm B's (#582 review).
  prefilled: { id: "prefilled", name: "prefilled", graph: false, prefill: true },
};

/**
 * The registered ceiling for one run, in US dollars — read FROM the
 * registration, not repeated here. A number in two places is a number that
 * ends up different in one of them, and this one decides when a paid run stops.
 */
const REGISTRATION = JSON.parse(
  readFileSync(new URL("../../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
);
const REGISTERED_CEILING_USD = Number(REGISTRATION.run_conditions.cost_ceiling_usd);

/**
 * The ceiling this run honours. The environment may only LOWER it: a variable
 * that can raise a registered spending limit is not a limit, it is a default.
 */
export const COST_CEILING_USD = (() => {
  const raw = Number(process.env.CODE_ROI_COST_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, REGISTERED_CEILING_USD) : REGISTERED_CEILING_USD;
})();

/**
 * What one arm cost, from its transcript's `result` event.
 *
 * An aborted arm has no `result` event and reports 0 here, which is NOT the
 * same as free: `spentUsd` of an aborted arm is taken from `usageCostUsd`
 * below, so a run that burned money and produced nothing still pushes the
 * ceiling. The two are separate because only a `result` is a finished arm.
 */
export function armCostUsd(transcript) {
  let cost = 0;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "result" && typeof ev.total_cost_usd === "number") cost = ev.total_cost_usd;
    } catch {
      /* a half-written line is not a cost */
    }
  }
  return cost;
}

/**
 * Does this transcript carry the terminal `result` event?
 *
 * That event is what says the CLI finished its own turn. Without it the file is
 * whatever had been flushed when the process died — a timeout, a budget stop,
 * a crash — and its `FILES:` line, if there even is one, is a partial answer,
 * not an answer.
 */
/**
 * May this transcript be finalised as a finished arm?
 *
 * BOTH halves are required. Exit 0 alone is not enough — a CLI that stops at
 * `--max-budget-usd` can still exit cleanly — and a `result` event alone is not
 * enough either, because a non-zero exit says something went wrong after it.
 */
export function finalisable(exitCode, transcript) {
  return exitCode === 0 && hasResultEvent(transcript);
}

export function hasResultEvent(transcript) {
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).type === "result") return true;
    } catch {
      /* a half-written line is not a result */
    }
  }
  return false;
}

/**
 * What an ABORTED arm is charged against the ceiling.
 *
 * An arm killed at the timeout, stopped by `--max-budget-usd` or crashed spent
 * real money on every turn it took, and counting it as free is how a run of
 * failures spends without limit. Its transcript carries no `total_cost_usd` —
 * `result` is the only event that has one (checked on the archived v3
 * transcripts) — so the charge is the mean of the arms that DID finish in this
 * run, and nothing at all before the first one finished.
 *
 * That is an estimate, and it is deliberately taken from this run's own
 * measurements rather than from a price list: a per-token price written into
 * this file is a number nobody re-checks when it changes, and it would decide
 * when a paid run stops.
 */
export function abortedArmCharge(spentUsd, finishedArms) {
  return finishedArms > 0 ? spentUsd / finishedArms : 0;
}

/**
 * May another arm start? Only while the ceiling is still out of reach at what
 * the arms so far have cost on average — a ceiling checked only AFTER the
 * spend is not a ceiling.
 */
export function withinCeiling(spentUsd, armsRun, ceilingUsd = COST_CEILING_USD) {
  if (spentUsd >= ceilingUsd) return false;
  if (armsRun === 0) return true;
  return spentUsd + spentUsd / armsRun <= ceilingUsd;
}

/**
 * The prefilled arm's block: the product's own `find_affected_files` answer for
 * exactly the planned change, rendered as the agent would have received it.
 *
 * The symbols come from the scenario's diff through the product's
 * `changedSymbolsOf`, not from a hand-written list — the agent in arm B has
 * the same diff in its prompt, so both graph arms start from the same
 * information.
 */
async function prefillFor(s, tree, graphRoot) {
  const { loadGraph } = await import(`${DIST}reader.js`);
  const { changedSymbolsOf } = await import(`${DIST}affected.js`);
  const { findAffectedFiles } = await import(`${DIST}find-affected-files.js`);
  const { CodeGraphCache } = await import(`${DIST}cache.js`);
  const repo = scenarioRoot(tree, graphRoot);
  const loaded = await loadGraph(repo);
  if (!loaded.ok) throw new Error(`prefill: graph ${loaded.reason}`);
  const symbols = changedSymbolsOf(loaded.graph, s.file, s.diff).map((c) => c.name);
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

function runArm(arm, prompt, tree, graphRoot, dir, budgetUsd) {
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
    MODEL,
    "--max-turns",
    String(MAX_TURNS),
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
        const finished = finalisable(code, readFileSync(`${transcript}.partial`, "utf8"));
        const kept = finished ? transcript : `${transcript}.failed-${Date.now()}`;
        renameSync(`${transcript}.partial`, kept);
        writeFileSync(
          join(dir, `${arm.id}${finished ? "" : ".failed"}.meta.json`),
          JSON.stringify(
            {
              arm: arm.id,
              name: arm.name,
              exitCode: code,
              finished,
              ...(finished ? {} : { reason: timedOut ? "timeout" : code === 0 ? "no_result_event" : `exit_${code}` }),
              transcript: kept.split("/").slice(-1)[0],
              wallMs: Date.now() - startedAt,
              stderr: stderr.slice(-4000),
            },
            null,
            2,
          ),
        );
        resolve({ code, finished });
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
 * or copied in, may be an abort that was renamed anyway. So the terminal
 * `result` event is checked on disk — the same rule the runner applies when it
 * decides whether to finalise at all, so a resumed run and a fresh one agree.
 */
export function armFinished(dir, armId) {
  const path = join(dir, `${armId}.jsonl`);
  if (!existsSync(path)) return false;
  return hasResultEvent(readFileSync(path, "utf8"));
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
  const wantedIds = (arg("--arms") ?? ARM_IDS.join(",")).split(",").map((a) => a.trim());
  for (const id of wantedIds) {
    if (ARMS[id] === undefined) {
      throw new Error(`unknown arm "${id}" — the arms are ${ARM_IDS.join(", ")}`);
    }
  }

  const { scenarios } = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
  const live = scenarios.filter((s) => !s.excluded && (!only || only.has(s.id)));
  const maxScenarios = helpingSize();
  let spentUsd = 0;
  let armsRun = 0;
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
    // A scenario file written before the arms were renamed would silently run
    // nothing at all — the failure #582 was built to make impossible.
    const order = s.armOrder ?? wantedIds;
    for (const arm of order) {
      const spec = ARMS[arm];
      if (spec === undefined) {
        throw new Error(
          `${s.id}: armOrder contains "${arm}", which is not an arm. ` +
            `The arms are ${ARM_IDS.join(", ")} — re-run select.mjs for this sample.`,
        );
      }
      if (!wantedIds.includes(spec.id)) continue;
      const transcript = join(dir, `${spec.id}.jsonl`);
      if (armFinished(dir, spec.id)) {
        spentUsd += armCostUsd(readFileSync(transcript, "utf8"));
        armsRun++;
        continue;
      }
      if (!withinCeiling(spentUsd, armsRun)) {
        process.stdout.write(
          `\nstopping before ${s.id} ${spec.id}: $${spentUsd.toFixed(2)} spent of the ` +
            `$${COST_CEILING_USD.toFixed(2)} ceiling over ${armsRun} arms — the next arm ` +
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
      process.stdout.write(`${s.id} ${spec.id} (${spec.name})\u2026 `);
      const { code, finished } = await runArm(
        spec,
        prompt,
        tree,
        graphRoot,
        dir,
        Math.max(0.01, COST_CEILING_USD - spentUsd),
      );
      if (finished) {
        const cost = armCostUsd(readFileSync(transcript, "utf8"));
        spentUsd += cost;
        armsRun++;
        process.stdout.write(`exit ${code}  $${cost.toFixed(2)}  (total $${spentUsd.toFixed(2)})\n`);
      } else {
        // The arm stays unfinished and the next helping re-runs it \u2014 but what
        // it burned still counts, or a scenario that keeps failing would run
        // for ever at no recorded cost.
        const charged = abortedArmCharge(spentUsd, armsRun);
        spentUsd += charged;
        process.stdout.write(
          `exit ${code}  ABORTED, not finalised; charged the running mean ` +
            `$${charged.toFixed(2)} (total $${spentUsd.toFixed(2)})\n`,
        );
      }
    }
  }
  const complete = live.filter((s) => scenarioComplete(join(RUNS, s.id), wantedIds)).length;
  process.stdout.write(
    `\n${complete} of ${live.length} scenarios complete, ${armsRun} arms done, ` +
      `ceiling $${spentUsd.toFixed(2)} of $${COST_CEILING_USD.toFixed(2)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
