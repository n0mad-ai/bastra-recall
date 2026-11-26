/**
 * #1198 S3 — sign-in limits (ui-login-throttle.ts) with an injected clock:
 * per-source and per-account locks with doubling up to 24 h, local sign-in
 * unaffected by public locks, CF-Connecting-IP only for public requests (IPv6
 * per /64, invalid → shared group), one-at-a-time queue with 4 waiting,
 * 30/min public and 5/min local, counters survive reopening, unlock.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/ui-login-throttle.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase, type AppDatabase } from "../src/app-database.js";
import { UiLoginThrottle, uiLoginSource, type UiLoginAccess, type UiLoginDecision } from "../src/ui-login-throttle.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const fixture = () => join(mkdtempSync(join(tmpdir(), "bastra-ui-throttle-db-")), "recall.db");

function setup(path = fixture()) {
  const clock = { t: Date.UTC(2026, 10, 26, 12) };
  const db = openAppDatabase({ path });
  const throttle = new UiLoginThrottle(db, () => clock.t);
  /** One attempt; spaced 2.1 s apart so the 30/min limit never interferes. */
  const attempt = (access: UiLoginAccess, ip: string | undefined, success: boolean): UiLoginDecision => {
    clock.t += 2_100;
    const decision = throttle.check({ access, cfConnectingIp: ip });
    if (decision.kind === "allowed") throttle.report(decision, success);
    return decision;
  };
  return { clock, db, throttle, attempt, path };
}

function lockedFor(decision: UiLoginDecision, now: number): number {
  assert.equal(decision.kind, "locked", JSON.stringify(decision));
  return (decision as { lockedUntil: number }).lockedUntil - now;
}

