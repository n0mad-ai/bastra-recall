/** Local state adapters only: never pass a vault path to this module. */
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openAppDatabase, type AppDatabase } from "./app-database.js";

export function appRecordDatabasePath(legacyPath: string): string {
  return resolve(process.env.BASTRA_DB_PATH ?? join(dirname(resolve(legacyPath)), "recall.db"));
}

interface RecordValue { text: string | null; archive?: string; }
type Validate = (text: string) => void;
function assertLocalSource(path: string): void {
  const check = (value: string) => {
    if (/^(?:\\\\|\/\/)/u.test(value) || /(?:^|[\\/])(?:CloudStorage|Google Drive|GoogleDrive[^\\/]*|Dropbox|OneDrive[^\\/]*|Mobile Documents)(?:[\\/]|$)/iu.test(value))
      throw new Error("Local state migration cannot change a sync or vault source");
  };
  check(path);
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  check(realpathSync(ancestor));
  // State files are local regular inputs, never links to a vault artifact.
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Local state migration cannot follow a source symlink");
}
function row(db: AppDatabase, namespace: string, path: string): RecordValue | undefined {
  const entry = db.sqlite.prepare("SELECT value FROM app_records WHERE namespace=? AND key=?").get(namespace, path);
  return entry ? JSON.parse(String(entry.value)) as RecordValue : undefined;
}
function put(db: AppDatabase, namespace: string, path: string, value: RecordValue): void {
  db.sqlite.prepare("INSERT INTO app_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value")
    .run(namespace, path, JSON.stringify(value));
}
function missing(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`No app state at ${path}`), { code: "ENOENT", path });
}
function finishArchive(path: string, value: RecordValue): void {
  if (!value.archive || !existsSync(path)) return;
  assertLocalSource(path);
  // The commit is authoritative after interruption. Never reimport an old file
  // and never overwrite any retained original while completing the rename.
  const destination = existsSync(value.archive) ? `${value.archive}-${randomUUID()}` : value.archive;
  chmodSync(path, 0o600);
  renameSync(path, destination);
}
function importLegacy(db: AppDatabase, namespace: string, path: string, validate?: Validate): RecordValue | undefined {
  return db.transaction(() => {
    const current = row(db, namespace, path);
    if (current) return current;
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    // Corruption/unreadable inputs remain in place; the caller owns its error
    // policy, and can never accidentally complete an empty migration here.
    validate?.(text);
    db.backup(`${db.path}.import-${randomUUID()}.db`);
    const value = { text, archive: `${path}.pre-db` };
    put(db, namespace, path, value);
    return value;
  });
}

/** Throws ENOENT for absent/deleted state, matching readFile's old contract. */
export function readAppRecord(namespace: string, legacyPath: string, validate?: Validate): string {
  const path = resolve(legacyPath);
  assertLocalSource(path);
  const db = openAppDatabase({ path: appRecordDatabasePath(path) });
  try {
    const value = row(db, namespace, path) ?? importLegacy(db, namespace, path, validate);
    if (!value) throw missing(path);
    finishArchive(path, value);
    if (value.text === null) throw missing(path);
    return value.text;
  } finally { db.close(); }
}

/** Caller holds the store's cross-process RMW lock across read and write. */
export function writeAppRecord(namespace: string, legacyPath: string, text: string, validate?: Validate): void {
  const path = resolve(legacyPath);
  assertLocalSource(path);
  const db = openAppDatabase({ path: appRecordDatabasePath(path) });
  try {
    validate?.(text);
    const value = row(db, namespace, path) ?? importLegacy(db, namespace, path, validate);
    if (value) finishArchive(path, value);
    db.transaction(() => put(db, namespace, path, { ...value, text }));
  } finally { db.close(); }
}

/** Durable tombstones prevent an interrupted rename from reviving old state. */
export function deleteAppRecord(namespace: string, legacyPath: string, validate?: Validate): void {
  const path = resolve(legacyPath);
  assertLocalSource(path);
  const db = openAppDatabase({ path: appRecordDatabasePath(path) });
  try {
    const value = row(db, namespace, path) ?? importLegacy(db, namespace, path, validate);
    if (value) finishArchive(path, value);
    db.transaction(() => put(db, namespace, path, { ...value, text: null }));
  } finally { db.close(); }
}

/** Recovery/export for an older binary, including changes made after migration.
 * Explicit destination is required; existing rollback inputs are never replaced.
 */
export function exportAppRecord(namespace: string, legacyPath: string, destination: string): void {
  writeFileSync(destination, readAppRecord(namespace, legacyPath), { encoding: "utf8", flag: "wx", mode: 0o600 });
}
