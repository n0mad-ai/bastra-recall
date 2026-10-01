/**
 * #684: a daemon the forwarder auto-spawns no longer inherits the MCP
 * client's env as-is. Client-only keys are dropped, `daemon.env` from
 * cli-settings.json wins, and the daemon reports who started it.
 *
 * Runner: `tsx --test __tests__/daemon-spawn-env.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonOrigin, daemonSpawnEnv, CLIENT_ONLY_ENV_KEYS } from "../src/daemon-spawn-env.js";
import { canAutoSpawnAt } from "../src/forwarder-daemon-client.js";
import { resolveDaemonEndpoint } from "../src/daemon-endpoint.js";
import { readSettings } from "../src/settings.js";
import { buildHealthPayload } from "../src/http-health.js";
import { daemonOriginLines } from "../src/cli/daemon-origin-note.js";
import type { DaemonProbe } from "../src/cli/helpers.js";

/** What the issue's client MCP entry carried. */
const CLIENT_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  BASTRA_DAEMON_URL: "http://127.0.0.1:6723",
  BASTRA_HOOK_TIMEOUT_MS: "5000",
  BASTRA_TOOL_SURFACE: "search",
  BASTRA_VAULT_PATH: "/v",
};

test("#684: a remote or TLS endpoint never triggers local daemon auto-spawn", () => {
  const endpoint = (url: string) => resolveDaemonEndpoint({ BASTRA_DAEMON_URL: url });
  assert.equal(canAutoSpawnAt(endpoint("http://127.0.0.1:6723")), true);
  assert.equal(canAutoSpawnAt(endpoint("http://localhost:6723")), true);
  assert.equal(canAutoSpawnAt(endpoint("http://[::1]:6723")), true);
  assert.equal(canAutoSpawnAt(endpoint("http://memory.example:6723")), false);
  assert.equal(canAutoSpawnAt(endpoint("https://127.0.0.1:6723")), false);
});

test("client-only keys are dropped; vault, endpoint and the rest pass through", () => {
  const { env, origin, pinned } = daemonSpawnEnv({ ...CLIENT_ENV, BASTRA_MCP_SESSION_CONTEXT: "0", BASTRA_HOOK_CLIENT: "codex", BASTRA_FORWARDER_SPAWN: "1" }, undefined);
  for (const k of CLIENT_ONLY_ENV_KEYS) assert.equal(env[k], undefined, k);
  assert.equal(env.BASTRA_VAULT_PATH, "/v");
  assert.equal(env.BASTRA_DAEMON_URL, "http://127.0.0.1:6723");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(origin, "client");
  assert.deepEqual(pinned, []);
  assert.equal(env.BASTRA_DAEMON_STARTED_BY, "forwarder");
  assert.equal(env.BASTRA_DAEMON_ENV_ORIGIN, "client");
});

test("daemon.env pins win over the client's value and fill what the client lacks", () => {
  const { env, origin, pinned } = daemonSpawnEnv(
    { ...CLIENT_ENV, BASTRA_PROMPT_HOOK_MODE: "off" },
    { BASTRA_TRIGGER_EXPAND: "0", BASTRA_PROMPT_HOOK_MODE: "all" },
  );
  assert.equal(env.BASTRA_TRIGGER_EXPAND, "0");
  assert.equal(env.BASTRA_PROMPT_HOOK_MODE, "all");
  assert.equal(origin, "client+settings");
  assert.deepEqual(pinned, ["BASTRA_TRIGGER_EXPAND", "BASTRA_PROMPT_HOOK_MODE"]);
});

test("acceptance: with a temp HOME, a key the client lacks comes from cli-settings.json", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "bastra-spawn-env-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, "cli-settings.json");
  await writeFile(file, JSON.stringify({
    daemon: { env: { BASTRA_TRIGGER_EXPAND: "0", BASTRA_DOCUMENT_WRITE: "1", BASTRA_RM_ARCHIVES: "1", BASTRA_HOOK_TIMEOUT_MS: "9", BASTRA_OLLAMA_URL: 5 } },
  }));
  const settings = await readSettings(file);
  assert.deepEqual(settings.daemon?.env, { BASTRA_TRIGGER_EXPAND: "0", BASTRA_DOCUMENT_WRITE: "1", BASTRA_RM_ARCHIVES: "1" },
    "only documented daemon keys with string values survive");
  const { env } = daemonSpawnEnv(CLIENT_ENV, settings.daemon?.env);
  assert.equal(env.BASTRA_TRIGGER_EXPAND, "0");
  assert.equal(env.BASTRA_DOCUMENT_WRITE, "1");
  assert.equal(env.BASTRA_RM_ARCHIVES, "1");
  assert.equal(env.BASTRA_HOOK_TIMEOUT_MS, undefined, "a client-only key cannot be pinned for the daemon");
});

test("daemonOrigin reads the starter's markers", () => {
  assert.deepEqual(daemonOrigin({ BASTRA_DAEMON_STARTED_BY: "forwarder", BASTRA_DAEMON_ENV_ORIGIN: "client+settings" }),
    { startedBy: "forwarder", envOrigin: "client+settings" });
  assert.deepEqual(daemonOrigin({ BASTRA_DAEMON_STARTED_BY: "forwarder" }), { startedBy: "forwarder", envOrigin: "client" });
  assert.deepEqual(daemonOrigin({ BASTRA_AUTOSTART_MANAGED: "1" }), { startedBy: "launchagent", envOrigin: "own" });
  assert.deepEqual(daemonOrigin({ INVOCATION_ID: "abc" }), { startedBy: "systemd", envOrigin: "own" });
  assert.deepEqual(daemonOrigin({}), { startedBy: "direct", envOrigin: "own" });
});

test("/health carries started_by and env_origin when wired", () => {
  const p = buildHealthPayload({
    vaultSize: () => 0,
    version: "t",
    embedding: { on: false, providerId: null, source: "none" } as never,
    updateState: () => null,
    origin: { startedBy: "forwarder", envOrigin: "client" },
  });
  assert.equal(p.started_by, "forwarder");
  assert.equal(p.env_origin, "client");
});

test("doctor names a forwarder-owned daemon and the way out; nothing for an older daemon", () => {
  const base = { ok: true, endpoint: {} as DaemonProbe["endpoint"], detail: "" } as DaemonProbe;
  const fwd = daemonOriginLines({ ...base, startedBy: "forwarder", envOrigin: "client" }).join("\n");
  assert.match(fwd, /started by an MCP client's forwarder \(auto-spawn\)/);
  assert.match(fwd, /no daemon\.env pins/);
  assert.match(fwd, /BASTRA_FORWARDER_SPAWN=0/);
  assert.match(daemonOriginLines({ ...base, startedBy: "forwarder", envOrigin: "client+settings" }).join("\n"), /plus daemon\.env/);
  assert.match(daemonOriginLines({ ...base, startedBy: "launchagent", envOrigin: "own" }).join("\n"), /the bastra LaunchAgent; env: its own/);
  assert.deepEqual(daemonOriginLines(base), []);
  assert.deepEqual(daemonOriginLines({ ok: false, endpoint: base.endpoint, detail: "down" }), []);
});