test("source: IPv4 as is, IPv6 per /64, invalid or missing → shared group, local ignores the header", () => {
  const cases: Array<[UiLoginAccess, unknown, string]> = [
    ["public", "203.0.113.5", "203.0.113.5"],
    ["public", " 203.0.113.5 ", "203.0.113.5"],
    ["public", "2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["public", "2001:0DB8:0001:0002::1", "2001:db8:1:2::/64"],
    ["public", "2001:db8::1", "2001:db8:0:0::/64"],
    ["public", "::ffff:198.51.100.7", "198.51.100.7"],
    ["public", "::", "0:0:0:0::/64"],
    ["public", undefined, "unknown-public"],
    ["public", "", "unknown-public"],
    ["public", "not-an-ip", "unknown-public"],
    ["public", "203.0.113.5, 198.51.100.7", "unknown-public"],
    ["public", "256.1.1.1", "unknown-public"],
    ["public", "fe80::1%en0", "unknown-public"],
    ["public", ["203.0.113.5"], "unknown-public"],
    ["public", "1".repeat(200), "unknown-public"],
    ["local", "203.0.113.5", "local"],
    ["local", undefined, "local"],
  ];
  for (const [access, header, expected] of cases)
    assert.equal(uiLoginSource(access, header), expected, `${access} ${JSON.stringify(header)}`);
});

test("addresses in the same IPv6 /64 share one counter; a different /64 does not", () => {
  const { attempt } = setup();
  for (let i = 1; i <= 5; i++) attempt("public", `2001:db8:1:2::${i}`, false);
  assert.equal(attempt("public", "2001:db8:1:2:ffff::9", false).kind, "locked");
  assert.equal(attempt("public", "2001:db8:1:3::1", false).kind, "allowed");
});

test("invalid and missing headers fall into one shared group that locks together", () => {
  const { attempt } = setup();
  for (const header of [undefined, "garbage", "", "999.1.1.1", undefined]) attempt("public", header, false);
  assert.equal(attempt("public", "also garbage", false).kind, "locked");
  assert.equal(attempt("public", "203.0.113.5", false).kind, "allowed");
});

test("the 6th failed attempt of one source is locked for 15 min; doubling up to 24 h", () => {
  const { attempt, clock, throttle } = setup();
  const expected = [15, 30, 60, 120, 240, 480, 960, 1440, 1440].map((m) => m * MIN);
  for (const [i, duration] of expected.entries()) {
    for (let n = 1; n <= 5; n++)
      assert.equal(attempt("public", "203.0.113.5", false).kind, "allowed", `lock ${i} try ${n}`);
    const blocked = attempt("public", "203.0.113.5", false);
    // The lock started at the 5th failure, 2.1 s before this attempt.
    assert.equal(lockedFor(blocked, clock.t), duration - 2_100, `lock ${i + 1}`);
    clock.t += duration;
    // Keep the account limit (20 per 24 h) out of this source-only table.
    throttle.unlock("account");
  }
});

test("lock levels decay after 24 h without a new lock; a success resets the source", () => {
  const { attempt, clock } = setup();
  const lockOnce = (ip: string) => {
    for (let n = 1; n <= 5; n++) attempt("public", ip, false);
    return lockedFor(attempt("public", ip, false), clock.t) + 2_100;
  };
  assert.equal(lockOnce("203.0.113.5"), 15 * MIN);
  clock.t += 15 * MIN;
  assert.equal(lockOnce("203.0.113.5"), 30 * MIN);
  clock.t += 30 * MIN + DAY;
  assert.equal(lockOnce("203.0.113.5"), 15 * MIN, "level decayed after 24 h");

  clock.t += 15 * MIN;
  for (let n = 1; n <= 4; n++) attempt("public", "198.51.100.7", false);
  assert.equal(attempt("public", "198.51.100.7", true).kind, "allowed");
  for (let n = 1; n <= 4; n++) assert.equal(attempt("public", "198.51.100.7", false).kind, "allowed");
  assert.equal(attempt("public", "198.51.100.7", false).kind, "allowed", "counter restarted after the success");
});

test("failures older than the 15-minute window do not add up", () => {
  const { attempt, clock } = setup();
  for (let n = 1; n <= 4; n++) attempt("public", "203.0.113.5", false);
  clock.t += 15 * MIN;
  for (let n = 1; n <= 4; n++) attempt("public", "203.0.113.5", false);
  assert.equal(attempt("public", "203.0.113.5", false).kind, "allowed");
});

test("the 21st failure on the account over changing sources closes public sign-in; local stays open", () => {
  const { attempt, clock, throttle } = setup();
  const ip = (i: number) => `198.51.100.${i}`;
  const expected = [60, 120, 240, 480, 960, 1440, 1440].map((m) => m * MIN);
  for (const [round, duration] of expected.entries()) {
    for (let i = 1; i <= 20; i++) assert.equal(attempt("public", ip(i), false).kind, "allowed", `round ${round} #${i}`);
    assert.equal(lockedFor(attempt("public", ip(21), false), clock.t), duration - 2_100, `account lock ${round + 1}`);
    assert.equal(attempt("public", undefined, false).kind, "locked");
    // Local sign-in while the account is closed for public requests, header ignored.
    const local = throttle.check({ access: "local", cfConnectingIp: ip(1) });
    assert.equal(local.kind, "allowed");
    assert.equal((local as { source: string }).source, "local");
    clock.t += duration;
  }
});

test("a public source lock never blocks local sign-in, and local failures lock nothing", () => {
  const { attempt, throttle, clock } = setup();
  for (let n = 1; n <= 5; n++) attempt("public", "203.0.113.5", false);
  assert.equal(attempt("public", "203.0.113.5", false).kind, "locked");
  for (let n = 1; n <= 30; n++) {
    clock.t += 15_000;
    const local = throttle.check({ access: "local", cfConnectingIp: "203.0.113.5" });
    assert.equal(local.kind, "allowed", `local #${n}`);
    if (local.kind === "allowed") throttle.report(local, false);
  }
  const entries = throttle.status();
  assert.deepEqual(
    entries.map((e) => e.bucket),
    ["account", "source:203.0.113.5"]
  );
  assert.equal(entries.find((e) => e.bucket === "account")?.failures, 5, "local failures do not count");
});

test("local soft limit: 5 attempts per minute, then busy with the wait in seconds", () => {
  const { throttle, clock } = setup();
  for (let n = 1; n <= 5; n++) assert.equal(throttle.check({ access: "local" }).kind, "allowed");
  clock.t += 20_000;
  assert.deepEqual(throttle.check({ access: "local" }), { kind: "busy", retryAfterSeconds: 40 });
  assert.equal(throttle.check({ access: "public", cfConnectingIp: "203.0.113.5" }).kind, "allowed");
  clock.t += 40_000;
  assert.equal(throttle.check({ access: "local" }).kind, "allowed");
});

test("public load: at most 30 attempts per minute over all sources", () => {
  const { throttle, clock } = setup();
  for (let n = 1; n <= 30; n++)
    assert.equal(throttle.check({ access: "public", cfConnectingIp: `198.51.100.${n}` }).kind, "allowed");
  clock.t += 59_500;
  assert.deepEqual(throttle.check({ access: "public", cfConnectingIp: "203.0.113.5" }), {
    kind: "busy",
    retryAfterSeconds: 1,
  });
  assert.equal(throttle.check({ access: "local" }).kind, "allowed", "local has its own limit");
  clock.t += 500;
  assert.equal(throttle.check({ access: "public", cfConnectingIp: "203.0.113.5" }).kind, "allowed");
});

test("queue: one check at a time, 4 waiting, the 6th is refused with a wait", async () => {
  const { throttle } = setup();
  const decisions = Array.from({ length: 6 }, (_, i) =>
    throttle.check({ access: "public", cfConnectingIp: `198.51.100.${i + 1}` })
  );
  let running = 0;
  let maxRunning = 0;
  const releases: Array<() => void> = [];
  const check = () =>
    new Promise<boolean>((resolve) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      releases.push(() => {
        running--;
        resolve(false);
      });
    });
  const runs = decisions.slice(0, 5).map((d) => {
    assert.equal(d.kind, "allowed");
    return throttle.verify(d as Extract<UiLoginDecision, { kind: "allowed" }>, check);
  });
  const sixth = decisions[5] as Extract<UiLoginDecision, { kind: "allowed" }>;
  assert.deepEqual(await throttle.verify(sixth, check), { kind: "busy", retryAfterSeconds: 1 });
  assert.deepEqual(throttle.check({ access: "public", cfConnectingIp: "203.0.113.9" }), {
    kind: "busy",
    retryAfterSeconds: 1,
  });
  // Local checks bypass the queue.
  const local = throttle.check({ access: "local" }) as Extract<UiLoginDecision, { kind: "allowed" }>;
  assert.deepEqual(await throttle.verify(local, async () => "local ran"), { kind: "done", value: "local ran" });

  for (let n = 0; n < 5; n++) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, n + 1, "exactly one more check started");
    releases[n]();
  }
  assert.deepEqual(await Promise.all(runs), Array(5).fill({ kind: "done", value: false }));
  assert.equal(maxRunning, 1);
  // Free again.
  assert.deepEqual(await throttle.verify(sixth, async () => true), { kind: "done", value: true });
});

