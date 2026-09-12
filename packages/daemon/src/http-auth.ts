/**
 * Auth + CORS policy for the daemon's HTTP surface: loopback detection, the
 * DNS-rebinding host gate, the CORS allowlist/origin resolution, and the
 * /api/v1 auth gate. Pure decision functions — the routing in http.ts applies
 * them. Split out of http.ts (file-size convention).
 */
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

// Loopback-Aufrufe sehen wir an `127.0.0.1`/`::1`/`::ffff:127.0.0.1`. Wenn
// BASTRA_AUTH_LOOPBACK_SKIP nicht explizit auf "0" steht, dürfen sie
// /api/v1/* ohne Token aufrufen — der MCP-Forwarder läuft loopback und soll
// nicht jedes Mal authentifizieren müssen.
export function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

/**
 * Constant-time string equality for the Bearer-token check. The early return
 * on length mismatch leaks only the length — not secret here, the token has
 * a fixed format (`Bearer ` + 43-char base64url). Exported for unit tests.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * DNS-Rebinding-Gate für die token-losen Loopback-Endpoints (/hook/recall,
 * /vault/count, /health): ein Browser, der eine Angreifer-Domain auf
 * 127.0.0.1 umbiegt, schickt deren Hostname im Host-Header — aus Browser-
 * Sicht ist der Request dann same-origin, CORS greift nicht. Nur loopback-
 * Hosts werden bedient; BASTRA_ALLOWED_HOSTS (Komma-Liste) ist der Escape-
 * Hatch für Tunnel-Setups, die mehr als /api/v1/* exposen wollen. Fehlender
 * Host-Header (HTTP/1.0-CLIs) passiert — Rebinding trägt immer einen.
 * Exported for unit tests.
 */
export function isLoopbackHost(
  hostHeader: string | undefined,
  extraHosts: readonly string[],
): boolean {
  if (!hostHeader) return true;
  const lower = hostHeader.toLowerCase();
  const host = lower.replace(/:\d+$/, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return true;
  }
  return extraHosts.includes(host) || extraHosts.includes(lower);
}

/**
 * CORS allowlist from BASTRA_CORS_ORIGIN (#95). Unset/empty = EMPTY allowlist —
 * no browser origin is allowed until the user opts in. "*" must be set
 * explicitly (tunnel/dev); it is no longer the default, because together with
 * a minted token it would let ANY website that obtains the token through.
 * Local tools (CLI, forwarder — no Origin header) are unaffected either way.
 * Exported for unit tests.
 */
export function corsAllowlistFromEnv(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The effective CORS allowlist from its two sources, env as the ops override —
 * mirroring how BASTRA_API_TOKEN backstops the minted token: a non-empty
 * BASTRA_CORS_ORIGIN wins outright; otherwise the origins that `bastra token
 * --origin` wrote into cli-settings.json apply. Exported for unit tests.
 */
export function resolveCorsAllowlist(fromEnv: readonly string[], fromSettings: readonly string[]): string[] {
  return fromEnv.length > 0 ? [...fromEnv] : [...fromSettings];
}

/**
 * Which Origin to reflect in `Access-Control-Allow-Origin`. `null` = the origin
 * isn't allowed → emit no ACAO header and the browser blocks the response. "*"
 * in the allowlist is permissive (tunnel/dev): reflect the caller's origin, or
 * "*" when there's none. Exported for unit tests.
 */
export function resolveCorsOrigin(
  reqOrigin: string | undefined,
  allow: readonly string[],
): string | null {
  if (allow.includes("*")) return reqOrigin ?? "*";
  if (reqOrigin && allow.includes(reqOrigin)) return reqOrigin;
  return null;
}

/**
 * Auth decision for /api/v1/*. A request WITH an Origin header is a browser
 * request (possibly a foreign site): it must be on the allowlist AND carry the
 * token — even over loopback, because the user's browser runs on 127.0.0.1 and
 * is indistinguishable from the CLI by TCP source; only the Origin header tells
 * them apart. Local tools (CLI, MCP-forwarder) send no Origin and may stay
 * tokenless via loopback-skip.
 *
 * #526: the tokenless skip needs BOTH a loopback peer AND a loopback Host. A
 * same-origin GET carries no Origin header, so a DNS-rebound page on
 * `attacker.example` — or a tunnel/reverse proxy fronting a public hostname —
 * would otherwise inherit the exemption from the loopback socket underneath.
 * A foreign Host stays usable for tunnels, but must carry the bearer token.
 * Returns the HTTP status to apply. Exported for unit tests.
 */
export function gateApiRequest(p: {
  reqOrigin: string | undefined;
  allowedOrigin: string | null;
  isLoopback: boolean;
  isLoopbackHost: boolean;
  authHeader: string;
  apiToken: string;
  loopbackSkip: boolean;
}): 200 | 401 | 403 {
  const isBrowser = typeof p.reqOrigin === "string" && p.reqOrigin.length > 0;
  if (isBrowser) {
    if (!p.allowedOrigin) return 403;
    if (!p.apiToken || !safeEqual(p.authHeader, `Bearer ${p.apiToken}`)) return 401;
    return 200;
  }
  const directLocal = p.isLoopback && p.isLoopbackHost;
  if (p.apiToken && !(p.loopbackSkip && directLocal)) {
    if (!safeEqual(p.authHeader, `Bearer ${p.apiToken}`)) return 401;
  }
  return 200;
}
