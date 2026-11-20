/**
 * #1513: the timing half of the hook recall characterization. The golden
 * master (`hook-recall-golden.test.ts`) replaces every `*_ms` value; this file
 * pins them: the dense-arm deadline each recall gets, the order of the prompt
 * and content recalls, the latencies the row and the payload report, the
 * shadow router's budget, and the fail-open answer when the dense arm misses
 * its deadline.
 *
 * No wall clock: `Date` (and, for the missed deadline, `setTimeout`) is
 * mocked. The time a recall takes is injected by moving the mocked clock
 * inside the spied search calls.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { runHookRecall } from "../src/http-hook-routes.js";

const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
// #1674: the monotonic clock follows the mocked `Date`, so the time each test
// injects reaches a remainder measured on either clock.
test.beforeEach((t) => (t as TestContext).mock.method(performance, "now", () => Date.now() - T0));
const Q = "how do we deploy the release branch after the tag";

function memo(id: string, body: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: Rule ${id}`,
    "type: lesson",
    "scope: alpha",
    `summary: ${body}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "recall_when:",
    "  - when we deploy",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

interface SearchCall {
  method: "recallHybrid" | "recall";
  query: string;
  vector_deadline_ms: unknown;
}

interface Setup {
  deps: { vault: Vault; search: SearchIndex; telemetry: Telemetry };
  calls: SearchCall[];
  logDir: string;
  /** Resolves once the dense provider has been asked; set by `stuckDense`. */
  denseAsked: Promise<void>;
}

/**
 * `spend` maps a search call's position (0 = prompt recall, 1 = content
 * recall) to the ms the mocked clock moves while it runs. `stuckDense` makes
 * the dense provider never answer.
 */
