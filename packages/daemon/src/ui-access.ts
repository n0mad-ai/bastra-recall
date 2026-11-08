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

export const UI_COOKIE = "bastra_ui";
export const UI_CODE_PARAM = "bastra_ui_code";
export const UI_SECRET_HEADER = "x-bastra-ui-secret";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE_TTL_MS = 60_000;
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const codes = new Map<string, number>();

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

const sessionValue = (secret: string) => createHmac("sha256", secret).update("bastra-ui-session-v1").digest("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The Cookie header value an authorised browser carries. */
export function uiSessionCookie(secret: string): string {
  return `${UI_COOKIE}=${sessionValue(secret)}`;
}

export function hasUiSession(req: IncomingMessage): boolean {
  const secret = readUiSecret();
  if (!secret) return false;
  const value = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`${UI_COOKIE}=`))?.slice(UI_COOKIE.length + 1);
  return typeof value === "string" && same(value, sessionValue(secret));
}

/** Routes under /ui that answer without a UI session. */
function openUiPath(path: string): boolean {
  // refresh: the CLI's secret-free nudge to re-read the owner's saved address
  // settings (empty body, no data returned).
  return path === "/ui/health" || path === "/ui/bootstrap" || path === "/ui/assistant-address/refresh";
}

/**
 * Gate for every /ui request after the host gate. Returns true when the request
 * was answered here (bootstrap, code exchange or refusal).
 */
export function gateUiAccess(req: IncomingMessage, res: ServerResponse, method: string, url: string): boolean {
  const parsed = new URL(url, "http://127.0.0.1");
  // Routes match the RAW path by prefix; decide on it as well as on the
  // normalized one, so "/ui/search/../../" cannot slip past the gate.
  const raw = url.split("?", 1)[0], path = parsed.pathname;
  const ui = (p: string) => p === "/ui" || p.startsWith("/ui/");
  if (!ui(raw) && !ui(path)) return false;
  if (method === "POST" && raw === "/ui/bootstrap") { issueCode(req, res); return true; }
  if (openUiPath(raw)) return false;
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
  const secret = readUiSecret(), presented = req.headers[UI_SECRET_HEADER];
  if (!secret || typeof presented !== "string" || !same(presented, secret)) { refuse(res); return; }
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
  const secret = ensureUiSecret();
  if (!secret) return url;
  try {
    const response = await fetch(`${daemonBaseUrl}/ui/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [UI_SECRET_HEADER]: secret },
      body: "{}",
    });
    if (!response.ok) return url;
    const { code } = await response.json() as { code?: unknown };
    return uiUrlWithCode(url, typeof code === "string" ? code : undefined);
  } catch {
    return url;
  }
}
