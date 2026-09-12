/**
 * #526 — Integrationstests für die kombinierte Peer/Host-Regel auf /api/v1/*.
 *
 * Bedrohungsmodell: Der Token-Skip hing allein am Peer-Socket. Ein same-origin
 * GET trägt keinen Origin-Header, also sah der Daemon bei DNS-Rebinding
 * (`attacker.example` → 127.0.0.1) und bei einem lokalen Tunnel/Reverse-Proxy
 * genau dasselbe wie bei der CLI: Loopback-Socket, kein Origin — und ließ den
 * Request token-los durch. Ab jetzt braucht der Skip BEIDES: Loopback-Peer UND
 * Loopback-Host.
 *
 * Gegen den echten HTTP-Server gefahren (nicht nur gegen den Gate-Helper), weil
 * der Befund am Zusammenspiel von Host-Gate und Auth-Gate hing und
 * /api/v1/graph/node den vollen Memory-Body zurückgibt.
 *
 * Runner: `tsx --test __tests__/http-rebinding-auth.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";

const TOKEN = "rebinding-test-token";
const FOREIGN = "evil.example";

interface Res {
  status: number;
  body: string;
}

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function buildVault(): Promise<{ dir: string; vault: Vault }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-526-"));
  await mkdir(join(dir, "memories", "projects", "alpha"), { recursive: true });
  const ts = new Date().toISOString();
  await writeFile(
    join(dir, "memories", "projects", "alpha", "a1.md"),
    [
      "---",
      "id: a1",
      "title: Title of a1",
      "type: reference",
      "summary: Summary of a1",
      "topic_path:",
      "  - test",
      "tags:",
      "  - test",
      "scope: rebinding-test",
      "recall_when:",
      "  - a1",
      `created: ${ts}`,
      `updated: ${ts}`,
      "---",
      "",
      "Body of a1 — the full non-private payload an attacker would exfiltrate.",
      "",
    ].join("\n"),
  );
  const vault = new Vault(dir);
  await vault.init();
  return { dir, vault };
}

/**
 * Ein Server mit gesetztem Token, isoliertem HOME (damit weder die echte
 * cli-settings.json noch deren CORS-Allowlist hereinreicht) und einer
 * deterministischen Allowlist.
 */
async function withServer(
  env: Record<string, string>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const { dir, vault } = await buildVault();
  const home = await mkdtemp(join(tmpdir(), "bastra-526-home-"));
  const saved: Record<string, string | undefined> = {};
  const all = { HOME: home, BASTRA_API_TOKEN: TOKEN, BASTRA_CORS_ORIGIN: "https://bastra.io", ...env };
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  try {
    await fn(handle.port!);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

test("#526: foreign Host + no Origin + no token → 401 on API GET and POST (loopback socket)", async () => {
  await withServer({}, async (port) => {
    const node = await call(port, "GET", "/api/v1/graph/node?id=a1", { host: FOREIGN });
    assert.equal(node.status, 401, "DNS-rebound GET must not inherit the loopback exemption");
    assert.doesNotMatch(node.body, /Body of a1/, "no memory body may leak");

    const recall = await call(
      port,
      "POST",
      "/api/v1/recall",
      { host: FOREIGN, ...JSON_HEADERS },
      JSON.stringify({ query: "a1" }),
    );
    assert.equal(recall.status, 401);

    const graph = await call(port, "GET", "/api/v1/graph", { host: FOREIGN });
    assert.equal(graph.status, 401);

    // Ein Host mit Port ist derselbe fremde Host — der Port darf nichts retten.
    const withPort = await call(port, "GET", "/api/v1/graph/node?id=a1", { host: `${FOREIGN}:${port}` });
    assert.equal(withPort.status, 401);
  });
});

test("#526: tunnel/reverse-proxy — foreign Host + correct bearer token still works", async () => {
  await withServer({}, async (port) => {
    const node = await call(port, "GET", "/api/v1/graph/node?id=a1", {
      host: FOREIGN,
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(node.status, 200);
    assert.match(node.body, /Body of a1/);

    const recall = await call(
      port,
      "POST",
      "/api/v1/recall",
      { host: FOREIGN, authorization: `Bearer ${TOKEN}`, ...JSON_HEADERS },
      JSON.stringify({ query: "a1" }),
    );
    assert.equal(recall.status, 200);
  });
});

test("#526: direct loopback stays tokenless — 127.0.0.1, localhost, [::1]", async () => {
  await withServer({}, async (port) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "127.0.0.1", "LocalHost"]) {
      const node = await call(port, "GET", "/api/v1/graph/node?id=a1", { host });
      assert.equal(node.status, 200, `loopback Host ${host} must stay tokenless (Map-UI/CLI/MCP)`);
      assert.match(node.body, /Body of a1/);
    }

    const recall = await call(
      port,
      "POST",
      "/api/v1/recall",
      { host: `127.0.0.1:${port}`, ...JSON_HEADERS },
      JSON.stringify({ query: "a1" }),
    );
    assert.equal(recall.status, 200, "the CLI/forwarder POST path must stay tokenless");

  });
});

test("#526: BASTRA_ALLOWED_HOSTS opens the loopback-only routes, not the tokenless API path", async () => {
  await withServer({ BASTRA_ALLOWED_HOSTS: FOREIGN }, async (port) => {
    // Das Rebinding-Gate lässt den Host jetzt durch …
    const health = await call(port, "GET", "/health", { host: FOREIGN });
    assert.equal(health.status, 200);
    // … die API verlangt trotzdem das Token.
    const node = await call(port, "GET", "/api/v1/graph/node?id=a1", { host: FOREIGN });
    assert.equal(node.status, 401);
  });
});

test("#526: BASTRA_AUTH_LOOPBACK_SKIP=0 requires the token even on a loopback Host", async () => {
  await withServer({ BASTRA_AUTH_LOOPBACK_SKIP: "0" }, async (port) => {
    const off = await call(port, "GET", "/api/v1/graph/node?id=a1", { host: `127.0.0.1:${port}` });
    assert.equal(off.status, 401);
    const on = await call(port, "GET", "/api/v1/graph/node?id=a1", {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(on.status, 200);
  });
});

test("#526: the pre-existing gates are untouched — /health and a foreign Origin", async () => {
  await withServer({}, async (port) => {
    const health = await call(port, "GET", "/health", { host: FOREIGN });
    assert.equal(health.status, 403, "the non-API host gate still answers 403");

    const browser = await call(
      port,
      "POST",
      "/api/v1/recall",
      { host: FOREIGN, origin: `http://${FOREIGN}`, ...JSON_HEADERS },
      JSON.stringify({ query: "a1" }),
    );
    assert.equal(browser.status, 403, "a foreign Origin is still an origin rejection");
  });
});

/** A hand-written request over a bare socket — no client library adds a Host. */
function rawRequest(port: number, wire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(wire));
    let out = "";
    sock.on("data", (c) => (out += c));
    sock.on("end", () => resolve(out));
    sock.on("error", reject);
  });
}

