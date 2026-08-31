# Architecture

## Goal

Bastra.Recall is a local-first memory layer for AI assistants. It gives Claude Code, Claude Desktop, Codex, ChatGPT Desktop, Cursor, ChatGPT Actions, and other MCP/HTTP clients one shared vault of durable lessons, preferences, project facts, decisions, workflows, bookmarks, and document sidecars.

The operating goal is simple: the user should not have to re-explain stable context. The assistant saves durable memories when a lesson or rule is learned, and recalls relevant memories before acting.

## Current Runtime Shape

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

## Vault Layer

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

### Write commit contract

`saveMemory` builds a complete temporary file and commits per destination path. The destination path—not only the memory id—is the concurrency boundary, so the same id in two explicitly different folders does not block.

Every commit has these invariants:

1. The target is read before the candidate is built. Only `ENOENT` means free; permission, device, and cloud-mount read failures abort the save.
2. The writer acquires `<target>.bastra-write.lock` with exclusive-create semantics. A second `saveMemory` writer, including one in another process, receives `MemoryWriteConflictError` with code `BASTRA_WRITE_CONFLICT`.
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

The per-path claim is the cooperation boundary: every project write path that calls `saveMemory` participates, across Node processes. A program that edits the markdown file directly does not acquire this claim. Creates still cannot clobber such an external late writer because their final publication is no-replace; portable Node filesystem APIs do not provide an atomic content-CAS replacement for the overwrite case.

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
| same id in different folders | both commit independently |
| target inspection fails with non-`ENOENT` | fail closed before temp/lock creation |
| success or handled conflict | no owned temp/lock artifact remains |
| winning overwrite is a patch | omitted frontmatter, including sensitivity, survives |

The watcher uses `chokidar`. On paths that look like cloud-storage mounts (`CloudStorage`, `Dropbox`, `iCloud`), it switches to polling because native file events are unreliable there. Write paths call `vault.reindexFile(...)` after known writes so a save and a recall in the same turn stay consistent.

A memory's **id survives** the engine's lifecycle operations: demote changes score only, soft-delete moves the file to append-only `.bastra/trash/` (recoverable), and only a hard delete removes a cell. This is the substrate guarantee the pin/floor lifecycle and any citation layer build on — pinned by a CI regression test. Details: [docs/survival.md](./docs/survival.md).

