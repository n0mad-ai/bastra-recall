/**
 * #1198 — limits against password guessing at the web UI sign-in (Daniel,
 * 26.11.2026: strict locks are mandatory once the UI is reachable through the
 * tunnel).
 *
 * Use per sign-in request (the caller classifies the request as "public" or
 * "local"):
 *
 *   const decision = throttle.check({ access, cfConnectingIp: req.headers["cf-connecting-ip"] });
 *   if (decision.kind !== "allowed") → refuse (locked: until …; busy: 429 + Retry-After)
 *   const run = await throttle.verify(decision, () => accounts.verifyLogin(name, password));
 *   if (run.kind === "busy") → 429 + Retry-After
 *   throttle.report(decision, run.value.ok);
 *
 * Rules:
 * - Source: for "public" the CF-Connecting-IP header (IPv4 as is, IPv6 cut to
 *   its /64); missing or invalid → one shared group "unknown-public". For
 *   "local" the source is "local" and the header is ignored.
 * - Per public source: 5 failures in a 15-minute window → 15 min lock; each
 *   further lock doubles, at most 24 h.
 * - The account, over all public sources: 20 failures in a 24-hour window →
 *   public sign-in closed for 1 h; each further lock doubles, at most 24 h.
 *   Every public failure counts, also for an unknown user name (there is only
 *   one account; changing names must not get around the limit).
 * - Public load: at most 30 attempts per minute; one password check at a time
 *   with at most 4 waiting, beyond that "busy" with a wait in seconds.
 * - Local: soft limit of 5 attempts per minute; no lock of any kind, and no
 *   public lock (source or account) ever blocks it. Local attempts bypass the
 *   one-at-a-time queue so a public flood cannot hold them up.
 * - A successful sign-in deletes its source's row (counter and lock level).
 * - Lock levels decay: when a bucket locks again more than 24 h after its last
 *   lock ended, the duration starts over at the base value. Rows untouched for
 *   24 h after their last failure or lock end are pruned.
 *
 * Counters live in table ui_login_failures (app database, migration v4), one
 * row per bucket: "source:<address or /64>", "source:unknown-public",
 * "account", and the per-minute attempt counters "rate:public" and
 * "rate:local" (there the `failures` column counts attempts). No password and
 * no typed user name is ever stored. Existing sessions are not affected; only
 * sign-in attempts are counted.
 *
 * The clock is injectable; the module starts no timers.
 */
import { isIPv4, isIPv6 } from "node:net";
import type { AppDatabase } from "./app-database.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MAX_LOCK_MS = DAY_MS;
const LEVEL_DECAY_MS = DAY_MS;
const SOURCE_RULE = { windowMs: 15 * MINUTE_MS, limit: 5, lockMs: 15 * MINUTE_MS };
const ACCOUNT_RULE = { windowMs: DAY_MS, limit: 20, lockMs: HOUR_MS };
const PUBLIC_ATTEMPTS_PER_MINUTE = 30;
const LOCAL_ATTEMPTS_PER_MINUTE = 5;
const QUEUE_WAITING = 4;
const QUEUE_RETRY_AFTER_SECONDS = 1;
// CF-Connecting-IP is one address; anything longer is not one.
const MAX_HEADER_CHARS = 64;

const ACCOUNT_BUCKET = "account";
const SOURCE_PREFIX = "source:";
const RATE_PREFIX = "rate:";
const UNKNOWN_PUBLIC = "unknown-public";

export type UiLoginAccess = "public" | "local";

/** An attempt check() let through; pass it to verify() and report(). */
export interface UiLoginAttempt {
  readonly access: UiLoginAccess;
  /** "local", "unknown-public", an IPv4 address or an IPv6 /64 ("2001:db8:1:2::/64"). */
  readonly source: string;
}

export type UiLoginDecision =
  | ({ kind: "allowed" } & UiLoginAttempt)
  | { kind: "locked"; lockedUntil: number; retryAfterSeconds: number }
  | { kind: "busy"; retryAfterSeconds: number };

export type UiLoginRun<T> = { kind: "done"; value: T } | { kind: "busy"; retryAfterSeconds: number };

/** One counter row for status displays (CLI `account status`, device management). */
export interface UiLoginThrottleEntry {
  /** "account" or "source:<…>"; pass to unlock() to clear just this one. */
  bucket: string;
  /** Failures in the current window (0 once the window has run out). */
  failures: number;
  windowStartedAt: number;
  lastFailureAt: number;
  /** End of the active lock; 0 when not locked. */
  lockedUntil: number;
  lockoutLevel: number;
}

