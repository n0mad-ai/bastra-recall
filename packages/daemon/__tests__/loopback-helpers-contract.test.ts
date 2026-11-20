/**
 * #1508 — characterization of the daemon's loopback self-calls, pinned BEFORE
 * they share `prompt-loopback.ts`: the request each one makes (method, path
 * with query, body) and its answer for 200, non-200, garbage, a stalled
 * server and a refused connection. Also the write and plan lanes' shared
 * `/hook/recall` call (`postHookRecall`, which sends the task header) and
 * what each transport does with a large answer and a long error body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { fetchFloors, fetchTaxonomy, postSessionContext, probeHealth } from "../src/session-hook-http.js";
import { reportHinted } from "../src/hook-hinted.js";
import { postHookRecall } from "../src/hook-recall-post.js";
import type { HookRecallRequest } from "../src/hook-surface.js";

interface Seen {
  method: string;
  url: string;
  type: string | undefined;
  task: string | string[] | undefined;
  body: string;
}

/** `reply` null = never answer (a stalled daemon). */
async function server(
  reply: { status: number; body: string } | null
): Promise<{ s: Server; base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        type: req.headers["content-type"],
        task: req.headers["x-bastra-task-authorization"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (!reply) return;
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok()));
  const addr = s.address();
  return { s, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, seen };
}

function close(s: Server): Promise<void> {
  s.closeAllConnections();
  return new Promise((ok) => s.close(() => ok()));
}

async function refusedBase(): Promise<string> {
  const { s, base } = await server({ status: 200, body: "{}" });
  await close(s);
  return base;
}

test("fetchFloors: GET with the form-encoded scope, floors on 200", async (t) => {
  const d = await server({ status: 200, body: JSON.stringify({ floors: [{ id: "f" }] }) });
  t.after(() => close(d.s));
  assert.deepEqual(await fetchFloors(d.base, "a b/ü'+&", 500), [{ id: "f" }]);
  assert.deepEqual(await fetchFloors(d.base, null, 500), [{ id: "f" }]);
  assert.deepEqual(
    d.seen.map((r) => [r.method, r.url, r.body]),
    [
      ["GET", "/hook/floors?scope=a+b%2F%C3%BC%27%2B%26", ""],
      ["GET", "/hook/floors", ""],
    ]
  );
});

test("GET helpers: non-200, garbage, wrong shape, stall and refusal fall back", async (t) => {
  for (const reply of [
    { status: 500, body: JSON.stringify({ floors: [], conventions: [], ok: true }) },
    { status: 200, body: "not json" },
    { status: 200, body: "null" },
    { status: 200, body: JSON.stringify({ floors: 1, conventions: "x", ok: false }) },
  ]) {
    const d = await server(reply);
    t.after(() => close(d.s));
    assert.deepEqual(await fetchFloors(d.base, null, 500), [], JSON.stringify(reply));
    assert.deepEqual(await fetchTaxonomy(d.base, 500), [], JSON.stringify(reply));
    assert.equal(await probeHealth(d.base, 500), null, JSON.stringify(reply));
  }
  const stalled = await server(null);
  t.after(() => close(stalled.s));
  const started = Date.now();
  assert.deepEqual(await fetchTaxonomy(stalled.base, 150), []);
  assert.equal(await probeHealth(stalled.base, 150), null);
  assert.ok(Date.now() - started < 1500);
  const refused = await refusedBase();
  assert.deepEqual(await fetchFloors(refused, "p", 500), []);
  assert.equal(await probeHealth(refused, 500), null);
});

test("taxonomy and health: GET paths and the 200 answers", async (t) => {
  const d = await server({
    status: 200,
    body: JSON.stringify({ conventions: [{ id: "c" }], ok: true, update_available: null }),
  });
  t.after(() => close(d.s));
  assert.deepEqual(await fetchTaxonomy(d.base, 500), [{ id: "c" }]);
  assert.deepEqual(await probeHealth(d.base, 500), { conventions: [{ id: "c" }], ok: true, update_available: null });
  assert.deepEqual(
    d.seen.map((r) => [r.method, r.url]),
    [
      ["GET", "/hook/taxonomy"],
      ["GET", "/health"],
    ]
  );
});

test("postSessionContext: POSTs the body with assembly_only, rejects with the daemon's text", async (t) => {
  const ok = await server({ status: 200, body: JSON.stringify({ data: { onboarding: true } }) });
  const bad = await server({ status: 503, body: "busy" });
  const garbage = await server({ status: 200, body: "nope" });
  const stalled = await server(null);
  t.after(async () => {
    for (const d of [ok, bad, garbage, stalled]) await close(d.s);
  });
  assert.deepEqual(await postSessionContext(ok.base, { project: "p" }, 500), { data: { onboarding: true } });
  assert.deepEqual(
    ok.seen.map((r) => [r.method, r.url, r.type, r.body]),
    [["POST", "/hook/session-context", "application/json; charset=utf-8", '{"project":"p","assembly_only":true}']]
  );
  await assert.rejects(postSessionContext(bad.base, {}, 500), /^Error: HTTP 503: busy$/);
  await assert.rejects(postSessionContext(garbage.base, {}, 500), /^Error: invalid JSON response from daemon$/);
  await assert.rejects(postSessionContext(stalled.base, {}, 150), /^Error: timeout$/);
  await assert.rejects(postSessionContext(await refusedBase(), {}, 500), { code: "ECONNREFUSED" });
});

