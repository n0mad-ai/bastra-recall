/**
 * #1279 Phase 2: the daemon as its own OAuth 2.1 authorization server, so
 * ChatGPT and claude.ai custom connectors — which only speak OAuth, never a
 * static bearer header — can reach /api/v1/mcp.
 *
 * Single user, single resource. The one human gate is the authorize page: the
 * user approves a client by typing the daemon's existing API token. Everything
 * else follows the MCP authorization spec (2025-11-25, the version SDK 1.32.1
 * implements): protected resource metadata (RFC 9728), authorization server
 * metadata (RFC 8414), dynamic client registration (RFC 7591), authorization
 * code + PKCE S256 only, rotating refresh tokens, and RFC 8707 audience binding
 * to the canonical MCP URL. Client ID Metadata Documents are not offered: they
 * would make the daemon fetch arbitrary URLs (SSRF), and both target clients
 * fall back to DCR when the metadata does not advertise them.
 *
 * Paths: the issuer is the bare public origin, because RFC 8414 then puts its
 * metadata at `/.well-known/oauth-authorization-server` — the one URL every
 * client probes, including the ones that ignore an issuer path. The protected
 * resource metadata sits at the RFC 9728 path for /api/v1/mcp and at the root.
 * Those well-known documents are public and carry no secret, so they pass the
 * front door ahead of the rebinding host gate (http.ts). The endpoints that act
 * live under /api/v1/oauth/ like the rest of the remote surface.
 *
 * The public origin comes from the Host header (the tunnel preserves it).
 * https unless the Host is loopback — the spec requires https for every
 * authorization endpoint, and loopback only exists for local tests.
 *
 * In memory: pending authorize requests, authorization codes and the failure
 * throttle. A daemon restart drops a half-finished login; the client simply
 * starts over. Persistent state is in oauth-store.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { isLoopbackHost, safeEqual } from "./http-auth.js";
import { sendJson } from "./http-util.js";
import {
  createGrant,
  getClient,
  refreshGrant,
  registerClient,
  revokeGrant,
  sanitizeClientName,
  verifyAccessToken,
} from "./oauth-store.js";
import { renderAuthorizePage, renderErrorPage } from "./oauth-page.js";

export const MCP_PATH = "/api/v1/mcp";
const SCOPE = "mcp";
const PRM_PATH = "/.well-known/oauth-protected-resource";
const ASM_PATH = "/.well-known/oauth-authorization-server";
const OAUTH_PREFIX = "/api/v1/oauth/";
const PENDING_TTL_MS = 10 * 60_000;
/** Open logins per client. A full client evicts its own oldest, so anonymous
 *  GETs against some other client_id never push out the user's open page. */
const MAX_PENDING_PER_CLIENT = 5;
const CODE_TTL_MS = 2 * 60_000;
/** Brute force on the authorize form: a pending request dies after this many
 *  wrong API tokens, so a guesser has to open a new one each time. Per
 *  request, not global — an attacker's failures must not lock the user out. */
const MAX_FAILURES_PER_REQUEST = 5;
/** Backstop over all requests: far above anything a human mistypes, it caps
 *  how fast a script cycling fresh requests can guess. Behind the tunnel every
 *  caller is the same loopback peer, so there is no per-IP alternative. */
const MAX_FAILURES_GLOBAL = 100;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FORM_BYTES = 16 * 1024;
/** The only places a login may send its code: the two products this door
 *  exists for, plus loopback for local tools and tests. Open DCR redirects
 *  would let anyone register an attacker URL under the name "ChatGPT" and
 *  phish a consent; a fixed list closes that. */
const REDIRECT_HOSTS = ["chatgpt.com", "chat.openai.com", "claude.ai", "claude.com"];
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1"];

interface PendingAuth {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  resource: string;
  issuer: string;
  expires_at: number;
  failures: number;
}

interface AuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  expires_at: number;
}

