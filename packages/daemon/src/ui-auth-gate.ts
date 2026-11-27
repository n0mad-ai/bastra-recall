/**
 * #1198 — the sign-in gate in front of every /ui handler.
 *
 * 1. classifyUiRequest decides which door a request came through:
 *    - "public-ui": path under /ui, Host exactly the host of `ui.public_origin`,
 *      loopback peer (the local cloudflared) and `X-Forwarded-Proto: https`.
 *      Only this class skips the loopback-Host gate and the token rule for
 *      forwarded requests in http.ts; BASTRA_ALLOWED_HOSTS plays no part.
 *    - "reject": the public host on a /ui path, but not through the tunnel as
 *      described (plain http, foreign peer). Refused with 403.
 *    - "local-ui": any other /ui request; the existing gates in http.ts stay.
 *    - "other": everything outside /ui; nothing changes for it.
 * 2. gateUiRequest runs after the host, token, account and local-POST gates:
 *    the Android app switch (ui-android-app.ts), route policy
 *    (ui-route-policy.ts), exact Origin for public writes, the session, CSRF,
 *    and the sign-in routes themselves (ui-auth-routes.ts).
 *
 * Without an account the web UI stays usable as before on the Mac (direct
 * local access through the gates above), so an update locks no one out before
 * an account exists; through the tunnel everything is 403 then. Damaged or
 * unreadable account storage is locked everywhere: no session counts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { forwardedWithoutToken, isLoopback, isLoopbackHost } from "./http-auth.js";
import { sendJson } from "./http-util.js";
import { refuseAndroidAppWithoutPulse } from "./ui-android-app.js";
import { normalizePublicUiOrigin } from "./settings-registry.js";
import { getUiPublicOrigin } from "./settings.js";
import { uiAuthStores } from "./ui-auth-stores.js";
import { uiRoutePolicy, type UiRoutePolicy } from "./ui-route-policy.js";
import { readUiSessionCookie, verifyUiCsrf, type UiSessionOrigin } from "./ui-session.js";
import { dispatchUiAuthRoutes, type UiRequestState } from "./ui-auth-routes.js";
import { sendUiAuthRequired } from "./webui.js";

export type UiRequestClass = "public-ui" | "local-ui" | "other" | "reject";

export interface UiRequestAccess {
  kind: UiRequestClass;
  /** The normalized `ui.public_origin`, "" when unset or invalid. */
  publicOrigin: string;
}

const states = new WeakMap<IncomingMessage, UiRequestState>();

/** The gate's result for this request; undefined when the gate did not run (outside /ui, or a direct unit call). */
export function uiRequestState(req: IncomingMessage): UiRequestState | undefined {
  return states.get(req);
}

const HSTS = "max-age=31536000";

const underUi = (pathname: string) => pathname === "/ui" || pathname.startsWith("/ui/");

/** Pure classification; `publicOrigin` is the stored `ui.public_origin` ("" = no tunnel access). */
export function classifyUiRequest(req: IncomingMessage, publicOrigin: string): UiRequestClass {
  const pathname = (req.url ?? "").split("?", 1)[0]!;
  if (!underUi(pathname)) return "other";
  const origin = normalizePublicUiOrigin(publicOrigin);
  if (origin === null || req.headers.host?.toLowerCase() !== new URL(origin).host) return "local-ui";
  return isLoopback(req) && req.headers["x-forwarded-proto"] === "https" ? "public-ui" : "reject";
}

/**
 * Classifies the request, reading `ui.public_origin` only for /ui paths (per
 * request, so `bastra ui remote off` takes effect at once). Public answers carry
 * Strict-Transport-Security from here on, error answers of later gates included.
 */
export async function uiRequestAccess(req: IncomingMessage, res: ServerResponse): Promise<UiRequestAccess> {
  if (!underUi((req.url ?? "").split("?", 1)[0]!)) return { kind: "other", publicOrigin: "" };
  const publicOrigin = normalizePublicUiOrigin(await getUiPublicOrigin()) ?? "";
  const kind = classifyUiRequest(req, publicOrigin);
  if (kind === "public-ui") res.setHeader("Strict-Transport-Security", HSTS);
  return { kind, publicOrigin };
}

