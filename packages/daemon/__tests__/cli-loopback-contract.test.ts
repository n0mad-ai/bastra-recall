/**
 * #1508 — characterization of the CLI's loopback calls to the daemon, pinned
 * BEFORE they share `prompt-loopback.ts`: the request each one makes (method,
 * path, headers, body) and what the command makes of 200, non-200, garbage,
 * a stalled server and a refused connection.
 *
 * Covered: `bastra panel` (GET /health + GET /vault/count), the update hint
 * after every command (GET /health, 700 ms), and the replay of `bastra doctor
 * --replay` (POST /hook/prompt). `probeDaemon` (cli/helpers.ts) keeps its own
 * request — see the reason there — and its report is pinned here too, except
 * its fixed 1.5 s socket timeout, which a test could only show by waiting.
 * The memory commands' REST call (`rulebookCliCall`: recall, save, trash,
 * rules proposals, save suggestions) is pinned here too, before it moved out
 * of the rulebook command into the shared CLI helpers (#1508).
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
import { probeDaemon, rulebookCliCall } from "../src/cli/helpers.js";
import { resolveDaemonEndpoint } from "../src/daemon-endpoint.js";
import { cmdTrash } from "../src/cli/trash-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { projectForFilter } from "../src/scope-filter.js";
import { DAEMON_VERSION } from "../src/version.js";

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

test("an https:// endpoint is refused before any socket, never spoken to in plain HTTP", async (t) => {
  // Before #1508 panel and update hint handed the whole URL to node:http,
  // which throws ERR_INVALID_PROTOCOL for https: without opening a socket.
  // The plain-HTTP server behind the https:// address must see nothing.
  const d = await server((url) =>
    url === "/health" ? { status: 200, body: JSON.stringify(HEALTH) } : { status: 200, body: '{"count":3}' }
  );
  t.after(() => close(d.s));
  const base = d.base.replace(/^http:/, "https:");
  const refused = { code: "ERR_INVALID_PROTOCOL" };
  await assert.rejects(
    withDaemon(base, () => capture(t, process.stdout, () => cmdPanel({} as never))),
    refused
  );
  await assert.rejects(withDaemon(base, maybeEmitUpdateHint), refused);
  await assert.rejects(
    withDaemon(base, () => withToken(undefined, () => rulebookCliCall("save_memory", { dry_run: true }))),
    refused
  );
  assert.equal(await daemonSupportsReplay(base), false);
  assert.equal(await postReplayTurn(base)(TURN, "replay-s"), null);
  assert.deepEqual(d.seen, []);
});

// ─── the memory commands' REST call (#1508) ──────────────────────────────────

/** Run `fn` with BASTRA_API_TOKEN set to `token` (unset for undefined). */
async function withToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.BASTRA_API_TOKEN;
  if (token === undefined) delete process.env.BASTRA_API_TOKEN;
  else process.env.BASTRA_API_TOKEN = token;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.BASTRA_API_TOKEN;
    else process.env.BASTRA_API_TOKEN = before;
  }
}

test("memory REST call: POST /api/v1/<tool> with JSON, the CLI agent, the project and the bearer", async (t) => {
  const d = await server(() => ({ status: 200, body: JSON.stringify({ archived: [], total: 0 }) }));
  t.after(() => close(d.s));
  const answer = await withDaemon(d.base, () =>
    withToken("tok-1508", () => rulebookCliCall("restore_memory", { limit: 100 }))
  );
  assert.deepEqual(answer, { archived: [], total: 0 });
  await withDaemon(d.base, () => withToken(undefined, () => rulebookCliCall("recall", { query: "q" })));
  const project = encodeURIComponent(projectForFilter(process.cwd()) ?? "");
  const agent = `bastra-cli/${DAEMON_VERSION}`;
  assert.deepEqual(
    d.seen.map((r) => [
      r.method,
      r.url,
      r.headers["content-type"],
      r.headers["user-agent"],
      r.headers["x-bastra-project"],
      r.headers.authorization,
      r.body,
    ]),
    [
      ["POST", "/api/v1/restore_memory", "application/json", agent, project, "Bearer tok-1508", '{"limit":100}'],
      ["POST", "/api/v1/recall", "application/json", agent, project, undefined, '{"query":"q"}'],
    ]
  );
});

