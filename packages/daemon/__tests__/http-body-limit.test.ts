/**
 * #62 — an oversized request body must fail as a size limit, not as a dead
 * daemon.
 *
 * The measured failure: `readJsonBody` called `req.destroy()` the moment the
 * cap was crossed, so the route's own `.catch(…)` wrote its JSON error into a
 * socket that no longer existed. The caller saw no response at all — on the
 * forwarder path that reads as
 * `daemon unreachable at http://127.0.0.1:6723: fetch failed`, and
 * `callDaemon` retries the identical oversized payload once before reporting
 * it. A long `save_memory` therefore died blaming a daemon that answered
 * `/health` with 200 in the same second.
 *
 * Run: npx tsx --test packages/daemon/__tests__/http-body-limit.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";

import { readJsonBody, sendJson, MAX_BODY_BYTES } from "../src/http-util.js";

/** A server shaped exactly like the `/api/v1/<tool>` route: read the body,
 *  answer 200 with it, and turn any read failure into a 400 JSON error. */
function startRoute(maxBytes: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    readJsonBody(req, maxBytes)
      .then((body) => sendJson(res, 200, { ok: true, keys: Object.keys(body) }))
      .catch((err: Error) => sendJson(res, 400, { error: err.message }));
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("#62: an oversized body gets a real HTTP answer, not a destroyed socket", async () => {
  const route = await startRoute(4096);
  try {
    const resp = await fetch(`http://127.0.0.1:${route.port}/api/v1/save_memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "x".repeat(50_000) }),
    });
    assert.equal(resp.status, 400);
    const json = (await resp.json()) as { error?: string };
    assert.match(String(json.error), /body too large/);
  } finally {
    await route.close();
  }
});

test("#62: the refusal names the size limit and rules out a transport failure", async () => {
  const route = await startRoute(4096);
  try {
    const resp = await fetch(`http://127.0.0.1:${route.port}/api/v1/save_memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "y".repeat(50_000) }),
    });
    const { error } = (await resp.json()) as { error: string };
    // The agent reading this must not conclude "the daemon is gone and I
    // should retry" — that is the misdiagnosis the destroyed socket produced.
    assert.match(error, /4096 bytes/);
    assert.match(error, /Nothing was saved or changed/);
    assert.match(error, /not a transport or daemon failure/);
  } finally {
    await route.close();
  }
});

test("#62: the connection survives a refusal — the next request is served normally", async () => {
  const route = await startRoute(4096);
  try {
    const agentBody = JSON.stringify({ body: "z".repeat(50_000) });
    const first = await fetch(`http://127.0.0.1:${route.port}/api/v1/save_memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: agentBody,
    });
    assert.equal(first.status, 400);
    await first.json();

    // Same origin, keep-alive pool: a destroyed socket used to poison this.
    const second = await fetch(`http://127.0.0.1:${route.port}/api/v1/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "still alive" }),
    });
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json()) as unknown, { ok: true, keys: ["query"] });
  } finally {
    await route.close();
  }
});

test("#62: a body inside the limit is unaffected", async () => {
  const route = await startRoute(MAX_BODY_BYTES);
  try {
    const resp = await fetch(`http://127.0.0.1:${route.port}/api/v1/save_memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t", body: "b".repeat(200_000) }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual((await resp.json()) as unknown, { ok: true, keys: ["title", "body"] });
  } finally {
    await route.close();
  }
});

test("#62: an empty and a malformed body keep their existing verdicts", async () => {
  const route = await startRoute(4096);
  try {
    const empty = await fetch(`http://127.0.0.1:${route.port}/api/v1/recall`, { method: "POST" });
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()) as unknown, { ok: true, keys: [] });

    const broken = await fetch(`http://127.0.0.1:${route.port}/api/v1/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(broken.status, 400);
    assert.match(String(((await broken.json()) as { error: string }).error), /invalid JSON body/);
  } finally {
    await route.close();
  }
});
