# Usage guide / Nutzungshandbuch

Everything that used to live in the README in full length: day-to-day scenarios, manual install, feature guides, the REST API reference and troubleshooting. The README keeps the short version; this file keeps the depth.

Alles, was früher in voller Länge in der README stand: Alltags-Szenarien, manuelle Installation, Feature-Guides, die REST-API-Referenz und Fehlerbehebung. Die README behält die Kurzfassung; diese Datei die Tiefe.

---

## 🇬🇧 English

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
- **`UserPromptSubmit`**, **`TodoWrite`**, **Bash safety**, and **Bash failure** hooks cover lookup prompts, topology recall before plans, destructive-command safety, and command-failure lesson recall.

The **`Stop`** save-eval hook is on by default: since the #48 redesign it is silent — suggestions go to a file the next session reads, with no chat noise. Opt out with `bastra install claude-code --no-stop-hook`. Telemetry (`scripts/stats.ts`) tracks per-hook latency, hint-quality, and follow-through (did the AI actually `load_memory` after a hint).

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

`bastra install claude-code` does both of these for you. Re-run `install.sh` whenever a skill file changes; re-run `install-hook.sh` only if hook binary paths move. To remove the hooks again: `bash packages/skill/install-hook.sh --uninstall`.

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

### Onboarding — five minutes to a warm start

A fresh vault offers to seed itself. Pick what your memory will mainly hold — code & projects, company & decisions, life & knowledge, or a mix — and answer a handful of persona-aware questions; every answer becomes a profile memory your AI recalls from day one. Three surfaces, one interview: the vault map auto-opens it on a fresh vault, `bastra onboard` runs it in the terminal, and your AI session offers it conversationally — the most adaptive of the three, it follows up where an answer is thin. Skippable everywhere, never asked twice.

### Importing memories — skip the cold start

Your other AI tools already know you — `bastra import` brings that head start along instead of starting cold. Three paths, one gate: candidates land as checkbox lines in `import-review.md` at the vault root, and your **next AI session distills accepted ones with you** — proper type, concrete triggers, deduped against what the vault already holds. Nothing is saved without your accept.

```bash
bastra import memories.txt         # a memory list: ChatGPT / Claude / Gemini export, free text — or paste via `bastra import -`
bastra import conversations.json   # a full data export (ChatGPT / Claude) — queued for chunk-wise mining
bastra import rules                # local rules files: CLAUDE.md, AGENTS.md, .cursorrules, .cursor/rules/, ~/.claude/CLAUDE.md
bastra import vault <dir>          # a whole folder of memory files (e.g. a Claude Code memory dir) — no review needed
```

A `conversations.json` never stages raw chat history: only **your own messages** are kept (assistant turns dropped), queued locally under `~/.bastra/` — it never leaves the machine, is deleted when mining completes, and `bastra import clear` discards it anytime. Your AI session combs the queue chunk-wise (`bastra import mine`) and stages candidate lessons, decisions and preferences for your review. The vault map carries a visual import dialog (topbar ↓) for the paste path and the folder path.

