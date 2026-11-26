/**
 * #1198 — the sign-in routes of the web UI, exactly as the HTTP contract in
 * the build plan describes them:
 *
 *   GET  /ui/login            the sign-in page (webui/app/login.html)
 *   GET  /ui/auth/state       account, session and setup state (+ CSRF value)
 *   POST /ui/auth/login       {username, password, remember}
 *   POST /ui/auth/logout      ends the own session
 *   POST /ui/auth/logout-all  ends every session
 *   POST /ui/auth/password    {current, next}; ends every session, new one for the caller
 *   POST /ui/auth/setup       first account, only direct on the Mac and only without one
 *
 * They run inside the gate (ui-auth-gate.ts), which has already applied the
 * route policy, the exact Origin through the tunnel and CSRF for writes with a
 * session. No password, user name, token or cookie is ever logged or echoed.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { hasForwardingHeaders, isLoopback, isLoopbackHost } from "./http-auth.js";
import { readJsonBody, sendJson } from "./http-util.js";
import { getUiEnabled } from "./settings.js";
import { uiAuthStores, type UiAuthStores } from "./ui-auth-stores.js";
import { uiUsernameProblem } from "./ui-account-store.js";
import { uiPasswordProblem, type UiPasswordProblem } from "./ui-password.js";
import {
  uiCsrfToken,
  uiSessionClearCookie,
  uiSessionCookie,
  type UiSessionKind,
  type UiSessionOrigin,
} from "./ui-session.js";
import type { UiLoginAccess } from "./ui-login-throttle.js";
import { serveLoginPage } from "./webui.js";

/** What the gate established for a /ui request. */
export interface UiRequestState {
  access: UiSessionOrigin;
  account: "none" | "present" | "damaged";
  session: { id: string; kind: UiSessionKind; token: string } | null;
}

/** Password (max 1024 bytes, JSON-escaped up to 6×) plus user name and framing. */
const AUTH_BODY_MAX_BYTES = 16 * 1024;

type Route = (req: IncomingMessage, res: ServerResponse, state: UiRequestState) => Promise<void>;

const ROUTES = new Map<string, Route>([
  ["GET /ui/login", (_req, res) => serveLoginPage(res)],
  ["GET /ui/auth/state", authState],
  ["POST /ui/auth/login", login],
  ["POST /ui/auth/logout", logout],
  ["POST /ui/auth/logout-all", logoutAll],
  ["POST /ui/auth/password", changePassword],
  ["POST /ui/auth/setup", setup],
]);
const PATHS = new Set([...ROUTES.keys()].map((key) => key.slice(key.indexOf(" ") + 1)));

/** true when the path is a sign-in route (answered here, 405 for another method). */
export function dispatchUiAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  state: UiRequestState
): boolean {
  if (!PATHS.has(pathname)) return false;
  res.setHeader("Cache-Control", "no-store");
  void (async () => {
    if (!(await getUiEnabled())) return sendJson(res, 404, { error: "ui disabled" });
    const route = ROUTES.get(`${method} ${pathname}`);
    if (!route) return sendJson(res, 405, { error: "method not allowed" });
    await route(req, res, state);
  })().catch(() => {
    // Neither storage nor parser errors leave this endpoint.
    if (!res.headersSent) sendJson(res, 500, { error: "auth error" });
    else res.destroy();
  });
  return true;
}

/** First-account setup only on the Mac itself: loopback peer and Host, no proxy headers. */
function directLocal(req: IncomingMessage, state: UiRequestState): boolean {
  return (
    state.access === "local" && isLoopback(req) && isLoopbackHost(req.headers.host, []) && !hasForwardingHeaders(req)
  );
}

async function authState(req: IncomingMessage, res: ServerResponse, state: UiRequestState): Promise<void> {
  const stores = uiAuthStores();
  const account = stores?.accounts.status();
  sendJson(res, 200, {
    account: state.account,
    authenticated: state.session !== null,
    access: state.access,
    setupAllowed: state.account === "none" && directLocal(req, state),
    ...(state.session && account?.state === "present"
      ? { username: account.username, sessionKind: state.session.kind, csrf: uiCsrfToken(state.session.token) }
      : {}),
  });
}

async function body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await readJsonBody(req, AUTH_BODY_MAX_BYTES);
    // JSON null, false, 0 or "" would otherwise read as "already answered" and leave the request hanging.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { error: "invalid-request" });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const tooLarge = (error as Error).message.startsWith("body too large");
    sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? "too-large" : "invalid-request" });
    return null;
  }
}

/** 429 with Retry-After for a lock or a full queue. */
function tooMany(res: ServerResponse, error: "locked" | "busy", retryAfterSeconds: number): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  sendJson(res, 429, { error, retryAfterSeconds });
}

/**
 * One password check under the throttle (check → verify → report). Returns the
 * credential version on success, null when an answer (401/429) was sent.
 */