/** The central session gate for "public-ui" and "local-ui". true = answered here. */
export async function gateUiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ui: UiRequestAccess,
  method: string,
  pathname: string
): Promise<boolean> {
  if (ui.kind === "other" || ui.kind === "reject") return false;
  // Recall Pulse: the Android app, before anything about the account or the vault.
  if (await refuseAndroidAppWithoutPulse(req, res, method)) return true;
  const isPublic = ui.kind === "public-ui";
  const policy = uiRoutePolicy(pathname);
  const write = method !== "GET" && method !== "HEAD";
  const refused = isPublic ? publicRefusal(req, res, ui, policy, write) : null;
  if (refused) return refuse(res, 403, refused);
  const state = currentState(req, isPublic ? "public" : "local", policy);
  if (isPublic && state.account === "none") return refuse(res, 403, "no-account");
  states.set(req, state);
  if (write && state.session && !policy.noCsrf && !verifyUiCsrf(state.session.token, req.headers["x-bastra-csrf"]))
    return refuse(res, 403, "csrf");
  if (dispatchUiAuthRoutes(req, res, method, pathname, state)) return true;
  return requireSession(req, res, method, policy, state);
}

/** Lets an open route or a valid session through; otherwise 302 to the sign-in page or 401. */
function requireSession(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  policy: UiRoutePolicy,
  state: UiRequestState
): boolean {
  if (policy.access === "open" || state.session) return false;
  // No account yet: the Mac keeps its web UI as before (see the header).
  if (state.access === "local" && state.account === "none") return false;
  sendUiAuthRequired(req, res, method);
  return true;
}

/** The loopback-Host gate of http.ts: "public-ui" skips it, "reject" never passes, the rest as before. */
export function uiHostAllowed(
  req: IncomingMessage,
  ui: UiRequestAccess,
  url: string,
  allowedHosts: readonly string[]
): boolean {
  if (ui.kind === "reject") return false;
  return ui.kind === "public-ui" || url.startsWith("/api/v1/") || isLoopbackHost(req.headers.host, allowedHosts);
}

/** #1264 token rule for forwarded requests; "public-ui" alone is exempt (its session gate follows). */
export function uiForwardedWithoutToken(
  req: IncomingMessage,
  ui: UiRequestAccess,
  pathname: string,
  apiToken: string | undefined
): boolean {
  return ui.kind !== "public-ui" && forwardedWithoutToken(req, pathname, apiToken);
}

/** Through the tunnel: local-only routes are closed, and a write must name exactly the configured origin. */
function publicRefusal(
  req: IncomingMessage,
  res: ServerResponse,
  ui: UiRequestAccess,
  policy: UiRoutePolicy,
  write: boolean
): string | null {
  res.setHeader("Cache-Control", "no-store");
  if (policy.localOnly) return "local-only";
  // gateLocalPost lets a request without Origin through; here "null", a missing
  // or any other origin is refused.
  return write && req.headers.origin !== ui.publicOrigin ? "origin not allowed" : null;
}

/** Account state and the session this request presents for its access ("local" or "public"). */
function currentState(req: IncomingMessage, access: UiSessionOrigin, policy: UiRoutePolicy): UiRequestState {
  const stores = uiAuthStores();
  // status() itself reports unreadable storage as "damaged"; no database at all is locked too.
  const account = stores ? stores.accounts.status().state : "damaged";
  const token = readUiSessionCookie(req.headers.cookie, access);
  if (!stores || account !== "present" || !token) return { access, account, session: null };
  const check = stores.sessions.check(token, access, { background: policy.background === true });
  return { access, account, session: check.ok ? { id: check.id, kind: check.kind, token } : null };
}

function refuse(res: ServerResponse, status: number, error: string): true {
  sendJson(res, status, { error });
  return true;
}
