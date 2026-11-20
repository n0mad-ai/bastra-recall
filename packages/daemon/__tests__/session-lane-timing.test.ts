/**
 * #1512: the timing half of the SessionStart characterization. The golden
 * master (`session-lane-golden.test.ts`) normalizes every clock-derived value;
 * this file pins them: the deadline each loopback call gets, the remaining
 * budget the lane sends, the dense-arm deadline, the latency it reports, and
 * the fail-open answer when a call runs out of time.
 *
 * No wall clock: `Date` is mocked, and the time spent before the lane's
 * requests is injected through the warm-up seam (`onSessionContact`, called
 * once right after the lane reads its start time). Running out of time is the
 * socket timeout event, fired at once by the loopback spy.
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { runSessionLane } from "../src/session-lane.js";
import { budgetShadowWritesSettled } from "../src/session-budget.js";
import type { WarmupCoordinator } from "../src/embedding-warmup.js";
import { spyLoopbackRequests, type SpiedRequest } from "./loopback-request-spy.js";

const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
const HIT = { id: "pref-a", title: "Title", type: "lesson", scope: "user-preference", summary: "Summary", score: 150 };
const CONTEXT = {
  data: {
    recalls: [{ scope: "user-preference", resp: { hits: [HIT], vault_size: 5, latency_ms: 1, score_kind: "rrf" } }],
    floors: [],
    conventions: [],
    care: { open: 0, queued: 0 },
    imports: { open: 0, queued: 0 },
    onboarding: false,
  },
};

interface Run {
  stdout: string;
  seen: SpiedRequest[];
  bodies: Map<string, Record<string, unknown>>;
  row: Record<string, unknown>;
}

interface Options {
  /** ms the mocked clock moves inside `onSessionContact`, before any request. */
  spentBefore?: number;
  /** ms the mocked clock moves while the session-context request is served. */
  spentInContext?: number;
  residency?: "warm" | "cold";
  /** Paths whose socket timeout runs out at once. */
  expire?: string[];
  /** HTTP status of /hook/session-context (default 200). */
  contextStatus?: number;
}

function fakeWarmup(t: TestContext, o: Options): WarmupCoordinator {
  const state = o.residency ?? "warm";
  return {
    onSessionContact: () => {
      if (o.spentBefore) t.mock.timers.tick(o.spentBefore);
      return state;
    },
    residencyDetail: () => ({ state, source: "observed", estimated: false }),
  } as unknown as WarmupCoordinator;
}

async function sessionRow(logDir: string): Promise<Record<string, unknown>> {
  for (const f of (await readdir(logDir)).filter((n) => n.startsWith("events-"))) {
    for (const line of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.kind === "session_hook_call") return row;
    }
  }
  throw new Error("no session_hook_call row");
}

async function runLane(t: TestContext, o: Options = {}): Promise<Run> {
  // A second run in the same test starts from the same instant again.
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const bodies = new Map<string, Record<string, unknown>>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      if (body) bodies.set(path, JSON.parse(body) as Record<string, unknown>);
      if (path === "/hook/session-context" && o.spentInContext) t.mock.timers.tick(o.spentInContext);
      const status = path === "/hook/session-context" ? (o.contextStatus ?? 200) : 200;
      const reply = path === "/hook/session-context" ? CONTEXT : path === "/health" ? { ok: true } : {};
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const spy = spyLoopbackRequests(port, new Set(o.expire ?? []));
  const root = await mkdtemp(join(tmpdir(), "bastra-1512-timing-"));
  const env: Record<string, string> = {
    BASTRA_TELEMETRY: "on",
    BASTRA_LOG_PATH: join(root, "logs"),
    BASTRA_HOOK_STATE_DIR: join(root, "state"),
  };
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const stdout = await runSessionLane(
      { hook_event_name: "SessionStart", source: "startup", cwd: root, session_id: "timing-1512" },
      `http://127.0.0.1:${port}`,
      fakeWarmup(t, o),
      async () => null
    );
    await budgetShadowWritesSettled();
    return { stdout, seen: [...spy.seen], bodies, row: await sessionRow(env.BASTRA_LOG_PATH) };
  } finally {
    spy.restore();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    await rm(root, { recursive: true, force: true });
  }
}

