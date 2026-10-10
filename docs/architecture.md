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
5. Normal success and handled conflicts remove the writer's temporary and lock files. A process killed while it owns the claim can leave the lock behind; the destination is still either the complete old file or the complete committed file, never a partial write. Verify that no writer is active before removing such a stale lock. A later writer takes over on its own: at once when the owner process on this host is gone, after 30 seconds when the owner cannot be checked (other host, unreadable claim), and a claim whose owner pid still answers alive is honoured for at most 10 minutes (a dead writer's pid can be reused by an unrelated process, so "alive" is not proof forever).

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

Every writer under the vault root (saves, documents, locks, audit log, usage sidecar, curator state, embeddings, journals) creates directories only through `ensureVaultDir` in `packages/core/src/vault-root-guard.ts`. A root seen present is recorded outside the vault, in `~/.bastra/vault-roots.json`; a recorded root that is missing now is an unmounted drive, so nothing is created and `vault_missing` stays on `/health` and recall, across restarts too. A root never seen is created only by a writer that makes a vault (`saveMemory`, `save_document`, `createVaultAt`), which says so with `createRoot`. Even then the root is created non-recursively, only under a parent directory that exists; a missing parent stops the write with an error naming it ("mount the drive or create the parent directory first"). `createVaultAt` (install `--vault`, the setup wizard) creates the parent chain itself before calling the guard, because the user named that path, and only for a root never seen. If the marker file is empty or corrupt, or its directory is not writable, the guard stops every write with a `VAULT_ROOT_HISTORY_UNAVAILABLE` error (same text in MCP `save_memory` and the CLI) that names the file, the cause and the repair: delete the file if the vault is mounted, or fix the directory permissions.
If the root-history file is corrupt or unreadable, writers stop instead of treating it as empty history. A write also requires the root to be recorded successfully; child directories are made one level at a time so a root lost between the check and `mkdir` is not recursively recreated. On a machine that has never seen a configured root, an absent mount whose parent directory exists remains indistinguishable from a genuinely new vault until its first successful presence check.
On macOS and Windows, a missing root is also compared to recorded paths without case, so `Vault` and `vault` cannot bypass the guard on a case-insensitive volume. This can conservatively stop a genuinely distinct path on a case-sensitive volume; symlink aliases still require the same configured spelling when the target is missing.

Temporary roots under `os.tmpdir()` or `/tmp` (including its macOS `/private/tmp` alias) keep only process-local history by default, so library reads and ad-hoc benchmarks do not add disposable vaults to the user's marker (#1071). A symlink into a persistent directory still records that root. Set `BASTRA_VAULT_ROOTS_PATH` to an explicit marker to persist temporary roots across processes; the root test runner already chooses an isolated marker. Run ad-hoc scripts with isolated `HOME` and `TMPDIR`, or preload `scripts/test-env.mjs`, because other state writers have their own defaults.

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

