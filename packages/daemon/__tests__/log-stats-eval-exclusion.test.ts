/**
 * #619 — `bastra logs --stats` gets the same exclusion as `scripts/stats.ts`:
 * a row whose stamped `dimensions.client === "eval"` is dropped from the
 * default report and reported as excluded (count + context-tax tokens);
 * `--include-eval` brings it back.
 *
 * Run: node --import tsx --test packages/daemon/__tests__/log-stats-eval-exclusion.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdLogStats } from "../src/cli/log-stats.js";

const EVENTS = [
  {
    kind: "hook_call",
    ts: "2026-09-09T10:00:00.000Z",
    session_id: "prod-1",
    status: "ok",
    hint_count: 1,
    latency_ms_total: 10,
    dimensions: { client: "claude-code", hook_source: "pre-tool", experiment_session: null, arm: "unassigned" },
  },
  // A hook-lane row marked eval — a future scripted lane caller, not just the
  // "recall"-kind probes that caused #619. Both readouts share one filter
  // (#619 acceptance: "per-client and per-lane splits use the same filter").
  {
    kind: "hook_call",
    ts: "2026-09-09T10:01:00.000Z",
    session_id: "eval-1",
    status: "ok",
    hint_count: 1,
    latency_ms_total: 10,
    hint_tokens_est: 4000,
    dimensions: { client: "eval", hook_source: "unknown", experiment_session: null, arm: "unassigned" },
  },
];

async function withCapturedStdout(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return out;
}

test("#619: bastra logs --stats excludes eval-marked rows by default and reports them", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-619-logstats-"));
  const prevLog = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  try {
    await writeFile(
      join(logDir, "events-2026-09-09.jsonl"),
      EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const defaultOut = await withCapturedStdout(() => cmdLogStats({ sinceMs: 30 * 86_400_000 }).then(() => undefined));
    assert.match(defaultOut, /1 call\(s\)/, `expected only the production call counted:\n${defaultOut}`);
    assert.match(
      defaultOut,
      /excluded as eval\/synthetic \(#619\): 1 events, ~4000 context-tax tokens — rerun with --include-eval to include them/,
      defaultOut,
    );

    const includeOut = await withCapturedStdout(() =>
      cmdLogStats({ sinceMs: 30 * 86_400_000, includeEval: true }).then(() => undefined),
    );
    assert.match(includeOut, /2 call\(s\)/, `expected both calls with --include-eval:\n${includeOut}`);
    assert.match(
      includeOut,
      /eval\/synthetic traffic included \(#619\): 1 events, ~4000 context-tax tokens/,
      includeOut,
    );
  } finally {
    if (prevLog === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = prevLog;
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