const timeoutOf = (r: Run, path: string) => r.seen.find((s) => s.path === path)?.timeout;

test("#1512 timing: a fresh start gives the health probe 200 ms and the context call the whole 1500 ms", async (t) => {
  const r = await runLane(t);
  // The health probe is started before the context call, beside it (not after).
  assert.equal(r.seen[0].path, "/health");
  assert.equal(r.seen[1].path, "/hook/session-context");
  assert.equal(timeoutOf(r, "/health"), 200);
  assert.equal(timeoutOf(r, "/hook/session-context"), 1500);
  const body = r.bodies.get("/hook/session-context")!;
  assert.deepEqual(body.budget, { time_ms: 1500 });
  assert.equal(body.vector_deadline_ms, 350);
  assert.equal(body.hook_budget_ms, 1500);
  assert.equal(body.lexical_only, undefined);
  assert.equal(r.row.status, "ok");
  assert.equal(r.row.latency_ms_total, 0);
});

test("#1512 timing: time spent before the calls comes off the context budget, not off the probe cap", async (t) => {
  const r = await runLane(t, { spentBefore: 1100 });
  assert.equal(timeoutOf(r, "/health"), 200);
  assert.equal(timeoutOf(r, "/hook/session-context"), 400);
  assert.deepEqual(r.bodies.get("/hook/session-context")!.budget, { time_ms: 400 });
  // The shadow router's budget is the lane's whole wall clock, not what is left.
  assert.equal(r.bodies.get("/hook/session-context")!.hook_budget_ms, 1500);
  assert.equal(r.row.latency_ms_total, 1100);
});

test("#1512 timing: near the end of the budget both calls keep their floors (80 ms probe, 60 ms context)", async (t) => {
  const r = await runLane(t, { spentBefore: 1450 });
  assert.equal(timeoutOf(r, "/health"), 80);
  assert.equal(timeoutOf(r, "/hook/session-context"), 60);
  assert.deepEqual(r.bodies.get("/hook/session-context")!.budget, { time_ms: 60 });
  const past = await runLane(t, { spentBefore: 4000 });
  assert.equal(timeoutOf(past, "/health"), 80);
  assert.equal(timeoutOf(past, "/hook/session-context"), 60);
  assert.equal(past.row.latency_ms_total, 4000);
});

test("#1512 timing: a cold model gets no dense-arm deadline but lexical_only", async (t) => {
  const r = await runLane(t, { residency: "cold" });
  const body = r.bodies.get("/hook/session-context")!;
  assert.equal(body.lexical_only, true);
  assert.equal("vector_deadline_ms" in body, false);
  assert.deepEqual(body.budget, { time_ms: 1500 });
});

test("#1512 timing: the reported latency is the lane's whole run, the context call included", async (t) => {
  const r = await runLane(t, { spentBefore: 100, spentInContext: 300 });
  assert.equal(r.row.latency_ms_total, 400);
});

test("#1512 fail-open: a context call that runs out of time answers like a failed one", async (t) => {
  const failed = await runLane(t, { contextStatus: 500 });
  const timedOut = await runLane(t, { expire: ["/hook/session-context"] });
  assert.equal(failed.row.status, "error");
  assert.equal(timedOut.row.status, "timeout");
  assert.equal(timedOut.stdout, failed.stdout);
  assert.doesNotMatch(timedOut.stdout, /pref-a/);
});

test("#1512 fail-open: a health probe that runs out of time changes nothing in the answer", async (t) => {
  const ok = await runLane(t);
  const probeTimedOut = await runLane(t, { expire: ["/health"] });
  assert.equal(probeTimedOut.row.status, "ok");
  assert.equal(probeTimedOut.stdout, ok.stdout);
  assert.match(probeTimedOut.stdout, /pref-a/);
});