/**
 * A raw TCP port-forwarder — socat / `ssh -L` / a plain proxy. Unlike nginx or
 * cloudflared it rewrites nothing, so it adds no Host header of its own.
 */
async function withRawForwarder(target: number, fn: (port: number) => Promise<void>): Promise<void> {
  const fwd = createTcpServer((client) => {
    const upstream = connect(target, "127.0.0.1", () => {
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => fwd.listen(0, "127.0.0.1", r));
  try {
    await fn((fwd.address() as AddressInfo).port);
  } finally {
    fwd.close();
  }
}

test("#526: a MISSING Host header is no loopback proof — raw tunnel and direct socket both need the token", async () => {
  await withServer({}, async (port) => {
    await withRawForwarder(port, async (fwdPort) => {
      // Der Angriff: roher Port-Forwarder davor, Request von Hand ohne Host.
      const tunneled = await rawRequest(fwdPort, "GET /api/v1/graph/node?id=a1 HTTP/1.0\r\n\r\n");
      assert.match(tunneled, /^HTTP\/1\.1 401 /, "a Host-less request through a raw tunnel must not be tokenless");
      assert.doesNotMatch(tunneled, /Body of a1/, "no memory body may leak");

      // Mit Token bleibt derselbe Weg für legitime Tunnel-Clients offen.
      const withToken = await rawRequest(
        fwdPort,
        `GET /api/v1/graph/node?id=a1 HTTP/1.0\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`,
      );
      assert.match(withToken, /^HTTP\/1\.1 200 /);
      assert.match(withToken, /Body of a1/);
    });

    // Dieselbe Regel direkt am Daemon — der Forwarder ist nicht die Ursache.
    const direct = await rawRequest(port, "GET /api/v1/graph/node?id=a1 HTTP/1.0\r\n\r\n");
    assert.match(direct, /^HTTP\/1\.1 401 /);
  });
});

test("#526: a MISSING Host header is rejected on the tokenless loopback routes too", async () => {
  await withServer({}, async (port) => {
    // /health und /hook/* kennen gar kein Token — dort bleibt nur das Host-Gate.
    const health = await rawRequest(port, "GET /health HTTP/1.0\r\n\r\n");
    assert.match(health, /^HTTP\/1\.1 403 /);
    // Mit loopback-Host ist derselbe Endpoint unverändert offen.
    const ok = await rawRequest(port, `GET /health HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    assert.match(ok, /^HTTP\/1\.1 200 /);
  });
});
