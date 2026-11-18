/**
 * `--help` sections for the commands that read, seed or curate the vault:
 * saving and searching, imports and onboarding, drafts and save proposals, the
 * map, Commons and bridges, the trash and reconciling two copies. Part of the
 * COMMAND_HELP catalog assembled in help-text.ts.
 */

export const MEMORY_COMMAND_HELP: Record<string, string> = {
  suggestions: `bastra suggestions — exact save proposal decisions

Usage:
  bastra suggestions reject <proposal_id> user-directed "explicit user rejection"
  bastra suggestions reset <proposal_id> user-directed

Only report a user's explicit rejection of a displayed proposal. Silence,
not saving and an agent's assessment do not count. Rejection suppresses only
that proposal in this project; reset restores it. Other suggestions, trigger
strength and binding rules stay unchanged. --dry-run prints the request.
The agent attests user direction, as with rule proposal decisions.
`,

  drafts: `bastra drafts — local session drafts

Usage:
  bastra drafts [list] [--json]   List unexpired drafts without refreshing them
  bastra drafts purge [--json]    Remove all drafts and retained tombstones
  bastra drafts undo <id> [--json] [--vault <path>] [--force]
                                Remove an unchanged promoted note; keep a 180-day tombstone
                                --force permits removing a reviewed edited note
  bastra drafts reject <id>... [--json]
                                Close open drafts; keep a 180-day tombstone against recapture

Drafts stay on this device, outside the vault. Secrets are redacted before
storage. Unshown drafts with one evidence row expire after 7 days (unmeasured);
other open drafts expire after 30 days without evidence or display;
promoted and rejected rows are retained for 180 days.
BASTRA_DRAFTS_PATH overrides the default ~/.bastra/drafts.json location.
Typed messages passing the structural noise filter are captured automatically
by the local session harvest, with their redacted situation. Retrieval shows
unconfirmed quotes separately; BASTRA_DRAFT_HINTS=0 disables that band.
BASTRA_PENDING_RELAY=0 stops all relay writes and delivery; retained files stay.
purge also clears the pending relay (even when disabled); unreadable relay files are preserved.
`,

  commons: `bastra commons — community recipes as a second, read-only index

Usage:
  bastra commons <enable|update|disable|status>
  bastra commons verify <recipe-id> <works|fails> ["environment note"]

Bastra Commons is a git-synced set of community-proven recipes, searched as a
second recall index next to your own vault. Read-only: nothing from Commons is
ever written into your memories, and your vault is never sent anywhere. Only
'verify' sends something out (see below).

  enable    Clone and register the index
  update    Pull the latest revision
  disable   Unregister it (the clone stays on disk)
  status    Revision, size and when it was last pulled
  verify    Record that a recipe works or fails for you and open a pull request
            with that record. The PR is public: it carries the recipe id, the
            result, your note, a verifier id, and your OS, CPU architecture and
            Node version. If git or gh is missing, or the target is refused, the
            record stays on disk to submit by hand.
`,

  bridges: `bastra bridges — shared learned-recall vocabulary (opt-in)

Usage:
  bastra bridges <enable|disable|status|language|live|mint|harvest>

Vocabulary bridges widen recall by connecting the words you search with the
words your memories use. Off by default. Without a language setting every
folder is searched; an override limits query expansion to one folder. New
bridges are filed by the detected language of their source query.

  enable / disable   Turn the shared index on or off
  status             What is active, and how many bridges are held
  language           Show or set the query-language override
  live <on|off>      Let bridges widen the query (default off: shadow — fires
                     are logged, the ranking is unchanged). Switch on only for
                     bridges that pass 'bastra bridges verify'
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
  bastra import clients               Import the clients' own memory folders
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
  clients          Every ~/.claude/projects/*/memory folder and ~/.codex/memories
                   that holds notes, each imported like 'vault' under its own
                   label; a re-run only writes what changed
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
  bastra onboard --answers <file>
  bastra onboard skip
  bastra onboard done

Persona-aware questions whose answers each become a profile memory, so recall
has something to work with on day one instead of an empty vault.

  skip              Dismiss the nudge — run 'bastra onboard' whenever you want it
  done              Mark onboarding as completed without running the interview
  --answers <file>  Save the answers from a file instead of asking (no TTY
                    needed): JSON (.json) or YAML, e.g.
                      persona: developer        # developer|business|personal|mixed
                      answers:
                        identity: Alex · English, informal
                        stack: TypeScript + Node
                    Answer ids are the interview's question ids (identity,
                    rules, stack, projects, workflow, conventions_size, ...).
                    An unknown id is reported and skipped. The file fails
                    (exit 2, onboarding stays open) when nothing in it is
                    usable and an entry was skipped: an unknown id or a value
                    that is not text. Only the persona is a valid file.
  --vault <path>    Onboard this vault instead of the configured one
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
  bastra rules proposals
  bastra rules confirm|reject <id> <revision> user-directed

Proposals prints the full rule text and current revision. Confirm or reject only
on the user's explicit decision in chat. user-directed attests that instruction;
it does not authenticate a human. Stale revisions are refused.

Writes .cursor/rules/bastra-recall.mdc into the project (default: the current
directory). Cursor keeps rules per repository — there is no global equivalent,
so this is run once per project.

Claude Code and Claude Desktop do not need this: they use the shared skill,
installed by 'bastra install'.
`,

  trash: `bastra trash — archived memories, back from the vault trash

Usage:
  bastra trash list              archived memories that can be restored (newest first)
  bastra trash restore <id>      put an archived memory back where it lived

archive_memory (and Archive in the memory browser) moves a memory into the
vault trash, <vault>/.bastra/trash/ — never a hard delete. This command asks
the running daemon (restore_memory) to list or restore them; the restore is
written to the vault's audit log. A memory with the same id that is live
again is not overwritten: the restore is refused. Private memories are not
listed or restored here; restore them in the memory browser.
--json prints the list as JSON.
`,

  recall: `bastra recall — search the vault from the terminal

Usage:
  bastra recall "<question>" [--limit N] [--scope S] [--type T] [--json]

Asks the running daemon the same recall agents use (MCP recall /
REST /api/v1/recall) and prints the matching memories: id, type and area,
title, summary. --limit caps the hits (1-20, default 5); --scope and --type
narrow to one area or memory type. --json prints the daemon's answer as is,
for scripts. Private memories are not shown here, the same as over REST.
`,

  save: `bastra save — save a memory yourself

Usage:
  bastra save --title T --type T --scope S [options] [text]
  echo "text" | bastra save --title T --type T --scope S

Options:
  --summary S          one line for the hit list (default: the text's first line)
  --recall-when W      when it should come up; repeatable (default: the title)
  --tag X              repeatable (default: the scope)
  --topic a/b          topic path (default: the scope)
  --json               print the daemon's answer as is

The text is the words after the options, or what is piped in. --type is one of
reference, project-fact, decision, lesson, workflow, preference,
user-preference, meta-working. The save goes through the running daemon's
save_memory path with every check an agent's save gets (claim gate,
credential redaction, audit, indexing) and is recorded as your own instruction
(write_origin: user-directed). A save another memory already covers is held,
not written: the command names that memory and exits 1. An existing memory
with the same title is not overwritten.
`,

  reconcile: `bastra reconcile — two stores of the same vault: which copy is ahead

Usage:
  bastra reconcile [--vault <this-store>]                  list the copies of this vault
  bastra reconcile <other-store> [--vault <this-store>]   the plan (dry run, default)
  bastra reconcile <other-store> --yes                     carry out the copies
  bastra reconcile <other-store> --json                    the plan as JSON

Without <other-store> it looks for copies: vault paths in the client
registrations (Claude Code, also per project; Claude Desktop, Cursor, Codex)
and BASTRA_VAULT_PATH — where a forwarder-spawned daemon writes when the
configured one is unreachable —, symlinks onto a store, and folders with a
bastra audit log in sync folders (iCloud Drive, ~/Library/CloudStorage,
Dropbox, OneDrive, Google Drive, Nextcloud, pCloud, ~/Sync). A sync-folder
hit counts as a copy when its audit log shares a memory with this vault's.
With exactly one other copy it prints the dry run against it; --yes always
takes the store as an argument.

Compares memory by memory, joined by the frontmatter id. mtime, hash and size
say nothing here: the daemon rewrites files on its own (generated fields, the
auto-related block). Two copies count as the same when their authored content
matches — body without the generated block, wrapping collapsed, wikilinks in
one spelling, frontmatter without generated fields.

Which side is ahead comes from each store's audit log
(.bastra/audit-log.ndjson): the side with writes the other lacks. Writes on
both sides, a change neither log records (an edit in another editor), a
delete on one side, or a duplicate id is a conflict: listed, never resolved.

--yes copies only the unambiguous cases. An overwritten file is first copied
to <store>/.bastra/reconcile-backup/<time>/; a file that changed since the
plan is skipped. The copied memory's audit entries go along, so the next run
still knows the order. Nothing is deleted. Exit code 1 if a copy was skipped.

Not the daemon's periodic vault reindex (BASTRA_VAULT_RECONCILE_MS).
`,
};
