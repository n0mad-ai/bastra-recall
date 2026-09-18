/**
 * Arm runner for the change-impact measurement, registration v4 (#582).
 *
 * v3 answered one question and raised another. It measured `find_code` offered
 * against no tool at all and found the agent never called it (0 of 44 runs), so
 * the comparison was two runs of the same grep behaviour. Two things were
 * confounded there and this runner separates them:
 *
 *   A  grep      no MCP server at all — text search and reads only (control)
 *   B  offered   `find_code` + `find_affected_files` offered, nothing else
 *                changed. Whether the agent CALLS it is the observation.
 *   C  forced    the same tools, plus the `find_affected_files` answer for the
 *                planned change already in the prompt. The agent cannot fail
 *                to use it, so this measures whether the ANSWER helps.
 *
 * ADOPTION is read off B alone (tool calls per scenario). EFFECT is C against
 * A. B against A measures the two together and is not the effect question —
 * reporting it as one is what made v3 unreadable.
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
 * Usage: CODE_ROI_OUT=… node run-arms-v3.mjs [--only S01,S02] [--arms A,B,C]
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildGraph, prepareTree, promptFor } from "./run-arms.mjs";
import { scenarioRoot } from "./scenario-root.mjs";

const OUT = process.env.CODE_ROI_OUT ?? join(homedir(), ".bastra", "eval", "code-roi-v4");
const RUNS = join(OUT, "runs");
const MCP_SERVER = new URL("./code-tools-mcp.mjs", import.meta.url).pathname;
const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;

// From the registration — not tunable here.
const MODEL = "claude-sonnet-5";
const MAX_TURNS = 30;
const ARM_TIMEOUT_MS = 20 * 60_000;
const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(sed -n:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
];
const GRAPH_TOOLS = ["mcp__code__find_code", "mcp__code__find_affected_files"];
const DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit", "Agent", "Workflow", "Skill", "WebFetch", "WebSearch"];

/** The arms, and what each one changes. `graph` = the MCP server is attached. */
export const ARMS = {
  A: { id: "A", name: "grep", graph: false, prefill: false },
  B: { id: "B", name: "offered", graph: true, prefill: false },
  C: { id: "C", name: "forced", graph: true, prefill: true },
};

/**
 * Arm C's prefill: the product's own `find_affected_files` answer for exactly
 * the planned change, rendered as the agent would have received it.
 *
 * The symbols come from the scenario's diff through the product's
 * `changedSymbolsOf`, not from a hand-written list — the agent in arm B has
 * the same diff in its prompt, so both arms start from the same information.
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

function runArm(arm, prompt, tree, graphRoot, dir) {
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
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), ARM_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end(() => {
        renameSync(`${transcript}.partial`, transcript);
        writeFileSync(
          join(dir, `${arm.id}.meta.json`),
          JSON.stringify(
            { arm: arm.id, name: arm.name, exitCode: code, wallMs: Date.now() - startedAt, stderr: stderr.slice(-4000) },
            null,
            2,
          ),
        );
        resolve(code);
      });
    });
  });
}

async function main() {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? process.argv[i + 1] : null;
  };
  const only = arg("--only") ? new Set(arg("--only").split(",")) : null;
  const wanted = (arg("--arms") ?? "A,B,C").split(",").map((a) => ARMS[a.trim()]);
  if (wanted.some((a) => a === undefined)) throw new Error("--arms takes A, B and/or C");

  const { scenarios } = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
  for (const s of scenarios) {
    if (s.excluded) continue;
    if (only && !only.has(s.id)) continue;
    const dir = join(RUNS, s.id);
    mkdirSync(dir, { recursive: true });
    const { tree, graphRoot } = prepareTree(s, dir);
    await buildGraph(tree, graphRoot);
    writeFileSync(
      join(dir, "graph.sha256"),
      createHash("sha256").update(readFileSync(join(graphRoot, "graphify-out", "graph.json"))).digest("hex") + "\n",
    );

    let prefill = null;
    for (const arm of s.armOrder ?? wanted.map((a) => a.id)) {
      const spec = ARMS[arm];
      if (spec === undefined || !wanted.includes(spec)) continue;
      if (existsSync(join(dir, `${spec.id}.jsonl`))) continue;
      let prompt = promptFor(s);
      if (spec.prefill) {
        prefill ??= await prefillFor(s, tree, graphRoot);
        writeFileSync(join(dir, "prefill.json"), JSON.stringify(prefill, null, 2));
        prompt = promptWithPrefill(s, prefill);
      }
      process.stdout.write(`${s.id} ${spec.id} (${spec.name})… `);
      const code = await runArm(spec, prompt, tree, graphRoot, dir);
      process.stdout.write(`exit ${code}\n`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
