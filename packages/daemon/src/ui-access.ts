/**
 * #1198 — the tokenless local UI is bound to the OS user that owns the daemon.
 *
 * Loopback proves no user identity: another account on the same machine, or a
 * local proxy that rewrites Host to localhost, reached every /ui route and the
 * Tasks session. Access now needs a per-user secret that only the owner can
 * read (`<data dir>/ui-secret`, 0600, checked for owner and mode like the task
 * hook token). The owner never types it: `bastra ui` (and the assistant
 * address setup) trades the secret for a short-lived one-time code, opens the
 * browser with that code, and the daemon exchanges the code for an HttpOnly
 * cookie. The cookie is an HMAC of the secret, so it survives daemon restarts
 * and is revoked by deleting the secret file.
 *
 * Remaining boundary: processes of the SAME OS user can read the secret.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { bastraDataDir } from "./platform-paths.js";
import { sendJson } from "./http-util.js";
import { tasksEnabled } from "./tasks-enabled.js";

export const UI_COOKIE = "bastra_ui";
export const UI_CODE_PARAM = "bastra_ui_code";
/** Local tools prove the secret with a single-use HMAC; the secret never travels. */
export const UI_PROOF_HEADER = "x-bastra-ui-proof";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE_TTL_MS = 60_000;
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const codes = new Map<string, number>();
const usedProofs = new Map<string, number>();
const PROOF_WINDOW_MS = 30_000;

export function uiSecretPath(): string {
  return join(bastraDataDir(), "ui-secret");
}

/** The secret, only from a regular file owned by this user and closed to others. */
export function readUiSecret(path = uiSecretPath()): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 256) return undefined;
    if (process.platform !== "win32" && (info.mode & 0o077 || info.uid !== process.getuid?.())) return undefined;
    const value = readFileSync(fd, "utf8").trim();
    return TOKEN.test(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Creates the secret on first use (exclusive create, 0600) and returns it. */
export function ensureUiSecret(path = uiSecretPath()): string | undefined {
  const existing = readUiSecret(path);
  if (existing) return existing;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    // Lost a create race or the file exists with the wrong mode: never overwrite.
  }
  return readUiSecret(path);
}

// Each sign-in gets its own random session id, bound to the secret by an HMAC:
// the cookie is never derivable from the secret alone, needs no daemon state
// (survives restarts) and every session dies with the secret file.
const mac = (secret: string, sid: string) => createHmac("sha256", secret).update(`bastra-ui-session-v2:${sid}`).digest("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The Cookie header value of one signed-in browser session. */
export function uiSessionCookie(secret: string, sid = randomBytes(32).toString("base64url")): string {
  return `${UI_COOKIE}=${sid}.${mac(secret, sid)}`;
}

export function hasUiSession(req: IncomingMessage): boolean {
  const secret = readUiSecret();
  if (!secret) return false;
  const value = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`${UI_COOKIE}=`))?.slice(UI_COOKIE.length + 1);
  const [sid, proof, extra] = value?.split(".") ?? [];
  return extra === undefined && typeof sid === "string" && TOKEN.test(sid) && typeof proof === "string" && same(proof, mac(secret, sid));
}

// Bound to the target host:port and path, single-use (nonce set), 30 s window.
const proofMac = (secret: string, host: string, path: string, nonce: string, ts: string) =>
  createHmac("sha256", secret).update(`bastra-ui-proof-v1:${host.toLowerCase()}:${path}:${nonce}:${ts}`).digest("base64url");

/** Header for a same-user local tool calling `path` on `host` (host:port): nonce, time and HMAC, never the secret. */
export function uiProofHeaders(path: string, host: string, secret = readUiSecret()): Record<string, string> {
  if (!secret) return {};
  const nonce = randomBytes(32).toString("base64url"), ts = String(Date.now());
  return { [UI_PROOF_HEADER]: `${nonce}.${ts}.${proofMac(secret, host, path, nonce, ts)}` };
}

/** A same-user local tool (no browser): fresh, unused proof bound to this path. */
function presentsProof(req: IncomingMessage, path: string): boolean {
  const secret = readUiSecret(), presented = req.headers[UI_PROOF_HEADER];
  if (!secret || typeof presented !== "string") return false;
  const [nonce, ts, proof, extra] = presented.split(".");
  const now = Date.now(), at = Number(ts);
  if (extra !== undefined || !nonce || !TOKEN.test(nonce) || !proof || !/^\d{1,16}$/.test(ts ?? "") || Math.abs(now - at) > PROOF_WINDOW_MS) return false;
  if (!same(proof, proofMac(secret, req.headers.host ?? "", path, nonce, ts!))) return false;
  for (const [n, expires] of usedProofs) if (expires <= now) usedProofs.delete(n);
  if (usedProofs.has(nonce) || usedProofs.size >= 1000) return false;
  usedProofs.set(nonce, now + 2 * PROOF_WINDOW_MS);
  return true;
}

