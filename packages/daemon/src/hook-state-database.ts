/** Persistent hook state with immutable, process-local read snapshots.
 * Lanes only mutate through a short SQLite transaction; no vault I/O occurs.
 * Legacy tmpdir files are imported once and retained for downgrade recovery. */
import { lstat, readdir, rename, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { defaultAppDatabasePath, openAppDatabase, type AppDatabase } from "./app-database.js";
import { defaultHookStateDir, legacyHookStateDir, privateDirState, readPrivateFile } from "./private-state-dir.js";

/** Legacy state files are small JSON or empty touch files. */
const MAX_LEGACY_BYTES = 8 * 1024 * 1024;

interface StoredState {
  raw: string;
  at: number;
}
interface HookSnapshot {
  db: AppDatabase;
  sessionsNamespace: string;
  markersNamespace: string;
  throttlesNamespace: string;
  sessions: Map<string, StoredState>;
  markers: Map<string, number>;
  throttles: Map<string, number>;
}
const snapshots = new Map<string, Promise<HookSnapshot>>();

/** The default location and the tmpdir one before it (#1569) are one store. */
function isDefaultDir(dir: string): boolean {
  return resolve(dir) === resolve(defaultHookStateDir()) || resolve(dir) === resolve(legacyHookStateDir());
}

function databasePath(dir: string): string {
  return process.env.BASTRA_DB_PATH || isDefaultDir(dir) ? defaultAppDatabasePath() : join(dir, "recall.db");
}

/** #1569: rows keep the namespace of the location that wrote them first, so a
 * moved default directory still finds every stored session. */
function storeIdentity(dir: string): string {
  return isDefaultDir(dir) ? resolve(legacyHookStateDir()) : resolve(dir);
}

/** Directories legacy state files are imported from: the store's own, and for
 * the default store also the old tmpdir one (only when this account owns it). */
function legacySources(dir: string): string[] {
  return isDefaultDir(dir) ? [...new Set([resolve(dir), resolve(legacyHookStateDir())])] : [dir];
}

async function retainOriginal(file: string): Promise<void> {
  const target = `${file}.pre-sqlite`;
  try {
    // A symlink, FIFO or foreign file in place of either one is never read.
    await readPrivateFile(target, MAX_LEGACY_BYTES);
    // #1584: an original is already retained. Whether a reappearing file (an
    // older binary still writing) matches it or not, both stay untouched and
    // the committed rows win; a difference must not block every later load.
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The rows are already committed; both paths simply stay as they are.
    if (code === "ELOOP" || code === "EUNSAFE") return;
    if (code !== "ENOENT") throw error;
  }
  await rename(file, target);
}

/** The legacy directory sits in a shared tmpdir on Linux. One that another
 * account owns or may write is treated like no legacy state at all. */
async function legacyFileNames(dir: string): Promise<string[]> {
  if ((await privateDirState(dir)) !== "private") return [];
  return readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

/** Every legacy file name with the directory it was found in. */
async function legacyFiles(dir: string): Promise<{ source: string; name: string }[]> {
  const files: { source: string; name: string }[] = [];
  for (const source of legacySources(dir))
    for (const name of await legacyFileNames(source)) files.push({ source, name });
  return files;
}

async function hydrate(dir: string, dbPath: string): Promise<HookSnapshot> {
  const db = openAppDatabase({ path: dbPath, busyTimeoutMs: 0 });
  const suffix = createHash("sha256").update(storeIdentity(dir)).digest("hex");
  const snapshot: HookSnapshot = {
    db,
    sessionsNamespace: `hook-session:${suffix}`,
    markersNamespace: `hook-loaded:${suffix}`,
    throttlesNamespace: `hook-throttle:${suffix}`,
    sessions: new Map(),
    markers: new Map(),
    throttles: new Map(),
  };
  try {
    const files = await legacyFiles(dir);
    const imports: { file: string; bytes: Buffer; namespace: string; key: string; value: StoredState | number }[] = [];
    for (const { source, name } of files) {
      const session = /^([a-zA-Z0-9_-]+)\.json$/.exec(name);
      const marker = /^loaded-([a-zA-Z0-9_.-]+)\.touch$/.exec(name);
      const throttle = /^fail-throttle-([a-zA-Z0-9_-]+)\.ts$/.exec(name);
      if (!session && !marker && !throttle) continue;
      const file = join(source, name);
      // Read and inspect the same descriptor: a path swap cannot import a
      // symlink target or give its contents a different file's timestamp.
      let bytes: Buffer, at: number;
      try {
        ({ bytes, mtimeMs: at } = await readPrivateFile(file, MAX_LEGACY_BYTES));
      } catch (error) {
        if (["ENOENT", "ELOOP", "EUNSAFE"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      if (session) {
        const raw = bytes.toString("utf8");
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || !("shown" in parsed)) continue;
        } catch {
          continue;
        } // Corruption stays untouched for diagnosis.
        imports.push({ file, bytes, namespace: snapshot.sessionsNamespace, key: session[1], value: { raw, at } });
      } else if (marker) {
        imports.push({ file, bytes, namespace: snapshot.markersNamespace, key: marker[1], value: at });
      } else if (throttle) {
        imports.push({ file, bytes, namespace: snapshot.throttlesNamespace, key: throttle[1], value: at });
      }
    }
    if (imports.length) {
      // Keep a byte-for-byte file backup before touching database contents.
      for (const row of imports) {
        try {
          await writeFile(`${row.file}.pre-sqlite.backup`, row.bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const hasNew = imports.some(
        (row) => !db.sqlite.prepare("SELECT 1 FROM app_records WHERE namespace=? AND key=?").get(row.namespace, row.key)
      );
      if (hasNew)
        db.transaction(() => {
          const stillNew = imports.some(
            (row) =>
              !db.sqlite.prepare("SELECT 1 FROM app_records WHERE namespace=? AND key=?").get(row.namespace, row.key)
          );
          if (!stillNew) return;
          db.backup(join(`${db.path}.backups`, `before-hook-state-${randomUUID()}.db`));
          const insert = db.sqlite.prepare("INSERT OR IGNORE INTO app_records(namespace,key,value) VALUES(?,?,?)");
          for (const row of imports) insert.run(row.namespace, row.key, JSON.stringify(row.value));
        });
      // An interrupted post-commit rename is completed on the next hydrate.
      for (const row of imports) await retainOriginal(row.file);
    }
    for (const row of db.sqlite
      .prepare("SELECT namespace,key,value FROM app_records WHERE namespace IN (?,?,?)")
      .all(snapshot.sessionsNamespace, snapshot.markersNamespace, snapshot.throttlesNamespace)) {
      const parsed: unknown = JSON.parse(String(row.value));
      if (row.namespace === snapshot.markersNamespace && typeof parsed === "number")
        snapshot.markers.set(String(row.key), parsed);
      else if (row.namespace === snapshot.throttlesNamespace && typeof parsed === "number")
        snapshot.throttles.set(String(row.key), parsed);
      else if (
        parsed &&
        typeof parsed === "object" &&
        "raw" in parsed &&
        typeof parsed.raw === "string" &&
        "at" in parsed &&
        typeof parsed.at === "number"
      )
        snapshot.sessions.set(String(row.key), { raw: parsed.raw, at: parsed.at });
    }
    return snapshot;
  } catch (error) {
    db.close();
    throw error;
  }
}

function getSnapshot(dir: string): Promise<HookSnapshot> {
  const dbPath = databasePath(dir);
  const key = `${dbPath}\0${storeIdentity(dir)}`;
  let pending = snapshots.get(key);
  if (!pending) {
    pending = hydrate(dir, dbPath);
    snapshots.set(key, pending);
    pending.catch(() => snapshots.delete(key)); // Failed initialization is retryable.
  }
  return pending;
}

export async function readHookState(dir: string, session: string): Promise<string | undefined> {
  return (await getSnapshot(dir)).sessions.get(session)?.raw;
}

/** #1637: no hydration, migrations, imports or cache initialization. SQLite
 * may coordinate readers through its WAL/SHM sidecars; no application rows
 * or schema are written. A missing database is never opened. */
export async function peekHookState(dir: string, session: string): Promise<string | undefined> {
  const dbPath = databasePath(dir);
  const pending = snapshots.get(`${dbPath}\0${storeIdentity(dir)}`);
  if (pending) return (await pending).sessions.get(session)?.raw;
  try {
    if ((await lstat(dbPath)).isFile()) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const suffix = createHash("sha256").update(storeIdentity(dir)).digest("hex");
        const row = db
          .prepare("SELECT value FROM app_records WHERE namespace=? AND key=?")
          .get(`hook-session:${suffix}`, session);
        const stored: unknown = row ? JSON.parse(String(row.value)) : undefined;
        if (stored && typeof stored === "object" && "raw" in stored && typeof stored.raw === "string")
          return stored.raw;
      } finally {
        db.close();
      }
    }
  } catch {
    // Missing, busy or corrupt storage is never repaired by a read.
  }
  return readLegacySession(dir, session);
}

/** Use the same private descriptors and source precedence as migration,
 * reading only this session, without retaining or importing any file. */
async function readLegacySession(dir: string, session: string): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9_-]+$/.test(session)) return undefined;
  for (const source of legacySources(dir)) {
    if ((await privateDirState(source)) !== "private") continue;
    try {
      const { bytes } = await readPrivateFile(join(source, `${session}.json`), MAX_LEGACY_BYTES);
      const raw = bytes.toString("utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "shown" in parsed) return raw;
    } catch {
      // Leave malformed or unsafe legacy files untouched.
    }
  }
  return undefined;
}

/** Read the latest committed state inside the writer transaction; cross-process
 * mutations cannot overwrite each other using an old in-memory read snapshot. */
export async function updateHookState(
  dir: string,
  session: string,
  mutate: (raw: string | undefined) => string
): Promise<void> {
  const snapshot = await getSnapshot(dir);
  const stored = snapshot.db.transaction(() => {
    const row = snapshot.db.sqlite
      .prepare("SELECT value FROM app_records WHERE namespace=? AND key=?")
      .get(snapshot.sessionsNamespace, session);
    const current = row ? (JSON.parse(String(row.value)) as StoredState) : undefined;
    const next = { raw: mutate(current?.raw), at: Date.now() };
    snapshot.db.sqlite
      .prepare(
        "INSERT INTO app_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value"
      )
      .run(snapshot.sessionsNamespace, session, JSON.stringify(next));
    return next;
  });
  snapshot.sessions.set(session, stored); // A failed commit never publishes a claim.
}

export async function listHookStates(dir: string): Promise<readonly [string, string][]> {
  return [...(await getSnapshot(dir)).sessions].map(([key, value]) => [key, value.raw]);
}

export async function writeHookMarker(dir: string, memory: string, throttle = false): Promise<void> {
  const snapshot = await getSnapshot(dir);
  const namespace = throttle ? snapshot.throttlesNamespace : snapshot.markersNamespace;
  const at = Date.now();
  snapshot.db.transaction(() => {
    snapshot.db.sqlite
      .prepare(
        "INSERT INTO app_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value"
      )
      .run(namespace, memory, JSON.stringify(at));
  });
  (throttle ? snapshot.throttles : snapshot.markers).set(memory, at);
}

export async function readHookMarker(dir: string, memory: string, throttle = false): Promise<number | null> {
  const snapshot = await getSnapshot(dir);
  return (throttle ? snapshot.throttles : snapshot.markers).get(memory) ?? null;
}

export async function cleanupHookState(dir: string, maxAgeMs: number): Promise<void> {
  const snapshot = await getSnapshot(dir);
  const cutoff = Date.now() - maxAgeMs;
  const removed = snapshot.db.transaction(() => {
    // Another process may have refreshed a row since this process hydrated its
    // read snapshot. Select and delete only current persisted expired rows.
    const sessions = snapshot.db.sqlite
      .prepare("SELECT key FROM app_records WHERE namespace=? AND json_extract(value,'$.at') < ?")
      .all(snapshot.sessionsNamespace, cutoff)
      .map((row) => String(row.key));
    const expiredNumbers = snapshot.db.sqlite.prepare(
      "SELECT key FROM app_records WHERE namespace=? AND CAST(value AS REAL) < ?"
    );
    const markers = expiredNumbers.all(snapshot.markersNamespace, cutoff).map((row) => String(row.key));
    const throttles = expiredNumbers.all(snapshot.throttlesNamespace, cutoff).map((row) => String(row.key));
    const remove = snapshot.db.sqlite.prepare("DELETE FROM app_records WHERE namespace=? AND key=?");
    for (const key of sessions) remove.run(snapshot.sessionsNamespace, key);
    for (const key of markers) remove.run(snapshot.markersNamespace, key);
    for (const key of throttles) remove.run(snapshot.throttlesNamespace, key);
    return { sessions, markers, throttles };
  });
  for (const key of removed.sessions) snapshot.sessions.delete(key);
  for (const key of removed.markers) snapshot.markers.delete(key);
  for (const key of removed.throttles) snapshot.throttles.delete(key);
}
