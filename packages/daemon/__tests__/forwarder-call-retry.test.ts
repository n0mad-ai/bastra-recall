/**
 * #1676 — when the forwarder repeats a tool call, and how often the call
 * reaches the daemon.
 *
 * A counting stand-in daemon on loopback (free port) plays each failure. No
 * wall clock: the forwarder's request deadline and its retry pause run on
 * timers this file fires by hand, so every expectation is a count or an
 * exact delay. Other timers (the health probe's) run as usual.
 *
 * Since #1676 the deadline covers the body too, and a call whose response
 * had begun is reported, not repeated. Since #1677 (owner decision B) a call
 * that may have reached the daemon is repeated only for a read-only tool
 * (`readOnlyHint`); a write call is repeated only when the connection was
 * refused, and otherwise ends with an error that says to check first.
 * `load_memory` stands for the read-only tools, `save_memory` for the others.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

type Mode =
  | "ok"
  | "refuse"
  | "reset-on-connect"
  | "silent"
  | "status-500"
  | "status-404"
  | "status-600"
  | "reset-before-headers"
  | "stall-body";

let mode: Mode = "ok";
let arrivals = 0;
let stalled: ServerResponse | null = null;
const sockets = new Set<Socket>();

const server = createServer((req, res) => {
  req.resume();
  // No reuse: a later test must not inherit a socket an earlier one tore down.
  res.shouldKeepAlive = false;
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  arrivals++;
  if (mode === "ok") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ saved: true }));
  } else if (mode === "status-500") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  } else if (mode === "status-404") {
    res.writeHead(404);
    res.end();
  } else if (mode === "status-600") {
    // A complete answer fetch can read but `new Response` refuses (200–599 only).
    res.writeHead(600, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "odd" }));
  } else if (mode === "reset-before-headers") {
    req.socket.destroy();
  } else if (mode === "stall-body") {
    // Announces a length like the daemon's sendJson, then sends one byte of it.
    res.writeHead(200, { "content-type": "application/json", "content-length": "16" });
    res.write("{");
    stalled = res;
  }
  // "silent": never answer.
});
server.on("connection", (socket) => {
  if (mode === "reset-on-connect") {
    socket.destroy();
    return;
  }
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
const port = (server.address() as { port: number }).port;
process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${port}`;
// The endpoint is resolved at import, so the import follows the env.
const { callDaemon, toolErrorText } = await import("../src/mcp-forwarder-calls.js");
const { holdForDaemon, REQUEST_TIMEOUT_MS } = await import("../src/forwarder-daemon-client.js");
const { TOOL_ARG_EXPECTATIONS } = await import("../src/tool-defs.js");
const RETRY_PAUSE_MS = 300;
const UNREACHABLE = new RegExp(`^daemon unreachable at http://127\\.0\\.0\\.1:${port}: `);
const READ = "load_memory";
const WRITE = "save_memory";

/** The error of a write call that may have run and was not repeated (#1677). */
function unclear(tool: string, cause: string): RegExp {
  return new RegExp(
    `^daemon did not answer ${tool} at http://127\\.0\\.0\\.1:${port}: ${cause}\\. ` +
      `It is unclear whether it was saved or carried out, so it was not repeated\\. ` +
      `Check whether it took effect before calling ${tool} again\\.$`
  );
}

/** Nobody listens on the port: a real connection refusal (ECONNREFUSED). */
async function stopListening(): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
}

/** The daemon is back on the same port. */
async function listenAgain(next: Mode): Promise<void> {
  mode = next;
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", () => ok()));
}

