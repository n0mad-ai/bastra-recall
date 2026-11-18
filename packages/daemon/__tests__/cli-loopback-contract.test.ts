/**
 * #1508 — characterization of the CLI's loopback calls to the daemon, pinned
 * BEFORE they share `prompt-loopback.ts`: the request each one makes (method,
 * path, headers, body) and what the command makes of 200, non-200, garbage,
 * a stalled server and a refused connection.
 *
 * Covered: `bastra panel` (GET /health + GET /vault/count), the update hint
 * after every command (GET /health, 700 ms), and the replay of `bastra doctor
 * --replay` (POST /hook/prompt). `probeDaemon` (cli/helpers.ts) keeps its own
 * request — see the reason there — and is pinned by its existing callers.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdPanel } from "../src/cli/panel.js";
import { maybeEmitUpdateHint } from "../src/cli/update-hint.js";
import { daemonSupportsReplay, postReplayTurn } from "../src/cli/doctor-replay.js";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

type Reply = { status: number; body: string } | null;

/** `reply` per path; null = never answer (a stalled daemon). */
async function server(reply: (url: string) => Reply): Promise<{ s: Server; base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const r = reply(req.url ?? "");
      if (!r) return;
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
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
  const { s, base } = await server(() => ({ status: 200, body: "{}" }));
  await close(s);
  return base;
}

/** Point the CLI at `base` with a fresh HOME (settings, day markers). */
async function withDaemon<T>(base: string, fn: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "bastra-cli-loopback-"));
  const keys = ["BASTRA_DAEMON_URL", "HOME", "BASTRA_UPDATE_CHECK"] as const;
  const before = keys.map((k) => process.env[k]);
  process.env.BASTRA_DAEMON_URL = base;
  process.env.HOME = home;
  delete process.env.BASTRA_UPDATE_CHECK;
  try {
    return await fn();
  } finally {
    keys.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
    await rm(home, { recursive: true, force: true });
  }
}

/** Run `fn` with `stream.write` captured. */
async function capture(
  t: { mock: { method: typeof test.mock.method } },
  stream: NodeJS.WriteStream,
  fn: () => Promise<unknown>
): Promise<string> {
  let out = "";
  const m = t.mock.method(stream, "write", (chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    await fn();
  } finally {
    m.mock.restore();
  }
  return out;
}

const HEALTH = {
  ok: true,
  version: "0.0.0-fixture",
  vault_size: 7,
  update_available: { current: "1.0.0", latest: "9.9.9", html_url: "https://example.invalid", published_at: "x" },
};

// ─── bastra panel ────────────────────────────────────────────────────────────

test("panel: GETs /health and /vault/count, the reconciled count wins", async (t) => {
  const d = await server((url) =>
    url === "/health"
      ? { status: 200, body: JSON.stringify(HEALTH) }
      : { status: 200, body: JSON.stringify({ count: 42 }) }
  );
  t.after(() => close(d.s));
  const out = await withDaemon(d.base, () => capture(t, process.stdout, () => cmdPanel({} as never)));
  assert.match(out, /✓ running/);
  assert.match(out, /42 memories/);
  assert.match(out, /bastra update {21}get 9\.9\.9 now/);
  assert.deepEqual(d.seen.map((r) => [r.method, r.url, r.body]).sort(), [
    ["GET", "/health", ""],
    ["GET", "/vault/count", ""],
  ]);
  for (const r of d.seen) {
    assert.equal(r.headers["content-type"], undefined);
    assert.equal(r.headers.authorization, undefined);
  }
});

test("panel: a failed count falls back to /health's size; a failed health is 'not running'", async (t) => {
  const countFails = await server((url) =>
    url === "/health" ? { status: 200, body: JSON.stringify(HEALTH) } : { status: 500, body: "{}" }
  );
  t.after(() => close(countFails.s));
  assert.match(
    await withDaemon(countFails.base, () => capture(t, process.stdout, () => cmdPanel({} as never))),
    /7 memories/
  );
  for (const reply of [
    { status: 503, body: JSON.stringify({ ...HEALTH }) },
    { status: 200, body: "not json" },
    { status: 200, body: JSON.stringify({ ok: false }) },
  ]) {
    const d = await server(() => reply);
    t.after(() => close(d.s));
    const out = await withDaemon(d.base, () => capture(t, process.stdout, () => cmdPanel({} as never)));
    assert.match(out, /✗ not running/, JSON.stringify(reply));
    assert.doesNotMatch(out, /memories/, JSON.stringify(reply));
  }
  const out = await withDaemon(await refusedBase(), () => capture(t, process.stdout, () => cmdPanel({} as never)));
  assert.match(out, /✗ not running/);
});

// ─── update hint ─────────────────────────────────────────────────────────────

test("update hint: GET /health; an offered update is printed once per day", async (t) => {
  const d = await server(() => ({ status: 200, body: JSON.stringify(HEALTH) }));
  t.after(() => close(d.s));
  await withDaemon(d.base, async () => {
    let shown = false;
    const err = await capture(t, process.stderr, async () => (shown = await maybeEmitUpdateHint()));
    assert.equal(shown, true);
    assert.match(err, /A new bastra-recall is available: 9\.9\.9 \(you have 1\.0\.0\)/);
    assert.equal(await maybeEmitUpdateHint(), false, "the day marker holds the second one back");
  });
  assert.deepEqual(
    d.seen.map((r) => [r.method, r.url, r.headers["content-type"], r.body]),
    [["GET", "/health", undefined, ""]]
  );
});

test("update hint: non-200, garbage, not ok, no update, stall and refusal print nothing", async (t) => {
  for (const reply of [
    { status: 500, body: JSON.stringify(HEALTH) },
    { status: 200, body: "not json" },
    { status: 200, body: JSON.stringify({ ...HEALTH, ok: false }) },
    { status: 200, body: JSON.stringify({ ...HEALTH, update_available: null }) },
  ]) {
    const d = await server(() => reply);
    t.after(() => close(d.s));
    assert.equal(await withDaemon(d.base, maybeEmitUpdateHint), false, JSON.stringify(reply));
  }
  const stalled = await server(() => null);
  t.after(() => close(stalled.s));
  const started = Date.now();
  assert.equal(await withDaemon(stalled.base, maybeEmitUpdateHint), false);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 600 && elapsed < 2000, `the 700 ms probe timeout holds (${elapsed} ms)`);
  assert.equal(await withDaemon(await refusedBase(), maybeEmitUpdateHint), false);
});

