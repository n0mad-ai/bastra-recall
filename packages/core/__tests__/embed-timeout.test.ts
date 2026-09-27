/**
 * Embedding requests have a deadline.
 *
 * A provider that accepts the connection and never answers used to leave
 * `embed()` pending forever: no rejection, so the breaker (which counts
 * failures, not hangs) never opened, and every call parked another socket and
 * promise. These tests hold a request open and expect a rejection within the
 * provider's `timeoutMs`.
 *
 * Revert-check: drop the timer in `postJsonKeepAlive` (Ollama) or the signal
 * on the OpenAI `fetch` — the matching test fails on its own guard ("no
 * rejection within …") instead of passing. Arm the Ollama timer before
 * `request()` again and the `ftp:` test fails with the ReferenceError.
 *
 * Run: npx tsx --test packages/core/__tests__/embed-timeout.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { OllamaEmbeddingProvider, OpenAIEmbeddingProvider } from "../src/embeddings.js";
import {
  EMBED_REQUEST_TIMEOUT_MS,
  EMBED_TIMEOUT_PER_TEXT_MS,
  embedDeadlineMs,
} from "../src/embedding-providers.js";

/** Server that answers /api/embed after `delayMs`, or never when `delayMs` is
 *  null. `holdFirst` holds only the first request and answers the rest.
 *  `connections()` counts the TCP connections the server has accepted. */
async function ollamaStub(
  delayMs: number | null,
  opts: { holdFirst?: boolean } = {},
): Promise<{ url: string; close: () => Promise<void>; connections: () => number }> {
  const sockets = new Set<Socket>();
  let connections = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    const nth = ++requests;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (delayMs === null || (opts.holdFirst && nth === 1)) return; // accept and hold
      const n = (JSON.parse(body) as { input: string[] }).input.length;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: Array.from({ length: n }, () => [0.1, 0.2, 0.3]) }));
      }, delayMs);
    });
  });
  server.on("connection", (s) => {
    connections++;
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Settle `p`, or fail if it has not settled within `ms`. The timer is ref'd on
 *  purpose, so a never-settling promise fails here instead of being cancelled. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; err: Error }> {
  let guard: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    guard = setTimeout(() => reject(new Error(`no rejection within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([
      p.then(
        (value) => ({ ok: true as const, value }),
        (err: Error) => ({ ok: false as const, err }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(guard);
  }
}

test("Ollama: a server that never answers rejects after timeoutMs", async () => {
  const stub = await ollamaStub(null);
  try {
    const provider = new OllamaEmbeddingProvider({ baseURL: stub.url, dim: 3, timeoutMs: 200 });
    const t0 = Date.now();
    const r = await settleWithin(provider.embed(["hello"]), 3000);
    assert.equal(r.ok, false, "embed resolved against a server that never answered");
    if (!r.ok) assert.match(r.err.message, /timed out after 200 ms/);
    assert.ok(Date.now() - t0 < 2000, `rejected after ${Date.now() - t0} ms`);
  } finally {
    await stub.close();
  }
});

test("Ollama: after a timeout the same endpoint answers again on one fresh keep-alive socket", async () => {
  // One server: the first request hangs, later ones answer after 50 ms. The
  // timed-out socket is destroyed; the next two calls must both succeed and
  // share ONE new connection — the agent dropped the dead socket and keep-alive
  // works again afterwards.
  const stub = await ollamaStub(50, { holdFirst: true });
  try {
    const provider = new OllamaEmbeddingProvider({ baseURL: stub.url, dim: 3, timeoutMs: 300 });
    await assert.rejects(provider.embed(["x"]), /timed out/);
    const first = await provider.embed(["a", "b"]);
    const second = await provider.embed(["c"]);
    assert.equal(first.length, 2);
    assert.equal(second.length, 1);
    assert.equal(stub.connections(), 2, "expected the hung socket plus one reused fresh socket");
  } finally {
    await stub.close();
  }
});

test("Ollama: a URL http.request rejects synchronously leaves no timer behind", async () => {
  // `ftp:` passes the loopback guard but makes http.request throw before a
  // request exists. A deadline timer armed before that would fire into an
  // uninitialised `req` and crash the process with an uncaught ReferenceError.
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on("uncaughtException", onUncaught);
  try {
    const provider = new OllamaEmbeddingProvider({ baseURL: "ftp://127.0.0.1:11434", dim: 3, timeoutMs: 50 });
    await assert.rejects(provider.embed(["x"]), /protocol/i);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(uncaught, [], "a stray deadline timer fired after the synchronous failure");
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

test("batch deadline grows with the number of texts", () => {
  assert.equal(embedDeadlineMs(EMBED_REQUEST_TIMEOUT_MS, 1), EMBED_REQUEST_TIMEOUT_MS);
  assert.equal(embedDeadlineMs(EMBED_REQUEST_TIMEOUT_MS, 50), EMBED_REQUEST_TIMEOUT_MS + 49 * EMBED_TIMEOUT_PER_TEXT_MS);
});

test("OpenAI: a fetch that never answers is aborted after timeoutMs", async () => {
  const realFetch = globalThis.fetch;
  let sawSignal = false;
  // Stands in for a hung endpoint: settles only when the caller aborts.
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      sawSignal = true;
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
    })) as typeof fetch;
  try {
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test", dim: 3, timeoutMs: 200 });
    const r = await settleWithin(provider.embed(["hello"]), 3000);
    assert.equal(r.ok, false, "embed resolved against a fetch that never answered");
    assert.ok(sawSignal, "fetch was called without a signal");
    if (!r.ok) assert.match(r.err.message, /timed out after 200 ms/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
