/**
 * #1674 — the Bash, TodoWrite and Write/Edit lanes give their loopback recall what remains
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBashPreLane } from "../src/bash-pre-lane.js";
import { runBashFailLane } from "../src/bash-fail-lane.js";
import { runTodoLane } from "../src/todo-lane.js";
import { runWriteLane } from "../src/write-lane.js";
import { runSessionLane } from "../src/session-lane.js";
import { spyLoopbackRequests } from "./loopback-request-spy.js";

/** The lanes' default budgets (BASTRA_HOOK_TIMEOUT_MS unset). */
const BASH_BUDGET_MS = 500;
const TODO_BUDGET_MS = 600;
const WRITE_BUDGET_MS = 600;
const SESSION_BUDGET_MS = 1500;

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
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    lastDelay = Number(ms ?? 0);
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout;
  http.request = ((...args: Parameters<typeof http.request>) => {
    const options = args[0] as { path?: string };
    seen.push({ path: String(options.path ?? ""), ms: lastDelay });
    return realRequest(...args);
  }) as typeof http.request;
  syncBuiltinESMExports();
  let system = 1_800_000_000_000;
  t.mock.method(Date, "now", () => (system += stepMs));
  // The monotonic clock is given too (a millisecond per reading), so the
  // remainder is the same on a loaded machine: a slow run would otherwise
  // use up the budget for real and get the 50 ms floor.
  let monotonic = 1_000;
  t.mock.method(performance, "now", () => (monotonic += 1));
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

const write = async (baseUrl: string) => {
  const cwd = await mkdtemp(join(tmpdir(), "bastra-1674-write-"));
  try {
    return await runWriteLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        session_id: "s1674-write",
        cwd,
        tool_input: { file_path: join(cwd, "src", "deploy.ts"), old_string: "a", new_string: "b" },
      },
      baseUrl
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

test("#1674 write lane: a system clock set back does not extend the recall's budget", async (t) => {
  const ms = deadlineOf(await deadlines(t, -1000, write), "/hook/recall");
  assert.ok(ms > 0 && ms <= WRITE_BUDGET_MS, `recall deadline ${ms} ms, budget ${WRITE_BUDGET_MS} ms`);
});

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

/** Run the SessionStart lane while the system clock moves by `stepMs` on every
 *  read; returns the socket timeout of each loopback call and the budget sent. */
async function sessionDeadlines(
  t: TestContext,
  stepMs: number
): Promise<{ probe: number | undefined; context: number | undefined; timeMs: unknown }> {
  let budget: unknown;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.url === "/hook/session-context") budget = (JSON.parse(body) as { budget?: unknown }).budget;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/health" ? JSON.stringify({ ok: true }) : "{}");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const port = (server.address() as { port: number }).port;
  const spy = spyLoopbackRequests(port);
  const dir = await mkdtemp(join(tmpdir(), "bastra-1674-session-"));
  const env = { BASTRA_TELEMETRY: "off", BASTRA_HOOK_STATE_DIR: join(dir, "state") };
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let system = 1_800_000_000_000;
  t.mock.method(Date, "now", () => (system += stepMs));
  let monotonic = 1_000;
  t.mock.method(performance, "now", () => (monotonic += 1));
  try {
    await runSessionLane(
      { hook_event_name: "SessionStart", source: "startup", cwd: dir, session_id: "s1674-session" },
      `http://127.0.0.1:${port}`,
      undefined,
      async () => null
    );
  } finally {
    t.mock.restoreAll();
    spy.restore();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    await rm(dir, { recursive: true, force: true });
  }
  const timeoutOf = (path: string) => spy.seen.find((s) => s.path === path)?.timeout;
  return { probe: timeoutOf("/health"), context: timeoutOf("/hook/session-context"), timeMs: budget };
}

test("#1674 session lane: a system clock set back does not extend the context call's budget", async (t) => {
  const r = await sessionDeadlines(t, -1000);
  assert.ok(r.context !== undefined && r.context <= SESSION_BUDGET_MS, `context timeout ${r.context} ms`);
  assert.deepEqual(r.timeMs, { time_ms: r.context });
});

test("#1674 session lane: a system clock set forward does not cut both calls to their floors", async (t) => {
  // Floors: 80 ms for the health probe, 60 ms for the context call.
  const r = await sessionDeadlines(t, 10_000);
  assert.ok(r.probe !== undefined && r.probe > 80 && r.probe <= 200, `probe timeout ${r.probe} ms`);
  assert.ok(r.context !== undefined && r.context > 60, `context timeout ${r.context} ms`);
});