export interface OAuthState {
  pending: Map<string, PendingAuth>;
  codes: Map<string, AuthCode>;
  /** Codes already exchanged → the grant they produced, until they would have
   *  expired. A second exchange means the code leaked: the grant goes too. */
  used: Map<string, { grant_id: string; expires_at: number }>;
  failures: number[];
}

export function createOAuthState(): OAuthState {
  return { pending: new Map(), codes: new Map(), used: new Map(), failures: [] };
}

// ─── origin, resource, challenge ─────────────────────────────────

const HOST_RE = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;

/** The public origin the caller reached, or null for a missing/odd Host. */
export function publicOrigin(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host || !HOST_RE.test(host)) return null;
  const scheme = isLoopbackHost(host, []) ? "http" : "https";
  return `${scheme}://${host.toLowerCase()}`;
}

/** RFC 8707 form for comparison: no query/fragment, no trailing slash. */
export function normalizeResource(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.search || u.hash || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** `WWW-Authenticate` for a 401 from /api/v1/mcp (RFC 9728 §5.1). */
export function mcpChallenge(req: IncomingMessage, invalidToken: boolean): string | null {
  const origin = publicOrigin(req);
  if (!origin) return null;
  const err = invalidToken ? `error="invalid_token", ` : "";
  return `Bearer ${err}resource_metadata="${origin}${PRM_PATH}${MCP_PATH}", scope="${SCOPE}"`;
}

/** Does the request carry an OAuth access token issued for THIS MCP URL?
 *  Only /api/v1/mcp asks — the token is worthless on every other route. */
export async function verifyMcpBearer(req: IncomingMessage): Promise<boolean> {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? "");
  const origin = publicOrigin(req);
  if (!m || !origin) return false;
  return verifyAccessToken(m[1], origin + MCP_PATH);
}

// ─── well-known metadata ─────────────────────────────────────────

function sendMetadata(res: ServerResponse, body: unknown): void {
  // Public by design: a browser-based client may read it cross-origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "max-age=300");
  sendJson(res, 200, body);
}

/** Front-door route for the well-known documents. True when handled. */
export function dispatchOAuthWellKnown(req: IncomingMessage, res: ServerResponse, method: string, url: string): boolean {
  const path = url.split("?", 1)[0];
  const isPrm = path === PRM_PATH || path === PRM_PATH + MCP_PATH;
  if (!isPrm && path !== ASM_PATH) return false;
  if (method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  const origin = publicOrigin(req);
  if (!origin) {
    sendJson(res, 400, { error: "missing or invalid Host header" });
    return true;
  }
  if (isPrm) {
    sendMetadata(res, {
      resource: origin + MCP_PATH,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Bastra Recall",
    });
    return true;
  }
  sendMetadata(res, {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_PREFIX}authorize`,
    token_endpoint: `${origin}${OAUTH_PREFIX}token`,
    registration_endpoint: `${origin}${OAUTH_PREFIX}register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  });
  return true;
}

// ─── request helpers ─────────────────────────────────────────────

/** Small bodies only; an oversized one is cut off at the socket — these are
 *  public endpoints, nothing legitimate sends 16 KiB here. */
function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FORM_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** RFC 6749 §3.1: a parameter sent twice is an error, not "first one wins". */
export function singleParams(params: URLSearchParams): Record<string, string> | null {
  const out = new Map<string, string>();
  for (const [k, v] of params) {
    if (out.has(k)) return null;
    out.set(k, v);
  }
  // Keep arbitrary extension parameters as own data, including __proto__,
  // without invoking setters on Object.prototype.
  return Object.fromEntries(out);
}

/** OAuth bodies are form-encoded; a JSON body is tolerated for clients that
 *  send one anyway. Only string fields are kept. */
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readRaw(req);
  const type = (req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") {
    const fields = singleParams(new URLSearchParams(raw));
    if (!fields) throw new Error("duplicate parameter");
    return fields;
  }
  const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function oauthError(res: ServerResponse, status: number, error: string, description?: string): void {
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, status, description ? { error, error_description: description } : { error });
}

