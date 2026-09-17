# Architecture / Architektur

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

### Goal

Bastra.Recall is a local-first memory layer for AI assistants. It gives Claude Code, Claude Desktop, Codex, ChatGPT Desktop, Cursor and other MCP/HTTP clients (see the [support matrix](../README.md#supported-surfaces); packaged ChatGPT Actions remain planned) one shared vault of durable lessons, preferences, project facts, decisions, workflows, bookmarks, and document sidecars.

The operating goal is simple: the user should not have to re-explain stable context. The assistant saves durable memories when a lesson or rule is learned, and recalls relevant memories before acting.

### Current Runtime Shape

```text
Markdown vault
  - recursive .md scan
  - YAML frontmatter + markdown body
  - Obsidian-compatible wikilinks
          |
          | Vault loader + chokidar watcher
          v
bastra-recall daemon (Node 22+, TypeScript)
  - in-memory MiniSearch BM25 index
  - optional in-memory EmbeddingIndex persisted at <vault>/.bastra/embeddings.json
  - optional Auto-Related enrichment via embedding similarity
  - local telemetry JSONL
  - HTTP REST on 127.0.0.1:6723
  - stdio MCP server
          |
          +--> direct stdio MCP clients
          |
          +--> mcp-forwarder stdio wrappers
          |      - auto-spawn or reuse one shared daemon
          |      - proxy MCP tool calls to HTTP REST
          |
          +--> hooks and non-MCP clients over HTTP
```

The vault is the source of truth. Search indexes, embedding vectors, telemetry, audit logs, and trash files are derived/runtime data under `.bastra/` or the user log directory.

### Vault Layer

`Vault` recursively scans the configured root from `BASTRA_VAULT_PATH` (legacy `NEXUS_VAULT_PATH` is still accepted). It loads only markdown files with a recognized `type` frontmatter value and silently ignores ordinary Obsidian notes.

Current write routing from `saveMemory`:

| Memory kind | Folder |
|---|---|
| `type: bookmark` | `bookmarks/` |
| `type: doc` | `dokumentationen/<scope>/` |
| `scope: user-preference` | `memories/user/` |
| `scope: all-projects` | `memories/all-projects/` |
| other scopes | `memories/projects/<scope>/` |

The scanner is recursive, so older flat vaults and hand-organized Obsidian folders continue to work.

#### Write commit contract

`saveMemory` builds a complete temporary file and commits under a vault-wide claim on the memory **id**. The id—not the destination path—is the concurrency boundary, so two writers that want the same id in two explicitly different folders are two contenders for one place, not two independent writes. The invariant the claim carries is **one ID, one file, one transactional writer** (`packages/core/src/id-transaction.ts`).

Every commit has these invariants:

1. The target is read before the candidate is built. Only `ENOENT` means free; permission, device, and cloud-mount read failures abort the save.
2. The writer acquires `<vault>/.bastra/locks/<sha256(id)>.bastra-write.lock` with exclusive-create semantics — one lock per id for the whole vault, not one per destination path. A second `saveMemory` writer for that id, including one in another process, receives `MemoryWriteConflictError` with code `BASTRA_WRITE_CONFLICT`.
3. Under that claim, the writer re-reads the target and compares the exact bytes with the first read. A change aborts the commit.
4. A create hard-links the completed temporary inode into the free destination, so it cannot replace a target that appeared late. An overwrite renames the complete temporary file atomically.
5. Normal success and handled conflicts remove the writer's temporary and lock files. A process killed while it owns the claim can leave the lock behind; the destination is still either the complete old file or the complete committed file, never a partial write. Verify that no writer is active before removing such a stale lock.

The optional third argument joins a caller-side ownership decision to that commit:

```ts
await saveMemory(vaultRoot, input, {
  // null means "I proved the destination was absent";
  // a string is the exact raw file content I approved.
  expectedTarget,
});
```

Omitting `expectedTarget` preserves the ordinary save API. Passing it makes the call compare-and-swap: if the destination no longer matches, the writer reports a conflict before publishing. `importVault` passes the raw target returned by its final provenance check, closing the previous ownership-check → rename window (#245, #285).

The id claim is the cooperation boundary: every project write path that goes through the id transaction participates, across Node processes. A program that edits the markdown file directly does not acquire this claim. Creates still cannot clobber such an external late writer because their final publication is no-replace; portable Node filesystem APIs do not provide an atomic content-CAS replacement for the overwrite case.

The regression matrix covers:

| Case | Required result |
|---|---|
| two creates, same free path and expected `null` | exactly one commit; one conflict |
| two overwrites, same path and preimage | exactly one patch; one conflict |
| two overlapping ordinary overwrites, no caller precondition | exactly one commit while their commit intervals overlap |
| target appears after caller proved it free | newcomer preserved; conflict |
| target bytes change after caller approved them | changed file preserved; conflict |
| commit claim already held | target and existing claim untouched; conflict |
| writers in separate Node processes | exactly one commit for one preimage |
| sequential overwrites | both succeed; ordinary update behavior unchanged |
| different ids in one folder | both commit independently |
| same id in different folders | exactly one commit; the loser conflicts and leaves no file behind |
| target inspection fails with non-`ENOENT` | fail closed before temp/lock creation |
| success or handled conflict | no owned temp/lock artifact remains |
| winning overwrite is a patch | omitted frontmatter, including sensitivity, survives |

The watcher uses `chokidar`. On paths that look like cloud-storage mounts (`CloudStorage`, `Dropbox`, `iCloud`), it switches to polling because native file events are unreliable there. Write paths call `vault.reindexFile(...)` after known writes so a save and a recall in the same turn stay consistent.

A memory's **id survives** the engine's lifecycle operations: demote changes score only, soft-delete moves the file to append-only `.bastra/trash/` (recoverable), and only a hard delete removes a cell. This is the substrate guarantee the pin/floor lifecycle and any citation layer build on — pinned by a CI regression test. Details: [survival.md](./survival.md).

The audited daemon write paths append to `<vault>/.bastra/audit-log.ndjson` (#206): `save_memory`, `edit_memory` (#519), `save_product_doc` and `archive_memory`, alongside the Mac-app bridge that already used it. The opt-in document mutation tools (`save_document`, `recategorize_document`, `move_document`) are **not** audited yet — tracked in [#452](https://github.com/n0mad-ai/bastra-recall/issues/452). Each entry carries the memory id, the operation, the actor and the surface (`mcp:save_memory`, `mcp:edit_memory`, `mcp:archive_memory`, …), the frontmatter before and after, the file path, and the daemon run id, so an entry can be correlated with the telemetry of the same run. Telemetry is not a substitute: it can be switched off and is pruned after 90 days, while this log is append-only and permanent. Recording is best-effort by design (`packages/daemon/src/audit-trail.ts`) — a write that already landed is never failed because its trail could not be written. The MCP path records directly rather than through `auditedSave`, because that wrapper requires a `reason` for assistant mutations and the tool schema has no reason field; a missing reason is honest, a generated one would be noise dressed as provenance.

### Search And Recall

The current index is in-memory MiniSearch BM25, not SQLite/FTS5. The searched fields are:

- `recall_when` with the highest boost
- `title`
- `tags`
- `topic_path`
- `summary`
- markdown body

`recall(query, opts)` returns direct BM25 hits filtered by:

- `obsolete !== true`
- optional exact `scope`
- optional exact `type`
- `sensitivity !== private` unless the call arrives over a trusted local transport (#464)

It then applies staleness reranking based on lifecycle fields such as `valid_until`, `expires_after_days`, and `last_reviewed_at`.

#### Hybrid Recall

Embeddings are an optional, configurable second pass; BM25 keyword search is the default. The provider is resolved in one shared place (`resolveEmbeddingChoice` in `packages/daemon/src/settings.ts`, used by the daemon, the bridge, and the CLI) with the precedence env > cli-settings > none:

| Source | Value | Behavior |
|---|---|---|
| env `BASTRA_EMBEDDING_PROVIDER` | `none` / `ollama` / `openai` | always wins over the settings file |
| `~/.bastra/cli-settings.json` `embedding.provider` | `none` / `ollama` / `openai` | written by `bastra embeddings on\|off` (or the `bastra install` end prompt); used when no env is set |
| unset + API key (`OPENAI_API_KEY` / `BASTRA_EMBEDDING_KEY`) | — | **BM25 only** — a generic credential is not consent (#520) |
| unset + no API key | — | BM25 only |

`ollama` uses local Ollama `/v1/embeddings` and keeps every text on the machine. `openai` is the one mode that sends data off-device: recall queries and the memory text being indexed are POSTed to `api.openai.com`. It therefore requires an **explicit** Bastra decision — `BASTRA_EMBEDDING_PROVIDER=openai` or `bastra config set embedding.provider openai` — plus an API key. Until #520 a bare `OPENAI_API_KEY` in the environment selected it on its own, which meant a key exported for an unrelated tool could ship the whole backfill corpus to OpenAI without any Bastra-specific opt-in; the resolver now stops at `none` in that case and the daemon, `bastra embeddings status` and `bastra doctor` print a migration line explaining how to opt in on purpose. The OpenAI provider is built in exactly one place (`cloudEmbeddingProvider`, `packages/daemon/src/embedding-cloud.ts`), so that gate cannot be bypassed by a second call site.

`bastra embeddings status` shows the effective provider, which source decided it, and whether that provider keeps text on-device.

The Ollama endpoint (`BASTRA_OLLAMA_URL`, default `http://localhost:11434`) is egress-guarded: a non-loopback host is refused unless `BASTRA_ALLOW_REMOTE_OLLAMA=1` is set explicitly, so a mistyped or injected URL can never send memory text off-box. The guard (`assertLocalOrOptIn`, `packages/core/src/ollama-egress.ts`) covers **both** callers — the embedding provider (query + memory text) and the reranker (candidate text) — so the "no cloud, no egress, stays on the machine" property holds outbound as well as for the loopback-only inbound server.

The Commons target (`BASTRA_COMMONS_REPO`) is guarded the same way (#260): `commonsRepoRefusal` (`packages/daemon/src/cli/commons.ts`) accepts only `github.com/n0mad-ai/…` unless `BASTRA_ALLOW_REMOTE_COMMONS=1` is set, and it fails **closed** — a local path or an unparseable value is refused rather than passed through, because git would clone it happily. The gate sits before the clone and before the `git push` of a verification record, not only before `gh pr create`, since the push is already the egress.

When an `EmbeddingIndex` is attached, `recallHybrid(...)` combines BM25 and vector rankings with Reciprocal Rank Fusion. Vectors are stored as base64-encoded floats in `<vault>/.bastra/embeddings.json`.

On the hybrid path the returned `score` is a **rank quantity, not a similarity** (#230). `fuseRRF` (`packages/core/src/embeddings.ts`) sums `1/(RRF_K + rank)` across the two arms and `recallHybrid` scales the result by `RRF_SCALE` into a BM25-looking range. `RRF_K` is 5; it was 60 (the TREC default) until that constant was measured against pools of 5–50, where it weighted arm agreement above rank. `RRF_SCALE` is tied to `RRF_K` so the two anchors below do not move with it. Every score therefore decomposes into a rank pair: rank 1 in both arms is the structural ceiling `2 × 5000/61 ≈ 163.934`, and rank 1 in a single arm (the arms fully disagree) is `5000/61 ≈ 81.967` — so a top hit can legitimately sit near 82. A top hit is high *by construction*: a list always has a first element even when the honest answer is "nothing here", so a nonsense query can still carry a 130+ score. Two consequences:

- The documented `min_score` floor (default 30) is very hard to reach on the hybrid path: a hit needs roughly rank 28 in **both** arms to fall below it (it was rank 273 at the old `RRF_K = 60`). The floor is mainly meaningful in BM25-only mode (no embeddings), where the score is a genuine BM25 quantity. Note that the band boundaries move with `RRF_K` even though the anchors do not — the cuts are absolute and the curve between the anchors is not, so a telemetry series over `band` is not comparable across a change to that constant.
- `recall` returns a top-level `weak_result: true` when, on the hybrid path, no returned hit has a `recall_when` or title match — an explicit "nothing here" signal riding alongside the rank-1-of-nothing score. It is informational and filters nothing. With `verbosity: "full"` each hit also carries `rrf: { rank_bm25, rank_vector, raw }` so callers can see the rank pair the score is built from.

**The ceiling is not one number, so the response names its arms.** `163.934` is the ceiling of the *two personal arms*. When the Bastra Commons are active they fuse in as a **third arm** (`commons-fusion.ts`), and the ceiling rises to `163.934 + 0.95 × 81.967 ≈ 241.803`; on the degraded collapse path (personal arm unfused, only its list rank enters) it is `147.541` instead. All three call themselves `score_kind: "rrf"`, so `score_kind` alone does not make two numbers comparable. Every response therefore carries `score_arms` (sorted: `["bm25","vector"]`, `["bm25","commons","vector"]`, `["commons","personal-rank"]`) and `score_version` — the formula version, to be bumped whenever the same arm set starts producing a different number. **Compare scores only within an identical `score_version`/`score_arms` pair; across them, re-fuse by RANK.** Batch recall does exactly that: sub-results with differing signatures are merged via `query-rank-fusion` and the response drops back to `unfused`, because a band that means one thing in one list and another in the next is not a band. With `verbosity: "full"` a hit that the commons contributed to additionally carries `rrf: { rank_commons, commons_weight, personal_score }` — `personal_score` is what the same recall would have served without them.

#### Multi-Hop Recall

If `expand_hops: 1` is passed, recall adds one-hop neighbors from `frontmatter.related_via`. Those neighbors are filtered with the same obsolete/scope/type/sensitivity rules and receive a reduced score.

`RelatedEnricher` can maintain `related_via` automatically after embedding batches. It also appends an auto-managed Obsidian wikilink section to the memory body, bounded by marker comments so manual links and automatic links stay separate.

### Daemon And Transports

The main daemon is `packages/daemon/src/index.ts`.

It starts:

- one `Vault`
- one `SearchIndex`
- optional `EmbeddingIndex`
- optional `RelatedEnricher`
- one `Telemetry` instance
- HTTP REST server on `127.0.0.1:6723` by default
- stdio MCP server in the same process

HTTP can be disabled with `BASTRA_HTTP=off`. The endpoint is resolved in exactly one place since #531 (`packages/daemon/src/daemon-endpoint.ts`), and every surface that binds, probes, names or persists it reads that resolver: `BASTRA_DAEMON_URL` → `BASTRA_HTTP_URL` → `BASTRA_HTTP_PORT` → loopback on `6723` (legacy `NEXUS_*` names are accepted alongside each).

#### MCP Forwarder

`bastra-recall-mcp` is a thin stdio MCP wrapper. It does not load the vault or hold an index. It:

1. probes `GET /health` on `BASTRA_DAEMON_URL` (default `http://127.0.0.1:6723`);
2. auto-spawns the daemon unless `BASTRA_FORWARDER_SPAWN=0`;
3. exposes MCP tools over stdio;
4. proxies each tool call to `/api/v1/<tool>`.

This lets multiple MCP clients share a single daemon, index, embedding queue, and telemetry stream.

### Tools

Core memory tools:

| Tool | Purpose |
|---|---|
| `recall` | Search memories by action context or natural-language query |
| `load_memory` | Load full frontmatter and body by id |
| `save_memory` | Write a new or overwritten memory markdown file and force reindex |
| `edit_memory` | Patch one existing memory — `str_replace`, `append` and/or a frontmatter patch, through the same save path; `expected_revision` is the optimistic-concurrency precondition (#519) |

Document read tools:

| Tool | Purpose |
|---|---|
| `find_document` | Search `type: doc` sidecars |
| `read_document` | Load document sidecar metadata and extracted body |
| `open_document` | macOS-only open of the original file or sidecar |

Document write tools are gated by `BASTRA_DOCUMENT_WRITE=1`:

| Tool | Purpose |
|---|---|
| `save_document` | Copy or link an original file and write a retrievable sidecar |
| `recategorize_document` | Update title, tags, category, or folder metadata |
| `move_document` | Move sidecar and original file to another document folder |

The direct daemon only lists document write tools when the env flag is enabled. The forwarder may list them and let the daemon return the gate error on call.

### HTTP REST

The HTTP server binds to loopback only. Main endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | `GET` | daemon health, version, vault size |
| `/hook/recall` | `POST` | Claude Code PreToolUse hook recall path |
| `/api/v1/recall` | `POST` | REST wrapper for `recall` |
| `/api/v1/load_memory` | `POST` | REST wrapper for `load_memory` |
| `/api/v1/save_memory` | `POST` | REST wrapper for `save_memory` |
| `/api/v1/edit_memory` | `POST` | REST wrapper for `edit_memory` |
| `/api/v1/find_document` | `POST` | REST wrapper for `find_document` |
| `/api/v1/read_document` | `POST` | REST wrapper for `read_document` |
| `/api/v1/open_document` | `POST` | REST wrapper for `open_document` |
| `/api/v1/save_document` | `POST` | gated document write |
| `/api/v1/recategorize_document` | `POST` | gated document write |
| `/api/v1/move_document` | `POST` | gated document write |

`/api/v1/*` requires `Authorization: Bearer <token>` for everything that is not a direct local caller — including when no token is configured at all, where the answer is a `401` that no bearer can satisfy until one is minted (#526; the tokenless dev mode is the direct-local exemption, never a global open door). Direct local callers bypass auth by default — the exemption needs a loopback peer socket **and** a present, loopback `Host` header, so neither a DNS-rebound page nor a local tunnel — including a raw port-forwarder whose caller simply omits the header — inherits it from the socket (#526). Set `BASTRA_AUTH_LOOPBACK_SKIP=0` to require the token even locally.

CORS is deny-by-default: no browser origin is allowed until `BASTRA_CORS_ORIGIN` lists it (comma-separated). `BASTRA_CORS_ORIGIN=*` is an explicit permissive opt-in for tunnel/dev setups. When the calling site is served over HTTPS (public origin → localhost daemon), Chrome's Private Network Access preflight is answered automatically with `Access-Control-Allow-Private-Network: true` for allowed origins.

### Hooks

Claude Code hooks call the loopback daemon and are designed to fail open so they do not block the assistant.

Current live hook binaries:

| Binary | Event | Purpose |
|---|---|---|
| `bastra-recall-hook` | `PreToolUse` | detect file/content topics before Write/Edit/MultiEdit/NotebookEdit and inject recall hints |
| `bastra-recall-session-hook` | `SessionStart` | preload user preferences, cross-project rules, and project memories at startup/resume/clear/compact |

Topic detection is deterministic and based on file extension, path segments, and content patterns. The hook sends a bounded natural-language query to `/hook/recall`.

### Privacy And Safety

Storage and keyword search run locally. MCP results and hook context are handed to the connected AI client; a cloud-backed client may send that context to its provider. Explicitly configured remote embeddings, REST exposure and vault-folder synchronization add separate data paths. The [privacy overview](./PRIVACY.md) covers these boundaries and metadata-only network features; the transport-level controls below apply to Bastra's own API.

- The daemon binds to `127.0.0.1`.
- The vault is plain local markdown.
- `sensitivity: private` memories are hidden from external MCP/REST callers. Since #464 the permission is transport-bound (`private-access.ts`): it is not a tool argument, so no request body can grant it to itself. The local app's bridge (`bridge.ts`) is the trusted transport.
- `load_memory` also enforces the sensitivity filter, so direct id enumeration cannot load private memories.
- The same gate covers every mutation of a hidden record — `save_memory(overwrite)`, `edit_memory`, `archive_memory`, `save_document(overwrite)`, `recategorize_document`, `move_document`. All of them answer exactly like an unknown id, so a refused write is not an existence oracle either.
- Telemetry is local JSONL and can be disabled with `BASTRA_TELEMETRY=off`.
- Save/delete/restore operations used by the Mac-app bridge can be recorded in `<vault>/.bastra/audit-log.ndjson`.
- Soft deletes move files to `<vault>/.bastra/trash/`.

### Stack Summary

| Layer | Current choice |
|---|---|
| Runtime | Node 22+, TypeScript, ESM |
| MCP | `@modelcontextprotocol/sdk` |
| Search | MiniSearch BM25 in memory |
| Embeddings | Optional local Ollama provider, or OpenAI after an explicit opt-in; in-memory vectors with JSON persistence |
| Vault parsing | `gray-matter` + Zod frontmatter schema |
| File watching | `chokidar` with polling on cloud mounts |
| HTTP | Node `http` server |
| CLI/install adapters | Claude Code, Claude Desktop, Codex/ChatGPT Desktop, Cursor |

### Historical Note

Early design docs described a SQLite/FTS5 index and HTTP MCP on port `7891`. That is not the current implementation. The current code uses MiniSearch/BM25, optional embeddings, REST on `127.0.0.1:6723`, and MCP stdio/forwarder transports.

<a id="deutsch"></a>

## Deutsch

### Ziel

Bastra.Recall ist eine lokal ausgerichtete Gedächtnisschicht für KI-Assistenten. Sie gibt Claude Code, Claude Desktop, Codex, ChatGPT Desktop, Cursor und anderen MCP-/HTTP-Clients (siehe die [Support-Matrix](../README.md#unterstützte-oberflächen); paketierte ChatGPT Actions sind weiterhin geplant) einen gemeinsamen Vault mit dauerhaften Lessons, Präferenzen, Projektfakten, Entscheidungen, Workflows, Lesezeichen und Dokument-Sidecars.

Das Betriebsziel ist einfach: Der Nutzer soll stabilen Kontext nicht erneut erklären müssen. Der Assistent speichert dauerhafte Erinnerungen, wenn eine Lesson oder Regel gelernt wurde, und ruft relevante Erinnerungen ab, bevor er handelt.

### Aktuelle Laufzeitstruktur

```text
Markdown vault
  - recursive .md scan
  - YAML frontmatter + markdown body
  - Obsidian-compatible wikilinks
          |
          | Vault loader + chokidar watcher
          v
bastra-recall daemon (Node 22+, TypeScript)
  - in-memory MiniSearch BM25 index
  - optional in-memory EmbeddingIndex persisted at <vault>/.bastra/embeddings.json
  - optional Auto-Related enrichment via embedding similarity
  - local telemetry JSONL
  - HTTP REST on 127.0.0.1:6723
  - stdio MCP server
          |
          +--> direct stdio MCP clients
          |
          +--> mcp-forwarder stdio wrappers
          |      - auto-spawn or reuse one shared daemon
          |      - proxy MCP tool calls to HTTP REST
          |
          +--> hooks and non-MCP clients over HTTP
```

Der Vault ist die maßgebliche Quelle. Suchindizes, Embedding-Vektoren, Telemetrie, Audit-Logs und Papierkorb-Dateien sind abgeleitete bzw. Laufzeitdaten unter `.bastra/` oder im Log-Verzeichnis des Nutzers.

### Vault-Schicht

`Vault` durchsucht rekursiv das konfigurierte Wurzelverzeichnis aus `BASTRA_VAULT_PATH` (das alte `NEXUS_VAULT_PATH` wird weiterhin akzeptiert). Es lädt nur Markdown-Dateien mit einem bekannten `type`-Wert im Frontmatter und ignoriert gewöhnliche Obsidian-Notizen stillschweigend.

Aktuelle Schreib-Zuordnung von `saveMemory`:

| Art der Erinnerung | Ordner |
|---|---|
| `type: bookmark` | `bookmarks/` |
| `type: doc` | `dokumentationen/<scope>/` |
| `scope: user-preference` | `memories/user/` |
| `scope: all-projects` | `memories/all-projects/` |
| andere Scopes | `memories/projects/<scope>/` |

Der Scanner arbeitet rekursiv, daher funktionieren ältere flache Vaults und von Hand organisierte Obsidian-Ordner weiterhin.

#### Commit-Vertrag beim Schreiben

`saveMemory` baut eine vollständige temporäre Datei und committet unter einem vault-weiten Claim auf die **ID** der Erinnerung. Die ID – nicht der Zielpfad – ist die Nebenläufigkeitsgrenze. Zwei Schreiber, die dieselbe ID in zwei ausdrücklich verschiedenen Ordnern wollen, konkurrieren also um einen Platz; es sind keine zwei unabhängigen Schreibvorgänge. Die Invariante, die der Claim trägt, lautet **eine ID, eine Datei, ein transaktionaler Schreiber** (`packages/core/src/id-transaction.ts`).

Jeder Commit hat diese Invarianten:

1. Das Ziel wird gelesen, bevor der Kandidat gebaut wird. Nur `ENOENT` bedeutet frei; Lesefehler wegen Berechtigungen, Geräten oder Cloud-Mounts brechen das Speichern ab.
2. Der Schreiber erwirbt `<vault>/.bastra/locks/<sha256(id)>.bastra-write.lock` mit Exclusive-Create-Semantik – ein Lock pro ID für den ganzen Vault, nicht einer pro Zielpfad. Ein zweiter `saveMemory`-Schreiber für diese ID, auch in einem anderen Prozess, erhält `MemoryWriteConflictError` mit dem Code `BASTRA_WRITE_CONFLICT`.
3. Unter diesem Claim liest der Schreiber das Ziel erneut und vergleicht die exakten Bytes mit dem ersten Lesen. Eine Änderung bricht den Commit ab.
4. Ein Create legt einen Hardlink vom fertigen temporären Inode auf das freie Ziel an und kann daher kein spät aufgetauchtes Ziel ersetzen. Ein Overwrite benennt die vollständige temporäre Datei atomar um.
5. Normaler Erfolg und behandelte Konflikte entfernen die temporären Dateien und Lock-Dateien des Schreibers. Ein Prozess, der beendet wird, während er den Claim hält, kann den Lock zurücklassen; das Ziel ist trotzdem entweder die vollständige alte Datei oder die vollständige committete Datei, nie ein halber Schreibvorgang. Prüfe, dass kein Schreiber aktiv ist, bevor du einen solchen verwaisten Lock entfernst.

Das optionale dritte Argument verbindet eine Eigentums-Entscheidung des Aufrufers mit diesem Commit:

```ts
await saveMemory(vaultRoot, input, {
  // null means "I proved the destination was absent";
  // a string is the exact raw file content I approved.
  expectedTarget,
});
```

Ohne `expectedTarget` bleibt die gewöhnliche Speicher-API erhalten. Mit dem Argument wird der Aufruf zu einem Compare-and-Swap: Passt das Ziel nicht mehr, meldet der Schreiber vor dem Veröffentlichen einen Konflikt. `importVault` übergibt das rohe Ziel aus seiner abschließenden Herkunftsprüfung und schließt damit das bisherige Zeitfenster zwischen Eigentumsprüfung und Umbenennung (#245, #285).

Der ID-Claim ist die Kooperationsgrenze: Jeder Schreibpfad des Projekts, der über die ID-Transaktion läuft, nimmt teil, auch über Node-Prozesse hinweg. Ein Programm, das die Markdown-Datei direkt bearbeitet, erwirbt diesen Claim nicht. Creates können einen solchen externen späten Schreiber trotzdem nicht überschreiben, weil ihre abschließende Veröffentlichung nichts ersetzt; portable Node-Dateisystem-APIs bieten für den Overwrite-Fall keinen atomaren Ersatz mit Inhalts-CAS.

Die Regressionsmatrix deckt ab:

| Fall | Erforderliches Ergebnis |
|---|---|
| zwei Creates, gleicher freier Pfad und erwartetes `null` | genau ein Commit; ein Konflikt |
| zwei Overwrites, gleicher Pfad und gleiches Vorabbild | genau ein Patch; ein Konflikt |
| zwei überlappende gewöhnliche Overwrites ohne Vorbedingung des Aufrufers | genau ein Commit, solange sich ihre Commit-Intervalle überlappen |
| Ziel taucht auf, nachdem der Aufrufer es als frei nachgewiesen hat | Neuankömmling bleibt erhalten; Konflikt |
| Bytes des Ziels ändern sich, nachdem der Aufrufer sie freigegeben hat | geänderte Datei bleibt erhalten; Konflikt |
| Commit-Claim ist bereits vergeben | Ziel und bestehender Claim unverändert; Konflikt |
| Schreiber in getrennten Node-Prozessen | genau ein Commit für ein Vorabbild |
| aufeinanderfolgende Overwrites | beide erfolgreich; gewöhnliches Update-Verhalten unverändert |
| verschiedene IDs in einem Ordner | beide committen unabhängig |
| gleiche ID in verschiedenen Ordnern | genau ein Commit; der Verlierer bekommt einen Konflikt und hinterlässt keine Datei |
| Prüfung des Ziels scheitert mit einem Fehler außer `ENOENT` | sicherer Abbruch vor Anlegen von Temp-Datei/Lock |
| Erfolg oder behandelter Konflikt | keine eigene Temp-/Lock-Datei bleibt zurück |
| gewinnender Overwrite ist ein Patch | weggelassenes Frontmatter, einschließlich sensitivity, bleibt erhalten |

Der Watcher nutzt `chokidar`. Auf Pfaden, die nach Cloud-Speicher-Mounts aussehen (`CloudStorage`, `Dropbox`, `iCloud`), wechselt er auf Polling, weil native Dateiereignisse dort unzuverlässig sind. Schreibpfade rufen nach bekannten Schreibvorgängen `vault.reindexFile(...)` auf, damit Speichern und Abrufen im selben Zug konsistent bleiben.

Die **ID einer Erinnerung überlebt** die Lebenszyklus-Operationen der Engine: Demote ändert nur den Score, Soft-Delete verschiebt die Datei in das nur anhängbare `.bastra/trash/` (wiederherstellbar), und nur ein Hard-Delete entfernt eine Zelle. Das ist die Grundgarantie, auf der der Pin/Floor-Lebenszyklus und jede Zitierschicht aufbauen – abgesichert durch einen CI-Regressionstest. Details: [survival.md](./survival.md).

Die auditierten Schreibpfade des Daemons hängen an `<vault>/.bastra/audit-log.ndjson` an (#206): `save_memory`, `edit_memory` (#519), `save_product_doc` und `archive_memory`, zusätzlich zur Mac-App-Bridge, die das Log bereits nutzte. Die optionalen Dokument-Schreibwerkzeuge (`save_document`, `recategorize_document`, `move_document`) werden **noch nicht** auditiert – verfolgt in [#452](https://github.com/n0mad-ai/bastra-recall/issues/452). Jeder Eintrag enthält die ID der Erinnerung, die Operation, den Akteur und die Oberfläche (`mcp:save_memory`, `mcp:edit_memory`, `mcp:archive_memory`, …), das Frontmatter vorher und nachher, den Dateipfad und die Lauf-ID des Daemons, damit sich ein Eintrag mit der Telemetrie desselben Laufs verknüpfen lässt. Telemetrie ist kein Ersatz: Sie lässt sich abschalten und wird nach 90 Tagen bereinigt, während dieses Log nur anhängbar und dauerhaft ist. Die Aufzeichnung erfolgt bewusst nach bestem Bemühen (`packages/daemon/src/audit-trail.ts`) – ein bereits erfolgter Schreibvorgang schlägt nie fehl, nur weil sein Protokolleintrag nicht geschrieben werden konnte. Der MCP-Pfad protokolliert direkt statt über `auditedSave`, weil dieser Wrapper für Änderungen durch den Assistenten einen `reason` verlangt und das Tool-Schema kein Reason-Feld hat; ein fehlender Grund ist ehrlich, ein generierter wäre als Herkunftsnachweis getarntes Rauschen.

### Suche und Abruf

Der aktuelle Index ist ein In-Memory-MiniSearch-BM25-Index, nicht SQLite/FTS5. Durchsucht werden diese Felder:

- `recall_when` mit der höchsten Gewichtung
- `title`
- `tags`
- `topic_path`
- `summary`
- Markdown-Body

`recall(query, opts)` liefert direkte BM25-Treffer, gefiltert nach:

- `obsolete !== true`
- optional exaktem `scope`
- optional exaktem `type`
- `sensitivity !== private`, außer der Aufruf kommt über einen vertrauenswürdigen lokalen Transport (#464)

Danach wird nach Aktualität neu gewichtet, anhand von Lebenszyklus-Feldern wie `valid_until`, `expires_after_days` und `last_reviewed_at`.

#### Hybrider Abruf

Embeddings sind ein optionaler, konfigurierbarer zweiter Durchgang; Standard ist die BM25-Stichwortsuche. Der Provider wird an einer gemeinsamen Stelle bestimmt (`resolveEmbeddingChoice` in `packages/daemon/src/settings.ts`, genutzt von Daemon, Bridge und CLI), mit der Rangfolge env > cli-settings > none:

| Quelle | Wert | Verhalten |
|---|---|---|
| env `BASTRA_EMBEDDING_PROVIDER` | `none` / `ollama` / `openai` | gewinnt immer gegenüber der Settings-Datei |
| `~/.bastra/cli-settings.json` `embedding.provider` | `none` / `ollama` / `openai` | geschrieben von `bastra embeddings on\|off` (oder der Abschlussfrage von `bastra install`); gilt, wenn keine env gesetzt ist |
| nicht gesetzt + API-Key (`OPENAI_API_KEY` / `BASTRA_EMBEDDING_KEY`) | — | **nur BM25** – ein allgemeiner Zugangsschlüssel ist keine Einwilligung (#520) |
| nicht gesetzt + kein API-Key | — | nur BM25 |

`ollama` nutzt das lokale Ollama `/v1/embeddings` und behält jeden Text auf dem Rechner. `openai` ist der einzige Modus, der Daten vom Gerät schickt: Recall-Anfragen und der zu indizierende Erinnerungstext werden per POST an `api.openai.com` gesendet. Deshalb erfordert er eine **ausdrückliche** Bastra-Entscheidung – `BASTRA_EMBEDDING_PROVIDER=openai` oder `bastra config set embedding.provider openai` – plus einen API-Key. Bis #520 wählte ein bloßer `OPENAI_API_KEY` in der Umgebung ihn von selbst aus. Ein Schlüssel, der für ein ganz anderes Werkzeug exportiert war, konnte so den gesamten Backfill-Bestand ohne Bastra-spezifische Zustimmung an OpenAI schicken. Der Resolver bleibt in diesem Fall jetzt bei `none`, und Daemon, `bastra embeddings status` und `bastra doctor` geben einen Migrationshinweis aus, wie man bewusst zustimmt. Der OpenAI-Provider wird an genau einer Stelle gebaut (`cloudEmbeddingProvider`, `packages/daemon/src/embedding-cloud.ts`), damit diese Sperre nicht über eine zweite Aufrufstelle umgangen werden kann.

`bastra embeddings status` zeigt den wirksamen Provider, welche Quelle ihn bestimmt hat und ob dieser Provider Texte auf dem Gerät behält.

Der Ollama-Endpunkt (`BASTRA_OLLAMA_URL`, Standard `http://localhost:11434`) ist gegen ausgehenden Datenverkehr abgesichert: Ein Host außerhalb von Loopback wird abgelehnt, sofern nicht ausdrücklich `BASTRA_ALLOW_REMOTE_OLLAMA=1` gesetzt ist. So kann eine vertippte oder eingeschleuste URL nie Erinnerungstext vom Rechner schicken. Die Sperre (`assertLocalOrOptIn`, `packages/core/src/ollama-egress.ts`) deckt **beide** Aufrufer ab – den Embedding-Provider (Anfrage + Erinnerungstext) und den Reranker (Kandidatentext). Damit gilt die Eigenschaft „keine Cloud, kein ausgehender Verkehr, bleibt auf dem Rechner“ ausgehend ebenso wie für den nur über Loopback erreichbaren eingehenden Server.

Das Commons-Ziel (`BASTRA_COMMONS_REPO`) ist auf dieselbe Weise abgesichert (#260): `commonsRepoRefusal` (`packages/daemon/src/cli/commons.ts`) akzeptiert nur `github.com/n0mad-ai/…`, sofern nicht `BASTRA_ALLOW_REMOTE_COMMONS=1` gesetzt ist, und schlägt **sicher** fehl – ein lokaler Pfad oder ein nicht auswertbarer Wert wird abgelehnt statt durchgereicht, denn git würde ihn bereitwillig klonen. Die Sperre sitzt vor dem Klonen und vor dem `git push` eines Verifikationseintrags, nicht nur vor `gh pr create`, weil schon der Push ausgehender Verkehr ist.

Ist ein `EmbeddingIndex` angebunden, kombiniert `recallHybrid(...)` BM25- und Vektor-Rankings per Reciprocal Rank Fusion. Vektoren werden als base64-kodierte Floats in `<vault>/.bastra/embeddings.json` gespeichert.

Auf dem hybriden Pfad ist der zurückgegebene `score` eine **Rang-Größe, keine Ähnlichkeit** (#230). `fuseRRF` (`packages/core/src/embeddings.ts`) summiert `1/(RRF_K + rank)` über beide Arme, und `recallHybrid` skaliert das Ergebnis mit `RRF_SCALE` in einen BM25-ähnlichen Bereich. `RRF_K` ist 5; es war 60 (der TREC-Standard), bis diese Konstante an Pools von 5–50 gemessen wurde, wo sie Übereinstimmung der Arme höher gewichtete als den Rang. `RRF_SCALE` ist an `RRF_K` gekoppelt, damit sich die beiden Ankerwerte unten nicht mit verschieben. Jeder Score lässt sich daher in ein Rangpaar zerlegen: Rang 1 in beiden Armen ist die strukturelle Obergrenze `2 × 5000/61 ≈ 163.934`, und Rang 1 in nur einem Arm (die Arme sind sich völlig uneinig) ist `5000/61 ≈ 81.967` – ein Top-Treffer kann also berechtigt bei etwa 82 liegen. Ein Top-Treffer ist *konstruktionsbedingt* hoch: Eine Liste hat immer ein erstes Element, auch wenn die ehrliche Antwort „hier ist nichts“ lautet, daher kann selbst eine unsinnige Anfrage einen Score über 130 haben. Zwei Folgen:

- Die dokumentierte `min_score`-Untergrenze (Standard 30) ist auf dem hybriden Pfad sehr schwer zu erreichen: Ein Treffer braucht etwa Rang 28 in **beiden** Armen, um darunter zu fallen (beim alten `RRF_K = 60` war es Rang 273). Die Untergrenze ist hauptsächlich im reinen BM25-Modus (ohne Embeddings) aussagekräftig, wo der Score eine echte BM25-Größe ist. Beachte, dass sich die Band-Grenzen mit `RRF_K` verschieben, obwohl die Ankerwerte gleich bleiben – die Schnitte sind absolut, die Kurve zwischen den Ankern nicht. Eine Telemetrie-Reihe über `band` ist daher über eine Änderung dieser Konstante hinweg nicht vergleichbar.
- `recall` liefert auf oberster Ebene `weak_result: true`, wenn auf dem hybriden Pfad kein zurückgegebener Treffer einen Treffer in `recall_when` oder im Titel hat – ein ausdrückliches „hier ist nichts“-Signal neben dem Rang-1-von-nichts-Score. Es ist rein informativ und filtert nichts. Mit `verbosity: "full"` trägt jeder Treffer zusätzlich `rrf: { rank_bm25, rank_vector, raw }`, damit Aufrufer das Rangpaar sehen, aus dem der Score gebildet wird.

**Die Obergrenze ist keine einzelne Zahl, deshalb benennt die Antwort ihre Arme.** `163.934` ist die Obergrenze der *zwei persönlichen Arme*. Wenn die Bastra Commons aktiv sind, fließen sie als **dritter Arm** ein (`commons-fusion.ts`), und die Obergrenze steigt auf `163.934 + 0.95 × 81.967 ≈ 241.803`; auf dem degradierten Collapse-Pfad (persönlicher Arm nicht fusioniert, nur sein Listenrang geht ein) ist sie stattdessen `147.541`. Alle drei bezeichnen sich als `score_kind: "rrf"`, daher macht `score_kind` allein zwei Zahlen nicht vergleichbar. Jede Antwort trägt deshalb `score_arms` (sortiert: `["bm25","vector"]`, `["bm25","commons","vector"]`, `["commons","personal-rank"]`) und `score_version` – die Formelversion, die erhöht wird, sobald dieselbe Arm-Menge eine andere Zahl liefert. **Vergleiche Scores nur innerhalb eines identischen Paars aus `score_version`/`score_arms`; darüber hinweg wird nach RANG neu fusioniert.** Batch-Recall macht genau das: Teilergebnisse mit unterschiedlichen Signaturen werden über `query-rank-fusion` zusammengeführt, und die Antwort fällt auf `unfused` zurück, denn ein Band, das in einer Liste das eine und in der nächsten etwas anderes bedeutet, ist kein Band. Mit `verbosity: "full"` trägt ein Treffer, zu dem die Commons beigetragen haben, zusätzlich `rrf: { rank_commons, commons_weight, personal_score }` – `personal_score` ist das, was derselbe Recall ohne sie geliefert hätte.

#### Mehrstufiger Abruf

Wird `expand_hops: 1` übergeben, ergänzt Recall direkte Nachbarn aus `frontmatter.related_via`. Diese Nachbarn werden mit denselben Regeln für obsolete/scope/type/sensitivity gefiltert und erhalten einen reduzierten Score.

`RelatedEnricher` kann `related_via` nach Embedding-Batches automatisch pflegen. Er hängt außerdem einen automatisch verwalteten Abschnitt mit Obsidian-Wikilinks an den Body der Erinnerung an, begrenzt durch Marker-Kommentare, damit manuelle und automatische Links getrennt bleiben.

### Daemon und Transporte

Der Haupt-Daemon ist `packages/daemon/src/index.ts`.

Er startet:

- einen `Vault`
- einen `SearchIndex`
- optional einen `EmbeddingIndex`
- optional einen `RelatedEnricher`
- eine `Telemetry`-Instanz
- standardmäßig einen HTTP-REST-Server auf `127.0.0.1:6723`
- einen stdio-MCP-Server im selben Prozess

HTTP lässt sich mit `BASTRA_HTTP=off` abschalten. Der Endpunkt wird seit #531 an genau einer Stelle bestimmt (`packages/daemon/src/daemon-endpoint.ts`), und jede Oberfläche, die ihn bindet, prüft, benennt oder speichert, liest diesen Resolver: `BASTRA_DAEMON_URL` → `BASTRA_HTTP_URL` → `BASTRA_HTTP_PORT` → Loopback auf `6723` (die alten `NEXUS_*`-Namen werden jeweils zusätzlich akzeptiert).

#### MCP-Forwarder

`bastra-recall-mcp` ist ein schlanker stdio-MCP-Wrapper. Er lädt weder den Vault noch hält er einen Index. Er:

1. prüft `GET /health` auf `BASTRA_DAEMON_URL` (Standard `http://127.0.0.1:6723`);
2. startet den Daemon automatisch, außer bei `BASTRA_FORWARDER_SPAWN=0`;
3. stellt MCP-Werkzeuge über stdio bereit;
4. leitet jeden Werkzeugaufruf an `/api/v1/<tool>` weiter.

So können mehrere MCP-Clients einen einzigen Daemon, Index, eine Embedding-Warteschlange und einen Telemetrie-Strom teilen.

### Werkzeuge

Zentrale Gedächtniswerkzeuge:

| Werkzeug | Zweck |
|---|---|
| `recall` | Erinnerungen nach Handlungskontext oder natürlichsprachiger Anfrage durchsuchen |
| `load_memory` | Vollständiges Frontmatter und Body per ID laden |
| `save_memory` | Eine neue oder überschriebene Markdown-Erinnerung schreiben und Reindex erzwingen |
| `edit_memory` | Eine bestehende Erinnerung patchen – `str_replace`, `append` und/oder ein Frontmatter-Patch, über denselben Speicherpfad; `expected_revision` ist die Vorbedingung für optimistische Nebenläufigkeit (#519) |

Werkzeuge zum Lesen von Dokumenten:

| Werkzeug | Zweck |
|---|---|
| `find_document` | `type: doc`-Sidecars durchsuchen |
| `read_document` | Metadaten und extrahierten Body eines Dokument-Sidecars laden |
| `open_document` | Nur macOS: Originaldatei oder Sidecar öffnen |

Werkzeuge zum Schreiben von Dokumenten sind durch `BASTRA_DOCUMENT_WRITE=1` gesperrt:

| Werkzeug | Zweck |
|---|---|
| `save_document` | Eine Originaldatei kopieren oder verlinken und einen abrufbaren Sidecar schreiben |
| `recategorize_document` | Titel, Tags, Kategorie oder Ordner-Metadaten aktualisieren |
| `move_document` | Sidecar und Originaldatei in einen anderen Dokumentordner verschieben |

Der direkte Daemon listet Dokument-Schreibwerkzeuge nur auf, wenn das env-Flag gesetzt ist. Der Forwarder darf sie auflisten und den Daemon beim Aufruf den Sperrfehler zurückgeben lassen.

### HTTP-REST

Der HTTP-Server bindet nur an Loopback. Wichtigste Endpunkte:

| Endpunkt | Methode | Zweck |
|---|---|---|
| `/health` | `GET` | Zustand, Version und Vault-Größe des Daemons |
| `/hook/recall` | `POST` | Recall-Pfad für den PreToolUse-Hook von Claude Code |
| `/api/v1/recall` | `POST` | REST-Wrapper für `recall` |
| `/api/v1/load_memory` | `POST` | REST-Wrapper für `load_memory` |
| `/api/v1/save_memory` | `POST` | REST-Wrapper für `save_memory` |
| `/api/v1/edit_memory` | `POST` | REST-Wrapper für `edit_memory` |
| `/api/v1/find_document` | `POST` | REST-Wrapper für `find_document` |
| `/api/v1/read_document` | `POST` | REST-Wrapper für `read_document` |
| `/api/v1/open_document` | `POST` | REST-Wrapper für `open_document` |
| `/api/v1/save_document` | `POST` | gesperrter Dokument-Schreibzugriff |
| `/api/v1/recategorize_document` | `POST` | gesperrter Dokument-Schreibzugriff |
| `/api/v1/move_document` | `POST` | gesperrter Dokument-Schreibzugriff |

`/api/v1/*` verlangt `Authorization: Bearer <token>` für alles, was kein direkter lokaler Aufrufer ist – auch wenn gar kein Token konfiguriert ist. Dann lautet die Antwort `401`, und kein Bearer kann sie erfüllen, bis ein Token erzeugt wurde (#526; der tokenlose Dev-Modus ist die Ausnahme für direkte lokale Aufrufer, nie eine global offene Tür). Direkte lokale Aufrufer umgehen die Authentifizierung standardmäßig. Die Ausnahme erfordert einen Loopback-Peer-Socket **und** einen vorhandenen `Host`-Header mit Loopback-Adresse. So erbt weder eine per DNS-Rebinding umgelenkte Seite noch ein lokaler Tunnel – auch kein roher Port-Forwarder, dessen Aufrufer den Header einfach weglässt – die Ausnahme vom Socket (#526). Setze `BASTRA_AUTH_LOOPBACK_SKIP=0`, um das Token auch lokal zu verlangen.

CORS ist standardmäßig gesperrt: Kein Browser-Origin ist erlaubt, bis `BASTRA_CORS_ORIGIN` ihn aufführt (kommagetrennt). `BASTRA_CORS_ORIGIN=*` ist eine ausdrückliche, freizügige Zustimmung für Tunnel- und Dev-Setups. Wird die aufrufende Seite über HTTPS ausgeliefert (öffentlicher Origin → Daemon auf localhost), beantwortet der Daemon den Private-Network-Access-Preflight von Chrome für erlaubte Origins automatisch mit `Access-Control-Allow-Private-Network: true`.

### Hooks

Claude-Code-Hooks rufen den Loopback-Daemon auf und sind so gebaut, dass sie bei Fehlern offen durchlassen, damit sie den Assistenten nicht blockieren.

Aktuell aktive Hook-Programme:

| Programm | Ereignis | Zweck |
|---|---|---|
| `bastra-recall-hook` | `PreToolUse` | vor Write/Edit/MultiEdit/NotebookEdit Datei- und Inhaltsthemen erkennen und Recall-Hinweise einspeisen |
| `bastra-recall-session-hook` | `SessionStart` | bei startup/resume/clear/compact Nutzerpräferenzen, projektübergreifende Regeln und Projekterinnerungen vorladen |

Die Themenerkennung ist deterministisch und beruht auf Dateiendung, Pfadsegmenten und Inhaltsmustern. Der Hook sendet eine begrenzte natürlichsprachige Anfrage an `/hook/recall`.

### Datenschutz und Sicherheit

Speicherung und Stichwortsuche laufen lokal. MCP-Ergebnisse und Hook-Kontext werden an den verbundenen KI-Client übergeben; ein cloudgestützter Client kann diesen Kontext an seinen Anbieter senden. Ausdrücklich konfigurierte entfernte Embeddings, REST-Freigabe und die Synchronisierung des Vault-Ordners fügen eigene Datenwege hinzu. Die [Datenschutz-Übersicht](./PRIVACY.md#deutsch) beschreibt diese Grenzen und die Netzwerkfunktionen, die nur Metadaten nutzen; die Kontrollen auf Transportebene unten gelten für Bastras eigene API.

- Der Daemon bindet an `127.0.0.1`.
- Der Vault besteht aus einfachem lokalem Markdown.
- Erinnerungen mit `sensitivity: private` sind für externe MCP-/REST-Aufrufer verborgen. Seit #464 ist die Berechtigung an den Transport gebunden (`private-access.ts`): Sie ist kein Werkzeug-Argument, also kann sich kein Request-Body sie selbst erteilen. Die Bridge der lokalen App (`bridge.ts`) ist der vertrauenswürdige Transport.
- `load_memory` wendet den Sensitivity-Filter ebenfalls an, daher kann direktes Durchprobieren von IDs keine privaten Erinnerungen laden.
- Dieselbe Sperre gilt für jede Änderung eines verborgenen Datensatzes – `save_memory(overwrite)`, `edit_memory`, `archive_memory`, `save_document(overwrite)`, `recategorize_document`, `move_document`. Alle antworten genau wie bei einer unbekannten ID, daher verrät auch ein abgelehnter Schreibvorgang nicht, ob der Datensatz existiert.
- Telemetrie ist lokales JSONL und lässt sich mit `BASTRA_TELEMETRY=off` abschalten.
- Speicher-, Lösch- und Wiederherstellungsvorgänge der Mac-App-Bridge können in `<vault>/.bastra/audit-log.ndjson` protokolliert werden.
- Soft-Deletes verschieben Dateien nach `<vault>/.bastra/trash/`.

### Stack-Übersicht

| Schicht | Aktuelle Wahl |
|---|---|
| Laufzeit | Node 22+, TypeScript, ESM |
| MCP | `@modelcontextprotocol/sdk` |
| Suche | MiniSearch BM25 im Arbeitsspeicher |
| Embeddings | Optional lokaler Ollama-Provider oder OpenAI nach ausdrücklicher Zustimmung; Vektoren im Arbeitsspeicher mit JSON-Persistenz |
| Vault-Parsing | `gray-matter` + Zod-Frontmatter-Schema |
| Dateiüberwachung | `chokidar` mit Polling auf Cloud-Mounts |
| HTTP | Node-`http`-Server |
| CLI-/Installations-Adapter | Claude Code, Claude Desktop, Codex/ChatGPT Desktop, Cursor |

### Historischer Hinweis

Frühe Design-Dokumente beschrieben einen SQLite/FTS5-Index und HTTP-MCP auf Port `7891`. Das ist nicht die aktuelle Implementierung. Der aktuelle Code nutzt MiniSearch/BM25, optionale Embeddings, REST auf `127.0.0.1:6723` und MCP über stdio/Forwarder.
