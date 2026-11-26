/**
 * #1198 S1 — the web UI account (ui-account-store.ts) and app-database
 * migration v4 "ui-login": from v3 with a backup, idempotent reopen; one
 * account, never overwritten; credential_version; damaged storage is locked;
 * exportJson carries no check value and no session hash.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/ui-account-store.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APP_MIGRATIONS, openAppDatabase } from "../src/app-database.js";
import { UiAccountStore, uiUsernameProblem } from "../src/ui-account-store.js";

const fixture = () => join(mkdtempSync(join(tmpdir(), "bastra-ui-account-db-")), "recall.db");
const PASSWORD = "correct horse battery staple";
const UI_TABLES = ["ui_account", "ui_login_failures", "ui_sessions"];
const uiTables = (db: DatabaseSync) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ui_%' ORDER BY name")
    .all()
    .map((r) => r.name);

test("migration v4 adds the UI login tables after a backup of v3, keeps rows, runs once", () => {
  const path = fixture();
  const v3 = openAppDatabase({ path, migrations: APP_MIGRATIONS.slice(0, 3) });
  v3.sqlite.prepare("INSERT INTO app_records(namespace,key,value) VALUES('tasks','t1','{}')").run();
  v3.sqlite.prepare("INSERT INTO chat_conversations(id,title,created_at,updated_at) VALUES('c1','hi',1,1)").run();
  v3.close();

  const db = openAppDatabase({ path });
  assert.equal(db.sqlite.prepare("PRAGMA user_version").get()?.user_version, 4);
  assert.deepEqual(uiTables(db.sqlite), UI_TABLES);
  const cols = (table: string) =>
    db.sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name);
  assert.deepEqual(cols("ui_account"), [
    "id",
    "username",
    "password_hash",
    "credential_version",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(cols("ui_sessions"), [
    "id",
    "token_hash",
    "kind",
    "origin",
    "created_at",
    "expires_at",
    "last_seen_at",
    "credential_version",
    "label",
    "user_agent",
  ]);
  assert.deepEqual(cols("ui_login_failures"), [
    "bucket",
    "failures",
    "window_started_at",
    "locked_until",
    "lockout_level",
    "updated_at",
  ]);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM app_records").get()?.n, 1);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM chat_conversations").get()?.n, 1);
  // Constraints S2 relies on.
  assert.throws(() =>
    db.sqlite
      .prepare(
        "INSERT INTO ui_sessions(id,token_hash,kind,origin,created_at,expires_at,last_seen_at,credential_version) VALUES('s','x','browser','local',1,2,1,1)"
      )
      .run()
  );
  assert.throws(() =>
    db.sqlite
      .prepare(
        "INSERT INTO ui_sessions(id,token_hash,kind,origin,created_at,expires_at,last_seen_at,credential_version) VALUES('s',?,'other','local',1,2,1,1)"
      )
      .run("a".repeat(64))
  );
  db.close();

  const backups = readdirSync(`${path}.backups`).filter((x) => x.startsWith("before-v4-"));
  assert.equal(backups.length, 1);
  const snap = new DatabaseSync(join(`${path}.backups`, backups[0]!), { readOnly: true });
  assert.equal(snap.prepare("PRAGMA user_version").get()?.user_version, 3);
  assert.deepEqual(uiTables(snap), [], "backup is the state before v4");
  snap.close();

  const again = openAppDatabase({ path });
  assert.equal(again.sqlite.prepare("PRAGMA user_version").get()?.user_version, 4);
  again.close();
  openAppDatabase({ path }).close();
  assert.deepEqual(
    readdirSync(`${path}.backups`).filter((x) => x.startsWith("before-v4-")),
    backups,
    "reopening does not migrate again"
  );
});

test("a fresh database migrates straight to v4", () => {
  const db = openAppDatabase({ path: fixture() });
  assert.equal(db.sqlite.prepare("PRAGMA user_version").get()?.user_version, 4);
  assert.deepEqual(uiTables(db.sqlite), UI_TABLES);
  db.close();
});

test("one account: create, login, second setup never overwrites, password change raises credential_version", async () => {
  const db = openAppDatabase({ path: fixture() });
  const store = new UiAccountStore(db);
  assert.deepEqual(store.status(), { state: "none" });
  assert.deepEqual(await store.verifyLogin("daniel", PASSWORD), { ok: false }, "no account: refused");
  assert.deepEqual(await store.setPassword(PASSWORD), { ok: false, problem: "no-account" });

  assert.deepEqual(await store.create("daniel", "too short"), { ok: false, problem: "too-short" });
  assert.deepEqual(await store.create(" daniel", PASSWORD), { ok: false, problem: "username-invalid" });
  assert.deepEqual(store.status(), { state: "none" });

  assert.deepEqual(await store.create("daniel", PASSWORD), { ok: true, credentialVersion: 1 });
  const status = store.status();
  assert.equal(status.state, "present");
  assert.equal(status.state === "present" && status.username, "daniel");
  assert.equal(status.state === "present" && status.credentialVersion, 1);
  assert.equal("password_hash" in status, false, "status never carries the check value");
  const stored = String(db.sqlite.prepare("SELECT password_hash FROM ui_account").get()?.password_hash);
  assert.ok(stored.startsWith("$argon2id$v=19$"));
  assert.equal(stored.includes(PASSWORD), false);

  assert.deepEqual(await store.verifyLogin("daniel", PASSWORD), { ok: true, credentialVersion: 1 });
  assert.deepEqual(await store.verifyLogin("daniel", "wrong password, long enough"), { ok: false });
  assert.deepEqual(await store.verifyLogin("Daniel", PASSWORD), { ok: false }, "user name keeps its case");
  assert.deepEqual(await store.verifyLogin("someone", PASSWORD), { ok: false });
  assert.deepEqual(await store.verifyLogin("daniel", "x".repeat(5000)), { ok: false });
  assert.deepEqual(await store.verifyLogin(undefined, undefined), { ok: false });

  // Second setup, even with another name: refused, nothing replaced.
  assert.deepEqual(await store.create("other", "another password, long enough"), {
    ok: false,
    problem: "account-exists",
  });
  assert.equal(db.sqlite.prepare("SELECT password_hash FROM ui_account").get()?.password_hash, stored);
  assert.deepEqual(await store.verifyLogin("daniel", PASSWORD), { ok: true, credentialVersion: 1 });
  const next = "a new password that is long enough";
  assert.deepEqual(await store.setPassword("short"), { ok: false, problem: "too-short" });
  assert.deepEqual(await store.setPassword(next), { ok: true, credentialVersion: 2 });
  assert.deepEqual(await store.verifyLogin("daniel", PASSWORD), { ok: false });
  assert.deepEqual(await store.verifyLogin("daniel", next), { ok: true, credentialVersion: 2 });
  db.close();
});

test("two setups racing past the existence check: exactly one wins, the other does not overwrite", async () => {
  const db = openAppDatabase({ path: fixture() });
  // Both calls pass the synchronous existence check before either hash finishes.
  const raced = await Promise.all([
    new UiAccountStore(db).create("first", "racing password number one"),
    new UiAccountStore(db).create("second", "racing password number two"),
  ]);
  assert.equal(raced.filter((r) => r.ok).length, 1);
  assert.deepEqual(
    raced.find((r) => !r.ok),
    { ok: false, problem: "account-exists" }
  );
  const store = new UiAccountStore(db);
  const winner = raced[0]!.ok ? ["first", "racing password number one"] : ["second", "racing password number two"];
  assert.deepEqual(await store.verifyLogin(winner[0], winner[1]), { ok: true, credentialVersion: 1 });
  db.close();
});

test("multi-byte user names and passwords; user names compare in NFC", async () => {
  const db = openAppDatabase({ path: fixture() });
  const store = new UiAccountStore(db);
  const name = "Zoë 山田 🚀";
  const password = "пароль-密码-🔐-ünïcödé";
  assert.deepEqual(await store.create(name.normalize("NFD"), password), { ok: true, credentialVersion: 1 });
  const status = store.status();
  assert.equal(status.state === "present" && status.username, name.normalize("NFC"));
  assert.deepEqual(await store.verifyLogin(name.normalize("NFC"), password), { ok: true, credentialVersion: 1 });
  assert.deepEqual(
    await store.verifyLogin(name, password.normalize("NFD")),
    { ok: false },
    "passwords are not normalized"
  );
  db.close();
});

test("user name rules are length and character classes, no language lists", () => {
  for (const ok of ["d", "daniel", "Даниэль", "ダニエル", "دانيال", "a b", "x".repeat(64), "🙂".repeat(64)])
    assert.equal(uiUsernameProblem(ok), null, ok);
  assert.equal(uiUsernameProblem(""), "username-empty");
  assert.equal(uiUsernameProblem("x".repeat(65)), "username-too-long");
  assert.equal(uiUsernameProblem("🙂".repeat(65)), "username-too-long");
  assert.equal(uiUsernameProblem("x".repeat(10_000)), "username-too-long");
  for (const bad of ["a\nb", "a\u0000b", "tab\t", " lead", "trail ", " nbsp", "a\u007fb", "a\uD800", 7, null])
    assert.equal(uiUsernameProblem(bad), "username-invalid", JSON.stringify(bad));
});

test("damaged storage is locked, not open, and never throws", async () => {
  const db = openAppDatabase({ path: fixture() });
  const store = new UiAccountStore(db);
  await store.create("daniel", PASSWORD);

  db.sqlite.prepare("UPDATE ui_account SET password_hash='$argon2id$v=19$m=65536,t=3,p=1$broken'").run();
  assert.deepEqual(store.status(), { state: "damaged" });
  assert.deepEqual(await store.verifyLogin("daniel", PASSWORD), { ok: false });
  assert.deepEqual(await store.create("daniel", PASSWORD), { ok: false, problem: "account-exists" });
  // The local repair path (CLI reset-password) writes a fresh check value.
  assert.deepEqual(await store.setPassword(PASSWORD), { ok: true, credentialVersion: 2 });
  assert.equal(store.status().state, "present");
  assert.deepEqual(await store.verifyLogin("daniel", PASSWORD), { ok: true, credentialVersion: 2 });

  db.sqlite.prepare("UPDATE ui_account SET username=?").run("bad\nname");
  assert.deepEqual(store.status(), { state: "damaged" });
  assert.deepEqual(await store.verifyLogin("bad\nname", PASSWORD), { ok: false });

  db.sqlite.exec("DROP TABLE ui_account");
  assert.deepEqual(store.status(), { state: "damaged" });
  assert.deepEqual(await store.verifyLogin("daniel", PASSWORD), { ok: false });
  db.close();
});

test("exportJson leaves out the password check value, session token hashes and failure rows (IPs)", async () => {
  const path = fixture();
  const db = openAppDatabase({ path });
  await new UiAccountStore(db).create("daniel", PASSWORD);
  const stored = String(db.sqlite.prepare("SELECT password_hash FROM ui_account").get()?.password_hash);
  const tokenHash = "ab".repeat(32);
  db.sqlite
    .prepare(
      "INSERT INTO ui_sessions(id,token_hash,kind,origin,created_at,expires_at,last_seen_at,credential_version) VALUES('s1',?,'device','public',1,2,1,1)"
    )
    .run(tokenHash);
  db.sqlite
    .prepare(
      "INSERT INTO ui_login_failures(bucket,failures,window_started_at,updated_at) VALUES('ip:203.0.113.9',1,1,1)"
    )
    .run();
  db.exportJson(`${path}.json`);
  db.close();
  const text = readFileSync(`${path}.json`, "utf8");
  const exported = JSON.parse(text);
  assert.equal(exported.schemaVersion, 4);
  assert.equal(text.includes(stored), false);
  assert.equal(text.includes(stored.split("$").at(-1)!), false);
  assert.equal(text.includes(tokenHash), false);
  assert.equal("ui_account" in exported.tables, false);
  assert.equal("ui_sessions" in exported.tables, false);
  // Failure rows hold source IP addresses: omitted as well.
  assert.equal("ui_login_failures" in exported.tables, false);
  assert.equal(text.includes("ip:203.0.113.9"), false);
  assert.ok("app_records" in exported.tables, "other tables stay in the export");
});
