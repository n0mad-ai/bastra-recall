import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const mode = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "help-readonly-"));
process.env.HOME = process.env.USERPROFILE = join(root, "home");
delete process.env.BASTRA_DB_PATH;
process.env.BASTRA_LOG_PATH = join(root, "logs");
process.env.BASTRA_HOOK_STATE_DIR = join(root, "hook-state");
process.env.BASTRA_VAULT_PATH = join(root, "vault");
process.env.BASTRA_VAULT_ROOTS_PATH = join(root, "roots.json");
mkdirSync(process.env.HOME);
const { settingsFilePath } = await import("../../src/settings-file.ts");
const path = settingsFilePath();
mkdirSync(dirname(path), { recursive: true });
const database = mode === "override" ? join(root, "override.db") : join(dirname(path), "recall.db");
if (mode === "override") process.env.BASTRA_DB_PATH = database;
let db;
let app;
const databaseMode = ["database", "current", "wal", "override", "tombstone", "old-schema"].includes(mode);
if (databaseMode) {
  if (mode === "current") {
    const { openAppDatabase } = await import("../../src/app-database.ts");
    app = openAppDatabase({ path: database });
    db = app.sqlite;
  } else db = new DatabaseSync(database);
  if (mode === "wal") db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  if (mode !== "old-schema") {
    if (mode !== "current") db.exec("CREATE TABLE app_records(namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key)); PRAGMA user_version=1");
    db.prepare("INSERT INTO app_records VALUES(?,?,?)").run(
      "settings", path, JSON.stringify({ text: mode === "tombstone" ? null : JSON.stringify({ language: { primary: "de" } }), archive: path + ".pre-db" })
    );
  }
  // A stale source must neither override the committed row nor be archived by help.
  writeFileSync(path, JSON.stringify({ language: { primary: mode === "old-schema" ? "de" : "en" } }));
} else if (mode === "corrupt-db") {
  writeFileSync(database, "invalid database");
  writeFileSync(path, JSON.stringify({ language: { primary: "de" } }));
} else if (mode !== "missing") {
  writeFileSync(path, mode === "corrupt" ? "{invalid" : JSON.stringify({ language: { primary: "de" } }));
}
function snapshot(dir) {
  const entries = {};
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    // SQLite may update reader coordination in SHM; this is not business state.
    if (name.endsWith("-shm")) continue;
    entries[name] = lstatSync(p).isDirectory() ? snapshot(p) : createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return entries;
}
const logical = () => db ? {
  schema: db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all(),
  version: db.prepare("PRAGMA user_version").get(),
  records: mode === "old-schema" ? [] : db.prepare("SELECT * FROM app_records ORDER BY namespace,key").all(),
} : null;
try {
  const before = snapshot(root), rows = logical();
  const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "tasks", "--help"], {
    env: process.env, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const german = ["legacy", "database", "current", "wal", "override", "old-schema"].includes(mode);
  assert.match(result.stdout, german ? /\nMehr: bastra help\n$/ : /\nMore: bastra help\n$/);
  assert.deepEqual(logical(), rows, "help changed application schema/rows");
  assert.deepEqual(snapshot(root), before, "help changed files beyond SQLite reader coordination");
  console.log(`${mode}: application state unchanged`);
} finally {
  if (app) app.close();
  else db?.close();
  rmSync(root, { recursive: true, force: true });
}
