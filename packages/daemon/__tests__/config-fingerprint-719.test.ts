/**
 * #719 (part 1) — a fingerprint of the daemon's behaviour config.
 *
 * #684 made /health say who started the daemon. That does not say whether its
 * config differs: a forwarder-spawned daemon can run exactly what the service
 * would, and a service daemon can run without what daemon.env pins. /health
 * now carries a fingerprint of the behaviour settings, and doctor compares it
 * with the fingerprint of the configured state.
 *
 * Runner: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFingerprint, daemonSpawnEnv } from "../src/daemon-spawn-env.js";
import { resolveDaemonEndpoint } from "../src/daemon-endpoint.js";
import { buildHealthPayload } from "../src/http-health.js";
import { autostartEnv, readState, renderPlist } from "../src/cli/autostart.js";
import { configuredState, daemonOriginLines } from "../src/cli/daemon-origin-note.js";
import { probeDaemon, type DaemonProbe } from "../src/cli/helpers.js";

/** The unit env from the #684 report. */
const SERVICE_ENV = {
  BASTRA_TRIGGER_EXPAND: "0",
  BASTRA_PROMPT_HOOK_MODE: "all",
  BASTRA_DOCUMENT_WRITE: "1",
  BASTRA_RM_ARCHIVES: "1",
};

test("same config, same fingerprint — key order, empty values and non-behaviour keys do not matter", () => {
  const fp = configFingerprint(SERVICE_ENV);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(configFingerprint(Object.fromEntries(Object.entries(SERVICE_ENV).reverse())), fp, "key order");
  assert.equal(configFingerprint({ ...SERVICE_ENV, BASTRA_QUERY_ROUTER: "", BASTRA_BANTER: undefined }), fp, "unset and empty are the same");
  assert.equal(configFingerprint({ ...SERVICE_ENV, BASTRA_TRIGGER_EXPAND: " 0 " }), fp, "surrounding whitespace");
  assert.equal(
    configFingerprint({
      ...SERVICE_ENV,
      PATH: "/usr/bin",
      HOME: "/home/u",
      INVOCATION_ID: "abc",
      // client-only keys the forwarder's spawn drops
      BASTRA_TOOL_SURFACE: "search",
      BASTRA_HOOK_TIMEOUT_MS: "5000",
      // how and where the process runs
      BASTRA_DAEMON_STARTED_BY: "forwarder",
      BASTRA_DAEMON_ENV_ORIGIN: "client",
      BASTRA_DAEMON_URL: "http://127.0.0.1:26723",
      BASTRA_DAEMON_IDLE_SHUTDOWN_MS: "0",
      BASTRA_AUTOSTART_MANAGED: "1",
      BASTRA_HTTP_PORT: "26723",
      // locations
      BASTRA_VAULT_PATH: "/Users/a/vault",
      BASTRA_LOG_PATH: "/tmp/logs",
      BASTRA_HOOK_STATE_DIR: "/tmp/state",
      BASTRA_GRAPHIFY_BIN: "/opt/bin/graphify",
      BASTRA_RM_TEMP_ROOTS: "/tmp:/var/tmp",
      // secrets
      BASTRA_API_TOKEN: "secret-token",
      BASTRA_EMBEDDING_KEY: "sk-secret",
    }),
    fp,
    "paths, secrets, start markers and client-only keys are not part of it",
  );
});

test("a changed behaviour setting changes the fingerprint", () => {
  const fp = configFingerprint(SERVICE_ENV);
  assert.notEqual(configFingerprint({ ...SERVICE_ENV, BASTRA_TRIGGER_EXPAND: "1" }), fp, "a changed value");
  assert.notEqual(configFingerprint({ ...SERVICE_ENV, BASTRA_QUERY_ROUTER: "shadow" }), fp, "an added setting, pinnable or not");
  const { BASTRA_RM_ARCHIVES: _dropped, ...without } = SERVICE_ENV;
  assert.notEqual(configFingerprint(without), fp, "a missing setting");
  assert.notEqual(configFingerprint({ ...SERVICE_ENV, NEXUS_DOCUMENT_WRITE: "1" }), fp, "the legacy prefix is read by the daemon too");
  assert.notEqual(configFingerprint({}), fp);
});

test("a URL value counts without its credentials", () => {
  const plain = configFingerprint({ BASTRA_OLLAMA_URL: "http://gpu-box:11434" });
  assert.equal(configFingerprint({ BASTRA_OLLAMA_URL: "http://user:hunter2@gpu-box:11434" }), plain);
  assert.notEqual(configFingerprint({ BASTRA_OLLAMA_URL: "http://localhost:11434" }), plain, "the host is behaviour");
});

test("the #684 case: a spawn from the client's env differs from the service; with the pins it does not", () => {
  const client = { PATH: "/usr/bin", BASTRA_DAEMON_URL: "http://127.0.0.1:6723", BASTRA_HOOK_TIMEOUT_MS: "5000", BASTRA_TOOL_SURFACE: "search", BASTRA_VAULT_PATH: "/v" };
  const service = configFingerprint({ ...SERVICE_ENV, BASTRA_VAULT_PATH: "/v", INVOCATION_ID: "abc" });
  assert.notEqual(configFingerprint(daemonSpawnEnv(client, undefined).env), service);
  assert.equal(configFingerprint(daemonSpawnEnv(client, SERVICE_ENV).env), service);
});

