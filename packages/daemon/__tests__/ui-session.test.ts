/**
 * #1198 S2 — web UI sessions (ui-session.ts): lifetimes with an injected clock,
 * background polls, activity write throttle, revocation, credential_version,
 * cookie texts, cookie parser, CSRF value, malformed input, reopen.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/ui-session.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase, type AppDatabase } from "../src/app-database.js";
import { UiAccountStore } from "../src/ui-account-store.js";
import {
  UiSessionStore,
  readUiSessionCookie,
  uiCsrfToken,
  uiSessionClearCookie,
  uiSessionCookie,
  verifyUiCsrf,
  type UiSessionKind,
  type UiSessionOrigin,
} from "../src/ui-session.js";

const fixture = () => join(mkdtempSync(join(tmpdir(), "bastra-ui-session-db-")), "recall.db");
const PASSWORD = "correct horse battery staple";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 26, 9, 0, 0);
const USER = { background: false };
const POLL = { background: true };

async function setup(path = fixture()) {
  const db = openAppDatabase({ path });
  const account = new UiAccountStore(db);
  await account.create("daniel", PASSWORD);
  const clock = { t: T0 };
  const sessions = new UiSessionStore(db, () => clock.t);
  const start = (kind: UiSessionKind = "browser", origin: UiSessionOrigin = "local") =>
    sessions.create({ kind, origin, credentialVersion: 1, label: "Mac", userAgent: "Test" });
  return { db, path, account, clock, sessions, start };
}

const lastSeen = (db: AppDatabase, id: string) =>
  Number(db.sqlite.prepare("SELECT last_seen_at FROM ui_sessions WHERE id=?").get(id)?.last_seen_at);

test("create stores only the SHA-256 of a 32-byte token and returns a neutral handle", async () => {
  const { db, sessions, start } = await setup();
  const s = start();
  assert.match(s.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(s.token, "base64url").length, 32);
  assert.notEqual(s.id, s.token);
  assert.equal(s.expiresAt, T0 + DAY);
  const row = db.sqlite.prepare("SELECT * FROM ui_sessions WHERE id=?").get(s.id)!;
  assert.match(String(row.token_hash), /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(row).includes(s.token), false, "raw token is never stored");
  assert.deepEqual(
    [row.kind, row.origin, row.created_at, row.last_seen_at, row.credential_version],
    ["browser", "local", T0, T0, 1]
  );
  assert.deepEqual(sessions.check(s.token, "local", USER), {
    ok: true,
    id: s.id,
    kind: "browser",
    origin: "local",
    expiresAt: T0 + DAY,
  });
  assert.notEqual(start().token, s.token);
  db.close();
});

test("browser session: ends after 2 h idle, activity keeps it, 24 h absolute regardless", async () => {
  const { db, clock, sessions, start } = await setup();
  const idle = start();
  clock.t = T0 + 2 * HOUR - 1;
  assert.equal(sessions.check(idle.token, "local", POLL).ok, true);
  clock.t = T0 + 2 * HOUR;
  assert.equal(sessions.check(idle.token, "local", USER).ok, false, "idle 2 h");

  clock.t = T0;
  const busy = start();
  for (let t = T0 + HOUR; t < T0 + DAY; t += HOUR) {
    clock.t = t;
    assert.equal(sessions.check(busy.token, "local", USER).ok, true, `active at ${(t - T0) / HOUR} h`);
  }
  clock.t = T0 + DAY - 1;
  assert.equal(sessions.check(busy.token, "local", USER).ok, true);
  clock.t = T0 + DAY;
  assert.equal(sessions.check(busy.token, "local", USER).ok, false, "24 h absolute");
  db.close();
});

test("device session: no idle limit, ends after 30 days", async () => {
  const { db, clock, sessions, start } = await setup();
  const device = start("device");
  assert.equal(device.expiresAt, T0 + 30 * DAY);
  clock.t = T0 + 29 * DAY;
  assert.equal(sessions.check(device.token, "local", POLL).ok, true, "weeks without activity");
  clock.t = T0 + 30 * DAY - 1;
  assert.equal(sessions.check(device.token, "local", USER).ok, true);
  clock.t = T0 + 30 * DAY;
  assert.equal(sessions.check(device.token, "local", USER).ok, false);
  db.close();
});

test("background polls do not extend; activity is written at most once a minute", async () => {
  const { db, clock, sessions, start } = await setup();
  const s = start();
  for (let t = T0 + 10 * MIN; t < T0 + 2 * HOUR; t += 10 * MIN) {
    clock.t = t;
    assert.equal(sessions.check(s.token, "local", POLL).ok, true);
  }
  assert.equal(lastSeen(db, s.id), T0, "polls never write");
  clock.t = T0 + 2 * HOUR;
  assert.equal(sessions.check(s.token, "local", POLL).ok, false, "polling alone does not keep the session");

  clock.t = T0;
  const t = start();
  clock.t = T0 + 30_000;
  sessions.check(t.token, "local", USER);
  assert.equal(lastSeen(db, t.id), T0, "within the first minute: no write");
  clock.t = T0 + MIN - 1;
  sessions.check(t.token, "local", USER);
  assert.equal(lastSeen(db, t.id), T0);
  clock.t = T0 + MIN;
  sessions.check(t.token, "local", USER);
  assert.equal(lastSeen(db, t.id), T0 + MIN, "one minute on: written");
  clock.t = T0 + MIN + 59_000;
  sessions.check(t.token, "local", USER);
  assert.equal(lastSeen(db, t.id), T0 + MIN);
  clock.t = T0 + MIN + 2 * HOUR - 1;
  assert.equal(sessions.check(t.token, "local", USER).ok, true, "idle counts from the last write");
  db.close();
});

test("a session is valid only for the origin it was created for", async () => {
  const { db, sessions, start } = await setup();
  const local = start("browser", "local");
  const pub = start("device", "public");
  assert.equal(sessions.check(local.token, "public", USER).ok, false);
  assert.equal(sessions.check(pub.token, "local", USER).ok, false);
  const ok = sessions.check(pub.token, "public", USER);
  assert.deepEqual(ok.ok && [ok.kind, ok.origin, ok.id], ["device", "public", pub.id]);
  db.close();
});

test("revocation (one, all, by origin) and a new credential_version act immediately", async () => {
  const { db, account, sessions, start } = await setup();
  const a = start("browser", "local");
  const b = start("device", "public");
  const c = start("browser", "public");
  assert.equal(sessions.revoke(a.id), true);
  assert.equal(sessions.revoke(a.id), false);
  assert.equal(sessions.revoke(a.token), false, "the token is no handle");
  assert.equal(sessions.revoke(undefined), false);
  assert.equal(sessions.revoke("x".repeat(100_000)), false);
  assert.equal(sessions.check(a.token, "local", USER).ok, false);
  assert.equal(sessions.check(b.token, "public", USER).ok, true);

  const d = start("device", "local");
  assert.equal(sessions.revokeOrigin("public"), 2);
  assert.equal(sessions.check(b.token, "public", USER).ok, false);
  assert.equal(sessions.check(c.token, "public", USER).ok, false);
  assert.equal(sessions.check(d.token, "local", USER).ok, true, "local sessions stay");

  start("browser", "public");
  assert.equal(sessions.revokeAll(), 2);
  assert.equal(sessions.check(d.token, "local", USER).ok, false);
  assert.deepEqual(sessions.list(), []);

  const e = start("device", "local");
  assert.equal(sessions.check(e.token, "local", USER).ok, true);
  assert.equal((await account.setPassword("a new password that is long enough")).ok, true);
  assert.equal(sessions.check(e.token, "local", USER).ok, false, "password change ends old sessions");
  const f = sessions.create({ kind: "browser", origin: "local", credentialVersion: 2 });
  assert.equal(sessions.check(f.token, "local", USER).ok, true);

  db.sqlite.prepare("UPDATE ui_account SET username=?").run("bad\nname");
  assert.equal(sessions.check(f.token, "local", USER).ok, false, "damaged account: locked");
  db.sqlite.exec("DROP TABLE ui_account");
  assert.equal(sessions.check(f.token, "local", USER).ok, false, "missing account: locked, no exception");
  db.close();
});

test("list shows active sessions without hashes; pruneExpired removes expired, idle and superseded rows", async () => {
  const { db, account, clock, sessions, start } = await setup();
  const old = start("browser", "local");
  clock.t = T0 + 3 * HOUR;
  const device = sessions.create({
    kind: "device",
    origin: "public",
    credentialVersion: 1,
    label: "  Pixel\u0000 ‮phone\n  ",
    userAgent: `Mozilla/5.0 ${"x".repeat(5000)}`,
  });
  const fresh = start("browser", "local");
  clock.t = T0 + 3 * HOUR + 5 * MIN;
  sessions.check(fresh.token, "local", USER);

  const list = sessions.list();
  assert.deepEqual(
    list.map((s) => s.id),
    [fresh.id, device.id],
    "idle session hidden, newest activity first"
  );
  assert.deepEqual(Object.keys(list[1]!).sort(), [
    "createdAt",
    "expiresAt",
    "id",
    "kind",
    "label",
    "lastSeenAt",
    "origin",
    "userAgent",
  ]);
  assert.equal(list[1]!.label, "Pixel phone", "control and bidi characters removed, trimmed");
  assert.equal([...list[1]!.userAgent].length, 300, "user agent bounded");
  assert.equal(JSON.stringify(list).includes(device.token), false);

  assert.equal(sessions.pruneExpired(), 1);
  assert.equal(db.sqlite.prepare("SELECT 1 FROM ui_sessions WHERE id=?").get(old.id), undefined);
  assert.equal(sessions.pruneExpired(), 0);
  await account.setPassword("a new password that is long enough");
  assert.deepEqual(sessions.list(), [], "superseded sessions are not listed");
  assert.equal(sessions.pruneExpired(), 2);
  db.close();
});

test("labels: multi-byte text kept, cut by code points, never a lone surrogate", async () => {
  const { db, sessions } = await setup();
  const make = (label: unknown) =>
    sessions.create({ kind: "browser", origin: "local", credentialVersion: 1, label, userAgent: 42 });
  make("Zoës 山田 📱 👩‍💻");
  make("🚀".repeat(500));
  make({ toString: () => "evil" });
  const labels = sessions.list().map((s) => s.label);
  assert.ok(labels.includes("Zoës 山田 📱 👩‍💻"), "emoji joiners stay");
  assert.ok(labels.includes("🚀".repeat(100)));
  assert.ok(labels.includes(""));
  for (const s of sessions.list()) {
    assert.equal(s.userAgent, "");
    assert.equal(/\p{Cs}/u.test(s.label), false);
  }
  db.close();
});

test("cookie texts match the plan character for character", () => {
  const token = "A".repeat(43);
  assert.equal(
    uiSessionCookie("local", { token, kind: "browser" }),
    `bastra_ui=${token}; HttpOnly; SameSite=Strict; Path=/ui`
  );
  assert.equal(
    uiSessionCookie("local", { token, kind: "device" }),
    `bastra_ui=${token}; HttpOnly; SameSite=Strict; Path=/ui; Max-Age=2592000`
  );
  assert.equal(
    uiSessionCookie("public", { token, kind: "browser" }),
    `__Host-bastra_ui=${token}; Secure; HttpOnly; SameSite=Strict; Path=/`
  );
  assert.equal(
    uiSessionCookie("public", { token, kind: "device" }),
    `__Host-bastra_ui=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`
  );
  assert.equal(uiSessionClearCookie("local"), "bastra_ui=; HttpOnly; SameSite=Strict; Path=/ui; Max-Age=0");
  assert.equal(
    uiSessionClearCookie("public"),
    "__Host-bastra_ui=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
  );
  assert.equal(uiSessionCookie("local", { token, kind: "browser" }).includes("Secure"), false);
});

test("cookie parser accepts only the name of its origin and well-formed tokens", () => {
  const token = "abcDEF123_-".repeat(4).slice(0, 43);
  assert.equal(readUiSessionCookie(`bastra_ui=${token}`, "local"), token);
  assert.equal(readUiSessionCookie(`theme=dark; bastra_ui=${token}; x=1`, "local"), token);
  assert.equal(readUiSessionCookie(`__Host-bastra_ui=${token}`, "public"), token);
  assert.equal(readUiSessionCookie(`theme=dark;__Host-bastra_ui=${token}`, "public"), token);
  assert.equal(readUiSessionCookie(`__Host-bastra_ui=${token}`, "local"), null, "wrong name for local");
  assert.equal(readUiSessionCookie(`bastra_ui=${token}`, "public"), null, "wrong name for public");
  assert.equal(readUiSessionCookie(`xbastra_ui=${token}`, "local"), null);
  assert.equal(readUiSessionCookie(`BASTRA_UI=${token}`, "local"), null);
  assert.equal(readUiSessionCookie(`bastra_ui=${token}; bastra_ui=${"B".repeat(43)}`, "local"), token, "first wins");
  for (const bad of [
    undefined,
    null,
    42,
    ["bastra_ui=" + token],
    "",
    "bastra_ui",
    "bastra_ui=",
    `bastra_ui=${token}x`,
    `bastra_ui=${token.slice(1)}`,
    `bastra_ui="${token}"`,
    `bastra_ui=${token.slice(0, 42)}é`,
    `bastra_ui=${token.slice(0, 41)}🙂`,
    `bastra_ui=${token.slice(0, 42)}=`,
    `x=${"y".repeat(20_000)}; bastra_ui=${token}`,
    "\u0000;;;==;",
  ])
    assert.equal(readUiSessionCookie(bad, "local"), null, JSON.stringify(bad)?.slice(0, 60));
});

test("malformed tokens are invalid without exceptions", async () => {
  const { db, sessions, start } = await setup();
  start();
  for (const bad of [
    undefined,
    null,
    0,
    {},
    "",
    "short",
    "x".repeat(1_000_000),
    "é".repeat(43),
    "🙂".repeat(22),
    "A".repeat(42) + "\u0000",
    "A".repeat(43),
  ])
    assert.deepEqual(sessions.check(bad, "local", USER), { ok: false });
  db.close();
});

test("CSRF value belongs to its own session only and is checked safely", async () => {
  const { db, sessions, start } = await setup();
  const a = start();
  const b = start();
  const csrfA = uiCsrfToken(a.token);
  assert.match(csrfA, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(uiCsrfToken(a.token), csrfA, "deterministic, nothing stored");
  assert.notEqual(csrfA, a.token);
  assert.equal(verifyUiCsrf(a.token, csrfA), true);
  assert.equal(verifyUiCsrf(b.token, csrfA), false, "another session's value");
  assert.equal(verifyUiCsrf(a.token, uiCsrfToken(b.token)), false);
  assert.equal(verifyUiCsrf(a.token, a.token), false, "the session token is no CSRF value");
  for (const bad of [
    undefined,
    null,
    "",
    csrfA.slice(1),
    `${csrfA}A`,
    `${csrfA.slice(0, 42)}é`,
    `${csrfA.slice(0, 41)}🙂`,
    "x".repeat(100_000),
    [csrfA],
  ])
    assert.equal(verifyUiCsrf(a.token, bad), false, JSON.stringify(bad)?.slice(0, 60));
  assert.equal(verifyUiCsrf(undefined, csrfA), false);
  assert.equal(verifyUiCsrf("é".repeat(43), csrfA), false);
  assert.equal(sessions.check(a.token, "local", USER).ok, true);
  db.close();
});

test("sessions survive reopening the database", async () => {
  const first = await setup();
  const device = first.start("device", "public");
  const browser = first.start("browser", "local");
  first.db.close();

  const db = openAppDatabase({ path: first.path });
  const sessions = new UiSessionStore(db, () => T0 + HOUR);
  assert.equal(sessions.check(device.token, "public", USER).ok, true);
  assert.equal(sessions.check(browser.token, "local", USER).ok, true);
  assert.equal(sessions.list().length, 2);
  db.close();
});
