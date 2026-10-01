/**
 * The exposure-normalised section divides a windowed numerator (acted_on
 * episodes inside --days) by an all-time denominator (the usage sidecar's
 * `surfaced`), so --days understates the rate. The section says so when --days
 * is set, and stays quiet for an all-time run. A missing sidecar shows up as
 * every row counted `unknown` (readUsage never throws), not as a skip message.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stats-exposure-days.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function exposureSection(extraArgs: string[]): Promise<string> {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-exposure-log-"));
  const vault = await mkdtemp(join(tmpdir(), "bastra-exposure-vault-"));
  try {
    const now = new Date();
    const event = {
      kind: "recall_episode",
      ts: now.toISOString(),
      session_id: "s1",
      recall_id: "r1",
      memory_id: "mem-1",
      surfaced: true,
      acted_on: true,
      band: "required",
    };
    await writeFile(
      join(logDir, `events-${now.toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify(event) + "\n",
      "utf8",
    );
    const { stdout } = await exec(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "packages/daemon/scripts/stats.ts"), ...extraArgs],
      { cwd: REPO_ROOT, env: { ...process.env, BASTRA_LOG_PATH: logDir, BASTRA_VAULT_PATH: vault } },
    );
    const start = stdout.indexOf("## Exposure-normalised use");
    assert.notEqual(start, -1, `expected the exposure section:\n${stdout}`);
    const rest = stdout.slice(start + 1);
    const next = rest.indexOf("\n## ");
    return next === -1 ? rest : rest.slice(0, next);
  } finally {
    await rm(logDir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
}

test("--days warns that the surfaced denominator is all-time", async () => {
  const section = await exposureSection(["--days", "7"]);
  assert.match(section, /CAUTION: acted_on is windowed to the last 7 day\(s\)/);
});

test("an all-time run carries no windowing caution", async () => {
  const section = await exposureSection([]);
  assert.doesNotMatch(section, /CAUTION/);
});

test("a vault without a sidecar counts rows as unknown, never as a skip", async () => {
  const section = await exposureSection([]);
  assert.doesNotMatch(section, /usage sidecar unreadable/);
  assert.match(section, /unknown/i);
});
