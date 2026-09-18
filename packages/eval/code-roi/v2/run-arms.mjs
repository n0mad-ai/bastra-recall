/**
 * Arm runner for the code-awareness measurement, registration v2 (#588).
 *
 * For every scenario in `scenarios.json` (written by select.mjs, adjudicated
 * by hand BEFORE this runs), in a fresh headless Claude Code process per arm:
 *
 *   control    no MCP server at all — text search and reads only
 *   treatment  exactly one MCP tool, `find_code`, over the scenario's graph
 *
 * The scenario tree is a `git archive` of the commit's parent: no `.git`, so
 * `git log --all` cannot hand either arm the historical commit — the answer.
 * The graph is built from that tree and then moved OUT of it, so neither arm
 * can read it as a file; the treatment reaches it only through the tool.
 *
 * Isolation is the registered one, verified on 2026-09-18: `--setting-sources
 * project --strict-mcp-config --no-session-persistence` means no user hooks,
 * no user CLAUDE.md and no Recall tools. The tree carries no `.claude/`.
 *
 * Everything raw is kept: the stream-json transcript of every arm lands next
 * to the tree, so a run can be re-scored without being re-run (v1 lost its raw
 * logs and could not be audited).
 *
 * Usage: node run-arms.mjs [--only S01,S02]   (resumable: finished arms are skipped)
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
// CODE_ROI_OUT: a pilot directory, so a plumbing check never touches the real archive.
const OUT = process.env.CODE_ROI_OUT ?? join(homedir(), ".bastra", "eval", "code-roi-v2");
const RUNS = join(OUT, "runs");
const MCP_SERVER = new URL("./find-code-mcp.mjs", import.meta.url).pathname;

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
const DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit", "Agent", "Workflow", "Skill", "WebFetch", "WebSearch"];

export function promptFor(s) {
  return [
    "You are working in the repository in the current directory.",
    "",
    `Planned change: the diff below will be applied to \`${s.file}\` (commit message: "${s.subject}").`,
    "",
    "```diff",
    s.diff.trimEnd(),
    "```",
    "",
    "Question: which OTHER files in this repository — production code and tests — would fail to " +
      "type-check after exactly this change, unless they were adapted too? Investigate as you see fit, " +
      "but do not modify any file.",
    "",
    "End your reply with exactly one line of the form",
    'FILES: ["packages/x/src/a.ts", "packages/x/__tests__/b.test.ts"]',
    "listing repo-relative paths, or FILES: [] if no other file is affected.",
  ].join("\n");
}

function prepareTree(s, dir) {
  const tree = join(dir, "tree");
  const graphRoot = join(dir, "graph");
  if (existsSync(join(graphRoot, "graphify-out", "graph.json")) && existsSync(tree)) return { tree, graphRoot };
  rmSync(tree, { recursive: true, force: true });
  rmSync(graphRoot, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  mkdirSync(graphRoot, { recursive: true });
  const tar = execFileSync("git", ["archive", "--format=tar", s.parent], { cwd: REPO, maxBuffer: 512 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", tree], { input: tar });
  // No project settings may reach the agent — the registration says so.
  rmSync(join(tree, ".claude"), { recursive: true, force: true });
  return { tree, graphRoot };
}

async function buildGraph(tree, graphRoot) {
  if (existsSync(join(graphRoot, "graphify-out", "graph.json"))) return;
  // Imported here, not at the top: the daemon's build output only has to
  // exist when a graph is actually built, not when the prompt is imported.
  const { buildCodeGraph } = await import(`${REPO}/packages/daemon/dist/code-graph/build.js`);
  const result = await buildCodeGraph({ repoRoot: tree, lowPriority: false });
  if (!result.ok) throw new Error(`graph build failed: ${result.reason} ${result.detail}`);
  renameSync(join(tree, "graphify-out"), join(graphRoot, "graphify-out"));
}

function runArm(arm, s, tree, graphRoot, dir) {
  const transcript = join(dir, `${arm}.jsonl`);
  const mcpConfig = join(dir, `${arm}-mcp.json`);
  const servers =
    arm === "treatment" ? { code: { command: process.execPath, args: [MCP_SERVER, graphRoot] } } : {};
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }));
  const allowed = arm === "treatment" ? [...ALLOWED_TOOLS, "mcp__code__find_code"] : ALLOWED_TOOLS;
  const args = [
    "-p",
    promptFor(s),
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
          join(dir, `${arm}.meta.json`),
          JSON.stringify({ arm, exitCode: code, wallMs: Date.now() - startedAt, stderr: stderr.slice(-4000) }, null, 2),
        );
        resolve(code);
      });
    });
  });
}

async function main() {
  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(",")) : null;
  const { scenarios } = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
  for (const s of scenarios) {
    if (s.excluded) continue;
    if (only && !only.has(s.id)) continue;
    const dir = join(RUNS, s.id);
    mkdirSync(dir, { recursive: true });
    const { tree, graphRoot } = prepareTree(s, dir);
    await buildGraph(tree, graphRoot);
    const graphHash = createHash("sha256").update(readFileSync(join(graphRoot, "graphify-out", "graph.json"))).digest("hex");
    writeFileSync(join(dir, "graph.sha256"), graphHash + "\n");
    for (const arm of s.armOrder) {
      if (existsSync(join(dir, `${arm}.jsonl`))) continue;
      process.stdout.write(`${s.id} ${arm}… `);
      const code = await runArm(arm, s, tree, graphRoot, dir);
      process.stdout.write(`exit ${code}\n`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
