/**
 * #322: `bastra map` handed out http://127.0.0.1:6723/ui while nothing listened
 * there. Measured in a VM right after the guided setup — doctor said
 * "ECONNREFUSED (forwarder will auto-spawn on first MCP call)" and Safari said
 * "cannot connect to the server", on the one command that exists for people who
 * have no AI session to auto-spawn from.
 *
 * The daemon start is driven through an injected clock/probe, and cmdMap runs
 * against a temp settings file — no test spawns a daemon, opens a browser, or
 * reads the developer's own ~/.bastra settings.
 *
 * Run: npx tsx --test packages/daemon/__tests__/map-daemon-start.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureDaemonRunning,
  DAEMON_START_TIMEOUT_MS,
  type DaemonStartIO,
  type DaemonStartOutcome,
} from "../src/cli/daemon-start.js";
import { cmdMap, mapUrl } from "../src/cli/map-cmd.js";
import { formatVaultMapLine } from "../src/cli/status.js";
import { vaultMapOutcomeLine, vaultMapSetupStep } from "../src/cli/wizard.js";
import { setUiEnabled } from "../src/settings.js";

const VAULT = "/tmp/test-vault";

/**
 * A fake daemon on a fake clock: `healthyAtMs` is when /health starts
 * answering, `null` for never. sleep() is what moves time, so a 30 s timeout
 * costs no wall-clock seconds.
 */
function harness(opts: { healthyAtMs: number | null; vault?: { path: string } | { error: string } }) {
  const state = { clock: 0, probes: 0, spawns: [] as string[] };
  const io: DaemonStartIO = {
    probe: async () => {
      state.probes += 1;
      return opts.healthyAtMs !== null && state.clock >= opts.healthyAtMs;
    },
    resolveVaultPath: async () => opts.vault ?? { path: VAULT },
    spawnDaemon: (vaultPath) => { state.spawns.push(vaultPath); },
    sleep: async (ms) => { state.clock += ms; },
    now: () => state.clock,
  };
  return { io, state };
}

