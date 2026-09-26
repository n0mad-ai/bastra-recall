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
 * rejection within …") instead of passing.
 *
 * Run: npx tsx --test packages/core/__tests__/embed-timeout.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { OllamaEmbeddingProvider, OpenAIEmbeddingProvider } from "../src/embeddings.js";

/** Server that answers /api/embed after `delayMs`, or never when `delayMs` is null. */
async function ollamaStub(delayMs: number | null): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (delayMs === null) return; // accept and hold
      const n = (JSON.parse(body) as { input: string[] }).input.length;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: Array.from({ length: n }, () => [0.1, 0.2, 0.3]) }));
      }, delayMs);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
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

test("Ollama: a slow answer inside timeoutMs still resolves, and the socket is reusable after a timeout", async () => {
  const hang = await ollamaStub(null);
  const slow = await ollamaStub(50);
  try {
    const hung = new OllamaEmbeddingProvider({ baseURL: hang.url, dim: 3, timeoutMs: 100 });
    await assert.rejects(hung.embed(["x"]), /timed out/);
    const provider = new OllamaEmbeddingProvider({ baseURL: slow.url, dim: 3, timeoutMs: 1000 });
    const first = await provider.embed(["a", "b"]);
    const second = await provider.embed(["c"]);
    assert.equal(first.length, 2);
    assert.equal(second.length, 1);
  } finally {
    await hang.close();
    await slow.close();
  }
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