test("/health carries config_fingerprint when wired, and not otherwise", () => {
  const deps = {
    vaultSize: () => 0,
    version: "t",
    embedding: { on: false, providerId: null, source: "none" } as never,
    updateState: () => null,
  };
  const fp = configFingerprint(SERVICE_ENV);
  const p = buildHealthPayload({ ...deps, origin: { startedBy: "systemd", envOrigin: "own", configFingerprint: fp } });
  assert.equal(p.config_fingerprint, fp);
  assert.equal("config_fingerprint" in buildHealthPayload({ ...deps, origin: { startedBy: "direct", envOrigin: "own" } }), false);
  assert.equal("config_fingerprint" in buildHealthPayload(deps), false);
});

test("the health probe reads config_fingerprint, and leaves it absent for an older daemon", async (t) => {
  let payload: Record<string, unknown> = { ok: true, vault_size: 1, version: "t", config_fingerprint: "0123456789ab" };
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const endpoint = resolveDaemonEndpoint({ BASTRA_HTTP_PORT: String((server.address() as { port: number }).port) });

  assert.equal((await probeDaemon(endpoint)).configFingerprint, "0123456789ab");
  payload = { ok: true, vault_size: 1, version: "t" };
  assert.equal((await probeDaemon(endpoint)).configFingerprint, undefined);
});

test("configured state: LaunchAgent env with the daemon.env pins on top; nothing configured is null", () => {
  assert.equal(configuredState(undefined, null), null);
  assert.equal(configuredState({}, null), null);

  const pins = configuredState(SERVICE_ENV, null);
  assert.equal(pins?.fingerprint, configFingerprint(SERVICE_ENV));
  assert.deepEqual(pins?.sources, ["daemon.env in ~/.bastra/cli-settings.json"]);

  // The managed plist as bastra writes it holds no behaviour setting.
  const agentEnv = autostartEnv("/Users/a/vault", "/opt/homebrew/bin/node", "http://127.0.0.1:26723");
  const agent = configuredState(undefined, agentEnv);
  assert.equal(agent?.fingerprint, configFingerprint({}));
  assert.deepEqual(agent?.sources, ["the bastra LaunchAgent env"]);

  const both = configuredState({ BASTRA_TRIGGER_EXPAND: "0" }, { ...agentEnv, BASTRA_TRIGGER_EXPAND: "1", BASTRA_BANTER: "0" });
  assert.equal(both?.fingerprint, configFingerprint({ BASTRA_TRIGGER_EXPAND: "0", BASTRA_BANTER: "0" }), "a pin wins over the plist's value");
  assert.equal(both?.sources.length, 2);
});

test("the plist's env is read back for the comparison", { skip: process.platform !== "darwin" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-fingerprint-plist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plist = join(dir, "agent.plist");
  await writeFile(
    plist,
    renderPlist({ ...autostartEnv("/Users/a/vault", "/opt/homebrew/bin/node", null), BASTRA_TRIGGER_EXPAND: "0" }, ["/opt/homebrew/bin/node", plist]),
    "utf8",
  );
  const state = await readState(plist);
  assert.equal(state.managed, true);
  assert.equal(state.env.BASTRA_TRIGGER_EXPAND, "0");
  assert.equal(configuredState(undefined, state.env)?.fingerprint, configFingerprint({ BASTRA_TRIGGER_EXPAND: "0" }));
  assert.deepEqual((await readState(join(dir, "none.plist"))).env, {});
});

test("doctor flags a daemon whose fingerprint differs and stays quiet on a match", () => {
  const base = { ok: true, endpoint: {} as DaemonProbe["endpoint"], detail: "", startedBy: "forwarder", envOrigin: "client" } as DaemonProbe;
  const configured = configuredState(SERVICE_ENV, null);
  assert.ok(configured);

  const differs = daemonOriginLines({ ...base, configFingerprint: configFingerprint({}) }, configured).join("\n");
  assert.match(differs, new RegExp(`⚠ config fingerprint: running ${configFingerprint({})}, configured ${configured.fingerprint}`));
  assert.match(differs, /differ from daemon\.env in ~\/\.bastra\/cli-settings\.json/);
  assert.match(differs, /then restart the daemon/);

  const same = daemonOriginLines({ ...base, envOrigin: "client+settings", configFingerprint: configured.fingerprint }, configured).join("\n");
  assert.match(same, new RegExp(`· config fingerprint: ${configured.fingerprint} — matches daemon\\.env`));
  assert.doesNotMatch(same, /⚠|differ/);

  // Nothing configured: the fingerprint is shown, nothing is flagged.
  const unconfigured = daemonOriginLines({ ...base, configFingerprint: "0123456789ab" }, null).join("\n");
  assert.match(unconfigured, /config fingerprint: 0123456789ab \(no daemon\.env pins and no managed LaunchAgent/);
  assert.doesNotMatch(unconfigured, /⚠/);

  // A daemon on another host (no comparison) and an older daemon (no field): no fingerprint line.
  assert.doesNotMatch(daemonOriginLines({ ...base, configFingerprint: "0123456789ab" }).join("\n"), /fingerprint/);
  assert.doesNotMatch(daemonOriginLines(base, configured).join("\n"), /fingerprint/);
});