/** Yield to the event loop (I/O included) until `cond` holds; counted turns, no clock. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 200_000; turn++) {
    if (cond()) return;
    await new Promise((ok) => setImmediate(ok));
  }
  assert.fail(`never happened: ${what}`);
}

/** Take over the timers with the request deadline's and the retry pause's delay. */
function handTimers(t: TestContext) {
  const pending: { ms: number; fire: () => void; handle: object }[] = [];
  const scheduled: number[] = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const owned = new Set([REQUEST_TIMEOUT_MS, RETRY_PAUSE_MS]);
  t.mock.method(globalThis, "setTimeout", ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === undefined || !owned.has(ms)) return realSet(fn, ms, ...args);
    const handle = {};
    scheduled.push(ms);
    pending.push({ ms, fire: () => fn(...args), handle });
    return handle;
  }) as typeof setTimeout);
  t.mock.method(globalThis, "clearTimeout", ((h: unknown) => {
    const i = pending.findIndex((p) => p.handle === h);
    if (i >= 0) pending.splice(i, 1);
    else realClear(h as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout);
  return {
    scheduled,
    pending,
    /** Wait until a timer of `ms` is set, then let it expire. */
    async fire(ms: number): Promise<void> {
      await until(() => pending.some((p) => p.ms === ms), `a ${ms} ms timer`);
      const i = pending.findIndex((p) => p.ms === ms);
      pending.splice(i, 1)[0]!.fire();
    },
  };
}

/** Watch a promise without awaiting it. */
function track<T>(p: Promise<T>) {
  const s: { done: boolean; value?: T; error?: Error } = { done: false };
  p.then(
    (value) => Object.assign(s, { done: true, value }),
    (error: Error) => Object.assign(s, { done: true, error })
  );
  return s;
}

/** Signals once the forwarder's fetch has its response headers. */
function watchHeaders(t: TestContext) {
  const seen = { headers: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
    const resp = await real(...a);
    seen.headers++;
    return resp;
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return seen;
}

async function reset(t: TestContext, next: Mode): Promise<void> {
  mode = next;
  arrivals = 0;
  if (next === "refuse") await stopListening();
  t.after(async () => {
    stalled = null;
    for (const s of sockets) s.destroy();
    if (!server.listening) await listenAgain("ok");
  });
}

test.after(() => {
  server.closeAllConnections();
  server.close();
});

test("#1677 the tools under test: load_memory declares readOnlyHint, save_memory does not", () => {
  assert.equal(TOOL_ARG_EXPECTATIONS.get(READ)?.readOnly, true);
  assert.equal(TOOL_ARG_EXPECTATIONS.get(WRITE)?.readOnly, false);
});

for (const tool of [WRITE, READ]) {
  test(`#1677 (a) connection refused (${tool}): one retry after 300 ms, then 'daemon unreachable'`, async (t) => {
    await reset(t, "refuse");
    const timers = handTimers(t);
    const call = track(callDaemon(tool, { body: "x" }));
    await timers.fire(RETRY_PAUSE_MS);
    await until(() => call.done, "the call settles");
    assert.match(String(call.error?.message), new RegExp(UNREACHABLE.source + "fetch failed$"));
    assert.deepEqual(timers.scheduled, [REQUEST_TIMEOUT_MS, RETRY_PAUSE_MS, REQUEST_TIMEOUT_MS]);
    assert.equal(arrivals, 0);
  });

  test(`#1677 (a) connection refused, the daemon is back for the retry (${tool}): it arrives once`, async (t) => {
    await reset(t, "refuse");
    const timers = handTimers(t);
    const call = track(callDaemon(tool, { body: "x" }));
    await until(() => timers.pending.some((p) => p.ms === RETRY_PAUSE_MS), "the retry pause");
    await listenAgain("ok");
    await timers.fire(RETRY_PAUSE_MS);
    await until(() => call.done, "the call settles");
    assert.deepEqual(call.value, { saved: true });
    assert.equal(arrivals, 1);
  });

  test(`#1677 (a) the daemon restarts, through the hold-the-call gate (${tool}): it arrives once`, async (t) => {
    await reset(t, "refuse");
    const timers = handTimers(t);
    // The gate's health probe finds the restarted daemon.
    const real = globalThis.fetch;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
      if (String(a[0]).endsWith("/health") && !server.listening) await listenAgain("ok");
      return await real(...a);
    }) as typeof fetch;
    t.after(() => {
      globalThis.fetch = real;
    });
    const call = track(holdForDaemon(() => callDaemon(tool, { body: "x" })));
    await timers.fire(RETRY_PAUSE_MS);
    await until(() => call.done, "the call settles");
    assert.deepEqual(call.value, { saved: true });
    assert.equal(arrivals, 1);
  });
}

test("#1677 (a) a reset on connect is not a refusal: a write call is not repeated", async (t) => {
  await reset(t, "reset-on-connect");
  const timers = handTimers(t);
  const call = track(holdForDaemon(() => callDaemon(WRITE, { body: "x" })));
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), unclear(WRITE, "fetch failed"));
  assert.deepEqual(timers.scheduled, [REQUEST_TIMEOUT_MS]);
});

test("#1677 (a) a daemon that receives a write call and never answers: it arrives once, the error says to check first", async (t) => {
  await reset(t, "silent");
  const timers = handTimers(t);
  const call = track(callDaemon(WRITE, { body: "x" }));
  await until(() => arrivals === 1, "first arrival");
  await timers.fire(REQUEST_TIMEOUT_MS);
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), unclear(WRITE, "This operation was aborted"));
  assert.deepEqual(timers.scheduled, [REQUEST_TIMEOUT_MS]);
  assert.equal(arrivals, 1);
});