On the hybrid path the returned `score` is a **rank quantity, not a similarity** (#230). `fuseRRF` (`packages/core/src/embeddings.ts`) sums `1/(RRF_K + rank)` across the two arms and `recallHybrid` scales the result by `RRF_SCALE` into a BM25-looking range. `RRF_K` is 5; it was 60 (the TREC default) until that constant was measured against pools of 5–50, where it weighted arm agreement above rank. `RRF_SCALE` is tied to `RRF_K` so the two anchors below do not move with it. Every score therefore decomposes into a rank pair: rank 1 in both arms is the structural ceiling `2 × 5000/61 ≈ 163.934`. Rank 1 in a single arm (the arms fully disagree) depends on the arm since v1.0.1 (`score_version: "rrf-2"`, dense-arm weight 1.5, #641): `0.8 × 5000/61 ≈ 65.6` for BM25 only, `1.2 × 5000/61 ≈ 98.4` for the vector arm only — so a top hit can legitimately sit near 66. Under `rrf-1` (v1.0.0, equal weights, or `BASTRA_RRF_VECTOR_WEIGHT=1`) both were `5000/61 ≈ 81.967`. Two scores are comparable only within the same `score_version`. A top hit is high *by construction*: a list always has a first element even when the honest answer is "nothing here", so a nonsense query can still carry a 130+ score. Two consequences:

- The documented `min_score` floor (default 30) is very hard to reach on the hybrid path: a hit needs roughly rank 28 in **both** arms to fall below it (it was rank 273 at the old `RRF_K = 60`). The floor is mainly meaningful in BM25-only mode (no embeddings), where the score is a genuine BM25 quantity. Note that the band boundaries move with `RRF_K` even though the anchors do not — the cuts are absolute and the curve between the anchors is not, so a telemetry series over `band` is not comparable across a change to that constant. The same holds for `BASTRA_RRF_VECTOR_WEIGHT` (#641, default `1.5` since v1.0.1, `1` restores the v1.0.0 equal weights): it weights the dense arm against BM25, normalised so that rank 1 in both arms stays at 163.934, but a one-armed rank 1 then scores above 81.967 (dense) or below it (BM25).
- `recall` returns a top-level `weak_result: true` when, on the hybrid path, no returned hit has a `recall_when` or title match — an explicit "nothing here" signal riding alongside the rank-1-of-nothing score. It is informational and filters nothing. With `verbosity: "full"` each hit also carries `rrf: { rank_bm25, rank_vector, raw }` so callers can see the rank pair the score is built from.

**The ceiling is not one number, so the response names its arms.** `163.934` is the ceiling of the *two personal arms*. When the Bastra Commons are active they fuse in as a **third arm** (`commons-fusion.ts`), and the ceiling rises to `163.934 + 0.95 × 81.967 ≈ 241.803`; on the degraded collapse path (personal arm unfused, only its list rank enters) it is `81.967 + weight × 81.967` instead — `147.541` at the default commons weight `0.8`, `159.836` at the `0.95` cap. All three call themselves `score_kind: "rrf"`, so `score_kind` alone does not make two numbers comparable. Every response therefore carries `score_arms` (sorted: `["bm25","vector"]`, `["bm25","commons","vector"]`, `["commons","personal-rank"]`) and `score_version` — the formula version, to be bumped whenever the same arm set starts producing a different number. **Compare scores only within an identical `score_version`/`score_arms` pair; across them, re-fuse by RANK.** Batch recall does exactly that: sub-results with differing signatures are merged via `query-rank-fusion` and the response drops back to `unfused`, because a band that means one thing in one list and another in the next is not a band. With `verbosity: "full"` a hit that the commons contributed to additionally carries `rrf: { rank_commons, commons_weight, personal_score }` — `personal_score` is what the same recall would have served without them.

**Query router (#362), live since v1.0.1.** `routeQueryArms` (`packages/core/src/query-router.ts`) decides per query whether the dense arm can contribute: short queries (at most two words, counted with `Intl.Segmenter`, so a sentence in a script without spaces is several words) and identifier-shaped queries (at least half the whitespace terms carry inner glue `._/\:`, camelCase or a letter next to a digit) run on BM25 alone; everything else stays hybrid. Both rules are structural, no word list. `BASTRA_QUERY_ROUTER` defaults to `live` (owner decision 2026-09-29), which skips the dense arm for routed queries; `shadow` only records `query_route` with `would_save_ms` (the wait on the dense arm after BM25) on `hook_recall`. On gold-set run A (`npm run router-lift`, eval: baseline, routed, control) the router routes 17 of 699 queries, no metric drops below the baseline and routed queries drop from p50 14.8 ms to 5.8 ms; it does not touch the p90 tail of the prompt lane, which comes from long prompts (design 5d54c63, #362).

#### Multi-Hop Recall

If `expand_hops: 1` is passed, recall adds one-hop neighbors from `frontmatter.related_via`. Those neighbors are filtered with the same obsolete/scope/type/sensitivity rules and receive a reduced score.

`RelatedEnricher` can maintain `related_via` automatically after embedding batches. It also appends an auto-managed Obsidian wikilink section to the memory body, bounded by marker comments so manual links and automatic links stay separate.

#### One Recall Pipeline For Hooks And MCP (#421)

Hook lanes and MCP `recall` share the selection steps in `packages/daemon/src/recall-pipeline.ts`; what differs is parameters, not code:

- **Reflex hits.** Memories the user wired as `recall_mode: reflex` that sit in the deeper candidate pool below the top-k cut come back as `reflex_hits` on every path — `/hook/recall` (hook lanes and the MCP forwarder, which used to drop the field in its projection) and the stdio server's `recallHandler`. The MCP path applies its own `min_score` floor to them; the hook path passes them unfloored because the lanes apply their own floor. Batch recall merges them across phrasings. `max_tokens` counts them, ranked hits are cut first.
- **Project scope filter.** The prompt lane's filter (anchored cross-scope bypass, reflex hits exempt, bypass closed without fusion, `project_known` from the vault) now also runs for MCP callers: the forwarder sends its client's project (`projectForFilter(cwd)`, the same confidence gate as the lanes) with `apply_scope_filter: true`, and the stdio server passes its own cwd. An explicit `scope` argument disables it (`scope_filter_skipped: "explicit-scope"`). The mode is the lanes' switch, `BASTRA_SCOPE_FILTER_LANES`: `shadow` (default) only records `scope_filter_mode`/`dropped_scope_count`/`dropped_scopes`/`filter_project` on the `recall` or `hook_recall` row, `enforce` drops. Hook lanes do not set `apply_scope_filter` and keep filtering on their side, so their responses and telemetry rows are unchanged.

Still separate, tracked on #421: the evidence gate and deadline shadow run only on `/hook/recall` (the stdio `recallHandler` and `/api/v1/recall` do not), the REST path has no caller project, commons fusion and `verbosity: "full"` exist only in `recallHandler`, and the GET session-context path still runs `recallHandler`.

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
2. after failed health, gives a managed macOS service up to 10 seconds before auto-spawning; `BASTRA_FORWARDER_SPAWN=0` still disables spawn and this service wait;
3. exposes MCP tools over stdio;
4. proxies each tool call to `/api/v1/<tool>`.

This lets multiple MCP clients share a single daemon, index, embedding queue, and telemetry stream.

**The env of an auto-spawned daemon (#684).** The spawned daemon is shared by
every client, so it does not take the spawning client's env as-is
(`packages/daemon/src/daemon-spawn-env.ts`). Keys that only a client reads are
dropped: `BASTRA_TOOL_SURFACE`, `BASTRA_MCP_SESSION_CONTEXT`,
`BASTRA_HOOK_TIMEOUT_MS` (the daemon's hook lanes read it, so one client's
entry used to set every lane's budget), `BASTRA_FORWARDER_SPAWN`,
`BASTRA_HOOK_CLIENT`. Daemon behaviour that exists only as env —
`BASTRA_TRIGGER_EXPAND`, `BASTRA_PROMPT_HOOK_MODE`, `BASTRA_DOCUMENT_WRITE`,
`BASTRA_RM_ARCHIVES`, `BASTRA_OLLAMA_URL` — can be pinned in
`~/.bastra/cli-settings.json`:

```json
{ "daemon": { "env": { "BASTRA_TRIGGER_EXPAND": "0", "BASTRA_PROMPT_HOOK_MODE": "all" } } }
```

A pin wins over the client's value; other keys are ignored with a warning.
Put the same values there that your service unit or LaunchAgent sets, and a
daemon a client spawns while the service is down runs the same config. A
service-started daemon keeps its own env; this only shapes the forwarder's
spawn. `/health` reports `started_by` (`forwarder`, `launchagent`, `systemd`
— detected by `INVOCATION_ID` — or `direct`) and `env_origin` (`own`,
`client`, `client+settings`), and `bastra doctor` prints them under "daemon
origin". On macOS an installed managed XML plist gets a 10-second health window
without checking the loaded job or adding a setting; an unsuccessful window
falls back once with a stderr debug-log diagnosis. A forwarder daemon holds the
port until idle exit (30 min by default), even with a registered LaunchAgent.
A headless non-forwarder starter retries before storage boot: 1/2/4/8/16/30-second
intervals, capped at 30 seconds, without a total deadline. Health probes do not
count as activity. No shutdown handshake. Linux client-first starts remain
possible until managed setup arrives in #566; `BASTRA_FORWARDER_SPAWN=0` remains
a workaround.

Who started the daemon does not say whether its config differs, so `/health`
also reports `config_fingerprint`: twelve hex characters over the daemon's
behaviour settings. That is every `BASTRA_*` variable in its env except the
client-only keys above, everything about how and where the process runs
(`BASTRA_DAEMON_*`, the HTTP port, the autostart marker), paths (`*_PATH`,
`*_DIR`, `*_BIN`) and secrets (`*_KEY`, `*_TOKEN`; a URL counts without its
credentials). Key order does not matter, and an empty value counts as unset.
`bastra doctor` computes the same fingerprint over the configured state — the
`daemon.env` pins, plus on macOS the env of the LaunchAgent that `bastra
autostart on` wrote — and prints a warning under "daemon origin" when the
running daemon's differs; on a match it prints the fingerprint and says so.
The exit code does not change. With no pins and no managed LaunchAgent there
is nothing to compare with (a systemd unit's env is not readable from the
CLI), and doctor only shows the fingerprint. A mismatch means the two start
paths do not run the same settings: set them in both places, then restart the
daemon. The fingerprint does not say which setting differs.

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

Code-awareness read tool (#576; experimental, see #667):

| Tool | Purpose |
|---|---|
| `find_code` | Locate a symbol or file in the repository's code graph and list what depends on it, one hop |

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
| `/api/v1/find_code` | `POST` | REST wrapper for `find_code` |
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

#### Module Map (#680)

Files that passed the 800-line convention were split along one responsibility each; the original file keeps the orchestration and re-exports its public surface, so import paths did not change. All paths under `packages/daemon/` unless noted.

| Module | Split-out neighbours |
|---|---|
| `src/prompt-lane.ts` (UserPromptSubmit pipeline) | `prompt-classify.ts` (mode detection, trivial gate, score floors), `prompt-format.ts` (hint blocks), `prompt-lane-telemetry.ts` (`prompt_hook_call` row), `prompt-loopback.ts` (self-call) |
| `src/http-hook-routes.ts` (`/hook/recall` route + `runHookRecall`) | `hook-recall-input.ts` (request fields), `hook-content-recall.ts` (content recall + merge gate), `hook-recall-evidence.ts` (evidence decision/gate), `hook-recall-payload.ts` (lean projection, reflex hits, budget), `deadline-shadow-row.ts` (also the `vector_late_settle` row) |
| `src/bash-pre-lane.ts` (Bash tripwire pipeline) | `bash-pre-analysis.ts` (command analysis, shim eligibility, hint), next to `bash-pre-patterns.ts` (tables) |
| `src/session-lane.ts` (SessionStart pipeline) | `session-format.ts` (hit merge, session/taxonomy blocks), `session-lane-telemetry.ts` (`session_hook_call` row, per-part tokens) |
| `src/stop-lane.ts` (Stop pipeline) | `stop-transcript.ts` (transcript loading/normalising), `stop-heuristics.ts` (save heuristics, suggestion format), `stop-lane-same-turn.ts` (same-turn hand-over: user notice, agent block) |
| `src/write-lane.ts` (PreToolUse Write/Edit pipeline) | `write-format.ts` (hint block), `write-lane-telemetry.ts` (`hook_call` row) |
| `src/settings.ts` (typed per-key accessors) | `settings-file.ts` (shape, validation, read/write, `mutateSettings`) |
| `src/telemetry-events.ts` (event types) | `telemetry-events-hook.ts` (hook rows), next to `-embedding` and `-code` |
| `src/rm-archive.ts` (archiving `rm` shim, manifest, receipt, restore) | `rm-archive-reconcile.ts` (retention per class, reconcile plan and apply, hourly stamp) |
| `src/cli/adapters/claude-code.ts` (install/uninstall/doctor) | `claude-code-hooks.ts` (hook definitions, settings.json entries, checks) |
| `scripts/stats.ts` (readout entry, runs on import) | `stats-context.ts` (context readouts), `stats-shared.ts` (leaf helpers) |
| `src/telemetry-report.ts` (telemetry report entry, 853 → 338 lines) | `telemetry-report-recall.ts` (recall quality, `summarizeQuality`), `telemetry-report-tokens.ts` (token readouts), `telemetry-report-shared.ts` (leaf helpers), next to `-code` and `-suppression` |
| `src/webui-areas.ts` (area routes, 957 → 184) | `webui-areas-rename.ts` (rename), `webui-areas-delete.ts` (delete), `webui-areas-shared.ts` (shared helpers) |
| `src/mcp-forwarder.ts` (MCP forwarder, 818 → 430) | `mcp-forwarder-calls.ts` (tool-call forwarding), `mcp-forwarder-statusline.ts` (statusline hand-over) |
| `src/import-vault.ts` (vault import, 809 → 644) | `import-vault-shared.ts` (shared helpers), `import-vault-fs-browse.ts` (filesystem browse) |
| `src/documents-write-handler.ts` (document write tools, 1775 → 210) | `documents-write-shared.ts` (shared checks and helpers), `documents-write-save.ts` (`save_document`), `documents-write-recategorize.ts` (`recategorize_document`), `documents-write-move.ts` (`move_document`) |
| `webui/js/renderer.js` (web UI renderer, 835 → 528) | `renderer-bolts.js` (bolts), `renderer-flow.js` (flow) |
| `src/tool-handlers.ts` (MCP tool handlers, 851 → 195) | `load-memory-handler.ts` (`load_memory`), `save-memory-handler.ts` (`save_memory`) |
| `tui/sections.ts` (statusline TUI sections, 1555 → 786; under `packages/statusline/src/`) | `tui/sections-bars.ts` (bars), `tui/sections-parts.ts` (parts), `tui/sections-shared.ts` (shared helpers) |
| `segments/renderer.ts` (statusline segment renderer, `SegmentRenderer` facade; 1020 → 754, #1039; under `packages/statusline/src/`) | `segments/renderer-types.ts` (config and output types), `segments/renderer-bars.ts` (progress-bar machinery), `segments/renderer-format.ts` (usage/budget and directory text helpers) |
| `powerline.ts` (`PowerlineRenderer`: the render flow; 1084 → 301, #1039; under `packages/statusline/src/`) | `powerline-theme.ts` (glyphs and colours), `powerline-segments.ts` (segment data, lazy providers, dispatch), `powerline-layout.ts` (measuring, fitting to width, ANSI line assembly) |
| `search.ts` (`SearchIndex`: state, index maintenance, recall orchestration; 1748 → 795, #1039; under `packages/core/src/`) | `search-types.ts` (`RecallHit`, `RecallOptions`, `IndexDoc`, `CueIndexOptions`), `search-anchor.ts` (`recall_when` match, anchor strength), `search-pipeline.ts` (recall filters, query cache, stage emitter, one-hop neighbours), `search-hybrid.ts` (dense-arm deadline race, RRF fusion), `search-staleness.ts` (lifecycle reranking, score gateway) |
| `src/telemetry.ts` (`Telemetry`: event writers, notices, dimensions; 1093 → 605, #1039) | `telemetry-join-state.ts` (`JoinState`: recall/hint/turn correlation, acted_on windows, `join-state.json` snapshot), `telemetry-sink.ts` (`EventSink`: the `events-*.jsonl` append) |
| `src/index.ts` (daemon entry; `main()` is the start-up sequence, 1110 → 256, #1039) | one module per start-up phase, called in this order: `boot-storage.ts` (vault, search index, Commons), `boot-recall-options.ts` (evidence gate, bridge pool), `boot-telemetry.ts` (telemetry, experiment, observers, curator demotions), `boot-embeddings.ts` (provider, breaker, warm-up, embedding index), `boot-tool-deps.ts` (shared tool deps), `boot-http.ts` (REST gateway), `boot-stdio.ts` (stdio MCP server), `boot-shutdown.ts` (graceful shutdown, signals) |

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
5. Normaler Erfolg und behandelte Konflikte entfernen die temporären Dateien und Lock-Dateien des Schreibers. Ein Prozess, der beendet wird, während er den Claim hält, kann den Lock zurücklassen; das Ziel ist trotzdem entweder die vollständige alte Datei oder die vollständige committete Datei, nie ein halber Schreibvorgang. Prüfe, dass kein Schreiber aktiv ist, bevor du einen solchen verwaisten Lock entfernst. Ein späterer Schreiber übernimmt ihn von selbst: sofort, wenn der Besitzerprozess auf diesem Rechner nicht mehr existiert, nach 30 Sekunden, wenn sich der Besitzer nicht prüfen lässt (anderer Rechner, unlesbarer Claim); ein Claim, dessen Besitzer-PID noch antwortet, gilt höchstens 10 Minuten (die PID eines toten Schreibers kann ein fremder Prozess wiederverwenden, „lebt“ ist also kein ewiger Beweis).

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

Jeder Schreiber unter dem Vault-Root (Saves, Dokumente, Locks, Audit-Log, Usage-Sidecar, Curator-Zustand, Embeddings, Journale) legt Verzeichnisse nur über `ensureVaultDir` in `packages/core/src/vault-root-guard.ts` an. Ein Root, der einmal da war, wird außerhalb des Vaults vermerkt, in `~/.bastra/vault-roots.json`. Fehlt ein vermerkter Root, ist das ein nicht eingehängtes Laufwerk: Es wird nichts angelegt, und `vault_missing` bleibt auf `/health` und im Recall stehen, auch über einen Neustart hinweg. Einen nie gesehenen Root legt nur ein Schreiber an, der einen Vault erzeugt (`saveMemory`, `save_document`, `createVaultAt`), und er sagt das ausdrücklich mit `createRoot`. Auch dann wird der Root nicht rekursiv angelegt, sondern nur unter einem vorhandenen übergeordneten Verzeichnis; fehlt es, stoppt der Schreibzugriff mit einem Fehler, der es nennt („mount the drive or create the parent directory first"). `createVaultAt` (Install mit `--vault`, Einrichtungsassistent) legt die übergeordneten Verzeichnisse vor dem Guard selbst an, weil der Nutzer diesen Pfad genannt hat, und nur für einen nie gesehenen Root. Ist die Marker-Datei leer oder beschädigt, oder ihr Verzeichnis nicht beschreibbar, stoppt der Guard jeden Schreibzugriff mit einem `VAULT_ROOT_HISTORY_UNAVAILABLE`-Fehler (derselbe Text in MCP `save_memory` und CLI), der Datei, Ursache und Reparatur nennt: Datei löschen, wenn der Vault eingehängt ist, oder die Verzeichnisrechte korrigieren.
Ist die Root-Historie beschädigt oder nicht lesbar, stoppen Schreiber, statt sie als leer zu behandeln. Ein Schreibzugriff setzt außerdem voraus, dass der Root erfolgreich vermerkt wurde; Unterordner werden einzeln angelegt, damit ein Root, der zwischen Prüfung und `mkdir` verschwindet, nicht rekursiv neu entsteht. Auf einer Maschine, die einen konfigurierten Root noch nie gesehen hat, bleibt ein fehlendes Laufwerk, dessen übergeordnetes Verzeichnis existiert, bis zur ersten erfolgreichen Präsenzprüfung von einem wirklich neuen Vault ununterscheidbar.
Unter macOS und Windows werden fehlende Roots zusätzlich ohne Groß-/Kleinschreibung mit vermerkten Pfaden verglichen; `Vault` und `vault` umgehen die Sperre auf einem case-insensitiven Volume damit nicht. Auf einem case-sensitiven Volume kann dies einen tatsächlich anderen Pfad vorsichtshalber stoppen. Symlink-Aliase brauchen bei fehlendem Ziel weiterhin dieselbe konfigurierte Schreibweise.

Temporäre Roots unter `os.tmpdir()` oder `/tmp` (einschließlich des macOS-Alias `/private/tmp`) behalten standardmäßig nur eine Historie im Prozess. Lesende Library-Aufrufe und Ad-hoc-Benchmarks tragen dadurch keine Wegwerf-Vaults in den Nutzer-Marker ein (#1071). Ein Symlink auf ein dauerhaftes Verzeichnis vermerkt den Root weiterhin. Mit `BASTRA_VAULT_ROOTS_PATH` lässt sich auch für temporäre Roots eine ausdrückliche Marker-Datei für mehrere Prozesse wählen; der Root-Test-Runner setzt bereits einen isolierten Marker. Ad-hoc-Skripte sollten mit isoliertem `HOME` und `TMPDIR` oder dem Preload `scripts/test-env.mjs` laufen, weil andere Zustandsschreiber eigene Defaults haben.

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

Auf dem hybriden Pfad ist der zurückgegebene `score` eine **Rang-Größe, keine Ähnlichkeit** (#230). `fuseRRF` (`packages/core/src/embeddings.ts`) summiert `1/(RRF_K + rank)` über beide Arme, und `recallHybrid` skaliert das Ergebnis mit `RRF_SCALE` in einen BM25-ähnlichen Bereich. `RRF_K` ist 5; es war 60 (der TREC-Standard), bis diese Konstante an Pools von 5–50 gemessen wurde, wo sie Übereinstimmung der Arme höher gewichtete als den Rang. `RRF_SCALE` ist an `RRF_K` gekoppelt, damit sich die beiden Ankerwerte unten nicht mit verschieben. Jeder Score lässt sich daher in ein Rangpaar zerlegen: Rang 1 in beiden Armen ist die strukturelle Obergrenze `2 × 5000/61 ≈ 163.934`. Rang 1 in nur einem Arm (die Arme sind sich völlig uneinig) hängt seit v1.0.1 vom Arm ab (`score_version: "rrf-2"`, Dense-Gewicht 1.5, #641): `0.8 × 5000/61 ≈ 65.6` nur BM25, `1.2 × 5000/61 ≈ 98.4` nur Vektor – ein Top-Treffer kann also berechtigt bei etwa 66 liegen. Unter `rrf-1` (v1.0.0, gleiche Gewichte, oder `BASTRA_RRF_VECTOR_WEIGHT=1`) lagen beide bei `5000/61 ≈ 81.967`. Zwei Scores sind nur bei gleicher `score_version` vergleichbar. Ein Top-Treffer ist *konstruktionsbedingt* hoch: Eine Liste hat immer ein erstes Element, auch wenn die ehrliche Antwort „hier ist nichts“ lautet, daher kann selbst eine unsinnige Anfrage einen Score über 130 haben. Zwei Folgen:

- Die dokumentierte `min_score`-Untergrenze (Standard 30) ist auf dem hybriden Pfad sehr schwer zu erreichen: Ein Treffer braucht etwa Rang 28 in **beiden** Armen, um darunter zu fallen (beim alten `RRF_K = 60` war es Rang 273). Die Untergrenze ist hauptsächlich im reinen BM25-Modus (ohne Embeddings) aussagekräftig, wo der Score eine echte BM25-Größe ist. Beachte, dass sich die Band-Grenzen mit `RRF_K` verschieben, obwohl die Ankerwerte gleich bleiben – die Schnitte sind absolut, die Kurve zwischen den Ankern nicht. Eine Telemetrie-Reihe über `band` ist daher über eine Änderung dieser Konstante hinweg nicht vergleichbar. Dasselbe gilt für `BASTRA_RRF_VECTOR_WEIGHT` (#641, Standard `1.5` seit v1.0.1, `1` stellt die gleichen Gewichte von v1.0.0 wieder her): Es gewichtet den Dense-Arm gegen BM25, so normiert, dass Rang 1 in beiden Armen bei 163.934 bleibt; ein einarmiger Rang 1 liegt dann aber über 81.967 (Dense) oder darunter (BM25).
- `recall` liefert auf oberster Ebene `weak_result: true`, wenn auf dem hybriden Pfad kein zurückgegebener Treffer einen Treffer in `recall_when` oder im Titel hat – ein ausdrückliches „hier ist nichts“-Signal neben dem Rang-1-von-nichts-Score. Es ist rein informativ und filtert nichts. Mit `verbosity: "full"` trägt jeder Treffer zusätzlich `rrf: { rank_bm25, rank_vector, raw }`, damit Aufrufer das Rangpaar sehen, aus dem der Score gebildet wird.

**Die Obergrenze ist keine einzelne Zahl, deshalb benennt die Antwort ihre Arme.** `163.934` ist die Obergrenze der *zwei persönlichen Arme*. Wenn die Bastra Commons aktiv sind, fließen sie als **dritter Arm** ein (`commons-fusion.ts`), und die Obergrenze steigt auf `163.934 + 0.95 × 81.967 ≈ 241.803`; auf dem degradierten Collapse-Pfad (persönlicher Arm nicht fusioniert, nur sein Listenrang geht ein) ist sie stattdessen `81.967 + Gewicht × 81.967` – `147.541` beim Standard-Commons-Gewicht `0.8`, `159.836` an der Kappe `0.95`. Alle drei bezeichnen sich als `score_kind: "rrf"`, daher macht `score_kind` allein zwei Zahlen nicht vergleichbar. Jede Antwort trägt deshalb `score_arms` (sortiert: `["bm25","vector"]`, `["bm25","commons","vector"]`, `["commons","personal-rank"]`) und `score_version` – die Formelversion, die erhöht wird, sobald dieselbe Arm-Menge eine andere Zahl liefert. **Vergleiche Scores nur innerhalb eines identischen Paars aus `score_version`/`score_arms`; darüber hinweg wird nach RANG neu fusioniert.** Batch-Recall macht genau das: Teilergebnisse mit unterschiedlichen Signaturen werden über `query-rank-fusion` zusammengeführt, und die Antwort fällt auf `unfused` zurück, denn ein Band, das in einer Liste das eine und in der nächsten etwas anderes bedeutet, ist kein Band. Mit `verbosity: "full"` trägt ein Treffer, zu dem die Commons beigetragen haben, zusätzlich `rrf: { rank_commons, commons_weight, personal_score }` – `personal_score` ist das, was derselbe Recall ohne sie geliefert hätte.

**Query-Router (#362), seit v1.0.1 scharf.** `routeQueryArms` (`packages/core/src/query-router.ts`) entscheidet je Anfrage, ob der dichte Arm etwas beitragen kann: kurze Anfragen (höchstens zwei Wörter, gezählt mit `Intl.Segmenter`, damit ein Satz in einer Schrift ohne Leerzeichen mehrere Wörter ist) und bezeichnerförmige Anfragen (mindestens die Hälfte der Leerzeichen-Terme trägt inneren Kleber `._/\:`, Binnenmajuskel oder Buchstabe neben Ziffer) laufen nur über BM25; alles andere bleibt hybrid. Beide Regeln sind strukturell, ohne Wortliste. `BASTRA_QUERY_ROUTER` steht per Default auf `live` (Owner-Entscheid 29.09.2026) und lässt den dichten Arm für geroutete Anfragen weg; `shadow` schreibt nur `query_route` mit `would_save_ms` (Wartezeit auf den dichten Arm nach BM25) an `hook_recall`. Auf Gold-Set-Lauf A (`npm run router-lift`, eval: Baseline, geroutet, Kontrolle) routet der Router 17 von 699 Anfragen, keine Kennzahl fällt unter die Baseline, und geroutete Anfragen sinken von p50 14,8 ms auf 5,8 ms; den p90-Schwanz der Prompt-Lane berührt er nicht, der kommt von langen Prompts (Design 5d54c63, #362).

#### Mehrstufiger Abruf

Wird `expand_hops: 1` übergeben, ergänzt Recall direkte Nachbarn aus `frontmatter.related_via`. Diese Nachbarn werden mit denselben Regeln für obsolete/scope/type/sensitivity gefiltert und erhalten einen reduzierten Score.

`RelatedEnricher` kann `related_via` nach Embedding-Batches automatisch pflegen. Er hängt außerdem einen automatisch verwalteten Abschnitt mit Obsidian-Wikilinks an den Body der Erinnerung an, begrenzt durch Marker-Kommentare, damit manuelle und automatische Links getrennt bleiben.

#### Eine Recall-Pipeline für Hooks und MCP (#421)

Hook-Lanes und MCP-`recall` teilen die Auswahlschritte in `packages/daemon/src/recall-pipeline.ts`; was sich unterscheidet, sind Parameter, nicht der Code:

- **Reflex-Hits.** Vom Nutzer als `recall_mode: reflex` verdrahtete Erinnerungen, die im tieferen Kandidatenpool unter dem top-k-Schnitt liegen, kommen auf jedem Weg als `reflex_hits` zurück — über `/hook/recall` (Hook-Lanes und MCP-Forwarder, der das Feld früher in seiner Projektion verwarf) und über den `recallHandler` des stdio-Servers. Der MCP-Weg wendet seinen eigenen `min_score`-Floor auf sie an; der Hook-Weg reicht sie ungefiltert durch, weil die Lanes ihren eigenen Floor haben. Batch-Recall vereinigt sie über die Phrasierungen. `max_tokens` zählt sie mit, gerankte Treffer fallen zuerst.
- **Projekt-Scope-Filter.** Der Filter der Prompt-Lane (Anker-Ausnahme für Cross-Scope, Reflex-Treffer ausgenommen, Ausnahme ohne Fusion zu, `project_known` aus dem Vault) läuft jetzt auch für MCP-Aufrufer: Der Forwarder schickt das Projekt seines Clients (`projectForFilter(cwd)`, dasselbe Konfidenz-Gate wie in den Lanes) mit `apply_scope_filter: true`, der stdio-Server gibt sein eigenes cwd mit. Ein explizites `scope`-Argument schaltet ihn ab (`scope_filter_skipped: "explicit-scope"`). Die Stufe ist der Schalter der Lanes, `BASTRA_SCOPE_FILTER_LANES`: `shadow` (Default) schreibt nur `scope_filter_mode`/`dropped_scope_count`/`dropped_scopes`/`filter_project` an die `recall`- bzw. `hook_recall`-Zeile, `enforce` verwirft. Hook-Lanes setzen `apply_scope_filter` nicht und filtern weiter selbst; ihre Antworten und Telemetriezeilen bleiben unverändert.

Noch getrennt, verfolgt in #421: Evidenz-Gate und Deadline-Schatten laufen nur auf `/hook/recall` (nicht im stdio-`recallHandler` und nicht auf `/api/v1/recall`), der REST-Weg kennt kein Aufrufer-Projekt, Commons-Fusion und `verbosity: "full"` gibt es nur im `recallHandler`, und der GET-Weg des Session-Kontexts fährt weiterhin den `recallHandler`.

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
2. gibt nach fehlgeschlagenem Health-Check einem verwalteten macOS-Dienst bis zu 10 Sekunden, bevor er selbst startet; `BASTRA_FORWARDER_SPAWN=0` schaltet Start und dieses Dienst-Warten weiterhin aus;
3. stellt MCP-Werkzeuge über stdio bereit;
4. leitet jeden Werkzeugaufruf an `/api/v1/<tool>` weiter.

So können mehrere MCP-Clients einen einzigen Daemon, Index, eine Embedding-Warteschlange und einen Telemetrie-Strom teilen.

**Die Umgebung eines automatisch gestarteten Daemons (#684).** Der gestartete
Daemon gehört allen Clients, daher übernimmt er die Umgebung des startenden
Clients nicht unverändert (`packages/daemon/src/daemon-spawn-env.ts`).
Schlüssel, die nur ein Client liest, fallen weg: `BASTRA_TOOL_SURFACE`,
`BASTRA_MCP_SESSION_CONTEXT`, `BASTRA_HOOK_TIMEOUT_MS` (die Hook-Lanes des
Daemons lesen ihn, also legte der Eintrag eines Clients das Budget jeder Lane
fest), `BASTRA_FORWARDER_SPAWN`, `BASTRA_HOOK_CLIENT`. Daemon-Verhalten, das es
nur als Umgebungsvariable gibt — `BASTRA_TRIGGER_EXPAND`,
`BASTRA_PROMPT_HOOK_MODE`, `BASTRA_DOCUMENT_WRITE`, `BASTRA_RM_ARCHIVES`,
`BASTRA_OLLAMA_URL` —, lässt sich in `~/.bastra/cli-settings.json` festlegen:

```json
{ "daemon": { "env": { "BASTRA_TRIGGER_EXPAND": "0", "BASTRA_PROMPT_HOOK_MODE": "all" } } }
```

Ein festgelegter Wert hat Vorrang vor dem des Clients; andere Schlüssel werden
mit einer Warnung ignoriert. Trägst du dort dieselben Werte ein wie in deiner
Service-Unit oder deinem LaunchAgent, läuft ein Daemon, den ein Client startet,
während der Service steht, mit derselben Konfiguration. Ein vom Service
gestarteter Daemon behält seine eigene Umgebung; das hier formt nur den Start
durch den Forwarder. `/health` meldet `started_by` (`forwarder`, `launchagent`,
`systemd` — erkannt an `INVOCATION_ID` — oder `direct`) und `env_origin`
(`own`, `client`, `client+settings`), und `bastra doctor` zeigt beides unter
„daemon origin". Auf macOS bekommt eine installierte verwaltete XML-plist eine Health-Frist von 10 Sekunden, ohne Prüfung des geladenen Jobs oder neue Einstellung; danach erfolgt bei Bedarf der Ersatzstart mit einmaliger Diagnose im stderr-Debug-Log. Ein Forwarder-Daemon hält den Port bis zum Leerlauf-Ende (standardmäßig 30 min), auch bei registriertem LaunchAgent. Ein Starter ohne Terminal, der kein Forwarder ist, versucht es vor dem Storage-Start erneut: Abstände 1/2/4/8/16/30 Sekunden, höchstens 30 Sekunden, ohne Gesamtfrist. Health-Abfragen gelten nicht als Aktivität. Kein Shutdown-Handschlag. Unter Linux kann bis zur verwalteten Einrichtung aus #566 weiter der Client zuerst starten; `BASTRA_FORWARDER_SPAWN=0` bleibt eine Notlösung.

Wer den Daemon gestartet hat, sagt noch nicht, ob seine Konfiguration abweicht.
Deshalb meldet `/health` zusätzlich `config_fingerprint`: zwölf Hex-Zeichen über
die Verhaltenseinstellungen des Daemons. Das ist jede `BASTRA_*`-Variable in
seiner Umgebung, ausgenommen die oben genannten Client-Schlüssel, alles dazu,
wie und wo der Prozess läuft (`BASTRA_DAEMON_*`, der HTTP-Port, die
Autostart-Marke), Pfade (`*_PATH`, `*_DIR`, `*_BIN`) und Geheimnisse (`*_KEY`,
`*_TOKEN`; eine URL zählt ohne ihre Zugangsdaten). Die Reihenfolge der
Schlüssel spielt keine Rolle, ein leerer Wert gilt als nicht gesetzt.
`bastra doctor` berechnet denselben Fingerprint über den konfigurierten Stand —
die `daemon.env`-Werte, auf macOS zusätzlich die Umgebung des LaunchAgents, den
`bastra autostart on` geschrieben hat — und gibt unter „daemon origin" eine
Warnung aus, wenn der des laufenden Daemons abweicht; stimmen beide überein,
zeigt es den Fingerprint und sagt das dazu. Der Exit-Code ändert sich nicht.
Ohne `daemon.env`-Werte und ohne verwalteten LaunchAgent gibt es nichts zu
vergleichen (die Umgebung einer systemd-Unit ist vom CLI aus nicht lesbar),
und doctor zeigt nur den Fingerprint. Eine Abweichung heißt: Die beiden
Startwege laufen nicht mit denselben Einstellungen. Trag sie an beiden Stellen
ein und starte den Daemon neu. Welche Einstellung abweicht, verrät der
Fingerprint nicht.

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

Werkzeug für Code-Awareness (#576; experimentell, siehe #667):

| Werkzeug | Zweck |
|---|---|
| `find_code` | Symbol oder Datei im Code-Graphen des Repositories finden und einen Hop Abhängige auflisten |

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
| `/api/v1/find_code` | `POST` | REST-Wrapper für `find_code` |
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

#### Modulkarte (#680)

Dateien über der 800-Zeilen-Konvention wurden entlang je einer Verantwortung geteilt; die Ursprungsdatei behält die Orchestrierung und re-exportiert ihre öffentliche Oberfläche, Importpfade bleiben also gleich. Alle Pfade unter `packages/daemon/`, sofern nicht anders angegeben.

| Modul | Ausgelagerte Nachbarmodule |
|---|---|
| `src/prompt-lane.ts` (UserPromptSubmit-Pipeline) | `prompt-classify.ts` (Moduserkennung, Trivial-Gate, Score-Floors), `prompt-format.ts` (Hinweisblöcke), `prompt-lane-telemetry.ts` (`prompt_hook_call`-Zeile), `prompt-loopback.ts` (Selbstaufruf) |
| `src/http-hook-routes.ts` (`/hook/recall`-Route + `runHookRecall`) | `hook-recall-input.ts` (Request-Felder), `hook-content-recall.ts` (Content-Recall + Merge-Gate), `hook-recall-evidence.ts` (Evidenzentscheid/-Gate), `hook-recall-payload.ts` (Lean-Projektion, Reflex-Hits, Budget), `deadline-shadow-row.ts` (auch die `vector_late_settle`-Zeile) |
| `src/bash-pre-lane.ts` (Bash-Stolperdraht-Pipeline) | `bash-pre-analysis.ts` (Befehlsanalyse, Shim-Eignung, Hinweis), neben `bash-pre-patterns.ts` (Tabellen) |
| `src/session-lane.ts` (SessionStart-Pipeline) | `session-format.ts` (Treffer-Merge, Session-/Taxonomie-Block), `session-lane-telemetry.ts` (`session_hook_call`-Zeile, Token je Teil) |
| `src/stop-lane.ts` (Stop-Pipeline) | `stop-transcript.ts` (Transkript laden/normalisieren), `stop-heuristics.ts` (Save-Heuristiken, Vorschlagsformat), `stop-lane-same-turn.ts` (Übergabe im selben Turn: Nutzerhinweis, Agentenblock) |
| `src/write-lane.ts` (PreToolUse-Write/Edit-Pipeline) | `write-format.ts` (Hinweisblock), `write-lane-telemetry.ts` (`hook_call`-Zeile) |
| `src/settings.ts` (typisierte Zugriffe je Schlüssel) | `settings-file.ts` (Form, Validierung, Lesen/Schreiben, `mutateSettings`) |
| `src/telemetry-events.ts` (Ereignistypen) | `telemetry-events-hook.ts` (Hook-Zeilen), neben `-embedding` und `-code` |
| `src/rm-archive.ts` (archivierendes `rm`: Shim, Manifest, Quittung, Wiederherstellen) | `rm-archive-reconcile.ts` (Aufbewahrung je Klasse, Reconcile-Plan und -Ausführung, Stundenstempel) |
| `src/cli/adapters/claude-code.ts` (Install/Uninstall/Doctor) | `claude-code-hooks.ts` (Hook-Definitionen, settings.json-Einträge, Prüfungen) |
| `scripts/stats.ts` (Auswertungs-Einstieg, läuft beim Import) | `stats-context.ts` (Kontext-Auswertungen), `stats-shared.ts` (Blatt-Helfer) |
| `src/telemetry-report.ts` (Telemetrie-Report-Einstieg, 853 → 338 Zeilen) | `telemetry-report-recall.ts` (Recall-Qualität, `summarizeQuality`), `telemetry-report-tokens.ts` (Token-Auswertungen), `telemetry-report-shared.ts` (Blatt-Helfer), neben `-code` und `-suppression` |
| `src/webui-areas.ts` (Bereichs-Routen, 957 → 184) | `webui-areas-rename.ts` (Umbenennen), `webui-areas-delete.ts` (Löschen), `webui-areas-shared.ts` (gemeinsame Helfer) |
| `src/mcp-forwarder.ts` (MCP-Forwarder, 818 → 430) | `mcp-forwarder-calls.ts` (Weiterleitung der Tool-Aufrufe), `mcp-forwarder-statusline.ts` (Übergabe an die Statusline) |
| `src/import-vault.ts` (Vault-Import, 809 → 644) | `import-vault-shared.ts` (gemeinsame Helfer), `import-vault-fs-browse.ts` (Dateisystem-Browse) |
| `src/documents-write-handler.ts` (Dokument-Schreibwerkzeuge, 1775 → 210) | `documents-write-shared.ts` (gemeinsame Prüfungen und Helfer), `documents-write-save.ts` (`save_document`), `documents-write-recategorize.ts` (`recategorize_document`), `documents-write-move.ts` (`move_document`) |
| `webui/js/renderer.js` (Web-UI-Renderer, 835 → 528) | `renderer-bolts.js` (Bolts), `renderer-flow.js` (Flow) |
| `src/tool-handlers.ts` (MCP-Tool-Handler, 851 → 195) | `load-memory-handler.ts` (`load_memory`), `save-memory-handler.ts` (`save_memory`) |
| `tui/sections.ts` (Statusline-TUI-Abschnitte, 1555 → 786; unter `packages/statusline/src/`) | `tui/sections-bars.ts` (Balken), `tui/sections-parts.ts` (Teile), `tui/sections-shared.ts` (gemeinsame Helfer) |
| `segments/renderer.ts` (Statusline-Segment-Renderer, Fassade `SegmentRenderer`; 1020 → 754, #1039; unter `packages/statusline/src/`) | `segments/renderer-types.ts` (Konfigurations- und Ausgabetypen), `segments/renderer-bars.ts` (Fortschrittsbalken), `segments/renderer-format.ts` (Text-Helfer für Nutzung/Budget und Verzeichnis) |
| `powerline.ts` (`PowerlineRenderer`: Render-Ablauf; 1084 → 301, #1039; unter `packages/statusline/src/`) | `powerline-theme.ts` (Glyphen und Farben), `powerline-segments.ts` (Segmentdaten, Lazy-Provider, Dispatch), `powerline-layout.ts` (Messen, Anpassen an die Breite, ANSI-Zeilenaufbau) |
| `search.ts` (`SearchIndex`: Zustand, Indexpflege, Recall-Orchestrierung; 1748 → 795, #1039; unter `packages/core/src/`) | `search-types.ts` (`RecallHit`, `RecallOptions`, `IndexDoc`, `CueIndexOptions`), `search-anchor.ts` (`recall_when`-Treffer, Anker-Stärke), `search-pipeline.ts` (Recall-Filter, Query-Cache, Stage-Emitter, Ein-Hop-Nachbarn), `search-hybrid.ts` (Deadline-Rennen des Dense-Arms, RRF-Fusion), `search-staleness.ts` (Lifecycle-Reranking, Score-Gateway) |
| `src/telemetry.ts` (`Telemetry`: Ereignis-Schreiber, Notices, Dimensionen; 1093 → 605, #1039) | `telemetry-join-state.ts` (`JoinState`: Korrelation von Recall, Hinweis und Turn, acted_on-Fenster, Snapshot `join-state.json`), `telemetry-sink.ts` (`EventSink`: Anhängen an `events-*.jsonl`) |
| `src/index.ts` (Daemon-Einstieg; `main()` ist die Startreihenfolge, 1110 → 256, #1039) | ein Modul je Startphase, in dieser Reihenfolge aufgerufen: `boot-storage.ts` (Vault, Suchindex, Commons), `boot-recall-options.ts` (Evidenz-Gate, Bridge-Pool), `boot-telemetry.ts` (Telemetrie, Experiment, Beobachter, Curator-Demotions), `boot-embeddings.ts` (Provider, Breaker, Warmup, Embedding-Index), `boot-tool-deps.ts` (gemeinsame Tool-Abhängigkeiten), `boot-http.ts` (REST-Gateway), `boot-stdio.ts` (stdio-MCP-Server), `boot-shutdown.ts` (geordnetes Herunterfahren, Signale) |

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
