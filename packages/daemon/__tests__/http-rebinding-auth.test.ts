/**
 * #526 — Integrationstests für die kombinierte Peer/Host/Token-Regel auf
 * /api/v1/*.
 *
 * Bedrohungsmodell: Der Token-Skip hing allein am Peer-Socket. Ein same-origin
 * GET trägt keinen Origin-Header, also sah der Daemon bei DNS-Rebinding
 * (`attacker.example` → 127.0.0.1) und bei einem lokalen Tunnel/Reverse-Proxy
 * genau dasselbe wie bei der CLI: Loopback-Socket, kein Origin — und ließ den
 * Request token-los durch. Der Skip braucht BEIDES: Loopback-Peer UND
 * Loopback-Host.
 *
 * #526 (wieder geöffnet): dieser Harness setzte in JEDEM Fall ein Token und
 * konnte den Betriebszustand "kein Token konfiguriert" darum strukturell nicht
 * sehen — genau dort war die Host-Regel wirkungslos und ein fremder Host bekam
 * 200 mit vollem Vault-Body. Der Token-Zustand ist deshalb jetzt eine
 * DIMENSION des Harness (gesetzt / leer / gar nicht gesetzt), keine Konstante,
 * und die Matrix unten hat für jede Kombination ein festgeschriebenes
 * Ergebnis.
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
import { gateApiRequest } from "../src/http-auth.js";
import { Telemetry } from "../src/telemetry.js";

const TOKEN = "rebinding-test-token";
const FOREIGN = "evil.example";

/**
 * Der Token-Zustand, wie er im Betrieb vorkommt: gemintet/gesetzt, auf leer
 * gesetzt (`BASTRA_API_TOKEN=` im Startscript, Token gelöscht) und nie gesetzt
 * (Default-Installation ohne `bastra token`). Die letzten beiden sehen für den
 * Daemon gleich aus — genau die Form, die der alte Harness nie erzeugt hat.
 */
type TokenState = "set" | "empty" | "unset";

const TOKEN_ENV: Record<TokenState, string | undefined> = {
  set: TOKEN,
  empty: "",
  unset: undefined,
};

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
 * Ein GET auf den Endpoint mit dem vollen Memory-Body, roh über den Socket —
 * damit "gar kein Host-Header" dieselbe Codebahn nimmt wie "fremder Host" und
 * kein Client-Library-Default dazwischenfunkt.
 */