test("reportHinted: one POST with ids and drafts, resolves on every outcome", async (t) => {
  const d = await server({ status: 200, body: "{}" });
  const bad = await server({ status: 500, body: "x" });
  const stalled = await server(null);
  t.after(async () => {
    for (const x of [d, bad, stalled]) await close(x.s);
  });
  await reportHinted(d.base, [], "s");
  await reportHinted(d.base, ["a"], "s", 500, { ids: ["d1", "d2", "d3"], input: "in" });
  assert.deepEqual(
    d.seen.map((r) => [r.method, r.url, r.type, r.body]),
    [
      [
        "POST",
        "/hook/hinted",
        "application/json; charset=utf-8",
        '{"ids":["a"],"session_id":"s","draft_ids":["d1","d2"],"draft_input":"in"}',
      ],
    ]
  );
  await reportHinted(bad.base, ["a"]);
  await reportHinted(stalled.base, ["a"], null, 100);
  await reportHinted(await refusedBase(), ["a"]);
  await reportHinted("not a url", ["a"]);
});

test("reportHinted: the answer is drained, never collected", async (t) => {
  // Before #1508 the ping called res.resume() and read nothing; collecting
  // the answer (Buffer.concat of every chunk) is what it must not do.
  const size = 1024 * 1024;
  const big = await server({ status: 200, body: "x".repeat(size) });
  t.after(() => close(big.s));
  let largest = 0;
  const concat = Buffer.concat;
  t.mock.method(Buffer, "concat", (list: readonly Uint8Array[], length?: number) => {
    largest = Math.max(
      largest,
      list.reduce((n, c) => n + c.byteLength, 0)
    );
    return concat(list, length);
  });
  await reportHinted(big.base, ["a"], "s", 2000);
  assert.equal(big.seen.length, 1);
  assert.ok(largest < size, `the ping collected ${largest} bytes of the answer`);
});

// ─── the write and plan lanes' /hook/recall (hook-recall-post.ts) ───────────

const RECALL_BODY = {
  query: "q",
  topics: ["t"],
  project: null,
  tool_name: "Write",
  k: 3,
  hook_source: "write",
} as unknown as HookRecallRequest;

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("postHookRecall: POSTs the body as is, with the task header only when one is configured", async (t) => {
  const d = await server({ status: 200, body: JSON.stringify({ hits: [{ id: "h" }] }) });
  t.after(() => close(d.s));
  const token = "a".repeat(43);
  assert.deepEqual(
    await withEnv({ BASTRA_TASKS: "1", BASTRA_TASK_TOKEN: token }, () => postHookRecall(d.base, RECALL_BODY, 500)),
    { hits: [{ id: "h" }] }
  );
  await withEnv({ BASTRA_TASKS: "0", BASTRA_TASK_TOKEN: token }, () => postHookRecall(d.base, RECALL_BODY, 500));
  assert.deepEqual(
    d.seen.map((r) => [r.method, r.url, r.type, r.task, r.body]),
    [
      ["POST", "/hook/recall", "application/json; charset=utf-8", `Bearer ${token}`, JSON.stringify(RECALL_BODY)],
      ["POST", "/hook/recall", "application/json; charset=utf-8", undefined, JSON.stringify(RECALL_BODY)],
    ]
  );
});

test("postHookRecall: rejects with the daemon's text, invalid JSON, a timeout and a refusal", async (t) => {
  const bad = await server({ status: 503, body: "busy" });
  const garbage = await server({ status: 200, body: "nope" });
  const stalled = await server(null);
  t.after(async () => {
    for (const d of [bad, garbage, stalled]) await close(d.s);
  });
  await assert.rejects(postHookRecall(bad.base, RECALL_BODY, 500), /^Error: HTTP 503: busy$/);
  await assert.rejects(postHookRecall(garbage.base, RECALL_BODY, 500), /^Error: invalid JSON response from daemon$/);
  const started = Date.now();
  await assert.rejects(postHookRecall(stalled.base, RECALL_BODY, 150), /^Error: timeout$/);
  assert.ok(Date.now() - started < 1500);
  await assert.rejects(postHookRecall(await refusedBase(), RECALL_BODY, 500), { code: "ECONNREFUSED" });
});

// ─── response size ───────────────────────────────────────────────────────────

test("response size: a large answer arrives whole, an error names only its first 200 characters", async (t) => {
  const large = "x".repeat(1024 * 1024);
  const big = await server({ status: 200, body: JSON.stringify({ ok: true, data: large }) });
  const long = await server({ status: 503, body: "e".repeat(300) });
  t.after(async () => {
    for (const d of [big, long]) await close(d.s);
  });
  assert.equal(((await postSessionContext(big.base, {}, 2000)) as { data: string }).data, large);
  assert.equal(((await postHookRecall(big.base, RECALL_BODY, 2000)) as { data: string }).data, large);
  assert.equal(((await probeHealth(big.base, 2000)) as unknown as { data: string }).data, large);
  const cut = new RegExp(`^Error: HTTP 503: e{200}$`);
  await assert.rejects(postSessionContext(long.base, {}, 500), cut);
  await assert.rejects(postHookRecall(long.base, RECALL_BODY, 500), cut);
});
