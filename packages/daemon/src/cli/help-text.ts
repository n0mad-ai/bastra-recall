/**
 * `bastra help` and `bastra <command> --help` (#330/#15).
 *
 * `--help` is the convention by which someone finds out what a command does
 * BEFORE running it. Until #330 the effect was inverted: the help flag was
 * bound to "no command given", so `bastra update --help` fell through to the
 * switch and restarted the daemon as an answer to the question what it does.
 *
 * The per-command sections exist because that is the actual reason someone
 * types `bastra update --help` — the global listing describes update in two
 * lines and never mentions --staged or --force. COMMAND_HELP is diffed against
 * the dispatch table in `__tests__/cli-help.test.ts`, the same drift gate
 * `completion.ts` carries, so a new command cannot land without its section.
 */

import { ADAPTERS } from "./registry.js";
import { VERSION } from "./helpers.js";

function globalHelp(): string {
  const supportedSurfaces = Object.keys(ADAPTERS).join(", ");
  return `bastra ${VERSION} — install bastra-recall across AI clients

Usage:
  bastra                     Show status panel (version, update, daemon, vault)
  bastra <command> [surface] [options]
  bastra <command> --help    What that one command does, and its options

Commands:
  install                    Guided setup (interactive): pick vault, clients,
                             semantic recall from selection lists
  install <surface|all>      Register bastra-recall with the AI client
  install claude-desktop --extension
                             Hand the .mcpb Desktop Extension to Claude
                             Desktop instead (logo + vault picker; one
                             Install click stays in Desktop's dialog)
  uninstall <surface|all>    Remove the registration (the shared skill is
                             removed once no surface references it anymore)
  update                     brew upgrade (if brew-installed) + re-register +
                             daemon restart. Use this after pulling new code.
  autostart <on|off|status>  Keep the daemon running permanently (off by
                             default — it otherwise starts on demand and shuts
                             down after 30 min idle). 'on' writes a LaunchAgent;
                             a hand-written one is never replaced without --force
  patches <list|add <file>|remove <id>|status>
                             Local patches that survive an update: an ordered
                             series reapplied onto the fresh install. One that
                             upstream has absorbed is retired, one that no
                             longer applies is set aside and reported — never
                             forced. 'status' probes them against what is
                             installed right now.
  embeddings <on|off|status> Semantic recall (multilingual vector search):
                             'on' sets up Ollama + the embeddinggemma model
                             (~620 MB) and persists the choice; 'off' returns
                             to BM25 keyword-only; 'status' shows the effective
                             provider and how it was resolved
  models [status|recommend|  Local text model for memory rewriting (doc2query +
    set <tag>]               rerank). 'status' shows the active model + this
                             machine's RAM-tier recommendation; 'set' pulls a
                             model + persists it (e.g. gemma4:12b on a 24 GB+ box)
  config get <key>           Read a setting (e.g. update.mode)
  config set <key> <value>   Write a setting (update.mode = notify|auto|off,
                             docs.mode = off|suggest|auto, docs.language = en|de|…)
  token [rotate|clear]       Print the REST API token (mint on first use) for
                             browser/REST clients; 'rotate' issues a fresh one,
                             'clear' removes it (locks out browser/REST clients)
    [--origin <url>]         With 'token': also allowlist this browser Origin
                             (e.g. https://bastra.io) so the web app can reach
                             the daemon — no plist/env editing needed
  commons <enable|update|disable|status>
                             Bastra Commons: community-proven recipes as a
                             read-only second recall index (git-synced)
  bridges <enable|disable|status|language|mint|harvest>
                             Shared learned-recall: opt-in, language-partitioned
                             vocabulary bridges that widen recall (off by default).
                             'mint' = bridges from acted-on reaches; 'harvest' =
                             deep far-slice pass with the local reranker (Teacher 2).
  map                        Open the vault map in the browser — an interactive
                             graph of your memory (local only; offers to enable
                             it when off). Alias: ui
  import <file|-> [source]   Seed the vault from another AI tool's memories
                             (ChatGPT/Claude/Gemini list or free text): stages
                             candidates in import-review.md for review — your
                             next AI session distills accepted ones with you;
                             nothing is saved without your accept.
                             A conversations.json data export is queued locally
                             instead; the AI session mines it chunk-wise
  import rules               Stage local rules files (CLAUDE.md, AGENTS.md,
                             .cursorrules, .cursor/rules/, ~/.claude/CLAUDE.md)
  import vault <dir> [label] Import a whole folder of memory files (e.g. a
                             Claude Code memory dir) into its own isolated
                             set under memories/imported/ — deterministic,
                             no per-item review, nothing existing is touched
  import <mine|clear>        Print the next mining chunk for the AI session /
                             discard the local mining queue
  onboard                    5-minute interview that seeds a fresh vault:
                             persona-aware questions, every answer becomes a
                             profile memory ('onboard skip' stops the nudge)
  skills <list|add|remove>   Declare link targets that live on another surface
                             (e.g. Claude Code skills): declared ids render in
                             the map's skills ring instead of as unwritten
                             ghosts — no path, no scan, no sync
  feedback <bug|idea>        Open a prefilled GitHub issue form in the browser.
                             'bug' includes a sanitized diagnostics block
                             (version, OS, embedding mode, vault size — never
                             vault content); you review and submit it yourself
  doctor [surface|all]       Check status of one or every surface
  doctor [surface|all] --fix Check status and repair missing/broken pieces
  status                     Check daemon and adapters status (supports --json, -q)
  logs                       Readable view of what the hooks and the daemon
                             recorded — one line per event, newest last
                             (-f to follow, --since 1h, --source hook|daemon)
  rules cursor [path]        Write Cursor's memory rules into a project
                             (.cursor/rules/bastra-recall.mdc). Cursor keeps
                             rules per repo — there is no global equivalent,
                             so run this once per project. 'rules remove
                             cursor [path]' takes it back out
  completion <shell>         Print a Tab-completion script (bash, zsh, fish)
  help                       Show this help
  version                    Show version

Surfaces:
  claude-desktop             Claude Desktop App
  claude-code                Claude Code
  codex                      Codex + ChatGPT Desktop
  cursor                     Cursor
  all                        Every surface above

Options:
  --dry-run                  Print what would change; write nothing
  --vault <path>             Vault path (BASTRA_VAULT_PATH env also works)
  --json                     Output status in JSON format (status command only)
  -q, --quiet                Suppress output, return exit code only (status command only)
  --yes, -y                  Skip confirmation prompts (replace a foreign statusLine)
  --ollama                   Set up Ollama for semantic recall without asking (installs via Homebrew, downloads ~620 MB)
  --no-ollama                Skip the Ollama setup (semantic recall uses BM25 keyword search)
  -f, --follow               Keep printing new entries as they arrive (logs only)
  --since <duration>         How far back to read: 30s, 10min, 2h, 1d (logs only, default 5min)
  --source <daemon|hook|all> Which log source to read (logs only, default all)
  --lines <n>                Cap the number of lines printed (logs only, default 200)
  --stats                    Aggregate per trigger lane instead of printing lines
                             (logs only; --since defaults to 7d)
  --fix                      With doctor: repair non-ok surfaces (on 'all', won't set up ones never installed)
  --no-stop-hook             Skip the Stop save-eval hook (registered by default)
  --stub                     Download the compiled hook client for Claude Code without asking (~70 MB)
  --no-stub                  Keep the node hook client — never download the compiled one (remembered)
  --force                    With update: install even though locally modified files
                             were found (they are backed up to
                             ~/.bastra/update-backups/<version>/ either way).
                             Never applies to the unattended auto-update.
  --help, -h                 Show this help
  --version, -v              Show version

Examples:
  bastra install claude-desktop
  bastra install codex
  bastra install all --dry-run
  bastra status --json
  bastra doctor
  bastra uninstall claude-desktop

Supported surfaces (this build): ${supportedSurfaces}
`;
}

