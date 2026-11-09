# Local store migration and rollback

Stage 1 moves local floors, skills, pending suggestions, the import-mining queue
and its cursor, and OAuth state into `app_records` in the local app database.
Memories and `import-review.md` remain in the vault and are not migrated.

The default database sits beside the legacy local state files as `recall.db`.
Thus the installation uses the platform's bastra data directory. A deliberately
configured `BASTRA_DB_PATH` wins; explicit legacy paths without this override
use a database beside that path, keeping fixtures and separate installations
isolated. The database's local-path checks apply to this adapter too.

The `namespace` plus the absolute former file path identify each record. Its
JSON envelope holds the unchanged serialized state (`text`) and the retained
original's path (`archive`). A null `text` is a deletion tombstone; it prevents
an interrupted migration from reimporting stale state. Existing store decoders
and lifecycle rules still apply. Async read-modify-write operations retain the
same cross-process path lock across their reads and writes.

On the first read of a legacy file, its decoder validates the contents before
any import is accepted. A SQLite writer transaction rechecks whether another
process already imported it, writes a consistent database backup named
`recall.db.import-<uuid>.db`, and commits the state with its archive path. The
legacy file is then renamed to `<original>.pre-db` with owner-only permissions.
It is never deleted. If the process stops after the database commit but before
the rename, the next read finishes the rename without importing the file again.
An existing retained original is never overwritten. Later reads produce no new
import backups. Corrupt or unreadable legacy files stay in place.

## Return to the version before the migration

Stop the new daemon and any CLI writer before rollback; do not run old and new
writers against the same state directory. Keep a copy of `recall.db` and its WAL
and SHM files together. For the pre-migration state, rename each `.pre-db` file
back to its original filename, then start the older binary. This intentionally
returns to the state at the migration, so later database writes are excluded.

To retain changes made after migration, export each current record to a new
file first. The adapter's `exportAppRecord(namespace, legacyPath, destination)`
requires an explicit, absent destination and writes with mode `0600`. The
legacy path argument is the **original** absolute filename, even after rename.
For example, from a built repository while the new daemon is stopped:

```sh
node --input-type=module -e 'import { exportAppRecord } from "./packages/daemon/dist/app-record-store.js"; exportAppRecord("floors", "/local/bastra/floors.json", "/local/bastra/floors.rollback.json")'
```

| Namespace | Original filename |
| --- | --- |
| `floors` | `floors.json` |
| `skills` | `skills.json` |
| `pending-suggestions` | `pending-suggestions.json` (or configured override) |
| `oauth` | `oauth.json` |
| `import-queue` | `import-queue.jsonl` and `import-queue.cursor` |

Export **both** import-queue records before restoring that queue. An `ENOENT`
export means the corresponding state is absent/deleted: leave its original
filename absent, retaining any `.pre-db` file only as a backup. Rename successful
exports to their original names before starting the older binary. Preserve the
DB and `.pre-db` files until the returned version is verified. OAuth records
contain hashes and client metadata, never original bearer or refresh tokens.
