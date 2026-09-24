/**
 * #507 — the context-tax readout in `scripts/stats.ts` splits by `client` and
 * `hook_source`, but only once the emissions it folds actually carry
 * `dimensions`. Before #507 wired the six hook lanes to write it, this section
 * did not exist at all: `summarizeContextTax` printed lane/tool totals only,
 * with no dimension breakdown — this test fails on that main because the
 * "by client:"/"by hook_source:" lines are simply absent from stdout.
 *
 * The fixture supplies its own `dimensions` (this is a stats.ts test, not a
 * lane test — the six lanes' own writers are pinned separately, next to each
 * writer: bash-pre-lane.test.ts, bash-fail-lane.test.ts,
 * session-lane-telemetry.test.ts, todo-lane-telemetry.test.ts,
 * prompt-lane-telemetry-path-free.test.ts), plus one pre-existing row WITHOUT
 * `dimensions` (groups under "(pre-#263)": the column did not exist yet) and
 * one row WITH `dimensions.client: "unknown"` (groups under "unknown": the
 * column existed but the writer had no evidence — `hookClientEvidence()`,
 * #507 Nachbesserung). Neither may disappear or collapse into the other.
 *
 * Run: npx tsx --test packages/daemon/__tests__/context-tax-dimensions.test.ts
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
  {
    kind: "hook_call",
    ts: "2026-09-15T10:00:00.000Z",
    session_id: "s1",
    hint_tokens_est: 100,
    dimensions: { client: "claude-code", hook_source: "pre-tool", experiment_session: null, arm: "unassigned" },
  },
  {
    kind: "todo_hook_call",
    ts: "2026-09-15T10:01:00.000Z",
    session_id: "s2",
    hint_tokens_est: 50,
    dimensions: { client: "codex", hook_source: "todo", experiment_session: null, arm: "unassigned" },
  },
  // Pre-#507 row: no `dimensions` field at all — must fall into the honest
  // "row predates the column" bucket, not silently vanish from the split.
  {
    kind: "prompt_hook_call",
    ts: "2026-09-15T10:02:00.000Z",
    session_id: "s3",
    hint_tokens_est: 30,
  },
  // Post-#507 row with no client EVIDENCE (#507 Nachbesserung): the writer
  // stamped the honest "unknown", distinct from the "(pre-#263)" row above —
  // it must group on its own, not be conflated with the missing-column case.
  {
    kind: "bash_fail_hook_call",
    ts: "2026-09-15T10:03:00.000Z",
    session_id: "s4",
    hint_tokens_est: 20,
    dimensions: { client: "unknown", hook_source: "bash-fail", experiment_session: null, arm: "unassigned" },
  },
];

test("#507: the context-tax split groups emissions by client and by hook_source", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-507-context-tax-"));
  try {
    await writeFile(
      join(logDir, "events-2026-09-15.jsonl"),
      EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const { stdout } = await exec(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "packages/daemon/scripts/stats.ts")],
      { cwd: REPO_ROOT, env: { ...process.env, BASTRA_LOG_PATH: logDir } },
    );

    const lines = stdout.split("\n");
    const byClientAt = lines.findIndex((l) => l.trim() === "by client:");
    const byHookSourceAt = lines.findIndex((l) => l.trim() === "by hook_source:");
    assert.notEqual(byClientAt, -1, `expected a "by client:" section in the context-tax readout:\n${stdout}`);
    assert.notEqual(byHookSourceAt, -1, `expected a "by hook_source:" section in the context-tax readout:\n${stdout}`);

    // Rows sort by total tokens (100, 50, 30, 20). The pre-#507 row groups
    // under "(pre-#263)" instead of disappearing, and the post-#507 row with
    // no client evidence groups under its own "unknown" — the two must not
    // be conflated, or an unmarked live row would misread as historical.
    const clientBlock = lines.slice(byClientAt + 1, byClientAt + 5).join("\n");
    assert.match(clientBlock, /claude-code\s+100\s+1 emissions/);
    assert.match(clientBlock, /codex\s+50\s+1 emissions/);
    assert.match(clientBlock, /\(pre-#263\)\s+30\s+1 emissions/);
    assert.match(clientBlock, /unknown\s+20\s+1 emissions/);

    const sourceBlock = lines.slice(byHookSourceAt + 1, byHookSourceAt + 5).join("\n");
    assert.match(sourceBlock, /pre-tool\s+100\s+1 emissions/);
    assert.match(sourceBlock, /todo\s+50\s+1 emissions/);
    assert.match(sourceBlock, /\(pre-#263\)\s+30\s+1 emissions/);
    assert.match(sourceBlock, /bash-fail\s+20\s+1 emissions/);
  } finally {
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
