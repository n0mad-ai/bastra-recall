/**
 * summarizeContextROI summed hint_tokens_est from only 3 lanes (pre-tool,
 * session, bash-pre) and then divided by every acted-on surfaced episode
 * regardless of lane, so the ratio divided one lane's tokens by another lane's
 * loads. The ratio now counts only acted-on loads whose hook_recall lane is one
 * of the numerator's lanes.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/stats-context-roi-lanes.test.ts
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

const dims = (hook_source: string) => ({
  client: "claude-code",
  hook_source,
  experiment_session: null,
  arm: "unassigned",
});

const recall = (id: string, hook_source: string) => ({
  kind: "hook_recall",
  ts: "2026-09-15T10:00:00.000Z",
  session_id: "s1",
  recall_id: id,
  hits: [{ id: "m", score: 120 }],
  dimensions: dims(hook_source),
});

const acted = (id: string) => ({
  kind: "recall_episode",
  ts: "2026-09-15T10:01:00.000Z",
  session_id: "s1",
  recall_id: id,
  surfaced: true,
  acted_on: true,
  band: "required",
});

const spend = {
  kind: "hook_call",
  ts: "2026-09-15T10:00:00.000Z",
  session_id: "s1",
  hint_tokens_est: 1000,
};

async function roiLine(events: unknown[]): Promise<string> {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-roi-lanes-"));
  try {
    await writeFile(
      join(logDir, "events-2026-09-15.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    const { stdout } = await exec(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "packages/daemon/scripts/stats.ts")],
      { cwd: REPO_ROOT, env: { ...process.env, BASTRA_LOG_PATH: logDir } },
    );
    const line = stdout.split("\n").find((l) => l.includes("tokens per acted-on load"));
    assert.ok(line, `expected a tokens-per-acted-on-load line:\n${stdout}`);
    return line;
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
}

test("tokens per acted-on load divides by the numerator's own lanes only", async () => {
  // 1000 tokens were spent by the pre-tool lane; one of the two acted-on loads
  // came from it, the other from the prompt lane whose tokens are not counted.
  const line = await roiLine([
    spend,
    recall("r1", "pre-tool"),
    recall("r2", "prompt"),
    acted("r1"),
    acted("r2"),
  ]);
  assert.match(line, /~1000\b/, line);
  assert.match(line, /1 of 2/, line);
});

test("no acted-on load from the counted lanes reads as unbounded, not as a ratio", async () => {
  const line = await roiLine([spend, recall("r2", "prompt"), acted("r2")]);
  assert.match(line, /∞/, line);
});

// Regression: the session lane's spend arrives as session_hook_call, but its recalls are
// stamped "session-context" by the shared assembler. Without that source in the lane set
// the session lane's tokens stay in the numerator while its loads leave the denominator.
test("a session-lane load (hook_source session-context) is counted against session_hook_call spend", async () => {
  const line = await roiLine([
    { ...spend, kind: "session_hook_call" },
    recall("r1", "session-context"),
    recall("r2", "prompt"),
    acted("r1"),
    acted("r2"),
  ]);
  assert.match(line, /~1000\b/, line);
  assert.match(line, /1 of 2/, line);
});
