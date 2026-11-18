/**
 * `--help` sections for the commands around agent work in a project: the task
 * board and the attached Codex chat, code awareness, and the archive behind the
 * agent's rm. Part of the COMMAND_HELP catalog assembled in help-text.ts; the
 * German sections are in help-text-agents-de.ts (#1602).
 */

export const AGENT_COMMAND_HELP: Record<string, string> = {
  codex: `bastra codex — Start an attached Codex CLI chat with active task delivery

Usage:
  bastra codex [Codex options and prompt]
  bastra codex resume <thread-id>
  bastra codex -- -m <model>

Uses its own private local App Server and authenticated terminal connection.
No Codex settings are changed. Existing Codex, desktop and IDE chats are not
attached. The last real human-used chat wins globally with Claude Code within
tasks.chatActiveMinutes (default 30). Tasks remain data, never execution approval.
macOS notification and the board remain available. Requires Codex CLI 0.167.0
with App Server Unix transport and --remote support on macOS/Linux.
Codex options pass through unchanged; an alternative --remote is refused.
More: https://github.com/n0mad-ai/bastra-recall/wiki/Active-Chat-Notifications`,

  tasks: `On by default since v1.2.0. Turn off: tasks.enabled=false or BASTRA_TASKS=0; restart the daemon and the clients/hooks.

bastra tasks — tasks and reminders (on next contact)
Usage: bastra tasks <create|list|due|status|setup-hooks|client-status|ui> [options]
First access: tasks auth mint owner me personal ~/.bastra/owner-task.token.
Copy the token in a local editor; enter it only hidden, in the terminal/browser.
Optional tasks owner-login: private storage only for the interactive owner CLI, never hooks/MCP.
Then tasks setup-hooks, tasks client-status, tasks create --goal "Test" --after 1m --arm.
Once due: tasks due, tasks acknowledge ID --occurrence OCCURRENCE, tasks resolve ID.
Arming = review; rearm explicitly sets it back to UNARMED for a new review.
  bastra tasks create --goal "Evaluate after seven days" --after 7d --domain personal --timezone Europe/Madrid --arm
  bastra tasks create --goal "Check daily" --when 2026-10-12T18:00 --timezone Europe/Madrid --every 1d --count 3
  bastra tasks create --goal "Check appointment" --when 2026-10-12T18:00 --timezone Europe/Madrid --expires 2026-10-13T18:00
  bastra tasks edit ID --expires none   (remove the end of validity)
  bastra tasks list | due | status [--json] [--agent]
  bastra tasks mute|unmute|off|on|stop|resume  Global owner controls
  bastra tasks get|review|resolve|cancel|rearm|delete <id>
  bastra tasks pause|resume|end-series <id>  Pause, resume or end a series
  Repetition: --every 1d also without --count/--end; resolve completes one occurrence only.
  bastra tasks acknowledge <id> --occurrence <occurrence-id>
  bastra tasks snooze <id> --until 2026-10-13T18:00
  bastra tasks targets register demo --root DIRECTORY --path artifact.txt --domain personal
  bastra tasks targets update ID --root DIR --path FILE --domain DOMAIN
  bastra tasks targets remove ID --agent  Remove an instructed target, stop execution
  bastra tasks targets list       Existing local reversible targets, no provider
  bastra tasks archive ID         Completed work only; run tasks stop first
  bastra tasks archive-restore ARCHIVE_ID  Bring back history/rollback, unarmed
  bastra tasks recover [--lock]   Owner offline: stop processes, keep backup/original
  bastra tasks setup-hooks        Owner sets up local hook cards with their own agent credential
  bastra tasks client-status      Shows a missing/revoked client credential honestly
  bastra tasks <operation> --input input.json  Advanced/machine input
The owner credential is asked for hidden on the terminal; --agent uses the assigned
client credential. Instructed tasks are created armed directly with --agent;
--agent --arm is allowed for every task level without further owner approval. Without
an agent instruction, creating stays unarmed by default. For execute too, the user's
instruction in chat is the approval.
--after 7d is an elapsed duration; --when without an offset uses the named time zone.
Acknowledged means seen, not done. Small hook cards: bastra tasks due.
  bastra tasks auth mint|rotate owner|agent actor domain[,domain] new-token-file [old-id]
  bastra tasks auth revoke credential-id
  bastra tasks execution-enable --agent  Enable an instructed local adapter, lift the stop
  bastra tasks release LEASE_ID   Release your own reservation; renews no approval
  bastra tasks prepare --agent --input input.json
Machine input: authorization {write_origin:"user-directed", session_id, program,
user_request, at}. The agent passes on the user's instruction; Recall does not
evaluate its wording. For its own consequential proposals, ask once in chat and
record the yes the same way. No keys, passphrase or second confirmation.
Historical signature commands are kept for old data only. No background wakeup;
BASTRA_TASK_TOKEN overrides the private local hook configuration.`,

  code: `bastra code — code awareness for a repository (experimental)

Usage:
  bastra code                        What is enabled, which Graphify, how fresh,
                                     and whether the daemon's automatic refresh
                                     is paused or stopped (and until when)
  bastra code enable [<dir>]         Turn it on here and build the graph once
  bastra code disable [<dir>]        Turn it off; the graph files stay
  bastra code index [<dir>]          Refresh the graph (incremental, ~2s) and
                                     resume a paused or stopped daemon refresh
  bastra code rebuild [<dir>] [--yes]
                                     Repair: rebuild with --force, which
                                     overrides Graphify's refusal to replace a
                                     larger graph with a smaller one

Recall reads the graph Graphify writes and shows an agent what depends on a
file before it edits one. Nothing is indexed until you enable a repository,
the graph never leaves your machine, and no code is sent to an LLM.

Experimental. It can help an agent find its way into an unfamiliar or large
repository. For "what breaks if I change this" it did not beat plain search
in our measurements on repositories like ours, and it costs context (the
dependents block before edits) and background CPU (graph refreshes).

The graph lives in <dir>/graphify-out/ and is excluded from git locally.
macOS and Linux for now.`,

  archive: `bastra archive — the archive behind the agent's rm

Usage:
  bastra archive put <path>...        move paths into the archive (never deletes)
  bastra archive list                 what was archived, deleted or refused (30 days)
  bastra archive restore <path|ref>   put it back (a path, or a git snapshot ref / sha)
  bastra archive reconcile [--yes]    show (with --yes: remove) what can go

Opt-in, off by default: bastra config set archive.enabled on (or
BASTRA_RM_ARCHIVES=1 in the daemon's environment, which wins). Only for hook
calls marked as Claude Code (re-run bastra install once to add the marker).

With it on, a Claude Code Bash command made only of rm runs through bastra's
archiving rm, without the usual permission prompt:
targets move to ~/.bastra/archive/<date>/<time-pid>/<full path>, temp dirs
are really removed, /, ~ and system dirs are refused. Old entries go by class,
checked hourly after Bash calls: build junk after 1 day, clean git-tracked
after 2, the rest after 2; the size cap never touches your own files younger
than their retention. Change it (days, fractions allowed; env
BASTRA_ARCHIVE_RETAIN wins):
  bastra config set archive.retain junk=1,in-git=2,user=2
Limits (sizes like 5GB or 500MB; env BASTRA_ARCHIVE_CAP and
BASTRA_ARCHIVE_MAX_ITEM win):
  bastra config set archive.cap 10GB       the whole archive (default 10 GB)
  bastra config set archive.max-item 2GB   largest target it takes (default:
                                           none; off removes it). A larger one
                                           is refused, not archived, not deleted.
Another archive directory: BASTRA_ARCHIVE_DIR. It must be your own; if it is
open to others, it is closed to you alone. One of another account, or one that
directly holds a link or another account's entry, is not used, and nothing is
archived or removed.
Only the rm part off: BASTRA_RM_SHIM=0.

bastra archive put <path>... makes the archiving rm's move by hand, opt-in
or not: same archive, same restore, and temp dirs are archived too, never
deleted. A user who denies Bash(rm:*) in Claude Code can allow
Bash(bastra archive put:*) on its own; the hook never rewrites rm into it.

git acts that lose work (clean -f, reset --hard, checkout [<tree>] -- <paths>,
restore, branch -D, stash drop|clear) are snapshotted first: clean's files
and any untracked file the act would overwrite go to the archive, the rest
is pinned under refs/bastra-archive/ and listed here too;
\`bastra archive restore <ref>\` puts it back. The pins show up in
\`git log --all\` until they expire. Only the git part off: BASTRA_GIT_SHIM=0.
`,
};
