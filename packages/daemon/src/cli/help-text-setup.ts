/**
 * `--help` sections for installing bastra-recall into the AI clients and
 * running it: registration, health checks, the daemon and its settings,
 * models, tokens, updates and local patches. Part of the COMMAND_HELP catalog
 * assembled in help-text.ts.
 */

const SURFACE_ARG = `Surfaces:
  claude-desktop  Claude Desktop App
  claude-code     Claude Code
  codex           Codex + ChatGPT Desktop
  cursor          Cursor
  all             Every surface above
`;

export const SETUP_COMMAND_HELP: Record<string, string> = {
  address: `bastra address — lokale Assistenten-Adresse
Usage:
  bastra config set assistant.name Jarvis
  bastra address status [--json]
  bastra address setup [name] [--yes] [--dry-run]
  bastra address remove [--yes] [--dry-run]
Auf macOS: einmalige Admin-Freigabe für eigenen Loopback-Port-80-Helfer und hosts.
Node läuft als normaler Nutzer. Eigene Firefox-Pref für den Namen; Firefox vorher schließen und danach neu starten.
Nach Einrichtung wird http://<name>/ einmal im Standardbrowser geöffnet.
Pur <name> ist Such-/Verlaufsheuristik: <name>/ oder <name>.localhost ist eindeutig.
Windows/Linux: Port-80-/hosts-Einrichtung durch Administrator; keine automatische Elevation.
`,

  install: `bastra install — register bastra-recall with an AI client

Usage:
  bastra install                     Guided setup: pick vault, clients and
                                     semantic recall from selection lists
  bastra install <surface|all>       Register one surface (or every one)
  bastra install claude-desktop --extension
                                     Hand the .mcpb Desktop Extension to Claude
                                     Desktop instead — the final Install click
                                     stays in Desktop's own dialog

Registers the MCP server, the shared skill and the hooks. On a machine with no
vault yet it offers to create one first.

${SURFACE_ARG}
Options:
  --dry-run        Print what would change; write nothing
  --vault <path>   Vault path (BASTRA_VAULT_PATH env also works)
  --yes, -y        Skip confirmation prompts (e.g. replacing a foreign statusLine)
  --ollama         Set up Ollama for semantic recall without asking (~620 MB)
  --no-ollama      Skip the Ollama setup — recall stays BM25 keyword-only
  --with-bootstrap          Add generated startup instructions (explicit consent)
  --no-bootstrap            Skip the startup instruction offer
  --no-stop-hook   Skip the Stop save-eval hook (registered by default)
  --stub           Download the compiled hook client without asking (~70 MB; faster hook start)
  --no-stub        Keep the node hook client — no download, remembered for updates
  --extension      claude-desktop only: install via the .mcpb extension
`,

  uninstall: `bastra uninstall — remove the registration from an AI client

Usage:
  bastra uninstall <surface|all>

Removes the MCP server entry, the hooks and the statusline segment. The shared
skill is removed once no surface references it anymore. Your vault is never
touched — uninstalling a client does not delete a single memory.

${SURFACE_ARG}
Options:
  --dry-run   Print what would be removed; write nothing
`,

  doctor: `bastra doctor — check that every piece is registered and healthy

Usage:
  bastra doctor [surface|all]
  bastra doctor [surface|all] --fix
  bastra doctor --replay [--days N] [--json] [--compare <report.json>]

Checks the daemon, the MCP forwarder path, the hook commands, the skill and the
statusline for one surface or all of them. A hook whose command points at a
replaced or missing runtime makes the surface non-healthy rather than counting
as registered (#321).

A final "features" section lists which Recall features are on or off (memory
language, onboarding, semantic recall, hooks and skill per client, opt-in
extras) with the command that turns each one on. Off features never change the
exit code, and --fix never switches one on.

--replay (#702) answers a different question: how does recall behave on YOUR
vault with YOUR prompts? It reads your Claude Code transcripts of the last N
days (default 14), sends every user turn through the running daemon's prompt
lane in shadow — session ids 'replay-…', no vault writes, telemetry in its own
'replay-YYYY-MM-DD.jsonl' that no live readout counts — and prints the share
of prompts with a hint, the slots taken by the ten most frequent notes, the
share of system turns (task notifications, agent mail), the slots on notes the
agent actually loaded, bridge fires per bridge and the p50/p95 latency. Without
transcripts it says "not evaluable". Without a vector arm, same transcripts
and settings give the same report apart from latency and timeouts; with an
embedding provider, hits also depend on the vector deadline and machine load,
and the usage-based suppression reads the live usage sidecar. To compare two settings profiles, run the daemon with the
candidate env on another port and point the replay at it with
BASTRA_DAEMON_URL, saving each --json report; --compare prints the deltas.

${SURFACE_ARG}
Options:
  --fix       Repair missing or broken pieces. On 'all' this will not set up a
              surface that was never installed
  --vault <path>  Check against this vault instead of the configured one
  --replay    Replay your own prompts through recall in shadow (see above)
  --days <n>  With --replay: how many days of transcripts to read (default 14)
  --json      With --replay: print the report as JSON
  --compare <report.json>  With --replay: also print deltas to a saved report
`,

  status: `bastra status — is the daemon up, and what is it serving

Usage:
  bastra status [--json] [-q]

Prints daemon reachability, vault size, the effective embedding provider and
how it was resolved. Reads only — nothing is registered, restarted or written.

Options:
  --json      Machine-readable output
  -q, --quiet Print nothing; the exit code carries the answer (0 = ok)
`,

  logs: `bastra logs — what the hooks and the daemon actually recorded

Usage:
  bastra logs [-f] [--since <duration>] [--source <src>] [--lines <n>]
  bastra logs --stats [--since <duration>]
  bastra logs --conventions [--since <duration>]

One line per event, newest last. --stats aggregates per trigger lane instead
(median/p90/max latency, timeouts) — that is the view the hook budget is
measured against.

Options:
  -f, --follow           Keep printing new entries as they arrive
  --since <duration>     How far back: 30s, 10min, 2h, 1d (default 5min;
                         with --stats the default is 7d)
  --source <daemon|hook|all>
                         Which log source to read (default all)
  --lines <n>            Cap the number of lines printed (default 200)
  --conventions          Per-session shown/loaded/gate/receipt evidence
  --stats                Aggregate per lane instead of printing lines
  --include-eval         With --stats: also count eval/synthetic-marked rows
                         (excluded by default, #619)
`,

  autostart: `bastra autostart — keep the daemon running, or let it start on demand

Usage:
  bastra autostart status     Show what is installed and what it points at
  bastra autostart on         Install and start the managed service
  bastra autostart off        Unload and remove it
  bastra autostart on --force Replace a service bastra did not write

Off by default. Without autostart the daemon starts when an AI client first
calls it and shuts down again after 30 minutes idle — that is enough for
Claude Code, Claude Desktop and Cursor. Turn it on when you use the REST API,
want the embedding model to stay warm, or simply want instant answers.

'on' disables the idle shutdown, so the daemon stays up until you turn it off.

A service that bastra did not write is left alone: it usually points
somewhere on purpose (a source checkout, a custom model setup), and replacing
it would break that. --force replaces it anyway.

macOS uses a LaunchAgent; Windows uses a per-user Task Scheduler logon task
with restart-on-failure. doctor reports a stopped task. Windows acceptance on
a real machine is still pending. On Linux use on-demand start or a systemd
user unit.`,

  update: `bastra update — upgrade, re-register, restart

Usage:
  bastra update [options]

Upgrades the installed package (brew upgrade when brew-installed; for a global
npm install the package you installed: 'npm install -g bastra-recall@latest',
or '@bastra-recall/daemon@latest' when you installed that one; nothing for a
source checkout), re-registers every surface and restarts the daemon.

A source checkout is never pulled, installed or built by this command: it only
verifies that the checkout's build is not older than its sources, and stops
without re-registering or restarting when it is. So there, run
'git pull && npm ci && npm run build' yourself first, then 'bastra update'.

Before replacing an in-place installation it runs a preflight: locally modified
files are backed up to ~/.bastra/update-backups/<version>/ and reported. A
registered patch series (see 'bastra patches') is reapplied afterwards.

Options:
  --dry-run   Describe every step, change nothing
  --staged    Swap the files only, no daemon restart — the unattended
              auto-update path; a blocked update is recorded instead of forced
  --force     Install even though locally modified files were found. They are
              backed up either way. Never applies to the unattended auto-update
  --yes, -y   Skip confirmation prompts during the re-registration
`,

  config: `bastra config — read and write settings

Usage:
  bastra config get <key>
  bastra config set <key> <value>

Keys:
  update.mode      notify | auto | off
  docs.mode        off | suggest | auto   (product documentation capture)
  docs.language    en | de | …            (language docs are written in)
  reflex.enabled   true | false           (reflex memories; default true)
  promptImpact.enabled
                   true | false           (change impact in prompts, experimental; default false)
  battery.saver    true | false           (on battery: defer background Ollama work, macOS; default false)

Settings live next to the vault; 'bastra config get' without a value prints the
effective one including where it was resolved from.
`,

  embeddings: `bastra embeddings — semantic recall on or off

Usage:
  bastra embeddings <on|off|status>

'on' sets up Ollama plus the embeddinggemma model (~620 MB) and persists the
choice, so recall runs the hybrid path (BM25 + vectors, multilingual).
'off' returns to BM25 keyword-only. 'status' shows the effective provider and
how it was resolved (env, setting, or detection).

'bastra embeddings' takes no options of its own. To decide the Ollama install
non-interactively, pass --ollama / --no-ollama to 'bastra install' or
'bastra update'; on this command they are rejected as a usage error (#536).
`,

  models: `bastra models — the local text model for memory rewriting

Usage:
  bastra models [status]
  bastra models recommend
  bastra models set <tag>
  bastra models switch <recommendation> <model>
  bastra models later <recommendation>
  bastra models dismiss <recommendation>

The model behind doc2query trigger expansion and the local reranker — not the
embedding model ('bastra embeddings' owns that one).

  status      Active model plus this machine's RAM-tier recommendation
  recommend   What this machine can carry, without changing anything
  set <tag>   Pull a model and persist it (e.g. gemma4:12b on a 24 GB+ box)

New installs are offered tev1:4b from 16 GB of RAM (gemma4:12b as the
alternative from 24 GB, and as the suggestion from 32 GB). An install that
never stored a choice keeps running the built-in fallback gemma3:4b.

A release can recommend a different model. bastra never switches on its own:
'bastra update', the first command on a terminal after an update, the session
start and a line after CLI commands tell you until you have answered. Session
start normally shows it once per UTC day across Claude Code and Codex, with its
own marker independent of the CLI line. Simultaneous session starts reclaiming
an orphaned lock can rarely show it twice on the same day. 'status' shows the
recommendation at any time.
Every notice prints the exact commands; they name the recommendation they
answer, and bastra refuses an answer to a different one.

  switch      Pull the recommended model, check it with a short test call, and
              only then store it together with your answer. If anything fails,
              nothing changes. The old model stays installed; 'set <old tag>'
              switches back.
  later       Keep the current model and ask again in 7 days
  dismiss     Keep the current model and do not ask again for this
              recommendation (a later, new recommendation asks again). The
              notice then does not come back, and you may be giving up better
              recall quality; 'status' keeps showing the recommendation and
              you can still switch later.

BASTRA_UPDATE_CHECK=off (or update.mode off) silences the notice as well.
`,

  token: `bastra token — the REST API token for browser and REST clients

Usage:
  bastra token [--origin <url>]
  bastra token rotate
  bastra token clear

Prints the token, minting one on first use. Browser clients also need their
Origin allowlisted — '--origin https://bastra.io' does that in the same step,
so no plist or env editing is needed.

  rotate   Issue a fresh token; the old one stops working immediately
  clear    Remove it — locks out every browser/REST client until a new one is
           minted

Options:
  --origin <url>  Allowlist this browser Origin as well
  --json          Machine-readable output
`,

  oauth: `bastra oauth — remote MCP clients approved through the OAuth login

Usage:
  bastra oauth [list] [--json]
  bastra oauth revoke <client_id>
  bastra oauth revoke all

ChatGPT and claude.ai custom connectors reach /api/v1/mcp with OAuth. Each
one registers itself, and you approve it once by entering your API token
('bastra token') on the daemon's login page. Their tokens only open the MCP
door, never the other /api/v1 routes.

  list     Every registered client: name, redirect host, grants, last token
  revoke   Remove a client and all its tokens; takes effect on the next request

Options:
  --json   Machine-readable output
`,

  patches: `bastra patches — local changes that survive an update

Usage:
  bastra patches [list]
  bastra patches add <file.patch>
  bastra patches remove <id>
  bastra patches status

An ordered series reapplied onto the fresh install after every update. A patch
upstream has absorbed is retired; one that no longer applies is set aside and
reported — never forced.

  status   Probe the series against what is installed right now
`,

  feedback: `bastra feedback — open a prefilled GitHub issue form

Usage:
  bastra feedback bug
  bastra feedback idea

'bug' attaches a sanitized diagnostics block: version, OS, node, embedding
mode, vault size, daemon status. Never a file path, never vault content. The
browser opens with the form filled in — you read it and submit it yourself.
`,

  completion: `bastra completion — Tab completion for your shell

Usage:
  bastra completion <bash|zsh|fish>

Prints the completion script to stdout; the script carries its own install
instructions in a comment at the top.
`,

  help: `bastra help — show the command listing

Usage:
  bastra help
  bastra --help
  bastra <command> --help

The last form is the useful one: it prints what that single command does and
which options apply to it.
`,

  version: `bastra version — print the version of this CLI

Usage:
  bastra version
  bastra --version

Note this is the CLI's own version. 'bastra status' reports what the RUNNING
daemon serves, which differs when its code was replaced under it (#329).
`,
};
