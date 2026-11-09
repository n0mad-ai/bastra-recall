import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as SQLiteDatabase } from "node:sqlite";
import { bastraDataDir } from "./platform-paths.js";

// Node 22 advertises this built-in module as experimental. Suppress only that
// warning during its initial load, preserving every unrelated warning.
function sqliteConstructor(): typeof SQLiteDatabase {
  const original = process.emitWarning;
  if (process.versions.node.split(".")[0] === "22") {
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
      if (typeof warning === "string" && warning.startsWith("SQLite is an experimental feature")) return;
      Reflect.apply(original, process, [warning, ...args]);
    }) as typeof process.emitWarning;
  }
  try { return createRequire(import.meta.url)("node:sqlite").DatabaseSync; }
  finally { process.emitWarning = original; }
}
const DatabaseSync = sqliteConstructor();

export interface AppMigration {
  version: number;
  name: string;
  /** Synchronous DDL/data updates only. No filesystem writes or async work. */
  up(db: SQLiteDatabase): void;
}

export const APP_MIGRATIONS: readonly AppMigration[] = [{
  version: 1,
  name: "app-storage-foundation",
  up(db) {
    db.exec(`CREATE TABLE app_records (
      namespace TEXT NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL CHECK(json_valid(value)),
      PRIMARY KEY(namespace,key)
    ) STRICT;
    CREATE TABLE app_index_catalog (name TEXT PRIMARY KEY, rebuildable INTEGER NOT NULL CHECK(rebuildable=1)) STRICT;
    CREATE VIRTUAL TABLE app_search USING fts5(namespace UNINDEXED,key UNINDEXED,text);
    INSERT INTO app_index_catalog VALUES('app_search',1);`);
  },
}];

export interface AppDatabaseOptions {
  /** Explicit local path for isolated fixtures or an installation's state root. */
  path?: string;
  migrations?: readonly AppMigration[];
  /** Hooks can choose 0 to fail immediately rather than exceed their budget. */
  busyTimeoutMs?: number;
}

let isolatedTestPath: string | undefined;
export function defaultAppDatabasePath(): string {
  if (process.env.BASTRA_DB_PATH) return process.env.BASTRA_DB_PATH;
  if (process.env.NODE_TEST_CONTEXT) {
    // No implicit test invocation may open the user's production database.
    isolatedTestPath ??= join(tmpdir(), `bastra-app-db-test-${process.pid}-${randomUUID()}`, "recall.db");
    return isolatedTestPath;
  }
  return join(bastraDataDir(), "recall.db");
}

function localPath(path: string): string {
  // Check spelling and physical ancestors, including aliases to sync folders.
  const check = (value: string) => {
    if (/^(?:\\\\|\/\/)/u.test(value) || /(?:^|[\\/])(?:CloudStorage|Google Drive|GoogleDrive[^\\/]*|Dropbox|OneDrive[^\\/]*|Mobile Documents)(?:[\\/]|$)/iu.test(value)) {
      throw new Error("App database and backups must use local storage outside sync folders");
    }
  };
  check(path);
  const absolute = resolve(path);
  let ancestor = absolute;
  while (true) {
    try {
      const entry = lstatSync(ancestor);
      if (entry.isSymbolicLink() && (!existsSync(ancestor) || ancestor === absolute)) {
        throw new Error("App database and backups must use local regular files, not symlink endpoints");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  check(realpathSync(ancestor));
  return absolute;
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function reservePrivateFile(path: string): void {
  const fd = openSync(path, "wx", 0o600);
  closeSync(fd);
}

function schemaVersion(db: SQLiteDatabase): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version);
}

function enableWal(db: SQLiteDatabase, timeout: number): void {
  const deadline = Date.now() + timeout;
  // Concurrent first opens can race the DELETE -> WAL transition; SQLite does
  // not always invoke its busy handler for this PRAGMA. Retry only BUSY/LOCKED,
  // within the same configured budget (hooks with timeout=0 never wait).
  while (true) {
    try { db.exec("PRAGMA journal_mode=WAL"); return; }
    catch (error) {
      const code = (error as { errcode?: number }).errcode;
      const remaining = deadline - Date.now();
      if ((code !== 5 && code !== 6) || remaining <= 0) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, remaining));
    }
  }
}

