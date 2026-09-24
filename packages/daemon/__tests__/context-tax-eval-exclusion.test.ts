/**
 * #619 — the context-tax readout in `scripts/stats.ts` must not be dominated
 * by measurement/eval traffic. Two repository probes (measure-recall-payload.ts,
 * measure-recall-budget.ts) call `recallHandler` directly against a REAL vault
 * and, before this fix, wrote unmarked "recall" events indistinguishable from
 * production traffic — two such runs on 2026-09-09 contributed ~3.76M of a
 * 5.68M-token 30-day total (see the issue).
 *
 * This pins the readout side of the fix: a row with `dimensions.client ===
 * "eval"` is excluded from the default report, the report states how many
 * rows/tokens were excluded, and `--include-eval` brings them back.
 *
 * Run: npx tsx --test packages/daemon/__tests__/context-tax-eval-exclusion.test.ts
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

const EVENTS = [
  // A real production emission — must survive both the default and the
  // --include-eval run.
  {
    kind: "hook_call",
    ts: "2026-09-09T10:00:00.000Z",
    session_id: "prod-1",
    hint_tokens_est: 200,
    dimensions: { client: "claude-code", hook_source: "pre-tool", experiment_session: null, arm: "unassigned" },
  },
  // What measure-recall-payload.ts writes once it declares itself (#619).
  {
    kind: "recall",
    ts: "2026-09-09T10:01:00.000Z",
    session_id: "eval-run-1",
    payload_tokens_est: 5000,
    presentation: "lean",
    dimensions: { client: "eval", hook_source: "unknown", experiment_session: null, arm: "unassigned" },
  },
];

async function runStats(logDir: string, extraArgs: string[] = []): Promise<string> {
  const { stdout } = await exec(
    process.execPath,
    ["--import", "tsx", join(REPO_ROOT, "packages/daemon/scripts/stats.ts"), ...extraArgs],
    { cwd: REPO_ROOT, env: { ...process.env, BASTRA_LOG_PATH: logDir } },
  );
  return stdout;
}

test("#619: the default context-tax report excludes eval-marked rows and states how many", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-619-stats-"));
  try {
    await writeFile(
      join(logDir, "events-2026-09-09.jsonl"),
      EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const stdout = await runStats(logDir);
    assert.match(stdout, /^events: 1$/m, `expected the eval row to be excluded from the event count:\n${stdout}`);
    assert.match(
      stdout,
      /excluded as eval\/synthetic \(#619\): 1 events, ~5000 context-tax tokens — rerun with --include-eval to include them/,
      `expected an explicit exclusion line:\n${stdout}`,
    );
    // The production emission's 200 tokens must be the whole context-tax
    // total — the eval row's 5000 must not have leaked in.
    assert.match(stdout, /total \(known parts\):\s+200 tokens across 1 emissions/, stdout);
    assert.doesNotMatch(stdout, /eval\/synthetic traffic included/, stdout);
  } finally {
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#619: --include-eval brings the excluded rows back into every total", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-619-stats-inc-"));
  try {
    await writeFile(
      join(logDir, "events-2026-09-09.jsonl"),
      EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const stdout = await runStats(logDir, ["--include-eval"]);
    assert.match(stdout, /^events: 2$/m, `expected both rows with --include-eval:\n${stdout}`);
    assert.match(
      stdout,
      /eval\/synthetic traffic included \(#619\): 1 events, ~5000 context-tax tokens/,
      `expected an inclusion note, not an exclusion line:\n${stdout}`,
    );
    assert.match(stdout, /total \(known parts\):\s+5200 tokens across 2 emissions/, stdout);
  } finally {
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