const SURFACE_ARG = `Surfaces:
  claude-desktop  Claude Desktop App
  claude-code     Claude Code
  codex           Codex + ChatGPT Desktop
  cursor          Cursor
  all             Every surface above
`;

/**
 * One section per dispatched command. Keys must cover the switch in cli.ts —
 * the drift gate enforces it. Aliases (map/ui) carry their own key so that
 * whichever spelling the user typed is the one echoed back.
 */
export const COMMAND_HELP: Record<string, string> = {
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

Checks the daemon, the MCP forwarder path, the hook commands, the skill and the
statusline for one surface or all of them. A hook whose command points at a
replaced or missing runtime makes the surface non-healthy rather than counting
as registered (#321).

${SURFACE_ARG}
Options:
  --fix       Repair missing or broken pieces. On 'all' this will not set up a
              surface that was never installed
  --vault <path>  Check against this vault instead of the configured one
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
  --stats                Aggregate per lane instead of printing lines
`,

  autostart: `bastra autostart — keep the daemon running, or let it start on demand

Usage:
  bastra autostart status     Show what is installed and what it points at
  bastra autostart on         Install and load the LaunchAgent (macOS)
  bastra autostart off        Unload and remove it
  bastra autostart on --force Replace a LaunchAgent bastra did not write

Off by default. Without autostart the daemon starts when an AI client first
calls it and shuts down again after 30 minutes idle — that is enough for
Claude Code, Claude Desktop and Cursor. Turn it on when you use the REST API,
want the embedding model to stay warm, or simply want instant answers.

'on' disables the idle shutdown, so the daemon stays up until you turn it off.

A LaunchAgent that bastra did not write is left alone: it usually points
somewhere on purpose (a source checkout, a custom model setup), and replacing
it would break that. --force replaces it anyway.

macOS only. On Linux the daemon keeps starting on demand; write a systemd user
unit if you want it permanent.`,

  update: `bastra update — upgrade, re-register, restart

Usage:
  bastra update [options]

Upgrades the installed package (brew upgrade when brew-installed, npm for a
global install, nothing for a source checkout), re-registers every surface and
restarts the daemon. Run it after pulling new code.

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

Options:
  --ollama      Install Ollama without asking
  --no-ollama   Never install it — fail instead
`,

  models: `bastra models — the local text model for memory rewriting

Usage:
  bastra models [status]
  bastra models recommend
  bastra models set <tag>

The model behind doc2query trigger expansion and the local reranker — not the
embedding model ('bastra embeddings' owns that one).

  status      Active model plus this machine's RAM-tier recommendation
  recommend   What this machine can carry, without changing anything
  set <tag>   Pull a model and persist it (e.g. gemma4:12b on a 24 GB+ box)
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

  commons: `bastra commons — community recipes as a second, read-only index

Usage:
  bastra commons <enable|update|disable|status>

Bastra Commons is a git-synced set of community-proven recipes, searched as a
second recall index next to your own vault. Read-only: nothing from Commons is
ever written into your memories, and nothing of yours is sent anywhere.

  enable    Clone and register the index
  update    Pull the latest revision
  disable   Unregister it (the clone stays on disk)
  status    Revision, size and when it was last pulled
`,

  bridges: `bastra bridges — shared learned-recall vocabulary (opt-in)

Usage:
  bastra bridges <enable|disable|status|language|mint|harvest>

Vocabulary bridges widen recall by connecting the words you search with the
words your memories use. Off by default and language-partitioned.

  enable / disable   Turn the shared index on or off
  status             What is active, and how many bridges are held
  language           Show or set the partition language
  mint               Derive bridges from reaches you actually acted on
  harvest            Deep far-slice pass with the local reranker (Teacher 2)
`,

  map: `bastra map — the vault as an interactive graph

Usage:
  bastra map

Opens the local map in your browser: memories, their links and the clusters
they form. Local only — the page is served by the daemon on 127.0.0.1 and
nothing leaves the machine. If the map is off, the command offers to enable it
and starts the daemon that serves it.

Alias: bastra ui
`,

  ui: `bastra ui — alias for 'bastra map'

Usage:
  bastra ui

Opens the vault map in your browser. See 'bastra map --help'.
`,

  import: `bastra import — seed the vault from what you already wrote elsewhere

Usage:
  bastra import <file|-> [source]     Stage candidates from a list or free text
  bastra import rules                 Stage local rules files
  bastra import vault <dir> [label]   Import a whole folder of memory files
  bastra import <mine|clear>          Mining queue for a data export
  bastra import status                How many candidates are waiting

Staging is not saving: candidates land in import-review.md and your next AI
session distills the accepted ones with you. Nothing becomes a memory without
your accept.

  rules            CLAUDE.md, AGENTS.md, .cursorrules, .cursor/rules/,
                   ~/.claude/CLAUDE.md
  vault <dir>      Deterministic folder import into its own isolated subtree
                   under memories/imported/ — no per-item review, nothing
                   existing is touched
  mine             Print the next chunk of a queued conversations.json export
  clear            Discard the local mining queue

Options:
  --dry-run          Report what would be staged; write nothing
  --exclude <glob>   With 'vault': skip matching files (repeatable)
  --vault <path>     Import into this vault instead of the configured one
`,

  onboard: `bastra onboard — the 5-minute interview that seeds a fresh vault

Usage:
  bastra onboard
  bastra onboard skip
  bastra onboard done

Persona-aware questions whose answers each become a profile memory, so recall
has something to work with on day one instead of an empty vault.

  skip   Dismiss the nudge — run 'bastra onboard' whenever you want it
  done   Mark onboarding as completed without running the interview
`,

  skills: `bastra skills — declare link targets that live on another surface

Usage:
  bastra skills [list]
  bastra skills add <id> [label]
  bastra skills remove <id>

A memory may link to a Claude Code skill that is not a file in your vault.
Declared ids render in the map's skills ring instead of as unwritten ghosts.
Declaration only: no path, no scan, no sync.
`,

  rules: `bastra rules — write a client's memory rules into a project

Usage:
  bastra rules cursor [path]
  bastra rules remove cursor [path]

Writes .cursor/rules/bastra-recall.mdc into the project (default: the current
directory). Cursor keeps rules per repository — there is no global equivalent,
so this is run once per project.

Claude Code and Claude Desktop do not need this: they use the shared skill,
installed by 'bastra install'.
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

/**
 * Print help: the section for `command` when there is one, the global listing
 * otherwise. Never has a side effect — that is the whole point of #330.
 */
export function showHelp(command?: string | null): void {
  const section = command ? COMMAND_HELP[command] : undefined;
  if (section) {
    process.stdout.write(`${section}\nMore: bastra help\n`);
    return;
  }
  process.stdout.write(globalHelp());
}