/** One connection per process; SQLite's writer lock serializes transactions. */
export class AppDatabase {
  readonly sqlite: SQLiteDatabase;
  readonly path: string;
  private inTransaction = false;

  constructor(options: AppDatabaseOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 10000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) throw new Error("Invalid app database busy timeout");
    const migrations = options.migrations ?? APP_MIGRATIONS;
    migrations.forEach((migration, index) => {
      if (migration.version !== index + 1) throw new Error("App migrations must have contiguous versions starting at 1");
      if (migration.up.constructor.name === "AsyncFunction") throw new Error("App migrations must be synchronous");
    });
    this.path = localPath(options.path ?? defaultAppDatabasePath());
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try { reservePrivateFile(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.sqlite = new DatabaseSync(this.path, { allowExtension: false });
    try {
      chmodSync(this.path, 0o600);
      // PRAGMA works on Node 22 too (constructor timeout was added later).
      this.sqlite.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
      enableWal(this.sqlite, busyTimeoutMs);
      this.sqlite.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
      if (schemaVersion(this.sqlite) > migrations.length) throw new Error("App database schema is newer than this version; restore its backup before downgrading");
      for (const migration of migrations) this.migrate(migration);
    } catch (error) { this.sqlite.close(); throw error; }
  }

  private migrate(migration: AppMigration): void {
    if (schemaVersion(this.sqlite) >= migration.version) return;
    this.transaction(() => {
      // Recheck after acquiring the writer lock: another process may have won.
      if (schemaVersion(this.sqlite) >= migration.version) return;
      const directory = `${this.path}.backups`;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.backup(join(directory, `before-v${migration.version}-${randomUUID()}.db`));
      const result: unknown = migration.up(this.sqlite);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") throw new Error("App migrations must be synchronous");
      this.sqlite.exec(`PRAGMA user_version=${migration.version}`);
    });
  }

  transaction<T>(operation: () => T): T {
    if (this.inTransaction) throw new Error("Nested app database transactions are not supported");
    if (operation.constructor.name === "AsyncFunction") throw new Error("App database transactions must be synchronous");
    this.sqlite.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = operation();
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") throw new Error("App database transactions must be synchronous");
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    } finally { this.inTransaction = false; }
  }

  /** Consistent committed snapshot, including WAL. Never overwrites a backup. */
  backup(destination: string): void {
    const target = localPath(destination);
    if (existsSync(target)) throw new Error("Backup destination already exists");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    reservePrivateFile(target);
    // A second connection sees the last committed state while the migration
    // connection holds BEGIN IMMEDIATE. No other writer can race the backup.
    const reader = new DatabaseSync(this.path, { readOnly: true, allowExtension: false });
    try {
      reader.exec("PRAGMA busy_timeout=10000");
      reader.prepare("VACUUM INTO ?").run(target);
      chmodSync(target, 0o600);
      syncFile(target);
    } finally { reader.close(); }
  }

  /** Diagnostic portable snapshot. Schema SQL and rows; no media BLOBs. */
  exportJson(destination: string): void {
    const target = localPath(destination);
    const collect = () => {
      const schema = this.sqlite.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
      const tables: Record<string, unknown[]> = {};
      for (const row of this.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
        const name = String(row.name);
        tables[name] = this.sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
      }
      return { format: "bastra-app-database-v1", schemaVersion: schemaVersion(this.sqlite), schema, tables };
    };
    const snapshot = this.transaction(collect);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // Exclusive creation avoids overwriting a previous recovery artifact.
    writeFileSync(target, `${JSON.stringify(snapshot, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2)}\n`, { flag: "wx", mode: 0o600 });
    syncFile(target);
  }

  close(): void { this.sqlite.close(); }
}

export function openAppDatabase(options: AppDatabaseOptions = {}): AppDatabase {
  return new AppDatabase(options);
}
