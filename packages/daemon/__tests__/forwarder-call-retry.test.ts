/**
 * #1676 — when the forwarder repeats a tool call, and how often the call
 * reaches the daemon.
 *
 * A counting stand-in daemon on loopback (free port) plays each failure. No
 * wall clock: the forwarder's request deadline and its retry pause run on
 * timers this file fires by hand, so every expectation is a count or an
 * exact delay. Other timers (the health probe's) run as usual.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

type Mode = "ok" | "refuse" | "silent" | "status-500" | "status-404" | "reset-before-headers" | "stall-body";

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
  if (mode === "refuse") {
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
const { callDaemon } = await import("../src/mcp-forwarder-calls.js");
const { holdForDaemon, REQUEST_TIMEOUT_MS } = await import("../src/forwarder-daemon-client.js");
const RETRY_PAUSE_MS = 300;
const UNREACHABLE = new RegExp(`^daemon unreachable at http://127\\.0\\.0\\.1:${port}: `);

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

function reset(t: TestContext, next: Mode): void {
  mode = next;
  arrivals = 0;
  t.after(() => {
    stalled = null;
    for (const s of sockets) s.destroy();
  });
}

test.after(() => {
  server.closeAllConnections();
  server.close();
});

test("#1676 (a) a daemon that takes no connection: one retry after 300 ms, then 'daemon unreachable'", async (t) => {
  reset(t, "refuse");
  const timers = handTimers(t);
  const call = track(callDaemon("save_memory", { body: "x" }));
  await timers.fire(RETRY_PAUSE_MS);
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), new RegExp(UNREACHABLE.source + "fetch failed$"));
  assert.deepEqual(timers.scheduled, [REQUEST_TIMEOUT_MS, RETRY_PAUSE_MS, REQUEST_TIMEOUT_MS]);
  assert.equal(arrivals, 0);
});

test("#1676 (a) a daemon that receives the call and never answers: the call reaches it twice", async (t) => {
  reset(t, "silent");
  const timers = handTimers(t);
  const call = track(callDaemon("save_memory", { body: "x" }));
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

test("#1676 (a) through the hold-the-call gate: a never-answering, healthy daemon receives the call four times", async (t) => {
  reset(t, "silent");
  const timers = handTimers(t);
  const call = track(holdForDaemon(() => callDaemon("save_memory", { body: "x" })));
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
  reset(t, "status-500");
  const timers = handTimers(t);
  await assert.rejects(callDaemon("save_memory", { body: "x" }), { message: "boom" });
  assert.equal(arrivals, 1);
  mode = "status-404";
  await assert.rejects(callDaemon("save_memory", { body: "x" }), { message: "HTTP 404" });
  assert.equal(arrivals, 2);
  assert.equal(timers.scheduled.includes(RETRY_PAUSE_MS), false);
});

test("#1676 (c) headers arrive, the body stalls: today the call never settles", async (t) => {
  reset(t, "stall-body");
  const timers = handTimers(t);
  const seen = watchHeaders(t);
  const call = track(callDaemon("save_memory", { body: "x" }));
  await until(() => seen.headers === 1, "response headers");
  // The deadline was cleared with the headers: no timer is left to end the wait.
  assert.deepEqual(timers.pending, []);
  for (let turn = 0; turn < 1000; turn++) await new Promise((ok) => setImmediate(ok));
  assert.equal(call.done, false);
  assert.equal(arrivals, 1);
  stalled?.socket?.destroy();
  await until(() => call.done, "the call settles once the socket is gone");
});

test("#1676 (d) the connection drops after the headers: reported once as 'terminated', not repeated", async (t) => {
  reset(t, "stall-body");
  const timers = handTimers(t);
  const seen = watchHeaders(t);
  const call = track(holdForDaemon(() => callDaemon("save_memory", { body: "x" })));
  await until(() => seen.headers === 1, "response headers");
  stalled?.socket?.destroy();
  await until(() => call.done, "the call settles");
  assert.equal(call.error?.message, "terminated");
  assert.equal(arrivals, 1);
  assert.equal(timers.scheduled.includes(RETRY_PAUSE_MS), false);
});

test("#1676 (d) the connection drops after the daemon received the call, before any header: it reaches the daemon twice", async (t) => {
  reset(t, "reset-before-headers");
  const timers = handTimers(t);
  const call = track(callDaemon("save_memory", { body: "x" }));
  await until(() => arrivals === 1, "first arrival");
  await timers.fire(RETRY_PAUSE_MS);
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), new RegExp(UNREACHABLE.source + "fetch failed$"));
  assert.equal(arrivals, 2);
});

test("#1676 (d) …and through the hold-the-call gate, four times", async (t) => {
  reset(t, "reset-before-headers");
  const timers = handTimers(t);
  const call = track(holdForDaemon(() => callDaemon("save_memory", { body: "x" })));
  await until(() => arrivals === 1, "first arrival");
  await timers.fire(RETRY_PAUSE_MS);
  await until(() => arrivals === 3, "third arrival");
  await timers.fire(RETRY_PAUSE_MS);
  await until(() => call.done, "the call settles");
  assert.match(String(call.error?.message), new RegExp(UNREACHABLE.source + "fetch failed$"));
  assert.equal(arrivals, 4);
});

test("#1676 a healthy answer: one arrival, no timer left behind", async (t) => {
  reset(t, "ok");
  const timers = handTimers(t);
  assert.deepEqual(await callDaemon("save_memory", { body: "x" }), { saved: true });
  assert.equal(arrivals, 1);
  assert.deepEqual(timers.scheduled, [REQUEST_TIMEOUT_MS]);
  assert.deepEqual(timers.pending, []);
});