/** https to one of {@link REDIRECT_HOSTS}, or plain http to loopback on any
 *  port; no fragments, no userinfo, no other schemes or hosts. */
export function allowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return REDIRECT_HOSTS.includes(u.hostname) && u.port === "";
  return u.protocol === "http:" && LOOPBACK_HOSTS.includes(u.hostname);
}

function redirectWith(res: ServerResponse, redirectUri: string, params: Record<string, string | null>): void {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  res.setHeader("Location", u.toString());
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(302);
  res.end();
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // No script, no framing (clickjacking on the consent button), no referrer
  // leaking the authorize query string to the redirect target.
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status);
  res.end(html);
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sweep<T extends { expires_at: number }>(map: Map<string, T>, now: number): void {
  for (const [k, v] of map) if (v.expires_at <= now) map.delete(k);
}

// ─── /api/v1/oauth/* ─────────────────────────────────────────────

export interface OAuthApiCtx {
  apiToken: string;
  state: OAuthState;
}

// Public token acquisition routes are an explicit allowlist, before the
// bearer gate. Each handler applies its own OAuth validation/consent checks.
type PublicOAuthRoute = (req: IncomingMessage, res: ServerResponse, url: string, origin: string, ctx: OAuthApiCtx) => Promise<void>;
const PUBLIC_OAUTH_ROUTES = new Map<string, ReadonlyMap<string, PublicOAuthRoute>>([
  ["register", new Map([["POST", (req, res) => handleRegister(req, res)]])],
  ["authorize", new Map([
    ["GET", (_req, res, url, origin, ctx) => handleAuthorizeGet(res, url, origin, ctx.state)],
    ["POST", (req, res, _url, _origin, ctx) => handleAuthorizePost(req, res, ctx)],
  ])],
  ["token", new Map([["POST", (req, res, _url, origin, ctx) => handleToken(req, res, origin, ctx.state)]])],
]);

/** Ahead of the bearer gate: these endpoints ARE how a client gets a token. */
export function dispatchOAuthApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  ctx: OAuthApiCtx,
): boolean {
  const path = url.split("?", 1)[0];
  if (!path.startsWith(OAUTH_PREFIX)) return false;
  const origin = publicOrigin(req);
  if (!origin) {
    sendJson(res, 400, { error: "missing or invalid Host header" });
    return true;
  }
  const endpoint = path.slice(OAUTH_PREFIX.length);
  const methods = PUBLIC_OAUTH_ROUTES.get(endpoint);
  const route = methods?.get(method);
  if (!route) {
    sendJson(res, methods ? 405 : 404, { error: "not found" });
    return true;
  }
  route(req, res, url, origin, ctx).catch((err: Error) => {
    if (!res.headersSent) oauthError(res, 400, "invalid_request", err.message);
  });
  return true;
}