interface Row {
  failures: number;
  windowStartedAt: number;
  lockedUntil: number;
  lockoutLevel: number;
  updatedAt: number;
}

const retryAfterSeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * The source an attempt counts against. `cfConnectingIp` is the raw header
 * value (external data: anything may arrive); it only matters for "public".
 */
export function uiLoginSource(access: UiLoginAccess, cfConnectingIp: unknown): string {
  if (access === "local") return "local";
  if (typeof cfConnectingIp !== "string" || cfConnectingIp.length > MAX_HEADER_CHARS) return UNKNOWN_PUBLIC;
  const text = cfConnectingIp.trim();
  if (isIPv4(text)) return text;
  return (isIPv6(text) && ipv6Source(text)) || UNKNOWN_PUBLIC;
}

/** IPv6 → its /64 in lower-case hex; IPv4-mapped addresses → the IPv4 address. */
function ipv6Source(text: string): string | null {
  let host: string;
  try {
    // WHATWG URL parsing rejects zone ids and rewrites an embedded IPv4 tail as hex.
    host = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head, tail] = host.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right].map((g) =>
    parseInt(g, 16)
  );
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff)
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

export class UiLoginThrottle {
  private checking = false;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now
  ) {}

  /** May this attempt run? Counts it toward the per-minute limit when allowed. */
  check(request: { access: UiLoginAccess; cfConnectingIp?: unknown }): UiLoginDecision {
    const source = uiLoginSource(request.access, request.cfConnectingIp);
    const now = this.now();
    return this.db.transaction((): UiLoginDecision => {
      if (request.access === "public") {
        const lockedUntil = Math.max(
          this.activeLock(SOURCE_PREFIX + source, now),
          this.activeLock(ACCOUNT_BUCKET, now)
        );
        if (lockedUntil > now)
          return { kind: "locked", lockedUntil, retryAfterSeconds: retryAfterSeconds(lockedUntil - now) };
        if (this.queueFull()) return { kind: "busy", retryAfterSeconds: QUEUE_RETRY_AFTER_SECONDS };
      }
      const [bucket, limit] =
        request.access === "public"
          ? [`${RATE_PREFIX}public`, PUBLIC_ATTEMPTS_PER_MINUTE]
          : [`${RATE_PREFIX}local`, LOCAL_ATTEMPTS_PER_MINUTE];
      const waitMs = this.takeRateSlot(bucket, limit, now);
      if (waitMs > 0) return { kind: "busy", retryAfterSeconds: retryAfterSeconds(waitMs) };
      return { kind: "allowed", access: request.access, source };
    });
  }

  /**
   * Runs the password check. Public checks go one at a time through a queue of
   * at most 4 waiting; a full queue answers "busy" without running `check`.
   */
  async verify<T>(attempt: UiLoginAttempt, check: () => Promise<T>): Promise<UiLoginRun<T>> {
    if (attempt.access === "local") return { kind: "done", value: await check() };
    if (this.queueFull()) return { kind: "busy", retryAfterSeconds: QUEUE_RETRY_AFTER_SECONDS };
    if (this.checking) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.checking = true;
    try {
      return { kind: "done", value: await check() };
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = this.waiting.shift();
      if (next) next();
      else this.checking = false;
    }
  }

  /** Outcome of an attempt check() allowed. Local outcomes change no counter. */
  report(attempt: UiLoginAttempt, success: boolean): void {
    if (attempt.access === "local") return;
    const now = this.now();
    this.db.transaction(() => {
      if (success) {
        this.db.sqlite.prepare("DELETE FROM ui_login_failures WHERE bucket=?").run(SOURCE_PREFIX + attempt.source);
        return;
      }
      this.db.sqlite
        .prepare("DELETE FROM ui_login_failures WHERE max(updated_at,locked_until)+?<=?")
        .run(LEVEL_DECAY_MS, now);
      this.recordFailure(SOURCE_PREFIX + attempt.source, SOURCE_RULE, now);
      this.recordFailure(ACCOUNT_BUCKET, ACCOUNT_RULE, now);
    });
  }

  /** Account and source counters, most recent failure first (per-minute counters left out). */
  status(): UiLoginThrottleEntry[] {
    const now = this.now();
    return this.db.sqlite
      .prepare(
        `SELECT bucket,failures,window_started_at,locked_until,lockout_level,updated_at FROM ui_login_failures
         WHERE bucket NOT LIKE '${RATE_PREFIX}%' ORDER BY updated_at DESC, bucket`
      )
      .all()
      .map((r) => {
        const bucket = String(r.bucket);
        const row = toRow(r);
        const rule = bucket === ACCOUNT_BUCKET ? ACCOUNT_RULE : SOURCE_RULE;
        return {
          bucket,
          failures: now - row.windowStartedAt < rule.windowMs ? row.failures : 0,
          windowStartedAt: row.windowStartedAt,
          lastFailureAt: row.updatedAt,
          lockedUntil: row.lockedUntil > now ? row.lockedUntil : 0,
          lockoutLevel: row.lockoutLevel,
        };
      });
  }

  /** Clears one bucket from status(), or every counter and lock; returns the rows removed. */
  unlock(bucket?: string): number {
    const statement =
      bucket === undefined
        ? this.db.sqlite.prepare("DELETE FROM ui_login_failures")
        : this.db.sqlite.prepare("DELETE FROM ui_login_failures WHERE bucket=?");
    return Number((bucket === undefined ? statement.run() : statement.run(bucket)).changes);
  }

  private queueFull(): boolean {
    return this.checking && this.waiting.length >= QUEUE_WAITING;
  }

  private read(bucket: string): Row | undefined {
    const r = this.db.sqlite
      .prepare(
        "SELECT failures,window_started_at,locked_until,lockout_level,updated_at FROM ui_login_failures WHERE bucket=?"
      )
      .get(bucket);
    return r ? toRow(r) : undefined;
  }

  private write(bucket: string, row: Row): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO ui_login_failures(bucket,failures,window_started_at,locked_until,lockout_level,updated_at)
         VALUES(?,?,?,?,?,?) ON CONFLICT(bucket) DO UPDATE SET failures=excluded.failures,
         window_started_at=excluded.window_started_at, locked_until=excluded.locked_until,
         lockout_level=excluded.lockout_level, updated_at=excluded.updated_at`
      )
      .run(bucket, row.failures, row.windowStartedAt, row.lockedUntil, row.lockoutLevel, row.updatedAt);
  }

  private activeLock(bucket: string, now: number): number {
    const lockedUntil = this.read(bucket)?.lockedUntil ?? 0;
    return lockedUntil > now ? lockedUntil : 0;
  }

  /** 0 when the attempt fits into the current minute (and is counted), else ms until the next window. */
  private takeRateSlot(bucket: string, limit: number, now: number): number {
    const row = this.read(bucket);
    const fresh = !row || now - row.windowStartedAt >= MINUTE_MS || now < row.windowStartedAt;
    if (!fresh && row.failures >= limit) return row.windowStartedAt + MINUTE_MS - now;
    this.write(bucket, {
      failures: fresh ? 1 : row.failures + 1,
      windowStartedAt: fresh ? now : row.windowStartedAt,
      lockedUntil: 0,
      lockoutLevel: 0,
      updatedAt: now,
    });
    return 0;
  }

  private recordFailure(bucket: string, rule: typeof SOURCE_RULE, now: number): void {
    const row = this.read(bucket);
    const fresh = !row || now - row.windowStartedAt >= rule.windowMs || now < row.windowStartedAt;
    let failures = fresh ? 1 : row.failures + 1;
    let windowStartedAt = fresh ? now : row.windowStartedAt;
    let lockedUntil = row?.lockedUntil ?? 0;
    let lockoutLevel = row && lockedUntil + LEVEL_DECAY_MS > now ? row.lockoutLevel : 0;
    if (failures >= rule.limit) {
      lockoutLevel += 1;
      lockedUntil = now + Math.min(rule.lockMs * 2 ** (lockoutLevel - 1), MAX_LOCK_MS);
      failures = 0;
      windowStartedAt = now;
    }
    this.write(bucket, { failures, windowStartedAt, lockedUntil, lockoutLevel, updatedAt: now });
  }
}

function toRow(r: Record<string, unknown>): Row {
  return {
    failures: Number(r.failures),
    windowStartedAt: Number(r.window_started_at),
    lockedUntil: Number(r.locked_until),
    lockoutLevel: Number(r.lockout_level),
    updatedAt: Number(r.updated_at),
  };
}