/** Captures stdout+stderr for the duration of fn. */
async function withCapture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** A settings file with the map enabled, so cmdMap reaches the daemon step. */
async function withUiEnabled<T>(fn: (settingsPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-map-"));
  try {
    const settingsPath = join(dir, "cli-settings.json");
    await setUiEnabled(true, settingsPath);
    return await fn(settingsPath);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ─── ensureDaemonRunning ─────────────────────────────────────────────────────

test("daemon down: started once, with the resolved vault path", async () => {
  const { io, state } = harness({ healthyAtMs: 500 });
  const r = await ensureDaemonRunning({ io });

  assert.equal(r.ok, true);
  assert.equal(r.state, "started");
  assert.deepEqual(state.spawns, [VAULT], "exactly one start, carrying the vault the daemon needs");
});

test("daemon already up: never started a second time", async () => {
  const { io, state } = harness({ healthyAtMs: 0 });
  const r = await ensureDaemonRunning({ io });

  assert.equal(r.ok, true);
  assert.equal(r.state, "already-running");
  assert.deepEqual(state.spawns, [], "the port is the singleton — a LaunchAgent/forwarder daemon is THE daemon");
  assert.equal(state.probes, 1, "one probe is the whole cost when it is already up");
});

test("daemon never answers: bounded wait, honest detail", async () => {
  const { io, state } = harness({ healthyAtMs: null });
  const r = await ensureDaemonRunning({ io, timeoutMs: 5_000 });

  assert.equal(r.ok, false);
  assert.equal(r.state, "timeout");
  assert.match(r.detail, /did not answer \/health within 5s/);
  assert.ok(state.clock >= 5_000 && state.clock < 5_500, `stopped at the deadline, not later (${state.clock}ms)`);
});

test("no vault: fails immediately instead of waiting out the timeout", async () => {
  const { io, state } = harness({ healthyAtMs: null, vault: { error: "vault path required — pass --vault <path>" } });
  const r = await ensureDaemonRunning({ io });

  assert.equal(r.ok, false);
  assert.equal(r.state, "no-vault");
  assert.match(r.detail, /vault path required/);
  assert.deepEqual(state.spawns, [], "a daemon without a vault would only refuse to boot");
  assert.equal(state.clock, 0, "no wait at all");
});

test("onStarting announces a real start only — never a daemon that was already up", async () => {
  let announced = 0;
  const up = harness({ healthyAtMs: 0 });
  await ensureDaemonRunning({ io: up.io, onStarting: () => { announced += 1; } });
  assert.equal(announced, 0);

  const down = harness({ healthyAtMs: 1_000 });
  await ensureDaemonRunning({ io: down.io, onStarting: () => { announced += 1; } });
  assert.equal(announced, 1, "fires once, before the wait it explains");
});

test("the default timeout stays a bounded, human wait", () => {
  assert.ok(DAEMON_START_TIMEOUT_MS > 0 && DAEMON_START_TIMEOUT_MS <= 60_000);
});

test("an explicit vault path wins over detection — the wizard's pick may be in no config yet", async () => {
  const { io, state } = harness({
    healthyAtMs: 500,
    vault: { error: "must not be consulted when the caller knows the path" },
  });
  const r = await ensureDaemonRunning({ io, vaultPath: "/picked/in/the/wizard" });

  assert.equal(r.ok, true);
  assert.deepEqual(state.spawns, ["/picked/in/the/wizard"]);
});

// ─── the URL is never offered as reachable when it is not (#322) ─────────────

test("setup: the closing line offers the URL only when the daemon came up", () => {
  const ok = vaultMapOutcomeLine({ ok: true, state: "started", detail: "daemon started" }, "http://127.0.0.1:6723/ui");
  assert.equal(ok.level, "success");
  assert.match(ok.text, /http:\/\/127\.0\.0\.1:6723\/ui/);
});

test("setup: a daemon that did not start downgrades the line and names the way out", () => {
  const bad = vaultMapOutcomeLine(
    { ok: false, state: "timeout", detail: "daemon did not answer /health within 30s" },
    "http://127.0.0.1:6723/ui",
  );
  assert.equal(bad.level, "warn", "a link that cannot load is not a success");
  assert.match(bad.text, /did not start/);
  assert.match(bad.text, /bastra map/, "the reader needs the command that fixes it");
});

const MAP_URL = "http://127.0.0.1:6723/ui";

/**
 * The setup step wired to the REAL ensureDaemonRunning, only with the fake
 * clock/probe underneath — so these exercise the actual order and start
 * decision, not a stand-in for them. Nothing writes settings, nothing spawns.
 */
function setupStep(
  h: ReturnType<typeof harness>,
  opts: { vaultPath?: string; timeoutMs?: number } = {},
) {
  const calls: string[] = [];
  const run = vaultMapSetupStep(
    { vaultPath: opts.vaultPath, onStarting: () => calls.push("announced") },
    {
      enableMap: async () => { calls.push("enabled"); },
      ensureDaemon: (o) => {
        calls.push("ensured");
        return ensureDaemonRunning({ ...o, io: h.io, timeoutMs: opts.timeoutMs });
      },
      url: () => { calls.push("url-read"); return MAP_URL; },
    },
  );
  return { run, calls };
}

test("setup step: daemon down → started with the picked vault, URL offered only afterwards", async () => {
  const h = harness({ healthyAtMs: 500 });
  const { run, calls } = setupStep(h, { vaultPath: "/picked/in/the/wizard" });
  const line = await run;

  assert.deepEqual(h.state.spawns, ["/picked/in/the/wizard"], "the vault the user just picked, not a detected one");
  assert.deepEqual(
    calls,
    ["enabled", "ensured", "announced", "url-read"],
    "the daemon is dealt with before the URL is even read, let alone offered",
  );
  assert.equal(line.level, "success");
  assert.ok(line.text.includes(MAP_URL));
});

test("setup step: daemon already running → no second start, same closing line", async () => {
  const h = harness({ healthyAtMs: 0 });
  const { run, calls } = setupStep(h);
  const line = await run;

  assert.deepEqual(h.state.spawns, [], "a LaunchAgent/forwarder daemon is THE daemon");
  assert.ok(!calls.includes("announced"), "nothing to announce when nothing was started");
  assert.equal(line.level, "success");
});

test("setup step: daemon will not come up → the URL is NOT offered as reachable (#322)", async () => {
  const h = harness({ healthyAtMs: null });
  const { run } = setupStep(h, { timeoutMs: 5_000 });
  const line = await run;

  assert.equal(line.level, "warn", "this is the line the reporter clicked — it must not read as success");
  assert.ok(
    !line.text.includes("read per request"),
    "no 'here is your map' phrasing when there is no map to open",
  );
  assert.match(line.text, /did not start/);
  assert.match(line.text, /bastra map/, "name the command that retries it");
});

test("setup step: no vault anywhere → reported, and no wait was spent on it", async () => {
  const h = harness({ healthyAtMs: null, vault: { error: "vault path required — pass --vault <path>" } });
  const { run } = setupStep(h);
  const line = await run;

  assert.equal(line.level, "warn");
  assert.match(line.text, /vault path required/);
  assert.equal(h.state.clock, 0);
});

test("status: an enabled map with the daemon down is reported, not advertised", () => {
  const url = "http://127.0.0.1:6723/ui";
  assert.equal(formatVaultMapLine(true, true, url), `✓ ${url}`);
  assert.match(formatVaultMapLine(true, false, url), /daemon down — open it with: bastra map/);
  assert.ok(!formatVaultMapLine(true, false, url).startsWith("✓"), "no ✓ on a link that cannot load");
  assert.equal(formatVaultMapLine(false, true, url), "· off (open + enable: bastra map)");
});

// ─── cmdMap ──────────────────────────────────────────────────────────────────

function outcome(o: DaemonStartOutcome): (opts: { onStarting?: () => void }) => Promise<DaemonStartOutcome> {
  return async (opts) => {
    if (o.ok && o.state === "started") opts.onStarting?.();
    return o;
  };
}

test("map: the browser opens only after the daemon answers", async () => {
  await withUiEnabled(async (settingsPath) => {
    const opened: string[] = [];
    const { result, out } = await withCapture(() =>
      cmdMap({
        settingsPath,
        ensureDaemon: outcome({ ok: true, state: "started", detail: "daemon started" }),
        open: (url) => opened.push(url),
        withCode: async (url) => `${url}?bastra_ui_code=fixture`,
      }),
    );

    assert.equal(result, 0);
    assert.deepEqual(opened, [`${mapUrl()}?bastra_ui_code=fixture`], "#1198: the page opens with a one-time UI code");
    assert.match(out, /starting the daemon/, "the wait is explained while it happens");
  });
});

test("map: a daemon that was already running is not announced, page opens as before", async () => {
  await withUiEnabled(async (settingsPath) => {
    const opened: string[] = [];
    const { result, out } = await withCapture(() =>
      cmdMap({
        settingsPath,
        ensureDaemon: outcome({ ok: true, state: "already-running", detail: "daemon already running" }),
        open: (url) => opened.push(url),
        withCode: async (url) => `${url}?bastra_ui_code=fixture`,
      }),
    );

    assert.equal(result, 0);
    assert.deepEqual(opened, [`${mapUrl()}?bastra_ui_code=fixture`], "#1198: the page opens with a one-time UI code");
    assert.ok(!out.includes("starting the daemon"));
  });
});

test("map: a daemon that will not come up opens NO page and says why (#322)", async () => {
  await withUiEnabled(async (settingsPath) => {
    const opened: string[] = [];
    const { result, err } = await withCapture(() =>
      cmdMap({
        settingsPath,
        ensureDaemon: outcome({ ok: false, state: "timeout", detail: "daemon did not answer /health within 30s" }),
        open: (url) => opened.push(url),
      }),
    );

    assert.equal(result, 1, "a map that cannot load is not a success");
    assert.deepEqual(opened, [], "the reported bug WAS the browser opening on a dead port");
    assert.match(err, /did not answer \/health/);
    assert.match(err, /not opening/);
  });
});

test("map: an unresolvable vault is reported, not opened into", async () => {
  await withUiEnabled(async (settingsPath) => {
    const opened: string[] = [];
    const { result, err } = await withCapture(() =>
      cmdMap({
        settingsPath,
        ensureDaemon: outcome({ ok: false, state: "no-vault", detail: "vault path required — pass --vault <path>" }),
        open: (url) => opened.push(url),
      }),
    );

    assert.equal(result, 1);
    assert.deepEqual(opened, []);
    assert.match(err, /vault path required/);
  });
});

test("map: still disabled + no TTY → the old opt-in message, and no daemon is started", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-map-off-"));
  try {
    let ensured = 0;
    const opened: string[] = [];
    const { result, err } = await withCapture(() =>
      cmdMap({
        settingsPath: join(dir, "cli-settings.json"),
        ensureDaemon: async () => { ensured += 1; return { ok: true, state: "started", detail: "" }; },
        open: (url) => opened.push(url),
      }),
    );

    assert.equal(result, 1);
    assert.equal(ensured, 0, "nothing to serve while the map is off");
    assert.deepEqual(opened, []);
    assert.match(err, /vault map is disabled/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
