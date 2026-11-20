/**
 * #1674 — the Bash and TodoWrite lanes give their loopback recall what remains
 * of their budget, measured on a monotonic clock. Measured with `Date.now()`,
 * a system clock set back during the lane made the remainder larger than the
 * budget itself; one set forward cut it to its floor.
 *
 * No wall clock: `Date.now` is replaced by a clock that jumps on every read,
 * and the assertion is on the deadline timer each loopback request was armed
 * with (`hook-transport.ts` arms it right before it opens the request).
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { runBashPreLane } from "../src/bash-pre-lane.js";
import { runBashFailLane } from "../src/bash-fail-lane.js";
import { runTodoLane } from "../src/todo-lane.js";

/** The lanes' default budgets (BASTRA_HOOK_TIMEOUT_MS unset). */
const BASH_BUDGET_MS = 500;
const TODO_BUDGET_MS = 600;

/** Run `lane` against a loopback daemon while the system clock moves by
 *  `stepMs` on every read; returns each loopback path with its deadline. */
async function deadlines(
  t: TestContext,
  stepMs: number,
  lane: (baseUrl: string) => Promise<string>
): Promise<Array<{ path: string; ms: number }>> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/hook/act") res.end(JSON.stringify({ matched: 0 }));
      else res.end(JSON.stringify({ hits: [], vault_size: 0, latency_ms: 1, recall_id: "t1674" }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const seen: Array<{ path: string; ms: number }> = [];
  let lastDelay = NaN;
  const realSetTimeout = globalThis.setTimeout;
  const realRequest = http.request;
  const prevTelemetry = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off";
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    lastDelay = Number(ms ?? 0);
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  http.request = ((...args: Parameters<typeof http.request>) => {
    const options = args[0] as { path?: string };
    seen.push({ path: String(options.path ?? ""), ms: lastDelay });
    return realRequest(...args);
  }) as typeof http.request;
  syncBuiltinESMExports();
  let system = 1_800_000_000_000;
  t.mock.method(Date, "now", () => (system += stepMs));
  try {
    await lane(baseUrl);
  } finally {
    t.mock.restoreAll();
    globalThis.setTimeout = realSetTimeout;
    http.request = realRequest;
    syncBuiltinESMExports();
    if (prevTelemetry === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = prevTelemetry;
    await new Promise<void>((ok) => server.close(() => ok()));
  }
  return seen;
}

const deadlineOf = (seen: Array<{ path: string; ms: number }>, path: string): number => {
  const hit = seen.filter((s) => s.path === path);
  assert.equal(hit.length, 1, `one ${path} request, saw ${JSON.stringify(seen)}`);
  return hit[0]!.ms;
};

const bashPre = (baseUrl: string) =>
  runBashPreLane(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      session_id: "s1674-bash-pre",
      tool_input: { command: "git push --force origin main" },
    } as Parameters<typeof runBashPreLane>[0],
    baseUrl
  );

const bashFail = (baseUrl: string) =>
  runBashFailLane(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      session_id: `s1674-bash-fail-${Math.random()}`,
      tool_input: { command: "npm run build" },
      tool_response: { exit_code: 2, stderr: "error TS2304: Cannot find name 'deploy'" },
    } as Parameters<typeof runBashFailLane>[0],
    baseUrl
  );

const todo = (baseUrl: string) =>
  runTodoLane(
    {
      hook_event_name: "PreToolUse",
      tool_name: "TodoWrite",
      bastra_client: "claude-code",
      session_id: "s1674-todo",
      tool_input: {
        todos: [
          { content: "Move the deployment pipeline to the new runner", status: "pending" },
          { content: "Check the telemetry dimensions of the hook lanes", status: "pending" },
          { content: "Write the migration script for the vault indexes", status: "pending" },
        ],
      },
    } as never,
    baseUrl
  );

test("#1674 bash-pre lane: a system clock set back does not extend the recall's budget", async (t) => {
  const ms = deadlineOf(await deadlines(t, -1000, bashPre), "/hook/recall");
  assert.ok(ms > 0 && ms <= BASH_BUDGET_MS, `recall deadline ${ms} ms, budget ${BASH_BUDGET_MS} ms`);
});

test("#1674 bash-fail lane: a system clock set back does not extend the recall's budget", async (t) => {
  const ms = deadlineOf(await deadlines(t, -1000, bashFail), "/hook/recall");
  assert.ok(ms > 0 && ms <= BASH_BUDGET_MS, `recall deadline ${ms} ms, budget ${BASH_BUDGET_MS} ms`);
});

test("#1674 bash-fail lane: a system clock set forward does not cut the act signal to its floor", async (t) => {
  // The act signal gets at most 120 ms of the remainder; a clock jumping
  // ahead by seconds used to leave it the 50 ms floor.
  const ms = deadlineOf(await deadlines(t, 10_000, bashFail), "/hook/act");
  assert.ok(ms > 50 && ms <= 120, `act deadline ${ms} ms`);
});

test("#1674 todo lane: a system clock set back does not extend the recall's budget", async (t) => {
  const ms = deadlineOf(await deadlines(t, -1000, todo), "/hook/recall");
  assert.ok(ms > 0 && ms <= TODO_BUDGET_MS, `recall deadline ${ms} ms, budget ${TODO_BUDGET_MS} ms`);
});
