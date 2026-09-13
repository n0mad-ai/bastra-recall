/**
 * #531 — one endpoint, or the diagnosis describes two machines as one.
 *
 * THE MEASURED FAULT. With the real vault's daemon on the default port and an
 * empty-vault daemon on the configured port 26723, `bastra status --json` said:
 *
 *   daemon   {"status":"ok","message":"vault_size=1193"}
 *   vaultMap {"url":"http://127.0.0.1:26723/ui","reachable":true}
 *
 * 1193 is the DEFAULT-port instance; 26723 is the configured one, and it held
 * zero memories. One report, two machines, and a reachability claim for a URL
 * that was never probed. Whoever debugs from that output measures the wrong
 * daemon — which is worse than a wrong number, because nothing in the output
 * says so.
 *
 * WHAT THIS FILE INSISTS ON. Not "the configured port is used somewhere". Two
 * REAL daemons run here at the same time, each with its own vault, its own
 * memory count and its own version string. Every surface is then checked
 * twice: it must name the configured instance's numbers, and it must never
 * mention the other instance's — no count, no version, no port. A fix that
 * merely routed the probe correctly but left one surface deriving its own URL
 * would still fail the negative half.
 *
 * The second half of the contract is persistence: a chosen endpoint that is
 * not written into the client registration and the managed LaunchAgent is lost
 * at the next GUI client start and at the next update, and the merge comes
 * back through the back door.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/endpoint-contract.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";

import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import {
  DEFAULT_DAEMON_PORT,
  endpointToPersist,
  portOfEndpoint,
  resolveDaemonEndpoint,
} from "../src/daemon-endpoint.js";
import { probeDaemon, buildServerBlock, serverBlockEndpoint } from "../src/cli/helpers.js";
import { cmdStatus } from "../src/cli/status.js";
import { cmdPanel } from "../src/cli/panel.js";
import { cmdEmbeddings } from "../src/cli/embeddings-cmd.js";
import { mapUrl } from "../src/cli/map-cmd.js";
import { daemonPort } from "../src/cli/daemon-processes.js";
import { maybeEmitUpdateHint } from "../src/cli/update-hint.js";
import { autostartEnv, renderPlist, readState } from "../src/cli/autostart.js";
import { daemonBaseUrl } from "../src/thin-client.js";
import type { ParsedArgs } from "../src/cli/types.js";

// ─── a real daemon, twice ────────────────────────────────────────

function memoryMarkdown(id: string): string {
  const ts = new Date().toISOString();
  return [
    "---", `id: ${id}`, `title: ${id}`, "type: reference", `summary: ${id}`,
    "topic_path:", "  - t", "tags:", "  - t", "scope: endpoint-531",
    "recall_when:", `  - ${id}`, `created: ${ts}`, `updated: ${ts}`, "---",
    "", `Body ${id}.`, "",
  ].join("\n");
}

interface LiveDaemon {
  port: number;
  vaultSize: number;
  version: string;
  stop: () => Promise<void>;
}

/** A genuine daemon HTTP surface over a genuine vault, on an ephemeral port. */
async function startDaemon(memories: number, version: string): Promise<LiveDaemon> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-531-"));
  for (let i = 0; i < memories; i++) {
    await writeFile(join(dir, `m${i}.md`), memoryMarkdown(`m${i}`), "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version,
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  return {
    port: handle.port,
    vaultSize: memories,
    version,
    stop: async () => {
      await handle.close();
      search.stop?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Capture what a command prints — the test-env shim drops string writes. */
async function captured(fn: () => Promise<unknown>): Promise<string> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let buf = "";
  const sink = (chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
    if (typeof chunk === "string") buf += chunk;
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return buf;
}

interface TwoDaemons {
  configured: LiveDaemon;
  other: LiveDaemon;
  home: string;
}

/**
 * Two daemons, the second one deliberately the WRONG answer: different vault
 * size, different version, different port. `BASTRA_HTTP_PORT` names the first.
 * HOME is redirected so nothing reads or writes the developer's own settings.
 */
async function twoDaemons(t: {
  after: (fn: () => unknown | Promise<unknown>) => void;
}): Promise<TwoDaemons> {
  const configured = await startDaemon(2, "0.0.0-configured");
  const other = await startDaemon(7, "0.0.0-other");
  const home = await mkdtemp(join(tmpdir(), "bastra-531-home-"));

  const saved = {
    port: process.env.BASTRA_HTTP_PORT,
    url: process.env.BASTRA_DAEMON_URL,
    httpUrl: process.env.BASTRA_HTTP_URL,
    home: process.env.HOME,
  };
  process.env.BASTRA_HTTP_PORT = String(configured.port);
  delete process.env.BASTRA_DAEMON_URL;
  delete process.env.BASTRA_HTTP_URL;
  process.env.HOME = home;

  t.after(async () => {
    for (const [k, v] of Object.entries({
      BASTRA_HTTP_PORT: saved.port,
      BASTRA_DAEMON_URL: saved.url,
      BASTRA_HTTP_URL: saved.httpUrl,
      HOME: saved.home,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await configured.stop();
    await other.stop();
    await rm(home, { recursive: true, force: true });
  });

  return { configured, other, home };
}

/** Nothing in `text` may come from the instance that was NOT configured. */
function mentionsNothingOf(text: string, other: LiveDaemon, where: string): void {
  assert.equal(
    text.includes(String(other.port)),
    false,
    `${where} names the other daemon's port ${other.port}: ${text}`,
  );
  assert.equal(
    text.includes(other.version),
    false,
    `${where} names the other daemon's version ${other.version}: ${text}`,
  );
  assert.equal(
    text.includes(`vault_size=${other.vaultSize}`),
    false,
    `${where} reports the other daemon's vault size: ${text}`,
  );
}

// ─── the resolver itself ─────────────────────────────────────────

test("#531 the endpoint resolver has one precedence, and it is documented", () => {
  const base = { HOME: "/tmp" };
  assert.equal(resolveDaemonEndpoint(base).port, DEFAULT_DAEMON_PORT);
  assert.equal(resolveDaemonEndpoint(base).configured, false);

  const byPort = resolveDaemonEndpoint({ ...base, BASTRA_HTTP_PORT: "26723" });
  assert.equal(byPort.baseUrl, "http://127.0.0.1:26723");
  assert.equal(byPort.healthUrl, "http://127.0.0.1:26723/health");
  assert.equal(byPort.mapUrl, "http://127.0.0.1:26723/ui");
  assert.equal(byPort.configured, true);

  // A full endpoint wins over a bare port — it is the more specific statement.
  const byUrl = resolveDaemonEndpoint({
    ...base,
    BASTRA_HTTP_PORT: "26723",
    BASTRA_DAEMON_URL: "http://127.0.0.1:31000/",
  });
  assert.equal(byUrl.port, 31000);
  assert.equal(byUrl.baseUrl, "http://127.0.0.1:31000");
  assert.equal(byUrl.source, "BASTRA_DAEMON_URL");

  // Garbage must not take the CLI down, and must not be believed either.
  assert.equal(resolveDaemonEndpoint({ ...base, BASTRA_HTTP_PORT: "not-a-port" }).port, DEFAULT_DAEMON_PORT);
  assert.equal(resolveDaemonEndpoint({ ...base, BASTRA_DAEMON_URL: "nonsense" }).port, DEFAULT_DAEMON_PORT);
});

// ─── every diagnostic surface, against two live daemons ──────────

test("#531 status --json reports the configured daemon only — never the other instance", async (t) => {
  const { configured, other } = await twoDaemons(t);

  const out = await captured(() => cmdStatus({ json: true }));
  const parsed = JSON.parse(out.slice(out.indexOf("{"))) as {
    endpoint: { url: string; source: string };
    daemon: { status: string; message: string };
    vaultMap: { enabled: boolean; url: string; reachable: boolean };
  };

  // The positive half: every number is the configured instance's.
  assert.equal(parsed.endpoint.url, `http://127.0.0.1:${configured.port}`);
  assert.equal(parsed.daemon.status, "ok");
  assert.match(parsed.daemon.message, new RegExp(`vault_size=${configured.vaultSize}\\b`));
  assert.match(parsed.daemon.message, new RegExp(`127\\.0\\.0\\.1:${configured.port}`));
  assert.equal(parsed.vaultMap.url, `http://127.0.0.1:${configured.port}/ui`);

  // The exact fabricated claim from the report: a map called reachable while
  // the health it was inferred from came from somewhere else. Reachability may
  // only be asserted for the endpoint that was actually probed.
  if (parsed.vaultMap.enabled) assert.equal(parsed.vaultMap.reachable, true);
  assert.equal(new URL(parsed.vaultMap.url).port, String(new URL(parsed.endpoint.url).port));

  // The negative half — this is what catches a half-fix.
  mentionsNothingOf(
    JSON.stringify({ endpoint: parsed.endpoint, daemon: parsed.daemon, vaultMap: parsed.vaultMap }),
    other,
    "status --json",
  );
});

test("#531 the health probe carries the endpoint it spoke to, so no caller has to guess", async (t) => {
  const { configured, other } = await twoDaemons(t);

  const probe = await probeDaemon();
  assert.equal(probe.ok, true);
  assert.equal(probe.endpoint?.port, configured.port);
  assert.equal(probe.version, configured.version);
  assert.match(probe.detail, new RegExp(`vault_size=${configured.vaultSize}\\b`));
  mentionsNothingOf(`${probe.detail} ${probe.version ?? ""}`, other, "probeDaemon");

  // And the same call, aimed at the other instance, must report ITS numbers —
  // proof that the two are distinguishable at all and the test is not just
  // reading one server twice.
  const otherProbe = await probeDaemon(
    resolveDaemonEndpoint({ BASTRA_HTTP_PORT: String(other.port) }),
  );
  assert.equal(otherProbe.version, other.version);
  assert.match(otherProbe.detail, new RegExp(`vault_size=${other.vaultSize}\\b`));
});

test("#531 the map URL, process discovery and the hook clients name the configured endpoint", async (t) => {
  const { configured, other } = await twoDaemons(t);

  assert.equal(mapUrl(), `http://127.0.0.1:${configured.port}/ui`);
  assert.equal(daemonPort(), configured.port);
  assert.equal(daemonBaseUrl(), `http://127.0.0.1:${configured.port}`);
  mentionsNothingOf(`${mapUrl()} ${daemonPort()} ${daemonBaseUrl()}`, other, "map/discovery/hooks");

  // The thin hook clients used to honour BASTRA_HTTP_URL but not
  // BASTRA_DAEMON_URL — the very variable the installer now writes into a
  // client registration.
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${other.port}`;
  try {
    assert.equal(daemonBaseUrl(), `http://127.0.0.1:${other.port}`);
    assert.equal(mapUrl(), `http://127.0.0.1:${other.port}/ui`);
  } finally {
    delete process.env.BASTRA_DAEMON_URL;
  }
});

test("#531 the panel shows the configured daemon's memory count, not the other one's", async (t) => {
  const { configured, other } = await twoDaemons(t);

  const out = await captured(() => cmdPanel({} as ParsedArgs));
  assert.match(out, new RegExp(`127\\.0\\.0\\.1:${configured.port}`));
  assert.match(out, new RegExp(`\\b${configured.vaultSize} memories\\b`));
  mentionsNothingOf(out, other, "bastra (panel)");
  assert.equal(out.includes(`${other.vaultSize} memories`), false, `panel shows the other vault's count: ${out}`);
});

test("#531 embeddings status names the instance its live answer came from", async (t) => {
  const { configured, other } = await twoDaemons(t);

  const out = await captured(() => cmdEmbeddings({ sub: "status" }));
  assert.match(out, new RegExp(`running daemon at 127\\.0\\.0\\.1:${configured.port}`));
  mentionsNothingOf(out, other, "embeddings status");
});

test("#531 the update hint probes the configured endpoint and never the default one", async (t) => {
  // Recording servers, because here the question IS "who did you ask" — a
  // health payload alone cannot answer it.
  const hits: Record<string, number> = { configured: 0, decoy: 0 };
  const make = (key: string) =>
    new Promise<{ port: number; close: () => Promise<void> }>((done) => {
      const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
        hits[key] += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, update_available: null, path: req.url }));
      });
      srv.listen(0, "127.0.0.1", () =>
        done({
          port: (srv.address() as AddressInfo).port,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        }),
      );
    });
  const configured = await make("configured");
  const decoy = await make("decoy");
  const home = await mkdtemp(join(tmpdir(), "bastra-531-hint-"));
  const saved = { port: process.env.BASTRA_HTTP_PORT, home: process.env.HOME, check: process.env.BASTRA_UPDATE_CHECK };
  process.env.BASTRA_HTTP_PORT = String(configured.port);
  process.env.HOME = home;
  delete process.env.BASTRA_UPDATE_CHECK;
  t.after(async () => {
    if (saved.port === undefined) delete process.env.BASTRA_HTTP_PORT; else process.env.BASTRA_HTTP_PORT = saved.port;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.check !== undefined) process.env.BASTRA_UPDATE_CHECK = saved.check;
    await configured.close();
    await decoy.close();
    await rm(home, { recursive: true, force: true });
  });

  await captured(() => maybeEmitUpdateHint());
  assert.equal(hits.configured, 1, "the update hint must probe the configured endpoint");
  assert.equal(hits.decoy, 0, "the update hint must not probe any other instance");
});