test("a failing check frees the queue slot", async () => {
  const { throttle } = setup();
  const d = throttle.check({ access: "public", cfConnectingIp: "203.0.113.5" }) as Extract<
    UiLoginDecision,
    { kind: "allowed" }
  >;
  await assert.rejects(
    throttle.verify(d, async () => {
      throw new Error("boom");
    })
  );
  assert.deepEqual(await throttle.verify(d, async () => 1), { kind: "done", value: 1 });
});

test("counters and locks survive reopening the database; nothing but bucket names is stored", () => {
  const first = setup();
  for (let n = 1; n <= 5; n++) first.attempt("public", "203.0.113.5", false);
  const t = first.clock.t;
  first.db.close();

  const db: AppDatabase = openAppDatabase({ path: first.path });
  const reopened = new UiLoginThrottle(db, () => t + 1_000);
  assert.equal(reopened.check({ access: "public", cfConnectingIp: "203.0.113.5" }).kind, "locked");
  assert.deepEqual(
    db.sqlite
      .prepare("SELECT bucket FROM ui_login_failures ORDER BY bucket")
      .all()
      .map((r) => r.bucket),
    ["account", "rate:public", "source:203.0.113.5"]
  );
  db.close();
});

test("status lists locks and recent failures; unlock clears one bucket or all", () => {
  const { attempt, throttle, clock } = setup();
  for (let n = 1; n <= 5; n++) attempt("public", "203.0.113.5", false);
  attempt("public", "198.51.100.7", false);
  const status = throttle.status();
  assert.deepEqual(
    status.map(({ bucket, failures, lockoutLevel }) => ({ bucket, failures, lockoutLevel })),
    [
      { bucket: "account", failures: 6, lockoutLevel: 0 },
      { bucket: "source:198.51.100.7", failures: 1, lockoutLevel: 0 },
      { bucket: "source:203.0.113.5", failures: 0, lockoutLevel: 1 },
    ]
  );
  const locked = status.find((e) => e.bucket === "source:203.0.113.5");
  assert.equal(locked?.lockedUntil, clock.t - 2_100 + 15 * MIN);
  assert.equal(status.find((e) => e.bucket === "account")?.lastFailureAt, clock.t);

  assert.equal(throttle.unlock("source:203.0.113.5"), 1);
  assert.equal(attempt("public", "203.0.113.5", false).kind, "allowed");
  assert.equal(throttle.unlock("source:unknown"), 0);

  // 7 account failures so far; the 13th of these is the account's 20th.
  for (let i = 1; i <= 13; i++) assert.equal(attempt("public", `192.0.2.${i}`, false).kind, "allowed");
  assert.equal(attempt("public", "192.0.2.99", false).kind, "locked");
  assert.ok(throttle.unlock() >= 3);
  assert.deepEqual(throttle.status(), []);
  assert.equal(attempt("public", "192.0.2.99", false).kind, "allowed");
});

test("stale rows are pruned on the next failure", () => {
  const { attempt, throttle, clock } = setup();
  attempt("public", "203.0.113.5", false);
  clock.t += DAY;
  attempt("public", "198.51.100.7", false);
  assert.deepEqual(
    throttle.status().map((e) => e.bucket),
    ["account", "source:198.51.100.7"]
  );
});
