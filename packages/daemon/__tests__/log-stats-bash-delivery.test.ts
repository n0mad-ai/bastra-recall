import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, renderStats } from "../src/cli/log-stats.js";

const stats = (...rows: Array<Record<string, unknown>>) => renderStats(aggregate(rows), 600);
const acts = (client: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    kind: "hook_act",
    tool_name: "Bash",
    ts: new Date(Date.UTC(2026, 10, 21, 12, i)).toISOString(),
    session_id: client,
    exit_code: 0,
    dimensions: { client, hook_source: "bash-fail" },
  }));
const failure = (kind: string, client: string, extra: Record<string, unknown> = {}) => ({
  kind,
  status: "timeout",
  tool_name: "Bash",
  latency_ms_total: 600,
  ts: "2026-11-21T12:10:00.600Z",
  session_id: client,
  hook_version: "1-stub",
  dimensions: { client },
  ...extra,
});

test("#1739: successful and unmatched Bash commands contribute to observed delivery coverage", () => {
  const rendered = stats(
    ...acts("codex", 100),
    ...acts("claude-code", 50),
    failure("bash_hook_call", "codex"),
    failure("bash_hook_call", "claude-code", { status: "ok", hook_version: undefined, latency_ms_total: 4 }),
    failure("bash_fail_hook_call", "claude-code"),
    failure("bash_fail_hook_call", "codex", { tool_name: "other" })
  );
  assert.match(rendered, /per observed completed Bash command \(hook_act\)/);
  assert.match(rendered, /bash-pre\s+codex: 1\/100 \(1\.00%\)/);
  assert.match(rendered, /bash-post\s+claude-code: 1\/50 \(2\.00%\)/);
  assert.match(rendered, /bash-post\s+codex: 0\/100 \(0\.00%\)/);
  assert.match(rendered, /bash-pre\s+500ms budget .* — NOT EVALUABLE/);
  assert.match(rendered, /bash-post\s+500ms budget .* — NOT EVALUABLE/);
});

test("#1739: missing post coverage and unclassified legacy rows cannot pass as a complete series", () => {
  const rendered = stats(
    ...acts("claude-code", 50),
    failure("bash_hook_call", "claude-code", { dimensions: undefined, tool_name: undefined }),
    failure("bash_fail_hook_call", "claude-code", { dimensions: undefined, tool_name: undefined }),
    failure("bash_hook_call", "codex")
  );
  assert.match(rendered, /bash-pre\s+claude-code: 1\/50 \(2\.00%\)/);
  assert.match(rendered, /bash-pre\s+codex: NOT EVALUABLE/);
  assert.match(rendered, /bash-post\s+claude-code: NOT EVALUABLE/);
  assert.match(rendered, /bash-pre\s+500ms budget .* — NOT EVALUABLE/);
  assert.match(rendered, /bash-post\s+500ms budget .* — NOT EVALUABLE/);
});

test("#1739: one scoped Bash failure on the client and daemon counts once", () => {
  const rendered = stats(...acts("codex", 100), failure("bash_fail_hook_call", "codex"), {
    ...failure("bash_fail_hook_call", "codex"),
    ts: "2026-11-21T12:10:00.610Z",
    hook_version: undefined,
    latency_ms_total: 40,
    dimensions: { client: "codex", hook_source: "bash-fail" },
  });
  assert.match(rendered, /bash-post\s+codex: 1\/100 \(1\.00%\)/);
});

test("#1739: zero failures can pass only with the original p90 sample size", () => {
  const done = acts("codex", 100);
  const details = done.slice(0, 30).map((row) => ({
    ...row,
    kind: "bash_fail_hook_call",
    status: "ok",
    latency_ms_total: 25,
  }));
  const sparse = stats(...done, ...details.slice(0, 1));
  assert.match(sparse, /bash-post\s+500ms budget .* — NOT EVALUABLE \(1 p90 detail sample\(s\)/);
  assert.match(stats(...done, ...details), /bash-post\s+500ms budget .* — PASS/);
  const slow = details.map((row) => ({ ...row, latency_ms_total: 300 }));
  assert.match(
    stats(...done, ...slow, failure("bash_fail_hook_call", "codex")),
    /bash-post\s+500ms budget .* — NOT EVALUABLE \(complete Bash invocation count unavailable · p90 300ms > 200ms\)/
  );
});