// ─── the endpoint has to SURVIVE ─────────────────────────────────

test("#531 a chosen endpoint survives registration — and a hand-set one survives a reinstall", () => {
  const configured = resolveDaemonEndpoint({ BASTRA_HTTP_PORT: "26723" });

  // Installing with an endpoint configured writes it into the client block: a
  // GUI client inherits no shell export, so without this its forwarder dials
  // the default port and can attach to a different vault entirely.
  const fresh = buildServerBlock("/v", "/fwd.js", "write", endpointToPersist(null, configured));
  assert.equal(fresh.env.BASTRA_DAEMON_URL, "http://127.0.0.1:26723");

  // A later run WITHOUT the export must keep what the registration says
  // instead of resetting it to the default.
  const plain = resolveDaemonEndpoint({ HOME: "/tmp" });
  assert.equal(plain.configured, false);
  assert.equal(
    endpointToPersist(fresh.env.BASTRA_DAEMON_URL, plain),
    "http://127.0.0.1:26723",
  );
  const again = buildServerBlock("/v", "/fwd.js", "write", endpointToPersist(fresh.env.BASTRA_DAEMON_URL, plain));
  assert.equal(again.env.BASTRA_DAEMON_URL, "http://127.0.0.1:26723");

  // With nothing configured anywhere the block stays as short as it was —
  // the ordinary single-daemon install gains no noise.
  assert.equal("BASTRA_DAEMON_URL" in buildServerBlock("/v", "/fwd.js", "write", endpointToPersist(null, plain)).env, false);
});

