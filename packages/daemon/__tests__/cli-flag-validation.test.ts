/**
 * #536 — an option the command does not take is a usage error, not a warning.
 *
 * The parser printed `warning: unknown flag '--dryrun' ignored` and dispatched
 * anyway. Measured on an isolated profile: `bastra uninstall cursor --dryrun`
 * warned, removed the real `bastra-recall` registration, wrote a backup and
 * exited 0 — a typo in the rehearsal flag performed the mutation it was meant
 * to rehearse.
 *
 * Two gates:
 *
 *  1. BEHAVIOUR — spawn the real CLI against an isolated HOME whose Cursor
 *     config carries a registration, and assert the file is byte-identical
 *     afterwards and the exit code is 2. Run for read-only and mutating
 *     commands alike, plus the positive control that the correctly spelled
 *     `--dry-run` still works.
 *  2. UNIT/DRIFT — validateArgs' table, and the guarantee that every
 *     dispatched command has an entry in COMMAND_FLAGS.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/cli-flag-validation.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { COMMAND_FLAGS, validateArgs } from "../src/cli/flag-spec.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(here, "..", "src", "cli.ts");

interface Run { stdout: string; stderr: string; code: number }

function runCli(args: string[], home: string): Promise<Run> {
  return new Promise((ok, ko) => {
    const child = spawn("npx", ["tsx", CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: home,
        BASTRA_TELEMETRY: "off",
        BASTRA_LOG_PATH: join(home, "logs"),
        BASTRA_VAULT_PATH: join(home, "vault"),
      },
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

/** A HOME with a Cursor registration in it — the target of the byte check. */
async function isolatedHome(): Promise<{ home: string; cursorConfig: string }> {
  const home = mkdtempSync(join(tmpdir(), "bastra-536-"));
  await mkdir(join(home, ".cursor"), { recursive: true });
  await mkdir(join(home, "vault"), { recursive: true });
  const cursorConfig = join(home, ".cursor", "mcp.json");
  await writeFile(
    cursorConfig,
    `${JSON.stringify(
      { mcpServers: { "bastra-recall": { command: "node", args: ["/opt/bastra/mcp-forwarder.js"] } } },
      null,
      2,
    )}\n`,
  );
  return { home, cursorConfig };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// ─── behaviour gate ──────────────────────────────────────────────────────────

/** Each case: the argv, and why it must never reach the command. */
const REJECTED: Array<{ argv: string[]; why: string }> = [
  { argv: ["uninstall", "cursor", "--dryrun"], why: "a misspelled --dry-run on the removing command" },
  { argv: ["install", "cursor", "--dryrun"], why: "the same typo on the registering command" },
  { argv: ["uninstall", "cursor", "--dry-Run"], why: "case is not spelling" },
  { argv: ["uninstall", "cursor", "--stats"], why: "a known flag that belongs to another command" },
  { argv: ["install", "cursor", "--vault"], why: "a value-taking option with no value" },
  { argv: ["install", "cursor", "--vault", "--dry-run"], why: "the next flag is not a vault path" },
  { argv: ["doctor", "--fixx"], why: "a misspelled repair flag" },
  { argv: ["logs", "--stats", "--days", "1"], why: "the review's second observation, on a read-only command" },
  { argv: ["status", "--jsonn"], why: "a read-only command rejects unknown options too" },
  { argv: ["uninstall", "cursor", "--dryrun", "--help"], why: "validation wins over --help (documented precedence)" },
];

for (const { argv, why } of REJECTED) {
  test(`#536 — 'bastra ${argv.join(" ")}' is rejected before it runs (${why})`, async () => {
    const { home, cursorConfig } = await isolatedHome();
    const before = await sha256(cursorConfig);
    const run = await runCli(argv, home);
    assert.equal(run.code, 2, `expected a usage exit, got ${run.code}\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /^error: /m, "the reason must be named on stderr");
    assert.equal(await sha256(cursorConfig), before, "the target file changed");
    assert.deepEqual(
      (await readdir(join(home, ".cursor"))).sort(),
      ["mcp.json"],
      "a backup file proves the mutating path ran",
    );
  });
}

test("#536 — the correctly spelled --dry-run still rehearses and still changes nothing", async () => {
  const { home, cursorConfig } = await isolatedHome();
  const before = await sha256(cursorConfig);
  const run = await runCli(["uninstall", "cursor", "--dry-run"], home);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /would-remove|would remove/i, run.stdout);
  assert.equal(await sha256(cursorConfig), before);
});

test("#536 — without the typo the removal still happens", async () => {
  const { home, cursorConfig } = await isolatedHome();
  const before = await sha256(cursorConfig);
  const run = await runCli(["uninstall", "cursor"], home);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.notEqual(await sha256(cursorConfig), before, "the real uninstall must still work");
});

// ─── unit gate ───────────────────────────────────────────────────────────────

test("#536 — validateArgs separates unknown, misplaced and value-less options", () => {
  assert.deepEqual(validateArgs(["uninstall", "cursor", "--dry-run"]), []);
  assert.deepEqual(validateArgs(["uninstall", "cursor", "--dryrun"]), ["unknown option '--dryrun'"]);
  assert.deepEqual(validateArgs(["uninstall", "cursor", "--stats"]), [
    "option '--stats' is not valid for 'bastra uninstall'",
  ]);
  assert.deepEqual(validateArgs(["install", "all", "--vault"]), ["option '--vault' needs a value"]);
  assert.deepEqual(validateArgs(["install", "all", "--vault", "--yes"]), ["option '--vault' needs a value"]);
  // A value may look like anything as long as it is not an option.
  assert.deepEqual(validateArgs(["install", "all", "--vault", "install"]), []);
  assert.deepEqual(validateArgs(["install", "all", "--vault=/tmp/v"]), []);
  // Global flags are accepted everywhere, on every command and on none.
  assert.deepEqual(validateArgs(["--help"]), []);
  assert.deepEqual(validateArgs(["update", "--help"]), []);
  assert.deepEqual(validateArgs(["--version"]), []);
  // A flag with no command at all still has to be a real one.
  assert.deepEqual(validateArgs(["--fix"]), ["option '--fix' needs a command — run 'bastra help'"]);
  // An unknown COMMAND is the dispatcher's message, not ours.
  assert.deepEqual(validateArgs(["frobnicate", "--fix"]), []);
  // Short options are options, not positionals.
  assert.deepEqual(validateArgs(["status", "-x"]), ["unknown option '-x'"]);
  assert.deepEqual(validateArgs(["status", "-q"]), []);
});

test("#536 — every dispatched command has a flag list (drift gate)", async () => {
  const src = await readFile(join(here, "..", "src", "cli.ts"), "utf8");
  const body = src.slice(src.indexOf("switch (args.command)"), src.indexOf("default:"));
  const dispatched = [...body.matchAll(/case\s+"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(dispatched.length > 10, "sanity: the dispatch table was parsed");
  const missing = dispatched.filter((c) => COMMAND_FLAGS[c] === undefined);
  assert.deepEqual(
    missing,
    [],
    `these commands dispatch but have no flag list — add them to COMMAND_FLAGS in cli/flag-spec.ts: ${missing.join(", ")}`,
  );
});