// ─── doctor --replay ─────────────────────────────────────────────────────────

const TURN = { session: "s", cwd: "/w", at: 0, text: "hello" };

test("replay: POSTs the turn to /hook/prompt in replay mode, without a task token", async (t) => {
  const row = { kind: "prompt_hook_call", hint_count: 1 };
  const d = await server(() => ({ status: 200, body: JSON.stringify({ stdout: "{}", telemetry: row }) }));
  t.after(() => close(d.s));
  assert.equal(await daemonSupportsReplay(d.base), true);
  assert.deepEqual(await postReplayTurn(d.base)(TURN, "replay-s"), row);
  assert.deepEqual(
    d.seen.map((r) => [r.method, r.url, r.headers["content-type"], r.headers.authorization, JSON.parse(r.body)]),
    [
      [
        "POST",
        "/hook/prompt",
        "application/json; charset=utf-8",
        undefined,
        {
          replay: true,
          payload: { session_id: "replay-probe", hook_event_name: "UserPromptSubmit", prompt: "" },
        },
      ],
      [
        "POST",
        "/hook/prompt",
        "application/json; charset=utf-8",
        undefined,
        {
          replay: true,
          payload: { session_id: "replay-s", cwd: "/w", hook_event_name: "UserPromptSubmit", prompt: "hello" },
        },
      ],
    ]
  );
  assert.equal(d.seen[1]!.headers["content-length"], String(Buffer.byteLength(d.seen[1]!.body)));
});

test("replay: a daemon without the replay mode, an error, garbage or a refusal yield nothing", async (t) => {
  for (const reply of [
    { status: 200, body: JSON.stringify({ hookSpecificOutput: {} }) },
    { status: 500, body: JSON.stringify({ stdout: "{}", telemetry: {} }) },
    { status: 404, body: "{}" },
    { status: 200, body: "not json" },
  ]) {
    const d = await server(() => reply);
    t.after(() => close(d.s));
    assert.equal(await daemonSupportsReplay(d.base), false, JSON.stringify(reply));
    assert.equal(await postReplayTurn(d.base)(TURN, "replay-s"), null, JSON.stringify(reply));
  }
  const refused = await refusedBase();
  assert.equal(await daemonSupportsReplay(refused), false);
  assert.equal(await postReplayTurn(refused)(TURN, "replay-s"), null);
  assert.equal(await daemonSupportsReplay("not a url"), false);
});

test("panel and update hint reach an IPv6 literal endpoint", async (t) => {
  const s = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/health" ? HEALTH : { count: 3 }));
    });
  });
  try {
    await new Promise<void>((ok, ko) => s.once("error", ko).listen(0, "::1", () => ok()));
  } catch {
    return t.skip("no IPv6 loopback on this machine");
  }
  t.after(() => close(s));
  const addr = s.address();
  const base = `http://[::1]:${typeof addr === "object" && addr ? addr.port : 0}`;
  assert.match(await withDaemon(base, () => capture(t, process.stdout, () => cmdPanel({} as never))), /3 memories/);
  let shown = false;
  await withDaemon(base, () => capture(t, process.stderr, async () => (shown = await maybeEmitUpdateHint())));
  assert.equal(shown, true);
});