async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readRaw(req)) as Record<string, unknown>;
    if (typeof body !== "object" || body === null) throw new Error("body must be a JSON object");
  } catch (err) {
    return oauthError(res, 400, "invalid_client_metadata", (err as Error).message);
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && allowedRedirectUri(u))) {
    return oauthError(res, 400, "invalid_redirect_uri", `redirect_uris must be https on ${REDIRECT_HOSTS.join(", ")} or http on localhost`);
  }
  const grantTypes = body.grant_types;
  if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code"))) {
    return oauthError(res, 400, "invalid_client_metadata", "only the authorization_code grant is supported");
  }
  const responseTypes = body.response_types;
  if (responseTypes !== undefined && (!Array.isArray(responseTypes) || responseTypes.some((t) => t !== "code"))) {
    return oauthError(res, 400, "invalid_client_metadata", "only response_type code is supported");
  }
  const rawName = typeof body.client_name === "string" ? sanitizeClientName(body.client_name).trim() : "";
  const client = await registerClient({
    client_name: rawName.slice(0, 120) || "Unnamed client",
    redirect_uris: uris as string[],
  });
  if (!client) return oauthError(res, 400, "invalid_client_metadata", "too many registered clients — revoke some with `bastra oauth revoke`");
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 201, {
    client_id: client.client_id,
    client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

async function handleAuthorizeGet(res: ServerResponse, url: string, origin: string, state: OAuthState): Promise<void> {
  const params = singleParams(new URL(url, origin).searchParams);
  if (!params) return sendHtml(res, 400, renderErrorPage("Invalid sign-in request: a parameter was sent twice."));
  const q = new URLSearchParams(params);
  const clientId = q.get("client_id") ?? "";
  const client = clientId ? await getClient(clientId) : null;
  if (!client) return sendHtml(res, 400, renderErrorPage("Unknown client. Remove the connector and add it again."));
  const requested = q.get("redirect_uri");
  const redirectUri = requested ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  // Never redirect to an address the client did not register (open redirect),
  // nor to one the allowlist no longer covers.
  if (!redirectUri || !client.redirect_uris.includes(redirectUri) || !allowedRedirectUri(redirectUri)) {
    return sendHtml(res, 400, renderErrorPage("The redirect address does not match this client's registration."));
  }
  // Before the user has consented, nothing redirects: a malformed request
  // gets a page here, so this endpoint cannot be used to bounce a browser
  // to the client's address with attacker-chosen error text.
  const fail = (description: string) => sendHtml(res, 400, renderErrorPage(`Invalid sign-in request: ${description}.`));
  if (q.get("response_type") !== "code") return fail("response_type must be code");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail("PKCE with code_challenge_method S256 is required");
  }
  const canonical = origin + MCP_PATH;
  const resource = q.get("resource");
  if (resource !== null && normalizeResource(resource) !== canonical) {
    return fail(`this server only issues tokens for ${canonical}`);
  }
  const stateParam = q.get("state");

  const now = Date.now();
  sweep(state.pending, now);
  const own = [...state.pending].filter(([, p]) => p.client_id === client.client_id);
  for (const [key] of own.slice(0, Math.max(0, own.length - MAX_PENDING_PER_CLIENT + 1))) state.pending.delete(key);
  // The pending id doubles as the form's CSRF token: unguessable, bound to
  // the validated request server-side, single use. A foreign page can submit
  // the form only if it can read this page — which CSP and SOP prevent.
  const id = randomBytes(24).toString("base64url");
  state.pending.set(id, {
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uri: redirectUri,
    state: stateParam,
    code_challenge: challenge,
    resource: canonical,
    issuer: origin,
    expires_at: now + PENDING_TTL_MS,
    failures: 0,
  });
  sendHtml(res, 200, renderAuthorizePage({ requestId: id, clientName: client.client_name, redirectUri, error: null }));
}

function lockedUntil(state: OAuthState, now: number): number | null {
  state.failures = state.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
  return state.failures.length >= MAX_FAILURES_GLOBAL ? state.failures[0] + FAILURE_WINDOW_MS : null;
}

