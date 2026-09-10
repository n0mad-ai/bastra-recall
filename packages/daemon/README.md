# @bastra-recall/daemon

The MCP server + HTTP gateway behind bastra-recall. Watches a markdown vault, indexes it with BM25 + optional embeddings, and exposes a stable tool surface over both stdio MCP and HTTP REST.

For project-level docs (vision, install, REST API, roadmap), see the [top-level README](../../README.md) and [PLAN.md](../../PLAN.md).

## What it does

- Watches a directory of `.md` files with YAML frontmatter (schema in [`../../docs/memory-schema.md`](../../docs/memory-schema.md)).
- Indexes via [`minisearch`](https://github.com/lucaong/minisearch) BM25; `recall_when` is the highest-weighted field because it's authored for triggering.
- **Hybrid recall**: optional embeddings (Ollama or OpenAI) via Reciprocal Rank Fusion on top of BM25 — see `BASTRA_EMBEDDING_PROVIDER`.
- **Save path**: writes `.md` files, validates frontmatter (zod), force-reindexes so save+recall in the same turn are consistent.
- **Auto-related enricher**: for each new save, fills `related_via` with cosine ≥0.7 neighbors.
- **Memory graph**: multi-hop recall (`expand_hops: 1`) returns 1-hop neighbors via `related_via`.
- **Sensitivity filter**: `private` memories aren't visible to external MCP callers.
- **Staleness re-ranking**: memories with `valid_until` / `expires_after_days` / `last_reviewed_at` get demoted (or excluded if expired) at recall time.

## Surfaces

| Surface | Entry point | Use case |
|---|---|---|
| MCP (stdio, standalone) | `dist/index.js` | Single-client setup; each session spawns its own embedded daemon |
| MCP forwarder (stdio → loopback HTTP) | `dist/mcp-forwarder.js` | **Default for multi-client setups.** Auto-spawns the daemon on first call if none is listening. All sessions share one vault state, one index, one telemetry stream |
| HTTP REST | `http://127.0.0.1:6723/api/v1/{tool}` | Non-MCP clients (ChatGPT Custom GPT Actions, web apps, scripts). Bearer auth + CORS supported |
| Hooks | `dist/hook.js` (PreToolUse), `dist/session-hook.js` (SessionStart) | Both POST to the daemon's `/hook/recall` |
| CLI | `dist/cli.js` (`bastra` bin) | Install / uninstall / doctor across every supported AI client |

## Tools exposed (MCP + REST symmetric)

| Tool | Purpose |
|---|---|
| `recall(query, k?, scope?, type?, expand_hops?, allow_private?)` | Search the vault; hybrid BM25 + embeddings when enabled |
| `load_memory(id, allow_private?)` | Fetch full frontmatter + body |
| `save_memory({title, type, body, …})` | Write a new memory with schema validation + force-reindex |
| `find_document(query, k?)` | Search documents (PDFs, photos, contracts) |
| `read_document(id)` | Load extracted text + metadata for a document |
| `open_document(id)` | macOS-only: open in the system handler |
| `save_document` / `recategorize_document` / `move_document` | Document write path (Pro Mac-app uses this; OSS callers may need `BASTRA_DOCUMENT_WRITE=1`) |

## Install + register

See the [top-level README](../../README.md). Paths, in order of friction:

1. **`curl -fsSL https://bastra.io/install | bash`** — installs Homebrew + tap + binary + runs the guided setup. The recommended non-developer path.
2. **`Install Bastra.command` doubleclick** — same steps, but a browser download is quarantined and mode 644, so it needs right-click → Open (#320).
3. **`bastra install all`** — single CLI call that registers MCP + Skill + the default quiet Hooks across Claude Code, Claude Desktop, Codex/ChatGPT Desktop, and Cursor. On a first run with no vault configured, an interactive install offers to create `~/BastraVault` for you (non-interactive/`--yes`/`--dry-run` runs keep the deterministic error).
4. **Fully manual JSON snippets** — fallback.

All paths end with the daemon reachable on `http://127.0.0.1:6723` and the client configs patched.
Use `bastra doctor --fix` to repair stale paths, missing required hooks, or a
stale Skill copy after an update. The Stop save-eval hook is optional; disabling
it intentionally does not make Doctor fail. Enable it explicitly with
`bastra install claude-code --with-stop-hook`.

## Daemon process check

Don't grep for `daemon/dist/index.js` — the daemon is often launched with a relative path (`node dist/index.js`) and won't match. Use the port instead:

```bash
lsof -i :6723 -P -n      # who owns the daemon port
curl -sS http://127.0.0.1:6723/health
```

Exactly one PID should be listed. Two means a stale daemon is running in parallel — the HTTP port goes to whichever bound first, and the loser exits silently (see http.ts EADDRINUSE handler).

## Daemon startup

The MCP forwarder auto-spawns one shared daemon on first use. For REST clients
that need the daemon before an MCP client connects, start it explicitly:

```bash
bastra-recall &
```

## Dev workflow

```bash
npm run dev                # ts-watch via tsx (no compile step)
npm run build              # tsc + chmod +x all dist binaries
npm run check:types        # type-check only
npm run smoke              # smoke-test recall against fixtures/sample-vault
npm run smoke:telemetry    # smoke-test telemetry append
npm run backfill:related   # populate related_via on legacy memories
```

## Configuration (environment variables)

| env var | required | default | meaning |
|---|---|---|---|
| `BASTRA_VAULT_PATH` | yes | — | absolute path to the vault root (memories are auto-discovered) |
| `BASTRA_HTTP_PORT` | no | `6723` | loopback HTTP port for REST + hooks |
| `BASTRA_HTTP_URL` | no | derived | full URL override (for non-loopback testing) |
| `BASTRA_API_TOKEN` | no | unset | when set, REST `/api/v1/*` requires `Authorization: Bearer <token>` |
| `BASTRA_AUTH_LOOPBACK_SKIP` | no | `1` | set to `0` to require the bearer even for 127.0.0.1 callers |
| `BASTRA_CORS_ORIGIN` | no | unset (deny all) | comma-separated browser-origin allowlist; unset = no browser origin allowed; `*` = explicit permissive opt-in (tunnel/dev) |
| `BASTRA_EMBEDDING_PROVIDER` | no | unset | `ollama` or `openai`; without it the daemon stays BM25-only |
| `BASTRA_EMBEDDING_MODEL` | no | provider default | e.g. `embeddinggemma` (ollama) or `text-embedding-3-small` (openai) |
| `BASTRA_OLLAMA_URL` | no | `http://localhost:11434` | ollama provider endpoint |
| `BASTRA_ALLOW_REMOTE_OLLAMA` | no | unset | allow a non-loopback `BASTRA_OLLAMA_URL`; without it the daemon refuses a remote endpoint, so a mistyped URL never sends memory text off-box (guards both the embedding provider and the reranker) |
| `BASTRA_OLLAMA_KEEP_ALIVE` | no | `10m` | per-request `keep_alive` window — how long Ollama keeps the embedding model in RAM after each embed |
| `BASTRA_OLLAMA_IDLE_UNLOAD_MS` | no | `600000` (10 min) | unload the embedding model from Ollama RAM after this long without an embed (battery saver); `0` disables |
| `OPENAI_API_KEY` | no | unset | required when `BASTRA_EMBEDDING_PROVIDER=openai` |
| `BASTRA_FORWARDER_SPAWN` | no | `1` | when `0`, the MCP forwarder will not auto-spawn the daemon. Set this when a service manager (launchd, systemd) owns the daemon, together with `BASTRA_DAEMON_URL` naming that owner — a spawned second process exits as soon as it sees the port taken (#483), but not starting it at all is cheaper |
| `BASTRA_DAEMON_URL` | no | `http://127.0.0.1:6723` | which daemon the MCP forwarder talks to |
| `BASTRA_HOOK_TIMEOUT_MS` | no | `500` | per-hook wall-clock budget before fail-silent |
| `BASTRA_VECTOR_DEADLINE_MS` | no | `150` | hook path only: how long a recall waits for the dense arm before serving BM25-only. Bounds that stage, not the call — measured warm the arm costs 87–96ms (total 106–113ms), cold 668ms (total 694ms), so 150ms passes every warm call and caps a cold one near 180ms. The embed is abandoned, not cancelled, so the model still finishes loading and the next call is warm. Degradations are visible as `degraded: "vector-arm-timeout"`; `0` disables (kill switch) |
| `BASTRA_HOOK_MAX_SHOW` | no | `1` | how often the same memory may appear in `<recall-hints>` per session (4h window); a `load_memory` of that id resets the counter |
| `BASTRA_HOOK_CONTENT_RECALL` | no | `off` | set to `1` to run the opt-in edit-content recall arm (#282) |
| `BASTRA_DOCUMENT_WRITE` | no | unset | set to `1` to expose document write tools |
| `BASTRA_LOG_PATH` | no | `~/.bastra/logs` | telemetry JSONL output directory (out-of-vault on purpose) |
| `BASTRA_TELEMETRY` | no | `on` | set to `off` to disable telemetry writes entirely |

## Telemetry

Every `recall`, `load_memory`, `save_memory` and hook call appends one JSON line to `events-YYYY-MM-DD.jsonl` in the log dir. Each daemon process gets a fresh `session_id`; recalls get a `recall_id` and any `load_memory` / `save_memory` within 5 minutes references that id as `follows_recall`.

That's enough to compute:

- recalls per session, hit counts, top-score distribution, latency p50/p95
- recall→load_memory follow-through rate (proxy for "was the hint useful?")
- saves per session, type/scope distribution, % overwrite vs. new
- save→follows_recall rate (was a duplicate-check done?)
- per-hook latency and hit-quality (where do PreToolUse / SessionStart actually help?)

Logs live outside the vault on purpose so the file watcher doesn't index them. Tail one to watch live: `tail -f ~/.bastra/logs/events-$(date +%F).jsonl`.

## Search ranking

Field boosts (in `src/search.ts`):

```
recall_when_flat: 5    ← authored for triggering, highest weight
title:            4
tags_flat:        3
topic_path_flat:  2
summary:          2
body:             1
```

Fuzzy distance 0.2, prefix matching enabled, `combineWith: "OR"`. Hybrid mode combines BM25 with embedding cosine via Reciprocal Rank Fusion (RRF); the embedding query goes to the provider once per recall and is cached in-memory.

## Schema reference

See [`../../docs/memory-schema.md`](../../docs/memory-schema.md) for the full memory frontmatter spec. The daemon enforces required fields via [`zod`](https://zod.dev) on load — files that fail validation are skipped with a warning to stderr.

## Limitations

- **Single-process.** The forwarder auto-spawns one daemon on first call (detached via `nohup` + `disown`, reparents to `launchd`). A LaunchAgent plist template covers autostart at login.
- **Cloud-storage mounts** (Google Drive, iCloud, Dropbox) need polling-mode in chokidar — enabled by default, but watcher latency can be a few seconds.
- **Cursor Rules layer** (`.cursor/rules/*.mdc`) is not yet generated by `bastra install cursor` — only the MCP server registration. Tracked on the roadmap.
