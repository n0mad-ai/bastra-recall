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

### Agent chat history (schema v2)

Migration v2 (`agent-chat-history`) adds `chat_conversations` (id, title =
first question cut to 80 characters, created/updated times) and
`chat_messages` (role `user`/`assistant`, text, sources as JSON
`[{id,type,title}]`, time). Deleting a conversation deletes its messages. It
is UI state of the web UI's agent window: nothing is written to the vault, and
retention is unlimited until the user deletes a conversation. `POST /ui/chat`
appends each question, answer and source list; a request without a known
`conversation_id` starts a new conversation. Private memories are never stored
as sources. `GET /ui/chat/conversations` lists conversations,
`GET /ui/chat/conversations/<id>` returns one and
`DELETE /ui/chat/conversations/<id>` removes it. These routes are local-only
like `/ui/chat`; DELETE needs a same-origin request with
`Content-Type: application/json`. A binary that supports only schema v1
refuses this database; restore `before-v2-<UUID>.db` as described above to
downgrade (stored conversations are then lost).

**Save as memory (#1445).** Nothing from a conversation reaches the vault on
its own. Under each answer, also a reopened one, **Save as memory** opens an
editable preview: title (proposed from the answer's heading or the question),
type, area and the full answer as Markdown. Only **Save** writes, through
`POST /ui/save-memory`: the normal `save_memory` path with
`write_origin: user-directed`, so validation, claim gate, audit and the index
apply as for any save. A memory with the same title, or one that already
declares the same situation, is named in the preview and nothing is written.
If a source of the answer is private, the new memory is saved private too.
The route is local-only like `/ui/chat` and needs
`Content-Type: application/json`.

**Deutsch:** Migration v2 (`agent-chat-history`) legt die Tabellen
`chat_conversations` und `chat_messages` an. Darin speichert das
Agentenfenster der Web-UI seine Gespräche: Frage, Antwort und Quellen. Der
Titel ist die erste Frage. In den Vault wird nichts geschrieben. Gespräche
bleiben, bis der Nutzer sie einzeln löscht. Private Memories werden nie als
Quelle gespeichert. Die Routen `GET /ui/chat/conversations`,
`GET /ui/chat/conversations/<id>` und `DELETE /ui/chat/conversations/<id>`
sind nur lokal erreichbar; DELETE verlangt eine Anfrage derselben Herkunft mit
`Content-Type: application/json`. Ein Programm, das nur Schema v1 kennt,
startet mit dieser Datenbank nicht; für den Rückweg `before-v2-<UUID>.db`
wie oben beschrieben zurückspielen (die Gespräche gehen dabei verloren).

**Als Memory speichern (#1445).** Von selbst gelangt aus Gesprächen nichts in
den Vault. Unter jeder Antwort, auch einer wieder geöffneten, öffnet **Als
Memory speichern** eine bearbeitbare Vorschau: Titel (vorgeschlagen aus der
Überschrift der Antwort oder der Frage), Typ, Bereich und die vollständige
Antwort als Markdown. Erst **Speichern** schreibt, über `POST /ui/save-memory`:
den normalen `save_memory`-Weg mit `write_origin: user-directed`. Prüfung,
Claim-Gate, Audit und Index gelten wie bei jedem Speichern. Gibt es schon ein
Memory mit diesem Titel oder eines, das dieselbe Situation abdeckt, nennt die
Vorschau es, und es wird nichts geschrieben. Ist eine Quelle der Antwort
privat, wird auch das neue Memory privat gespeichert. Die Route ist wie
`/ui/chat` nur lokal erreichbar und verlangt `Content-Type: application/json`.

### Telemetry days (schema v3)

Migration v3 (`telemetry-days`, #1438) adds `telemetry_days`: one row per
finished UTC day of the telemetry event log (`~/.bastra/logs/events-<day>.jsonl`).
Columns: `log_dir`, `day` (UTC `YYYY-MM-DD`, primary key with `log_dir`),
`version`, `file_size`, `file_mtime_ms`, `event_count`, `events_json_gz`
(gzip-compressed JSON array of the day's events, cut to the fields the
telemetry report reads) and `computed_at`. `GET /ui/telemetry` reads finished
days from here and only the current UTC day from the log; the report is
identical to reading every log file. A day is read again from its log when
`version` differs from the code's `TELEMETRY_DAY_VERSION` or when the log
file's size or mtime changed (late lines just after midnight, rewrites).
Rows whose log file retention deleted are removed. The table holds no vault
data and can be emptied at any time; it is rebuilt from the logs on the next
request. If the database cannot be opened, the report is computed from the
logs as before. To downgrade, restore `before-v3-<UUID>.db` as described
above; nothing is lost but the cache.

**Deutsch:** Migration v3 (`telemetry-days`, #1438) legt `telemetry_days` an:
je abgeschlossenem UTC-Tag des Telemetrie-Logs eine Zeile mit den
Ereignissen des Tages, beschnitten auf die Felder, die der Bericht liest,
gzip-komprimiert. `GET /ui/telemetry` liest abgeschlossene Tage von hier und
nur den laufenden Tag aus dem Log; das Ergebnis ist dasselbe wie beim Lesen
aller Logdateien. Ein Tag wird neu aus dem Log gelesen, wenn sich die
Auswertungsversion ändert oder die Logdatei nachträglich gewachsen bzw.
geändert ist. Zeilen zu Tagen, deren Logdatei gelöscht wurde, werden
entfernt. Die Tabelle enthält keine Vault-Daten und darf jederzeit geleert
werden. Für den Rückweg `before-v3-<UUID>.db` zurückspielen; verloren geht
dabei nur der Zwischenspeicher.

## Tests

Tests always choose temporary fixture paths; calls without an explicit path
under `node --test` also use a temporary database unless `BASTRA_DB_PATH` is
explicitly configured. Never test migrations against the production state
directory. The targeted test covers FTS5/WAL, backup contents, failed and
terminated migrations, repeat startup, two-process migration and updates,
exports, future-version rejection, and cloud-directory symlinks.