test("#531 serverBlockEndpoint reads the endpoint an existing registration already carries", () => {
  const existing = { command: "node", args: ["/fwd.js"], env: { BASTRA_DAEMON_URL: "http://127.0.0.1:26723" } };
  const saved = process.env.BASTRA_HTTP_PORT;
  delete process.env.BASTRA_HTTP_PORT;
  try {
    assert.equal(serverBlockEndpoint(existing), "http://127.0.0.1:26723");
    assert.equal(serverBlockEndpoint({ env: {} }), null);
    assert.equal(serverBlockEndpoint(null), null);
  } finally {
    if (saved !== undefined) process.env.BASTRA_HTTP_PORT = saved;
  }
});

test("#531 the managed LaunchAgent freezes the port the daemon must bind, and keeps it across a refresh", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-531-plist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "agent.plist");

  const configured = resolveDaemonEndpoint({ BASTRA_HTTP_PORT: "26723" });
  const env = autostartEnv("/vault", "/opt/homebrew/bin/node", endpointToPersist(null, configured));

  // BASTRA_HTTP_PORT is what the daemon reads when it binds. The old plist
  // omitted it on the claim that the daemon reads the port "from settings" —
  // it does not; there is no such setting. So `autostart on` from a shell with
  // the export produced an agent that came up on the default port while every
  // diagnostic still named the configured one.
  assert.equal(env.BASTRA_HTTP_PORT, "26723");
  assert.equal(env.BASTRA_DAEMON_URL, "http://127.0.0.1:26723");

  await writeFile(path, renderPlist(env, ["/opt/homebrew/bin/node", "/x/index.js"]), "utf8");
  const written = await readFile(path, "utf8");
  assert.match(written, /<key>BASTRA_HTTP_PORT<\/key>\s*<string>26723<\/string>/);

  if (process.platform === "darwin") {
    const state = await readState(path, "/bin/launchctl");
    assert.equal(state.managed, true);
    assert.equal(state.endpoint, "http://127.0.0.1:26723");
    assert.equal(portOfEndpoint(state.endpoint), 26723);

    // The refresh case: `bastra update` runs in a shell without the export.
    // The endpoint therefore comes from the plist being rewritten, or the
    // repoint silently moves the daemon back to the default port.
    const plain = resolveDaemonEndpoint({ HOME: "/tmp" });
    const refreshed = autostartEnv("/vault", "/opt/homebrew/bin/node", endpointToPersist(state.endpoint, plain));
    assert.equal(refreshed.BASTRA_HTTP_PORT, "26723");
  }

  // An agent written with no endpoint configured anywhere stays as narrow as
  // it always was.
  const bare = autostartEnv("/vault", "/opt/homebrew/bin/node", endpointToPersist(null, resolveDaemonEndpoint({ HOME: "/tmp" })));
  assert.equal("BASTRA_HTTP_PORT" in bare, false);
});

