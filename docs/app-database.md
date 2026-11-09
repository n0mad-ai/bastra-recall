# Local app database

The daemon uses built-in `node:sqlite`, WAL, and FTS5. Its default file is
`~/.bastra/recall.db` (`%LOCALAPPDATA%/Bastra/recall.db` on Windows).
`BASTRA_DB_PATH` can select an explicitly local installation or fixture path.
Known cloud-sync paths and symlinks pointing into them are rejected. Operators
must not place the file on other network mounts or sync roots. Memories remain
Markdown in the vault; this database never replaces them.

## API and migrations

`openAppDatabase({path?})` returns a connection with `sqlite`,
`transaction(syncCallback)`, `backup(destination)`, `exportJson(destination)`,
and `close()`. Transactions use `BEGIN IMMEDIATE` and prohibit nested/async
callbacks. Do not start filesystem, network, or asynchronous work inside them.
Each process owns its connection; a ten-second SQLite busy timeout serializes
writers. Hook hot paths should retain in-memory snapshots.
Hooks may pass `busyTimeoutMs: 0` when opening to fail immediately on writer
contention, including during startup migration, and stay within their budget.

Schema versions are contiguous and recorded in `PRAGMA user_version`.
Before **each** migration, the migrator acquires the SQLite writer lock,
rechecks the version, and creates a committed snapshot using a separate
connection with `VACUUM INTO`. This includes WAL data without copying an active
database file. Only after the snapshot is flushed to disk does the migration
run. Schema changes and the version change commit together. Failure or process
termination leaves the previous committed version available; startup retries
the migration. Repeated successful startup does not migrate or back up again.

Backups live beside the database in `recall.db.backups/before-v<VERSION>-<UUID>.db`.
Each is a standalone SQLite file. The database and backups have owner-only
file permissions. Existing backup/export destinations are never overwritten.
JSON export includes schema SQL, version and table rows, for diagnostics and
portable inspection; use the SQLite snapshot for restoration.

The initial schema contains JSON records keyed by `(namespace,key)` and a
rebuildable `app_search` FTS5 index (declared in `app_index_catalog`). Media
files and vectors are not stored as BLOBs. Later migrations can add dedicated
tables without changing the connection API.

## Recovery and downgrade

Stop all processes using the database before restoring it. Preserve the
current `recall.db`, `recall.db-wal`, and `recall.db-shm` by renaming them to
distinct recovery names; never delete them. Copy the required `before-vN`
snapshot to `recall.db` and start a binary supporting that schema version.
Do not leave the old WAL/SHM beside the restored file. A binary rejects a
database whose schema version is newer than it supports.

Store migrations retain their previous JSON files by renaming, not deletion.
To run the previous pre-database binary, stop the daemon and restore each
retained JSON filename before starting it. Those files contain the state at
migration time; export subsequent database changes before downgrading if they
must also be retained. Each store's migration documents its exact suffix.
Stage 0 itself does not import or rename any existing JSON files.

## Tests

Tests always choose temporary fixture paths; calls without an explicit path
under `node --test` also use a temporary database unless `BASTRA_DB_PATH` is
explicitly configured. Never test migrations against the production state
directory. The targeted test covers FTS5/WAL, backup contents, failed and
terminated migrations, repeat startup, two-process migration and updates,
exports, future-version rejection, and cloud-directory symlinks.