async function throttledVerify(
  req: IncomingMessage,
  res: ServerResponse,
  stores: UiAuthStores,
  access: UiLoginAccess,
  username: unknown,
  password: unknown
): Promise<number | null> {
  const decision = stores.throttle.check({ access, cfConnectingIp: req.headers["cf-connecting-ip"] });
  if (decision.kind !== "allowed") {
    tooMany(res, decision.kind, decision.retryAfterSeconds);
    return null;
  }
  const run = await stores.throttle.verify(decision, () => stores.accounts.verifyLogin(username, password));
  if (run.kind !== "done") {
    tooMany(res, run.kind, run.retryAfterSeconds);
    return null;
  }
  // Directly after verify(), no await in between: the next waiter must see a lock this outcome sets.
  stores.throttle.report(decision, run.value.ok);
  if (!run.value.ok) {
    sendJson(res, 401, { error: "invalid-credentials" });
    return null;
  }
  return run.value.credentialVersion;
}

function startSession(
  req: IncomingMessage,
  res: ServerResponse,
  stores: UiAuthStores,
  access: UiSessionOrigin,
  kind: UiSessionKind,
  credentialVersion: number
): void {
  stores.sessions.pruneExpired();
  const created = stores.sessions.create({
    kind,
    origin: access,
    credentialVersion,
    userAgent: req.headers["user-agent"],
  });
  res.setHeader("Set-Cookie", uiSessionCookie(access, created));
  sendJson(res, 200, { ok: true });
}

async function login(req: IncomingMessage, res: ServerResponse, state: UiRequestState): Promise<void> {
  const stores = uiAuthStores();
  if (!stores || state.account === "damaged") return sendJson(res, 503, { error: "account-damaged" });
  if (state.account === "none") return sendJson(res, 409, { error: "no-account" });
  const input = await body(req, res);
  if (!input) return;
  const version = await throttledVerify(req, res, stores, state.access, input.username, input.password);
  if (version === null) return;
  // The browser's previous session gives way to the new one.
  if (state.session) stores.sessions.revoke(state.session.id);
  startSession(req, res, stores, state.access, input.remember === true ? "device" : "browser", version);
}

async function logout(_req: IncomingMessage, res: ServerResponse, state: UiRequestState): Promise<void> {
  if (!state.session) return sendJson(res, 401, { error: "auth-required" });
  uiAuthStores()?.sessions.revoke(state.session.id);
  res.setHeader("Set-Cookie", uiSessionClearCookie(state.access));
  sendJson(res, 200, { ok: true });
}

async function logoutAll(_req: IncomingMessage, res: ServerResponse, state: UiRequestState): Promise<void> {
  const stores = uiAuthStores();
  if (!state.session || !stores) return sendJson(res, 401, { error: "auth-required" });
  stores.sessions.revokeAll();
  res.setHeader("Set-Cookie", uiSessionClearCookie(state.access));
  sendJson(res, 200, { ok: true });
}

function invalidPassword(res: ServerResponse, problem: UiPasswordProblem): void {
  sendJson(res, 400, { error: "invalid-password", problem });
}

async function changePassword(req: IncomingMessage, res: ServerResponse, state: UiRequestState): Promise<void> {
  const stores = uiAuthStores();
  const account = stores?.accounts.status();
  if (!state.session || !stores || account?.state !== "present") return sendJson(res, 401, { error: "auth-required" });
  const input = await body(req, res);
  if (!input) return;
  const problem = uiPasswordProblem(input.next);
  if (problem) return invalidPassword(res, problem);
  // The current password is checked under the same limits as a sign-in.
  const verified = await throttledVerify(req, res, stores, state.access, account.username, input.current);
  if (verified === null) return;
  const changed = await stores.accounts.setPassword(input.next);
  if (!changed.ok) return sendJson(res, 409, { error: changed.problem });
  // The new credential version already invalidates every session; remove them too.
  stores.sessions.revokeAll();
  startSession(req, res, stores, state.access, state.session.kind, changed.credentialVersion);
}

async function setup(req: IncomingMessage, res: ServerResponse, state: UiRequestState): Promise<void> {
  // Never through the tunnel (the gate refuses it there already) or any proxy.
  if (!directLocal(req, state)) return sendJson(res, 403, { error: "local-only" });
  const stores = uiAuthStores();
  if (!stores) return sendJson(res, 503, { error: "account-damaged" });
  if (state.account !== "none") return sendJson(res, 409, { error: "account-exists" });
  const input = await body(req, res);
  if (!input) return;
  const nameProblem = uiUsernameProblem(input.username);
  if (nameProblem) return sendJson(res, 400, { error: "invalid-username", problem: nameProblem });
  const passwordProblem = uiPasswordProblem(input.password);
  if (passwordProblem) return invalidPassword(res, passwordProblem);
  const created = await stores.accounts.create(input.username, input.password);
  if (!created.ok) return sendJson(res, 409, { error: "account-exists" });
  startSession(req, res, stores, "local", "browser", created.credentialVersion);
}
