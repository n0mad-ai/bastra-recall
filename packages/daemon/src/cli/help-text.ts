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
 *
 * Language (#1602): the help follows language.primary like the rest of the CLI,
 * English when unset or for a language without its own help; German is complete.
 */

import { ADAPTERS } from "./registry.js";
import { VERSION } from "./helpers.js";
import { AGENT_COMMAND_HELP } from "./help-text-agents.js";
import { AGENT_COMMAND_HELP_DE } from "./help-text-agents-de.js";
import { MEMORY_COMMAND_HELP } from "./help-text-memory.js";
import { MEMORY_COMMAND_HELP_DE } from "./help-text-memory-de.js";
import { SETUP_COMMAND_HELP } from "./help-text-setup.js";
import { SETUP_COMMAND_HELP_DE } from "./help-text-setup-de.js";
import { globalHelpDe } from "./help-text-global-de.js";
import { taskCliLanguage } from "./task-cli-words.js";

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
  update                     brew or npm upgrade (whichever installed it) +
                             re-register + daemon restart. From a source checkout: run it
                             after pulling AND building (it verifies the build,
                             it never runs one).
  address <status|setup [name]|remove>  Your own assistant name as a browser address.
                             System/browser setup only with your consent.
  autostart <on|off|status>  Keep the daemon running permanently (off by
                             default — it otherwise starts on demand and shuts
                             down after 30 min idle). 'on' installs a service;
                             a hand-written one is never replaced without --force
  tasks <list|get|create|review|edit|snooze|acknowledge|resolve|cancel|rearm|delete>
                             Enabled by default; disable in Settings or with BASTRA_TASKS=0.
                             Owner token prompt; JSON input file. Add agent before
                             the file to use explicit BASTRA_TASK_TOKEN.
  codex [Codex options]      Start a Codex CLI chat with active task delivery.
  suggestions <reject|reset>  Explicit decisions on exact project save proposals
  drafts <list|purge|undo|reject>  Inspect or clear local session drafts
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
  models <switch|later|      Answer a release's model recommendation: switch to
    dismiss> <id> [model]    it (pulled + tested first), ask again in 7 days,
                             or not for this recommendation. The notice prints
                             the exact command
  config get <key>           Read a setting (e.g. update.mode)
  config set <key> <value>   Write a setting (update.mode = notify|auto|off,
                             docs.mode = off|suggest|auto, docs.language = en|de|…)
  token [rotate|clear]       Print the REST API token (mint on first use) for
                             browser/REST clients; 'rotate' issues a fresh one,
                             'clear' removes it (locks out browser/REST clients)
    [--origin <url>]         With 'token': also allowlist this browser Origin
                             (e.g. https://bastra.io) so the web app can reach
                             the daemon — no plist/env editing needed
  oauth [list|revoke <id|all>]
                             Remote MCP clients approved via OAuth (ChatGPT,
                             claude.ai connectors); 'revoke' cuts one or all off
  code <enable|disable|index|rebuild|status>
                             Code awareness per repository (experimental):
                             shows an agent what depends on a file before it
                             edits one, and adds find_code. Off until enabled;
                             Graphify builds a local code map, sends nothing
                             anywhere (macOS/Linux)
  commons <enable|update|disable|status|verify>
                             Bastra Commons: community-proven recipes as a
                             read-only second recall index (git-synced);
                             'verify' submits a works/fails record as a PR
  bridges <enable|disable|status|language|live|mint|harvest>
                             Shared learned-recall: opt-in vocabulary
                             bridges that widen recall (off by default;
                             when on, query expansion runs in shadow until 'live on').
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
  import clients             Import Claude Code's and Codex's own memory
                             folders the same way (one set per folder)
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
  archive <put|list|restore|reconcile>
                             Move a path into ~/.bastra/archive yourself, see
                             what the agent's rm moved there, put a path back,
                             or let old entries go
  trash <list|restore ID>    Archived memories (archive_memory, the vault
                             trash): list them, or put one back where it lived
  recall "<question>"        Search the vault from the terminal (same search
                             agents use; needs the running daemon)
  save --title T --type T --scope S [text]
                             Save a memory yourself (same checks as an agent's
                             save, recorded as your own instruction)
  reconcile [other-store]    Two copies of the same vault: which one is ahead,
                             per memory (dry run; --yes copies with backup,
                             conflicts are only listed); no argument lists
                             the copies it finds
  doctor [surface|all]       Check status of one or every surface
  doctor [surface|all] --fix Check status and repair missing/broken pieces
  doctor --replay [--days N] Send your own past prompts through recall in
                             shadow and report what it would have hinted
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
  --conventions              Per-session convention evidence (default window: 7d)
  --stats                    Aggregate per trigger lane instead of printing lines
                             (logs only; --since defaults to 7d)
  --include-eval             With --stats: also count rows marked as eval/
                             synthetic traffic (excluded by default, #619)
  --fix                      With doctor: repair non-ok surfaces (on 'all', won't set up ones never installed)
  --replay                   With doctor: replay your Claude Code prompts of the last
                             --days N days (default 14) through the live prompt lane,
                             nothing written; --json for the report as JSON,
                             --compare <report.json> to print deltas to a saved one
  --with-bootstrap          Add generated startup instructions (explicit consent)
  --no-bootstrap            Skip the startup instruction offer
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

/**
 * One section per dispatched command. Keys must cover the switch in cli.ts —
 * the drift gate enforces it. Aliases (map/ui) carry their own key so that
 * whichever spelling the user typed is the one echoed back.
 */
const GROUPS = {
  en: { agent: AGENT_COMMAND_HELP, memory: MEMORY_COMMAND_HELP, setup: SETUP_COMMAND_HELP },
  de: { agent: AGENT_COMMAND_HELP_DE, memory: MEMORY_COMMAND_HELP_DE, setup: SETUP_COMMAND_HELP_DE },
};
export type HelpLanguage = keyof typeof GROUPS;
export const HELP_LANGUAGES = Object.keys(GROUPS) as HelpLanguage[];

/** The section catalog in one language: the group each command's section lives in. */
export function commandHelp(language: HelpLanguage): Record<string, string> {
  const { agent, memory, setup } = GROUPS[language];
  return {
    codex: agent.codex,
    address: setup.address,
    tasks: agent.tasks,
    suggestions: memory.suggestions,
    drafts: memory.drafts,
    code: agent.code,
    install: setup.install,
    uninstall: setup.uninstall,
    doctor: setup.doctor,
    status: setup.status,
    logs: setup.logs,
    autostart: setup.autostart,
    update: setup.update,
    config: setup.config,
    embeddings: setup.embeddings,
    models: setup.models,
    token: setup.token,
    oauth: setup.oauth,
    commons: memory.commons,
    bridges: memory.bridges,
    map: memory.map,
    ui: memory.ui,
    import: memory.import,
    onboard: memory.onboard,
    skills: memory.skills,
    rules: memory.rules,
    patches: setup.patches,
    feedback: setup.feedback,
    trash: memory.trash,
    recall: memory.recall,
    save: memory.save,
    archive: agent.archive,
    reconcile: memory.reconcile,
    completion: setup.completion,
    help: setup.help,
    version: setup.version,
  };
}

/** The English catalog — the drift gate in cli-help.test.ts reads this one. */
export const COMMAND_HELP: Record<string, string> = commandHelp("en");

const MORE: Record<HelpLanguage, string> = { en: "More", de: "Mehr" };

/** What `bastra help [command]` / `bastra <command> --help` prints in `language`. */
export function helpText(command: string | null | undefined, language: HelpLanguage): string {
  const section = command ? commandHelp(language)[command] : undefined;
  if (section) return `${section}\n${MORE[language]}: bastra help\n`;
  return language === "de" ? globalHelpDe(VERSION, Object.keys(ADAPTERS).join(", ")) : globalHelp();
}

/** language.primary when it has its own help, English otherwise. An unreadable
 *  settings file never keeps --help from answering: it answers in English. */
async function helpLanguage(): Promise<HelpLanguage> {
  const code = await taskCliLanguage().catch(() => "en");
  return HELP_LANGUAGES.find((language) => language === code) ?? "en";
}

/**
 * Print help: the section for `command` when there is one, the global listing
 * otherwise. Never has a side effect — that is the whole point of #330.
 */
export async function showHelp(command?: string | null): Promise<void> {
  process.stdout.write(helpText(command, await helpLanguage()));
}