/** Routes under /ui that answer without a UI session. */
function openUiPath(path: string): boolean {
  return path === "/ui/health" || path === "/ui/bootstrap";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The one rule for every same-user call carrying a UI proof: an http loopback
 *  daemon URL only, never an overridden remote BASTRA_DAEMON_URL. */
export function loopbackDaemonBase(daemonBaseUrl: string): URL | undefined {
  try {
    const base = new URL(daemonBaseUrl);
    return base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname) ? base : undefined;
  } catch { return undefined; }
}

/**
 * Gate for every /ui request after the host gate. Returns true when the request
 * was answered here (bootstrap, code exchange or refusal).
 */
export function gateUiAccess(req: IncomingMessage, res: ServerResponse, method: string, url: string): boolean {
  const raw = url.split("?", 1)[0];
  const ui = (p: string) => p === "/ui" || p.startsWith("/ui/");
  // Only origin-form targets ("/...", not "//host/..." or absolute) may reach /ui;
  // an unparsable target is refused instead of throwing in the request handler.
  let parsed: URL | undefined;
  try { parsed = new URL(url, "http://127.0.0.1"); } catch { /* refused below when /ui-shaped */ }
  if (!parsed || !raw.startsWith("/") || raw.startsWith("//")) {
    if (!url.includes("/ui")) return false;
    refuse(res); return true;
  }
  // Routes match the RAW path by prefix; decide on it as well as on the
  // normalized one, so "/ui/search/../../" cannot slip past the gate.
  const path = parsed.pathname;
  if (!ui(raw) && !ui(path)) return false;
  if (method === "POST" && raw === "/ui/bootstrap") { issueCode(req, res); return true; }
  if (openUiPath(raw)) return false;
  // A disabled Tasks preview keeps its routes hidden (404 from dispatchTaskUi).
  if (raw.startsWith("/ui/tasks/") && !tasksEnabled()) return false;
  // The CLI's address refresh nudge returns the address status: owner only.
  if (raw === "/ui/assistant-address/refresh" && presentsProof(req, raw)) return false;
  const code = parsed.searchParams.get(UI_CODE_PARAM);
  if (code !== null && (method === "GET" || method === "HEAD")) {
    const secret = readUiSecret(), expires = codes.get(code);
    codes.delete(code);
    if (!secret || expires === undefined || expires <= Date.now()) { refuse(res); return true; }
    parsed.searchParams.delete(UI_CODE_PARAM);
    res.writeHead(303, {
      "Set-Cookie": `${uiSessionCookie(secret)}; HttpOnly; SameSite=Strict; Path=/ui; Max-Age=${COOKIE_MAX_AGE_S}`,
      Location: path + parsed.search,
      "Cache-Control": "no-store",
    });
    res.end();
    return true;
  }
  if (hasUiSession(req)) return false;
  refuse(res);
  return true;
}

function refuse(res: ServerResponse): void {
  sendJson(res, 401, { error: "UI access needs this user's local session — open the map with: bastra ui", code: "ui_session_required" });
}

function issueCode(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  if (!presentsProof(req, "/ui/bootstrap")) { refuse(res); return; }
  const code = mintUiCode();
  if (!code) { sendJson(res, 429, { error: "too many pending UI codes" }); return; }
  sendJson(res, 200, { code, expires_in: CODE_TTL_MS / 1000 });
}

/** In-process (daemon) issuer: a single-use code, valid for one minute. */
export function mintUiCode(): string | undefined {
  if (!ensureUiSecret()) return undefined;
  const now = Date.now();
  for (const [c, expires] of codes) if (expires <= now) codes.delete(c);
  if (codes.size >= 100) return undefined;
  const code = randomBytes(32).toString("base64url");
  codes.set(code, now + CODE_TTL_MS);
  return code;
}

/** Adds a one-time code to a /ui URL; unchanged when no code is available. */
export function uiUrlWithCode(url: string, code: string | undefined): string {
  if (!code) return url;
  const target = new URL(url);
  // The assistant gateway's bare "/" redirect drops the query; aim at /ui/.
  if (target.pathname === "/") target.pathname = "/ui/";
  target.searchParams.set(UI_CODE_PARAM, code);
  return target.toString();
}

/** Same-user caller (CLI, daemon): turn `url` into a one-time browser login link. */
export async function withUiCode(url: string, daemonBaseUrl: string): Promise<string> {
  // The secret goes to a loopback http daemon only, never to an overridden
  // remote BASTRA_DAEMON_URL; there the map opens without a code.
  const base = loopbackDaemonBase(daemonBaseUrl);
  if (!base) return url;
  const secret = ensureUiSecret();
  if (!secret) return url;
  try {
    const response = await fetch(new URL("/ui/bootstrap", base), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...uiProofHeaders("/ui/bootstrap", base.host, secret) },
      body: "{}",
    });
    if (!response.ok) return url;
    const { code } = await response.json() as { code?: unknown };
    return uiUrlWithCode(url, typeof code === "string" ? code : undefined);
  } catch {
    return url;
  }
}