test("#1677 a task action that may have run answers with the check-first message, not `unavailable, retryable`", async (t) => {
  await reset(t, "silent");
  const timers = handTimers(t);
  const call = track(callDaemon("task_create", {}));
  await until(() => arrivals === 1, "first arrival");
  await timers.fire(REQUEST_TIMEOUT_MS);
  await until(() => call.done, "the call settles");
  assert.match(toolErrorText("task_create", call.error), unclear("task_create", "This operation was aborted"));
  assert.equal(arrivals, 1);
  // Any other task failure keeps its task failure body.
  assert.equal(JSON.parse(toolErrorText("task_create", new Error("x"))).code, "unavailable");
});

test("#1677 (a) a tool this build does not know counts as writing: it arrives once", async (t) => {
  await reset(t, "silent");
  const timers = handTimers(t);
  const call = track(holdForDaemon(() => callDaemon("no_such_tool", {})));
  await until(() => arrivals === 1, "first arrival");
  await timers.fire(REQUEST_TIMEOUT_MS);
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), unclear("no_such_tool", "This operation was aborted"));
  assert.equal(arrivals, 1);
});

test("#1677 (a) a read-only call the daemon never answers: it reaches it twice, as before", async (t) => {
  await reset(t, "silent");
  const timers = handTimers(t);
  const call = track(callDaemon(READ, { id: "x" }));
  await until(() => arrivals === 1, "first arrival");
  await timers.fire(REQUEST_TIMEOUT_MS);
  await timers.fire(RETRY_PAUSE_MS);
  await until(() => arrivals === 2, "second arrival");
  await timers.fire(REQUEST_TIMEOUT_MS);
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), new RegExp(UNREACHABLE.source + "This operation was aborted$"));
  assert.deepEqual(timers.scheduled, [REQUEST_TIMEOUT_MS, RETRY_PAUSE_MS, REQUEST_TIMEOUT_MS]);
  assert.equal(arrivals, 2);
});

test("#1677 (a) through the hold-the-call gate: a write call to a never-answering, healthy daemon arrives once", async (t) => {
  await reset(t, "silent");
  const timers = handTimers(t);
  const call = track(holdForDaemon(() => callDaemon(WRITE, { body: "x" })));
  await until(() => arrivals === 1, "first arrival");
  await timers.fire(REQUEST_TIMEOUT_MS);
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), unclear(WRITE, "This operation was aborted"));
  assert.equal(arrivals, 1);
});

test("#1677 (a) through the hold-the-call gate: a read-only call to a never-answering, healthy daemon arrives four times, as before", async (t) => {
  await reset(t, "silent");
  const timers = handTimers(t);
  const call = track(holdForDaemon(() => callDaemon(READ, { id: "x" })));
  for (let n = 1; n <= 4; n++) {
    await until(() => arrivals === n, `arrival ${n}`);
    await timers.fire(REQUEST_TIMEOUT_MS);
    if (n % 2 === 1) await timers.fire(RETRY_PAUSE_MS);
  }
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), new RegExp(UNREACHABLE.source + "This operation was aborted$"));
  assert.equal(arrivals, 4);
});

test("#1676 (b) an error status is reported once, never repeated", async (t) => {
  await reset(t, "status-500");
  const timers = handTimers(t);
  await assert.rejects(callDaemon("save_memory", { body: "x" }), { message: "boom" });
  assert.equal(arrivals, 1);
  mode = "status-404";
  await assert.rejects(callDaemon("save_memory", { body: "x" }), { message: "HTTP 404" });
  assert.equal(arrivals, 2);
  assert.equal(timers.scheduled.includes(RETRY_PAUSE_MS), false);
});

test("#1676 (b) a complete answer the forwarder cannot rebuild is reported once, never repeated", async (t) => {
  await reset(t, "status-600");
  const timers = handTimers(t);
  await assert.rejects(callDaemon("save_memory", { body: "x" }), (err: Error) => !/unreachable/.test(err.message));
  assert.equal(arrivals, 1);
  assert.equal(timers.scheduled.includes(RETRY_PAUSE_MS), false);
});

test("#1676 (c) headers arrive, the body stalls: the deadline ends it with the abort text, the call is not repeated", async (t) => {
  await reset(t, "stall-body");
  const timers = handTimers(t);
  const seen = watchHeaders(t);
  const call = track(callDaemon("save_memory", { body: "x" }));
  await until(() => seen.headers === 1, "response headers");
  // The deadline outlives the headers now; before #1676 it was cleared with them.
  assert.equal(call.done, false);
  await timers.fire(REQUEST_TIMEOUT_MS);
  await until(() => call.done, "the call settles");
  assert.equal(call.error?.message, "This operation was aborted");
  assert.equal(arrivals, 1);
  assert.deepEqual(timers.scheduled, [REQUEST_TIMEOUT_MS]);
  // Nothing left that keeps the forwarder process alive: no timer, no open read.
  assert.deepEqual(timers.pending, []);
  await until(() => sockets.size === 0, "the stalled connection is closed");
});

