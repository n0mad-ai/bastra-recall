# Task and draft database storage

The local app database stores task snapshots in namespace `tasks` and drafts in
`drafts`, `draft-decisions`, and `draft-vectors`. Keys are the absolute former
file paths. The shared adapter uses `BASTRA_DB_PATH` when set; otherwise each
explicit fixture/state directory uses its local `recall.db`. Normal installation
paths share the installation's single app database. Never point an override at a
vault or a sync directory.

## Migration and behavior

Before adopting each legacy file, the adapter creates a consistent database
backup. After the database commit, the original is retained at `<file>.pre-db`.
An interrupted rename is resumed without reimporting the stale source. Repeated
reads create no further migration artifacts. Deletion writes a tombstone, so an
old JSON file cannot silently restore purged state.

The strict local task lock still spans asynchronous preparation, target writes,
and snapshot commits. SQLite transactions themselves remain synchronous. Main
and recovery snapshots are adopted under that same lock before the existing
private-comparison normalization runs. The storage move does not change task
identity, generation, revision, recurrence, lifecycle, delivery acknowledgement,
approval spending, fencing, or receipt semantics. A frozen synthetic schema-v3
snapshot from the pre-database contract at `e1191a2a` is versioned in
`packages/daemon/__tests__/fixtures/tasks-pre-db-e1191a2a.json`; its signatures and
hashes are inert fixture values, not owner credentials.

Task recovery still requires the existing explicit authority checks. It reads
the preceding task snapshot from the `tasks` record keyed by `<path>.backup`,
retains damaged bytes in a private quarantine file, disarms restored tasks, and
changes the recovery epoch. Private comparison keys, owner credentials, signing
registries, recovery markers, and portable archive exports remain local files;
they retain their existing validation and permissions.

Draft document metadata, unknown fields, tombstones, promotion decisions and
the existing model-bound JS vector cache retain their current representation.
The vector cache is JSON text, with no SQLite vector extension. Draft retrieval
continues reading the existing in-memory snapshot. Background refresh watches
the database/WAL and polls as before to notice external commits or purges.
Task runtime watches the database/WAL as well, so an external CLI commit still
wakes its cached projection. Empty or removed reader WALs are ignored, and
opening an already-private database does not rewrite its file permissions.
These rules prevent file watchers from repeatedly waking themselves on reads.

Hook best-effort draft mutations and pending-relay attempts use a zero SQLite
busy timeout in addition to their existing non-queuing path locks. A busy draft
claim is not persisted. Pending hook writes follow their existing background
retry path and acknowledge persistence only after the actual database commit;
busy relay reads neither consume rows nor advance counters. Normal mutations
retain the ordinary database timeout. Legacy imports accept regular local
files through a nonblocking, descriptor-checked read; FIFO overrides are refused.

## Downgrade

Stop all processes using the store first. To return to migration-time data,
preserve any current rollback destination and rename each retained `.pre-db`
file back to its original name, including the task `.backup` and any draft
decision/vector files. Start the pre-database binary only after restoring those
names. Keep the database and its WAL/SHM files for recovery; do not delete them.

To retain changes made since migration, use the shared adapter's
`exportAppRecord(namespace, formerAbsolutePath, newDestination)` while running
the new binary. It creates an exclusive owner-only UTF-8 file. Export both the
task main record and `<path>.backup` when present, and the three draft namespaces
when present. Verify the exported JSON, stop the new binary, retain existing
destinations, and move those exports to the legacy names before starting the
old binary. A purged record reports `ENOENT`; do not restore its stale `.pre-db`
file unless deliberately returning to the earlier state. Preserve private task
keys and archive export directories alongside the snapshots.

All migration tests use isolated synthetic fixtures. Never run them against a
user's real state directory.
