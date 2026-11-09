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

### Hook state (stage 2)

Session bookkeeping, loaded-memory timestamps and the Bash failure throttle
use separate `hook-session:`, `hook-loaded:` and `hook-throttle:` namespaces.
The configured hook-state directory identifies the namespace; explicitly
configured fixture directories use their own `recall.db` unless
`BASTRA_DB_PATH` selects the shared database. Production uses the installation's
single app database.

The first read hydrates an immutable process-local snapshot. Warm reads do no
filesystem or SQLite work. Mutations read the latest committed row inside a
short synchronous transaction, then publish their new snapshot only after
commit. They never hold the lock around recall work. Database contention
returns immediately; a failed gate claim does not deny a tool call. The daemon
owns these hot read snapshots; external process writes become visible after a
restart or a local mutation of that session.

Legacy `<session>.json`, `loaded-<memory>.touch`, and
`fail-throttle-<session>.ts` files are copied to owner-only
`<original>.pre-sqlite.backup` files before import. A consistent database
snapshot is saved as `recall.db.backups/before-hook-state-<UUID>.db` before new
rows are imported. After commit the originals are renamed to
`<original>.pre-sqlite`; an interrupted rename is completed on restart without
overwriting newer database state. Corrupt files and symlinks are left intact.
The original timestamps and 30-second throttle window are preserved.

For a downgrade, stop the daemon, copy each `.pre-sqlite` original back to its
exact former filename in the configured hook-state directory, then start the
older version. Preserve the originals and database for returning to the new
version. The rulebook failure spool remains a stdlib-only offline transport
buffer: clients must be able to record failures while the daemon is unreachable.

## Tests

Tests always choose temporary fixture paths; calls without an explicit path
under `node --test` also use a temporary database unless `BASTRA_DB_PATH` is
explicitly configured. Never test migrations against the production state
directory. The targeted test covers FTS5/WAL, backup contents, failed and
terminated migrations, repeat startup, two-process migration and updates,
exports, future-version rejection, and cloud-directory symlinks.