test("#1676 (c) …and through the hold-the-call gate, a write tool still reaches the daemon once", async (t) => {
  await reset(t, "stall-body");
  const timers = handTimers(t);
  const seen = watchHeaders(t);
  const call = track(holdForDaemon(() => callDaemon("save_memory", { body: "x" })));
  await until(() => seen.headers === 1, "response headers");
  await timers.fire(REQUEST_TIMEOUT_MS);
  await until(() => call.done, "the call settles");
  assert.equal(call.error?.message, "This operation was aborted");
  assert.equal(arrivals, 1);
});

test("#1676 (c) a body that stalls on the retry ends the call there, it is not handed on as 'unreachable'", async (t) => {
  // Since #1677 only a read-only call reaches a retry after it was sent.
  await reset(t, "silent");
  const timers = handTimers(t);
  const seen = watchHeaders(t);
  const call = track(holdForDaemon(() => callDaemon(READ, { id: "x" })));
  await until(() => arrivals === 1, "first arrival");
  mode = "stall-body";
  await timers.fire(REQUEST_TIMEOUT_MS);
  await timers.fire(RETRY_PAUSE_MS);
  await until(() => seen.headers === 1, "headers of the retry");
  await timers.fire(REQUEST_TIMEOUT_MS);
  await until(() => call.done, "the call settles");
  assert.equal(call.error?.message, "This operation was aborted");
  // The unanswered first attempt is repeated; the stalled answer of the
  // second is not — before #1676 the gate made it four.
  assert.equal(arrivals, 2);
});

test("#1676 (d) the connection drops after the headers: reported once as 'terminated', not repeated, no timer left", async (t) => {
  await reset(t, "stall-body");
  const timers = handTimers(t);
  const seen = watchHeaders(t);
  const call = track(holdForDaemon(() => callDaemon("save_memory", { body: "x" })));
  await until(() => seen.headers === 1, "response headers");
  stalled?.socket?.destroy();
  await until(() => call.done, "the call settles");
  assert.equal(call.error?.message, "terminated");
  assert.equal(arrivals, 1);
  assert.equal(timers.scheduled.includes(RETRY_PAUSE_MS), false);
  assert.deepEqual(timers.pending, []);
});

test("#1677 (d) the connection drops after the daemon received a write call, before any header: it arrives once", async (t) => {
  await reset(t, "reset-before-headers");
  const timers = handTimers(t);
  const call = track(callDaemon(WRITE, { body: "x" }));
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), unclear(WRITE, "fetch failed"));
  assert.deepEqual(timers.scheduled, [REQUEST_TIMEOUT_MS]);
  assert.equal(arrivals, 1);
});

test("#1677 (d) …a read-only call: it reaches the daemon twice, as before", async (t) => {
  await reset(t, "reset-before-headers");
  const timers = handTimers(t);
  const call = track(callDaemon(READ, { id: "x" }));
  await until(() => arrivals === 1, "first arrival");
  await timers.fire(RETRY_PAUSE_MS);
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), new RegExp(UNREACHABLE.source + "fetch failed$"));
  assert.equal(arrivals, 2);
});

test("#1677 (d) …through the hold-the-call gate: a write call arrives once", async (t) => {
  await reset(t, "reset-before-headers");
  handTimers(t);
  const call = track(holdForDaemon(() => callDaemon(WRITE, { body: "x" })));
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), unclear(WRITE, "fetch failed"));
  assert.equal(arrivals, 1);
});

test("#1677 (d) …through the hold-the-call gate: a read-only call arrives four times, as before", async (t) => {
  await reset(t, "reset-before-headers");
  const timers = handTimers(t);
  const call = track(holdForDaemon(() => callDaemon(READ, { id: "x" })));
  await until(() => arrivals === 1, "first arrival");
  await timers.fire(RETRY_PAUSE_MS);
  await until(() => arrivals === 3, "third arrival");
  await timers.fire(RETRY_PAUSE_MS);
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), new RegExp(UNREACHABLE.source + "fetch failed$"));
  assert.equal(arrivals, 4);
});

test("#1676 a healthy answer: one arrival, no timer left behind", async (t) => {
  await reset(t, "ok");
  const timers = handTimers(t);
  assert.deepEqual(await callDaemon("save_memory", { body: "x" }), { saved: true });
  assert.equal(arrivals, 1);
  assert.deepEqual(timers.scheduled, [REQUEST_TIMEOUT_MS]);
  assert.deepEqual(timers.pending, []);
});
