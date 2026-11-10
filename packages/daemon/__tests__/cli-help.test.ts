/**
 * `bastra <command> --help` (#330) — the flag documents, it never acts.
 *
 * The defect this guards against: `showHelp` was bound to "no command given",
 * so any command plus --help fell through to the dispatch switch and ran. For
 * `bastra update --help` that meant re-registering every surface and restarting
 * the daemon as the answer to the question what update does.
 *
 * Three gates, because one alone would rot:
 *
 *  1. BEHAVIOUR — spawn the real CLI and assert that help came out and the
 *     command did not run. The writing commands are exercised with --dry-run
 *     as a second net: if the guard ever breaks, this test prints a diff
 *     instead of restarting the daemon on whoever's machine runs the suite.
 *  2. STRUCTURE — the guard sits before the switch and carries no
 *     `!args.command` condition. This is what makes the fix hold for the
 *     commands the behaviour test deliberately does not run (token, config).
 *  3. DRIFT — every dispatched command has its own help section, so a new
 *     command cannot land with nothing to say for itself.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/cli-help.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { COMMAND_HELP } from "../src/cli/help-text.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(here, "..", "src", "cli.ts");

interface Run { stdout: string; stderr: string; code: number }

function runCli(args: string[]): Promise<Run> {
  return new Promise((ok, ko) => {
    const child = spawn("npx", ["tsx", CLI_PATH, ...args], {
      env: { ...process.env, BASTRA_TELEMETRY: "off" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", ko);
    child.on("close", (code) => ok({ stdout, stderr, code: code ?? -1 }));
  });
}

/**
 * "Did not run" is asserted as "printed the help section and nothing else".
 * Matching against markers of execution was tried first and is the weaker
 * test: the help text legitimately contains words like 'daemon' and
 * 'candidates', so the marker either collides with the documentation or is so
 * narrow it stops covering the failure. Exact output leaves no room.
 */
function expectedHelp(cmd: string): string {
  return `${COMMAND_HELP[cmd]}\nMore: bastra help\n`;
}

// Commands whose execution would be visible in stdout. The writing ones carry
// --dry-run purely as a safety net for the case where this very test is the
// thing that fails — a broken guard then prints a diff instead of restarting
// the daemon on whoever's machine runs the suite.
const SAFE_ARGS: Record<string, string[]> = {
  codex: ['-m','fixture-help-only'],
  status: [],
  doctor: [],
  update: ["--dry-run"],
  uninstall: ["all", "--dry-run"],
  import: ["--dry-run"],
};

for (const [cmd, extra] of Object.entries(SAFE_ARGS)) {
  test(`--help documents '${cmd}' instead of running it`, async () => {
    const { stdout, code } = await runCli([cmd, "--help", ...extra]);
    assert.equal(code, 0, `exit code for '${cmd} --help'`);
    assert.equal(
      stdout,
      expectedHelp(cmd),
      `'${cmd} --help' emitted something other than its help section — it ran`,
    );
  });
}

test("-h is the same gate as --help", async () => {
  const { stdout, code } = await runCli(["status", "-h"]);
  assert.equal(code, 0);
  assert.equal(stdout, expectedHelp("status"));
});

test("per-command help answers about THAT command", async () => {
  // The reason someone types it: the global listing describes update in two
  // lines and never mentions --staged or --force.
  const { stdout } = await runCli(["update", "--help", "--dry-run"]);
  assert.match(stdout, /bastra update —/);
  assert.match(stdout, /--staged/);
  assert.match(stdout, /--force/);
});

test("the global entry points are unchanged", async () => {
  const global = await runCli(["--help"]);
  assert.equal(global.code, 0);
  assert.match(global.stdout, /install bastra-recall across AI clients/);
  assert.match(global.stdout, /Commands:/);

  const helpCmd = await runCli(["help"]);
  assert.equal(helpCmd.code, 0);
  assert.match(helpCmd.stdout, /install bastra-recall across AI clients/);

  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
});

test("an unknown command with --help still gets the global listing", async () => {
  const { stdout, code } = await runCli(["nonsense-command", "--help"]);
  assert.equal(code, 0, "help never errors out over an unknown command");
  assert.match(stdout, /Commands:/);
});

// ─── structure gate ──────────────────────────────────────────────────────────

test("the help guard runs before the dispatch switch, for every command", async () => {
  const src = await readFile(join(here, "..", "src", "cli.ts"), "utf8");
  const guard = src.indexOf("if (args.showHelp)");
  const table = src.indexOf("switch (args.command)");
  assert.ok(guard > 0, "no showHelp guard found in cli.ts");
  assert.ok(guard < table, "the showHelp guard must run before the dispatch switch");
  // The exact shape of the original defect: binding help to "no command given".
  assert.doesNotMatch(
    src.slice(guard, table),
    /args\.showHelp\s*&&\s*!args\.command/,
    "help is bound to the no-command case again — that is #330",
  );
});

// ─── drift gate ──────────────────────────────────────────────────────────────

/** The commands cli.ts actually dispatches on, read from the source. */
async function dispatchedCommands(): Promise<Set<string>> {
  const src = await readFile(join(here, "..", "src", "cli.ts"), "utf8");
  const body = src.slice(src.indexOf("switch (args.command)"), src.indexOf("default:"));
  const found = new Set<string>();
  for (const m of body.matchAll(/case\s+"([a-z-]+)"/g)) found.add(m[1]);
  return found;
}

test("every dispatched command has its own help section (drift gate)", async () => {
  const dispatched = await dispatchedCommands();
  assert.ok(dispatched.size > 10, "sanity: the dispatch table was parsed");
  const missing = [...dispatched].filter((c) => !COMMAND_HELP[c]);
  assert.deepEqual(
    missing,
    [],
    `these commands dispatch but have no help section — add them to COMMAND_HELP in cli/help-text.ts: ${missing.join(", ")}`,
  );
});

test("no help section describes a command the CLI would reject", async () => {
  const dispatched = await dispatchedCommands();
  // `help` is handled before the switch, so it never appears as a case.
  const valid = new Set([...dispatched, "help"]);
  const phantom = Object.keys(COMMAND_HELP).filter((c) => !valid.has(c));
  assert.deepEqual(phantom, [], `help sections for non-existent commands: ${phantom.join(", ")}`);
});

test("each section names its command and shows a usage block", () => {
  for (const [cmd, text] of Object.entries(COMMAND_HELP)) {
    assert.match(text, new RegExp(`bastra ${cmd}\\b`), `${cmd}: section does not name the command`);
    assert.match(text, /Usage:/, `${cmd}: section has no usage block`);
  }
});
