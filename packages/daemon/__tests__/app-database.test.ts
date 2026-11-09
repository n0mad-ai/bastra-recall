import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openAppDatabase, type AppMigration } from "../src/app-database.js";

function fixture() { return join(mkdtempSync(join(tmpdir(), "bastra-db-")), "recall.db"); }
const first: AppMigration = { version: 1, name: "counter", up(db) { db.exec("CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)"); } };

test("WAL, FTS5, JSON records and idempotent schema startup", () => {
  const path = fixture();
  const db = openAppDatabase({ path });
  assert.equal(db.sqlite.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  db.sqlite.prepare("INSERT INTO app_records(namespace,key,value) VALUES(?,?,?)").run("test", "a", '{"ok":true}');
  db.sqlite.prepare("INSERT INTO app_search(namespace,key,text) VALUES(?,?,?)").run("test", "a", "searchable sentence");
  assert.equal(db.sqlite.prepare("SELECT key FROM app_search WHERE app_search MATCH ?").get("searchable")?.key, "a");
  db.close();
  const backups = readdirSync(`${path}.backups`);
  const again = openAppDatabase({ path });
  assert.equal(again.sqlite.prepare("SELECT value FROM app_records").get()?.value, '{"ok":true}');
  again.close();
  assert.deepEqual(readdirSync(`${path}.backups`), backups);
});

test("backup precedes each migration, includes committed WAL and failed migration rolls back", () => {
  const path = fixture();
  let db = openAppDatabase({ path, migrations: [first] });
  db.sqlite.exec("UPDATE counter SET value=42");
  db.close();
  const second: AppMigration = { version: 2, name: "broken", up(sqlite) { sqlite.exec("UPDATE counter SET value=99; CREATE TABLE partial(value)"); throw new Error("interrupted"); } };
  assert.throws(() => openAppDatabase({ path, migrations: [first, second] }), /interrupted/);
  db = openAppDatabase({ path, migrations: [first] });
  assert.equal(db.sqlite.prepare("SELECT value FROM counter").get()?.value, 42);
  assert.equal(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(), undefined);
  db.close();
  const backups = readdirSync(`${path}.backups`).filter(x => x.includes("before-v2"));
  assert.equal(backups.length, 1);
  const snapshot = new DatabaseSync(join(`${path}.backups`, backups[0]), { readOnly: true });
  assert.equal(snapshot.prepare("SELECT value FROM counter").get()?.value, 42);
  assert.equal(snapshot.prepare("PRAGMA user_version").get()?.user_version, 1);
  snapshot.close();
});

test("backup and portable JSON export preserve rows; transaction rejects async callbacks", () => {
  const path = fixture();
  const db = openAppDatabase({ path, migrations: [first] });
  assert.throws(() => db.transaction(() => { db.sqlite.exec("UPDATE counter SET value=1"); throw new Error("rollback"); }), /rollback/);
  assert.throws(() => db.transaction(async () => 1), /synchronous/);
  assert.equal(db.sqlite.prepare("SELECT value FROM counter").get()?.value, 0);
  const target = `${path}.copy`;
  db.backup(target);
  const copy = new DatabaseSync(target);
  assert.equal(copy.prepare("SELECT value FROM counter").get()?.value, 0);
  copy.close();
  db.exportJson(`${path}.json`);
  const exported = JSON.parse(readFileSync(`${path}.json`, "utf8"));
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(exported.tables.counter, [{ value: 0 }]);
  assert.throws(() => db.backup(target), /exist/i);
  db.close();
});

test("rejects future schemas, invalid migration sequences and sync-directory symlinks", () => {
  const path = fixture();
  assert.throws(() => openAppDatabase({ path, migrations: [{ ...first, version: 2 }] }), /contiguous/);
  let db = openAppDatabase({ path, migrations: [first] });
  db.sqlite.exec("PRAGMA user_version=99"); db.close();
  assert.throws(() => openAppDatabase({ path, migrations: [first] }), /newer/);
  const root = mkdtempSync(join(tmpdir(), "bastra-db-path-"));
  mkdirSync(join(root, "CloudStorage"));
  symlinkSync(join(root, "CloudStorage"), join(root, "alias"));
  assert.throws(() => openAppDatabase({ path: join(root, "alias", "recall.db") }), /local/i);
  assert.equal(existsSync(join(root, "CloudStorage", "recall.db")), false);
  symlinkSync(join(root, "CloudStorage", "missing.db"), join(root, "dangling.db"));
  assert.throws(() => openAppDatabase({ path: join(root, "dangling.db") }), /local/i);
  assert.equal(existsSync(join(root, "CloudStorage", "missing.db")), false);
  const backupDb = openAppDatabase({ path: fixture() });
  assert.throws(() => backupDb.backup(join(root, "dangling.db")), /local/i);
  backupDb.close();
  let invoked = false;
  assert.throws(() => openAppDatabase({ path: fixture(), migrations: [{ version: 1, name: "async", async up() { invoked = true; } }] }), /synchronous/);
  assert.equal(invoked, false);
  assert.throws(() => openAppDatabase({ path: fixture(), busyTimeoutMs: -1 }), /timeout/);
  const failFast = openAppDatabase({ path: fixture(), busyTimeoutMs: 0 });
  assert.equal(failFast.sqlite.prepare("PRAGMA busy_timeout").get()?.timeout, 0);
  failFast.close();
});

async function child(code: string) {
  return await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: process.cwd(), env: process.env });
    let stderr = ""; proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.on("error", reject); proc.on("close", code => resolve({ code, stderr }));
  });
}

test("multiple processes migrate once and serialize read-modify-write transactions", async () => {
  const path = fixture();
  const code = `import {openAppDatabase} from './packages/daemon/src/app-database.ts';
    const db=openAppDatabase({path:${JSON.stringify(path)}, migrations:[{version:1,name:'counter',up(db){db.exec('CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)')}}]});
    for(let i=0;i<30;i++) db.transaction(()=>{const value=db.sqlite.prepare('SELECT value FROM counter').get().value; db.sqlite.prepare('UPDATE counter SET value=?').run(value+1)}); db.close();`;
  const results = await Promise.all([child(code), child(code)]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const db = openAppDatabase({ path, migrations: [first] });
  assert.equal(db.sqlite.prepare("SELECT value FROM counter").get()?.value, 60);
  assert.equal(readdirSync(`${path}.backups`).length, 1);
  db.close();
});

test("process termination during migration leaves previous version usable and retry succeeds", async () => {
  const path = fixture();
  const db = openAppDatabase({ path, migrations: [first] }); db.close();
  const result = await child(`import {openAppDatabase} from './packages/daemon/src/app-database.ts'; openAppDatabase({path:${JSON.stringify(path)},migrations:[{version:1,name:'counter',up(){}},{version:2,name:'crash',up(db){db.exec('UPDATE counter SET value=88'); process.exit(17)}}]});`);
  assert.equal(result.code, 17, result.stderr);
  const retry = openAppDatabase({ path, migrations: [first, { version: 2, name: "retry", up(sqlite) { assert.equal(sqlite.prepare("SELECT value FROM counter").get()?.value, 0); sqlite.exec("ALTER TABLE counter ADD COLUMN note TEXT"); } }] });
  assert.equal(retry.sqlite.prepare("PRAGMA user_version").get()?.user_version, 2);
  retry.close();
});
