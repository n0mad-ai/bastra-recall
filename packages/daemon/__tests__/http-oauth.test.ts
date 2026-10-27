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
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
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
import { registerClient, createGrant, revokeClient } from "../src/oauth-store.js";
import { cmdOAuth } from "../src/cli/oauth-cmd.js";

const TOKEN = "test-token-abcdef0123456789";
process.env.BASTRA_API_TOKEN = TOKEN;

const HOST = "recall.example.com";
const ORIGIN = `https://${HOST}`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

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

async function register(port: number, name = "Test <Client>"): Promise<string> {
  const r = await call(port, "POST", "/api/v1/oauth/register", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
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
  assert.match(r.text, /<strong>(Test &lt;Client&gt;|ChatGPT)<\/strong>/, "client name shown, escaped");
  assert.match(r.text, /chatgpt\.com/, "redirect host shown");
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

test("oauth: registration accepts only the allowlisted redirect hosts", async () => {
  await withServer(async (port) => {
    const ok = await call(port, "POST", "/api/v1/oauth/register", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [REDIRECT, "https://claude.ai/api/mcp/auth_callback", "https://claude.com/cb", "https://chat.openai.com/cb", "http://localhost:3334/cb", "http://127.0.0.1:9/cb"],
      }),
    });
    assert.equal(ok.status, 201, ok.text);
    const reg = JSON.parse(ok.text) as Record<string, unknown>;
    assert.equal(reg.token_endpoint_auth_method, "none");
    assert.ok(typeof reg.client_id === "string" && reg.client_id.length > 0);
    assert.equal(reg.client_secret, undefined, "public client — no secret");
    const refused = [
      ["https://attacker.example/cb"],
      ["https://chatgpt.com.attacker.example/cb"],
      ["https://evil.chatgpt.com/cb"],
      ["https://chatgpt.com:8443/cb"],
      ["https://user@chatgpt.com/cb"],
      ["http://chatgpt.com/cb"],
      ["http://client.example/cb"],
      ["javascript:alert(1)"],
      ["https://chatgpt.com/cb#frag"],
      [REDIRECT, "https://attacker.example/cb"],
      [],
    ];
    for (const uris of refused) {
      const bad = await call(port, "POST", "/api/v1/oauth/register", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: uris }),
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

test("oauth: before consent, a malformed request gets a page — never a redirect", async () => {
  await withServer(async (port) => {
    const clientId = await register(port);
    const base = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s" };
    const { challenge } = pkce();
    const cases: Record<string, string>[] = [
      base, // no PKCE
      { ...base, code_challenge: challenge, code_challenge_method: "plain" },
      { ...base, response_type: "token", code_challenge: challenge, code_challenge_method: "S256" },
      { ...base, code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" },
      { ...base, redirect_uri: "https://attacker.example/cb", code_challenge: challenge, code_challenge_method: "S256" },
    ];
    for (const params of cases) {
      const r = await call(port, "GET", `/api/v1/oauth/authorize?${new URLSearchParams(params)}`);
      assert.equal(r.status, 400, JSON.stringify(params));
      assert.equal(r.headers.location, undefined, `no redirect for ${JSON.stringify(params)}`);
    }
    const dup = `/api/v1/oauth/authorize?${new URLSearchParams({ ...base, code_challenge: challenge, code_challenge_method: "S256" })}&client_id=${clientId}`;
    const r = await call(port, "GET", dup);
    assert.equal(r.status, 400, "a duplicated parameter is refused");
    assert.match(r.text, /sent twice/);
  });
});

test("oauth: wrong API tokens burn their own request, not the user's", async () => {
  await withServer(async (port) => {
    const clientId = await register(port);
    const users = await openAuthorize(port, clientId, pkce().challenge);
    const attackers = await openAuthorize(port, await register(port, "ChatGPT"), pkce().challenge);
    for (let i = 0; i < 4; i++) {
      const r = await approve(port, attackers, "wrong-token");
      assert.equal(r.status, 401);
      assert.match(r.text, /Wrong API token/);
      assert.equal(r.headers.location, undefined);
    }
    const fifth = await approve(port, attackers, "wrong-token");
    assert.equal(fifth.status, 401);
    assert.match(fifth.text, /Start the connection again/);
    assert.equal((await approve(port, attackers, TOKEN)).status, 400, "a burnt request stays dead, even with the right token");

    const ok = await approve(port, users, TOKEN);
    assert.equal(ok.status, 302, "the user's own request is untouched by the attacker's failures");
    assert.ok(new URL(String(ok.headers.location)).searchParams.get("code"));

    const unknown = await call(port, "POST", "/api/v1/oauth/authorize", form({ request: "forged", api_token: TOKEN, action: "approve" }));
    assert.equal(unknown.status, 400, "a form without a live request id (CSRF) is refused");
  });
});

test("oauth: the global backstop locks the form after 100 failures", async () => {
  await withServer(async (port) => {
    const clientId = await register(port);
    for (let i = 0; i < 20; i++) {
      const id = await openAuthorize(port, clientId, pkce().challenge);
      for (let j = 0; j < 5; j++) assert.equal((await approve(port, id, "wrong")).status, 401);
    }
    const id = await openAuthorize(port, clientId, pkce().challenge);
    const locked = await approve(port, id, TOKEN);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers["retry-after"]) > 0);
  });
});

test("oauth: open logins are capped per client, so foreign GETs cannot evict the user's", async () => {
  await withServer(async (port) => {
    const userClient = await register(port);
    const users = await openAuthorize(port, userClient, pkce().challenge);
    const other = await register(port, "ChatGPT");
    for (let i = 0; i < 60; i++) await openAuthorize(port, other, pkce().challenge);
    assert.equal((await approve(port, users, TOKEN)).status, 302, "the user's page survives 60 foreign GETs");

    const first = await openAuthorize(port, userClient, pkce().challenge);
    const rest = [];
    for (let i = 0; i < 5; i++) rest.push(await openAuthorize(port, userClient, pkce().challenge));
    assert.equal((await approve(port, first, TOKEN)).status, 400, "the client's own oldest makes room");
    assert.equal((await approve(port, rest[4], TOKEN)).status, 302);
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

test("oauth: refresh rotates; the replaced token gets one grace use within 60 s, then revokes", async () => {
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

    const grace = await refresh(tokens.refresh_token);
    assert.equal(grace.status, 200, "a lost response / parallel worker gets one more rotation");
    const third = JSON.parse(grace.text) as Tokens;
    assert.equal((await mcp(port, third.access_token, INIT)).status, 200);

    assert.equal((await refresh(tokens.refresh_token)).status, 400, "the grace is spent");
    assert.equal((await mcp(port, third.access_token, INIT)).status, 401, "and the second replay revoked the whole grant");
  });
});

test("oauth: a refresh replay after the grace window revokes the grant", async () => {
  await withServer(async (port, storePath) => {
    const { clientId, tokens } = await login(port);
    const refresh = (rt: string) =>
      call(port, "POST", "/api/v1/oauth/token", form({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }));
    const next = JSON.parse((await refresh(tokens.refresh_token)).text) as Tokens;
    const data = JSON.parse(await readFile(storePath, "utf8")) as { grants: { rotated_at: number }[] };
    for (const g of data.grants) g.rotated_at = Date.now() - 61_000;
    await writeFile(storePath, JSON.stringify(data), "utf8");
    assert.equal((await refresh(tokens.refresh_token)).status, 400);
    assert.equal((await mcp(port, next.access_token, INIT)).status, 401, "replay outside the window revokes");
  });
});

test("oauth: a reused code revokes what it bought; a malformed verifier is refused", async () => {
  await withServer(async (port) => {
    const clientId = await register(port);
    const { verifier, challenge } = pkce();
    const approved = await approve(port, await openAuthorize(port, clientId, challenge));
    const code = new URL(String(approved.headers.location)).searchParams.get("code")!;
    const fields = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier };
    const first = await call(port, "POST", "/api/v1/oauth/token", form(fields));
    assert.equal(first.status, 200);
    const tokens = JSON.parse(first.text) as Tokens;
    const second = await call(port, "POST", "/api/v1/oauth/token", form(fields));
    assert.equal(second.status, 400);
    assert.equal((await mcp(port, tokens.access_token, INIT)).status, 401, "the first exchange's token is revoked");

    const p2 = pkce();
    const a2 = await approve(port, await openAuthorize(port, clientId, p2.challenge));
    const code2 = new URL(String(a2.headers.location)).searchParams.get("code")!;
    const short = await call(port, "POST", "/api/v1/oauth/token", form({ ...fields, code: code2, code_verifier: "short" }));
    assert.equal(short.status, 400);
    const dup = await call(port, "POST", "/api/v1/oauth/token", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `${new URLSearchParams({ ...fields, code: code2, code_verifier: p2.verifier })}&client_id=${clientId}`,
    });
    assert.equal(dup.status, 400, "a duplicated form parameter is refused");
  });
});

test("oauth: control characters never reach the terminal", async () => {
  await withServer(async (port, storePath) => {
    await register(port, "\u001b[31mEvil\u0007\u009bName");
    const stored = await readFile(storePath, "utf8");
    assert.ok(!/\\u001b|\\u0007|\\u009b/i.test(stored), "sanitised at registration");
    assert.match(stored, /\[31mEvilName/);

    // A file written by hand (or before the fix) is sanitised again on print.
    const data = JSON.parse(stored) as { clients: { client_name: string }[] };
    data.clients[0].client_name = "\u001b]0;pwned\u0007X";
    await writeFile(storePath, JSON.stringify(data), "utf8");
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    try {
      assert.equal(await cmdOAuth({ sub: "list", positional: ["oauth", "list"], json: false }), 0);
    } finally {
      process.stdout.write = write;
    }
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out), JSON.stringify(out));
    assert.match(out, /\]0;pwnedX/);
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

test("oauth store: unused registrations expire, the cap evicts the oldest unused, no-op writes skip the disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-oauth-store-"));
  const path = join(dir, "oauth.json");
  try {
    const kept = await registerClient({ client_name: "kept", redirect_uris: [REDIRECT] }, path);
    assert.ok(kept && (await createGrant({ client_id: kept.client_id, resource: `${ORIGIN}/api/v1/mcp`, scope: "mcp" }, path)));
    const ids: string[] = [];
    for (let i = 0; i < 99; i++) ids.push((await registerClient({ client_name: `c${i}`, redirect_uris: [REDIRECT] }, path))!.client_id);
    const extra = await registerClient({ client_name: "extra", redirect_uris: [REDIRECT] }, path);
    assert.ok(extra, "at the cap, a new registration still succeeds");
    let data = JSON.parse(await readFile(path, "utf8")) as { clients: { client_id: string; created_at: string }[] };
    const present = new Set(data.clients.map((c) => c.client_id));
    assert.equal(data.clients.length, 100);
    assert.ok(present.has(kept.client_id), "a granted client is never evicted");
    assert.ok(!present.has(ids[0]), "the oldest never-granted one made room");

    // Ten minutes later every never-granted registration is gone.
    for (const c of data.clients) c.created_at = new Date(Date.now() - 11 * 60_000).toISOString();
    await writeFile(path, JSON.stringify(data), "utf8");
    assert.equal(await revokeClient("nobody", path), 0);
    data = JSON.parse(await readFile(path, "utf8")) as typeof data;
    assert.deepEqual(data.clients.map((c) => c.client_id), [kept.client_id]);

    const before = (await stat(path)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await revokeClient("nobody", path), 0);
    assert.equal((await stat(path)).mtimeMs, before, "nothing changed, nothing written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
