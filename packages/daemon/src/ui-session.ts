/**
 * #1198 S2 — web UI sessions, their cookies and the CSRF value.
 *
 * - The session token is 32 random bytes (base64url, 43 characters). Only its
 *   SHA-256 is stored (ui_sessions.token_hash); `id` is a neutral handle for
 *   revoking a device and never authenticates anything.
 * - Kind "browser": 24 h absolute, 2 h idle. Kind "device" ("stay signed in on
 *   this device"): 30 days absolute, no idle limit (Daniel, 26.11.2026).
 * - A session counts only while its credential_version equals the account's
 *   current one (UiAccountStore); a password change or reset ends all sessions
 *   at once. Missing or damaged account storage ends them too.
 * - A session is bound to the origin it was created for ("local" over http on
 *   the Mac, "public" through the tunnel); check() refuses the other origin, so
 *   revoking all public sessions really closes the tunnel.
 * - Activity: last_seen_at is written at most once a minute; background polls
 *   (/ui/updates, /ui/health, /ui/import-count) never extend a session.
 * - CSRF value: HMAC-SHA256 keyed with the raw session token over a fixed
 *   context string. Nothing else is stored.
 *
 * Malformed, oversized or multi-byte input yields "invalid", never an
 * exception. The clock is injected; the module has no timers.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AppDatabase } from "./app-database.js";
import { UiAccountStore } from "./ui-account-store.js";

export type UiSessionKind = "browser" | "device";
export type UiSessionOrigin = "local" | "public";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const BROWSER_ABSOLUTE_MS = 24 * HOUR_MS;
const BROWSER_IDLE_MS = 2 * HOUR_MS;
const DEVICE_ABSOLUTE_MS = 30 * 24 * HOUR_MS;
const TOUCH_INTERVAL_MS = MINUTE_MS;

const TOKEN_BYTES = 32;
/** base64url of 32 bytes without padding: ASCII only, so characters = bytes. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CSRF_CONTEXT = "bastra-recall ui csrf v1";
const LABEL_MAX_CHARS = 100;
const USER_AGENT_MAX_CHARS = 300;
/** Real Cookie headers stay far below this; anything longer is refused unparsed. */
const COOKIE_HEADER_MAX_BYTES = 16 * 1024;

const COOKIE = {
  local: { name: "bastra_ui", attributes: "HttpOnly; SameSite=Strict; Path=/ui" },
  public: { name: "__Host-bastra_ui", attributes: "Secure; HttpOnly; SameSite=Strict; Path=/" },
} as const;

export interface UiSessionCreated {
  /** Raw token for the cookie. Never stored, never logged. */
  token: string;
  id: string;
  kind: UiSessionKind;
  origin: UiSessionOrigin;
  expiresAt: number;
}

export type UiSessionCheck =
  { ok: true; id: string; kind: UiSessionKind; origin: UiSessionOrigin; expiresAt: number } | { ok: false };

/** One row of the device list; carries no token hash. */
export interface UiSessionInfo {
  id: string;
  kind: UiSessionKind;
  origin: UiSessionOrigin;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  label: string;
  userAgent: string;
}

interface SessionRow {
  id: string;
  kind: UiSessionKind;
  origin: UiSessionOrigin;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  credential_version: number;
  label: string;
  user_agent: string;
}

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const isToken = (value: unknown): value is string => typeof value === "string" && TOKEN_RE.test(value);

/** No control characters, lone surrogates or bidi controls; trimmed; cut to `max` code points. */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Bound the work before scanning: max code points need at most 2*max UTF-16
  // units (leading white space may shorten the result; that is fine). A pair
  // cut in half becomes a lone surrogate and is removed below. Bidi controls
  // go too: they could make a device name in the list read as another one.
  const cleaned = value.slice(0, max * 2).replace(/[\p{Cc}\p{Cs}\p{Bidi_Control}]/gu, "");
  return [...cleaned.trim()].slice(0, max).join("").trim();
}