// ─── the class, not just the instance ────────────────────────────

test("#531 no CLI surface carries its own copy of the daemon address", async () => {
  const here = new URL("../src/", import.meta.url);
  const files = [
    "cli/helpers.ts", "cli/status.ts", "cli/panel.ts", "cli/map-cmd.ts",
    "cli/update-hint.ts", "cli/daemon-processes.ts", "cli/daemon-start.ts",
    "cli/embeddings-cmd.ts", "cli/autostart.ts", "cli/config-cmd.ts",
    "cli/adapters/claude-code.ts", "cli/adapters/claude-desktop.ts",
    "cli/adapters/cursor.ts", "cli/adapters/codex.ts",
    "thin-client.ts", "hook.ts", "prompt-hook.ts", "bridge.ts",
    "forwarder-daemon-client.ts",
  ];
  for (const rel of files) {
    const src = await readFile(new URL(rel, here), "utf8");
    // Comments may still tell the story; executable text may not rebuild the
    // address. This is the gate that keeps the seventh copy from reappearing.
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    assert.equal(
      /127\.0\.0\.1:\$\{|"http:\/\/127\.0\.0\.1:6723|127\.0\.0\.1:\d+\/health/.test(code),
      false,
      `${rel} builds a daemon address of its own — use resolveDaemonEndpoint()`,
    );
    assert.equal(
      /daemon-on-6723/.test(code),
      false,
      `${rel} still names a fixed port in a diagnostic key`,
    );
  }
});