async function probe(port: number, opts: { host?: string; auth?: string }): Promise<Res> {
  const lines = ["GET /api/v1/graph/node?id=a1 HTTP/1.0"];
  if (opts.host !== undefined) lines.push(`Host: ${opts.host}`);
  if (opts.auth !== undefined) lines.push(`Authorization: ${opts.auth}`);
  const out = await rawRequest(port, `${lines.join("\r\n")}\r\n\r\n`);
  const status = Number(/^HTTP\/1\.\d (\d{3}) /.exec(out)?.[1] ?? 0);
  return { status, body: out };
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
 * Ein Server mit dem gewünschten Token-Zustand, isoliertem HOME (damit weder
 * die echte cli-settings.json noch deren CORS-Allowlist hereinreicht — und
 * damit "kein Token gesetzt" auch wirklich kein gemintetes Token findet) und
 * einer deterministischen Allowlist.
 *
 * `token` ist Pflicht: kein Aufrufer darf den Zustand mehr stillschweigend
 * erben, daran ist der Regressionstest beim ersten Mal vorbeigelaufen.
 */
async function withServer(
  opts: { token: TokenState; env?: Record<string, string> },
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const { dir, vault } = await buildVault();
  const home = await mkdtemp(join(tmpdir(), "bastra-526-home-"));
  const saved: Record<string, string | undefined> = {};
  const all: Record<string, string | undefined> = {
    HOME: home,
    BASTRA_API_TOKEN: TOKEN_ENV[opts.token],
    BASTRA_CORS_ORIGIN: "https://bastra.io",
    ...opts.env,
  };
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
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

// ── Die Matrix: Host-Zustand × Token-Zustand, gegen den echten Server ──
//
// Der Peer-Socket ist hier immer loopback — der Daemon bindet per Bind-Policy
// ausschließlich 127.0.0.1, ein nicht-loopback Peer ist über den echten Server
// gar nicht erreichbar. Diese Achse deckt die erschöpfende Gate-Tabelle weiter
// unten ab.

type HostCase = "loopback" | "foreign" | "missing";

const HOST_LABEL: Record<HostCase, string> = {
  loopback: "Host: 127.0.0.1",
  foreign: `Host: ${FOREIGN}`,
  missing: "kein Host-Header",
};

function hostHeader(kind: HostCase, port: number): string | undefined {
  if (kind === "loopback") return `127.0.0.1:${port}`;
  if (kind === "foreign") return FOREIGN;
  return undefined;
}

/**
 * Erwartetes Ergebnis OHNE Authorization-Header, pro Kombination.
 * `200` heißt: Vault-Body kommt zurück. `401` heißt: kein Byte Vault.
 */
const EXPECT_NO_AUTH: Record<HostCase, Record<TokenState, 200 | 401>> = {
  // Direkter lokaler Client — der token-lose Weg, den CLI/MCP-Forwarder gehen.
  loopback: { set: 200, empty: 200, unset: 200 },
  // DNS-Rebinding / Tunnel: nie ein direkter lokaler Client, egal ob ein Token
  // konfiguriert ist. Ohne Token kann niemand das fehlende Token vorlegen → 401.
  foreign: { set: 401, empty: 401, unset: 401 },
  // Kein Host = kein Loopback-Beweis (roher Port-Forwarder).
  missing: { set: 401, empty: 401, unset: 401 },
};

for (const tokenState of ["set", "empty", "unset"] as const) {
  for (const hostCase of ["loopback", "foreign", "missing"] as const) {
    const expected = EXPECT_NO_AUTH[hostCase][tokenState];
    test(`#526 matrix: loopback peer + ${HOST_LABEL[hostCase]} + token ${tokenState} → ${expected}`, async () => {
      await withServer({ token: tokenState }, async (port) => {
        const res = await probe(port, { host: hostHeader(hostCase, port) });
        assert.equal(
          res.status,
          expected,
          `${HOST_LABEL[hostCase]} / token ${tokenState} must answer ${expected}`,
        );
        if (expected === 200) assert.match(res.body, /Body of a1/);
        else assert.doesNotMatch(res.body, /Body of a1/, "no memory body may leak");
      });
    });
  }
}

test("#526: a foreign Host cannot bluff its way in when NO token is configured", async () => {
  for (const tokenState of ["empty", "unset"] as const) {
    await withServer({ token: tokenState }, async (port) => {
      // Irgendein Bearer — es gibt kein konfiguriertes Token, das passen könnte.
      for (const auth of [undefined, "Bearer ", "Bearer anything", `Bearer ${TOKEN}`]) {
        const res = await probe(port, { host: FOREIGN, auth });
        assert.equal(res.status, 401, `token ${tokenState}, auth ${String(auth)}`);
        assert.doesNotMatch(res.body, /Body of a1/);
      }
      // Und über den POST-Weg (node:http, echter Client) genauso.
      const recall = await call(
        port,
        "POST",
        "/api/v1/recall",
        { host: FOREIGN, ...JSON_HEADERS },
        JSON.stringify({ query: "a1" }),
      );
      assert.equal(recall.status, 401);
      assert.doesNotMatch(recall.body, /Body of a1/);
    });
  }
});

test("#526: without a token the direct local path stays open — dev/local mode is untouched", async () => {
  for (const tokenState of ["empty", "unset"] as const) {
    await withServer({ token: tokenState }, async (port) => {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "LocalHost"]) {
        const res = await probe(port, { host });
        assert.equal(res.status, 200, `loopback Host ${host}, token ${tokenState}`);
        assert.match(res.body, /Body of a1/);
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
  }
});

test("#526: BASTRA_AUTH_LOOPBACK_SKIP=0 without a token locks the API completely", async () => {
  // Widersprüchlich konfiguriert (Token erzwingen, keins konfiguriert) — die
  // ehrliche Antwort ist 401 und nicht "dann eben alles offen".
  await withServer({ token: "unset", env: { BASTRA_AUTH_LOOPBACK_SKIP: "0" } }, async (port) => {
    const res = await probe(port, { host: `127.0.0.1:${port}` });
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.body, /Body of a1/);
  });
});

test("#526: foreign Host + no Origin + no token → 401 on API GET and POST (loopback socket)", async () => {
  await withServer({ token: "set" }, async (port) => {
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
  await withServer({ token: "set" }, async (port) => {
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
  await withServer({ token: "set" }, async (port) => {
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
  for (const tokenState of ["set", "unset"] as const) {
    await withServer({ token: tokenState, env: { BASTRA_ALLOWED_HOSTS: FOREIGN } }, async (port) => {
      // Das Rebinding-Gate lässt den Host jetzt durch …
      const health = await call(port, "GET", "/health", { host: FOREIGN });
      assert.equal(health.status, 200);
      // … die API verlangt trotzdem das Token — auch wenn gar keins existiert.
      const node = await call(port, "GET", "/api/v1/graph/node?id=a1", { host: FOREIGN });
      assert.equal(node.status, 401, `BASTRA_ALLOWED_HOSTS must not open /api/v1 (token ${tokenState})`);
    });
  }
});

test("#526: BASTRA_AUTH_LOOPBACK_SKIP=0 requires the token even on a loopback Host", async () => {
  await withServer({ token: "set", env: { BASTRA_AUTH_LOOPBACK_SKIP: "0" } }, async (port) => {
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
  for (const tokenState of ["set", "unset"] as const) {
    await withServer({ token: tokenState }, async (port) => {
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

      // Erlaubte Origin, aber ohne konfiguriertes Token kommt auch sie nicht rein.
      const allowed = await call(
        port,
        "POST",
        "/api/v1/recall",
        { host: `127.0.0.1:${port}`, origin: "https://bastra.io", ...JSON_HEADERS },
        JSON.stringify({ query: "a1" }),
      );
      assert.equal(allowed.status, 401, "a browser needs the token, configured or not");
    });
  }
});

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
  await withServer({ token: "set" }, async (port) => {
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

test("#526: the raw tunnel stays shut when no token is configured at all", async () => {
  await withServer({ token: "unset" }, async (port) => {
    await withRawForwarder(port, async (fwdPort) => {
      const tunneled = await rawRequest(fwdPort, `GET /api/v1/graph/node?id=a1 HTTP/1.0\r\nHost: ${FOREIGN}\r\n\r\n`);
      assert.match(tunneled, /^HTTP\/1\.1 401 /);
      assert.doesNotMatch(tunneled, /Body of a1/, "no memory body may leak");
    });
  });
});

test("#526: a MISSING Host header is rejected on the tokenless loopback routes too", async () => {
  await withServer({ token: "set" }, async (port) => {
    // /health und /hook/* kennen gar kein Token — dort bleibt nur das Host-Gate.
    const health = await rawRequest(port, "GET /health HTTP/1.0\r\n\r\n");
    assert.match(health, /^HTTP\/1\.1 403 /);
    // Mit loopback-Host ist derselbe Endpoint unverändert offen.
    const ok = await rawRequest(port, `GET /health HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    assert.match(ok, /^HTTP\/1\.1 200 /);
  });
});

// ── Die erschöpfende Tabelle inkl. Peer-Achse ─────────────────────────
//
// {Peer loopback / nicht} × {Host loopback / fremd / fehlend} × {Token gesetzt
// / leer / nicht gesetzt}, ohne Authorization-Header. Die Peer-Achse ist gegen
// den echten Server nicht erreichbar (Bind-Policy 127.0.0.1), darum hier auf
// der Entscheidungsfunktion — dieselbe, die http.ts aufruft. Kein Feld bleibt
// undefiniert, das war die Lücke.
test("#526: full peer × host × token matrix on the gate — 18 defined cells", () => {
  const cells: Array<[peer: boolean, host: HostCase, token: TokenState, expect: 200 | 401]> = [
    // Loopback-Peer: nur ein loopback Host ist ein direkter lokaler Client.
    [true, "loopback", "set", 200],
    [true, "loopback", "empty", 200],
    [true, "loopback", "unset", 200],
    [true, "foreign", "set", 401],
    [true, "foreign", "empty", 401],
    [true, "foreign", "unset", 401],
    [true, "missing", "set", 401],
    [true, "missing", "empty", 401],
    [true, "missing", "unset", 401],
    // Nicht-loopback Peer: nie ein direkter lokaler Client, der Host rettet
    // nichts — ein gefälschter `Host: 127.0.0.1` erst recht nicht.
    [false, "loopback", "set", 401],
    [false, "loopback", "empty", 401],
    [false, "loopback", "unset", 401],
    [false, "foreign", "set", 401],
    [false, "foreign", "empty", 401],
    [false, "foreign", "unset", 401],
    [false, "missing", "set", 401],
    [false, "missing", "empty", 401],
    [false, "missing", "unset", 401],
  ];
  assert.equal(cells.length, 18, "2 peer × 3 host × 3 token — no cell may be missing");
  for (const [peer, host, token, expect] of cells) {
    const got = gateApiRequest({
      reqOrigin: undefined,
      allowedOrigin: null,
      isLoopback: peer,
      isLoopbackHost: host === "loopback",
      authHeader: "",
      apiToken: TOKEN_ENV[token] ?? "",
      loopbackSkip: true,
    });
    assert.equal(got, expect, `peer=${peer} host=${host} token=${token}`);
  }
});

test("#526: with a token the same matrix opens exactly the cells the bearer earns", () => {
  for (const host of ["loopback", "foreign", "missing"] as const) {
    for (const peer of [true, false]) {
      const got = gateApiRequest({
        reqOrigin: undefined,
        allowedOrigin: null,
        isLoopback: peer,
        isLoopbackHost: host === "loopback",
        authHeader: `Bearer ${TOKEN}`,
        apiToken: TOKEN,
        loopbackSkip: true,
      });
      assert.equal(got, 200, `a correct bearer must work everywhere (peer=${peer} host=${host})`);
    }
    // Ohne konfiguriertes Token kann derselbe Bearer nichts öffnen, was nicht
    // direkt lokal ist.
    const tokenless = gateApiRequest({
      reqOrigin: undefined,
      allowedOrigin: null,
      isLoopback: true,
      isLoopbackHost: host === "loopback",
      authHeader: `Bearer ${TOKEN}`,
      apiToken: "",
      loopbackSkip: true,
    });
    assert.equal(tokenless, host === "loopback" ? 200 : 401, `tokenless daemon, host=${host}`);
  }
});