export class UiSessionStore {
  private readonly account: UiAccountStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now
  ) {
    this.account = new UiAccountStore(db);
  }

  /**
   * New session after a successful sign-in. `credentialVersion` is the one
   * UiAccountStore.verifyLogin returned, so a password change racing the
   * sign-in leaves the new session invalid.
   */
  create(input: {
    kind: UiSessionKind;
    origin: UiSessionOrigin;
    credentialVersion: number;
    label?: unknown;
    userAgent?: unknown;
  }): UiSessionCreated {
    const now = this.now();
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const id = randomUUID();
    const expiresAt = now + (input.kind === "device" ? DEVICE_ABSOLUTE_MS : BROWSER_ABSOLUTE_MS);
    this.db.sqlite
      .prepare(
        `INSERT INTO ui_sessions(id,token_hash,kind,origin,created_at,expires_at,last_seen_at,credential_version,label,user_agent)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        hashToken(token),
        input.kind,
        input.origin,
        now,
        expiresAt,
        now,
        input.credentialVersion,
        cleanText(input.label, LABEL_MAX_CHARS),
        cleanText(input.userAgent, USER_AGENT_MAX_CHARS)
      );
    return { token, id, kind: input.kind, origin: input.origin, expiresAt };
  }

  /**
   * Per request. Valid only for a known, unexpired session of this origin and
   * the account's current credential_version. Records activity (at most one
   * write a minute) unless `background` is set; background polls never extend
   * the idle window.
   */
  check(token: unknown, origin: UiSessionOrigin, options: { background: boolean }): UiSessionCheck {
    if (!isToken(token)) return { ok: false };
    try {
      const row = this.db.sqlite
        .prepare(
          "SELECT id,kind,origin,created_at,expires_at,last_seen_at,credential_version,label,user_agent FROM ui_sessions WHERE token_hash=?"
        )
        .get(hashToken(token)) as SessionRow | undefined;
      const now = this.now();
      if (!row || row.origin !== origin || !this.isActive(row, now, this.currentCredentialVersion()))
        return { ok: false };
      if (!options.background && now - row.last_seen_at >= TOUCH_INTERVAL_MS)
        this.db.sqlite.prepare("UPDATE ui_sessions SET last_seen_at=? WHERE id=?").run(now, row.id);
      return { ok: true, id: row.id, kind: row.kind, origin: row.origin, expiresAt: row.expires_at };
    } catch {
      // Unreadable storage signs out rather than letting a request through.
      return { ok: false };
    }
  }

  /** Active sessions for the device list, most recently used first. */
  list(): UiSessionInfo[] {
    const now = this.now();
    const version = this.currentCredentialVersion();
    const rows = this.db.sqlite
      .prepare(
        "SELECT id,kind,origin,created_at,expires_at,last_seen_at,credential_version,label,user_agent FROM ui_sessions ORDER BY last_seen_at DESC, created_at DESC"
      )
      .all() as unknown as SessionRow[];
    return rows
      .filter((row) => this.isActive(row, now, version))
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        origin: row.origin,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
        label: row.label,
        userAgent: row.user_agent,
      }));
  }

  /** One session by its handle; true when it existed. */
  revoke(id: unknown): boolean {
    if (typeof id !== "string" || id.length > 64) return false;
    return Number(this.db.sqlite.prepare("DELETE FROM ui_sessions WHERE id=?").run(id).changes) > 0;
  }

  /** All sessions ("sign out everywhere"); returns how many were removed. */
  revokeAll(): number {
    return Number(this.db.sqlite.prepare("DELETE FROM ui_sessions").run().changes);
  }

  /** All sessions of one origin, e.g. every public session when remote access is switched off. */
  revokeOrigin(origin: UiSessionOrigin): number {
    return Number(this.db.sqlite.prepare("DELETE FROM ui_sessions WHERE origin=?").run(origin).changes);
  }

  /** Removes expired, idle and superseded sessions; returns how many. */
  pruneExpired(): number {
    const now = this.now();
    const version = this.currentCredentialVersion();
    const stale = (
      this.db.sqlite
        .prepare("SELECT id,kind,expires_at,last_seen_at,credential_version FROM ui_sessions")
        .all() as unknown as SessionRow[]
    ).filter((row) => !this.isActive(row, now, version));
    if (stale.length === 0) return 0;
    const remove = this.db.sqlite.prepare("DELETE FROM ui_sessions WHERE id=?");
    return this.db.transaction(() => stale.reduce((n, row) => n + Number(remove.run(row.id).changes), 0));
  }

  private currentCredentialVersion(): number | null {
    const status = this.account.status();
    return status.state === "present" ? status.credentialVersion : null;
  }

  private isActive(row: SessionRow, now: number, credentialVersion: number | null): boolean {
    if (credentialVersion === null || row.credential_version !== credentialVersion) return false;
    if (now >= row.expires_at) return false;
    return row.kind === "device" || now - row.last_seen_at < BROWSER_IDLE_MS;
  }
}

/** Set-Cookie value for a new session. Max-Age only for device sessions; browser sessions end with the browser. */
export function uiSessionCookie(origin: UiSessionOrigin, session: { token: string; kind: UiSessionKind }): string {
  const { name, attributes } = COOKIE[origin];
  const maxAge = session.kind === "device" ? `; Max-Age=${DEVICE_ABSOLUTE_MS / 1000}` : "";
  return `${name}=${session.token}; ${attributes}${maxAge}`;
}

/** Set-Cookie value that removes the session cookie of this origin. */
export function uiSessionClearCookie(origin: UiSessionOrigin): string {
  const { name, attributes } = COOKIE[origin];
  return `${name}=; ${attributes}; Max-Age=0`;
}

/**
 * Session token from a Cookie request header. Only the cookie name of this
 * origin counts; the first occurrence wins; anything not shaped like a token
 * yields null.
 */
export function readUiSessionCookie(header: unknown, origin: UiSessionOrigin): string | null {
  if (typeof header !== "string" || Buffer.byteLength(header, "utf8") > COOKIE_HEADER_MAX_BYTES) return null;
  const { name } = COOKIE[origin];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return isToken(value) ? value : null;
  }
  return null;
}

/** CSRF value for the X-Bastra-CSRF header, derived from the raw session token. */
export function uiCsrfToken(sessionToken: string): string {
  return createHmac("sha256", Buffer.from(sessionToken, "base64url")).update(CSRF_CONTEXT).digest("base64url");
}

/** Constant-time check of a presented CSRF value against the session it claims to belong to. */
export function verifyUiCsrf(sessionToken: unknown, presented: unknown): boolean {
  // Both are 43 ASCII characters when well-formed; checking the shape first
  // keeps timingSafeEqual on equal byte lengths and away from multi-byte text.
  if (!isToken(sessionToken) || !isToken(presented)) return false;
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(uiCsrfToken(sessionToken), "utf8"));
}