Every vault write through the daemon appends to `<vault>/.bastra/audit-log.ndjson` (#206) — `save_memory`, `save_product_doc` and `archive_memory`, alongside the Mac-app bridge that already used it. Each entry carries the memory id, the operation, the actor and the surface (`mcp:save_memory`, `mcp:archive_memory`, …), the frontmatter before and after, the file path, and the daemon run id, so an entry can be correlated with the telemetry of the same run. Telemetry is not a substitute: it can be switched off and is pruned after 90 days, while this log is append-only and permanent. Recording is best-effort by design (`packages/daemon/src/audit-trail.ts`) — a write that already landed is never failed because its trail could not be written. The MCP path records directly rather than through `auditedSave`, because that wrapper requires a `reason` for assistant mutations and the tool schema has no reason field; a missing reason is honest, a generated one would be noise dressed as provenance.

## Search And Recall

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
- `sensitivity !== private` unless `allow_private: true`

It then applies staleness reranking based on lifecycle fields such as `valid_until`, `expires_after_days`, and `last_reviewed_at`.

### Hybrid Recall

Embeddings are an optional, configurable second pass; BM25 keyword search is the default. The provider is resolved in one shared place (`resolveEmbeddingChoice` in `packages/daemon/src/settings.ts`, used by the daemon, the bridge, and the CLI) with the precedence env > cli-settings > API-key > none:

| Source | Value | Behavior |
|---|---|---|
| env `BASTRA_EMBEDDING_PROVIDER` | `none` / `ollama` / `openai` | always wins over the settings file |
| `~/.bastra/cli-settings.json` `embedding.provider` | `none` / `ollama` / `openai` | written by `bastra embeddings on\|off` (or the `bastra install` end prompt); used when no env is set |
| unset + API key (`OPENAI_API_KEY` / `BASTRA_EMBEDDING_KEY`) | — | use OpenAI for backwards compatibility |
| unset + no API key | — | BM25 only |

`ollama` uses local Ollama `/v1/embeddings`; `openai` requires an API key. `bastra embeddings status` shows the effective provider and which source decided it.

The Ollama endpoint (`BASTRA_OLLAMA_URL`, default `http://localhost:11434`) is egress-guarded: a non-loopback host is refused unless `BASTRA_ALLOW_REMOTE_OLLAMA=1` is set explicitly, so a mistyped or injected URL can never send memory text off-box. The guard (`assertLocalOrOptIn`, `packages/core/src/ollama-egress.ts`) covers **both** callers — the embedding provider (query + memory text) and the reranker (candidate text) — so the "no cloud, no egress, stays on the machine" property holds outbound as well as for the loopback-only inbound server.

The Commons target (`BASTRA_COMMONS_REPO`) is guarded the same way (#260): `commonsRepoRefusal` (`packages/daemon/src/cli/commons.ts`) accepts only `github.com/n0mad-ai/…` unless `BASTRA_ALLOW_REMOTE_COMMONS=1` is set, and it fails **closed** — a local path or an unparseable value is refused rather than passed through, because git would clone it happily. The gate sits before the clone and before the `git push` of a verification record, not only before `gh pr create`, since the push is already the egress.

When an `EmbeddingIndex` is attached, `recallHybrid(...)` combines BM25 and vector rankings with Reciprocal Rank Fusion. Vectors are stored as base64-encoded floats in `<vault>/.bastra/embeddings.json`.

On the hybrid path the returned `score` is a **rank quantity, not a similarity** (#230). `fuseRRF` (`packages/core/src/embeddings.ts`) sums `1/(RRF_K + rank)` across the two arms and `recallHybrid` scales the result by `RRF_SCALE` into a BM25-looking range. `RRF_K` is 5; it was 60 (the TREC default) until that constant was measured against pools of 5–50, where it weighted arm agreement above rank. `RRF_SCALE` is tied to `RRF_K` so the two anchors below do not move with it. Every score therefore decomposes into a rank pair: rank 1 in both arms is the structural ceiling `2 × 5000/61 ≈ 163.934`, and rank 1 in a single arm (the arms fully disagree) is `5000/61 ≈ 81.967` — so a top hit can legitimately sit near 82. A top hit is high *by construction*: a list always has a first element even when the honest answer is "nothing here", so a nonsense query can still carry a 130+ score. Two consequences:

- The documented `min_score` floor (default 30) is very hard to reach on the hybrid path: a hit needs roughly rank 28 in **both** arms to fall below it (it was rank 273 at the old `RRF_K = 60`). The floor is mainly meaningful in BM25-only mode (no embeddings), where the score is a genuine BM25 quantity. Note that the band boundaries move with `RRF_K` even though the anchors do not — the cuts are absolute and the curve between the anchors is not, so a telemetry series over `band` is not comparable across a change to that constant.
- `recall` returns a top-level `weak_result: true` when, on the hybrid path, no returned hit has a `recall_when` or title match — an explicit "nothing here" signal riding alongside the rank-1-of-nothing score. It is informational and filters nothing. With `verbosity: "full"` each hit also carries `rrf: { rank_bm25, rank_vector, raw }` so callers can see the rank pair the score is built from.

**The ceiling is not one number, so the response names its arms.** `163.934` is the ceiling of the *two personal arms*. When the Bastra Commons are active they fuse in as a **third arm** (`commons-fusion.ts`), and the ceiling rises to `163.934 + 0.95 × 81.967 ≈ 241.803`; on the degraded collapse path (personal arm unfused, only its list rank enters) it is `147.541` instead. All three call themselves `score_kind: "rrf"`, so `score_kind` alone does not make two numbers comparable. Every response therefore carries `score_arms` (sorted: `["bm25","vector"]`, `["bm25","commons","vector"]`, `["commons","personal-rank"]`) and `score_version` — the formula version, to be bumped whenever the same arm set starts producing a different number. **Compare scores only within an identical `score_version`/`score_arms` pair; across them, re-fuse by RANK.** Batch recall does exactly that: sub-results with differing signatures are merged via `query-rank-fusion` and the response drops back to `unfused`, because a band that means one thing in one list and another in the next is not a band. With `verbosity: "full"` a hit that the commons contributed to additionally carries `rrf: { rank_commons, commons_weight, personal_score }` — `personal_score` is what the same recall would have served without them.

### Multi-Hop Recall

If `expand_hops: 1` is passed, recall adds one-hop neighbors from `frontmatter.related_via`. Those neighbors are filtered with the same obsolete/scope/type/sensitivity rules and receive a reduced score.

`RelatedEnricher` can maintain `related_via` automatically after embedding batches. It also appends an auto-managed Obsidian wikilink section to the memory body, bounded by marker comments so manual links and automatic links stay separate.

## Daemon And Transports

The main daemon is `packages/daemon/src/index.ts`.

It starts:

- one `Vault`
- one `SearchIndex`
- optional `EmbeddingIndex`
- optional `RelatedEnricher`
- one `Telemetry` instance
- HTTP REST server on `127.0.0.1:6723` by default
- stdio MCP server in the same process

HTTP can be disabled with `BASTRA_HTTP=off`. The port defaults to `6723` and can be changed with `BASTRA_HTTP_PORT` (legacy `NEXUS_HTTP_PORT` is accepted).

### MCP Forwarder

`bastra-recall-mcp` is a thin stdio MCP wrapper. It does not load the vault or hold an index. It:

1. probes `GET /health` on `BASTRA_DAEMON_URL` (default `http://127.0.0.1:6723`);
2. auto-spawns the daemon unless `BASTRA_FORWARDER_SPAWN=0`;
3. exposes MCP tools over stdio;
4. proxies each tool call to `/api/v1/<tool>`.

This lets multiple MCP clients share a single daemon, index, embedding queue, and telemetry stream.

## Tools

Core memory tools:

| Tool | Purpose |
|---|---|
| `recall` | Search memories by action context or natural-language query |
| `load_memory` | Load full frontmatter and body by id |
| `save_memory` | Write a new or overwritten memory markdown file and force reindex |

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

## HTTP REST

The HTTP server binds to loopback only. Main endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | `GET` | daemon health, version, vault size |
| `/hook/recall` | `POST` | Claude Code PreToolUse hook recall path |
| `/api/v1/recall` | `POST` | REST wrapper for `recall` |
| `/api/v1/load_memory` | `POST` | REST wrapper for `load_memory` |
| `/api/v1/save_memory` | `POST` | REST wrapper for `save_memory` |
| `/api/v1/find_document` | `POST` | REST wrapper for `find_document` |
| `/api/v1/read_document` | `POST` | REST wrapper for `read_document` |
| `/api/v1/open_document` | `POST` | REST wrapper for `open_document` |
| `/api/v1/save_document` | `POST` | gated document write |
| `/api/v1/recategorize_document` | `POST` | gated document write |
| `/api/v1/move_document` | `POST` | gated document write |

If `BASTRA_API_TOKEN` is set, `/api/v1/*` requires `Authorization: Bearer <token>`. Loopback callers bypass auth by default; set `BASTRA_AUTH_LOOPBACK_SKIP=0` to require the token even locally.

CORS is deny-by-default: no browser origin is allowed until `BASTRA_CORS_ORIGIN` lists it (comma-separated). `BASTRA_CORS_ORIGIN=*` is an explicit permissive opt-in for tunnel/dev setups. When the calling site is served over HTTPS (public origin → localhost daemon), Chrome's Private Network Access preflight is answered automatically with `Access-Control-Allow-Private-Network: true` for allowed origins.

## Hooks

Claude Code hooks call the loopback daemon and are designed to fail open so they do not block the assistant.

Current live hook binaries:

| Binary | Event | Purpose |
|---|---|---|
| `bastra-recall-hook` | `PreToolUse` | detect file/content topics before Write/Edit/MultiEdit/NotebookEdit and inject recall hints |
| `bastra-recall-session-hook` | `SessionStart` | preload user preferences, cross-project rules, and project memories at startup/resume/clear/compact |

Topic detection is deterministic and based on file extension, path segments, and content patterns. The hook sends a bounded natural-language query to `/hook/recall`.

## Privacy And Safety

- The daemon binds to `127.0.0.1`.
- The vault is plain local markdown.
- `sensitivity: private` memories are hidden from external MCP/REST callers unless an internal caller explicitly uses `allow_private: true`.
- `load_memory` also enforces the sensitivity filter, so direct id enumeration cannot load private memories.
- Telemetry is local JSONL and can be disabled with `BASTRA_TELEMETRY=off`.
- Save/delete/restore operations used by the Mac-app bridge can be recorded in `<vault>/.bastra/audit-log.ndjson`.
- Soft deletes move files to `<vault>/.bastra/trash/`.

## Stack Summary

| Layer | Current choice |
|---|---|
| Runtime | Node 22+, TypeScript, ESM |
| MCP | `@modelcontextprotocol/sdk` |
| Search | MiniSearch BM25 in memory |
| Embeddings | Optional OpenAI or Ollama provider, in-memory vectors with JSON persistence |
| Vault parsing | `gray-matter` + Zod frontmatter schema |
| File watching | `chokidar` with polling on cloud mounts |
| HTTP | Node `http` server |
| CLI/install adapters | Claude Code, Claude Desktop, Codex/ChatGPT Desktop, Cursor |

## Historical Note

Early design docs described a SQLite/FTS5 index and HTTP MCP on port `7891`. That is not the current implementation. The current code uses MiniSearch/BM25, optional embeddings, REST on `127.0.0.1:6723`, and MCP stdio/forwarder transports.
