# Usage guide / Nutzungshandbuch

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

Set up your clients, bring in existing memories and use Bastra Recall in everyday work. Start with the [README](../README.md#install) for guided installation; this guide covers examples, manual configuration, the REST API and troubleshooting.

### Cookbook

What this actually looks like in a working week.

**1. The convention you stop re-explaining.** You tell Claude Code once that this repo puts route handlers, business logic and DB access in separate files. It saves a `preference` scoped to the project. Six sessions later, in a file it has never opened, the PreToolUse hook surfaces that rule *before* it writes the handler — and it splits the file without being asked.

**2. The bug that only bites twice.** A focus-ring bug takes four iterations to pin down: stacked `:focus` styles on a nested input. When it's fixed, the fix and the *failed path* go in as a `lesson` with `recall_when: ["creating new input component", "writing input or form css"]`. The next time anyone touches an input, the wrong turn is already on the table.

**3. One vault, two tools.** You work out a deployment sequence with Claude Code on Monday. On Thursday you're in another MCP client, ask "how do we ship this again", and get your own Monday answer back — same daemon, same vault, no export step.

**4. The preference that isn't about code.** "German, du-Form, terse, no closing summaries" is a `user-preference`. It costs one save and applies in every project and every client from then on — including the ones you set up next month.

**5. Recall before the plan, not after it.** Ask for a multi-step plan in an area you haven't touched in weeks, and the session hook pulls the topology memory for that subsystem first: which files matter, what was deliberately left undone. The plan starts from where you left off instead of from a fresh reading of the repo.

Memories are plain files — write them by hand in Obsidian if you'd rather, or let the AI save them and correct what it got wrong.

### The Claude Code reflex layer in detail

Seven quiet hooks ship by default, all speaking to the daemon's loopback HTTP endpoint:

- **`PreToolUse`** (`bastra-recall-hook`) — fires before every `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. Topic-detects from the tool intent and injects `<recall-hints>` as `additionalContext`.
- **`SessionStart`** (`bastra-recall-session-hook`) — fires on `startup`/`resume`/`clear`/`compact`. Preloads top user-prefs + cross-project rules + project-scoped memories as `<session-context>` so the AI knows who, what, and what-not from the first prompt.
- **`UserPromptSubmit`**, **`TaskCreate`/`TodoWrite`/`ExitPlanMode`**, **Bash safety**, and **Bash failure** hooks cover lookup prompts, topology recall before plans, destructive-command safety, and command-failure lesson recall.

The **`Stop`** save-eval hook is on by default. In Claude Code a suggestion goes back to the agent in the same turn as Stop-hook feedback, once per heuristic per session, so it can save while the conversation is still there (#662); Codex gets it at the next session start via a file (#48). `bastra install` registers Claude Code's `SessionEnd` hook together with it, so a finished session is harvested on the next pass ([after-session harvest](./hooks.md), #675). Opt out of both with `bastra install claude-code --no-stop-hook`. Telemetry (`scripts/stats.ts`) tracks per-hook latency, hint-quality, and follow-through (did the AI actually `load_memory` after a hint).

The hook entry points can run as a **compiled client** (`bastra-hook`, built with `deno compile`, #344) instead of a `node` process, which takes the interpreter start out of every hook call. Plain npm installs get it on demand: `bastra install claude-code` asks once whether to download it (~70 MB, one GitHub Release asset per platform — macOS arm64/x64, Linux x64/arm64 — verified against the sha256 manifest shipped inside the package), `--stub` takes it without asking, `--no-stub` keeps the node client. The answer is remembered across updates. Without the binary every hook runs on the node client: same daemon lanes, just a slower start.

More: [architecture.md](./architecture.md), [hooks.md](./hooks.md), [triggers.md](./triggers.md), [Codex + ChatGPT Desktop](./CODEX.md).

### Fully manual install — fallback

Add the MCP server block to your client's config (`~/.claude.json` for Claude Code, `~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop, `~/.cursor/mcp.json` for Cursor).

Codex and ChatGPT Desktop share TOML rather than these JSON blocks. Use `bastra install codex` (recommended) or the official `codex mcp add` flow documented in [CODEX.md](./CODEX.md).

**Recommended (forwarder mode — shares one daemon across all sessions):**

```json
"bastra-recall": {
  "command": "node",
  "args": ["/abs/path/to/bastra-recall/packages/daemon/dist/mcp-forwarder.js"],
  "env": {
    "BASTRA_VAULT_PATH": "/abs/path/to/your/vault"
  }
}
```

The forwarder is a thin stdio-MCP wrapper that talks to a single local HTTP daemon (port 6723 by default). All MCP clients — Claude Code, Claude Desktop, Codex/ChatGPT Desktop, Cursor, additional sessions — share the same vault state, embedding index, and telemetry. The forwarder auto-spawns the daemon on first run if no one is listening yet.

**Standalone mode (one MCP client only, no sharing):**

```json
"bastra-recall": {
  "command": "node",
  "args": ["/abs/path/to/bastra-recall/packages/daemon/dist/index.js"],
  "env": {
    "BASTRA_VAULT_PATH": "/abs/path/to/your/vault"
  }
}
```

For Claude Code, also drop the Skill + hooks by hand:

```bash
bash packages/skill/install.sh        # copies the skill files → ~/.claude/skills/bastra-recall/
bash packages/skill/install-hook.sh   # registers all 7 reflex-layer hooks (opt out of the Stop save-eval with --no-stop-hook)
```

`bastra install claude-code` does both of these for you. Re-run `install.sh` whenever a skill file changes; re-run `install-hook.sh` only if hook binary paths move. To remove the hooks again: `bash packages/skill/install-hook.sh --uninstall` (no daemon build needed).

Every adapter write is **idempotent** (re-runs are no-ops), **atomic** (tmp file + rename), **backed up** (timestamped `.bak-…` next to the original), and **parse-safe** (broken JSON aborts the run instead of corrupting it). Vault path resolves in this order: `--vault <path>` flag → `BASTRA_VAULT_PATH` env → auto-detect from an existing Claude or Codex registration. If none of those produce a path (a fresh machine), an interactive `bastra install` offers to create `~/BastraVault` for you; non-interactive runs (piped, `--yes`, `--dry-run`) keep the clear deterministic error.

### Vault care — flag it now, groom it later

Memories age: titles go stale, duplicates creep in, ghosts point at notes you never wrote. bastra-recall turns tending the vault into a two-step loop instead of a chore. From any node's inspector on the vault map you flag a memory — *delete*, *edit*, *write* (for ghosts), or *note* — and the flags land as checkbox lines in an open `vault-care.md` at the vault root. Your **next AI session sees the open flags automatically** (session hook) and offers to work the list off with you: one guided cleanup pass, your call on every item. No hidden state, no separate app — a markdown checklist any editor can open.

### Local patches — a fix of your own that survives an update

If you run a local fix — a patch you wrote, or one from a PR that has not landed yet — an update would normally overwrite it. `bastra patches` keeps an ordered series of `git format-patch` files under `~/.bastra/patches/` and reapplies them after every successful update.

```bash
bastra patches add my-fix.patch    # register a patch (ordered in steps of ten)
bastra patches status              # what each patch would do against this install
bastra patches list                # the series, in apply order (the default)
bastra patches remove <id>         # drop one — ids come from `list`
```

An id is the ordering prefix plus a slug of the patch's `Subject:` line, e.g. `010-cyrillic-slugify`. The steps of ten leave room to slot a patch between two existing ones by hand without renumbering the series.

Three outcomes per patch, and the third is the point: a patch that **applies cleanly** is reapplied; one that upstream has **absorbed verbatim** is auto-retired out of the series; and one that **no longer applies** is *set aside, never forced* — the file stays exactly as the updater produced it, and the next session tells you which patch is waiting. A forced apply would produce a file nobody wrote and nobody reviewed, which is worse than a reverted fix.

After the series, the patched CLI is actually started. If it does not boot, every patch from that run is reversed and the install is left as the updater produced it. `bastra patches status` prints the directory patches are addressed from when it differs from the install root — on a source checkout those are two different roots, and that line is the first thing to check when every verdict looks wrong.

### Two copies of one vault — which one is ahead

If the same vault lives in two places — a synced mirror on a second machine, a copy a failover daemon wrote into — `bastra reconcile` tells you, memory by memory, which copy is ahead.

```bash
bastra reconcile                                # list the copies of this vault it finds
bastra reconcile /path/to/other/copy            # the plan (dry run, the default)
bastra reconcile /path/to/other/copy --yes      # carry out the unambiguous copies
bastra reconcile /path/to/other/copy --json     # the plan as JSON
```

"This store" is your vault (`--vault`, `BASTRA_VAULT_PATH`, or the one your clients are registered with). File date, hash and size decide nothing: the daemon rewrites memory files on its own (generated fields, the auto-related block), so the copy it served looks newer while it may hold the older text. Two copies count as the same when their *authored* content matches — body without the generated block, wrapping collapsed, wikilinks in one spelling, frontmatter without generated fields. Memories are matched by their frontmatter `id`, not their filename.

The direction comes from each store's audit log (`.bastra/audit-log.ndjson`): the copy with recorded writes the other lacks is ahead. Anything else is a **conflict** and is only listed, never resolved: writes on both sides, a change no log records (an edit in another editor), a delete on one side, a duplicate id. `--yes` copies only the unambiguous cases; an overwritten file is first copied to `<store>/.bastra/reconcile-backup/<time>/`, a file that changed since the plan is skipped, and nothing is deleted.

