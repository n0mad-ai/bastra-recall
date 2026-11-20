/**
 * #1525: the timing half of the Write/Edit lane characterization, for its
 * fail-open paths. The golden master (`write-lane-golden.test.ts`) drops
 * `latency_ms_total` and never lets the recall run out of time; this file
 * pins the recall's deadline, the answer when it passes, and the latency the
 * lane reports.
 *
 * No wall clock: `Date` is mocked, and for the deadline `setTimeout` too —
 * the recall's deadline is a plain timer (`hook-transport.ts`). The mock
 * daemon moves the mocked clock while it serves a request, or never answers.
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { runWriteLane } from "../src/write-lane.js";
import { warmSettingsReader } from "../src/settings-record-thread.js";

const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
// #1674: the monotonic clock follows the mocked `Date`, so the time each test
// injects reaches a remainder measured on either clock.
test.beforeEach((t) => (t as TestContext).mock.method(performance, "now", () => Date.now() - T0));
const BIG = Array.from({ length: 900 }, (_, i) => `export const v${i} = ${i};`).join("\n");
const HIT = { id: "own", title: "Title own", type: "lesson", scope: "timing-proj", summary: "Summary own", score: 150 };

interface Daemon {
  url: string;
  /** Resolves when /hook/recall has arrived. */
  recallArrived: Promise<void>;
  close: () => Promise<void>;
}

/** `recall`: "stall" never answers; a number moves the mocked clock that far, then answers with a hit. */
async function mockDaemon(t: TestContext, recall: "stall" | number): Promise<Daemon> {
  let arrived: () => void = () => {};
  const recallArrived = new Promise<void>((ok) => (arrived = ok));
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/hook/recall") {
        arrived();
        if (recall === "stall") return;
        t.mock.timers.tick(recall);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ hits: [HIT], vault_size: 10, latency_ms: 3, project_known: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    recallArrived,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

interface Workspace {
  cwd: string;
  logDir: string;
  env: Record<string, string>;
}

async function workspace(t: TestContext): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "bastra-1525-timing-"));
  const cwd = join(root, "timing-proj");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "big.ts"), BIG, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const logDir = join(root, "logs");
  return {
    cwd,
    logDir,
    env: { BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir, BASTRA_HOOK_STATE_DIR: join(root, "state") },
  };
}

async function hookCallRow(logDir: string): Promise<Record<string, unknown>> {
  for (const f of (await readdir(logDir)).filter((n) => n.startsWith("events-"))) {
    for (const line of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.kind === "hook_call") return row;
    }
  }
  throw new Error("no hook_call row");
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const lane = (ws: Workspace, url: string) =>
  runWriteLane(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      session_id: "timing-1525",
      cwd: ws.cwd,
      tool_input: { file_path: join(ws.cwd, "src", "big.ts"), old_string: "a", new_string: "b" },
    },
    url
  );

// As the golden does: the settings reader's start-up is not part of the size note's time.
test.before(async () => {
  const open = setInterval(() => {}, 1000);
  await warmSettingsReader();
  clearInterval(open);
});

test("#1525 fail-open: a recall that does not answer is given up at exactly 600 ms, and the size note still goes out", async (t) => {
  const daemon = await mockDaemon(t, "stall");
  t.after(daemon.close);
  const ws = await workspace(t);
  const unreachableWs = await workspace(t);
  await withEnv(unreachableWs.env, async () => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    const unreachable = await lane(unreachableWs, "http://127.0.0.1:1");
    t.mock.timers.reset();
    await withEnv(ws.env, async () => {
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: T0 });
      let settled = false;
      const run = lane(ws, daemon.url).then((out) => {
        settled = true;
        return out;
      });
      await daemon.recallArrived;
      const turn = () => new Promise((r) => setImmediate(r));
      await turn();
      t.mock.timers.tick(599);
      await turn();
      assert.equal(settled, false, "still waiting 1 ms before the deadline");
      t.mock.timers.tick(1);
      const stdout = await run;
      t.mock.timers.reset();
      // The same answer as with no daemon at all: the size note alone.
      assert.equal(stdout, unreachable);
      assert.match(stdout, /file-size-check/);
      const row = await hookCallRow(ws.logDir);
      assert.equal(row.status, "timeout");
      assert.equal(row.latency_ms_total, 600);
      assert.equal(row.daemon_reachable, false);
    });
    assert.equal((await hookCallRow(unreachableWs.logDir)).status, "daemon-unreachable");
  });
});

test("#1525 timing: the reported latency is the lane's whole run, the recall included", async (t) => {
  const daemon = await mockDaemon(t, 250);
  t.after(daemon.close);
  const ws = await workspace(t);
  await withEnv(ws.env, async () => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    const stdout = await lane(ws, daemon.url);
    t.mock.timers.reset();
    assert.match(stdout, /file-size-check/);
    const row = await hookCallRow(ws.logDir);
    assert.equal(row.status, "ok");
    assert.equal(row.latency_ms_total, 250);
  });
});

test("#1525 timing: a recall answered 1 ms before its deadline is still used", async (t) => {
  // 599 ms is inside the 600 ms deadline: the hits are delivered.
  const daemon = await mockDaemon(t, 599);
  t.after(daemon.close);
  const ws = await workspace(t);
  await withEnv(ws.env, async () => {
    // The deadline timer is mocked too, so the daemon's 599 ms count against it.
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: T0 });
    const stdout = await lane(ws, daemon.url);
    t.mock.timers.reset();
    assert.match(stdout, /own/);
    const row = await hookCallRow(ws.logDir);
    assert.equal(row.status, "ok");
    assert.equal(row.latency_ms_total, 599);
  });
});