test("memory REST call: the daemon's error text, else the HTTP status, is thrown", async (t) => {
  for (const [reply, message] of [
    [{ status: 400, body: JSON.stringify({ error: "no such id" }) }, { message: "no such id" }],
    [{ status: 500, body: "{}" }, { message: "HTTP 500" }],
  ] as const) {
    const d = await server(() => reply);
    t.after(() => close(d.s));
    await assert.rejects(
      withDaemon(d.base, () => withToken(undefined, () => rulebookCliCall("restore_memory", { id: "x" }))),
      message
    );
  }
  const refused = await refusedBase();
  await assert.rejects(withDaemon(refused, () => withToken(undefined, () => rulebookCliCall("recall", {}))));
});

test("memory REST call: a save preview checks the served schema first and sends nothing without dry_run", async (t) => {
  const schema = (dryRun: boolean) =>
    JSON.stringify({
      tools: [{ name: "save_memory", inputSchema: { properties: dryRun ? { dry_run: { type: "boolean" } } : {} } }],
    });
  const old = await server((url) => (url.startsWith("/tools") ? { status: 200, body: schema(false) } : null));
  t.after(() => close(old.s));
  await assert.rejects(
    withDaemon(old.base, () => withToken(undefined, () => rulebookCliCall("save_memory", { dry_run: true }))),
    /daemon does not advertise save_memory dry_run support; nothing was sent to save_memory/
  );
  assert.deepEqual(
    old.seen.map((r) => [r.method, r.url]),
    [["GET", "/tools?surface=write"]]
  );
  const now = await server((url) =>
    url.startsWith("/tools") ? { status: 200, body: schema(true) } : { status: 200, body: '{"ok":true}' }
  );
  t.after(() => close(now.s));
  await withDaemon(now.base, () => withToken(undefined, () => rulebookCliCall("save_memory", { dry_run: true })));
  assert.deepEqual(
    now.seen.map((r) => [r.method, r.url, r.body]),
    [
      ["GET", "/tools?surface=write", ""],
      ["POST", "/api/v1/save_memory", '{"dry_run":true}'],
    ]
  );
});

test("bastra trash list and restore reach restore_memory through the same call", async (t) => {
  const reply = { archived: [], total: 0, restored_to: "/v/a.md" };
  const d = await server(() => ({ status: 200, body: JSON.stringify(reply) }));
  t.after(() => close(d.s));
  await withDaemon(d.base, () =>
    withToken(undefined, async () => {
      await capture(t, process.stdout, () => cmdTrash(parseArgs(["trash", "list"])));
      await capture(t, process.stdout, () => cmdTrash(parseArgs(["trash", "restore", "m-1"])));
    })
  );
  const agent = `bastra-cli/${DAEMON_VERSION}`;
  assert.deepEqual(
    d.seen.map((r) => [r.method, r.url, r.headers["user-agent"], r.body]),
    [
      ["POST", "/api/v1/restore_memory", agent, '{"limit":100}'],
      ["POST", "/api/v1/restore_memory", agent, '{"id":"m-1"}'],
    ]
  );
});

// ─── probeDaemon (status, doctor, panel's own request) ──────────────────────

test("probeDaemon: one GET /health; the report names the HTTP status and the socket code apart", async (t) => {
  const replies: Reply[] = [
    { status: 200, body: JSON.stringify({ ok: true, vault_size: 7, version: "0.0.0-fixture" }) },
    { status: 503, body: JSON.stringify({ ok: true }) },
    { status: 200, body: JSON.stringify({ ok: false }) },
    { status: 200, body: "not json" },
  ];
  let i = 0;
  const d = await server(() => replies[i++]);
  t.after(() => close(d.s));
  const endpoint = resolveDaemonEndpoint({ BASTRA_DAEMON_URL: d.base });
  const ok = await probeDaemon(endpoint);
  assert.deepEqual(
    [ok.ok, ok.detail, ok.version, ok.vaultSize],
    [true, `vault_size=7 at ${endpoint.label}`, "0.0.0-fixture", 7]
  );
  const unexpected = (status: number) =>
    `daemon at ${endpoint.label} answered but health unexpected (status=${status})`;
  for (const status of [503, 200, 200]) {
    const r = await probeDaemon(endpoint);
    assert.deepEqual([r.ok, r.detail], [false, unexpected(status)]);
  }
  assert.deepEqual(
    d.seen.map((r) => [r.method, r.url, r.headers.authorization, r.body]),
    Array.from({ length: 4 }, () => ["GET", "/health", undefined, ""])
  );
  const refused = resolveDaemonEndpoint({ BASTRA_DAEMON_URL: await refusedBase() });
  const down = await probeDaemon(refused);
  assert.deepEqual(
    [down.ok, down.detail],
    [false, `not reachable at ${refused.label}: ECONNREFUSED (forwarder will auto-spawn on first MCP call)`]
  );
});