async function setup(t: TestContext, o: { spend?: number[]; stuckDense?: boolean } = {}): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1513-timing-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-1513-timing-logs-"));
  await writeFile(join(dir, "a.md"), memo("a", "deploy over the release branch with a smoke test"), "utf8");
  await writeFile(join(dir, "b.md"), memo("b", "deploy only after the tag and the approval"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  let asked: () => void = () => {};
  const denseAsked = new Promise<void>((ok) => (asked = ok));
  search.useEmbeddings({
    size: () => 2,
    runtimeHealth: () => ({ errorCount: 0 }),
    searchDetailed: () => {
      asked();
      if (o.stuckDense) return new Promise(() => {});
      return Promise.resolve({
        outcome: "hits",
        hits: [
          { id: "a", score: 0.9 },
          { id: "b", score: 0.8 },
        ],
        providerLoadMs: null,
        coldStartObserved: false,
      });
    },
  } as never);
  const calls: SearchCall[] = [];
  const spy = <M extends "recallHybrid" | "recall">(method: M) => {
    const original = search[method].bind(search) as (q: string, opts: Record<string, unknown>) => unknown;
    (search as unknown as Record<string, unknown>)[method] = (q: string, opts: Record<string, unknown>) => {
      const position = calls.length;
      calls.push({ method, query: q, vector_deadline_ms: opts.vector_deadline_ms });
      const ms = o.spend?.[position];
      if (ms) t.mock.timers.tick(ms);
      return original(q, opts);
    };
  };
  spy("recallHybrid");
  spy("recall");
  const prev = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prev === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prev;
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { deps: { vault, search, telemetry }, calls, logDir, denseAsked };
}

/** The row is written without being awaited; poll on real I/O turns, not on a timer. */
async function hookRecallRow(logDir: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 500; i++) {
    for (const f of (await readdir(logDir).catch(() => [] as string[])).filter((n) => n.startsWith("events-"))) {
      for (const line of (await readFile(join(logDir, f), "utf8")).split("\n")) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (ev.kind === "hook_recall") return ev;
      }
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("no hook_recall row");
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CONTENT = {
  tool_name: "Edit",
  hook_source: "pre-tool",
  tool_input_excerpt: "smoke test before the approval",
};

test("#1513 timing: the dense arm gets 150 ms by default, the caller's deadline clamped to 50..10000", async (t) => {
  const cases: Array<[unknown, number]> = [
    [undefined, 150],
    [350, 350],
    [20, 50],
    [99_999, 10_000],
  ];
  for (const [asked, expected] of cases) {
    const s = await setup(t);
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    await runHookRecall({ query: Q, ...(asked === undefined ? {} : { vector_deadline_ms: asked }) }, Q, T0, s.deps);
    t.mock.timers.reset();
    assert.deepEqual(
      s.calls.map((c) => [c.method, c.vector_deadline_ms]),
      [["recallHybrid", expected]],
      `asked ${String(asked)}`
    );
  }
});

test("#1513 timing: the content recall runs after the prompt recall, with the same deadline", async (t) => {
  await withEnv({ BASTRA_HOOK_CONTENT_RECALL: "1" }, async () => {
    const s = await setup(t);
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    await runHookRecall({ query: Q, vector_deadline_ms: 400, ...CONTENT }, Q, T0, s.deps);
    t.mock.timers.reset();
    assert.deepEqual(s.calls, [
      { method: "recallHybrid", query: Q, vector_deadline_ms: 400 },
      { method: "recallHybrid", query: CONTENT.tool_input_excerpt, vector_deadline_ms: 400 },
    ]);
  });
});

test("#1513 timing: lexical_only runs both recalls without a dense arm or a deadline", async (t) => {
  await withEnv({ BASTRA_HOOK_CONTENT_RECALL: "1" }, async () => {
    const s = await setup(t);
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    await runHookRecall({ query: Q, lexical_only: true, ...CONTENT }, Q, T0, s.deps);
    t.mock.timers.reset();
    assert.deepEqual(
      s.calls.map((c) => [c.method, c.vector_deadline_ms]),
      [
        ["recall", undefined],
        ["recall", undefined],
      ]
    );
  });
});

test("#1513 timing: the row and the payload report the time before, inside and after the recalls", async (t) => {
  await withEnv({ BASTRA_HOOK_CONTENT_RECALL: "1" }, async () => {
    const s = await setup(t, { spend: [40, 5] });
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    // The caller's clock started 30 ms before the pipeline.
    const payload = await runHookRecall({ query: Q, session_id: "timing-1513", ...CONTENT }, Q, T0 - 30, s.deps);
    t.mock.timers.reset();
    const row = await hookRecallRow(s.logDir);
    assert.equal(row.latency_ms_recall, 45);
    assert.equal(row.latency_ms_total, 75);
    assert.equal(payload.latency_ms, 75);
    assert.equal((row.content_recall as { latency_ms: number }).latency_ms, 5);
  });
});

test("#1513 timing: the shadow router measures against the caller's budget, 200 ms by default", async (t) => {
  const routes: unknown[] = [];
  for (const budget of [undefined, 200, 1]) {
    const s = await setup(t);
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    await runHookRecall(
      { query: "deploy", session_id: "timing-1513", ...(budget === undefined ? {} : { hook_budget_ms: budget }) },
      "deploy",
      T0,
      s.deps
    );
    t.mock.timers.reset();
    const row = await hookRecallRow(s.logDir);
    routes.push((row.shadow_route as { lexical_fits: boolean }).lexical_fits);
  }
  // No budget sent counts as the 200 ms default; 1 ms cannot fit the lexical arm.
  assert.deepEqual(routes, [true, true, false]);
});

test("#1513 fail-open: a dense arm that misses its deadline is abandoned at exactly that deadline", async (t) => {
  const s = await setup(t, { stuckDense: true });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: T0 });
  let settled = false;
  const run = runHookRecall({ query: Q, session_id: "timing-1513", vector_deadline_ms: 120 }, Q, T0, s.deps).then(
    (p) => {
      settled = true;
      return p;
    }
  );
  await s.denseAsked;
  const turn = () => new Promise((r) => setImmediate(r));
  // The hybrid recall yields one timer turn after firing the dense arm, runs
  // BM25, and only then starts the deadline (core `search.ts`, #305).
  await turn();
  t.mock.timers.tick(0);
  await turn();
  t.mock.timers.tick(119);
  await turn();
  assert.equal(settled, false, "still waiting 1 ms before the deadline");
  t.mock.timers.tick(1);
  const payload = await run;
  t.mock.timers.reset();
  // Served lexically, and honest about it.
  assert.equal(payload.score_kind, "bm25");
  assert.equal(payload.unfused, true);
  assert.equal(payload.degraded, "vector-arm-timeout");
  assert.ok(Array.isArray(payload.hits) && payload.hits.length > 0);
  const row = await hookRecallRow(s.logDir);
  assert.equal(row.degraded_reason, "vector-arm-timeout");
});
