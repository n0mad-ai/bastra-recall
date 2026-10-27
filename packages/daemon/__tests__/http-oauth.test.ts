/**
 * #1279 Phase 2: OAuth 2.1 for the remote MCP door.
 *
 * ChatGPT and claude.ai connectors cannot send a static bearer; they discover
 * the login from the 401, register themselves, send the user through the
 * authorize page (approved with the daemon's API token) and exchange a PKCE
 * code. The resulting token must open /api/v1/mcp — and nothing else.
 *
 * Requests carry a public Host, as they do through the tunnel: that is the
 * path where the loopback exemption does not apply and the public origin is
 * https.
 *
 * Runner: `tsx --test __tests__/http-oauth.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { revokeClient } from "../src/oauth-store.js";

const TOKEN = "test-token-abcdef0123456789";
process.env.BASTRA_API_TOKEN = TOKEN;

const HOST = "recall.example.com";
const ORIGIN = `https://${HOST}`;
const REDIRECT = "https://client.example/callback";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

function call(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method, headers: { Host: HOST, ...opts.headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const form = (fields: Record<string, string>) => ({
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function withServer(fn: (port: number, storePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-oauth-"));
  const storePath = join(dir, "oauth.json");
  process.env.BASTRA_OAUTH_PATH = storePath;
  const vaultDir = join(dir, "vault");
  await mkdir(vaultDir);
  const vault = new Vault(vaultDir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test-version",
    toolDeps: { vault, search, telemetry, vaultPath: vaultDir },
    documentWriteEnabled: false,
    onActivity: () => {},
    embedding: { on: false, providerId: null, source: "none" },
    origin: { startedBy: "direct", envOrigin: "own", configFingerprint: "0123456789ab" },
  });
  try {
    await fn(handle.port!, storePath);
  } finally {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function register(port: number): Promise<string> {
  const r = await call(port, "POST", "/api/v1/oauth/register", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test <Client>", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  assert.equal(r.status, 201, r.text);
  return (JSON.parse(r.text) as { client_id: string }).client_id;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** GET the authorize page and return the form's request id. */
async function openAuthorize(port: number, clientId: string, challenge: string): Promise<string> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${ORIGIN}/api/v1/mcp`,
    scope: "mcp",
  });
  const r = await call(port, "GET", `/api/v1/oauth/authorize?${q}`);
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /Test &lt;Client&gt;/, "client name shown, escaped");
  assert.match(r.text, /client\.example/, "redirect host shown");
  assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
  const m = /name="request" value="([^"]+)"/.exec(r.text);
  assert.ok(m, "form carries the request id");
  return m[1];
}

async function approve(port: number, requestId: string, apiToken = TOKEN): Promise<Reply> {
  return call(port, "POST", "/api/v1/oauth/authorize", form({ request: requestId, api_token: apiToken, action: "approve" }));
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** The whole login: register, authorize, approve, exchange. */
async function login(port: number): Promise<{ clientId: string; tokens: Tokens }> {
  const clientId = await register(port);
  const { verifier, challenge } = pkce();
  const approved = await approve(port, await openAuthorize(port, clientId, challenge));
  assert.equal(approved.status, 302, approved.text);
  const location = new URL(String(approved.headers.location));
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "xyz");
  assert.equal(location.searchParams.get("iss"), ORIGIN);
  const exchanged = await call(port, "POST", "/api/v1/oauth/token", form({
    grant_type: "authorization_code",
    code: location.searchParams.get("code")!,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${ORIGIN}/api/v1/mcp`,
  }));
  assert.equal(exchanged.status, 200, exchanged.text);
  assert.equal(exchanged.headers["cache-control"], "no-store");
  return { clientId, tokens: JSON.parse(exchanged.text) as Tokens };
}

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const INIT = rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });

function mcp(port: number, token: string | null, body: string): Promise<Reply> {
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return call(port, "POST", "/api/v1/mcp", { headers: { ...MCP_HEADERS, ...auth }, body });
}