Without a path, `bastra reconcile` looks for copies (#339): the vault paths in the client registrations (Claude Code, including per-project ones; Claude Desktop, Cursor, Codex) and `BASTRA_VAULT_PATH` — the folder a forwarder-spawned daemon writes to when the configured one is unreachable —, symlinks onto a store (listed as another path of the same store), and folders carrying a bastra audit log inside sync folders (iCloud Drive and app containers, `~/Library/CloudStorage`, Dropbox, OneDrive, Google Drive, Nextcloud, pCloud, `~/Sync`). Only directory listings are read on the way, so files a sync client keeps in the cloud are not downloaded. A sync-folder hit counts as a copy when its audit log names at least one memory this vault's log names; otherwise it is another vault and left out. With exactly one other copy it prints the dry run against it; `--yes` always takes the path. The clients' own memory folders are not copies of the vault; `bastra doctor` lists them and `bastra import clients` imports them (#674).

### Onboarding — five minutes to a warm start

A fresh vault offers to seed itself. Pick what your memory will mainly hold — code & projects, company & decisions, life & knowledge, or a mix — and answer a handful of persona-aware questions; every answer becomes a profile memory your AI recalls from day one. Two surfaces run it for certain: the vault map auto-opens it on a fresh vault, and `bastra onboard` runs it in the terminal (`bastra onboard --answers <file>` saves prepared answers from a JSON/YAML file, no terminal needed — see `bastra onboard --help`; a file with only the persona is valid, but one where nothing is usable and an entry was skipped — a mistyped question id, a value that is not text — fails with exit code 2 and leaves onboarding open). On top of that, an AI session with hooks (Claude Code, Codex) is handed the interview at session start and usually opens it for you — the most adaptive of the three, it follows up where an answer is thin. Skippable everywhere, never asked twice.

### Importing memories — skip the cold start

Bring useful context from other tools with `bastra import`. Lists, chat extracts and rules are staged in `import-review.md` for you and your assistant to review. Whole memory folders are the exception: `bastra import vault` imports them directly into a separate intake area, without reviewing each item first.

```bash
bastra import memories.txt         # a memory list: ChatGPT / Claude / Gemini export, free text — or paste via `bastra import -`
bastra import conversations.json   # a full data export (ChatGPT / Claude) — queued for chunk-wise mining
bastra import rules                # local rules files: CLAUDE.md, AGENTS.md, .cursorrules, .cursor/rules/, ~/.claude/CLAUDE.md
bastra import vault <dir>          # a whole folder of memory files (e.g. a Claude Code memory dir) — no review needed
bastra import clients              # every Claude Code (~/.claude/projects/*/memory) and Codex (~/.codex/memories) memory folder, imported like `vault`
```

A folder import builds each note's `recall_when` from the source's description and title: the memory type word (`feedback`, `reference`, …) stays a tag, never a trigger, and an entry longer than 200 characters is cut at a word boundary (the description stays in `summary`). If that leaves no trigger because the title is itself a type word, the first line of the note's body that says something becomes the trigger. Each such fix is printed as a warning; the note is imported anyway. Only a note that holds nothing but a type word in title, description and body is skipped, with the reason. Notes imported before this change keep their old triggers until you run the same `bastra import vault` again (#710).

A `conversations.json` never stages raw chat history: only **your own messages** are kept (assistant turns dropped), queued locally under `~/.bastra/` — the queue is deleted when mining completes, and `bastra import clear` discards it anytime. Text read by your assistant becomes its context and may be processed by its cloud provider; see [privacy](./PRIVACY.md). Your AI session combs the queue chunk-wise (`bastra import mine`) and stages candidate lessons, decisions and preferences for your review. The vault map carries a visual import dialog (topbar ↓) for the paste path and the folder path.

`import vault` is the fourth path and skips the gate on purpose: a folder of already-structured memory files (Claude Code's `name`/`description`/`type` frontmatter — both its variants — or plain markdown notes) carries every field a memory needs, so it maps deterministically. The set lands isolated under `memories/imported/<label>/` with its own scope and namespaced ids — nothing existing is read or modified, and deleting that one folder removes the whole set. An identical re-import is a true no-op (#530): unchanged memories are not rewritten, no audit event is appended and the `.bastra-imported` marker stays put — the run reports `created · updated · unchanged` so you can see which it was.

**Notes in the clients' own memory folders (#674).** Claude Code keeps a memory folder per project and Codex one per user; an agent that saves there instead of through `save_memory` writes notes recall never reads. `bastra doctor` lists every such folder that holds notes, with how many are not in the vault yet, and `bastra import clients` imports each one like `import vault` under its own label (`claude-code-<project>`, `codex`). The project opened in the home directory itself is `claude-code-home`, a project in `~/home` is `claude-code-home-home`; neither label carries the OS user name (#885). An earlier import of the home directory under `claude-code-users-<name>` (macOS) or `claude-code-home-<name>` (Linux) is moved to the new label on the next `bastra import clients` — folder, ids, links and source stamps — so no note lands in the vault twice; `--dry-run` shows the move without making it. The originals stay where they are; a re-run only writes what changed. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured.
If a label move was interrupted, run `bastra import clients` again: it recognizes files already rewritten or renamed and finishes the move. If ownership or an old ID is ambiguous, it reports a skip instead of guessing or overwriting another note. Notes, attachments and symlinks in the old folder that this import did not write are left there and named in the output (#1048); only the imported Markdown and its marker move. A disappearing vault stops the move instead of recreating its root. You can move the leftovers wherever they belong.

Link targets that live on another surface (say, your Claude Code skills) can be declared once with `bastra skills add <id>` — declared ids render as solid nodes in the map's own **skills ring** instead of "unwritten" ghosts, and the curator stops reporting them as dangling links. No path, no folder scan, no sync: the id is the whole declaration (also available on any ghost node in the map — "Mark as skill").

### Feedback

`bastra feedback bug` / `bastra feedback idea` opens a prefilled GitHub issue form in your browser. The bug form carries a sanitized diagnostics block — version, OS, Node, embedding mode, vault size; never file paths, never vault content — and you review and submit it yourself. The vault map links both forms in its sidebar.

### Cursor rules

`bastra install cursor` registers the MCP server globally. The behavioural layer — *recall before editing, save durable rules* — is a second step, once per project:

```bash
cd your-project
bastra rules cursor          # writes .cursor/rules/bastra-recall.mdc
```

This is not an oversight. Cursor's User Rules live in its settings UI, not on disk, so there is no global file to install; project rules live in the repo and are version-controlled. That is also the upside — commit the file and everyone on the repo gets the same behaviour. `bastra rules remove cursor` takes it back out.

Claude Code and Claude Desktop need no equivalent step: they share `~/.claude/skills/`, which `bastra install` writes for you.

### Shell completion

```bash
bastra completion zsh  > "${fpath[1]}/_bastra"          # zsh
bastra completion bash > /usr/local/etc/bash_completion.d/bastra
bastra completion fish > ~/.config/fish/completions/bastra.fish
```

Completes subcommands, surfaces (`install <TAB>` → `claude-code`, `cursor`, …) and flags. Start a new shell afterwards.

### Code awareness — what depends on the file you are editing

> **Experimental.** Code awareness uses Graphify to build a code map of a
> repository. It can help an agent find its way into an unfamiliar or large
> repository. For “what breaks if I change this” it measurably did not beat
> plain search on repositories like ours, and it costs context (the dependents
> block before edits) and background CPU (graph refreshes).

Off until you turn it on, per repository:

```bash
bastra code enable          # in the repository you want it for
bastra code                 # what is enabled, and how current it is
bastra code disable         # turn it off again
```

With it on, Recall reads a map of your code and tells the agent, before it
edits a file, which other files import or call into it. It also adds a
`find_code` tool for looking up a symbol by name instead of grepping for it.

The map is built by [Graphify](https://github.com/Graphify-Labs/graphify), a
separate open-source tool Recall installs on request (see
[INSTALL.md](./INSTALL.md)). It runs locally, reads only code, and sends
nothing anywhere — no LLM ever sees your source.

Details worth knowing:

- The map lives in `graphify-out/` inside the repository and is excluded from
  git automatically. It is never committed.
- It refreshes itself after edits, commits and branch switches, usually within
  a few seconds. While it is behind, anything Recall shows from it is marked
  as possibly outdated rather than presented as current.
- Nothing is indexed for a repository you have not enabled.
- `enable` and `disable` work from anywhere inside the repository and take
  effect within a few seconds, without restarting anything. A linked git
  worktree is its own repository and is enabled on its own.
- `BASTRA_CODE_AWARENESS=off` turns the whole feature off without changing
  what you enabled.
- macOS and Linux for now.

If something looks wrong, `bastra doctor` reports the state of every enabled
repository, and `bastra code rebuild` repairs a broken map after asking.
A busy build lock is retried after 10, 20, 40, 80, 160 and 320 seconds; further
automatic triggers do not shorten these waits. After the seventh locked attempt,
automatic refreshes pause and retry once per hour. A successful attempt
restores normal refresh triggers; a continuing lock keeps the hourly pace.
`bastra code index` or `bastra code rebuild` can also update the map manually.
The refresh log records the pause. Function anchors accept `file.ts#name` and
`file.ts#name()` equally; Windows-style CRLF diffs are read normally.

### REST API (for non-MCP clients)

The daemon exposes a REST API on `http://127.0.0.1:6723/api/v1/` covering every tool the MCP server offers. This is the integration point for clients that can't speak stdio-MCP.

Endpoints (all `POST`, JSON body):

| Endpoint | Tool |
|---|---|
| `/api/v1/recall` | recall |
| `/api/v1/load_memory` | load_memory |
| `/api/v1/save_memory` | save_memory |
| `/api/v1/edit_memory` | edit_memory |
| `/api/v1/find_document` / `read_document` / `open_document` | document search |
| `/api/v1/find_code` | code graph lookup |
| `/api/v1/save_document` / `recategorize_document` / `move_document` | document write (Pro) |
| `/api/v1/save_product_doc` | product docs |

In addition, `GET`/`POST /settings/docs` reads/writes the product-docs settings (`{mode, language}`) — loopback-only like `/hook/*`, intended for local UIs such as the Bastra Mac app's options pane.

**Liveness:** `GET /health` (token-free on loopback) and `GET /api/v1/health` (token + CORS, for browsers) return the same document — `ok`, `version`, `vault_size`, `uptime_seconds`, `started_at`, and the semantic-recall state (`on` / `off` / `degraded`). Neither counts as activity, so probing does not keep the daemon from its idle shutdown. A daemon whose `uptime_seconds` keeps resetting is restarting behind your back.

Auth and CORS:

- **Token:** `bastra token` prints the daemon's API token, minting one on first use (`bastra token rotate` issues a fresh one; `bastra token clear` removes it, locking out browser/REST clients). It's stored in `cli-settings.json`; the daemon reads it at startup, so restart after issuing, rotating, or clearing. `bastra` (the status panel) and `bastra status` show whether a token is set, without printing it. `BASTRA_API_TOKEN` overrides it.
- **Local tools** (CLI, MCP-forwarder — no `Origin` header) reach `/api/v1/*` without a token only when **both** are loopback: the peer socket *and* the `Host` header (`127.0.0.1` / `localhost` / `[::1]`). A foreign `Host` over a loopback socket — DNS rebinding, or a local tunnel/reverse proxy — always needs the token, and so does a request with **no** `Host` header at all: a raw port-forwarder (`socat`, `ssh -L`) adds none, so a missing header is no proof of a direct local client (#526). Set `BASTRA_AUTH_LOOPBACK_SKIP=0` to require the token even for direct local callers.
- **No token configured** (nothing minted, `BASTRA_API_TOKEN` unset or empty) does **not** mean an open daemon. The tokenless direct-local path is the only way in; everything else — a foreign `Host`, a missing `Host`, any browser `Origin` — gets `401`, and no bearer can satisfy it until you run `bastra token` and restart the daemon (#526). So a tunnel is usable only with a token: mint one first, the "it worked without one" setup is gone by design.
- **Browser clients** (any request *with* an `Origin` header) must always present the token **and** be on the CORS allowlist — even over loopback, since the user's browser shares `127.0.0.1` with the daemon and only the `Origin` header tells a real site from a stray one.
- **CORS** is deny-by-default: with `BASTRA_CORS_ORIGIN` unset, **no** browser origin is allowed. For a hosted web app, set an allowlist: `BASTRA_CORS_ORIGIN=https://your.host` (comma-separated for several) — the daemon then reflects only listed origins and a browser blocks the rest. `BASTRA_CORS_ORIGIN=*` remains available as an explicit tunnel/dev opt-in (the daemon logs a warning when combined with a minted token).
- **DNS rebinding** is blocked on both surfaces: the token-less loopback endpoints (`/health`, `/hook/*`, `/vault/count`) answer only requests whose `Host` header is present **and** loopback, and `/api/v1/*` drops its token exemption for any non-loopback `Host` — a rebound page or a tunnel gets a `401`, not data. `BASTRA_ALLOWED_HOSTS` (comma-separated) opens the loopback-only endpoints for tunnel setups; it does **not** make `/api/v1/*` token-free for those hosts.

To reach this daemon from a hosted web app (e.g. a site's admin talking to the user's *local* vault from the browser), set `BASTRA_CORS_ORIGIN` to the site origin, run `bastra token`, and paste the token into the site. When that site is served over **HTTPS** (e.g. `https://bastra.io`), Chrome sends a **Private Network Access** preflight for the public-origin → localhost call; the daemon answers it automatically with `Access-Control-Allow-Private-Network: true` for allowed origins — no extra config. For a server-side client, point a tunnel (Cloudflare Tunnel / ngrok / your own reverse proxy) at `127.0.0.1:6723` and configure it with the tunnel URL + your token. An OpenAPI 3.0 starter spec lives in [openapi.yaml](./openapi.yaml).

> **Status:** the ChatGPT Custom GPT Actions path does **not work end-to-end yet**. The REST API and the OpenAPI starter spec are in place; the packaged Custom-GPT action is tracked in [#13](https://github.com/n0mad-ai/bastra-recall/issues/13).

### Model recommendations — when a release suggests a different local text model

**The local text model.** `bastra models` shows the local text model behind keyword expansion, reranking and the draft check, plus what this machine's RAM tier can carry (below 16 GB: none). `bastra models set <tag>` pulls a model and stores the choice in `~/.bastra/cli-settings.json`; the environment variables `BASTRA_EXPAND_MODEL` / `BASTRA_RERANK_MODEL` override the stored choice. The embedding model is a separate thing (`bastra embeddings`) and is not touched by anything described here.

**What a new install is offered, and what runs without a choice.** These are two different things. The installer suggests `tev1:4b` (4.5 GB download) from 16 GB of RAM, offers `gemma4:12b` (8.1 GB) as the more accurate, slower alternative from 24 GB, and suggests `gemma4:12b` from 32 GB; it pulls and stores what you pick. That `tev1:4b` fits a 16 GB machine next to the embedding model is derived from its size — the comparison behind the suggestion ran on one 24 GB machine. An install that never stored a choice keeps running `gemma3:4b`, the built-in fallback, exactly as before: the new suggestion switches nothing on an existing install. It shows up there as the `recommended:` line of `bastra models` and as the recommendation described below. Where no recommendation is open, `bastra models` prints a `to switch:` hint under that line; it always names the model on the `recommended:` line, and where a tier has a heavier alternative, it follows on a line of its own, `alternative:`.

**What a recommendation is.** A release can carry a recommendation: per hardware tier (16 GB, 24 GB, 32 GB and up) a model, its download size, and one sentence on what gets better with that model. It ships inside the release, so showing it needs **no additional network access**. A release without a recommendation shows nothing and changes nothing.

**The current recommendation.** Since 1.1.0 the release carries one, named `2026-10-tev1`:

| RAM of the machine | Recommended model | Download | What the notice says gets better, compared with `gemma3:4b` |
| --- | --- | ---: | --- |
| below 16 GB | none | – | – |
| 16 GB to under 32 GB | `tev1:4b` | 4.5 GB | fewer wrong verdicts in the draft check, much harder to steer with injected text, a more accurate reranker; similar draft-check/reranker answer times, but slower keyword expansion and more notes without phrases |
| 32 GB and up | `gemma4:12b` | 8.1 GB | fewer wrong verdicts in the draft check, harder to steer with injected text, a clearly more accurate reranker — at about three times the answer time |

The numbers behind these sentences are in the [local model comparison](local-model-comparison.md), measured against `gemma3:4b` on one 24 GB machine with invented data. The sentence compares with `gemma3:4b`, also when you run a custom model. If you already use any model named in the active recommendation, no automatic switch notice appears, regardless of the tier: a 24 GB install using `gemma4:12b` is not prompted to move to `tev1:4b`, and a 32 GB install using `tev1:4b` is not prompted to move to `gemma4:12b`. The comparison ignores letter case and accepts a tag starting with a listed tag followed by `-` (for example `gemma4:12b-it-q4_K_M`). Bare names, `:latest`, and other sizes do not count as that model. `bastra models` still shows the tier’s pick and a manual switch command. Keyword expansion took 1.5 s instead of 0.9 s with `tev1:4b`, and 16 of 180 notes received no phrases instead of 1; the similar answer times refer to the draft check and reranking.

**Never switched automatically.** bastra never changes your model on its own — not on update, not with `update.mode auto`, not through the agent. New installs are simply offered the recommended model by the installer. Existing installs are told, and the answer is yours.

**When the notice appears.** All of these have to hold:

- the installed release carries a recommendation, and it has an entry for this machine's tier;
- the machine is at or above the 16 GB tier (below it, no text model runs);
- a text model is in use on this install: Ollama is the embedding provider (only then does the daemon run trigger expansion, the draft check and the search copilot), or you set a text model up yourself — stored with `bastra models set` or pinned by environment variable — which `bastra bridges harvest` uses whatever the embedding provider is;
- the model in effect is not already any model named in the active recommendation;
- update notices are not switched off (see "Switching it off" below);
- you have not answered yet — or you answered `later` and 7 days have passed, or the release carries a new recommendation.

**When it does not appear.** If any of the points above fails. In particular: once a model of the active recommendation is in effect, after `switch`, after `dismiss`, and for 7 days after `later`. A model outside that set gets the notice even if you chose it yourself.

**Where it appears.** Five places, all reading one shared note of your answer in `~/.bastra/cli-settings.json`, so an answer given in one place silences the others:

1. **`bastra update`** asks at the end. On a terminal it waits for one of three keys; without a terminal it only prints the notice and never waits.
2. **The catch-up question.** An update is run by the updater that was installed before it, and an updater from before this feature cannot ask. So the first `bastra` command you run on a terminal afterwards asks instead — after the command's own output, without changing its exit code, and once per recommendation. It does not ask when `bastra update` already asked, or when you already answered in the chat or on the command line. It never asks without a terminal on both ends (so not in pipes, scripts, hooks or background runs), and never after `--json`, `--help`, `--version`, `bastra update`, `models`, `config`, `token`, `completion` or `uninstall`. Enter, or anything it does not recognise, counts as `later`. Ctrl-C or end of input records no answer: the other places keep asking, the terminal does not ask a second time. An answer you gave elsewhere a moment earlier is never replaced by the question, and two commands finishing at the same moment ask once: the question is claimed under a lock on the settings file. If that lock cannot be had within a few seconds — another bastra process holds it, or one was interrupted and left it behind — nothing is asked and nothing is written; the question comes with the next command.
3. **`bastra models`** shows the recommendation at any time, also after you dismissed it.
4. **The agent's session start** carries the notice at every session start until you have answered — on purpose, with no daily limit. The agent is instructed to tell you about it, name the download size and ask. It may run the commands below for you, but only after your explicit answer.
5. **One dim line after CLI commands**, on stderr, normally once per day — wherever the catch-up question does not apply. Parallel commands share the day claim. A day lock older than about ten seconds is reclaimed without waiting; if commands simultaneously reclaim an orphaned lock, the line can rarely appear twice. If the day lock is fresh or unwritable, it silently skips that call without waiting; session start, the update question and catch-up do not use that lock. Not after `bastra update`, `models`, `config`, `token`, `completion`, `help` and `version`.

**The three answers.** Every notice prints the exact commands; they name the recommendation they answer (and, for a switch, the model):

```bash
bastra models switch <recommendation> <model>   # pull the recommended model, check it, then switch
bastra models later <recommendation>            # keep the current model, ask again in 7 days
bastra models dismiss <recommendation>          # keep it, never ask again for this recommendation
```

- `switch` — see "The safe switch" below. Afterwards nothing asks again for this recommendation.
- `later` — nothing changes; every place stays silent for 7 days and then reminds you (the session start and the dim line; the terminal question is not repeated).
- `dismiss` — nothing changes, and the notice does **not come back** for this recommendation. You may be giving up better recall quality. Every place that offers or confirms `dismiss` says so, and the agent tells you before it runs the command. `bastra models` keeps showing the recommendation, you can still switch later, and a later, new recommendation asks again.

All three work without a terminal.

**An answer only counts for what you were shown.** The commands carry the recommendation's name because the notice and the command can come from two different programs: a daemon that is still the previous version, and a command line that is already the new one. If the recommendation has changed in between, or the command names none, bastra refuses it, says what the current recommendation is, and changes nothing — a yes to one model never downloads another. For the same reason the answer does not depend on the shell it is typed in: if the recommended model happens to be pinned by an environment variable in your shell but not in the daemon, the answer is still recorded and the daemon stops asking.

**The safe switch.** `bastra models switch …` does these things in this order: it pulls the new model (skipped if it is already there), sends it one short real request, and only when that was answered stores the new model together with your answer — in one write, so there is never a new model without the answer or the reverse. The daemon reads the model at start, so restart it afterwards (`bastra update` restarts it, or restart your AI clients).

**Which Ollama the switch talks to.** Every request of the switch — is Ollama running, is the model there, the test request — goes to one address, worked out from `BASTRA_OLLAMA_URL` (default `http://localhost:11434`) before the first request is made. That address has to be on this machine, redirects are refused, and a query or fragment in the configured URL is left out. The switch is refused, without a single request, when the configured URL points to another machine, when it carries a user name or password (`http://user:pass@host`), or when it cannot be read as an http(s) URL. The refusal names at most the host — never the user name, the password, a token or the rest of the URL, in whatever spelling they were written — because what the command prints can end up in a chat transcript. In those cases `bastra models set <tag>` switches without the test request.

**When something fails.** If Ollama is not running, the pull fails or is interrupted, the test request fails or comes back empty, or the setting cannot be saved, the command prints the reason, exits with code 1 and changes nothing: your model stays as it was, and the question stays open. The same holds when `~/.bastra/cli-settings.json` is not valid JSON, or is there but cannot be read (wrong permissions, for example): bastra refuses to write to it rather than replace your other settings with defaults — repair the file or its permissions first. The second case is not special to model decisions: a command that stores a setting reads the file once, changes exactly what it read, and does not write when that one read failed. A model answer or switch is also refused, with a message, when the lock on the settings file cannot be had (another bastra process holds it, or an interrupted one left it behind; it is taken over after about ten seconds) — nothing is written, and you can simply repeat the command.

**Switching back.** The old model is never deleted. After a switch the command prints the exact way back: `bastra models set <previous tag>`. Removing an unused model from disk is yours to do (`ollama rm <tag>`).

**With `BASTRA_EXPAND_MODEL` or `BASTRA_RERANK_MODEL` set.** You get the notice as well. It names the variable and says that it overrides the stored choice: a switch stores the new model, but the variable keeps winning until you remove it and restart the daemon. If the variable already names any model of the active recommendation, there is no notice. The agent's session-start notice shows your current model only when it is a plain model tag (letters, digits and `. _ - : /`); anything else appears as "a custom model", and the variable is named without its value.

**Switching it off.** `BASTRA_UPDATE_CHECK=off` silences the notice at the session start, after CLI commands (the catch-up question and the dim line) and at the end of `bastra update`; so does `bastra config set update.mode off`. `bastra models dismiss <recommendation>` silences one recommendation. `bastra models` always shows it, whatever is switched off.

### Battery mode — keep background Ollama work off the battery (macOS)

Opt-in, off by default: `bastra config set battery.saver on` (or
`BASTRA_BATTERY_SAVER=1` in the daemon's environment, which wins over the file),
then restart the daemon. It checks the power source once a minute with
`pmset -g batt`; a plug change takes effect within 60 s. While the Mac runs on
battery:

- background paraphrasing (doc2query) and its catch-up round wait for AC,
- the embedding model is not warmed at boot, at turn start or at session start,
- the model unloads after 60 s without an embed instead of the configured
  `BASTRA_OLLAMA_IDLE_UNLOAD_MS` window.

An explicit `recall` still uses semantic search; the first one after an unload
is about 0.5–1 s slower because it loads the model. Hook lanes are unchanged.
On Linux and Windows the power source reads `unknown` and nothing is deferred.
`/health` reports `power: {battery_saver, source, saving}`, and `bastra doctor`
shows a "battery saver" row. bastra cannot stop the Ollama app itself or other
Ollama clients; an idle Ollama server without a loaded model costs little.

### Commons verification and bridge language

`bastra commons verify` opens a public pull request with the recipe ID, works/fails result, optional note, verifier ID, OS, CPU architecture and Node version. It does not submit your vault. If submission fails, the record remains on disk for manual submission.

`bastra bridges language <code>` limits query expansion to one language folder; `auto` searches all folders. New bridges are stored under the detected language of their source query, regardless of that override.

### Troubleshooting

- **Ollama says `using already-running ollama on 11434`** — another server answered after the first check. Bastra reuses it without starting a competing server; a brew or systemd start label appears only after that start command succeeded.
- **Daemon not reachable / `ECONNREFUSED`** — the MCP forwarder normally auto-spawns the daemon on the first tool call. Check with `curl -sS http://127.0.0.1:6723/health`; `bastra status` shows the same thing in readable form. If the forwarder was disabled (`BASTRA_FORWARDER_SPAWN=0`), remove that override and restart your AI client.
- **MCP is not registered with Claude Code, Claude Desktop, Codex/ChatGPT Desktop, or Cursor** — run `bastra doctor` to see which config is missing or broken, then re-run `bastra install <surface>`. The config paths are printed in both outputs.
- **A feature seems to do nothing** (memories come out in English, no save suggestions, recall never looks at the vault first) — `bastra doctor` ends with a **features** section: one line per feature, on or off, and for every off item the command that turns it on (`bastra config set language.primary <code>`, `bastra config set reflex.enabled true`, `bastra config set promptImpact.enabled true`, `bastra onboard`, `bastra embeddings on`, `bastra install <surface>` …). Claude Code's own `"disableAllHooks": true` shows up there too. So do two env keys in a client's MCP entry that narrow what the model can do: `BASTRA_TOOL_SURFACE=search` (recall only, the agent can never save) and `BASTRA_MCP_SESSION_CONTEXT=0` (no session context on the first tool call), each with the entry to edit. Features that are off by default on purpose — code awareness, the experimental change-impact block, product docs, Commons, bridges, the vault map, the archiving `rm` for Claude Code — are listed under their own heading as intentional, not as a problem. None of it changes doctor's exit code, and `--fix` never switches a feature on.
- **`the settings file exists but cannot be read`** — `~/.bastra/cli-settings.json` is there, but your user may not read it (or it is a directory). bastra stops instead of writing a fresh file over it, because that would drop every setting in it. Fix the permissions (`chmod 600 ~/.bastra/cli-settings.json`) and run the command again. This holds for every command that stores a setting.
- **`could not get the lock on the settings file`** — a model answer or switch found `~/.bastra/cli-settings.json.lock` held by another bastra process, or left behind by one that was interrupted. Nothing was written. Wait a few seconds and repeat the command; a lock nobody holds any more is taken over after about ten seconds.
- **Vault path missing or not writable** — pass `--vault <path>` during install or set `BASTRA_VAULT_PATH`. The directory must exist and your user must be able to create `.md` files in it; use a throwaway vault while testing.
- **Port `6723` already in use** — find the owner with `lsof -i :6723 -P -n`. Either stop the stale process or move the daemon with `BASTRA_HTTP_PORT=<port>` and point forwarders/hooks at the same endpoint via `BASTRA_DAEMON_URL` / `BASTRA_HTTP_URL`.
- **Recall returns nothing, or hits from the wrong vault** — confirm the registered vault with `bastra doctor`. Memory files need valid YAML frontmatter; files that fail validation are skipped. Weak or missing `recall_when` values are the other common cause — that field carries the most search weight.
- **Semantic recall shows `degraded`** — the daemon booted with embeddings on, but the provider stopped answering (Ollama not running, model deleted). `/health` reports `semantic_recall: "degraded"` plus the underlying error; recall keeps working on BM25 alone. Fix with `ollama serve` / `bastra embeddings on`.
- **Statusline costs changed** — cache writes marked as one-hour now use the one-hour price. If the external price table lacks that rate for a model, the display estimates that share at the five-minute rate instead of showing `NaN`.
- **Today in the statusline** — entries from yesterday are not reused after midnight. A valid empty result for a day is still cached, so the display does not reread transcripts on every refresh before the first activity.
- **Multilingual statusline alignment** — non-spacing combining marks do not take a terminal column regardless of script; spacing marks retain their width. Labels with Hebrew, Arabic, Thai or Tamil marks therefore keep their padding aligned.
- **Where logs live** — `bastra logs` renders them readably (`-f` to follow, `--since 1h`, `--source hook|daemon`); one line per event instead of raw JSONL. The files themselves sit outside the vault at `~/.bastra/logs/events-YYYY-MM-DD.jsonl` (override: `BASTRA_LOG_PATH`). The daemon deletes event logs older than **90 days** (`BASTRA_LOG_RETENTION_DAYS`); the floor is 30 days, because the curator mines that window for reflex promotions and a shorter setting would quietly degrade recall.
- **Reading context ROI** — `bastra logs --stats` reports hint tokens per acted-on load for pre-tool, session and bash-pre hooks. Its line shows how many loads had a matching source; older or unmatched loads are listed as unattributed rather than guessed into the ratio.
- **Reading dimension labels** — the stats tables distinguish rows from before dimension stamping (`pre-#263`), current load/read tool calls without a stamp (`tool call — not stamped`), and recall IDs with no matching `hook_recall` row (`unmatched`). An unmatched row can also be a reflex hint; it does not prove a time-window cut.
- **Reading the `candidates` column** — the use-rate tables in `packages/daemon/scripts/stats.ts` and in the Telemetry tab ("Recall quality": hit bands and hint sources; `candidates` in the `/ui/telemetry` report) count `candidates`: the engine's top-k per hook recall, before the hook applies its score floor, scope filter and per-session dedup. It is not the number of hints a client was shown — that count is not in these tables; the usage sidecar keeps it per memory, all-time. `loaded / candidates` is therefore a lower bound.
- **Reset derived state without losing memories** — stop the daemon, then delete only derived files inside `<vault>/.bastra/`: `embeddings.json` and `embed-cache.json` rebuild themselves on the next start. Never delete your `.md` files, `audit-log.ndjson`, or `trash/` unless you intend to remove user data.

<a id="deutsch"></a>

## Deutsch

Verbinde deine Clients, übernimm vorhandene Erinnerungen und nutze Bastra Recall im Alltag. Das geführte Setup steht in der [README](../README.md#installation); hier findest du Beispiele, manuelle Konfiguration, REST-API und Fehlerbehebung.

### Kochbuch

Wie sich das in einer Arbeitswoche tatsächlich anfühlt.

**1. Die Konvention, die du nicht mehr erklärst.** Du sagst Claude Code einmal, dass in diesem Repo Route-Handler, Business-Logik und DB-Zugriff in getrennte Dateien gehören. Das landet als projekt-bezogene `preference`. Sechs Sessions später, in einer Datei, die es nie geöffnet hat, holt der PreToolUse-Hook diese Regel hervor — *bevor* der Handler geschrieben wird. Die Datei wird geteilt, ohne dass du etwas sagst.

**2. Der Bug, der nur zweimal beißt.** Ein Focus-Ring-Bug braucht vier Anläufe: gestapelte `:focus`-Styles auf einem verschachtelten Input. Wenn er sitzt, wandern die Lösung **und der Irrweg** als `lesson` in den Vault, mit `recall_when: ["neue Input-Komponente bauen", "Input- oder Form-CSS schreiben"]`. Beim nächsten Input liegt der Irrweg schon auf dem Tisch.

**3. Ein Vault, zwei Tools.** Montag erarbeitest du mit Claude Code eine Deployment-Reihenfolge. Donnerstag sitzt du in einem anderen MCP-Client, fragst „wie shippen wir das nochmal" — und bekommst deine eigene Montagsantwort zurück. Gleicher Daemon, gleicher Vault, kein Export dazwischen.

**4. Die Präferenz, die nichts mit Code zu tun hat.** „Deutsch, Du-Form, knapp, keine Zusammenfassungen am Ende" ist eine `user-preference`. Ein Save, und sie gilt in jedem Projekt und jedem Client — auch in denen, die du nächsten Monat einrichtest.

**5. Recall vor dem Plan, nicht danach.** Frag nach einem mehrstufigen Plan in einem Bereich, den du seit Wochen nicht angefasst hast: Der Session-Hook zieht zuerst die Topologie-Memory dieses Subsystems — welche Dateien zählen, was bewusst offen blieb. Der Plan setzt dort an, wo du aufgehört hast, statt beim Neulesen des Repos.

Memories sind einfache Dateien — schreib sie von Hand in Obsidian, wenn dir das lieber ist, oder lass die AI speichern und korrigiere, was sie falsch verstanden hat.

### Der Claude-Code-Reflex-Layer im Detail

Sieben ruhige Hooks werden standardmäßig installiert, alle über den lokalen HTTP-Endpoint des Daemons:

- **`PreToolUse`** (`bastra-recall-hook`) — feuert vor jedem `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. Erkennt das Thema aus dem Tool-Aufruf und injiziert `<recall-hints>` als `additionalContext`.
- **`SessionStart`** (`bastra-recall-session-hook`) — feuert bei `startup`/`resume`/`clear`/`compact`. Lädt Top-User-Präferenzen + projektübergreifende Regeln + projekt-spezifische Memories als `<session-context>` vor, damit die AI ab dem ersten Prompt weiß: wer, was, und was-nicht.
- **`UserPromptSubmit`**, **`TaskCreate`/`TodoWrite`/`ExitPlanMode`**, **Bash-Safety** und **Bash-Failure** decken Lookup-Prompts, Topology-Recall vor Plänen, Safety bei riskanten Shell-Befehlen und Lesson-Recall bei fehlgeschlagenen Commands ab.

Der **`Stop`** Save-Eval-Hook ist standardmäßig an. In Claude Code geht ein Vorschlag im selben Turn als Stop-Hook-Feedback an den Agenten zurück, einmal pro Heuristik und Session, damit er speichern kann, solange das Gespräch noch da ist (#662); Codex bekommt ihn über eine Datei beim nächsten Session-Start (#48). `bastra install` registriert zusammen mit ihm den `SessionEnd`-Hook von Claude Code, damit eine beendete Session beim nächsten Durchlauf geerntet wird ([Nachlese nach der Session](./hooks.md), #675). Beide abwählen mit `bastra install claude-code --no-stop-hook`. Die Telemetrie (`scripts/stats.ts`) misst pro Hook Latenz, Hint-Qualität und Follow-Through (hat die AI nach einem Hint wirklich `load_memory` gemacht).

Die Hook-Einstiegspunkte können statt als `node`-Prozess als **kompilierter Client** laufen (`bastra-hook`, gebaut mit `deno compile`, #344) — das nimmt jedem Hook-Aufruf den Interpreter-Start. Normale npm-Installationen bekommen ihn auf Wunsch: `bastra install claude-code` fragt einmal, ob er geladen werden soll (~70 MB, ein GitHub-Release-Asset pro Plattform — macOS arm64/x64, Linux x64/arm64 — geprüft gegen das sha256-Manifest im Paket), `--stub` lädt ohne Nachfrage, `--no-stub` bleibt beim node-Client. Die Antwort wird über Updates hinweg gemerkt. Ohne die Binary laufen alle Hooks auf dem node-Client: dieselben Daemon-Lanes, nur ein langsamerer Start.

Mehr: [architecture.md](./architecture.md), [hooks.md](./hooks.md), [triggers.md](./triggers.md), [Codex + ChatGPT Desktop](./CODEX.md).

### Komplett manuelle Installation — Fallback

MCP-Server-Block in die Client-Config eintragen (für Claude Code: `~/.claude.json`, für Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`, für Cursor: `~/.cursor/mcp.json`).

Codex und ChatGPT Desktop teilen sich TOML statt dieser JSON-Blöcke. Empfohlen ist `bastra install codex`; der offizielle manuelle `codex mcp add`-Weg steht in [CODEX.md](./CODEX.md).

**Empfohlen (Forwarder-Modus — ein Daemon für alle Sitzungen):**

```json
"bastra-recall": {
  "command": "node",
  "args": ["/abs/path/to/bastra-recall/packages/daemon/dist/mcp-forwarder.js"],
  "env": {
    "BASTRA_VAULT_PATH": "/abs/path/to/your/vault"
  }
}
```

Der Forwarder ist ein dünner stdio-MCP-Wrapper, der mit einem einzigen lokalen HTTP-Daemon spricht (Standard-Port 6723). Alle MCP-Clients — Claude Code, Claude Desktop, Codex/ChatGPT Desktop, Cursor, weitere Sitzungen — teilen sich denselben Vault-State, Embedding-Index und Telemetry-Stream. Der Forwarder spawnt den Daemon beim ersten Start automatisch, falls noch keiner läuft.

**Standalone-Modus (nur ein MCP-Client, kein Sharing):**

```json
"bastra-recall": {
  "command": "node",
  "args": ["/abs/path/to/bastra-recall/packages/daemon/dist/index.js"],
  "env": {
    "BASTRA_VAULT_PATH": "/abs/path/to/your/vault"
  }
}
```

Für Claude Code zusätzlich Skill + Hooks manuell ablegen:

```bash
bash packages/skill/install.sh        # kopiert die Skill-Dateien → ~/.claude/skills/bastra-recall/
bash packages/skill/install-hook.sh   # registriert alle 7 Reflex-Layer-Hooks (Stop-Save-Eval abwählen mit --no-stop-hook)
```

`bastra install claude-code` erledigt beides für dich. `install.sh` neu ausführen, wenn sich eine Skill-Datei ändert; `install-hook.sh` nur, wenn sich Hook-Binärpfade verschieben. Hooks wieder entfernen: `bash packages/skill/install-hook.sh --uninstall` (ohne gebauten Daemon möglich).

Jeder Adapter-Write ist **idempotent** (Re-Runs sind No-Ops), **atomar** (Tmp-File + Rename), **gesichert** (timestamped `.bak-…` neben dem Original) und **parse-safe** (kaputtes JSON bricht den Lauf ab statt es zu zerstören). Vault-Pfad-Auflösung in dieser Reihenfolge: `--vault <pfad>`-Flag → `BASTRA_VAULT_PATH`-ENV → Auto-Detect aus bestehender Claude- oder Codex-Registrierung. Greift nichts davon (frische Maschine), bietet ein interaktives `bastra install` an, `~/BastraVault` anzulegen; nicht-interaktive Läufe (gepiped, `--yes`, `--dry-run`) behalten die klare, deterministische Fehlermeldung.

### Vault-Pflege — jetzt markieren, später aufräumen

Memories altern: Titel veralten, Dubletten schleichen sich ein, Ghosts zeigen auf nie geschriebene Notizen. bastra-recall macht aus der Vault-Pflege einen Zwei-Schritt-Loop statt einer lästigen Pflicht. Aus dem Inspector jeder Node auf der Vault-Map markierst du ein Memory — *delete*, *edit*, *write* (für Ghosts) oder *note* — und die Flags landen als Checkbox-Zeilen in einer offenen `vault-care.md` im Vault-Root. Deine **nächste AI-Session sieht die offenen Flags automatisch** (Session-Hook) und bietet an, die Liste gemeinsam abzuarbeiten: ein geführter Aufräum-Durchgang, jede Entscheidung bleibt bei dir. Kein versteckter State, keine Extra-App — eine Markdown-Checkliste, die jeder Editor öffnen kann.

### Lokale Patches — ein eigener Fix, der ein Update übersteht

Wenn du einen lokalen Fix fährst — selbst geschrieben oder aus einem PR, der noch nicht gelandet ist —, würde ein Update ihn normalerweise überschreiben. `bastra patches` hält eine geordnete Serie von `git format-patch`-Dateien unter `~/.bastra/patches/` und spielt sie nach jedem erfolgreichen Update wieder ein.

```bash
bastra patches add my-fix.patch    # Patch registrieren (in Zehnerschritten geordnet)
bastra patches status              # was jeder Patch gegen diese Installation täte
bastra patches list                # die Serie in Anwendungsreihenfolge (Default)
bastra patches remove <id>         # einen entfernen — die ids liefert `list`
```

Eine id besteht aus dem Ordnungspräfix und einem Slug der `Subject:`-Zeile des Patches, z. B. `010-cyrillic-slugify`. Die Zehnerschritte lassen Platz, einen Patch von Hand zwischen zwei bestehende zu schieben, ohne die Serie neu zu nummerieren.

Drei Ausgänge pro Patch, und der dritte ist der Punkt: Ein Patch, der **sauber greift**, wird wieder eingespielt; einer, den Upstream **wortgleich übernommen** hat, fliegt automatisch aus der Serie; und einer, der **nicht mehr passt**, wird *beiseitegelegt, nie erzwungen* — die Datei bleibt exakt so, wie das Update sie erzeugt hat, und die nächste Session sagt dir, welcher Patch wartet. Ein erzwungenes Anwenden erzeugte eine Datei, die niemand geschrieben und niemand geprüft hat — schlimmer als ein zurückgenommener Fix.

Nach der Serie wird die gepatchte CLI tatsächlich gestartet. Bootet sie nicht, wird jeder Patch dieses Laufs zurückgenommen und die Installation bleibt so, wie das Update sie hinterlassen hat. `bastra patches status` nennt das Verzeichnis, aus dem Patches adressiert werden, sobald es vom Install-Root abweicht — bei einem Source-Checkout sind das zwei verschiedene Wurzeln, und diese Zeile ist das Erste, was man prüft, wenn alle Urteile falsch aussehen.

### Zwei Kopien eines Vaults — welche ist vorn

Liegt derselbe Vault an zwei Orten — ein gespiegelter Vault auf einem zweiten Rechner, eine Kopie, in die ein Ersatz-Daemon geschrieben hat —, sagt dir `bastra reconcile` pro Memory, welche Kopie vorn ist.

```bash
bastra reconcile                                    # die gefundenen Kopien dieses Vaults auflisten
bastra reconcile /pfad/zur/anderen/kopie            # der Plan (Probelauf, Standard)
bastra reconcile /pfad/zur/anderen/kopie --yes      # die eindeutigen Kopien ausführen
bastra reconcile /pfad/zur/anderen/kopie --json     # der Plan als JSON
```

„Dieser Store" ist dein Vault (`--vault`, `BASTRA_VAULT_PATH` oder der, bei dem deine Clients registriert sind). Dateidatum, Hash und Größe entscheiden nichts: Der Daemon schreibt Memory-Dateien selbst neu (generierte Felder, der Auto-Related-Block), die von ihm bediente Kopie wirkt also neuer und kann trotzdem den älteren Text halten. Zwei Kopien gelten als gleich, wenn ihr *verfasster* Inhalt übereinstimmt — Body ohne generierten Block, Umbrüche zusammengefasst, Wikilinks in einer Schreibweise, Frontmatter ohne generierte Felder. Memories werden über ihre Frontmatter-`id` zugeordnet, nicht über den Dateinamen.

Die Richtung kommt aus dem Audit-Log jedes Stores (`.bastra/audit-log.ndjson`): Vorn ist die Kopie mit protokollierten Schreibvorgängen, die der anderen fehlen. Alles andere ist ein **Konflikt** und wird nur gemeldet, nie aufgelöst: Schreibvorgänge auf beiden Seiten, eine Änderung, die kein Log kennt (Bearbeitung in einem anderen Editor), ein Löschen auf einer Seite, eine doppelte id. `--yes` kopiert nur die eindeutigen Fälle; eine überschriebene Datei wird vorher nach `<store>/.bastra/reconcile-backup/<zeit>/` kopiert, eine seit dem Plan geänderte Datei übersprungen, gelöscht wird nichts.

Ohne Pfad sucht `bastra reconcile` nach Kopien (#339): die Vault-Pfade in den Client-Registrierungen (Claude Code, auch pro Projekt; Claude Desktop, Cursor, Codex) und `BASTRA_VAULT_PATH` — der Ordner, in den ein vom Forwarder gestarteter Daemon schreibt, wenn der eingestellte nicht erreichbar ist —, Symlinks auf einen Store (als weiterer Pfad desselben Stores gelistet) und Ordner mit bastra-Audit-Log in Sync-Ordnern (iCloud Drive samt App-Containern, `~/Library/CloudStorage`, Dropbox, OneDrive, Google Drive, Nextcloud, pCloud, `~/Sync`). Unterwegs werden nur Verzeichnislisten gelesen, Dateien, die ein Sync-Client nur in der Cloud hält, werden also nicht heruntergeladen. Ein Treffer im Sync-Ordner gilt als Kopie, wenn sein Audit-Log mindestens eine Memory nennt, die auch das Log dieses Vaults nennt; sonst ist es ein anderer Vault und bleibt draußen. Bei genau einer anderen Kopie zeigt es den Probelauf gegen sie; `--yes` braucht immer den Pfad. Die eigenen Memory-Ordner der Clients sind keine Kopien des Vaults; `bastra doctor` listet sie, `bastra import clients` importiert sie (#674).

### Onboarding — in fünf Minuten zum Warmstart

Ein frischer Vault bietet an, sich selbst zu befüllen. Du wählst, was dein Gedächtnis hauptsächlich halten soll — Code & Projekte, Firma & Entscheidungen, Leben & Wissen oder ein Mix — und beantwortest eine Handvoll persona-bewusster Fragen; jede Antwort wird ein Profil-Memory, das deine KI vom ersten Tag an abruft. Zwei Oberflächen führen es verlässlich: Die Vault-Map öffnet es bei frischem Vault automatisch, `bastra onboard` führt es im Terminal (`bastra onboard --answers <datei>` speichert vorbereitete Antworten aus einer JSON-/YAML-Datei, ganz ohne Terminal — siehe `bastra onboard --help`; eine Datei nur mit der Persona ist gültig, aber eine, in der nichts verwertbar ist und ein Eintrag übergangen wurde — vertippte Fragen-ID, ein Wert, der kein Text ist —, scheitert mit Exit-Code 2 und lässt das Onboarding offen). Darüber hinaus bekommt eine AI-Sitzung mit Hooks (Claude Code, Codex) das Interview beim Sitzungsstart übergeben und beginnt es in aller Regel von selbst — die adaptivste der drei, sie hakt nach, wo eine Antwort dünn ist. Überall überspringbar, nie doppelt gefragt.

### Memories importieren — den Kaltstart überspringen

Übernimm nützlichen Kontext aus anderen Tools mit `bastra import`. Listen, Chat-Auszüge und Regeln werden in `import-review.md` zur gemeinsamen Prüfung mit deinem Assistenten vorbereitet. Ganze Memory-Ordner sind die Ausnahme: `bastra import vault` importiert sie direkt in einen getrennten Bereich, ohne vorherige Einzelprüfung.

```bash
bastra import memories.txt         # eine Memory-Liste: ChatGPT- / Claude- / Gemini-Export, Freitext — oder Paste via `bastra import -`
bastra import conversations.json   # ein kompletter Daten-Export (ChatGPT / Claude) — wird für Chunk-weises Mining gequeued
bastra import rules                # lokale Rules-Dateien: CLAUDE.md, AGENTS.md, .cursorrules, .cursor/rules/, ~/.claude/CLAUDE.md
bastra import vault <dir>          # ein ganzer Ordner Memory-Dateien (z.B. ein Claude-Code-Memory-Dir) — ohne Review
bastra import clients              # alle Memory-Ordner von Claude Code (~/.claude/projects/*/memory) und Codex (~/.codex/memories), importiert wie `vault`
```

Ein Ordner-Import baut `recall_when` jeder Notiz aus Beschreibung und Titel der Quelle: Das Typwort (`feedback`, `reference`, …) bleibt ein Tag, nie ein Trigger, und ein Eintrag über 200 Zeichen wird an einer Wortgrenze gekürzt (die Beschreibung bleibt in `summary`). Bleibt danach kein Trigger übrig, weil der Titel selbst ein Typwort ist, wird die erste aussagekräftige Zeile des Notiztexts zum Trigger. Jede solche Korrektur erscheint als Warnung; die Notiz wird trotzdem importiert. Nur eine Notiz, die in Titel, Beschreibung und Text nichts als ein Typwort enthält, wird mit Begründung übersprungen. Vorher importierte Notizen behalten ihre alten Trigger, bis du denselben `bastra import vault` erneut ausführst (#710).

Eine `conversations.json` staged nie rohe Chat-History: Nur **deine eigenen Messages** bleiben (Assistant-Antworten fliegen raus), lokal gequeued unter `~/.bastra/` — wird nach dem Mining gelöscht, `bastra import clear` verwirft jederzeit. Vom Assistenten gelesene Abschnitte werden zu seinem Kontext und können bei seinem Cloud-Anbieter verarbeitet werden; siehe [Datenschutz](./PRIVACY.md#deutsch). Deine AI-Session kämmt die Queue Chunk-weise durch (`bastra import mine`) und staged Kandidaten-Lessons, -Entscheidungen und -Präferenzen für deine Review. Die Vault-Map hat einen visuellen Import-Dialog (Topbar ↓) für den Paste-Weg und den Ordner-Weg.

`import vault` ist der vierte Weg und überspringt das Gate bewusst: Ein Ordner bereits strukturierter Memory-Dateien (Claude Codes `name`/`description`/`type`-Frontmatter — beide Varianten — oder schlichte Markdown-Notizen) trägt jedes Feld, das ein Memory braucht, und mappt deshalb deterministisch. Der Satz landet isoliert unter `memories/imported/<label>/` mit eigenem Scope und namespaced ids — nichts Bestehendes wird gelesen oder verändert, und das Löschen dieses einen Ordners entfernt den ganzen Satz. Ein identischer Re-Import ist ein echtes No-Op (#530): Unveränderte Memories werden nicht neu geschrieben, es entsteht kein Audit-Eintrag und der Marker `.bastra-imported` bleibt stehen — der Lauf meldet `created · updated · unchanged`, damit sichtbar ist, was davon zutraf.

**Notizen in den eigenen Memory-Ordnern der Clients (#674).** Claude Code führt pro Projekt einen Memory-Ordner, Codex einen pro Nutzer; ein Agent, der dort statt über `save_memory` speichert, schreibt Notizen, die recall nie liest. `bastra doctor` listet jeden solchen Ordner mit Notizen auf, dazu wie viele davon noch nicht im Vault sind, und `bastra import clients` importiert jeden wie `import vault` unter einem eigenen Label (`claude-code-<projekt>`, `codex`). Das Projekt, das direkt im Home-Verzeichnis geöffnet wurde, heißt `claude-code-home`, ein Projekt in `~/home` heißt `claude-code-home-home`; keines der Labels enthält den Benutzernamen des Systems (#885). Ein früherer Import des Home-Verzeichnisses unter `claude-code-users-<name>` (macOS) oder `claude-code-home-<name>` (Linux) wird beim nächsten `bastra import clients` auf das neue Label umgezogen — Ordner, ids, Links und Quellstempel —, damit keine Notiz doppelt im Vault landet; `--dry-run` zeigt den Umzug, ohne ihn auszuführen. Die Originale bleiben liegen; ein erneuter Lauf schreibt nur, was sich geändert hat. `CLAUDE_CONFIG_DIR` und `CODEX_HOME` werden beachtet.
Wurde ein Label-Umzug unterbrochen, führe `bastra import clients` erneut aus: Bereits geänderte oder umbenannte Dateien werden erkannt und der Umzug fortgesetzt. Sind Besitz oder eine alte ID nicht eindeutig, meldet der Befehl einen Skip, statt eine andere Notiz auf Verdacht zu überschreiben. Notizen, Anhänge und Symlinks im alten Ordner, die dieser Import nicht geschrieben hat, bleiben dort liegen und werden in der Ausgabe genannt (#1048); nur importiertes Markdown und sein Marker ziehen um. Verschwindet der Vault, stoppt der Umzug, statt seinen Root neu anzulegen. Die übrigen Dateien kannst du verschieben, wohin sie gehören.

Link-Ziele, die auf einer anderen Surface leben (etwa deine Claude-Code-Skills), deklarierst du einmal mit `bastra skills add <id>` — deklarierte ids erscheinen als solide Knoten im eigenen **Skills-Ring** der Map statt als „unwritten"-Ghosts, und der Curator meldet sie nicht mehr als dangling links. Kein Pfad, kein Ordner-Scan, kein Sync: Die id ist die ganze Deklaration (auch auf jedem Ghost-Knoten in der Map — „Mark as skill").

### Feedback

`bastra feedback bug` / `bastra feedback idea` öffnet ein vorausgefülltes GitHub-Issue-Formular im Browser. Das Bug-Formular trägt einen sanitisierten Diagnose-Block — Version, OS, Node, Embedding-Modus, Vault-Größe; nie Dateipfade, nie Vault-Inhalte — und du prüfst und sendest es selbst. Die Vault-Map verlinkt beide Formulare in ihrer Sidebar.

### Cursor-Rules

`bastra install cursor` registriert den MCP-Server global. Die Verhaltens-Schicht — *Recall vor dem Editieren, dauerhafte Regeln speichern* — ist ein zweiter Schritt, einmal pro Projekt:

```bash
cd dein-projekt
bastra rules cursor          # schreibt .cursor/rules/bastra-recall.mdc
```

Das ist kein Versäumnis: Cursors User Rules liegen in der Settings-UI, nicht auf der Platte — es gibt also keine globale Datei zum Installieren. Projekt-Rules liegen im Repo und sind versioniert. Genau das ist der Vorteil — die Datei committen, und alle im Repo bekommen dasselbe Verhalten. `bastra rules remove cursor` nimmt sie wieder heraus.

Claude Code und Claude Desktop brauchen diesen Schritt nicht: Sie teilen sich `~/.claude/skills/`, das `bastra install` für dich schreibt.

### Shell-Completion

```bash
bastra completion zsh  > "${fpath[1]}/_bastra"          # zsh
bastra completion bash > /usr/local/etc/bash_completion.d/bastra
bastra completion fish > ~/.config/fish/completions/bastra.fish
```

Vervollständigt Subcommands, Surfaces (`install <TAB>` → `claude-code`, `cursor`, …) und Flags. Danach eine neue Shell starten.

### Code-Awareness — was von der Datei abhängt, die du gerade bearbeitest

> **Experimentell.** Code-Awareness baut mit Graphify eine Code-Karte eines
> Repositories. Sie kann einem Agenten helfen, sich in einem unbekannten oder
> großen Repository zurechtzufinden. Bei „was geht kaputt, wenn ich das
> ändere?“ war sie auf Repositories wie unserem messbar nicht besser als eine
> einfache Suche, und sie kostet Kontext (der Block mit abhängigen Dateien vor
> Änderungen) und Rechenzeit im Hintergrund (Aktualisieren der Karte).

Standardmäßig aus, und pro Repository einzuschalten:

```bash
bastra code enable          # im gewünschten Repository
bastra code                 # was aktiv ist und wie aktuell es ist
bastra code disable         # wieder ausschalten
```

Ist es an, liest Recall eine Karte deines Codes und sagt dem Agenten vor einer
Änderung, welche anderen Dateien die bearbeitete importieren oder aufrufen.
Dazu kommt ein Werkzeug `find_code`, das ein Symbol beim Namen findet, statt
danach zu suchen.

Die Karte baut [Graphify](https://github.com/Graphify-Labs/graphify), ein
eigenständiges Open-Source-Werkzeug, das Recall auf Wunsch mitinstalliert
(siehe [INSTALL.md](./INSTALL.md)). Es läuft lokal, liest ausschließlich Code
und schickt nichts irgendwohin — kein Sprachmodell sieht deinen Quelltext.

Was du wissen solltest:

- Die Karte liegt in `graphify-out/` im Repository und wird automatisch von Git
  ausgenommen. Sie wird nie committet.
- Sie aktualisiert sich nach Änderungen, Commits und Branch-Wechseln, meist
  binnen weniger Sekunden. Solange sie hinterherhinkt, wird alles, was Recall
  daraus zeigt, als möglicherweise veraltet gekennzeichnet statt als aktuell
  ausgegeben.
- Für ein Repository, das du nicht aktiviert hast, wird nichts indiziert.
- `enable` und `disable` funktionieren von überall im Repository und wirken
  binnen weniger Sekunden, ohne Neustart. Ein verknüpfter Git-Worktree ist ein
  eigenes Repository und wird für sich aktiviert.
- `BASTRA_CODE_AWARENESS=off` schaltet die ganze Funktion ab, ohne deine
  Aktivierungen zu verändern.
- Vorerst macOS und Linux.

Wenn etwas nicht stimmt: `bastra doctor` nennt den Zustand jedes aktivierten
Repositories, und `bastra code rebuild` repariert eine kaputte Karte nach
Rückfrage. Eine belegte Build-Sperre wird nach 10, 20, 40, 80, 160 und 320
Sekunden erneut versucht; weitere automatische Auslöser verkürzen diese Pausen
nicht. Nach dem siebten gesperrten Versuch werden automatische Aktualisierungen
pausiert und einmal pro Stunde erneut versucht. Ein erfolgreicher Versuch gibt die
normalen Auslöser wieder frei; bleibt die Sperre belegt, bleibt es beim
Stundenabstand. `bastra code index` oder `bastra code rebuild` können die Karte
auch manuell aktualisieren. Das Aktualisierungslog hält die Pause fest.
Funktionsanker akzeptieren `datei.ts#name` und `datei.ts#name()` gleichwertig;
Diffs mit Windows-Zeilenenden (CRLF) werden normal gelesen.

### REST API (für Nicht-MCP-Clients)

Der Daemon exponiert eine REST-API unter `http://127.0.0.1:6723/api/v1/`, die alle Tools des MCP-Servers abdeckt. Das ist der Integrationspunkt für Clients, die kein stdio-MCP sprechen können.

Endpoints (alle `POST`, JSON-Body):

| Endpoint | Tool |
|---|---|
| `/api/v1/recall` | recall |
| `/api/v1/load_memory` | load_memory |
| `/api/v1/save_memory` | save_memory |
| `/api/v1/edit_memory` | edit_memory |
| `/api/v1/find_document` / `read_document` / `open_document` | Document-Suche |
| `/api/v1/find_code` | Code-Graph-Abfrage |
| `/api/v1/save_document` / `recategorize_document` / `move_document` | Document-Schreiben (Pro) |
| `/api/v1/save_product_doc` | Produkt-Doku |

Zusätzlich liest/schreibt `GET`/`POST /settings/docs` die Produkt-Doku-Settings (`{mode, language}`) — loopback-only wie `/hook/*`, gedacht für lokale UIs wie die Options-Pane der Bastra Mac-App.

**Liveness:** `GET /health` (auf Loopback ohne Token) und `GET /api/v1/health` (Token + CORS, für Browser) liefern dasselbe Dokument — `ok`, `version`, `vault_size`, `uptime_seconds`, `started_at` und den Zustand des semantischen Recalls (`on` / `off` / `degraded`). Beide zählen nicht als Aktivität, ein Polling hält den Daemon also nicht vom Idle-Shutdown ab. Ein Daemon, dessen `uptime_seconds` immer wieder zurückspringt, startet unbemerkt neu.

Auth und CORS:

- **Token:** `bastra token` zeigt das API-Token des Daemons und erzeugt beim ersten Aufruf eines (`bastra token rotate` erneuert es; `bastra token clear` entfernt es und sperrt Browser-/REST-Clients aus). Es liegt in `cli-settings.json`; der Daemon liest es beim Start, also nach Erzeugen, Erneuern oder Entfernen neu starten. `bastra` (das Status-Panel) und `bastra status` zeigen, ob ein Token gesetzt ist, ohne es anzuzeigen. `BASTRA_API_TOKEN` hat Vorrang.
- **Lokale Tools** (CLI, MCP-Forwarder — kein `Origin`-Header) erreichen `/api/v1/*` nur dann ohne Token, wenn **beides** loopback ist: der Peer-Socket *und* der `Host`-Header (`127.0.0.1` / `localhost` / `[::1]`). Ein fremder `Host` über einen Loopback-Socket — DNS-Rebinding oder ein lokaler Tunnel/Reverse-Proxy — braucht immer das Token, und ein Request **ganz ohne** `Host`-Header ebenfalls: ein roher Port-Forwarder (`socat`, `ssh -L`) ergänzt keinen, ein fehlender Header ist also kein Beweis für einen direkten lokalen Client (#526). Mit `BASTRA_AUTH_LOOPBACK_SKIP=0` wird das Token auch von direkten lokalen Aufrufern verlangt.
- **Kein Token konfiguriert** (keins gemintet, `BASTRA_API_TOKEN` nicht oder leer gesetzt) heißt **nicht** offener Daemon. Dann ist der token-lose direkte lokale Weg der einzige Weg hinein; alles andere — fremder `Host`, fehlender `Host`, jede Browser-`Origin` — bekommt `401`, und kein Bearer kann das erfüllen, solange kein Token existiert: erst `bastra token`, dann Daemon neu starten (#526). Ein Tunnel ist damit nur mit Token nutzbar; das frühere "ging auch ohne" ist bewusst weg.
- **Browser-Clients** (jeder Request *mit* `Origin`-Header) müssen immer das Token tragen **und** auf der CORS-Allowlist stehen — auch über Loopback, denn der Browser des Users teilt sich `127.0.0.1` mit dem Daemon und nur der `Origin`-Header trennt eine echte Seite von einer fremden.
- **CORS** ist deny-by-default: ohne gesetztes `BASTRA_CORS_ORIGIN` ist **keine** Browser-Origin erlaubt. Für eine gehostete Web-App eine Allowlist setzen: `BASTRA_CORS_ORIGIN=https://dein.host` (kommagetrennt für mehrere) — der Daemon spiegelt dann nur gelistete Origins zurück, den Rest blockt der Browser. `BASTRA_CORS_ORIGIN=*` bleibt als explizites Tunnel/Dev-Opt-in (der Daemon warnt, wenn dabei ein Token gemintet ist).
- **DNS-Rebinding** wird auf beiden Flächen geblockt: Die token-losen Loopback-Endpoints (`/health`, `/hook/*`, `/vault/count`) antworten nur auf Requests mit vorhandenem loopback-`Host`, und `/api/v1/*` verliert seine Token-Ausnahme bei jedem nicht-loopback `Host` — eine umgebogene Seite oder ein Tunnel bekommt ein `401`, keine Daten. `BASTRA_ALLOWED_HOSTS` (kommagetrennt) öffnet die loopback-only Endpoints für Tunnel-Setups; `/api/v1/*` wird für diese Hosts dadurch **nicht** token-frei.

Um diesen Daemon aus einer gehosteten Web-App zu erreichen (z.B. das Admin einer Seite, das aus dem Browser auf den *lokalen* Vault des Users zugreift): `BASTRA_CORS_ORIGIN` auf die Seiten-Origin setzen, `bastra token` ausführen und das Token in der Seite hinterlegen. Läuft die Seite über **HTTPS** (z.B. `https://bastra.io`), schickt Chrome für den Public-Origin-→-localhost-Call einen **Private-Network-Access**-Preflight; der Daemon beantwortet ihn für erlaubte Origins automatisch mit `Access-Control-Allow-Private-Network: true` — ohne Zusatzkonfiguration. Für einen serverseitigen Client: einen Tunnel (Cloudflare Tunnel / ngrok / eigener Reverse-Proxy) auf `127.0.0.1:6723` legen und mit Tunnel-URL + Token konfigurieren. Eine OpenAPI-3.0-Starter-Spec liegt in [openapi.yaml](./openapi.yaml).

> **Status:** Der ChatGPT-Custom-GPT-Actions-Weg **funktioniert noch nicht end-to-end**. REST-API und OpenAPI-Starter-Spec stehen; die verpackte Custom-GPT-Action wird in [#13](https://github.com/n0mad-ai/bastra-recall/issues/13) verfolgt.

### Modell-Empfehlungen — wenn ein Release ein anderes lokales Textmodell vorschlägt

**Das lokale Textmodell.** `bastra models` zeigt das lokale Textmodell hinter Stichwort-Erweiterung, Nachsortierung und Entwurfs-Prüfung und dazu, was die RAM-Stufe dieser Maschine trägt (unter 16 GB: keines). `bastra models set <tag>` lädt ein Modell und speichert die Wahl in `~/.bastra/cli-settings.json`; die Umgebungsvariablen `BASTRA_EXPAND_MODEL` / `BASTRA_RERANK_MODEL` überstimmen die gespeicherte Wahl. Das Einbettungsmodell ist etwas anderes (`bastra embeddings`) und bleibt von allem hier Beschriebenen unberührt.

**Was eine Neuinstallation vorgeschlagen bekommt, und was ohne Wahl läuft.** Das sind zwei verschiedene Dinge. Der Installer schlägt ab 16 GB RAM `tev1:4b` vor (4,5 GB Download), bietet ab 24 GB `gemma4:12b` (8,1 GB) als genauere, langsamere Alternative an und schlägt ab 32 GB `gemma4:12b` vor; er lädt und speichert, was du auswählst. Dass `tev1:4b` auf einen 16-GB-Rechner neben das Einbettungsmodell passt, ist aus seiner Größe abgeleitet — der Vergleich hinter dem Vorschlag lief auf einem einzelnen 24-GB-Rechner. Eine Installation, die nie eine Wahl gespeichert hat, läuft weiter mit `gemma3:4b`, dem eingebauten Rückfallwert, genau wie bisher: Der neue Vorschlag stellt an einer bestehenden Installation nichts um. Er zeigt sich dort als Zeile `recommended:` von `bastra models` und als die unten beschriebene Empfehlung. Wo keine Empfehlung offen ist, gibt `bastra models` unter dieser Zeile einen Hinweis `to switch:` aus; er nennt immer das Modell der Zeile `recommended:`, und hat eine Stufe eine größere Alternative, folgt sie in einer eigenen Zeile, `alternative:`.

**Was eine Empfehlung ist.** Ein Release kann eine Empfehlung mitbringen: je Hardware-Stufe (16 GB, 24 GB, ab 32 GB) ein Modell, dessen Downloadgröße und einen Satz dazu, was mit diesem Modell besser wird. Sie steckt im Release selbst, ihre Anzeige braucht also **keinen zusätzlichen Netzzugriff**. Ein Release ohne Empfehlung zeigt nichts und ändert nichts.

**Die aktuelle Empfehlung.** Seit 1.1.0 bringt das Release eine mit, sie heißt `2026-10-tev1`:

| RAM der Maschine | Empfohlenes Modell | Download | Was laut Hinweis besser wird, verglichen mit `gemma3:4b` |
| --- | --- | ---: | --- |
| unter 16 GB | keines | – | – |
| 16 GB bis unter 32 GB | `tev1:4b` | 4,5 GB | weniger falsche Urteile in der Entwurfs-Prüfung, deutlich schwerer durch eingeschleusten Text zu lenken, eine genauere Nachsortierung; ähnliche Antwortzeiten bei Entwurfs-Prüfung/Nachsortierung, aber langsamere Stichwort-Erweiterung und mehr Notizen ohne Phrasen |
| ab 32 GB | `gemma4:12b` | 8,1 GB | weniger falsche Urteile in der Entwurfs-Prüfung, schwerer durch eingeschleusten Text zu lenken, eine klar genauere Nachsortierung — bei etwa dreifacher Antwortzeit |

Die Zahlen hinter diesen Sätzen stehen im [Vergleich lokaler Modelle](local-model-comparison.md#deutsch), gemessen gegen `gemma3:4b` auf einem einzelnen 24-GB-Rechner mit erfundenen Daten. Der Hinweis selbst erscheint auf Englisch. Der Satz vergleicht mit `gemma3:4b`, auch wenn bei dir ein eigenes Modell läuft. Wer bereits ein Modell der aktiven Empfehlung nutzt, bekommt unabhängig von der Stufe keinen automatischen Wechsel-Hinweis: Eine 24-GB-Installation mit `gemma4:12b` wird nicht zu `tev1:4b` aufgefordert, und eine 32-GB-Installation mit `tev1:4b` nicht zu `gemma4:12b`. Der Vergleich ignoriert Groß-/Kleinschreibung und akzeptiert einen Tag, der mit einem aufgeführten Tag und anschließend `-` beginnt (zum Beispiel `gemma4:12b-it-q4_K_M`). Bloße Namen, `:latest` und andere Größen zählen nicht als dieses Modell. `bastra models` zeigt den Vorschlag der Stufe und einen manuellen Wechselbefehl weiterhin. Die Stichwort-Erweiterung dauerte mit `tev1:4b` 1,5 statt 0,9 s, und 16 von 180 Notizen erhielten keine Phrasen statt 1; die ähnlichen Antwortzeiten beziehen sich auf Entwurfs-Prüfung und Nachsortierung.

**Nie automatisch umgestellt.** bastra wechselt dein Modell nie von sich aus — nicht beim Update, nicht mit `update.mode auto`, nicht über den Agenten. Neuinstallationen bekommen das empfohlene Modell einfach vom Installer vorgeschlagen. Bestehende Installationen werden informiert, und die Antwort gehört dir.

**Wann der Hinweis erscheint.** Alle diese Punkte müssen zutreffen:

- das installierte Release bringt eine Empfehlung mit, und sie hat einen Eintrag für die Stufe dieser Maschine;
- die Maschine liegt auf oder über der 16-GB-Stufe (darunter läuft kein Textmodell);
- auf dieser Installation wird ein Textmodell genutzt: Ollama ist der Embedding-Provider (nur dann führt der Daemon Stichwort-Erweiterung, Entwurfs-Prüfung und Such-Copilot aus), oder du hast selbst ein Textmodell eingerichtet — mit `bastra models set` gespeichert oder per Umgebungsvariable festgelegt —, das `bastra bridges harvest` unabhängig vom Embedding-Provider verwendet;
- das wirksame Modell ist nicht schon eines der Modelle der aktiven Empfehlung;
- Update-Hinweise sind nicht abgeschaltet (siehe „Abschalten“ unten);
- du hast noch nicht geantwortet — oder du hast `later` geantwortet und 7 Tage sind vergangen, oder das Release bringt eine neue Empfehlung mit.

**Wann er nicht erscheint.** Sobald einer der Punkte oben nicht zutrifft. Insbesondere: sobald ein Modell der aktiven Empfehlung wirksam ist, nach `switch`, nach `dismiss` und 7 Tage lang nach `later`. Ein Modell außerhalb dieses Satzes bekommt den Hinweis auch dann, wenn du es selbst gewählt hast.

**Wo er erscheint.** An fünf Stellen, die alle einen gemeinsamen Merkzettel deiner Antwort in `~/.bastra/cli-settings.json` lesen — eine Antwort an einer Stelle lässt die anderen verstummen:

1. **`bastra update`** fragt am Ende. Im Terminal wartet es auf eine von drei Tasten; ohne Terminal gibt es nur den Hinweis aus und wartet nie.
2. **Die Nachhol-Abfrage.** Ein Update führt der Updater aus, der vorher installiert war, und ein Updater aus der Zeit vor dieser Funktion kann nicht fragen. Deshalb fragt stattdessen der erste `bastra`-Befehl, den du danach in einem Terminal ausführst — nach der eigenen Ausgabe des Befehls, ohne dessen Exit-Code zu ändern, und einmal je Empfehlung. Sie fragt nicht, wenn `bastra update` schon gefragt hat oder du im Chat oder auf der Kommandozeile schon geantwortet hast. Sie fragt nie ohne Terminal an beiden Enden (also nicht in Pipes, Skripten, Hooks oder Hintergrundläufen) und nie nach `--json`, `--help`, `--version`, `bastra update`, `models`, `config`, `token`, `completion` oder `uninstall`. Enter oder alles, was sie nicht erkennt, zählt als `later`. Strg-C oder Eingabeende merkt keine Antwort: Die anderen Stellen fragen weiter, das Terminal fragt kein zweites Mal. Eine Antwort, die du einen Moment vorher anderswo gegeben hast, wird von der Frage nie ersetzt, und zwei Befehle, die gleichzeitig fertig werden, fragen einmal: Der Anspruch auf die Frage wird unter einer Sperre auf die Einstellungsdatei vergeben. Ist diese Sperre binnen weniger Sekunden nicht zu bekommen — ein anderer bastra-Prozess hält sie, oder einer wurde abgebrochen und hat sie zurückgelassen —, wird nichts gefragt und nichts geschrieben; die Frage kommt beim nächsten Befehl.
3. **`bastra models`** zeigt die Empfehlung jederzeit, auch nachdem du sie abgestellt hast.
4. **Der Sitzungsstart des Agenten** trägt den Hinweis bei jedem Sitzungsstart, bis du geantwortet hast — bewusst, ohne Tagesgrenze. Der Agent ist angewiesen, dir davon zu erzählen, die Downloadgröße zu nennen und zu fragen. Er darf die Befehle unten für dich ausführen, aber erst nach deiner ausdrücklichen Antwort.
5. **Eine gedimmte Zeile nach CLI-Befehlen**, auf stderr, normalerweise einmal am Tag — überall dort, wo die Nachhol-Abfrage nicht greift. Parallele Befehle teilen sich den Tagesmerker. Eine Tagessperre, die älter als etwa zehn Sekunden ist, wird ohne Warten übernommen; übernehmen Befehle gleichzeitig eine verwaiste Sperre, kann die Zeile selten zweimal erscheinen. Ist die Tagessperre frisch oder nicht schreibbar, entfällt dieser Aufruf still und ohne Warten; Sitzungsstart, Update-Frage und Nachhol-Abfrage verwenden diese Sperre nicht. Nicht nach `bastra update`, `models`, `config`, `token`, `completion`, `help` und `version`.

**Die drei Antworten.** Jeder Hinweis gibt die genauen Befehle aus; sie nennen die Empfehlung, auf die sie antworten (und beim Wechsel das Modell):

```bash
bastra models switch <empfehlung> <modell>   # empfohlenes Modell laden, prüfen, dann umstellen
bastra models later <empfehlung>             # beim aktuellen Modell bleiben, in 7 Tagen erneut fragen
bastra models dismiss <empfehlung>           # dabei bleiben, für diese Empfehlung nie mehr fragen
```

- `switch` — siehe „Der sichere Wechsel“ unten. Danach fragt für diese Empfehlung nichts mehr.
- `later` — nichts ändert sich; alle Stellen schweigen 7 Tage und erinnern dich dann (der Sitzungsstart und die gedimmte Zeile; die Frage im Terminal wird nicht wiederholt).
- `dismiss` — nichts ändert sich, und der Hinweis **kommt** für diese Empfehlung **nicht wieder**. Du verzichtest damit möglicherweise auf bessere Recall-Qualität. Das steht überall, wo `dismiss` angeboten oder bestätigt wird, und der Agent sagt es dir, bevor er den Befehl ausführt. `bastra models` zeigt die Empfehlung weiterhin, du kannst später immer noch wechseln, und eine spätere, neue Empfehlung fragt wieder.

Alle drei funktionieren ohne Terminal.

**Eine Antwort gilt nur für das, was dir gezeigt wurde.** Die Befehle tragen den Namen der Empfehlung, weil Hinweis und Befehl von zwei verschiedenen Programmen kommen können: von einem Daemon, der noch die vorige Version ist, und einer Kommandozeile, die schon die neue ist. Hat sich die Empfehlung dazwischen geändert oder nennt der Befehl keine, lehnt bastra ihn ab, sagt, was die aktuelle Empfehlung ist, und ändert nichts — ein Ja zu einem Modell lädt nie ein anderes. Aus demselben Grund hängt die Antwort nicht von der Shell ab, in der sie getippt wird: Ist das empfohlene Modell zufällig in deiner Shell per Umgebungsvariable festgelegt, im Daemon aber nicht, wird die Antwort trotzdem gespeichert und der Daemon hört auf zu fragen.

**Der sichere Wechsel.** `bastra models switch …` tut diese Dinge in dieser Reihenfolge: Es lädt das neue Modell (entfällt, wenn es schon da ist), schickt ihm eine kurze echte Anfrage und speichert erst, wenn diese beantwortet wurde, das neue Modell zusammen mit deiner Antwort — in einem Schreibvorgang, sodass es nie ein neues Modell ohne die Antwort gibt oder umgekehrt. Der Daemon liest das Modell beim Start, danach also neu starten (`bastra update` startet ihn neu, oder du startest deine KI-Clients neu).

**Mit welchem Ollama der Wechsel spricht.** Jede Anfrage des Wechsels — läuft Ollama, ist das Modell da, die Testanfrage — geht an eine einzige Adresse, die vor der ersten Anfrage aus `BASTRA_OLLAMA_URL` (Standard `http://localhost:11434`) ermittelt wird. Diese Adresse muss auf diesem Rechner liegen, Weiterleitungen werden abgelehnt, und eine Query oder ein Fragment der konfigurierten URL bleibt weg. Der Wechsel wird ohne eine einzige Anfrage abgelehnt, wenn die konfigurierte URL auf einen anderen Rechner zeigt, wenn sie Benutzername oder Passwort trägt (`http://user:pass@host`) oder wenn sie sich nicht als http(s)-URL lesen lässt. Die Ablehnung nennt höchstens den Host — nie den Benutzernamen, das Passwort, ein Token oder den Rest der URL, in welcher Schreibweise auch immer sie eingetragen wurden —, weil die Ausgabe des Befehls in einem Chat-Verlauf landen kann. In diesen Fällen wechselt `bastra models set <tag>` ohne die Testanfrage.

**Wenn etwas scheitert.** Läuft Ollama nicht, scheitert das Laden oder wird es abgebrochen, scheitert die Testanfrage oder kommt leer zurück, oder lässt sich die Einstellung nicht speichern, gibt der Befehl den Grund aus, endet mit Code 1 und ändert nichts: Dein Modell bleibt, wie es war, und die Frage bleibt offen. Dasselbe gilt, wenn `~/.bastra/cli-settings.json` kein gültiges JSON ist oder zwar da ist, aber nicht gelesen werden kann (falsche Rechte zum Beispiel): bastra schreibt dann nicht hinein, statt deine anderen Einstellungen durch Standardwerte zu ersetzen — repariere zuerst die Datei oder ihre Rechte. Der zweite Fall ist keine Besonderheit der Modell-Entscheidungen: Ein Befehl, der eine Einstellung speichert, liest die Datei einmal, ändert genau das Gelesene und schreibt nicht, wenn diese eine Lesung fehlgeschlagen ist. Eine Modell-Antwort oder ein Wechsel wird außerdem mit einer Meldung abgelehnt, wenn die Sperre auf die Einstellungsdatei nicht zu bekommen ist (ein anderer bastra-Prozess hält sie, oder ein abgebrochener hat sie zurückgelassen; nach etwa zehn Sekunden wird sie übernommen) — nichts wird geschrieben, und du kannst den Befehl einfach wiederholen.

**Zurückwechseln.** Das alte Modell wird nie gelöscht. Nach einem Wechsel gibt der Befehl den genauen Weg zurück aus: `bastra models set <vorheriger tag>`. Ein ungenutztes Modell von der Platte zu entfernen ist deine Sache (`ollama rm <tag>`).

**Mit gesetztem `BASTRA_EXPAND_MODEL` oder `BASTRA_RERANK_MODEL`.** Du bekommst den Hinweis ebenfalls. Er nennt die Variable und sagt, dass sie die gespeicherte Wahl überstimmt: ein Wechsel speichert das neue Modell, aber die Variable gewinnt weiter, bis du sie entfernst und den Daemon neu startest. Nennt die Variable bereits ein Modell der aktiven Empfehlung, gibt es keinen Hinweis. Der Hinweis beim Sitzungsstart des Agenten zeigt dein aktuelles Modell nur, wenn es ein schlichter Modell-Tag ist (Buchstaben, Ziffern und `. _ - : /`); alles andere erscheint als „a custom model“, und die Variable wird ohne ihren Wert genannt.

**Abschalten.** `BASTRA_UPDATE_CHECK=off` lässt den Hinweis beim Sitzungsstart, nach CLI-Befehlen (Nachhol-Abfrage und gedimmte Zeile) und am Ende von `bastra update` verstummen; `bastra config set update.mode off` ebenso. `bastra models dismiss <empfehlung>` stellt eine einzelne Empfehlung ab. `bastra models` zeigt sie immer, egal was abgeschaltet ist.

### Akkumodus — Ollama-Hintergrundarbeit nicht auf dem Akku (macOS)

Optional, standardmäßig aus: `bastra config set battery.saver on` (oder
`BASTRA_BATTERY_SAVER=1` in der Umgebung des Daemons, das hat Vorrang vor der Datei),
dann den Daemon neu starten. Er prüft die Stromquelle einmal pro Minute mit
`pmset -g batt`; ein Ein- oder Ausstecken wirkt innerhalb von 60 s. Solange der Mac
auf Akku läuft:

- wartet das Hintergrund-Paraphrasieren (doc2query) samt Nachholrunde auf Netzstrom,
- wird das Embedding-Modell weder beim Boot noch beim Turn- oder Sitzungsstart vorgewärmt,
- wird das Modell nach 60 s ohne Embed entladen statt nach dem eingestellten
  `BASTRA_OLLAMA_IDLE_UNLOAD_MS`-Fenster.

Ein ausdrückliches `recall` nutzt weiter die semantische Suche; das erste nach einem
Entladen ist etwa 0,5–1 s langsamer, weil es das Modell lädt. Die Hook-Lanes bleiben
unverändert. Unter Linux und Windows lautet die Stromquelle `unknown`, und nichts wird
verschoben. `/health` meldet `power: {battery_saver, source, saving}`, und `bastra doctor`
zeigt eine Zeile „battery saver". Die Ollama-App selbst oder andere Ollama-Clients kann
bastra nicht anhalten; ein untätiger Ollama-Server ohne geladenes Modell kostet wenig.

### Commons-Verifikation und Bridge-Sprache

`bastra commons verify` öffnet einen öffentlichen Pull Request mit Rezept-ID, Ergebnis (funktioniert/nicht), optionaler Notiz, Verifier-ID, Betriebssystem, CPU-Architektur und Node-Version. Dein Vault wird dabei nicht übertragen. Scheitert die Einreichung, bleibt der Eintrag zur manuellen Abgabe lokal liegen.

`bastra bridges language <code>` beschränkt die Anfrage-Erweiterung auf einen Sprachordner; `auto` durchsucht alle Ordner. Neue Bridges werden unabhängig von dieser Einstellung nach der erkannten Sprache ihrer Quellanfrage abgelegt.

### Fehlerbehebung

- **Ollama meldet `using already-running ollama on 11434`** — nach der ersten Prüfung hat ein anderer Server geantwortet. Bastra nutzt ihn, ohne einen zweiten Server zu starten; ein brew- oder systemd-Start wird nur nach einem erfolgreichen Startbefehl gemeldet.
- **Daemon nicht erreichbar / `ECONNREFUSED`** — der MCP-Forwarder startet den Daemon normalerweise beim ersten Tool-Aufruf selbst. Prüfen mit `curl -sS http://127.0.0.1:6723/health`; `bastra status` zeigt dasselbe in lesbar. Falls der Forwarder abgeschaltet wurde (`BASTRA_FORWARDER_SPAWN=0`), die Variable entfernen und den AI-Client neu starten.
- **MCP ist in Claude Code, Claude Desktop, Codex/ChatGPT Desktop oder Cursor nicht registriert** — `bastra doctor` zeigt, welche Config fehlt oder kaputt ist, danach `bastra install <surface>` erneut ausführen. Die Config-Pfade stehen in beiden Ausgaben.
- **Eine Funktion scheint nichts zu tun** (Memories kommen auf Englisch, keine Speichervorschläge, Recall schaut nie zuerst in den Vault) — `bastra doctor` endet mit dem Abschnitt **features**: eine Zeile pro Funktion, an oder aus, und für jede ausgeschaltete der Befehl zum Einschalten (`bastra config set language.primary <code>`, `bastra config set reflex.enabled true`, `bastra config set promptImpact.enabled true`, `bastra onboard`, `bastra embeddings on`, `bastra install <surface>` …). Auch Claude Codes eigenes `"disableAllHooks": true` taucht dort auf. Ebenso zwei Env-Schlüssel im MCP-Eintrag eines Clients, die einschränken, was das Modell tun kann: `BASTRA_TOOL_SURFACE=search` (nur Recall, der Agent kann nie speichern) und `BASTRA_MCP_SESSION_CONTEXT=0` (kein Sitzungskontext beim ersten Tool-Aufruf), jeweils mit dem Eintrag, der zu ändern ist. Funktionen, die bewusst standardmäßig aus sind — Code-Awareness, der experimentelle Change-Impact-Block, Produktdoku, Commons, Bridges, die Vault-Karte, das archivierende `rm` für Claude Code — stehen unter einer eigenen Überschrift als gewollt, nicht als Problem. Nichts davon ändert den Exit-Code von doctor, und `--fix` schaltet nie eine Funktion ein.
- **`the settings file exists but cannot be read`** — `~/.bastra/cli-settings.json` ist da, aber dein User darf sie nicht lesen (oder sie ist ein Verzeichnis). bastra hält an, statt eine frische Datei darüberzuschreiben, weil dabei jede Einstellung darin verloren ginge. Rechte korrigieren (`chmod 600 ~/.bastra/cli-settings.json`) und den Befehl erneut ausführen. Das gilt für jeden Befehl, der eine Einstellung speichert.
- **`could not get the lock on the settings file`** — eine Modell-Antwort oder ein Wechsel hat `~/.bastra/cli-settings.json.lock` von einem anderen bastra-Prozess gehalten vorgefunden, oder von einem abgebrochenen zurückgelassen. Es wurde nichts geschrieben. Ein paar Sekunden warten und den Befehl wiederholen; eine Sperre, die niemand mehr hält, wird nach etwa zehn Sekunden übernommen.
- **Vault-Pfad fehlt oder ist nicht beschreibbar** — beim Installieren `--vault <pfad>` übergeben oder `BASTRA_VAULT_PATH` setzen. Der Ordner muss existieren und dein User dort `.md`-Dateien anlegen dürfen; zum Testen einen Wegwerf-Vault nehmen.
- **Port `6723` ist belegt** — Besitzer finden mit `lsof -i :6723 -P -n`. Entweder den alten Prozess stoppen oder den Daemon per `BASTRA_HTTP_PORT=<port>` umziehen und Forwarder/Hooks über `BASTRA_DAEMON_URL` / `BASTRA_HTTP_URL` auf denselben Endpoint zeigen lassen.
- **Recall liefert nichts oder Treffer aus dem falschen Vault** — den registrierten Vault mit `bastra doctor` prüfen. Memory-Dateien brauchen gültiges YAML-Frontmatter; ungültige werden übersprungen. Die zweite häufige Ursache sind schwache oder fehlende `recall_when`-Werte — dieses Feld hat das größte Suchgewicht.
- **Semantischer Recall steht auf `degraded`** — der Daemon ist mit Embeddings gestartet, aber der Provider antwortet nicht mehr (Ollama läuft nicht, Modell gelöscht). `/health` meldet `semantic_recall: "degraded"` samt Fehler; Recall läuft auf BM25 weiter. Beheben mit `ollama serve` bzw. `bastra embeddings on`.
- **Statusline-Kosten haben sich geändert** — Cache-Schreibtokens mit 1h-Laufzeit werden jetzt zum 1h-Preis berechnet. Fehlt dieser Wert für ein Modell in der externen Preistabelle, schätzt die Anzeige den Anteil zum 5m-Preis, statt `NaN` auszugeben.
- **Heute in der Statusline** — Einträge von gestern werden nach Mitternacht nicht als heutige Nutzung wiederverwendet. Auch ein gültiges leeres Tagesergebnis bleibt im Cache, damit die Anzeige vor der ersten Aktivität nicht bei jedem Refresh die Transkripte neu liest.
- **Mehrsprachige Ausrichtung der Statusline** — nichtabstandnehmende kombinierende Zeichen verbrauchen unabhängig von der Schrift keine Terminalspalte; abstandnehmende Zeichen behalten ihre Breite. Beschriftungen mit hebräischen, arabischen, thailändischen oder tamilischen Zeichen bleiben dadurch ausgerichtet.
- **Wo die Logs liegen** — `bastra logs` zeigt sie lesbar an (`-f` zum Mitlaufen, `--since 1h`, `--source hook|daemon`): eine Zeile pro Event statt rohem JSONL. Die Dateien selbst liegen außerhalb des Vaults unter `~/.bastra/logs/events-YYYY-MM-DD.jsonl` (überschreibbar mit `BASTRA_LOG_PATH`). Event-Logs älter als **90 Tage** löscht der Daemon selbst (`BASTRA_LOG_RETENTION_DAYS`); die Untergrenze sind 30 Tage, weil der Curator dieses Fenster für Reflex-Promotions auswertet — ein kleinerer Wert würde den Recall still verschlechtern.
- **Context-ROI lesen** — `bastra logs --stats` zeigt Hint-Tokens pro verwendetem Load für Pre-Tool-, Session- und Bash-Pre-Hooks. Die Zeile nennt, wie viele Loads eine zuordenbare Quelle hatten; ältere oder nicht passende Loads werden als nicht zuordenbar ausgewiesen statt in die Quote geraten.
- **Dimensions-Etiketten lesen** — die Statistik trennt Zeilen vor der Dimensions-Erfassung (`pre-#263`), aktuelle Load-/Read-Tool-Calls ohne Stempel (`tool call — not stamped`) und Recall-IDs ohne passende `hook_recall`-Zeile (`unmatched`). Ein solcher Treffer kann auch ein Reflex-Hinweis sein und beweist keinen Schnitt am Zeitfenster.
- **Die Spalte `candidates` lesen** — die Use-Rate-Tabellen in `packages/daemon/scripts/stats.ts` und im Telemetrie-Tab („Recall quality": Trefferbänder und Hinweisquellen; `candidates` im `/ui/telemetry`-Report) zählen `candidates`: die Top-k der Engine je Hook-Recall, bevor der Hook Score-Untergrenze, Scope-Filter und Dedup pro Session anwendet. Das ist nicht die Zahl der Hinweise, die ein Client gesehen hat — diese Zahl steht nicht in diesen Tabellen; der Usage-Sidecar führt sie je Memory über die gesamte Laufzeit. `loaded / candidates` ist deshalb eine Untergrenze.
- **Abgeleiteten Zustand zurücksetzen, ohne Memories zu verlieren** — Daemon stoppen, dann ausschließlich abgeleitete Dateien in `<vault>/.bastra/` löschen: `embeddings.json` und `embed-cache.json` bauen sich beim nächsten Start neu auf. Niemals die `.md`-Dateien, `audit-log.ndjson` oder `trash/` löschen, außer du willst bewusst Nutzerdaten entfernen.