async function handleAuthorizePost(req: IncomingMessage, res: ServerResponse, ctx: OAuthApiCtx): Promise<void> {
  const form = await readForm(req);
  const { state } = ctx;
  const now = Date.now();
  sweep(state.pending, now);
  const pending = state.pending.get(form.request ?? "");
  if (!pending) return sendHtml(res, 400, renderErrorPage("This sign-in request expired or was already used. Start the connection again."));
  const back = { state: pending.state, iss: pending.issuer };
  if (form.action === "deny") {
    state.pending.delete(form.request);
    return redirectWith(res, pending.redirect_uri, { error: "access_denied", ...back });
  }
  const until = lockedUntil(state, now);
  if (until !== null) {
    res.setHeader("Retry-After", String(Math.ceil((until - now) / 1000)));
    return sendHtml(res, 429, renderErrorPage("Too many wrong tokens. The form is locked for a few minutes."));
  }
  if (!ctx.apiToken || !safeEqual(form.api_token ?? "", ctx.apiToken)) {
    state.failures.push(now);
    pending.failures += 1;
    if (pending.failures >= MAX_FAILURES_PER_REQUEST) {
      state.pending.delete(form.request);
      return sendHtml(res, 401, renderErrorPage("Too many wrong tokens for this sign-in. Start the connection again."));
    }
    return sendHtml(res, 401, renderAuthorizePage({
      requestId: form.request,
      clientName: pending.client_name,
      redirectUri: pending.redirect_uri,
      error: ctx.apiToken ? "Wrong API token." : "This daemon has no API token. Run `bastra token` and restart the daemon.",
    }));
  }
  state.pending.delete(form.request);
  sweep(state.codes, now);
  const code = randomBytes(32).toString("base64url");
  state.codes.set(code, {
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    resource: pending.resource,
    expires_at: now + CODE_TTL_MS,
  });
  redirectWith(res, pending.redirect_uri, { code, ...back });
}

/** Public clients send client_id in the body; tolerate HTTP Basic too. */
function clientIdOf(req: IncomingMessage, form: Record<string, string>): string {
  if (form.client_id) return form.client_id;
  const m = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return "";
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  return decodeURIComponent(decoded.split(":", 1)[0]);
}

async function handleToken(req: IncomingMessage, res: ServerResponse, origin: string, state: OAuthState): Promise<void> {
  const form = await readForm(req);
  const clientId = clientIdOf(req, form);
  const resource = form.resource ? normalizeResource(form.resource) : null;
  if (form.resource && resource !== origin + MCP_PATH) {
    return oauthError(res, 400, "invalid_target", `this server only issues tokens for ${origin + MCP_PATH}`);
  }
  if (!clientId) return oauthError(res, 401, "invalid_client", "client_id is required");

  let tokens;
  if (form.grant_type === "authorization_code") {
    const now = Date.now();
    sweep(state.used, now);
    const reused = state.used.get(form.code ?? "");
    if (reused) {
      // OAuth 2.1 §4.1.3: a code presented twice was intercepted — whatever
      // it already bought is revoked too.
      state.used.delete(form.code);
      await revokeGrant(reused.grant_id);
      return oauthError(res, 400, "invalid_grant", "code was already used");
    }
    const code = state.codes.get(form.code ?? "");
    // Single use, even when the exchange below fails: a code that met a wrong
    // verifier may have been intercepted.
    if (code) state.codes.delete(form.code);
    if (!code || code.expires_at <= now) return oauthError(res, 400, "invalid_grant", "unknown or expired code");
    if (code.client_id !== clientId) return oauthError(res, 400, "invalid_grant", "code was issued to another client");
    if (form.redirect_uri !== undefined && form.redirect_uri !== code.redirect_uri) {
      return oauthError(res, 400, "invalid_grant", "redirect_uri does not match");
    }
    // RFC 7636 §4.1: 43–128 characters from the unreserved set.
    const verifier = form.code_verifier ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(s256(verifier), code.code_challenge)) {
      return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
    }
    if (resource !== null && resource !== code.resource) return oauthError(res, 400, "invalid_target", "resource does not match");
    const created = await createGrant({ client_id: clientId, resource: code.resource, scope: SCOPE });
    if (created) state.used.set(form.code, { grant_id: created.grantId, expires_at: code.expires_at });
    tokens = created?.tokens ?? null;
  } else if (form.grant_type === "refresh_token") {
    tokens = await refreshGrant({ refresh_token: form.refresh_token ?? "", client_id: clientId, resource });
  } else {
    return oauthError(res, 400, "unsupported_grant_type");
  }
  if (!tokens) return oauthError(res, 400, "invalid_grant", "grant is invalid, expired or revoked");
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, { ...tokens, token_type: "Bearer" });
}