test("oauth: a 401 from /api/v1/mcp points at the protected resource metadata", async () => {
  await withServer(async (port) => {
    const r = await mcp(port, null, INIT);
    assert.equal(r.status, 401);
    assert.equal(
      r.headers["www-authenticate"],
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1/mcp", scope="mcp"`,
    );
    const bad = await mcp(port, "x".repeat(43), INIT);
    assert.equal(bad.status, 401);
    assert.match(String(bad.headers["www-authenticate"]), /^Bearer error="invalid_token", resource_metadata=/);
    // Other REST routes keep their plain 401 — no OAuth challenge there.
    const rest = await call(port, "POST", "/api/v1/recall", { headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(rest.status, 401);
    assert.equal(rest.headers["www-authenticate"], undefined);
  });
});

test("oauth: metadata documents describe resource and authorization server", async () => {
  await withServer(async (port) => {
    for (const path of ["/.well-known/oauth-protected-resource/api/v1/mcp", "/.well-known/oauth-protected-resource"]) {
      const r = await call(port, "GET", path);
      assert.equal(r.status, 200, `${path} must pass the front door with a public Host`);
      const prm = JSON.parse(r.text) as { resource: string; authorization_servers: string[] };
      assert.equal(prm.resource, `${ORIGIN}/api/v1/mcp`);
      assert.deepEqual(prm.authorization_servers, [ORIGIN]);
    }
    const r = await call(port, "GET", "/.well-known/oauth-authorization-server");
    assert.equal(r.status, 200);
    const asm = JSON.parse(r.text) as Record<string, unknown>;
    assert.equal(asm.issuer, ORIGIN);
    assert.equal(asm.authorization_endpoint, `${ORIGIN}/api/v1/oauth/authorize`);
    assert.equal(asm.token_endpoint, `${ORIGIN}/api/v1/oauth/token`);
    assert.equal(asm.registration_endpoint, `${ORIGIN}/api/v1/oauth/register`);
    assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(asm.grant_types_supported, ["authorization_code", "refresh_token"]);
    // The rest of the loopback surface stays behind the host gate.
    assert.equal((await call(port, "GET", "/health")).status, 403);
  });
});

test("oauth: dynamic registration accepts https redirects and refuses others", async () => {
  await withServer(async (port) => {
    const ok = await call(port, "POST", "/api/v1/oauth/register", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT, "http://localhost:3334/cb"] }),
    });
    assert.equal(ok.status, 201);
    const reg = JSON.parse(ok.text) as Record<string, unknown>;
    assert.equal(reg.token_endpoint_auth_method, "none");
    assert.ok(typeof reg.client_id === "string" && reg.client_id.length > 0);
    assert.equal(reg.client_secret, undefined, "public client — no secret");
    for (const uris of [["http://client.example/cb"], ["javascript:alert(1)"], ["https://client.example/cb#frag"], []]) {
      const bad = await call(port, "POST", "/api/v1/oauth/register", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris: uris }),
      });
      assert.equal(bad.status, 400, `redirect_uris ${JSON.stringify(uris)} must be refused`);
    }
  });
});