`import vault` is the fourth path and skips the gate on purpose: a folder of already-structured memory files (Claude Code's `name`/`description`/`type` frontmatter — both its variants — or plain markdown notes) carries every field a memory needs, so it maps deterministically. The set lands isolated under `memories/imported/<label>/` with its own scope and namespaced ids — nothing existing is read or modified, re-import is idempotent, and deleting that one folder removes the whole set.

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

### REST API (for non-MCP clients)

The daemon exposes a REST API on `http://127.0.0.1:6723/api/v1/` covering every tool the MCP server offers. This is the integration point for clients that can't speak stdio-MCP.

Endpoints (all `POST`, JSON body):

| Endpoint | Tool |
|---|---|
| `/api/v1/recall` | recall |
| `/api/v1/load_memory` | load_memory |
| `/api/v1/save_memory` | save_memory |
| `/api/v1/find_document` / `read_document` / `open_document` | document search |
| `/api/v1/save_document` / `recategorize_document` / `move_document` | document write (Pro) |
| `/api/v1/save_product_doc` | product docs |

In addition, `GET`/`POST /settings/docs` reads/writes the product-docs settings (`{mode, language}`) — loopback-only like `/hook/*`, intended for local UIs such as the Bastra Mac app's options pane.

**Liveness:** `GET /health` (token-free on loopback) and `GET /api/v1/health` (token + CORS, for browsers) return the same document — `ok`, `version`, `vault_size`, `uptime_seconds`, `started_at`, and the semantic-recall state (`on` / `off` / `degraded`). Neither counts as activity, so probing does not keep the daemon from its idle shutdown. A daemon whose `uptime_seconds` keeps resetting is restarting behind your back.

Auth and CORS:

- **Token:** `bastra token` prints the daemon's API token, minting one on first use (`bastra token rotate` issues a fresh one; `bastra token clear` removes it, locking out browser/REST clients). It's stored in `cli-settings.json`; the daemon reads it at startup, so restart after issuing, rotating, or clearing. `bastra` (the status panel) and `bastra status` show whether a token is set, without printing it. `BASTRA_API_TOKEN` overrides it.
- **Local tools** (CLI, MCP-forwarder — no `Origin` header) reach `/api/v1/*` over loopback without a token. Set `BASTRA_AUTH_LOOPBACK_SKIP=0` to require the token even for them.
- **Browser clients** (any request *with* an `Origin` header) must always present the token **and** be on the CORS allowlist — even over loopback, since the user's browser shares `127.0.0.1` with the daemon and only the `Origin` header tells a real site from a stray one.
- **CORS** is deny-by-default: with `BASTRA_CORS_ORIGIN` unset, **no** browser origin is allowed. For a hosted web app, set an allowlist: `BASTRA_CORS_ORIGIN=https://your.host` (comma-separated for several) — the daemon then reflects only listed origins and a browser blocks the rest. `BASTRA_CORS_ORIGIN=*` remains available as an explicit tunnel/dev opt-in (the daemon logs a warning when combined with a minted token).
- **DNS rebinding** is blocked: the token-less loopback endpoints (`/health`, `/hook/*`, `/vault/count`) only answer requests whose `Host` header is loopback (`127.0.0.1` / `localhost` / `[::1]`). `/api/v1/*` is unaffected (the token protects it). Tunnel setups that need more than `/api/v1/*` can allowlist hosts via `BASTRA_ALLOWED_HOSTS` (comma-separated).

To reach this daemon from a hosted web app (e.g. a site's admin talking to the user's *local* vault from the browser), set `BASTRA_CORS_ORIGIN` to the site origin, run `bastra token`, and paste the token into the site. When that site is served over **HTTPS** (e.g. `https://bastra.io`), Chrome sends a **Private Network Access** preflight for the public-origin → localhost call; the daemon answers it automatically with `Access-Control-Allow-Private-Network: true` for allowed origins — no extra config. For a server-side client, point a tunnel (Cloudflare Tunnel / ngrok / your own reverse proxy) at `127.0.0.1:6723` and configure it with the tunnel URL + your token. An OpenAPI 3.0 starter spec lives in [openapi.yaml](./openapi.yaml).

> **Status:** the ChatGPT Custom GPT Actions path does **not work end-to-end yet**. The REST API and the OpenAPI starter spec are in place; the packaged Custom-GPT action is tracked in [#13](https://github.com/n0mad-ai/bastra-recall/issues/13).

### Troubleshooting

- **Daemon not reachable / `ECONNREFUSED`** — the MCP forwarder normally auto-spawns the daemon on the first tool call. Check with `curl -sS http://127.0.0.1:6723/health`; `bastra status` shows the same thing in readable form. If the forwarder was disabled (`BASTRA_FORWARDER_SPAWN=0`), remove that override and restart your AI client.
- **MCP is not registered with Claude Code, Claude Desktop, Codex/ChatGPT Desktop, or Cursor** — run `bastra doctor` to see which config is missing or broken, then re-run `bastra install <surface>`. The config paths are printed in both outputs.
- **Vault path missing or not writable** — pass `--vault <path>` during install or set `BASTRA_VAULT_PATH`. The directory must exist and your user must be able to create `.md` files in it; use a throwaway vault while testing.
- **Port `6723` already in use** — find the owner with `lsof -i :6723 -P -n`. Either stop the stale process or move the daemon with `BASTRA_HTTP_PORT=<port>` and point forwarders/hooks at the same endpoint via `BASTRA_DAEMON_URL` / `BASTRA_HTTP_URL`.
- **Recall returns nothing, or hits from the wrong vault** — confirm the registered vault with `bastra doctor`. Memory files need valid YAML frontmatter; files that fail validation are skipped. Weak or missing `recall_when` values are the other common cause — that field carries the most search weight.
- **Semantic recall shows `degraded`** — the daemon booted with embeddings on, but the provider stopped answering (Ollama not running, model deleted). `/health` reports `semantic_recall: "degraded"` plus the underlying error; recall keeps working on BM25 alone. Fix with `ollama serve` / `bastra embeddings on`.
- **Where logs live** — `bastra logs` renders them readably (`-f` to follow, `--since 1h`, `--source hook|daemon`); one line per event instead of raw JSONL. The files themselves sit outside the vault at `~/.bastra/logs/events-YYYY-MM-DD.jsonl` (override: `BASTRA_LOG_PATH`). The daemon deletes event logs older than **90 days** (`BASTRA_LOG_RETENTION_DAYS`); the floor is 30 days, because the curator mines that window for reflex promotions and a shorter setting would quietly degrade recall.
- **Reset derived state without losing memories** — stop the daemon, then delete only derived files inside `<vault>/.bastra/`: `embeddings.json` and `embed-cache.json` rebuild themselves on the next start. Never delete your `.md` files, `audit-log.ndjson`, or `trash/` unless you intend to remove user data.

---

## 🇩🇪 Deutsch

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
- **`UserPromptSubmit`**, **`TodoWrite`**, **Bash-Safety** und **Bash-Failure** decken Lookup-Prompts, Topology-Recall vor Plänen, Safety bei riskanten Shell-Befehlen und Lesson-Recall bei fehlgeschlagenen Commands ab.

Der **`Stop`** Save-Eval-Hook ist standardmäßig an: seit dem #48-Redesign ist er still — Vorschläge landen in einer Datei, die die nächste Session liest, ohne Chat-Rauschen. Abwählen mit `bastra install claude-code --no-stop-hook`. Die Telemetrie (`scripts/stats.ts`) misst pro Hook Latenz, Hint-Qualität und Follow-Through (hat die AI nach einem Hint wirklich `load_memory` gemacht).

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

`bastra install claude-code` erledigt beides für dich. `install.sh` neu ausführen, wenn sich eine Skill-Datei ändert; `install-hook.sh` nur, wenn sich Hook-Binärpfade verschieben. Hooks wieder entfernen: `bash packages/skill/install-hook.sh --uninstall`.

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

### Onboarding — in fünf Minuten zum Warmstart

Ein frischer Vault bietet an, sich selbst zu befüllen. Du wählst, was dein Gedächtnis hauptsächlich halten soll — Code & Projekte, Firma & Entscheidungen, Leben & Wissen oder ein Mix — und beantwortest eine Handvoll persona-bewusster Fragen; jede Antwort wird ein Profil-Memory, das deine KI vom ersten Tag an abruft. Drei Oberflächen, ein Interview: Die Vault-Map öffnet es bei frischem Vault automatisch, `bastra onboard` führt es im Terminal, und deine AI-Session bietet es im Gespräch an — die adaptivste der drei, sie hakt nach, wo eine Antwort dünn ist. Überall überspringbar, nie doppelt gefragt.

### Memories importieren — den Kaltstart überspringen

Deine anderen AI-Tools kennen dich schon — `bastra import` nimmt diesen Vorsprung mit, statt bei null anzufangen. Drei Wege, ein Gate: Kandidaten landen als Checkbox-Zeilen in `import-review.md` im Vault-Root, und deine **nächste AI-Session destilliert akzeptierte gemeinsam mit dir** — richtiger Typ, konkrete Trigger, dedupliziert gegen den Bestand. Nichts wird ohne dein Okay gespeichert.

```bash
bastra import memories.txt         # eine Memory-Liste: ChatGPT- / Claude- / Gemini-Export, Freitext — oder Paste via `bastra import -`
bastra import conversations.json   # ein kompletter Daten-Export (ChatGPT / Claude) — wird für Chunk-weises Mining gequeued
bastra import rules                # lokale Rules-Dateien: CLAUDE.md, AGENTS.md, .cursorrules, .cursor/rules/, ~/.claude/CLAUDE.md
bastra import vault <dir>          # ein ganzer Ordner Memory-Dateien (z.B. ein Claude-Code-Memory-Dir) — ohne Review
```

Eine `conversations.json` staged nie rohe Chat-History: Nur **deine eigenen Messages** bleiben (Assistant-Antworten fliegen raus), lokal gequeued unter `~/.bastra/` — verlässt nie die Maschine, wird nach dem Mining gelöscht, `bastra import clear` verwirft jederzeit. Deine AI-Session kämmt die Queue Chunk-weise durch (`bastra import mine`) und staged Kandidaten-Lessons, -Entscheidungen und -Präferenzen für deine Review. Die Vault-Map hat einen visuellen Import-Dialog (Topbar ↓) für den Paste-Weg und den Ordner-Weg.

`import vault` ist der vierte Weg und überspringt das Gate bewusst: Ein Ordner bereits strukturierter Memory-Dateien (Claude Codes `name`/`description`/`type`-Frontmatter — beide Varianten — oder schlichte Markdown-Notizen) trägt jedes Feld, das ein Memory braucht, und mappt deshalb deterministisch. Der Satz landet isoliert unter `memories/imported/<label>/` mit eigenem Scope und namespaced ids — nichts Bestehendes wird gelesen oder verändert, Re-Import ist idempotent, und das Löschen dieses einen Ordners entfernt den ganzen Satz.

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

### REST API (für Nicht-MCP-Clients)

Der Daemon exponiert eine REST-API unter `http://127.0.0.1:6723/api/v1/`, die alle Tools des MCP-Servers abdeckt. Das ist der Integrationspunkt für Clients, die kein stdio-MCP sprechen können.

Endpoints (alle `POST`, JSON-Body):

| Endpoint | Tool |
|---|---|
| `/api/v1/recall` | recall |
| `/api/v1/load_memory` | load_memory |
| `/api/v1/save_memory` | save_memory |
| `/api/v1/find_document` / `read_document` / `open_document` | Document-Suche |
| `/api/v1/save_document` / `recategorize_document` / `move_document` | Document-Schreiben (Pro) |
| `/api/v1/save_product_doc` | Produkt-Doku |

Zusätzlich liest/schreibt `GET`/`POST /settings/docs` die Produkt-Doku-Settings (`{mode, language}`) — loopback-only wie `/hook/*`, gedacht für lokale UIs wie die Options-Pane der Bastra Mac-App.

**Liveness:** `GET /health` (auf Loopback ohne Token) und `GET /api/v1/health` (Token + CORS, für Browser) liefern dasselbe Dokument — `ok`, `version`, `vault_size`, `uptime_seconds`, `started_at` und den Zustand des semantischen Recalls (`on` / `off` / `degraded`). Beide zählen nicht als Aktivität, ein Polling hält den Daemon also nicht vom Idle-Shutdown ab. Ein Daemon, dessen `uptime_seconds` immer wieder zurückspringt, startet unbemerkt neu.

Auth und CORS:

- **Token:** `bastra token` zeigt das API-Token des Daemons und erzeugt beim ersten Aufruf eines (`bastra token rotate` erneuert es; `bastra token clear` entfernt es und sperrt Browser-/REST-Clients aus). Es liegt in `cli-settings.json`; der Daemon liest es beim Start, also nach Erzeugen, Erneuern oder Entfernen neu starten. `bastra` (das Status-Panel) und `bastra status` zeigen, ob ein Token gesetzt ist, ohne es anzuzeigen. `BASTRA_API_TOKEN` hat Vorrang.
- **Lokale Tools** (CLI, MCP-Forwarder — kein `Origin`-Header) erreichen `/api/v1/*` über Loopback ohne Token. Mit `BASTRA_AUTH_LOOPBACK_SKIP=0` wird das Token auch von ihnen verlangt.
- **Browser-Clients** (jeder Request *mit* `Origin`-Header) müssen immer das Token tragen **und** auf der CORS-Allowlist stehen — auch über Loopback, denn der Browser des Users teilt sich `127.0.0.1` mit dem Daemon und nur der `Origin`-Header trennt eine echte Seite von einer fremden.
- **CORS** ist deny-by-default: ohne gesetztes `BASTRA_CORS_ORIGIN` ist **keine** Browser-Origin erlaubt. Für eine gehostete Web-App eine Allowlist setzen: `BASTRA_CORS_ORIGIN=https://dein.host` (kommagetrennt für mehrere) — der Daemon spiegelt dann nur gelistete Origins zurück, den Rest blockt der Browser. `BASTRA_CORS_ORIGIN=*` bleibt als explizites Tunnel/Dev-Opt-in (der Daemon warnt, wenn dabei ein Token gemintet ist).
- **DNS-Rebinding** wird geblockt: Die token-losen Loopback-Endpoints (`/health`, `/hook/*`, `/vault/count`) antworten nur auf Requests, deren `Host`-Header loopback ist (`127.0.0.1` / `localhost` / `[::1]`). `/api/v1/*` ist nicht betroffen (dort schützt das Token). Tunnel-Setups, die mehr als `/api/v1/*` brauchen, können Hosts via `BASTRA_ALLOWED_HOSTS` (kommagetrennt) freischalten.

Um diesen Daemon aus einer gehosteten Web-App zu erreichen (z.B. das Admin einer Seite, das aus dem Browser auf den *lokalen* Vault des Users zugreift): `BASTRA_CORS_ORIGIN` auf die Seiten-Origin setzen, `bastra token` ausführen und das Token in der Seite hinterlegen. Läuft die Seite über **HTTPS** (z.B. `https://bastra.io`), schickt Chrome für den Public-Origin-→-localhost-Call einen **Private-Network-Access**-Preflight; der Daemon beantwortet ihn für erlaubte Origins automatisch mit `Access-Control-Allow-Private-Network: true` — ohne Zusatzkonfiguration. Für einen serverseitigen Client: einen Tunnel (Cloudflare Tunnel / ngrok / eigener Reverse-Proxy) auf `127.0.0.1:6723` legen und mit Tunnel-URL + Token konfigurieren. Eine OpenAPI-3.0-Starter-Spec liegt in [openapi.yaml](./openapi.yaml).

> **Status:** Der ChatGPT-Custom-GPT-Actions-Weg **funktioniert noch nicht end-to-end**. REST-API und OpenAPI-Starter-Spec stehen; die verpackte Custom-GPT-Action wird in [#13](https://github.com/n0mad-ai/bastra-recall/issues/13) verfolgt.

### Fehlerbehebung

- **Daemon nicht erreichbar / `ECONNREFUSED`** — der MCP-Forwarder startet den Daemon normalerweise beim ersten Tool-Aufruf selbst. Prüfen mit `curl -sS http://127.0.0.1:6723/health`; `bastra status` zeigt dasselbe in lesbar. Falls der Forwarder abgeschaltet wurde (`BASTRA_FORWARDER_SPAWN=0`), die Variable entfernen und den AI-Client neu starten.
- **MCP ist in Claude Code, Claude Desktop, Codex/ChatGPT Desktop oder Cursor nicht registriert** — `bastra doctor` zeigt, welche Config fehlt oder kaputt ist, danach `bastra install <surface>` erneut ausführen. Die Config-Pfade stehen in beiden Ausgaben.
- **Vault-Pfad fehlt oder ist nicht beschreibbar** — beim Installieren `--vault <pfad>` übergeben oder `BASTRA_VAULT_PATH` setzen. Der Ordner muss existieren und dein User dort `.md`-Dateien anlegen dürfen; zum Testen einen Wegwerf-Vault nehmen.
- **Port `6723` ist belegt** — Besitzer finden mit `lsof -i :6723 -P -n`. Entweder den alten Prozess stoppen oder den Daemon per `BASTRA_HTTP_PORT=<port>` umziehen und Forwarder/Hooks über `BASTRA_DAEMON_URL` / `BASTRA_HTTP_URL` auf denselben Endpoint zeigen lassen.
- **Recall liefert nichts oder Treffer aus dem falschen Vault** — den registrierten Vault mit `bastra doctor` prüfen. Memory-Dateien brauchen gültiges YAML-Frontmatter; ungültige werden übersprungen. Die zweite häufige Ursache sind schwache oder fehlende `recall_when`-Werte — dieses Feld hat das größte Suchgewicht.
- **Semantischer Recall steht auf `degraded`** — der Daemon ist mit Embeddings gestartet, aber der Provider antwortet nicht mehr (Ollama läuft nicht, Modell gelöscht). `/health` meldet `semantic_recall: "degraded"` samt Fehler; Recall läuft auf BM25 weiter. Beheben mit `ollama serve` bzw. `bastra embeddings on`.
- **Wo die Logs liegen** — `bastra logs` zeigt sie lesbar an (`-f` zum Mitlaufen, `--since 1h`, `--source hook|daemon`): eine Zeile pro Event statt rohem JSONL. Die Dateien selbst liegen außerhalb des Vaults unter `~/.bastra/logs/events-YYYY-MM-DD.jsonl` (überschreibbar mit `BASTRA_LOG_PATH`). Event-Logs älter als **90 Tage** löscht der Daemon selbst (`BASTRA_LOG_RETENTION_DAYS`); die Untergrenze sind 30 Tage, weil der Curator dieses Fenster für Reflex-Promotions auswertet — ein kleinerer Wert würde den Recall still verschlechtern.
- **Abgeleiteten Zustand zurücksetzen, ohne Memories zu verlieren** — Daemon stoppen, dann ausschließlich abgeleitete Dateien in `<vault>/.bastra/` löschen: `embeddings.json` und `embed-cache.json` bauen sich beim nächsten Start neu auf. Niemals die `.md`-Dateien, `audit-log.ndjson` oder `trash/` löschen, außer du willst bewusst Nutzerdaten entfernen.
