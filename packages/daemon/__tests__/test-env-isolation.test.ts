/**
 * scripts/test-env.mjs is the one seam every test process passes through. Its
 * properties, each asserted on a real child process rather than on the file:
 *
 *  1. A developer's bastra settings do not reach the tests. With
 *     BASTRA_VAULT_PATH exported by a shell profile, spawned CLIs ran against the
 *     real vault (arm-plumbing: `0 !== 100` queries against fixtures never read).
 *  2. Everything a run puts under tmpdir() is gone when the run exits — on a
 *     signal too. Runs used to leave thousands of directories behind.
 *  3. What a test deliberately hands a child, and an output directory a caller
 *     chose (#420), is left alone.
 *
 * Run: node --import tsx --test packages/daemon/__tests__/test-env-isolation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEST_ENV = join(REPO, "scripts", "test-env.mjs");

const PROBE = `
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const made = mkdtempSync(join(tmpdir(), "probe-"));
console.log(JSON.stringify({
  vault: process.env.BASTRA_VAULT_PATH ?? null,
  nexusVault: process.env.NEXUS_VAULT_PATH ?? null,
  daemonUrl: process.env.BASTRA_DAEMON_URL ?? null,
  token: process.env.BASTRA_API_TOKEN ?? null,
  ollama: process.env.BASTRA_OLLAMA_URL ?? null,
  hookState: process.env.BASTRA_HOOK_STATE_DIR ?? null,
  logs: process.env.BASTRA_LOG_PATH,
  runs: process.env.BASTRA_EVAL_RUNS_DIR,
  root: process.env.BASTRA_TEST_RUN_ROOT,
  made,
}));
if (process.argv.includes("--hang")) setInterval(() => {}, 1000);
`;

/** Env of a process that is NOT inside a test run yet — what a shell hands `npm test`. */
function outsideRun(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const k of ["BASTRA_TEST_RUN_ROOT", "BASTRA_LOG_PATH", "BASTRA_EVAL_RUNS_DIR", "NODE_TEST_CONTEXT"]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

function probe(env: NodeJS.ProcessEnv) {
  const r = spawnSync(process.execPath, ["--import", TEST_ENV, "-e", PROBE], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as Record<string, string | null>;
}

const DEVELOPER_SHELL = {
  BASTRA_VAULT_PATH: "/home/someone/real-vault",
  NEXUS_VAULT_PATH: "/home/someone/real-vault",
  BASTRA_DAEMON_URL: "http://127.0.0.1:6723",
  BASTRA_API_TOKEN: "real-token",
  BASTRA_OLLAMA_URL: "http://gpu-box:11434",
  BASTRA_HOOK_STATE_DIR: "/home/someone/.bastra/hook-state",
};

test("a developer's vault, daemon, token, model and state settings do not reach a test process", () => {
  const seen = probe(outsideRun(DEVELOPER_SHELL));
  assert.deepEqual(
    [seen.vault, seen.nexusVault, seen.daemonUrl, seen.token, seen.ollama, seen.hookState],
    [null, null, null, null, null, null],
  );
});

test("everything the run put under tmpdir() is removed when it exits", () => {
  const seen = probe(outsideRun({}));
  for (const p of [seen.logs, seen.runs, seen.made]) assert.ok(p!.startsWith(seen.root!), `${p} is outside the run root`);
  assert.equal(existsSync(seen.root!), false, `left behind: ${seen.root}`);
});

test("…and when it is terminated", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["--import", TEST_ENV, "-e", PROBE, "--", "--hang"], { env: outsideRun({}) });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  while (!out.includes("\n")) await new Promise((r) => setTimeout(r, 50));
  const seen = JSON.parse(out.trim()) as Record<string, string>;
  assert.ok(existsSync(seen.made));
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGTERM");
  // A handler that cleans up but swallows the signal would hang here forever;
  // make that a failure, not a stuck suite.
  const outcome = await Promise.race([exited.then(() => "exited"), new Promise((r) => setTimeout(() => r("hung"), 10_000))]);
  if (outcome === "hung") child.kill("SIGKILL");
  assert.equal(outcome, "exited", "SIGTERM must still end the process");
  assert.equal(existsSync(seen.root), false, `left behind after SIGTERM: ${seen.root}`);
});

test("an output directory the caller chose is kept and never removed (#420)", () => {
  const chosen = mkdtempSync(join(tmpdir(), "bastra-chosen-logs-"));
  try {
    const seen = probe(outsideRun({ BASTRA_LOG_PATH: chosen }));
    assert.equal(seen.logs, chosen);
    assert.ok(existsSync(chosen));
  } finally {
    rmSync(chosen, { recursive: true, force: true });
  }
});

test("BASTRA_TEST_KEEP_ENV=1 keeps a deliberately chosen vault", () => {
  const seen = probe(outsideRun({ BASTRA_VAULT_PATH: "/tmp/chosen-vault", BASTRA_TEST_KEEP_ENV: "1" }));
  assert.equal(seen.vault, "/tmp/chosen-vault");
});

test("inside a run, what a test hands its child is not stripped", () => {
  const seen = probe({ ...process.env, BASTRA_TEST_RUN_ROOT: tmpdir(), BASTRA_VAULT_PATH: "/tmp/fixture-vault", NODE_TEST_CONTEXT: "" });
  assert.equal(seen.vault, "/tmp/fixture-vault");
});