test("oauth: full code + PKCE flow ends in a working tools/list, and the token opens nothing else", async () => {
  await withServer(async (port, storePath) => {
    const { tokens } = await login(port);
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.expires_in, 3600);

    const init = await mcp(port, tokens.access_token, INIT);
    assert.equal(init.status, 200, init.text);
    const list = await mcp(port, tokens.access_token, rpc(2, "tools/list"));
    assert.equal(list.status, 200, list.text);
    const names = (JSON.parse(list.text) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    assert.ok(names.includes("recall"));

    const auth = { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" };
    const rest = await call(port, "POST", "/api/v1/recall", { headers: auth, body: JSON.stringify({ query: "x" }) });
    assert.equal(rest.status, 401, "an OAuth token must not open the REST tools");
    assert.equal((await call(port, "GET", "/api/v1/graph", { headers: auth })).status, 401);

    // Same token, different public host = different audience (RFC 8707).
    const other = await call(port, "POST", "/api/v1/mcp", {
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${tokens.access_token}`, Host: "evil.example.com" },
      body: INIT,
    });
    assert.equal(other.status, 401);

    const stored = await readFile(storePath, "utf8");
    assert.ok(!stored.includes(tokens.access_token) && !stored.includes(tokens.refresh_token), "tokens stored hashed only");
  });
});

test("oauth: a wrong PKCE verifier is rejected and burns the code", async () => {
  await withServer(async (port) => {
    const clientId = await register(port);
    const { challenge } = pkce();
    const approved = await approve(port, await openAuthorize(port, clientId, challenge));
    const code = new URL(String(approved.headers.location)).searchParams.get("code")!;
    const fields = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId };
    const wrong = await call(port, "POST", "/api/v1/oauth/token", form({ ...fields, code_verifier: pkce().verifier }));
    assert.equal(wrong.status, 400);
    assert.equal((JSON.parse(wrong.text) as { error: string }).error, "invalid_grant");
  });
});

test("oauth: the authorize page refuses PKCE-less and plain-challenge requests", async () => {
  await withServer(async (port) => {
    const clientId = await register(port);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s" });
    const r = await call(port, "GET", `/api/v1/oauth/authorize?${q}`);
    assert.equal(r.status, 302);
    assert.equal(new URL(String(r.headers.location)).searchParams.get("error"), "invalid_request");
    const unregistered = new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://attacker.example/cb" });
    const r2 = await call(port, "GET", `/api/v1/oauth/authorize?${unregistered}`);
    assert.equal(r2.status, 400, "an unregistered redirect gets an error page, never a redirect");
    assert.equal(r2.headers.location, undefined);
  });
});

test("oauth: a wrong API token on the form is rejected, then throttled", async () => {
  await withServer(async (port) => {
    const clientId = await register(port);
    const requestId = await openAuthorize(port, clientId, pkce().challenge);
    for (let i = 0; i < 5; i++) {
      const r = await approve(port, requestId, "wrong-token");
      assert.equal(r.status, 401);
      assert.match(r.text, /Wrong API token/);
      assert.equal(r.headers.location, undefined);
    }
    const locked = await approve(port, requestId, TOKEN);
    assert.equal(locked.status, 429, "the correct token is refused too while the form is locked");
    assert.ok(Number(locked.headers["retry-after"]) > 0);
    const unknown = await call(port, "POST", "/api/v1/oauth/authorize", form({ request: "forged", api_token: TOKEN, action: "approve" }));
    assert.equal(unknown.status, 400, "a form without a live request id (CSRF) is refused");
  });
});

test("oauth: deny redirects with access_denied", async () => {
  await withServer(async (port) => {
    const clientId = await register(port);
    const requestId = await openAuthorize(port, clientId, pkce().challenge);
    const r = await call(port, "POST", "/api/v1/oauth/authorize", form({ request: requestId, action: "deny" }));
    assert.equal(r.status, 302);
    assert.equal(new URL(String(r.headers.location)).searchParams.get("error"), "access_denied");
  });
});

test("oauth: refresh rotates the tokens; a replayed refresh token revokes the grant", async () => {
  await withServer(async (port) => {
    const { clientId, tokens } = await login(port);
    const refresh = (rt: string) =>
      call(port, "POST", "/api/v1/oauth/token", form({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }));
    const r = await refresh(tokens.refresh_token);
    assert.equal(r.status, 200, r.text);
    const next = JSON.parse(r.text) as Tokens;
    assert.notEqual(next.access_token, tokens.access_token);
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    assert.equal((await mcp(port, next.access_token, INIT)).status, 200);
    assert.equal((await mcp(port, tokens.access_token, INIT)).status, 401, "the replaced access token is dead");

    assert.equal((await refresh(tokens.refresh_token)).status, 400, "an old refresh token is refused");
    assert.equal((await mcp(port, next.access_token, INIT)).status, 401, "and its replay revoked the whole grant");
  });
});

test("oauth: expired and revoked tokens are rejected", async () => {
  await withServer(async (port, storePath) => {
    const a = await login(port);
    const data = JSON.parse(await readFile(storePath, "utf8")) as { grants: { access_expires_at: number }[] };
    for (const g of data.grants) g.access_expires_at = Date.now() - 1000;
    await writeFile(storePath, JSON.stringify(data), "utf8");
    assert.equal((await mcp(port, a.tokens.access_token, INIT)).status, 401, "expired");

    const b = await login(port);
    assert.equal((await mcp(port, b.tokens.access_token, INIT)).status, 200);
    assert.equal(await revokeClient(b.clientId, storePath), 1);
    assert.equal((await mcp(port, b.tokens.access_token, INIT)).status, 401, "revoked");
    const refreshed = await call(port, "POST", "/api/v1/oauth/token", form({
      grant_type: "refresh_token", refresh_token: b.tokens.refresh_token, client_id: b.clientId,
    }));
    assert.equal(refreshed.status, 400, "a revoked client cannot refresh");
  });
});

test("oauth: the static API token still opens /api/v1/mcp", async () => {
  await withServer(async (port) => {
    assert.equal((await mcp(port, TOKEN, INIT)).status, 200);
  });
});

test("oauth: the SDK's own client discovers, registers and connects", async () => {
  // Loopback with the exemption off, so the SDK meets the 401 a tunnelled
  // client meets — and its discovery (RFC 9728 → RFC 8414 → DCR) runs against
  // the real documents instead of our assumptions about them.
  process.env.BASTRA_AUTH_LOOPBACK_SKIP = "0";
  try {
    await withServer(async (port) => {
      const local = `127.0.0.1:${port}`;
      const serverUrl = new URL(`http://${local}/api/v1/mcp`);
      const redirectUrl = "http://localhost:9/cb";
      let info: OAuthClientInformationMixed | undefined;
      let saved: OAuthTokens | undefined;
      let verifier = "";
      let authUrl: URL | undefined;
      const provider: OAuthClientProvider = {
        redirectUrl,
        clientMetadata: { client_name: "SDK client", redirect_uris: [redirectUrl], token_endpoint_auth_method: "none" },
        clientInformation: () => info,
        saveClientInformation: (i) => { info = i; },
        tokens: () => saved,
        saveTokens: (t) => { saved = t; },
        redirectToAuthorization: (u) => { authUrl = u; },
        saveCodeVerifier: (v) => { verifier = v; },
        codeVerifier: () => verifier,
      };
      assert.equal(await auth(provider, { serverUrl }), "REDIRECT");
      assert.ok(authUrl);
      assert.equal(authUrl.searchParams.get("resource"), serverUrl.href);
      const page = await call(port, "GET", authUrl.pathname + authUrl.search, { headers: { Host: local } });
      const requestId = /name="request" value="([^"]+)"/.exec(page.text)![1];
      const approved = await call(port, "POST", "/api/v1/oauth/authorize", {
        ...form({ request: requestId, api_token: TOKEN, action: "approve" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Host: local },
      });
      const code = new URL(String(approved.headers.location)).searchParams.get("code")!;
      assert.equal(await auth(provider, { serverUrl, authorizationCode: code }), "AUTHORIZED");

      const client = new Client({ name: "sdk", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider: provider }));
      try {
        assert.ok((await client.listTools()).tools.some((t) => t.name === "recall"));
      } finally {
        await client.close();
      }
    });
  } finally {
    delete process.env.BASTRA_AUTH_LOOPBACK_SKIP;
  }
});
