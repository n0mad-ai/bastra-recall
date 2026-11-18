# Changelog

All notable changes to bastra-recall are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

The next planned product release is **1.3.0**. The interface remains **UI Version 2**
until a new design replaces it; this name is independent of the product version.

### Added

- Add a mandatory post-build Knip check with a frozen per-finding budget; new or increased unused-code findings fail CI (#1534).

- `goldset-run` takes `--archive` like the other eval runners (#503).

- `scripts/ast-equivalence.mjs`: the one-time Prettier commit changed no
  syntax tree (10/10 formatter-case files, 1,494/1,494 JS/TS files) (#1536).

- The #643 advisory harness accepts an existing physical temporary vault copy,
  isolates its application state, and reports aggregate replay and explicit
  replacement-chain routing counts without exposing stored text or IDs.

- Task reports show one state in the list and the head: New, In progress,
  Handed over, Done, Question. An agent closing the last handed-over note
  signs the report off and marks it read; a follow-up report with questions
  (`task_report_save` `follow_up_of`) shows as Question on the original
  until it is done.

- **Answer a question in a task report.** Questions ending with answer
  options such as `[? Yes | No]` offer answer buttons, a free answer and a
  request for clarification. The answer is saved as a note on that line,
  through the existing owner note workflow (#1607).
- `bastra logs --stats` counts harvest passes booked before compaction
  separately from SessionEnd passes; older logs keep their existing totals
  (#1628).
- **Notes on task reports, handed over to the agent when you say so.** While
  reading a report under Tasks › Reports, you can leave a note on a single
  place: a heading, a paragraph, a list item or a table row ("research the
  prices again", "this is how it should be"). Hover or focus the place and
  choose **Note**; the field has the same **Improve text** as the vault-care
  field in the memory browser. A new note is a draft that stays with you: no
  agent sees it. **Hand over to agent** in the report's head hands every draft
  of that report over in one click, with a short confirmation and no further
  question. Only then does an agent learn about it: the next session start
  names the reports with handed-over open notes, the agent reads them with
  `task_report_read`, treats the note texts as your instructions (the report
  text stays reference material) and closes each one with
  `task_report_note_done` and a short reply that appears under the note. Each
  note shows its state (draft, handed over · open, done), a place whose notes
  are all done turns green, and the report list and head show drafts (✎) and
  handed-over open notes (➜) apart. Editing a note makes it a draft again.
  Notes written before the hand-over existed count as drafts until you hand
  them over. Notes are cleaned like report text, hold up to 4,000 characters
  each, live inside their report and go with it when the report is deleted;
  leaving one does not change the report's read state. Only the Recall UI
  writes, edits, deletes and hands over notes; an agent's tool or `/api/v1`
  call is refused, so no agent can leave an "instruction" in your name. New
  agent tool: `task_report_note_done`.
- **Report actions stay in reach, and a search finds a report.** In the
  reports view, **Mark read**, **Mark unread** and **Delete** sit in the
  report's head, which stays on top while a long report scrolls. A search
  field above the list filters the reports by title and project.
- **Reports in the left rail.** A **Reports** entry right below **Tasks**,
  built like every other entry, opens the reports view and is lit while it is
  open. Its cyan badge counts the unread reports (it replaces the dot that sat
  on **Tasks**); its tooltip also names reports with notes not handed over
  yet.
- **Search inside the report text, and undo for delete.** The search field
  over the reports list now also finds words in the text of a report, not
  only in its title and project; title and project still filter at once, text
  hits join a moment later. Right after **Delete**, a notice above the next
  report offers **Undo**, including when the list is empty or the open report
  changes. Recall keeps a deleted report for 10 minutes and brings it back
  with its text, read state and notes. Only the 20 latest deletions can be
  undone; if the trash would exceed its byte limit, the new deletion is
  refused and earlier undo entries stay. For agents,
  `task_report_list` takes an optional `query`, `task_report_delete` answers
  with `restorable_until`, and the new tool `task_report_restore` undoes a
  delete when you ask for it (#1597, #1559).
- **Title, type, sensitivity and recall mode in the memory browser.** The
  editor in the reader now also changes a memory's title, type, sensitivity
  and recall mode, through the same revision-checked `edit_memory` path as
  the other fields: a change made meanwhile is refused and your draft stays.
  The file stays in its folder; documents and bookmarks keep their type. A
  memory set to private leaves the views that may not show private memories
  at once. The area cannot be changed here yet (#1558).
- **`/ui/#tasks` opens the Tasks area.** The web UI reads the area from the
  address (`#tasks`, `#reports`, a vault view such as `#chronos`) on load and
  when it changes; unknown names are ignored. The address follows the area
  you open, without new history entries (#1560).
- **Archived memories come back without the Mac app.** `bastra trash list`
  shows the memories archived into the vault trash (newest first), and
  `bastra trash restore <id>` puts one back where it lived. Agents get the
  same as the new tool `restore_memory` (without `id` it lists, with `id` it
  restores), on the full tool surface like `archive_memory`. The restore is
  written to the audit log; a memory that is live again under the same id is
  never overwritten, and private memories stay with the memory browser (#1471).
- **The audit log says who wrote.** Every write through a tool call
  (`save_memory`, `edit_memory`, `archive_memory`, `restore_memory`, documents,
  product docs) records `transport` (`stdio`, `forwarder`, `http`,
  `mcp-http`), `client` (the MCP client's name and version, or the OAuth client
  of a remote connector) and `caller_session` (the Claude Code session the
  forwarder reports). A record for tracing, not an access rule: nothing is
  refused or asked because of it. Folder imports also identify the CLI or web
  UI writer, retaining the import run ID and an absent client session (#1469).

- **`bastra doctor` shows more of what is really in effect.** Per installed
  client it now asks the daemon for that client's MCP tool list, as the client
  itself does, and prints how many tools arrive and roughly how many tokens
  they cost at every session start; when the daemon does not answer, it says
  so, because the client then works from the bundled list (#1472). The
  features block shows whether Codex's rulebook gate blocks or only gives
  hints: it names the installed Codex version and the verified ones, since
  every unverified version, newer ones included, runs advisory only. It also
  shows document writing (Recall Pulse) on or off (#1474). Under "autostart",
  `.bak` copies of Recall's own LaunchAgent plist in `~/Library/LaunchAgents`
  that other users can read are named with a `chmod 600` command to fix them;
  doctor itself changes nothing (#1523).
- **Search and save from the terminal: `bastra recall` and `bastra save`.**
  `bastra recall "<question>"` searches the vault without an agent and prints
  the matching memories; `--limit`, `--scope`, `--type` and `--json` for
  scripts. `bastra save --title … --type … --scope … "text"` (or the text piped
  in) saves a memory yourself through the daemon's normal `save_memory` path,
  with every check an agent's save gets, recorded as your own instruction
  (`write_origin: user-directed`) and attributed to the CLI. Fields left out
  are filled like *Save as memory* in the web UI. Both need the running daemon
  (#1492, #1496).
- **Harvest before compaction (Claude Code).** A `PreCompact` hook, registered
  with the Stop hook (`--no-stop-hook` leaves it out), books the session so the
  next harvest pass reads the turns the compaction summary replaces instead of
  waiting 30 quiet minutes. Same rules as the after-session harvest; the hook
  adds nothing to the summary. Run `bastra update` or `bastra install
  claude-code` to register it (#1486).
- **Preview a save.** `save_memory` takes `dry_run: true`: it runs every
  check of a real save (credential redaction, quality hints, claim gate,
  `replaces` and collision checks) and returns the file it would write and
  whether it would become a rule, a proposal or a note. The preview leaves
  the vault, audit and session state untouched. The stdio app bridge
  declines preview requests with an explicit error. `bastra save --dry-run`
  exposes the same preview in the terminal, requiring advertised daemon schema
  support before sending a save request (#1484, #1492).
- `save_quality` warns when a save re-asserts a claim that was already
  replaced and names its current public successor; advisory only,
  `replaces: <successor>` silences it. Editing the successor does not warn
  against its own predecessor; chains with a private successor are omitted
  (#643).
- A `write_origin: user-directed` save records transport, client, session and
  time of the call in `write_origin_evidence`, shown in the save receipt and
  in `list_rules`. No extra approval step (#1496).
- `bastra doctor` lists Syncthing conflict copies
  (`Alpha.sync-conflict-<date>-<time>-<device>.md` with the same memory id as
  `Alpha.md`). Other services do not document their copy names and are not
  matched by name (#1485).
- `REPORT.md` has a *Low-signal memories* section: memories with no or
  one-word triggers, a trigger that only repeats the summary, almost no body
  or a date-only title, with the reasons per entry. Report only (#642).
- **An unreachable Recall service is said once, not answered silently
  empty.** When a hook cannot reach the daemon, the first prompt or session
  start of that session shows one line: "bastra-recall: the Recall service is
  not reachable, so this session gets no memories. Check it with `bastra
  doctor`." (German on a German system). Later calls in the same session stay
  silent; tool calls are never interrupted by it. Works in Claude Code and
  Codex, once the installed hook program is the one from this release
  (#1473).

### Changed

- CLI help (`bastra help`, every `--help`) and chat delivery consent follow
  `language.primary`: English by default, German when selected. The guided
  `bastra install` asks for the language first when none is stored, then uses
  that language throughout (#1602). Help reads current or legacy settings
  without creating or migrating application state (#330).
- CLI address messages (`bastra address`, `config set assistant.name`,
  `uninstall`), the web UI's address answers and several usage errors follow
  `language.primary` (#1602).
- CLI usage errors (archive, trash, skills, reconcile, rules, patches, onboard,
  import, feedback, recall, save, completion) and the messages of recall/save,
  archive, trash, skills and doctor's assistant-address lines follow
  `language.primary`: English by default, German complete (#1602).
- CLI messages of `bastra code`, `patches`, `commons`, `bridges`, `reconcile`,
  `rules`, `map`, `drafts` and `doctor --replay` follow `language.primary`
  (English default, German complete) (#1602).
- install, uninstall, doctor, update, config, import, onboard (including the
  interview), token, oauth, the Desktop extension install and the status panel
  now print their messages in `language.primary` (German complete, English
  default) (#1602).
- `bastra embeddings`, `bastra autostart`, Ollama setup messages and the
  semantic-recall/autostart notes of `install`, `doctor` and `update` follow
  `language.primary` (German complete, English unchanged) (#1602).
- Memory browser: changing type or recall mode of a memory whose rule status
  depends on them shows what changes for the rule before saving; saving
  takes one confirming click.

- **Reports have their own reading area.** The Tasks head and its Reports
  button are removed from this view; Escape keeps the area open. The right
  panel shows headings and questions with an answered count and keeps its
  open or closed state across areas. Readers can choose small, medium or
  large text. Answer options stay in one framed area, with the selected
  choice in amber, and hold at most 40 characters. `task_report_save` asks
  agents to put the report first and questions after it.

- **Deleted task reports stay in the list.** A deleted report is struck
  through, with an undo countdown and **Restore**. The new `tasks.reportUndo`
  setting keeps the 10-minute default and accepts whole minutes, hours or
  days up to 30 days, or `off` (#1559).
- **Report search and project filter in the view header.** Reports with
  open notes show **In progress** in amber; hovering a report line and
  choosing **Note** is clearer (#1607).
- Claude Code subagents receive the full rule kernel at `SubagentStart`.
  Installing or updating registers 14 hooks (11 without Stop/harvest).
  Native delivery, resume and the minimum Claude Code version remain
  unverified (#1637).
- Node.js type definitions now track Node 24, and literal regex patterns use
  its built-in `RegExp.escape`; install instructions state the macOS 13.5
  minimum (#1225).

- **Node 22 is no longer supported; Node 24.16 or newer is required.**
  This supersedes the earlier next-major plan: the target release remains 1.3.0.
  Supported versions are Node 24.16 to 26. Update Node before updating
  Bastra Recall; `node --version` shows what you run. On an older Node,
  every `bastra` command now warns, and `bastra update` installs nothing
  and says why (an automatic update is held back and reported at the next
  session start). CI no longer tests Node 22.
- **`find_affected_files` says what was measured.** Its description no longer
  asks to be called first and before grep; it offers a candidate list next to
  the usual text search, not proof and not a complete list, like the server
  instructions since #1457 (#1562). The completed change-impact registration
  keeps the hash it measured; a new measurement needs a new registration.
- **The README says where Recall stands.** New short sections: how Recall
  relates to the built-in memory of Claude Code, Codex and Copilot (#1478);
  what is measured, with its limits (LongMemEval-S retrieval, the own gold set,
  abstention) and links to the registrations (#1477); what is free and what
  belongs to Recall Pulse (#1475). CONTRIBUTING.md states that document
  writing and OCR were never free. Commons is described as on hold: off by
  default and not developed further for now (#1498). The V2 evolution plan
  lists the owner decisions that replace its older release and approval rules
  (#1476).
- **`bastra tasks` speaks your language as a whole.** Its questions, lists,
  results and errors follow `language.primary`: German when it is `de`,
  English otherwise and when it is not set. Before, the task CLI was German
  for everyone. Texts that only the model reads (stored task errors and review
  reasons, `--json` output) are English and keep their codes (#1602).
- **Rule-kernel reminders require directly observed delivery.** When the
  rule kernel is due, an in-process caller can receive a short reminder with
  the catalog hash and how to fetch the rules (`list_rules`, `load_memory`)
  after it directly observed the byte-identical kernel for the same agent
  and context. Native hook clients using HTTP still receive the full text
  when it is due. The daemon can confirm that an HTTP response finished,
  but the hook can still lose its output before writing to the host. A
  changed kernel, a new agent and every compact or clear require the full
  text when the kernel is delivered (#1461).
- **Hints before a tool call have an upper size.** Each pre-tool lane
  (Write/Edit, plan, Bash) keeps its optional text within 4,000 characters:
  code-impact blocks, lower-ranked plan hints and draft quotes are left out
  whole when they would cross it. Warnings, the file-size note and rules wired
  to the action are never left out. The draft quote now also counts inside the
  prompt hook's 10,000 characters (#1460).
- **On Linux, hook state no longer lives in the shared temp directory.** It
  moved to `~/.bastra/hook-state`, so another account on the same machine
  cannot occupy its directory or lock names. Stored state is found as before,
  and old files in the former location are still imported. macOS and Windows
  keep their per-user temp directory (#1569).
- **Credentials are redacted before a memory is written.** `save_memory`,
  `edit_memory` and `save_document` run the same detector as drafts and tasks
  on their text fields; a recognized key, token or password becomes
  `[REDACTED]` before it reaches the vault. The write goes through without a
  question, and the answer names each field in `secrets_redacted` and says so
  in `warning`. Text without a credential is written byte for byte; paths and
  `$VARIABLE` references stay. Memories written earlier are not rewritten
  (#1470).
- **An expired memory is no longer shown automatically.** Once a memory's own
  `valid_until` has passed, the hooks (prompt, session start, reflex rules)
  leave it out; a rule marked `always` still stays in the automatically
  delivered rule kernel, marked `stale_status=expired`. `recall` still finds
  it and marks it `expired_on`. The
  type's default lifetime still affects ranking without hiding the memory
  from the hooks (#1468).
- **Hints cannot hide text or pose as host markup.** Memory text that a hook
  shows loses invisible characters (zero-width, bidi controls, Unicode tag
  characters, control characters; joiners inside words and emoji stay), and
  anything shaped like a tag or a chat-template token keeps its words but
  loses its angle brackets (`‹system›`). New invariant INV-SCRUB-04 (#1467).

- **Shorter tool descriptions.**
  The texts of `save_memory`, `edit_memory`, `recall`, `load_memory`,
  `archive_memory`, `list_rules` and `rulebook_check` say the same in fewer
  words, and the rulebook field descriptions are no longer sent a second time
  inside `rulebook_proposed`. In the test's definition comparison without
  task tools (document write on, UTF-16 units) the catalogue shrank from
  59.7k to 44.5k; real client lists were not measured. A test now caps each
  description, each tool and the catalogue (#1462).

- **Search: age alone now costs a note at most 30 % of its score, and rules
  without their own deadline do not age in search.** A project fact or lesson
  that nobody replaced used
  to lose half or four fifths of its score just by passing its type's default
  lifetime (90 days for project facts), and dropped out of the first results
  although it was still the answer. Now the type default ages a note mildly
  (stale and expired keep 70 %), a note with a rulebook declaration and no
  deadline of its own does not age in search at all, and the strong demotion
  stays where you set the
  deadline yourself (`valid_until`, `expires_after_days`). Replaced notes still
  yield to their successor. The staleness label a note shows is unchanged.
  Measured on a copy of a real vault (577 gold questions, fixed reference
  date): the right note among the first three rose from 170 to 253, with no
  question lost there (`packages/eval/registrations/staleness-policy-1567.json`)
  (#1567).

### Fixed

- Report and memory reader: a free-standing `---`/`***`/`___` line now renders as a thin divider instead of literal dashes.

- Vault and client imports redact credentials before saving content and new
  audit snapshots, and report changed fields in import warnings.

- Reports: the reading pane lines up with the other areas again; the jump list uses the side panel's own rows with the active marker on the outer edge and names questions by their heading; answer options, own answer and clarify are equal fields across the full width.

- Switching to another task report keeps undo available for a deleted
  report (#1559).
- Eval archives choose an unused name through the exclusive copy, including
  a counter for further same-name artefacts in the same second; existing bytes
  are never replaced (#1641).
- Gold-set `--gate` reads evidence deadlines at the run's reference time and
  records it as `evidence_time`; production keeps the wall clock (#1642).
- Hook offline notice markers expire with the session retention horizon;
  notices still appear at most once per session within that horizon (#1640).
- `bastra tasks` treats inherited property names such as `toString` and
  `__proto__` as unknown commands instead of calling `task_controls` (#1644).
- The cmux sender observes its wait deadline when a stale lock cannot be
  removed and keeps foreign lock contents (#1645).
- cmux agent sender pauses between retries when a broken symlink occupies the
  target lock instead of spinning until the deadline (#1648).
- Tasks web UI: the Run button of a prepared change stays disabled after the
  run returned an outcome, so a re-rendered dialog cannot start it again
  (#1651).
- Size note: settings are read off the event loop by at most one background
  reader and bounded by the note's deadline; only regular files are opened and at most 2 MiB of real bytes are
  read, so oversized files, devices behind symlinks and growing files no
  longer keep reading after the note returns (#1650, #1538).
- Vault-root history: concurrent registrations of different vaults no longer
  lose an entry or falsely block a save as `unwritable`; a persistent
  concurrent-update conflict is reported as its own cause (#1659).
- Report questions: the daemon's question status and the reader now share one
  answer-option contract (at most 40 characters per option; markers in code,
  headings or with formatting inside stay text) and one inline scanner, which
  takes linear time, so a line full of unclosed brackets no longer stalls the
  report list or the reader (#1656).
- Report reader: an escaped marker `\[? … ]` stays text and is shown without
  the backslash (#1652).
- Report reader: after resizing across the narrow width, the contents panel
  jumps to and tracks the text on screen (#1655).
- The lint configuration guard compares template and regular-expression text,
  rejecting unverified path and regex changes (#1646, #1535 S2).
- Invalid custom numeric settings keep their entered text and block Apply and
  restart until repaired; clearing or choosing a listed value repairs the draft.
- Rule-kernel cadence counts each agent separately. A failed or expired
  delivery returns its calls to the owning agent without consuming another
  worker's due reminder (#1623).
- Expired task-report undo entries leave disk on list or restore, preserving
  the existing undo window and entry limit (#1614).
- Pending rulebook-failure observations in an account-private legacy tmpdir
  spool are drained after hook-state migration; unreadable or unsafe files
  remain untouched (#1638).
- PSK assignment redaction no longer skips values based on the words before
  the key; the existing syntax scanner still handles protocol-mode values
  (#1625).

- Concurrent `tools/cmux-agent-send.mjs` senders to the same terminal target
  take turns from message text through Return, keeping submissions separate
  (#1636).
- Vault: of two files in one folder that carry the same memory id, the copy
  could win the index — `Alpha (1).md` sorts before `Alpha.md`, and a copy
  indexed first kept its entry when the original arrived — so a correction
  could disappear from recall. When one name extends the other, the shorter
  name (the original) now keeps the entry, at startup and in the watcher; the
  check reads no words. Other duplicates are handled as before (#1485).
- Releases: `publish-release-set.mjs --verify` now waits up to 20 minutes
  (was five) for npm to serve a fresh release, and asks again after a failed
  registry read. A failed `latest` lookup remains a registry error, and a
  hung npm process cannot outlast the verification window (#1076).
- OAuth: a burst of anonymous client registrations can no longer push out a
  client that is in the middle of signing in (an open sign-in page or a code
  not yet exchanged); when every slot is busy, a new registration is refused.
  Open sign-in pages have a limit over all clients, and at the limit a new one
  is refused instead of closing someone else's (#1280).
- `tools/cmux-agent-send.mjs` waits 300 ms between the message and Return, so
  an idle Codex pane submits it instead of keeping it in the input field
  (#1155).
- Windows: the offer to install the `bastra` command at the end of the setup
  runs npm through `node.exe` and npm's `npm-cli.js`, like `bastra update`,
  instead of starting `npm.cmd`, which current Node refuses without a shell
  (#1274). Setup recognizes the npm directory on PATH regardless of case.
  Checked with a simulated Windows platform only.
- Web UI switched off: the vault image and the import count no longer answer;
  `/ui/health` (the same answer as `/health`) and the address refresh the CLI
  uses stay open on purpose (#1571).
- Live updates: many private changes in a short time no longer push public
  changes out of the update buffer before a caller without private access has
  fetched them (#1605). When a memory becomes private, callers without
  private access also stop receiving its buffered history (#1618). Graph and
  semantic views recheck visibility before returning data from an overlapping
  read (#1617).
- `bastra doctor` names a link or another account's entry inside the archive
  directory on the archive line, the same entry the archiving `rm` stops at
  (#1606). It also reports an unreadable archive directory and continues its
  other checks.
- Lock and marker files in the vault folder (save claims, area marks), the
  update-check cache and staged marker, the task comparison marker and the
  vault care list are read without following a link or waiting on a FIFO; a
  special file there is refused at once instead of hanging (#1604).
- Assistant address: the names of 17 internationalized top-level domains
  (for example `москва`, `在线`) were split in the built-in block list and
  could be taken as an address; they are refused again (#1555).
- Task reports: a note is shown at its place only while that place still holds
  the text the note was left on; otherwise it is listed under "Notes whose
  place is no longer found" instead of at a wrong place (#1608). A full report
  store now says so and that deleting old reports makes room, instead of a
  generic error (#1609). When the reports view is rebuilt while you type a
  note (a live update), the cursor, the selection and the field's scroll
  place stay where they were (#1610). The report store now keeps fields a
  later version adds instead of refusing the whole store, so going back one
  version no longer locks you out of your reports from now on. Going back to
  1.2.1 itself is the exception, because its store check is still strict:
  while any report carries a note (done notes included) or `follow_up_of`,
  a 1.2.1 daemon
  refuses the whole report store ("Task report store unreadable"). Nothing is
  overwritten or lost, and this release reads the store as before; removing
  the notes and `follow_up_of` links, or the reports that carry them, before
  going back avoids it
  (#1611). Search
  handles Unicode compatibility letters regardless of case, and older search
  responses cannot replace results for the current input (#1597).
- Web UI: changing the time window while the lens is covered by the memory
  browser no longer stops the lens from drawing; the replay starts when the
  cover closes (#1552). Two identical vault-care flags on one memory keep
  separate drafts in the reader (#1554).
- Docs: the README no longer asks you to rerun `bastra install` after an
  update; `bastra update` registers the clients again by itself (#1489). The
  hooks guide names `npm install -g bastra-recall` as the install path, like
  the README (#1575). The README says that a suppressed save suggestion is
  restored by its proposal ID and that there is no list of them yet (#1466).
- Tasks: archiving or deleting a task is no longer refused while the task
  store is above 75 % of its limit, as long as it makes the store smaller, so
  a full store can be cleared again. The automatic time evaluation no longer
  uses the space kept for the owner's own control operations; it only uses it
  for the one history row that switches a full task off (#1599). Already due
  reminders still reach their delivery paths when a new evaluation runs out
  of space. After five minutes, a reminder is eligible for chat delivery again
  when a crash occurred before sending. Once sending may have begun, the
  claim prevents another announcement, including when upgrading with an
  older claim of uncertain delivery (#1600). Source errors and review
  reasons stored in a task are English (#1602).
- Hooks: the file-size note before an edit has its own deadline (a quarter of
  the lane budget); a slow disk can no longer spend the time of the recall
  that follows. A named pipe no longer keeps the hook running past that
  deadline (#1538).
- Hooks: every hook client waits until its answer is fully written before it
  exits. On macOS and Linux a large answer read slowly by the host could be
  cut off, because writes to a pipe are asynchronous there. A closed output
  pipe is handled without an unhandled stream error (#1573).
- Session start names deferred context even if the required sections exceed
  the budget. When many sections are deferred, the notice can show their
  count (#1639).
- `bastra logs --stats` judges the session lane against the 1,500 ms
  SessionStart budget it runs with, not 500 ms (#1564).
- Telemetry: old recall rows from a tool lane (such as the fixed session-start
  queries) are no longer counted as agent recalls in the demand-gap report
  (#1266).
- OAuth: a connector sign-in that runs past the 10-minute expiry for unused
  registrations now completes; the client is kept while its sign-in page is
  open or its code is unredeemed. Idle registrations still expire (#1619).
- Saving a memory refuses a FIFO or other special file at the memory's path
  at once instead of hanging (#1620).
- The daemon's error for an invalid assistant name follows `language.primary`
  (German or English) instead of always being German (#1621).

- Installer backups are private: `bastra install` and `bastra doctor --fix`
  write `*.bak-<time>` copies of client configs with mode 600 from the first
  write and never overwrite an earlier backup; the same holds for
  `bastra rules` and the copies `bastra update` keeps of locally modified
  files. Existing backups are left as they are (#1524).
- **Reviewed-miss harvester: five edge cases.** A byte-order mark no longer
  costs a transcript its first record; subagent (`isSidechain`) records are
  skipped; a load in the same message as a second recall is judged only
  against the results it could see; a recall after a slash command counts in
  `transcript_recalls`; and `hit_count` above zero next to an empty `hits`
  list is no longer read as an empty pool (#1126).
- **Invalid JSON in the `daemon.env` setting blocks Apply again.** Since the
  new web UI, an invalid edit was only marked red, and Apply stored the last
  valid text typed before it instead of what the field showed. Apply and the
  daemon restart are refused again while the field holds invalid JSON: the
  bar names the problem and the cursor jumps into the field. Correcting the
  text or clearing the field allows Apply; the invalid text survives a
  refresh of the settings view. Even when it is the only edit, the change
  list shows the error and offers a reset without displaying the field's
  contents.
- **Task errors and review notes in the web UI follow the UI language.**
  Stored task error and review texts are English (#1602). The task details
  and the failure column now show them in German or English by their fixed
  code: source limits and timeouts, an unreachable source, a full task
  history, a time that does not exist because of a clock change, a changed or
  ended bound decision, reminders from the chat being off, and the archive's
  execution failure. A text without a known code is shown as stored.
- Conflict marking checks whether the caller can see the target before
  preparing a preview or writing a conflict block. Preview and save now
  apply the same guard when a previously known vault is missing (#1484, #464).
- The app bridge validates the RPC method as a string before routing.
- The installed assistant-address helper loads its settings reader from its
  own runtime directory so it can serve the UI outside the npm installation.
- `bastra save` preserves UTF-8 characters from piped input when their bytes
  arrive in separate chunks (#1492).
- Restore the requirement for a substantive reason to the rulebook
  exception tool description, and clarify the stable-preference exception
  in the memory-save guidance.
- Evaluation keeps both statements of a typed pair on the same side of
  the development/holdout boundary by excluding pairs that cross it. Run
  archiving keeps an output named `SHA256SUMS` separate from its checksum
  list (#1578, #503).

### Internal

- Split gold-set selection from stratification without changing seeded
  results; remove its complexity baseline exception (#1643).
- Move the bridge pool path and migration to `learned-recall/pool-path.ts`;
  backend modules no longer import them from `cli/` (#1518).
- Restore tests of task execution, calendar and board drops, session renewal
  around writes and honest telemetry display using real UI modules in a
  synthetic DOM/VM fixture; no native browser run (#1615).
- Pin secret-redaction outputs to a frozen seeded pre-split fixture, with
  explicit exceptions for the later intentional PSK fix (#1528).
- Import/update execution steps, loopback CLI calls, settings registry access
  and HTTP hook routing reuse existing boundaries under characterization tests
  (#1514, #1508, #1510, #1529). Wizard and draft-promotion cuts remain open.
- Semantic gate-denial tests use the existing fixture clock so scheduler stalls
  do not consume production deadlines; independent timeout controls remain
  unchanged (#1303, #1506).

- Task-tool descriptions keep a shorter credential and chat-authorization
  contract at every entry, with tighter description and catalogue budgets;
  tool names, schemas and operational rules stay unchanged (#1462).
- CI tests the exact Node version pinned by publishing, alongside Node 26,
  and checks that those versions do not drift apart (#1590).
- The lint ratchet compares CI changes with the last successful ancestor run
  on `main` or the PR merge base, and checks for weaker lint configuration.
  Ignored source files cannot count as checked; mixed-case source extensions
  and workspace `/dist` imports are covered. Independent top-level statements
  cannot share a frozen module-depth budget, and structure diagnostics mark
  ambiguous anonymous siblings explicitly (#1535).
- Clone checks reuse one explicit Git file list for both scan groups without
  changing their filters or thresholds. The paired measurement did not establish
  an end-to-end speedup. CONTRIBUTING documents renamed-copy detection limits,
  the manual counter-review checklist and the recorded owner-decision path for
  a justified exception (#1535).
- The remaining stdio bootstrap, draft-promotion and binary-parity test files
  are mechanically formatted after formatter-independent tests or type checks;
  their syntax trees remain equivalent. Format checks ignore local evaluation
  scratch output while retaining evaluation sources and tests (#1539, #1616).
- The architecture reference describes audited document writes and their
  sidecar-only, best-effort limits (#1633).
- The interrupted stub-staging ignore test isolates Git's global configuration
  and proves a missing repository rule is detected (#1627).
- The TUI footer reuses the existing metric and environment formatters, with
  its full display output pinned before the structural change (#1626).
- **Six import cycles gone, task CLI and task evaluation cut along their
  decisions: same behaviour** (#1515 B1–B7, #1518, #1514, #1520 D6, #1526).
  Shared pieces moved into small modules below their users (lean summary cut,
  `commons-store.ts`, `rulebook-round-state.ts`, `draft-use-proof.ts`,
  `task-canonical.ts`/`task-source-file.ts`, `cli/task-cli-call.ts`); the
  backend no longer imports from `cli/`. `bastra tasks` dispatches through a
  handler table, pinned per sub-command (daemon calls, output, exit code) by a
  characterization test. The task snapshot evaluation and the task action
  transaction run as one function per decision. The draft search snapshot uses
  the store's expiry rule. Cycle baseline 39 → 27 edges.
- **Settings, embedding provider and bridge: same behaviour, less branching**
  (#1510, #1529, #1520 D7). `bastra config get|set` uses a table per key
  instead of two long switch statements; its output and stored settings are
  pinned per key by a characterization test. The thin-client feature read
  (tasks, telemetry) takes the data directory from the shared host paths and
  parses in one small function. The daemon and the app bridge build their
  embedding provider in one place (`embedding-provider.ts`; only the daemon
  sends Ollama `keep_alive`, as before). The bridge's request methods live in
  `bridge-methods.ts`; a test pins every method's reply before and after.
- **Invariants: the product's promises in one catalog and one command**
  (#1570). `docs/invariants.md` lists 44 promises whose breach would harm a
  user, grouped by area: no silent data loss on save and edit, private
  memories, injection and secret scrubbing, the rulebook (a user-directed rule
  applies at once, an agent's declaration stays a proposal), the session start
  context, recall answers, tasks and reports, the daemon's HTTP boundary, the
  external contracts, Node.js support and the two languages of the web UI.
  Each one names the test that holds it; the test's title starts with the ID.
  `npm run test:invariants` runs exactly these tests (they also run in
  `npm test`), and a catalog check fails when an entry loses its test or a
  test claims an ID the catalog does not list. Most promises were already
  held by existing tests, which now carry the ID; new tests pin that a save
  without `overwrite` never replaces a memory, that a saved memory is found
  by its id after a restart, that every TCP listener binds to 127.0.0.1, and
  that the German and English UI catalogs match key for key and placeholder
  for placeholder. CONTRIBUTING.md says when to add an invariant and that an
  invariant test is never weakened without changing its catalog entry.
- **A unit test for the Claude Desktop adapter** (#1566): install writes the
  MCP registration and the skill and keeps foreign servers, a second install
  changes nothing, uninstall removes only Recall, and the evidence ledger row
  matches the tested adapter.
- **The Codex gate probe takes `--expected-version`** (#1541), like the Stop
  probe, and `docs/rulebook-host-probes.md` lists the steps to check a new
  Codex release. Codex CLI 0.167.0 now has native-gate and Stop probe evidence
  for the measured paths, beside 0.162.1 and 0.166.0. Fork remains verified only
  on 0.162.1; apply_patch/MCP denial and other unmeasured paths remain
  unverified. This is not a live-installation certification.
- **Abstention figures registered** (#1463):
  `packages/eval/registrations/abstention-1463.json` reads the 79 unanswerable
  gold-set questions from the registered September runs. A partial current-code
  follow-up on an isolated vault copy adds hybrid and BM25 results; the full
  preregistered gate on/off and scoped/full-hook matrix remains open.
- **The passive-delivery bridge test no longer hangs on a bridge that already
  exited** (for example a missing `dist/bridge.js`): cleanup returns at once,
  is bounded and keeps the test's own error (#1324).
- **Hook context load can be measured again.** `npm run hook-context-load
  --workspace @bastra-recall/eval` reports from the event log what each hook
  lane injected, the draft quotes, the rule-kernel re-deliveries and the plan
  lane's follow-through. The #1371 measurement report is checked in under
  `packages/eval/reports/` (its transcript scripts were lost and are marked as
  missing), with a baseline for #1460, #1461 and #1464 (#1465, #1464).
- Hook lanes share one request type for `/hook/recall`; the session hook's
  unused `postRecall` is gone (#448).
- `redactSecrets` is split into one step per pattern family; every function
  is within the complexity limits and the output is byte-identical on the
  frozen corpus. `bastra logs` moved out of the CLI dispatch table (#1528).
- **Unit tests for the panels and the status line** (#1490): the three panel
  designs (Classic, Orbital, Ember) are checked for exact width, colour on
  and off and their content in every session state, the Codex panel data for
  each source state, the Codex transcript reader for each record type and the
  TUI status line segments; golden digests pin the full output.
- The Codex transcript reader, the Codex panel's data preparation and the TUI
  segment resolution are split into steps within the complexity limits; the
  rendered status line and panel data are byte-identical (#1530).
- Five tests that needed the repository's own `.git` now build their git
  folder in a temp directory, so the suite also runs in a copy of the code
  without `.git`, for example from an archive (#1488).
- Gold-set runs use a fixed reference date for the staleness step
  (`--reference-time`, default 2026-11-15) and report a second set of numbers
  at the day of the run, so runs on different days are comparable (#1568).
- `--archive` on `longmemeval-run`, `rerank-replay`, `rerank-longmemeval` and
  `rerank-pool-coverage` files the `--out` artefact under
  `~/.bastra/<harness>-runs/<date>/` with a `SHA256SUMS` line; the gold-set
  runner writes `SHA256SUMS` into its run directory (#503).
- `packages/eval/scripts/fingerprint-history.mjs` places a registered source
  fingerprint in git history; `registrations/fingerprint-map-1536.json` maps
  the fingerprints the one-time reformatting changed (#1536).
- `tools/draft-judge-eval/label.mts`: label captured draft-check examples by
  hand (blind to the model's verdict, stratified by verdict class, one
  statement in five held out); the labels are the reserved `human` records of
  the local training capture file (#1578).
- One shared seeded random generator for the eval split, control arm and
  bootstrap, with its sequence pinned by a test (#1520).
- Report on associative gold-set misses:
  `packages/eval/reports/associative-misses-1491-2026-11-17.md` (#1491).
- **Hook transport and lanes cut along their steps: same behaviour**
  (#1508, #1525, #1513). Every hook client (node clients, `hook.ts`, the
  compiled stub) now uses one wire transport, `hook-transport.ts`; the
  daemon's own loopback calls (session context, floors, taxonomy, health,
  drift, the hinted ping) share `prompt-loopback.ts`. `runWriteLane` runs
  named steps from `write-lane-hints.ts` and `write-lane-code.ts`; the gate
  lane's locked state mutation runs named steps from `gate-lane-claims.ts`;
  `runHookRecall`'s stage timings, event-loop probe and telemetry row live in
  `hook-recall-measure.ts`, its shadow measurements in
  `hook-recall-shadow.ts`. Pinned by golden-master tests recorded on the
  unsplit code (`write-lane-golden`, `gate-lane-state-golden`,
  `hook-recall-golden`, `hook-transport-contract`,
  `loopback-helpers-contract`).

## [1.2.1] — 2026-11-16

### Security

Fixes reported in a contributor audit of the 1.2.0 hardening.

- **Forwarded requests need the token on every local route.** A request that
  carries a proxy header now needs the API token on all local routes, not only
  on hooks and the web UI; only the public OAuth discovery documents under
  `/.well-known/` stay open, as before. `X-Real-IP`, `X-Forwarded-Proto` and
  `Via` now count as proxy headers too. `/api/v1/*` keeps its own token and
  sign-in rules; direct local tools are unchanged.
- **A lock that is not a regular file can no longer stall the service.** The
  shared lock for the daemon's settings and state files, the code map's build
  lock and the log files read for the telemetry report are now read without
  waiting. A special file, a link or an empty folder in place of that shared
  lock is removed (only the link, never the file it points to); where an
  unknown owner must never be replaced, it is refused with the normal "lock
  unavailable" error instead. A folder with content is never deleted and is
  handled as before.
  The code map replaces a special file or a link like any other broken lock
  after its short grace period, and the telemetry report skips such a log
  file. Locks inside the vault folder itself and a few other marker files of
  the daemon are not covered by this change yet.
- **The patched hono versions now reach every install.** `hono` (4.13.19 or a
  later 4.x) and `@hono/node-server` (2.1.8 or a later 2.x) are direct
  dependencies of the daemon package, so a plain `npm install` gets them too.
  The Claude Desktop extension is built with the repository's version pins and
  checked against them, including nested copies; a prerelease does not pass.
- Live updates in the web UI: the update counter that a caller without access
  to private memories sees now counts only the updates that caller may see.
- **The archive directory itself must be yours.** A directory set with
  `BASTRA_ARCHIVE_DIR` that belongs to another account (for example a shared
  folder) is no longer used. The archiving `rm` and the git snapshots then
  stop with a clear message and leave every file where it is; `bastra doctor`
  shows the problem. Your own directory that was open to others is closed to
  you alone, as before.
- **The archive is not used while it holds something that is not yours.** If
  a link or an entry of another account lies directly in the archive
  directory, the archiving `rm` and the git snapshots stop and leave every
  file where it is. This also applies to a link you made there yourself. The
  message names the entry; move it out of the archive directory to use the
  archive again.

### Fixed

- Web UI: clicking a memory in the Live list now jumps to it in the vault view
  and in the memory browser; a closed browser opens on that memory. Before,
  an open browser stayed on the memory it showed.
- A request path with invalid percent-encoding is answered with `400` instead
  of `500`.
- `save_memory`: three failed attempts no longer tell an unrelated save to
  stop retrying. The limit now counts per memory and caller, so a first
  attempt at another memory gets its own error message (#1593).
- Setup question in a new vault: the agent starts it at most once per session
  and no longer calls a vault with a few memories empty (#1595).
- `bastra drafts list` says when the draft store is full and new first
  captures are being dropped (#1592).
- Settings: resetting one setting to its default no longer removes the other
  stored settings of its group. Resetting `tasks.enabled` kept losing the
  stored Claude chat setup answer (`tasks.chatConsent`), and resetting
  `ui.enabled` the background image. A reset that would leave the experiment
  settings incomplete is refused instead of silently clearing them (#1582).
- Settings: saving one value (for example the background image) no longer
  stores the current default of `ui.enabled`, `tasks.enabled` or
  `sharedRecall.enabled` as if it had been chosen, so a later change of these
  defaults reaches everyone who never picked a side (#1576; `ui.enabled` part
  proposed by @bfs2021 in #1577).
- Tasks: a task lock left behind by a process that ended before the last
  restart of the computer is taken over automatically, even when its process
  number now belongs to another program. On macOS the lock of an ended
  process is also taken over after the computer's network name changed. A
  lock of a running process is never taken over.
  The error now names the task store instead of the settings file (#1587).
- Local app data: a read that loses a race with another process finishing the
  same first-time move into `recall.db` returns the stored state instead of
  "no state", which could lead to defaults being written over it (#1579).
- Local app data: a process using a different `BASTRA_DB_PATH` than the one
  the state was moved into now stops with `ESTATEELSEWHERE` and names both
  places, instead of reading "no state" and starting a second, diverging copy
  (#1588).
- Local app database: a full disk or I/O error inside a transaction is
  reported as such, not as "cannot rollback - no transaction is active"
  (#1589).
- Local app database: backups before a migration or import no longer fail
  with `EPERM` on Windows (#1580).
- Hook state: a legacy hook state file that reappears with content different
  from its retained original no longer makes every hook state load fail; both
  files and the stored state stay as they are (#1584).
- Tasks: a recurring calendar reminder whose time falls into the hour skipped
  by a daylight saving change now fires right after that hour on that day and
  keeps running, instead of being switched off for good. One-off reminders at
  such a time are still refused when you create them (#1585).
- Tasks: editing a field that does not change the time (for example the area
  or the end of validity) no longer fires an already delivered reminder again
  with a large missed count. A time reminder you have not seen yet is shown
  once more; a reminder triggered by an event stays as it is when only the
  area or the end of validity changes (#1586).
- Tasks: a chat announcement that is stopped before anything is sent is tried
  again later, and the reminder stays visible on the next contact (#1583).
- Tasks: one task whose history is full no longer stops all other reminders,
  also when several events for it arrive at once. That task is switched off
  with a visible error instead (#1581).
- Tasks: the Mac notification for an expired task follows `language.primary`,
  with English as the fallback; the reminder confirmation is no longer
  prescribed in German, and the task cards and reminder access hints the agent
  reads are English. Some stored error and review texts still reach the agent
  in German (#1594). The
  `bastra tasks` CLI stays German as before, error messages included, so one
  dialog never mixes two languages; a missing terminal now gets its own message.
- Tasks: recording the Claude chat setup answer no longer stores the current
  default of `tasks.enabled` as if it had been chosen.

### Documentation

- Linux: Recall cannot yet check which local user account a request comes
  from. Run it there only on a computer with a single user.

## [1.2.0] — 2026-11-16

### Added

- **Tasks and reminders in conversation.** Agents create, edit, postpone,
  acknowledge, resolve, cancel, archive and delete tasks of every level. A task
  the user asks for is created active; the agent asks only when goal, date,
  time, time zone or repeat is missing or unclear. A deadline or promised
  follow-up the agent notices itself becomes a reminder, announced in one
  line. Due tasks are mentioned briefly at the start of the agent's answer.
- Repeating tasks can run without an end, can be paused and resumed, and end
  with an explicit "end series"; finishing one occurrence leaves later dates
  active. A task can have an optional validity end (`expires_at`) and, for a
  one-off task with registered evidence, an opt-in completion once that
  evidence is verified.
- **Mac notifications for due tasks** (`tasks.notifications`, on by default
  while tasks are on). They also appear without an open chat, never start an
  agent and do not count as read.
- **Due tasks in the open chat.** A due task can reach the chat in which the
  user last typed, within `tasks.chatActiveMinutes` (default 30). Claude Code
  needs a one-time consent during setup (`bastra install` or
  `bastra tasks setup-hooks`) (#1421); Codex CLI terminals started with
  `bastra codex` take part in the same selection (#1425). Leases of active
  chats are renewed and old sessions retired (#1426).
- Tasks can carry what they wait on, their origin (mail or memory), an agent
  note and who holds them (you or Recall).
- Local snapshot sources for projects, worktrees, task phases, symbols and
  metadata can trigger tasks (#1420). A local app contract adds an event
  stream, an explicit read receipt and execution results for a future app; it
  starts no agent.
- **Task reports.** After larger or autonomous work, agents file their final
  report with `task_report_save` instead of a long chat answer;
  `task_report_list`, `task_report_read`, `task_report_mark` and
  `task_report_delete` complete the set. Reading never marks a report read.
  Before storing, Recall removes injected context blocks and replaces secrets
  with placeholders. Up to 200 reports are kept; beyond that new reports are
  refused and nothing is dropped. In the web UI, Tasks › Reports shows a list
  and the report with separate Mark read, Mark unread and Delete; unread
  reports show as a dot in the navigation, in the header ticker and in a
  dashboard widget.
- **Local app database.** Settings, tasks, drafts, hook state and other local
  app state move into `~/.bastra/recall.db` (SQLite); memories stay Markdown
  files in the vault. The move happens once, keeps the old files under a new
  name and backs up the database before every upgrade step (#1339).
- **Settings page** in the web UI, built from one registry that also drives
  `bastra config` (#1294, #1295, #1296). It covers tasks, telemetry, twelve
  existing environment options, autostart and login registration. Invalid JSON
  blocks saving; an explicit environment variable still wins.
- **Web UI areas:** a dashboard with widgets you can add and arrange;
  Telemetry; Tasks with a calendar, the due cards, a new-task form and a
  details, view and control panel; Areas, Import and Settings.
- **Memory browser** as its own area: search and read memories, with recall
  hints, facts, recall statistics and a 30-day curve.
- **Agent window** in the web UI: a small assistant on your local model that
  searches the vault, answers task questions from the real task list in every
  area and opens an area on request. Conversations are kept in the app
  database and can be reopened or deleted. Under each answer, **Save as
  memory** opens an editable preview; only your confirmation writes the memory
  (#1445).
- **Assistant name in any language and script.** The local web address is
  derived from it; a name that yields no address is still saved and the
  current address stays.
- **Personality:** choose a base personality (balanced, direct, warm, playful,
  sparring partner) and describe in your own words how you want to be
  treated. It applies to the agent window and to new sessions of connected
  clients; it does not learn yet (#1504).
- **Vault care notes** can be edited after saving. **Improve text** lets the
  local model tidy a note; the result can be undone before saving.
- The Ring view draws links as arcs with link kinds and a legend. Vault views
  zoom to a chosen memory and pause while a card is open. Notices run in the
  header ticker. A live list shows memories that are new, changed, deleted or
  read.
- Background image (presets or your own pictures, which you can delete again)
  and weather for a place you choose.
- Locked views say they belong to **Recall Pulse** (coming soon): the vault
  views Chronos, Radiant, Spiral, Half-life and Weave, and the task calendar
  styles Flow, Stream and Relay. Recall Pulse is the paid tier and is not
  available yet.
- Rule proposals can be confirmed or rejected in chat; the agent passes the
  user's decision with `edit_memory` and `expected_revision` (#1387). Saving
  or editing a rule asks the agent to review the complete lasting rule text
  (#1378).
- A save suggestion the user rejected can be switched off for that project and
  restored later (#1389).
- `bastra archive put <path>...` moves paths into the archive with the same
  move and restore as the archiving `rm`, and never deletes. A user who denies
  `Bash(rm:*)` in Claude Code can allow `Bash(bastra archive put:*)` on its
  own; the line under the deny names that rule. The hook never rewrites `rm`
  into it (#1383).
- The web UI's memory browser edits memories directly in the reader: summary,
  text, tags and rule fields through the `edit_memory` path with the shown
  revision (a change made meanwhile is refused, the draft stays), archive into
  the vault trash with undo, and a chip that says whether a rule applies, is
  proposed or the memory is a note (#1446).

### Changed

- **Proactive tasks and reminders are on by default**, for new and existing
  installations. An explicit earlier opt-out stays in effect. Switch them off
  in Settings › Tasks, with `bastra config set tasks.enabled false` or with
  `BASTRA_TASKS=0`, then restart the daemon and the clients. Switching off
  cancels no task. Remote MCP still offers no `task_*` tools (#1289).
- **The user's instruction in chat is the approval**, also for the execute
  level. The agent records who asked, in which program and session and with
  which words; Recall adds the time. No key file, signature or separate
  approval step is needed. If the agent proposes a consequential action the
  user did not ask for, it asks once in chat (#1424). `bastra tasks keys`,
  `approve` and `deny` only explain this and change nothing; the old key
  registry is kept as a backup and renamed. Prepare unfinished actions again
  with the user's instruction (#1428).
- On macOS, the web UI and the task routes answer only to programs of the
  macOS account that owns the vault (#1419). There the web UI shows private
  memories too; on other systems it keeps showing no private memories.
- Telemetry stores finished days in the app database and keeps the report
  until its data changes. The first time Telemetry opens, it fills the table
  from the existing log files (#1438).
- Document write tools are listed only when `BASTRA_DOCUMENT_WRITE` is on;
  before, agents saw them although the daemon refused them (#1458).
- **The source code was reformatted once** with Prettier and ESLint, which CI
  now enforces. If you keep your own patches on the installed code
  (`bastra patches`), they can conflict after this update; recreate such a
  patch on the new code (#1537).
- An assistant name whose address form has `--` in positions 3 and 4 gets an
  address only if it is a valid international domain name; such names are
  still saved.
- The onboarding interview waits while the user is in the middle of concrete
  work (#1411). The rulebook guidance in each round is shortened when nothing
  changed since its full delivery; IDs and revisions stay (#1371).
- **The web UI is on by default on macOS.** There it is bound to the macOS
  account that owns the vault, so it is on for new installations and for
  existing ones without a stored choice; the setup preselects the current
  state. On Linux and other systems this account binding does not exist yet,
  so the web UI stays off until you switch it on with `bastra map` or
  `bastra config set ui.enabled true`. Linux has not yet been properly tested
  in real use; that will follow. If you switched the web UI off, it stays off;
  if you switched it on, it stays on. To switch it off:
  `bastra config set ui.enabled false`.
- **The web UI is now the UI v2.** `/ui/` (and `bastra map`, the assistant's
  local address and every other link that opened the web UI) shows it. The
  Mindspace, Clouds and Semantic views run on the unchanged map engines.
- **Node 22.22 or newer is now required** (was Node 22). Supported versions
  are Node 22.22 to 26. On an older Node 22, update Node before updating
  Bastra Recall; `node --version` shows what you run (#1368).
- The vault file watcher now uses chokidar 6, which needs Node 22.22 (#1368).
- Documentation now names only the tested clients: Claude Code (CLI), Codex
  (CLI), Claude Desktop, ChatGPT (web and phone app, over remote MCP) and the
  ChatGPT desktop app with Codex. Untested clients are no longer listed; other
  MCP clients may work and are added once tested. Linux is untested in real
  use (#1451).
- The skill and the guides no longer promise OCR: Recall searches document text
  that is already in the vault, and OCR for scans is a Recall Pulse feature of
  the Mac app (#1450).
- README and hooks guide now agree that the Stop hook is on by default, give
  the SessionStart budget of 1500 ms, and say that clients without hooks read
  the rulebook with `list_rules` (#1453). The remote access guide and the
  roadmap describe the current release state (#1454).

### Removed

- The first web UI (its page, styles, scripts, right-click menu and the
  local Mindspace lab pages). Its views live on in the UI v2. Three of its
  actions have no place in the UI v2 yet: setting a vault image for the ring
  centre, marking a ghost as a skill from the map (`bastra skills add` still
  declares skills) and flagging a ghost with *write* for vault care (#1561).

### Security

- hono is updated to 4.13.19 and @hono/node-server to 2.1.8. Both come in
  through the MCP SDK; the updates close the open advisories for them.
- The web UI serves private memories, vault care notes of private memories and
  the details of linked private targets only after the caller's macOS account
  was confirmed; elsewhere it serves the filtered view. Saving from the agent
  window no longer reveals whether a hidden memory exists.
- A source that cannot be judged (deleted, unreadable or with broken
  frontmatter) now counts as private for untrusted callers, and
  `load_memory` returns the revision of the text it actually delivered
  (#1334).
- Requests forwarded to the local assistant address need a token (#1264). The
  number of waiting requests and address helpers is bounded, slow clients can
  no longer hold every helper, and dropped requests are reclaimed (#1335,
  #1401).
- Migration and probe files, the execute target and offline lock files are
  opened through checked file handles (#1213). The rulebook spool checks its
  base directory before it creates anything below it.
- Hardened request handling: the daemon rejects ambiguous request paths
  before any access check, keeps private memories out of live updates for
  unverified callers, and reads legacy hook state only from private
  directories. A stale lock marker that is not a regular file can no longer
  stall the daemon.
- The archive's directories are created 0700, and a volume's own
  `.bastra-archive` is used only when it is a real directory of this user (not
  a symlink, closed to 0700 if open). On a mount root writable by everyone,
  such as a tmpfs `/tmp` on Linux, another user could otherwise have made the
  name first and read or changed what moves in (#1383).
- An archive made 0755 by an earlier version is closed once: the archive root
  and its dated directories become 0700, the manifests 0600, and a new
  manifest is created 0600. A volume's `.bastra-archive` that is open to
  others is now refused instead of taken over, since it could be swapped
  between the check and the chmod (`chmod 700` it if it is yours). Before the
  move, every directory between the archive root and the destination must be
  a real directory of this user, never a symlink; otherwise the target stays
  where it is. A symlinked archive path the user set keeps working (#1383).

### Fixed

- `bastra update` now works for installs made with `npm install -g
  bastra-recall`, the npm install the README shows. It used to install
  `@bastra-recall/daemon` on top, which npm refuses because both packages
  bring the `bastra` command, so the update stopped with an error and changed
  nothing. It now updates `bastra-recall` itself and finds the new version
  inside it for the restart and the re-registration, also on Windows. An npm
  install under Homebrew's Node (`/opt/homebrew/lib/node_modules`) is no
  longer mistaken for a Homebrew install. Installs of `@bastra-recall/daemon`
  update as before. Coming from 1.1.8 or older with `npm install -g
  bastra-recall`: the old version still runs the update, so run
  `npm install -g bastra-recall@latest` once, then `bastra update`.
- Under the user's own `deny` rule an archiving `rm` no longer gets an allow,
  a rewrite or "No confirmation needed"; it keeps the STOP and one line naming
  the rule. Thanks to @zzallirog (#650, #1362).
- With the archive opt-in on, a destructive command from a hook registration
  without a client marker now says why it stops and how to add the marker. A
  `deny` rule gets no such line (#657, #1362).
- Reading permission rules from a repository settings file can no longer hang
  the Bash hook: no regex for globs, no FIFOs, no files over 1 MB.
- The memory browser's reader no longer shows a memory's old text after it
  changed with the vault total unchanged, also after reopening; a late answer
  for the old version never overwrites the new one (#1449).
- Saving and editing now always say whether a rule applies, is only proposed,
  is inactive or is a note. A user-directed note turned into a rule applies at
  once, overwrites keep the stored user origin, and obsolete or superseded
  rules are reported as inactive (#1384, #1385, #1392, #1395, #1398, #1399).
  A later binding write drops the superseded proposal, and a private
  declaration is reported as bound, not delivered (#1386, #1393, #1394).
- `rulebook_check` answers from the catalog of the session's rule index, and
  an over-long `not_applicable` ID no longer discards the whole check (#1364,
  #1374, #1397). GitHub rules that must be loaded are bound to the current
  action and catalog and still arrive after the denial budget; ordinary note
  advice comes once per session (#1372, #1377, #1391, #1396).
- Stop hook: no save suggestion after a save or edit in the same round,
  answered suggestions are booked, compact summaries are not read as user
  turns, and a continuation needs evidence from the current round and shows no
  error notice (#1365, #1370, #1373, #1376, #1390). Large context sections are
  evicted within a bound and protected overflow is kept (#1363).
- Tasks: board sessions stay valid for the daemon's lifetime, and a full
  session table gives way to the session that has been idle longest (at least
  10 minutes) (#1410). Cold archived tasks can be deleted explicitly (#1408).
  Metadata traversal is bounded (#1423), failed action and session refreshes
  recover (#1219), and areas without enrolled ownership are reported (#1321).
- Settings: a draft with invalid JSON blocks stale saves and keeps its
  restart hint (#1407); an unreadable settings database is no longer treated
  as missing (#1418); the assistant address reads migrated settings (#1417).
- Old assistant address launchers are migrated on first start (#1335), and a
  normal browser load of the local address no longer gets 403 or 503.
- A cloud placeholder that cannot be read is reported instead of skipped
  (#1242). Code-graph diffs handle tab suffixes in headerless paths (#1250).
- Hook timeout telemetry is written before the client exits (#1433), and a
  timed-out background status request is aborted (#1402).
- The injected personality block is removed from stored text like the other
  injected blocks.
- The skill's description is quoted as valid YAML.

## [1.1.8] — 2026-10-31

### Added

- A vault-backed rulebook with complete always-on rule bodies within explicit
  budgets, a paginated description catalog (`list_rules`) and per-round
  `rulebook_check` declarations. Rule IDs, revisions, scope, overflow and missing
  evidence stay visible; bounded action/Stop checks on supported hook hosts do
  not claim semantic compliance or the unmeasured 99.9% reliability target
  (#1276, #1336, #1340).
- Correspondence workflow stages are explicit agent self-reports through
  `rulebook_check.task`: translate-only, draft-for-review, approved-copy or none.
  Bastra does not recognize approval or change stages from the user's words,
  recall hits or draft formatting. The self-report may be wrong and is not
  evidence of user approval or permission to send; Bastra sends nothing itself.
  Applicable validators check fences and quotes in every stage. Ordinary prose
  is measured only in reported approved-copy, in the last assistant text.
  Unmarked long final prose without that report remains unmeasured (#1351).
  Receipts remain task/generation-bound, not byte-exact delivered-text evidence
  (#1325). After repair requests only new output is checked; each new user round
  requires fresh applicability decisions. Legacy session states remain readable.
  (#1306, #1309, #1310, #1311, #1323, #1340, #1341).
- Codex gate/fork registration, a source-backed host/runtime capability matrix,
  generated AGENTS.md/CLAUDE.md startup instructions with separate consent,
  deterministic convention replay in CI and `bastra logs --conventions`
  evidence readout. Existing installations must rerun their client installer
  to register new hooks; unsupported hosts retain advisory behavior
  (#1302–#1305, #1312–#1314).
- References such as “like last time” force retrieval; missing matching rules
  are reported. Repeated corrections can trigger a save reminder, and the
  curator can propose reflex mode for user-directed frustration memories;
  promotion requires user confirmation (#1307, #1308).
- Remote MCP over Streamable HTTP at `/api/v1/mcp`, OAuth 2.1 login and a
  remote-access guide (#1279). Assistant name and local browser-address setup
  include guarded recovery and update/uninstall handling (#1332).
- Opt-in Windows Task Scheduler autostart/supervision, Windows client-path
  handling and hook-stub build/registration preparation. Native Windows hook
  execution remains unverified (#1268–#1270).
- English language support for the Ember, classic and orbital status panels.
- `bastra doctor --replay` shadows your own Claude prompts against the running
  daemon without live-learning side effects (#702). Experimental code awareness
  adds opt-in test coverage maps, evidence-ranked dependents, visible refresh
  failures and corrected delivery/refresh telemetry (#629, #637, #665, #1148).
- Generated OpenAPI route documentation and a curator demand-gap report
  (#13, #1258).

### Fixed

- Codex CLI 0.166.0 joins the exact-version Gate/Stop allowlist after isolated
  native deny/control/retry and Stop-continuation probes. Other unlisted versions
  remain preparation-only; fork on 0.166.0 and patch/MCP write denial remain
  uncertified. Existing live hook registrations are not changed automatically.

- Mindspace pauses rendering in hidden tabs, reduces settled-cloud redraws,
  reuses depth-sort storage and skips offscreen nodes/edges while preserving
  bounds, stable depth ties and wake-up behavior (#324, #1260).
- Foreign stale hooks recommend the matching client reinstall instead of a
  checkout build that cannot update their registered path. Hook compilation
  uses sibling temporary output and publishes by atomic rename only after
  successful checks, preserving the old binary on failure (#1354, #1355).
- Hook builds with an explicit output path create missing parent directories;
  interrupted sibling staging directories stay out of Git (#1359).
- Source-checkout updates now refuse stale compiled hooks or embedded statuslines;
  `npm run build:deploy` builds and verifies both, and release CI verifies the
  native hook before uploading artifacts (#1346).
- Claude live panels no longer count PreToolUse hook denials as failed Recall
  calls; genuine MCP errors remain visible (#1345).
- Copy checks retain explicit fences and quotes before later tool calls and
  measure prose only in the last text of reported approved-copy. Translation,
  review and task end are agent reports, with no user-word classification,
  draft-presentation heuristic or task cue lexicon. New-output repair windows
  and the existing source/actor/round safeguards remain in force.
- Context loss rearms reflex denials, and action-rule non-applicability
  exceptions expire at the next user round (#1347, #1348).
- A fully loaded current rule revision remains usable for action-load checks
  within its context; compact/clear/fork invalidates that evidence. Invalid
  `rulebook_check.task` values reject only the task update while preserving
  valid rule declarations from the same call (#1343).
- Rulebook checks preserve user provenance, current exceptions and rule-source
  integrity. Agent-generated draft quotes do not become user instructions;
  pasted own-user text retains its origin. Stage reports clear legacy channel selection and choose no new channel;
  all applicable validators remain conservative. Deletion approval comes
  from the current user action, not quoted or model-provided authority (#1336, #1338, #1341, #1342).
- GitHub mutations load applicable saved issue/PR conventions at action time,
  with current revisions, bounded delivery and explicit exceptions (#1330).
- Assistant address recovery preserves partial state, owns both loopback
  listeners and publishes usable runtime state before exposing its launcher
  (#1332). Remaining process-bound and migration work is tracked in #1335.
- Updating preserves managed LaunchAgent environment variables and task opt-ins,
  snapshots the prior plist and avoids treating Ember's panel feed as Bastra's
  own statusline. Windows updates preserve daemon lifecycle (#1273, #1326,
  #1327, #1329). Commissioned notify reminders are armed across supported agent
  creation paths when the task preview is enabled (#1331).
- Search includes indexed stems for previously unindexed query words; code-graph
  diff handling recognizes Git-quoted paths and pure renames (#1194, #1246).
- npm packaging rebuilds compiled output and required workspace dependencies
  before packing, refusing publication after a failed build.

### Security

- OAuth public routes use an explicit allowlist; bootstrap and staged metadata
  reads use guarded file descriptors, and session paths are bounded (#1279,
  #1337). Runtime and development dependencies were refreshed; the remaining
  development MCPB audit exposure is documented rather than claimed fixed.
- Session-context framing no longer uses a backtracking regular expression, and
  caller-supplied dismissal and session IDs in rulebook audit rows are capped
  at 200 characters.

## [1.1.1] — 2026-10-17

### Security

- Hook hint wrappers escape external attribute values and protect header boundaries, so injected metadata cannot break out of the hint block (#1232, #1233, #1235).
- Task file-source and evidence reads reject non-regular files without blocking and bind the opened source on macOS/Linux, preventing parent-symlink swaps from reading outside a registered root (CodeQL #109). File-source observation deliberately rejects multiple hardlinks; own rollback backups retain hardlink support and work through symlinked data-directory aliases. Windows and other POSIX platforms retain their available nonblocking/regular-file and path checks without equivalent descriptor containment.

### Added

**Opt-in preview only, off by default until v1.2.0.** The task capabilities below require `BASTRA_TASKS=1`; they are not enabled by this upgrade.

- Explicit persisted tasks with one MCP/HTTP/CLI/UI contract, owner review,
  calendar/duration/recurrence, authenticated versioned source events, startup/contact
  catch-up and bounded daemon polling. Due cards are independent of recall ranking;
  attempted delivery, acknowledgement and completion stay separate. Versioned premise
  changes invite owner reconsideration without automatically reversing a decision.
- Optional task UI, readable German CLI with explicit `--json`, owner hook setup,
  source/budget/unknown-outcome status, mute/off/execute-stop, guarded target management,
  private cold archives and explicit fail-closed backup/lock recovery. Ordinary memory
  schema remains unchanged.
- One reversible local-artifact UTF-8 replacement adapter: separate exact Ed25519
  owner signatures for every required domain, revision/expiry/revocation checks,
  local leases/fencing, durable approval spending and intent before effects,
  exact-hash crash reconciliation and newly approved CAS rollback. No provider,
  messaging, email, Slack, GitHub, cloud or arbitrary shell adapters. Production
  execution requires actual owner/agent OS isolation; synthetic tests do not prove it.
- Disposable owner demo, final fourteen-case functional matrix and EN/DE instructions.
  Functional results are separate from pending longitudinal confirmation.


### Fixed

- CI now builds and tests on Node 22, 24 and 26. Node 22 to 26 are supported; Homebrew installs, which follow the newest Node, already run on 26. Support for Node 22 is planned to end in early 2027 with the next major release, before its upstream end of life on 2027-04-30.
- Release documentation guard: stable version bumps update both README release lines; tests and publishing verify README/package/changelog agreement. Prereleases retain the stable README announcement and do not require a matching changelog section. Real publishing requires an explicit EN/DE Wiki-update confirmation. README and user guides are refreshed for 1.1.1; the EN/DE Wiki update is prepared separately for publication after review.
- Proactive tasks ship as an **opt-in preview, off by default until v1.2.0** (#1238). Set `BASTRA_TASKS=1` in daemon and clients/hooks and restart them to restore notify reminders, automatic local Agent access and the Recall UI Tasks tab. Without opt-in there is no task runtime, task I/O, task tools or task UI/session API; existing data stays untouched. Existing prepare/execute approval remains unchanged pending further Owner discussion.
- Targeted searches for an old value keep both versions visible: retrieved successors inherit the predecessor's relevance and rank immediately ahead, including chains and batch merges. Predecessors retain their scores; direct and hop lanes remain separate (#1206, #1229).
- Saving retries a vanished claim-preparation directory on macOS EINVAL once, then reports a write conflict instead of leaking a filesystem error.
- Stop-hook and watcher triggers skip code-graph extraction when the source tree is already covered; thanks @zzallirog (#1228). Freshness checks detect renamed/replaced source paths and preserved-mtime size changes through a file-state signature. Successful builds record their start time; changes during a build or freshness check retain their promised follow-up. Old manifests rebuild once.
- Resumed Claude sessions resolve terminal width, tty and feed PID independently for each parent process. Git versions before 2.17 retry status without `--ahead-behind`.
- Repeated word-form checks reuse bounded Unicode normalization results without changing the accepted affix families.
- Bridge minting recognizes legacy Unicode IDs and preserves their evidence, age, demotion and archive state instead of creating duplicates after an upgrade.
- Path-lock takeover preserves successor leases and bounds stale-owner recovery (#1223). Saving publishes complete commit claims and recovers abandoned claims without letting concurrent writers commit the same target (#1221, #1203).

- On Linux, code-awareness watches only eligible directories, skipping ignored trees before allocating inotify watches. The ignored-directory list is shared with the source scanner, including virtual environments, Rust targets, vendor and coverage trees. New directories are discovered, removed trees release their watches, and freed capacity allows registration again after watch-limit exhaustion without stopping other refresh triggers. macOS keeps FSEvents; thanks @zzallirog (#1079).

- Reflex triggers and `acted_on` recognize supported inflected word forms using closed affix families; unrelated lookalikes such as `delete`/`delegate` and `backup`/`backdoor` stay distinct. Original implementation by @zzallirog, with conservative matching follow-up (Refs #1190, #1191).
- Word search segments supported spaceless scripts through Node/ICU on both index and query sides; mixed identifiers retain their whole term and components with additional segments (#1214 follow-up); thanks @zzallirog (#1189).
- Lexical comparisons share Unicode/case folding, with non-Latin in-word apostrophe boundaries aligned and folded bridge aliases counted once before overlap checks and expansion caps (#1215 follow-up); thanks @zzallirog (#1193).
- Bash-fail reads status only from structured fields or the official error/Codex header, caps repeated memory hints per session and skips leading `cd`/`pushd` in the recall query; thanks @zzallirog (#1152).
- Statusline installation and updates preserve a user-chosen refresh interval (default remains 1s). Each tick gets Git status and ahead/behind counts from one fresh status query, while the parent PID is reused across ticks of the same process ancestry. Thanks @zzallirog for the measurements and analysis (#1227).
- Without fusion, wired prompt-recall hits outside recognized lookups require a strong trigger anchor; fused recall and literal reflex remain unchanged; thanks @zzallirog (#1188).


## [1.1.0] — 2026-10-11

### Security

- The pending suggestion relay now redacts recognizable credentials with the
  draft filter before storage and delivery, including legacy rows on ordinary
  writes, and uses 0600 files. Vault comparisons still see original quotes;
  provisional withdrawals retain caller identity. No schema migration runs
  (Refs #513, #675, #1084).
  Existing relay files that cannot be read or parsed as a JSON array are
  preserved: the write is skipped with a text-free warning. Only a missing
  file starts an empty relay.
- Upgrade `proxy-addr` to 2.0.8 (GHSA-jqcg-44mw-7w3h) and override the
  repository's YAML CLI dependency `argparse` to 2.0.1, removing `sprintf-js`
  (GHSA-hp3w-g68c-fv3c) from the workspace lockfile. The frontmatter parser
  stays on `gray-matter` 4.0.3 / `js-yaml` 3.15.2; existing fixture
  roundtrips serialize identically. This root override applies to repository
  installs, not to consumers' independently resolved dependency trees.
  The development-only MCPB dependency still contains the unpatched
  `node-forge` advisory GHSA-86w9-cpqp-85rv; see the
  [reachability assessment](docs/security-alerts-2026-10.md).

### Added

- SessionStart can show up to three secret-redacted local draft candidates for
  agent review, once per vault, with injection filtering and the three checks
  for correctness, durability and existing notes. `review_draft` records a
  confirmation without saving/promoting, or rejects with the existing retained
  fingerprint marker. Review metadata does not gate promotion; the old quote
  block stays on, suppressing only same-start duplicates. All three draft/relay
  off switches disable the new presentation path. Text-free review telemetry
  and complete EN/DE privacy, usage and hook guidance are included (Refs #157,
  steps 1–2 only). Confirmation/rejection/uncertainty advice shares one
  canonical EN/DE rule across tool, block and skills. Candidate verdicts now
  follow the latest completed local pass; obsolete verdicts are removed without
  clearing prior answers.

- `BASTRA_PENDING_RELAY=0` disables every shared suggestion-relay writer and
  SessionStart delivery without reading or deleting retained entries. Explicit
  `bastra drafts purge` now clears the relay as well as drafts, vectors and
  decision receipts, preserving unreadable/invalid relay files and using the
  same cross-process lock and private 0600 writes as the daemon.
  Busy hook reads skip immediately; Stop writes defer contention to the daemon
  background instead of waiting or writing without a lock. Purge validates the
  relay before deleting drafts, accepts an empty file and marks a missing relay
  as absent.

- **Local drafts capture unsaved context automatically** (#1084) while the
  after-session harvest is enabled. Typed turns passing the noise filter
  (at least 20 letters, fewer than 2,000 characters) enter a secret-redacted
  local store outside the vault (0600, 500 rows / 1 MiB). Recall can show a
  separate unconfirmed hint band; `BASTRA_DRAFT_HINTS=0` disables that band,
  `BASTRA_SESSION_HARVEST=0` disables capture and the background tick.
  Automatic note promotion stays off unless exactly `BASTRA_DRAFT_PROMOTE=1`.
  A local meaning check can still run in the default dry run. Capture/rarity
  thresholds and 7-day single-evidence expiry are unmeasured on real use;
  other open drafts expire after 30 days, closed records after 180. See the
  [draft workflow](docs/hooks.md#local-drafts-1084) and
  [privacy boundaries](docs/PRIVACY.md#local-drafts).
- **Reviewed-miss harvester, an offline repository tool** (#454). It reads
  recorded session/telemetry evidence, classifies missed recall opportunities
  and produces a review queue and cue proposals. It calls no model, uploads
  nothing, never writes to the vault and applies no proposal automatically.
  The script/modules are excluded from the published npm package. See the
  [guide](docs/reviewed-miss-harvester.md).
- **Save notices for Codex.** After confirmed save/edit tools, a PostToolUse
  hook supplies a short line with a plain prefix by default. Re-run
  `bastra install codex` and trust the write-tool entry in `/hooks`.
  `BASTRA_SAVE_NOTICE=0` disables the notice; colour is an explicit opt-in.
  Calls and hook envelopes were checked with Codex CLI 0.160.0, but interactive
  appearance and colour remain visually unverified. See the
  [compatibility and setup guide](docs/codex-save-notice.md) (Refs #1094).
- **Terminal panels for Claude Code and Codex**, started manually with
  `bastra-codex-statusline --cmux` or `bastra-recall-panel --cmux`.
  The Codex Powerline panel binds to an explicit session and shows reported
  usage/context and Recall activity; paginated-only histories are unsupported.
  The Neural Console offers `classic`, `orbital` (default) and `ember` designs,
  session/pane following and a Claude statusline feed. Missing measurements
  stay unavailable; demo data is labeled. Panels read local transcripts/feed
  metadata and do not send messages or resume sessions. See
  [panel details](packages/statusline/README.md#experimental-neural-console).
- Complete German statusline and terminal-panel user guide alongside English
  in the packaged README, linked from both README and usage-guide languages.
  Both versions clarify the cloud of small dots representing the vault, changing idle values,
  selected demo design and known ahead/behind-arrow limitation (#1135);
  panel code is unchanged.
- **Training signal capture, a temporary tool for #1128.** Step 0 of the
  local fine-tuning evaluation needs data the daemon did not keep. Without any
  switch, the local event log gains ids, hashes and ranks only, never text:
  each `candidate_pool` entry of `recall` / `hook_recall` carries a
  `content_hash` of the note (an HMAC keyed with a secret that stays on the
  machine, `training-signal.key` beside the log) and its rank in the keyword
  and the vector arm; `load_memory` names the recall that delivered the note to
  the same caller session (`from_recall`, `recall_rank`; without a certain
  match it stays empty and the time-window link `follows_recall` is the
  fallback it was); rows written by
  a measurement run carry `eval_run: true` (`client: "eval"` or
  `BASTRA_EVAL_RUN=1`); and `bastra bridges harvest` writes one
  `rerank_verdict` row per judged question. With `BASTRA_TRAINING_CAPTURE=1`
  (off by default) the daemon also keeps the texts its draft check judges,
  with the verdicts, in `training-capture.jsonl` beside the event log (0600,
  never in the vault, never sent anywhere, not touched by log retention), and
  asks the local model about every new draft in shadow, with no effect on
  which drafts become notes. Private notes never reach that file. The whole
  feature will be removed once #1128 no longer needs it. See
  [training signal capture](docs/training-capture.md).
- **Save notice in Claude Code.** After `save_memory`, `edit_memory`,
  `save_document` and `save_product_doc` Recall prints one line under the
  collapsed "Called bastra-recall": the action, the title, the type and, where
  it fits, the first `recall_when` cue or what the edit changed — in
  `language.primary`, opening with the product name on the brand colour. A
  refused call gets no line; a save held at the claim gate or turned into a
  conflict mark says so instead of "saved". It is a `PostToolUse` entry on the
  existing post-tool client, so `bastra install claude-code` has to run once
  to register it (`bastra doctor` reports the missing registration until
  then). `BASTRA_SAVE_NOTICE=0` turns it off. Telemetry: `save_notice_call`.
- **Model recommendations for existing installs.** A release can now carry a
  recommendation for the local text model (per hardware tier, with download
  size and what gets better). Nothing switches on its own, not in
  `update.mode auto` either: `bastra update` asks at the end, the session start
  lets the agent ask, the first command on a terminal after an update asks once
  (an updater from before this feature cannot), and a dim line follows CLI
  commands normally once a day — until you answer with `bastra models switch`,
  `later` (asked again in 7 days) or `dismiss` (not for this recommendation;
  the notice says what that costs). The commands name the recommendation they
  answer, and an answer to a different one is refused. The switch pulls the
  model, checks it with a short local test call and only then stores model and
  answer in one write; the old model stays installed. New installs are offered the recommended model directly.
  `BASTRA_UPDATE_CHECK=off` silences the notice as well. This release carries
  the first recommendation (`2026-10-tev1`): `tev1:4b` (4.5 GB download) on
  machines with 16 GB to under 32 GB of RAM, `gemma4:12b` (8.1 GB) from 32 GB,
  none below 16 GB. It reaches installs that use a local text model outside
  that set, and rests on the
  [local model comparison](docs/local-model-comparison.md).
  Existing users of either recommended model are not prompted to switch
  between them. The notice distinguishes similar draft-check/reranker answer
  times from slower, less consistent keyword expansion. Parallel CLI commands
  share the daily model claim without waiting; simultaneous reclaim of an
  orphaned day lock can rarely duplicate the line. Fresh or unwritable locks
  silently skip that hint, while the other notice surfaces remain independent.
  Listed model tags are matched case-insensitively, including `-` suffixes;
  bare names, `:latest` and other sizes remain distinct.
- **New installs are offered `tev1:4b` as the local text model** from 16 GB of
  RAM (4.5 GB download); `gemma4:12b` stays the alternative from 24 GB and the
  suggestion from 32 GB. Existing installs are not switched: without a stored
  choice the daemon keeps running `gemma3:4b` until you answer the
  recommendation above with `switch`.

### Fixed

- On macOS the MCP forwarder gives an installed managed autostart service up
  to ten seconds before fallback spawn, without a new user setting. Headless
  service starters wait for a forwarder-owned port before opening storage,
  retrying with intervals capped at thirty seconds. Client daemons still idle
  exit even with a registered LaunchAgent, allowing the service to take over.
  No shutdown handshake; Linux managed setup remains tracked in #566 (Refs #758).

- The model recommendation at SessionStart normally appears in one prepared
  hook response per user and UTC day, shared across Claude Code and Codex.
  A separate day marker keeps the CLI line independent; busy or inaccessible locks skip
  silently without queueing, and skipped blocks do not spend the day. An aged
  lease is reclaimed in one non-waiting attempt, with the day marker checked
  under the lock. Simultaneous session starts reclaiming an orphaned lock can
  rarely show the notice twice on the same day (#1153).

- Terminal panels show Git ahead/behind arrows only for positive counts.
  Missing behind arrows do not claim the remote is current; the panel still
  never fetches or accesses the network (#1135).

- The daily CLI model hint reclaims a day lock older than ten seconds in a
  single silent attempt, so an interrupted command cannot suppress it forever.
  Fresh or unwritable locks still skip the hint without waiting; other
  advisory claims retain their existing policy.
- **Release verification waits for the complete npm set in one window** (#1076).
  `--verify` polls only unfinished packages for up to five minutes, with a
  growing pause capped at 30 seconds, instead of giving each package a short
  fixed slot. Registry reads share that deadline; late-visible manifests still
  have to match the release. On expiry it lists every unfinished package.
  Verification never publishes; publishing order and asset checks are unchanged.

- Codex doctor keeps healthy recall hooks enabled when only the newer
  save-notice registration is missing, and reports a specific reinstall hint
  instead of calling the installation broken (Refs #1094).
- Code awareness retries busy build locks with growing waits and pauses after
  six retries instead of looping forever, then tries at most once per hour
  until a successful build restores normal refreshes (Refs #670). CRLF diffs now expose changed lines (Refs #605), and declared
  function anchors resolve with or without Graphify's `()` suffix (Refs #594).
- Code-awareness telemetry uses delivery records for both headline block count
  and token cost, labels the passive code share as a share of Write/Edit
  injection, and excludes lock checks/skipped runs from build duration
  (Refs #663, #665). No event schema or historical data is changed.
- Draft secret redaction recognizes the network command/field forms listed in
  #1113: nmcli/networksetup/netsh, WiFi.begin/WIFI_PSK literals, vendor PSK
  configuration, PSK binding variants/XML/string arrays, Wi-Fi QR passwords,
  attached curl auth bundles and HTTPie auth. The frozen corpus adds 17
  positive/negative pairs. Only the named scalar grammars are recognized, with
  no arbitrary shell/C evaluation: unquoted `WiFi.begin` password values and
  other vendor grammars can remain readable. See the
  [coverage and limits](docs/secret-redaction.md) (Refs #1113).
- Claude Code doctor keeps healthy recall hooks enabled when only the new
  save-notice registration is missing, reports that entry separately and points
  to `bastra install claude-code`. Missing required recall hooks and malformed
  settings still need repair (Refs #1094).
- **A settings file that cannot be read is no longer written over — a
  behaviour change for every command that stores a setting** (`bastra config
  set`, `embeddings on|off`, `models set`, `token`, the installer, the
  daemon's own setters). With `~/.bastra/cli-settings.json` present but
  unreadable (wrong permissions, a transient I/O error), they used to replace
  it with defaults plus the one changed value. They now read the file once,
  change exactly what they read, and stop with "the settings file exists but
  cannot be read" when that read failed. Reading settings is unchanged.

## [1.0.1] — 2026-10-04

### Added

- **Archive limits** (#934). `bastra config set archive.cap <size>` sets what
  the whole archive may hold (default 10 GB; env `BASTRA_ARCHIVE_CAP` wins);
  the eviction order is unchanged. `bastra config set archive.max-item <size>`
  sets the largest target the archiving `rm` takes (default: none; env
  `BASTRA_ARCHIVE_MAX_ITEM` wins): a larger target is neither archived nor
  deleted, `rm` refuses and names the limit, `/bin/rm` and the setting.
  `bastra doctor` shows both values while the archive is on.

- **`/health` reports `config_fingerprint`, and `bastra doctor` flags a daemon
  whose config differs** (#719). The fingerprint covers the daemon's `BASTRA_*`
  behaviour settings, without client-only keys, paths, the endpoint and
  secrets. Doctor compares it with the configured state — the `daemon.env`
  pins in `cli-settings.json`, plus on macOS the managed LaunchAgent's env —
  and prints a warning under "daemon origin" on a mismatch. The exit code does
  not change.

- **Query router, shadow first** (#362). `routeQueryArms` (core) marks short
  (≤ 2 words, Unicode word segmentation) and identifier-shaped queries as
  BM25-only; everything else stays hybrid. Structural, no word list.
  `BASTRA_QUERY_ROUTER` defaulted to `shadow` here (now `live`, see
  Changed): the hook pipeline records
  `query_route` with `would_save_ms` on `hook_recall` and changes nothing;
  `live` skips the dense arm for routed queries. New harness
  `npm run router-lift` (eval) runs gold-set run A as baseline, routed and
  control arms: 17 of 699 queries routed, no metric below the baseline
  (recall@3 0.3904 → 0.3938, relevant_loss 78 → 77 of 365), routed queries
  p50 14.8 → 5.8 ms. The prompt lane's p90 tail comes from long prompts,
  which the router leaves hybrid, so it is unchanged.

- **One recall pipeline for hooks and MCP** (#421). A client without hooks
  now gets the same selection steps as a hook user
  (`packages/daemon/src/recall-pipeline.ts`): MCP `recall` returns
  `reflex_hits` (user-wired `recall_mode: reflex` memories below the top-k
  cut) on the forwarder and the stdio server, and runs the prompt lane's
  project scope filter with the caller's project. The filter follows
  `BASTRA_SCOPE_FILTER_LANES` — `shadow` by default, so hits do not change
  and the `recall`/`hook_recall` row records `dropped_scope_count`; an
  explicit `scope` argument skips it. Hook lanes are unchanged. The remaining
  gaps (evidence gate on the stdio/REST path, GET session context) are
  listed on #421.

- **Dense-weighted fusion, opt-in** (#641). On LongMemEval-S the dense arm
  alone ranks the gold session first more often than the equal-weight RRF
  (83.8% vs 79.6% R@1, 500 questions): BM25 puts a distractor at rank 1 that
  the dense arm ranks 2nd or 3rd, and equal weights hand it rank 1.
  `BASTRA_RRF_VECTOR_WEIGHT=<w>` weights the dense arm (default `1`, the
  shipped fusion, unchanged). At `1.5`: LongMemEval-S R@1 79.6% → 83.2%
  (27 gained / 9 lost, p = 0.004), R@5 98.2% unchanged; gold-set run A keeps
  both M1 gates (relevant_loss 0.2137 → 0.2301 ≤ 0.24, false abstention 0).
  `2` gains more on LongMemEval (84.8%) but breaks false abstention on the
  gold set. The default became `1.5` by owner decision (see Changed).
  `longmemeval-run` records the weight, and a weight other than `1` enters
  the gold-set config hash.

- **Client memory folders reach the vault** (#674; data from @zzallirog,
  #701). `bastra doctor` lists every Claude Code
  (`~/.claude/projects/*/memory`) and Codex (`~/.codex/memories`) memory
  folder that holds notes and how many are not in the vault yet;
  `bastra import clients [--dry-run]` imports each through the folder import
  (Claude Code adapter, audit trail, idempotent re-runs) under its own label.

- **After-session harvest** (#675; data from @zzallirog, #701). The Stop hook
  books each session; a daemon job reads the transcript once the session has
  been quiet for 30 minutes and relays up to three things the user said and
  the session did not save — restated requests, the turn after an
  interruption, answers to the agent's questions — as verbatim quotes in a
  `<session-harvest>` block through the pending relay (#513). Structural and
  language-neutral; it never writes to the vault. Telemetry
  `session_harvest`; off with `BASTRA_SESSION_HARVEST=0`.

- **`bastra reconcile` finds the copies of a vault** (#339). Without a path
  it lists the stores it finds: vault paths in the client registrations
  (Claude Code incl. per-project, Claude Desktop, Cursor, Codex) and
  `BASTRA_VAULT_PATH` — where a forwarder-spawned daemon writes —, symlinks
  onto a store, and folders with a bastra audit log in sync folders (iCloud,
  `~/Library/CloudStorage`, Dropbox, OneDrive, Google Drive, …) whose log
  shares history with this vault. With exactly one other copy it prints the
  dry run against it. Read-only; `--yes` still needs the path.

- **After-session harvest: SessionEnd, vault check, save rate** (#675).
  `bastra install` registers Claude Code's `SessionEnd` hook with the Stop
  hook (same client and route); a finished session is harvested on the next
  pass instead of after 30 quiet minutes. Codex keeps the idle rule: a Codex
  build without `SessionEnd` would reject the whole `hooks.json`. Each pick is
  checked against the vault first (BM25 candidates, IDF-weighted word
  containment ≥ 0.7, no stopword list) and dropped when a memory already says
  it. `bastra logs --stats` prints a "session harvest" line: sessions read,
  quotes relayed and already stored, and how many sessions that got a
  harvest block saved afterwards (joined on `caller_session`).

- **Save suggestions reach the session that produced them** (#662; data from
  @zzallirog, #701). The Stop lane used to park every suggestion for the next
  session start, where neither the conversation nor the body was left to
  save. In Claude Code it now returns the suggestion as
  `hookSpecificOutput.additionalContext` (`<save-eval-now>`), which the agent
  reads in the same turn as "Stop hook feedback". Once per heuristic per
  session; `stop_hook_active` keeps it from looping. Codex, payloads without a
  session id and `BASTRA_STOP_SAME_TURN=0` keep the pending relay.
  `save_eval_call` gains `delivery` (`same-turn` / `pending` /
  `already-delivered`). The save rate is measured with the #708
  `caller_session` join.

- **Battery mode** (#632, opt-in). `bastra config set battery.saver on` (or
  `BASTRA_BATTERY_SAVER=1`): the daemon reads `pmset -g batt` once a minute,
  and while the Mac runs on battery the doc2query paraphraser and its
  catch-up round wait for AC, boot/turn/session warm-ups of the embedding
  model are skipped (`skipped-battery`), and the idle unload fires after
  60 s instead of 10 min. Explicit recalls keep the vector arm. Not macOS or
  an unreadable reading behaves like AC. `/health` has a `power` block and
  `bastra doctor` a "battery saver" row. Hook lanes are not switched to
  BM25-only on battery (not part of this change).
- **`bastra reconcile <other-store>`: which copy of a vault is ahead** (#339,
  core of it; comparison design after @zzallirog's reviewed patch). Compares
  two stores of the same vault memory by memory, joined by the frontmatter
  `id`. "Same" means the same authored content — body without the
  auto-related block, wrapping collapsed, wikilinks in one spelling,
  frontmatter without generated fields — so a daemon-enriched copy no longer
  looks different. The direction comes from the audit logs (the side with
  recorded writes the other lacks), not from mtime; writes on both sides,
  unrecorded changes, one-sided deletes and duplicate ids are listed as
  conflicts and never resolved. Dry run by default; `--yes` copies the
  unambiguous cases, backs up every overwritten file under
  `.bastra/reconcile-backup/<time>/`, skips files that changed since the plan
  and carries the copied memory's audit entries along. Store discovery is not
  part of it yet.
- **Guard test against new language-bound matchers** (#679, part of #676).
  `packages/daemon/__tests__/language-bound-matchers.test.ts` scans daemon
  and core sources for language-named lists (`*_DE`, `*_CUES`, `*STOPWORDS`
  …), language-keyed word lists, case-insensitive word alternations and
  `a-z`+umlaut tokenizers. Every finding must be on an allowlist with an issue
  reference (today's places: #707, #677, #676, plus detector false
  positives); an allowlisted place that is gone fails the test until its line
  is removed, so the list only shrinks. Newly found and filed under #707:
  save-similarity, todo-lane, tool-handlers and taxonomy stopword/tokenizer
  lists and the save-quality admission regexes.
- **Learned bridges have a way down** (#129, part of it; data from
  @zzallirog, #701). A bridge (confirmed ones too) with 20 or more fires in 30
  days and no load or acted-on episode after any recall it expanded is
  demoted: it keeps its evidence but widens queries only at unconfirmed
  weight. An outcome restores it; another 30 days of fires without one move it
  to `bridges/archive/` (reversible, logged in `bridges/archive/log.jsonl`),
  and the mint does not write it back. `bastra doctor` shows demotions and
  archives under "learned bridges". New bridge field `demoted_at` is optional;
  old files load unchanged. The held-out lift gate #129 asks for before
  contribution is still open.

- **git acts that lose work are snapshotted first** (#650 follow-up, #691;
  design and implementation by @zzallirog — PR #692 is the design doc;
  opt-in, see the archiving `rm` below). With the opt-in on, a Claude Code
  command made only of `git clean -f`, `reset --hard`, `checkout [<tree>] --
  <paths>`, `restore`, `branch -D`, `stash drop|clear` (plus `cd`, `rm`) runs
  through bastra's `shims/git`: clean moves its files into the archive, the
  others pin what they discard under `refs/bastra-archive/` and then run as
  typed; an untracked file the act would overwrite goes into the archive
  first. The receipt names each pin and its restore command; `bastra archive
  restore <ref>`. Refused where the repository would run its own code on
  the act, or where no snapshot can hold what it discards. The pins show up
  in `git log --all` (and a `git push --mirror` would publish them) until
  they expire. With the opt-in on, `BASTRA_GIT_SHIM=0` leaves only this part
  out.
- Tripwire rows: `git checkout <tree> -- <paths>` and `git restore
  --source=<tree>` / `--staged --worktree` (they write the index too, and
  overwrite untracked files). A flag in front no longer hides an act from
  its row: `git checkout -q -- <paths>`, `git reset -q --hard`, `git branch
  -q -D`, and `git branch -d -f` / `--delete --force`.
- **`rm` in Claude Code's Bash can be an archive, not a loss** (#650) —
  design and implementation by @zzallirog (PRs #689, #690 are the design
  docs; landed via #696 as a squash, so his commits are not in `main`'s history) —
  **opt-in, off by default**: `bastra config set archive.enabled on`, or
  `BASTRA_RM_ARCHIVES=1` in the daemon's environment (env wins; `0` forces
  it off). Only for hook calls that carry Claude Code's client marker (see
  Changed). Off, `rm -r` and the git acts get exactly the hint they got
  before: nothing is rewritten, nothing allowed. With it on, an rm-only
  command runs through bastra's archiving `rm`: the bash-pre hook allows it
  and puts `shims/` first in its PATH, targets move to `~/.bastra/archive`
  (temp dirs are really removed, `/`, `~` and system dirs refused), and the
  post hook tells the agent what actually happened and how to restore.
  `bastra archive list|restore|reconcile`; old entries go by class (junk 1 day,
  git-tracked 2, the rest 2; `archive.retain` / `BASTRA_ARCHIVE_RETAIN`;
  10 GB cap; checked hourly). Mixed commands, redirections, rm overrides,
  `sudo`/absolute/remote `rm` keep the STOP. With the opt-in on,
  `BASTRA_RM_SHIM=0` leaves only the `rm` part out; then a command the shim
  would have taken gets one line saying what it would have done (worded
  after the user's own Claude Code permission rules), and a
  `rm_shim_shadow` telemetry event. The rewritten command names node by a
  path that survives `brew upgrade node` (Homebrew's `opt/` link), and the
  shim falls back to `node` on PATH if that path is gone. `bastra doctor`
  lists the opt-in among the intentionally-off features; `bastra install`
  never turns it on. Limits: on a
  full disk `rm` into the archive fails instead of freeing space; a target
  on another volume (USB, network drive) is archived under
  `<mount>/.bastra-archive`, or refused where none can be made. Carried
  over from #689/#690/#692 by @zzallirog.
- **`bastra doctor` shows which features are switched off**, not only which
  registrations are broken. A new `features` section lists, one line each,
  hooks / Stop hook / skill per registered client (including Claude Code's own
  `"disableAllHooks": true`), the memory language (unset means memories are
  written in English), onboarding, semantic recall and reflex memories — every
  off item with the command that turns it on. Features that are off by default
  on purpose (code awareness, the experimental change-impact block, product
  docs, Commons, bridges, the vault map) sit under their own heading as
  intentional. The section never changes the exit code, and `--fix` never
  switches a feature on.
- **`bastra doctor` reports when learned bridges stop learning** (#672). With
  shared recall on, a `learned bridges` note looks at the mint runs of the last
  30 days and warns when none ran, when runs minted candidates but wrote none,
  or when no acted-on recall reached the telemetry log — each with a one-line
  hint. Never changes the exit code.

- **A note can bind the claims it took from a file** (#609). `derived_claims`
  in the frontmatter names, per claim, an `id`, a `source` relative to the
  vault directory and a `resolver`. `load_memory` resolves each one read-only
  and returns the result next to the note under `derived.claims`, also on the
  lean path; the note and the source keep their own bytes. Three resolvers:
  `count.markdown-numbered-list.v1` counts the numbered items of the source and
  compares them with `expect`, the number the note states;
  `quote.v1` looks for `exact`, the string as it stands in the file;
  `sha256.v1` compares the digest of the source with the one the note recorded.
  The verdicts are `matches`, `differs`, `gone` (the quoted string is out of
  the source), `ambiguous` (it stands there more than once, so nothing is
  picked) and `unverifiable` (the source sits outside the vault, behind a
  symlink that leaves it, over 1 MB, is a directory or is missing). Like
  #235's anchor, the check shows a difference and the reader decides. A claim
  without `expect` keeps reporting the observed value on its own. The
  `save_memory` description carries the field and the claim shape, so a model
  that has just read a file declares the claim in the same save call. A note
  without `derived_claims` reads no source. Contributed by @zzallirog (branch
  `feat/derived-claims-609`, cherry-picked with his authorship). On top:
  `sha256.v1` hashes the bytes on disk (equal to `shasum -a 256`), and
  `bastra doctor` gets a `derived claims` note that lists claims out of step
  with their source (`differs`, `gone`, `ambiguous`) and counts the
  unverifiable ones — silent without claims, never changes the exit code.
  A pilot test runs the three resolvers through a daemon started in the test:
  seven notes (one decision note without claims) saved and loaded over
  `/api/v1/save_memory` and `/api/v1/load_memory`, then the sources edited on
  disk — the verdicts move, the decision note gets no `derived` block, and
  no load changes a note or a source.

### Changed

- **Stop hook: the same-turn save suggestion says what it is** (#757). It now
  comes with one line for the user, in their language ("bastra-recall is
  checking whether anything from this conversation is worth remembering —
  nothing for you to do."), and the block for the agent is cut to one
  instruction plus one line per suggestion. Claude Code prints Stop-hook
  feedback in full; there is no agent-only channel.

- **Bridge query expansion runs in shadow by default** (#129, #672, owner
  decision 2026-09-29). With shared recall on, a firing bridge no longer
  widens the query unless `sharedRecall.live` is `true`
  (`bastra bridges live on`). In shadow the ranking is exactly the one without
  bridges, and the fire is still logged: `bridge_expansion` on
  `recall`/`hook_recall` carries the terms it would add with
  `applied: false`; shadow fires do not count toward demotion. Why: on the
  maintainer's log (28.09.) the pooled bridges pushed 100 of 495 near hits
  out of the top 5, and 0 of 47 local bridges pass `bastra bridges verify`.
  `bastra doctor` and `bastra bridges status` show live/shadow; switch live on
  once a bridge passes verify.

- **Query router is live by default** (#362, owner decision 2026-09-29).
  `BASTRA_QUERY_ROUTER` now defaults to `live`: short (≤ 2 words) and
  identifier-shaped hook queries skip the dense arm and are answered
  BM25-only (`score_kind: "bm25"`, `unfused`, no `degraded`); the
  `hook_recall` row carries `query_route` with `applied: true`. Measured on
  gold-set run A (`npm run router-lift`): 17 of 699 queries routed, no
  metric below the baseline, routed queries p50 14.8 → 5.8 ms.
  `BASTRA_QUERY_ROUTER=shadow` restores the v1.0.0 behaviour (record only).

- **Dense-weighted fusion is the default** (#641, owner decision
  2026-09-29). `BASTRA_RRF_VECTOR_WEIGHT` now defaults to `1.5` instead of
  `1`: LongMemEval-S R@1 79.6% → 83.2% (+3.6 pp). Gold-set run A re-measured
  on this branch at the default: relevant_loss 84 of 365 (0.2301 ≤ 0.24),
  false abstention 0, R@1 24.1% → 24.3%. `BASTRA_RRF_VECTOR_WEIGHT=1`
  restores the v1.0.0 equal-weight fusion. Score bands move (a dense-only
  rank 1 scores above 81.967, a BM25-only one below it), and the gold-set
  config hash of a default run changes; the V1.0 baseline registration
  (`v1-baseline.json`) was measured at weight 1 and stays as registered.
  `score_version` is bumped `rrf-1` → `rrf-2`: rank 1 in both arms stays
  163.934, rank 1 in the BM25 arm only is ≈ 65.6, in the vector arm only
  ≈ 98.4 (was 81.967 for either). Compare scores only within one
  `score_version`; the recall tool description, `docs/openapi.yaml`,
  `docs/architecture.md` and `docs/hooks.md` carry the new anchors.

- **Bridges earn contribution on held-out data** (#129).
  `bastra bridges verify [days]` runs a 5-fold check over the candidate-pool
  log: bridges are minted from the other folds and measured on this fold's
  labelled recalls (gold = the acted-on or loaded memory) on the vault's BM25
  index, split into near, far in-pool and far out-of-pool slices, with a
  foreign-expansion null arm. `bastra bridges contribute` now stages only
  bridges that are confirmed, not demoted, measured, with lift ≥ 0 in every
  slice, no near hit pushed out of the top 5 and lift not below the null —
  scrubbed and signed in `~/.bastra/bridges/contribute/<lang>/` for a reviewed
  PR; nothing is pushed automatically. `evidence` counts independent occasions
  (caller session, else day) instead of every repeated reach. On the
  maintainer's log (924 cases) the pooled bridges at contributed weight pushed
  100 of 495 near hits out of the top 5 and gained +0.006 / +0.016 reciprocal
  rank on the far slices; no local bridge passes.

- **The remaining fixed-language matchers are data now** (#707). Duplicate-save
  similarity, todo-lane topics and the acted-on overlap share one per-language
  function-word list (`FUNCTION_WORDS_BY_LANGUAGE`, core `stopwords.ts`); a
  language without a list drops no word. The todo-lane and taxonomy tokenizers
  keep every script (`\p{L}\p{M}\p{N}`), so a Cyrillic todo list has topics and a
  Cyrillic convention title covers its cluster. Reflex alternatives split on
  per-language data (`or`, `oder`, `или`) and on a free-standing `/` or `|` in
  any script. The #159 save-quality flags (negative claim, fix marker,
  imperative lead) are lexicon data with Unicode boundaries, shipped for
  de/en/ru and extendable per user (`~/.bastra/lexicon/negative-claim.txt`,
  `fix-marker.txt`, `imperative-lead.txt`); an unlisted language gets no
  penalty, and a code span in the body counts as the fix in any script. Still
  open: word segmentation for scripts without spaces (#711) and the prompt
  lane's `detectAssertion`.

- **The local bridges pool moves out of the Commons checkout** (#648).
  `bridgesPath()` defaulted to `commonsPath()`, so `bridges/` and
  `last-mint.json` lived inside the git checkout of the shared repo and
  would clash with a Commons that ships its own `bridges/`. The pool now
  lives in `~/.bastra/bridges` (`BASTRA_BRIDGES_PATH` still overrides). The
  first daemon start, Mac-app bridge start or `bastra bridges …` command
  after the upgrade copies an existing `<commons>/bridges` + `last-mint.json`
  there once (staged, then renamed); the originals are kept, and a pool
  already at the new path is never overwritten. Reading shared bridges from
  `<commons>/bridges` next to the local pool is not part of this change.
- **The bash tripwire lists only memories wired to the command** (#614).
  Under the STOP / CAUTION / reversible-form text, a recalled memory now
  appears only when its own `recall_when` matched the command with a strong
  anchor. The offline check the issue asked for first (157 hinting calls,
  2026-08-22 to 09-28) showed the hinted memories were unrelated topics
  matched through path tokens — the reason none was ever loaded. The static
  warning is unchanged and unconditional. New telemetry field
  `dropped_unanchored_count` on `bash_hook_call`.
- **PreToolUse is a compact first-touch hint** (#621). The Write/Edit lane
  shows recall hints only for the first delivered hint of a task area per
  session (repo + two directory levels), at most one candidate as
  `id (type): title — rule line` under a 600-character ceiling. Memories
  already delivered by SessionStart, the prompt lane or an earlier edit are
  not repeated; a strongly anchored `recall_when` hit in the REQUIRED band is
  the one named exception (`binding-anchored`). Weak results are not shown.
  Ranking is unchanged; `BASTRA_PRETOOL_SHAPE=legacy` restores the old
  presentation. Telemetry: `pretool_shape`, `hint_reason`.
- **An injected candidate list counts as the recall** (#620). The
  prompt-lookup `<recall-hints>` block now carries `recall-step="done"` and
  the originating `recall_id`, and no longer tells the agent to "use recall"
  on retrieval prompts — it says the recall already ran. SKILL.md (and the
  generated Cursor/Codex projections) say:
  with such a block, or `<session-context>` at start, load candidates directly
  and call `recall` again only for a different intent, scope change,
  deliberate reformulation or a new topic. Server-side suppression of
  same-turn duplicates and its telemetry are not part of this change.
- **Smaller session-start block** (#509). Taxonomy lines carry `[id] title`
  without the summary — the block already points at `load_memory(id)` for the
  full rule; on the owner's vault the six summaries were 440 of the 605 tokens
  of those lines. Taxonomy, doku and memory-language are sent on change only
  (the #462 cadence): a `resume` whose transcript still holds the identical
  text leaves them out. The compact/resume contradiction is settled on Claude
  Code's documented behaviour: `compact` and `clear` start a new context
  (hint dedup, delivered constants and the shadow session budget reset),
  `resume` keeps all three. New telemetry field `constants_skipped`.
- **Learned bridges work in every language** (#707; reported by @zzallirog,
  #701). The language is now only the folder a bridge is filed under:
  detection still names de/en, anything else (and anything it abstains on)
  goes to `bridges/und/`. Without a `bastra bridges language` override a
  query consults every folder; the trigger rule (two shared trigger terms)
  decides. Before, a Russian, Greek or Turkish query minted no bridge and got
  none, and a Russian prompt with Latin paths only saw `en` bridges.
  Bridge terms keep every letter and combining mark (Cyrillic, Greek,
  Devanagari; Turkish "şifresi" is no longer cut to "ifresi"). Folders with
  any 2–3 letter language code load. Scripts without spaces (Chinese,
  Japanese, Thai) still lack word segmentation — open in #707.
- **Other fixed language lists got a neutral path** (#707).
  `PHRASE_STOPWORDS` and the trivial-ack words are data per language; a
  language without a list drops no word as a function word, and an unlisted
  ack runs one score-gated recall. A prompt without any letter or digit
  ("👍👍", "!!!") now counts as trivial in every script. The Stop lane's
  decision suggestion has a language-neutral fallback like #678's for
  frustration: the user picks one of the numbered options the agent offered
  with a question ("2 olsun", "вариант 1", "2でお願いします").
- **docs/hooks.md describes the tripwire's three hint kinds** (#659). The
  bash-pre section (EN+DE) still said STOP for every destructive pattern. It
  now has receipt / reversible form / STOP with a table of which pattern is
  which (incl. `git branch -D` as reversible form, the `git push +refspec`
  and `git push --delete` rows), the whole-command rule, what
  `BASTRA_RM_ARCHIVES=host` assumes about the host's `rm`, `find … -delete`
  among the risky patterns (the dropped `>` redirect is gone from the list),
  and the `hint_kind` field on `bash_hook_call`.
- **`bastra embeddings on` says it also starts doc2query** (#646, from
  @zzallirog's #640 report). Ollama embeddings start the background
  paraphraser on a generation model, a different cost than the embedding
  model. `embeddings on` (and `bastra install --ollama`) now print its model,
  its cost class and `BASTRA_TRIGGER_EXPAND=0` as the off switch, and warn
  when the model is not pulled, before the first 404. The install prompt's
  consent text names it too. README EN+DE.
- **`bastra doctor` names a narrowed MCP entry** (#635). The features block
  now shows, per client (Claude Code, Codex), `BASTRA_TOOL_SURFACE=search`
  (no save tools, so the agent never saves on its own) and
  `BASTRA_MCP_SESSION_CONTEXT=0` as off-states with the entry to edit. Default
  values print no row; the exit code is unchanged.
- **`bastra config set reflex.enabled` and `promptImpact.enabled`** (#634).
  Both were only switchable by editing `~/.bastra/cli-settings.json` by hand,
  and doctor's hint said so. They are now config keys (true | false, also
  on|off; `get` names an overriding `BASTRA_REFLEX` / `BASTRA_PROMPT_IMPACT`),
  and the doctor hints name the command.
- **Claude Code hook registrations carry a client marker** (#657, #507).
  `bastra install` now writes `BASTRA_HOOK_CLIENT=claude-code` in front of
  every Claude Code hook command, as it already did with `codex` for Codex.
  The bash-pre hook weighs the rm archive receipt and the archive opt-in
  only for a call that carries it: an unmarked payload (an older or
  hand-written registration) keeps the STOP instead of being guessed as
  Claude Code. Re-run `bastra install claude-code` once to add the marker;
  doctor says so when the opt-in is on and the marker is missing.
- **`BASTRA_RM_ARCHIVES=1` now turns on bastra's own archiving `rm`** (#650).
  A host that ships its own archiving `rm` (the #651 receipt text, no
  rewrite) sets `BASTRA_RM_ARCHIVES=host` instead.

- **Learned bridges are written on their first reach and expire unless
  confirmed** (#672). On a normal-volume vault the same reach rarely repeats:
  one contributor's month minted 3,435 bridge candidates and wrote none. A
  bridge is now written on its first reach but stays *unconfirmed* until a
  second reach confirms it: it widens a query only at reduced weight (at least
  half its trigger terms must match, at most 3 expansion terms, after confirmed
  bridges), and it is deleted by the next mint pass if no second reach comes
  within 30 days (optional `first_seen` field, no migration). Confirmed bridges
  behave as before and never expire.

- **The prompt lane recalls on every prompt, in any language** (#677). Whether
  a prompt recalled at all was decided by German/English lookup regexes — a
  contributor writing otherwise had 0 of 1,039 prompts recognised in a month.
  The default `BASTRA_PROMPT_HOOK_MODE` is now `all`: every non-trivial prompt
  recalls, and what it may inject is gated by score (≥ 100, plus memories
  wired as `recall_mode: reflex` at the normal floor; without fusion only the
  wired ones). `BASTRA_PROMPT_HOOK_MODE=retrieval-only` restores the old gate.
  Latency budgets unchanged.
- **Code awareness is marked experimental** wherever you meet it (#667): the
  `bastra install` prompt, `bastra code enable`, `bastra code --help`, the doctor
  features section, `bastra logs --stats`, the UI telemetry section and the docs.
  They say what it can help with (finding the way into an unfamiliar or large
  repository) and what not (“what breaks if I change this” did not beat plain
  search on our repositories; it costs context and background CPU). Still
  opt-in per repository and off by default; no behaviour change.
- **The pending relay has two lanes** (#513). What the last session raised is
  still shown once at the next start and then gone (`recency`). What keeps
  coming up — today the taxonomy-drift block — now sits in a `trends` lane: it
  is shown at every session start in its own `<pending-trends>` block, is not
  consumed on read, and ages out after a number of real session starts
  (default 6, `BASTRA_PENDING_TRENDS_SESSIONS`) instead of after days. A
  refreshed trend replaces its row and restarts its counter. Resumed,
  compacted and cleared sessions, a repeated session id and ids with an
  eval/test prefix never advance the counter. Both blocks share the existing
  3,000-char budget; a trend that does not fit is announced and comes back at
  the next start. Session-start telemetry records entries and size per lane,
  and the telemetry dashboard shows them.
- **`verify_cmd` guidance for counts** (#467). The `save_memory` description
  now says that a memory claiming a count needs an anchor that prints the
  count, not one that checks that a single item exists. `load_memory` adds the
  same reminder to its anchor hint when the summary states a count.

### Fixed

- Client-label migration leaves foreign attachments and symlinks untouched and uses the vault-root guard for its file-by-file moves, so it cannot recreate a root that disappears during the move (#1072).
- bash-pre keeps STOP in host archive mode when line continuations disguise PATH/source changes or quoted zsh function names redefine `rm`; ordinary quoted data keeps its receipt (#1073).
- Temporary library and benchmark vaults no longer write disposable root entries into the default home marker. An explicitly chosen `BASTRA_VAULT_ROOTS_PATH` retains durable history for temporary roots (#1071).

- On macOS and Windows, a missing vault root now matches recorded path spellings without case, so a case-only alias cannot bypass the vanished-root guard.
- README and changelog now state the first-seen vault-mount limit and that the Desktop compiled hook stub still requires opt-in.

- Interrupted `bastra import clients` home-label migrations now resume after a file was rewritten or renamed, preserving long-ID links and refusing ambiguous ownership.

- The opt-in archiving `rm` hook now treats scalar zsh `path` assignments and reads as possible PATH changes; it prefers STOP over a false archive receipt, including for harmless Bash variables named `path`.
- Stop transcript diagnostics now check the opened file handle, closing the path-check/open race flagged by CodeQL.

- Vault writes now refuse corrupt or unreadable root history and require a durable marker; child creation cannot recursively rebuild a root lost after the presence check.
- Prompt, Stop and bridge readers now reject noncanonical `system-reminder` tags instead of treating harness text as an owner turn.
- Injection scanning now folds Cyrillic Supplement look-alikes already in its mapping table, including `ԁ` in `ԁisregard`.
- Vault: a root recorded as present that goes missing is also recognised when it is addressed with different letter case (`Vault` vs `vault`) on macOS and Windows, so a first save no longer recreates an empty directory; on a case-sensitive volume this may stop two distinct paths that differ only by case. Symlink aliases remain a documented limitation (#1009, #1046).
- Vault: a never-seen vault root is created on first save only if its parent folder exists; a missing parent (e.g. an unmounted drive) stops with an error naming it. `bastra install --vault` and the wizard still create missing parent folders for the path you name (#892, #1050).
- The vault-root "history unavailable" stop now names `~/.bastra/vault-roots.json`, the cause (empty/corrupt file or unwritable `~/.bastra`) and the repair (#1049, #1055).
- `bastra import clients`: a note in the old `imported/claude-code-users-<name>/` folder that the import did not write no longer blocks the label move. It stays where it is and is named in the output, and the other notes move as before, so none is imported twice (#1048, #1051).
- bash-pre: `for path in …` / `select path in …` now stop before a destructive `rm` like a scalar `path` assignment, and when the `path` variable is the only reason the STOP says so and that renaming it brings the reversible receipt back (#1047, #1052).
- bash-pre: `source`/`.`, `path[n]=…` and `unset PATH`/`path` before an `rm` now stop like a PATH redefinition instead of showing the reversible receipt (#1047, #1054).

- statusline: `collapseHome` no longer rewrites a sibling of the home directory (`/Users/n0mad-backup` stayed `~-backup`); only the home directory and paths below it are shortened (#937, same class as #853).
- eval: rerank-latency stores `first_call_ms` as null and the report prints `n/a` when no call happened at an N, instead of `0 ms` (#941, follow-up to #919).
- scrub: every hook block the daemon emits (pending-trends, memory-language, local-patches, vault-care, the curator candidates, and seven more that were missing) is scrubbed as injected context, and a test reads the tags from the emitting sources so the list cannot drift (#936).
- Stop lane: a transcript that exists but cannot be opened is recorded as skipped (`skipped_reason`), not as an empty session; genuinely empty Stop rows no longer count in the latency sample (#993).
- desktop: the Claude Desktop extension ships the verified hook-stub manifest, so an opted-in download can use the compiled hook client like the npm package; without it the Node client remains (#957).
- skill: the frustration trigger text names a repetition phrase ("not again", "schon wieder", "снова … опять") instead of the bare word "again"/"wieder"/"снова" (#763, follow-up to #756/#761).
- core: `slugify` no longer cuts an id inside a surrogate pair at the 80-character limit (#938, partial). Cyrillic and Indic handling is unchanged and pinned by a test; the rest of #938 moved to V2.0, because changing it would recompute existing ids.
- graph-semantic: the PCA in the semantic map yields to the event loop between power iterations, so a graph refresh no longer blocks hook requests for one long stretch. Measured at 1360 notes: longest uninterrupted block 239 ms → 7 ms, output bit-identical (#939, follow-up to #907).
- Pending trends: a retired taxonomy-drift hint no longer returns on every count change; it comes back only when a new cluster key appears or a cluster has doubled since it retired (#997, follow-up to #996).
- eval: the presentation registration states its §18.1 verdict in `underpowered_arm_verdict` (`not_evaluable`); the checker reads the field and flags a reporting rule that names a different verdict (#972, follow-up to #971).
- Stop lane: text typed after a leading system-reminder block is kept as the owner's turn, like the prompt lane (#994). Hardened in the same change: only one closed reminder block is stripped, and a fake closing tag or several reminder tags leave the turn system-injected, so text inside a reminder cannot pass as the owner's words. This also tightens the prompt lane.
- eval-stress: under `--hybrid` the anti slice is reported NOT EVALUABLE and no longer fails the verdict; the label-shuffle null is labelled informational; an empty cross slice still gates (#1003, follow-up to #1004).
- eval: the rerank-replay report no longer claims a degraded dense arm is discarded; it states that a timeout or error stops the run (reported in @zzallirog's #914, fixed in #1012).
- @zzallirog's #893, taken over in #1009 — a vault root recorded as previously present is not recreated when it goes missing. Directory-creating writers under the vault use one guard and `~/.bastra/vault-roots.json` preserves that history across restarts; a path never seen on this machine can still be created by the first save (#892).
- The exact-identifier anchor no longer fires on a fragment glued to the left of a longer identifier (#868, reported in @zzallirog's #869, fixed in #1010): `1.0` stops anchoring on `11.0.3`, `e-com` on `pre-commit`. `v1.0`, `1.0.1`, `09.09.2026` and `import-vault.ts` still anchor; measured on the gold set, no anchor is lost.
- @zzallirog's #799 — eval-stress: a cross slice with no gradable cases fails instead of reading `0 === 0` as PASS.
- Follow-up to #799 (#1004): the label-shuffle null stays a reported baseline and does not gate, and the anti slice gates under `--hybrid` as before (the floor of 81.967 no longer holds since the dense arm is weighted, #641). Which rules should gate a stress verdict is open in #1003.
- @zzallirog's #895 — save-commit: a live-owner save claim ages out after 10 minutes instead of never, so a reused pid cannot block an area forever.
- Follow-up to #895 (#1002): comments in `save-commit.ts` and `area-claim.ts` and the architecture docs (EN + DE) say so instead of promising a live owner is never dispossessed.
- @zzallirog's #903 — injection-scan: "ignore previous instructions" is flagged when written with fullwidth, look-alike (Cyrillic/Greek) or zero-width characters.
- Follow-up to #903 (#1006): the per-language de/ru/es/fr signatures are dropped because they flagged ordinary prose and the Russian one could go quadratic (3.3 s on 64,000 spaces); text the fold would not change skips it, so a 1 MB ASCII document scans as fast as before #903.
- @zzallirog's #923 — web UI: the CSP is tightened to `style-src 'self'`, no inline style attribute is left.
- Follow-up to #923 (#1005): the right-click menu on the map keeps its layout under that policy, because its base rules now live in `overlays.css` instead of a `<style>` element the policy blocks (one harmless CSP message in the console on first open).
- @zzallirog's #885, taken over in #1001 — import clients: the project opened in the home directory is labelled `claude-code-home` instead of a label carrying the OS user name, and a project in `~/home` is labelled `claude-code-home-home`. An earlier import under the old label is moved to the new one (folder, ids, `[[links]]`, source stamps; `--dry-run` reports it), so no note is imported twice (#884).
- @zzallirog's #791 — backfill-related: no cloud embeddings from a bare `OPENAI_API_KEY`, and no Pass B on a partial index.
- @zzallirog's #771 — pending-suggestions: a standing trend is shown for N session starts and then stays retired until its text changes (replaces the refreshed counter of #513).
- Follow-up to #771 (#996): a retired trend's tombstone ends after N counted starts without a re-write, takes no slot in the trends cap, and changed text always starts a fresh row with a fresh counter.
- @zzallirog's #765 — prompt-lane: a Russian lookup ("где лежит конфиг nginx", "найди заметку про деплой") is recognised as a retrieval prompt like its German or English twin.
- Follow-up to #765 (#998): retrieval leads are per-language data (German, English, Russian) that you can extend in `~/.bastra/lexicon/retrieval-lead.txt`; they match whole words only, so "когда мы закончим, удали ветку", "Suchmaschine …" or "findings …" are no longer treated as lookups.
- @zzallirog's #767 — stop-lane: an option pick is read in any digit script and for lettered, parenthesised or heading option lists.
- Follow-up to #767 (#987): stop-lane: the language-neutral option pick no longer reads numbered section headings (`## 1. …`) or a letter followed by a dot (`A.`, "z. B.", "A. Smith") as option lines; digit scripts, `(1)` and `A)` stay.
- @zzallirog's #769 — system-turn: one prefix list decides what is a harness-written turn for the prompt lane, Stop lane and bridge harvest.
- Follow-up to #769 (#989): prompt lane: an expanded slash command is a trivial owner prompt again (parked task-boundary block delivered, no `origin: "system"`), a prompt that opens with `<system-reminder>` is gated only when no typed text follows the block, and `<task-notification …>` with attributes is recognised as a harness turn.
- @zzallirog's #795 — stats: USE-rate table stops calling raw top-k "surfaced".
- Follow-up to #795 (#990): Telemetry: the raw top-k of a hook recall is called `candidates` in the Telemetry tab and the `/ui/telemetry` report as well (`bands[].candidates`, `bySource[].candidates`, formerly `surfaced`), matching `stats.ts`; the hint under the USE-rate table no longer points to a section that does not print the injected count.
- @zzallirog's #851 — statusline: the context bar fills to the percentage printed beside it.
- Follow-up to #851 (#985): statusline: with `percentageMode: "remaining"` and no context data yet, the context bar is drawn full beside `100%` instead of empty.
- @zzallirog's #879 — onboard: --answers with no usable answer fails and leaves onboarding open.
- Follow-up to #879 (#988): `bastra onboard --answers <file>` fails (exit 2, onboarding stays open) only when nothing in the file is usable and an entry was ignored or dropped — a mistyped question id, a value that is not text — and the error names those entries; a file with only the persona is valid again, as on the map and in the interview.
- @zzallirog's #883 — host-profile: a test run no longer creates ~/.bastra/host-profile.json.
- Follow-up to #883 (#986): host-profile: the test seam `BASTRA_HOST_PROFILE_PATH` always names the salt file; a value without `.json` is no longer read as a directory.
- @zzallirog's #887 — stop-lane, session-harvest: an unreadable transcript writes a telemetry row.
- Follow-up to #887 (#991): Stop lane and session harvest: a transcript the daemon's host cannot read (e.g. a remote daemon) is recorded with `skipped_reason` instead of `error`; `bastra logs --stats` no longer counts it as a Stop-lane failure or as a session read, and keeps it out of the lane's latency figures.
- @zzallirog's #773 — pinned-block: a truncated-out pin stays eligible for a ranked hint slot.
- @zzallirog's #777 — save-similarity: diacritics fold only on Latin letters.
- @zzallirog's #779 — edit_memory: a frontmatter summary patch is capped like a save.
- @zzallirog's #783 — eval: marginal-lift refuses to report a number over zero queries.
- @zzallirog's #785 — memory-location: resolve symlinks before the vault-root containment check.
- @zzallirog's #793 — stats: evidence-gate decision table counts live decisions once active.
- @zzallirog's #805 — commit-pool: --synthetic exercises the hash check it demonstrates.
- @zzallirog's #807 — tests(update-check): #441 wiring test pins the snippet, not just the order.
- @zzallirog's #809 — stub-source-digest: the closure follows side-effect, extensionless and directory imports.
- @zzallirog's #811 — stats: exposure section drops its dead catch, warns on --days mismatch.
- @zzallirog's #813 — stress-save-62: RUNS=0 or non-numeric RUNS fails instead of checking nothing.
- @zzallirog's #819 — prepare-package-assets: the staged skill/ mirrors the source and skips dotfiles.
- @zzallirog's #823 — update-check.test: the #441 no-restart check proves the launchctl stub was reached.
- @zzallirog's #825 — telemetry-smoke: "enabled by default" is asserted with BASTRA_TELEMETRY unset.
- @zzallirog's #827 — link-check: only a wiki link may leave the repository root.
- @zzallirog's #833 — write-build-revision: a git status that could not be read stamps dirty=true.
- @zzallirog's #835 — bump: a hyphen in +build metadata does not make the release a prerelease.
- @zzallirog's #839 — statusline: a failed git status shows "?", not the clean symbol.
- @zzallirog's #845 — statusline: cache-timer colors follow the detected TTL in elapsed mode and the TUI.
- @zzallirog's #849 — statusline: a rate-limit window with no percentage is hidden, not drawn as 0%.
- @zzallirog's #853 — statusline: a sibling directory sharing the project path as a prefix is not shown as a subpath.
- @zzallirog's #855 — statusline: the budget percentage is not capped at 100%.
- @zzallirog's #859 — scrub: the session-harvest relay block is scrubbed as injected scaffolding.
- @zzallirog's #861 — doctor: the client memory note count walks the folder the way the import does.
- @zzallirog's #863 — cue-batch: a run stopped by the generation brake keeps the previous sidecar.
- @zzallirog's #891 — update: patch skip detection runs git in the C locale so a localized git cannot hide a skipped patch.
- @zzallirog's #897 — webui-areas: a failed delete-rename clears its tombstone instead of stranding it.
- @zzallirog's #899 — floor-acts: order live-intent acts on parsed time, not the raw string.
- @zzallirog's #905 — path-lock: a token proves the lock being released is still this holder's.
- @zzallirog's #907 — graph-semantic: the O(n²) neighbor scan yields, instead of blocking the daemon.
- @zzallirog's #911 — import: wikilink namespacing uses the same grammar as save, so non-Latin links stay in the imported set.
- @zzallirog's #913 — eval: doc2query-lift PROMOTE respects its own reliability warnings.
- @zzallirog's #917 — eval: persona-gen fails loudly when it generated no persona.
- @zzallirog's #919 — eval: rerank-latency reports no warm sample as n/a, not 0 ms.
- @zzallirog's #921 — webui: the sidebar's memory count says it is scoped to the map.
- @zzallirog's #927 — docs: hooks.md env table names the right reader for BASTRA_HOOK_TIMEOUT_MS and BASTRA_PROMPT_HOOK_MODE.
- @zzallirog's #781 — import: the `recall_when` cut never splits a surrogate pair.
- Follow-up to #781 (#981): a note whose title is a bare type word (`reference`, `feedback`, …) no longer gets `"<title> (imported)"` as its trigger; the trigger is taken from the first meaningful line of the note's body and the import warns about it, and a note that holds nothing but a type word is skipped with the reason.
- @zzallirog's #847 — statusline: usage data that is missing or cannot be read renders as `--`, not as a real zero.
- Follow-up to #847 (#983): a fresh session and a day without usage show `$0.00` again; `--` is left for usage data that is missing or cannot be read.
- @zzallirog's #875 — telemetry-report: the latency section excludes restart-window calls like the CLI does.
- Follow-up to #875 (#982): the telemetry tab says how many calls the latency section left out because they fell inside a daemon-restart window (`window.excludedRestart` in the `/ui/telemetry` report).
- @zzallirog's #933 adds `find_code` and `archive_memory` to the skill's tool list.
- Follow-up to #933: the list covers every registered tool by access tier, while PRIVACY keeps users' direct-edit freedom.

- @zzallirog's #931 lists Commons verification and its public record in CLI help, removes stale bridge partition wording, and corrects the collapse-path score ceiling.
- Follow-up to #931: bridge help distinguishes query-language override from where new bridges are filed, with EN/DE usage guidance and regressions.

- @zzallirog's #925 aligns the checkout hook installer with the Claude Code adapter, including Stop defaults and failure hooks.
- Follow-up to #925: uninstall works without a build, stale dist fails clearly before settings change, and shell parity tests skip Windows.

- #975 waits for the area test's shared lock before racing a rename, removing a flaky root-suite assertion.

- @zzallirog's #909 gives four hook transports a real deadline, TLS selection and IPv6-literal support.
- Follow-up to #909: TLS regressions run without IPv6 loopback, unused test/transport exports are removed, and EN/DE hook docs describe the behavior.

- @zzallirog's #901 identifies a false brew-services start label during an Ollama re-probe.
- Follow-up to #901: the re-probe still prevents a second server, while brew/systemd labels require a successful start.

- @zzallirog's #889 lets the code-graph build lock recover an abandoned generation marker.
- Follow-up to #889: the race regression checks uniqueness per generation and lock comments describe takeover limits.

- @zzallirog's #881 recognizes `not_evaluable` and `NOT-EVALUABLE` in eval reporting rules.
- Follow-up to #881: German verdict spellings work too; the unreliable prose-negation word list is removed pending a structured verdict decision.

- @zzallirog's #877 limits unbounded repeats in custom Stop cues so digit-heavy input cannot trigger the reported two-star slowdown.
- Follow-up to #877: large bounded and Unicode-escape repeats count toward the same limit, with regressions and EN/DE cue guidance.

- @zzallirog's #873 makes `git reflog drop` and an amend with the reflog disabled STOP instead of issuing an unusable undo receipt.
- Follow-up to #873: English/German hook docs list both STOP cases, with a regression for the other false reflog settings.

- @zzallirog's #871 recognizes more PATH/rm redefinitions and treats git commit messages after global options as prose; its updated regex passes CodeQL.
- Follow-up to #871: English/German safety docs cover the new forms, with a regression for `git --work-tree` messages.

- @zzallirog's #867 stops routine code operators, identifiers and filenames from counting as frustration emphasis.
- Follow-up to #867: sentence exclamation marks in scripts without spaces remain language-neutral repeat cues.

- @zzallirog's #865 recognizes wrapped compiled-hook registrations and preserves foreign handlers beside Bastra hooks.
- Follow-up to #865: quoted runner paths and shell operators in quoted arguments survive re-install; doctor and Codex retain the same ownership boundaries.

- @zzallirog's #857 corrects terminal width for Hebrew, Arabic and Devanagari combining marks.
- Follow-up to #857: all Unicode non-spacing and enclosing marks use zero columns, including Thai and Tamil.

- @zzallirog's #843 invalidates yesterday's Today usage cache after midnight.
- Follow-up to #843: a valid empty Today cache remains reusable instead of triggering repeated transcript reads.

- @zzallirog's #841 bills one-hour cache writes at the one-hour rate in statusline cost estimates.
- Follow-up to #841: missing one-hour prices fall back to the five-minute rate instead of turning costs into NaN.

- @zzallirog's #831 removes a temporary Codex auth copy after a probe run and preserves an existing probe-home login.
- Follow-up to #831: the predictable probe home is owner-only, and symlinked or foreign-owned credential paths are refused before copying.

- @zzallirog's #829 makes a zero-test map build fail and a zero-source heatmap display 0.0% instead of NaN.
- Follow-up to #829: an unparseable full test list is rejected before it can overwrite a previous coverage map.

- @zzallirog's #821 restores the stub build-info placeholder after a terminal interrupt and corrects its permission description.
- Follow-up to #821: parent-only SIGTERM/SIGHUP now exit with their signal status after restoring the placeholder.

- @zzallirog's #817 corrects the local Desktop Extension packaging description: its daemon tarball omits the publish-only stub manifest.
- Follow-up to #817: the second packaging comment matches that behavior, with a workflow contract test for the manifest difference.

- @zzallirog's #815 makes an evaluation with zero cases fail instead of reporting a perfect result.
- Follow-up to #815: the regression test requires the specific failure and the message accurately covers an empty vault.

- @zzallirog's #803 prevents the one-off vault migration from replacing an existing target and rejects escaping scopes.
- Follow-up to #803: migration uses the normal scope validator, reports planned target collisions in dry-run, and names incomplete apply runs without duplicate collision lines.

- @zzallirog's #801 separates unstamped tool payloads from genuinely historical dimension rows in stats.
- Follow-up to #801: unstamped `recall` stays historical, and unmatched IDs get a neutral label that covers reflex hints.

- @zzallirog's #797 aligns the historical context-ROI denominator with its counted hook lanes.
- Follow-up to #797: the ratio identifies legacy and unmatched loads, reports `n/a` when no denominator can be assigned, and reuses the existing recall lookup.

- Hook install and uninstall identify the executed runner, leaving foreign hooks whose arguments merely name `bastra-hook` untouched (#945).

- Telemetry smoke runs use their own temporary log directories instead of deleting a shared fixed path (#944).

- Release-set stub tests fail immediately against their deliberately empty registry (#948); production retry behavior remains covered by its dedicated tests.

- @zzallirog's #789 prevents inherited test reporters from emptying the coverage map while preserving reporters for `select --run`.
- Follow-up to #789: quoted reporter destinations with spaces no longer leave stray `NODE_OPTIONS` tokens in map-build children.

- **install: a hook script of your own is no longer removed because of its
  name** (#683). `bastra install` and `uninstall` recognised bastra's hook
  entries by the substrings `bastra-recall` and `hook`, so a script like
  `~/bin/my-bastra-recall-audit-hook.sh` was deleted from
  `~/.claude/settings.json` without a word; the Codex adapter and
  `install-hook.sh` had the same test. Entries are now recognised by the hook
  runner their command invokes. A script that only looks like ours stays
  registered, and install and uninstall print a `hooks left alone` line.

- **Stop hook: the plain word for "again" is no frustration cue** (#756).
  `wieder`, `again`, `снова`, `опять` count only in a construction ("schon
  wieder", "immer wieder", "not again", "опять не …"). "Jetzt geht es wieder"
  used to trigger a save suggestion. Exemplars are listed once.

- **Harvest and Stop hook: injected rows are not the user** (#701). Rows Claude
  Code injects with `isMeta: true` (hook feedback, skill bodies) and Codex
  harness wrappers (`<environment_context>`,
  `<send_user_message_question_reply>`, …) are no longer read as something the
  user said. A decision the user makes by answering an `AskUserQuestion`
  prompt now counts for the architecture-decision suggestion.

- **Bridges: recall events carry their origin** (#704). `recall` and
  `hook_recall` events carry an `origin` (`owner`, `agent`, `tool`, `system`).
  A prompt-lane row without it no longer counts as the owner, so machine text
  logged before the field teaches no bridge.

- **Archiving `rm` on a full disk** (#695). An ENOSPC halfway through the
  archive `mkdir` no longer leaves an empty dated directory behind, and a full
  volume on which `<mount>/.bastra-archive` cannot be made gets the disk-full
  message instead of "no writable .bastra-archive".

- **`acted_on` in any script** (#701). The tool input is tokenised with the
  Unicode tokenizer the memory side uses; a Cyrillic or CJK token finds its
  partner.

- **Ollama idle unload never loads a cold model** (#701). The unload asks
  `/api/ps` first and unloads with `/api/generate` + `keep_alive: 0`. A model
  Ollama already evicted is no longer loaded by the unload request.

- **Prompt lane: assertion signals in any listed language** (#707). The
  signals are per-language data (de/en/ru, extensible in `~/.bastra/lexicon/`)
  with Unicode boundaries; an unlisted language recalls as an ordinary prompt.

- @zzallirog's #775 gives documents with different non-Latin filenames distinct IDs.
- Follow-up to #775: document overwrite retains existing IDs, and new IDs keep non-Latin combining marks.

- **Env off-switches read one way**. `BASTRA_TELEMETRY`,
  `BASTRA_REFLEX`, `BASTRA_SIZE_CHECK` and `BASTRA_CODE_AWARENESS` only took
  `off`; `BASTRA_RM_SHIM`, `BASTRA_GIT_SHIM`, `BASTRA_MCP_SESSION_CONTEXT` and
  a few more only `0` — so `BASTRA_TELEMETRY=0` kept writing telemetry — and
  `BASTRA_RM_ARCHIVES=true` silently switched the archive off over
  `archive.enabled=on`. All of them now go through one parser (`0` | `false` |
  `off` | `no` off, `1` | `true` | `on` | `yes` on); every value that worked
  before still does, and `0`/`false`/`no` now also switch off where only `off`
  was read.
- Takeover of #787 (@zzallirog's commit above) with a follow-up: the remaining hand-compared switches go through the same parser — `BASTRA_DOCUMENT_WRITE`, `BASTRA_ALLOW_REMOTE_OLLAMA`, `BASTRA_ALLOW_REMOTE_COMMONS` and `BASTRA_PROGRESS_DEBUG` take `true`/`on`/`yes` like `1`, and the off value of `BASTRA_QUERY_ROUTER`, `BASTRA_SALIENCE_RANK`, `BASTRA_TRUST_RANK`, `BASTRA_HINT_SUPPRESS`, `BASTRA_BANTER` and `BASTRA_ARCHIVE_MAX_ITEM` may be written `0`/`false`/`no` as well. Behaviour changes to check in your environment: `BASTRA_RM_ARCHIVES=true|on|yes` now turns the archiving `rm` ON, `BASTRA_AUTH_LOOPBACK_SKIP=false|off|no` now requires the token on loopback, and `BASTRA_TELEMETRY`/`BASTRA_REFLEX`/`BASTRA_SIZE_CHECK`/`BASTRA_CODE_AWARENESS` set to `0`/`false`/`no` now switch off.
- Post-release review: `bastra reconcile --yes` protects concurrent writes
  and keeps a unique backup when replacing a copy (#749); forwarders pointed
  at remote or TLS daemons no longer start a local fallback (#750); bridge
  migration publishes its completion marker last and uses isolated staging
  (#751).
- Derived claims now validate expected values, count fenced lists correctly,
  normalize quotes and bound source reads (#752, #753). The reported
  `score_version` reflects the effective dense weight (#641). SessionStart
  still returns assembled context when optional dedup state cannot be written
  (#754).
- Updated transitive `fast-uri` and `ip-address` dependencies to patched
  releases.

- **An auto-spawned daemon no longer runs on the MCP client's env as-is**
  (#684, first cut; report by @zzallirog). The forwarder spawned the shared
  daemon with `env: process.env`, so a client's `BASTRA_HOOK_TIMEOUT_MS` set
  every hook lane's budget and a service's behaviour switches were silently
  missing. The spawn now drops client-only keys (`BASTRA_TOOL_SURFACE`,
  `BASTRA_MCP_SESSION_CONTEXT`, `BASTRA_HOOK_TIMEOUT_MS`,
  `BASTRA_FORWARDER_SPAWN`, `BASTRA_HOOK_CLIENT`) and applies
  `daemon.env` from `~/.bastra/cli-settings.json` for the five env-only
  daemon keys (`BASTRA_TRIGGER_EXPAND`, `BASTRA_PROMPT_HOOK_MODE`,
  `BASTRA_DOCUMENT_WRITE`, `BASTRA_RM_ARCHIVES`, `BASTRA_OLLAMA_URL`), which
  win over the client's value. `/health` reports `started_by` and
  `env_origin`; `bastra doctor` prints them under "daemon origin". Not in
  this cut: a config fingerprint, and the service taking the port back.
- **Folder import no longer writes the type word or a whole description into
  `recall_when`** (#710; reported by @zzallirog: 442 single-type-word entries
  and 47 over 300 characters in one import). `bastra import vault` builds
  triggers from the description and title only; the type word (`feedback`,
  `reference`, `project`, `user`) stays a tag, and an entry over 200
  characters is cut at a word boundary (the description stays in `summary`).
  Each fix is reported as a warning (CLI list, `warnings` count in the map
  dialog's answer); the note is still imported. Existing notes are not
  touched; re-running the same folder import rewrites them.

- **`bastra bridges harvest` records its run** (#705; reported by
  @zzallirog). The far harvest wrote bridges but no `bridges_mint` event, so
  `bastra doctor` said "written 0" over a pool the harvest had filled. Each
  harvest run now emits one `bridges_mint` event with `trigger: "cli-harvest"`
  (minted, far cases judged as `reaches`, written), and the doctor's bridge
  note counts it next to the in-band mint. `last-mint.json` stays the in-band
  mint's marker.
- **The plan lane fires from Claude Code plan mode** (#698). The lane saw 0
  Claude Code calls in the #305 window: current Claude Code offers
  `TaskCreate` / `TodoWrite` by default only on older models (Opus ≤ 4.7,
  Sonnet ≤ 4.6, Haiku 4.5) or with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, so the
  registered matcher never matched. It is now `TodoWrite|TaskCreate|ExitPlanMode`:
  a plan presented from plan mode is read line by line (code fences left
  out) and recalls like a task list. The old names stay. Re-run `bastra
  install claude-code` (or `bastra update`) to register it; until then doctor
  reports the plan hook as not registered. A wrapper the user put around the
  old entry is kept.
- **The archiving `rm` on a full disk refuses clearly** (#695). Archiving is
  a move and frees no space; when the move or its manifest line fails with
  `ENOSPC`, `rm` now exits 1 with a message that names the ways out
  (`bastra archive reconcile --yes`, `/bin/rm`, `bastra config set
  archive.enabled off`). The target stays where it was, nothing is deleted,
  and the empty dated directory made for the move is removed again.
- **An `rm` redefinition inside a compound command is seen** (#694). `{ hash
  -p /x rm; }`, `if …; then alias rm=/x; fi`, `! hash -p …`, `time hash -p …`
  before an `rm -rf` got the archive receipt although `rm` was no longer the
  archiving one; the word after `{ ! if then else elif do while until time`
  is now read as a command, so these keep the STOP.
- **Task notifications and agent mail no longer recall as owner prompts**
  (#703; found and first fixed by @zzallirog on his fork, #701). Claude Code
  delivers `<task-notification>` and `<teammate-message>` /
  `<agent-message>` / `<cross-session-message>` turns (also after "Another
  Claude session sent a message:") as user turns; on one install they took
  59 of 265 prompt-hint slots. The prompt lane now skips them like a trivial
  prompt: no recall, `{}`, and a `prompt_hook_call` row with
  `gated_reason: "system-injected"` and `origin: "system"`. The Stop lane and
  the prompt lane share one check (`system-turn.ts`), so their lists cannot
  drift. A prompt that only quotes such a tag still recalls.
- **One session id across MCP and hook events** (#708, found by @zzallirog
  in #701). `recall`, `save_memory` and `save_hold` events now record the
  Claude Code session from the forwarder's `x-bastra-cc-session` header as
  `caller_session`, as `load_memory` already did; `session_id` stays the
  daemon's telemetry id, so older rows read as before. Clients without the
  header (Codex, Cursor) record `caller_session: null`. Before, "sessions
  with a save suggestion that then saved" joined on two different ids and
  read zero whatever had happened (#662: "0 of 56", 23 of 44 when recounted
  from transcripts). `bastra logs --stats` and the Telemetry tab now print
  that rate, joined on `caller_session` with a fallback to `session_id`,
  and say how many saves the join can see.
- **Learned bridges learn only from owner-typed queries** (#704; reported by
  @zzallirog, #701). Any logged query counted as a reach, so a recurring
  `<task-notification>` turn became a confirmed bridge that fired on 520 of his
  578 September recalls with a bridge, and led to nothing. The in-band mint and
  `bastra bridges harvest` now count only owner prompts and explicit MCP
  `recall` calls; tool-lane queries, harness turns and rows without a lane do
  not. Machine vocabulary (`toolu`, `task`, `notification`, `home`, `users`,
  `claude`) never becomes a trigger term, and existing local bridges whose
  trigger is mostly machine vocabulary move to `bridges/archive/` (reversible,
  logged) on the next mint pass.
- docs/commons.md: a bridge fires on two shared trigger terms, not one (all
  terms for a one-term bridge, half for an unconfirmed one), and the
  latin-only note points at #707 instead of the closed #231 (#706; reported
  by @zzallirog, #701).

- **Reflex memories fire on inflected words** (#565). The reflex lane matches
  exact words, so a trigger "Antwort an zzalli" never fired on "wir antworten
  zzalli". The trigger expansion now also writes inflected forms of a reflex
  memory's own triggers into `recall_when_expanded` (one extra local-model
  call, only for memories wired as `recall_mode: reflex`; existing reflex
  memories are re-expanded once). The matcher is unchanged, so what fires
  stays readable in the memory.
- **"Semantic search is off" only when it is** (#565). The write, bash-pre,
  bash-fail and todo hint blocks said so whenever one lookup ranked lexically;
  they now name the reason the lookup had (deadline missed, empty dense arm),
  as the prompt lane already did.
- **Bash tripwire: the #657 and #658 checks cover their other spellings.**
  `hash -p <path> rm` keeps the STOP next to an archiving `rm`, like `alias
  rm=` already did (`hash -p` for another name does not). The verb is read at
  command position past `builtin` / `command`, so `builtin hash` counts and
  `echo hash …` or `sudo hash …` (a child shell) do not. An `eval` body is
  read again as shell: an `rm()` definition, `hash -p`, `alias` or `PATH=`
  inside it keeps the STOP. `rm()` inside quotes outside an eval (`grep "rm()"`) is
  data. The gc expiry set through config (`git -c gc.pruneExpire=now gc`,
  `… maintenance run`, `git config gc.reflogExpire now` before a plain
  `git gc`) is STOP like `git gc --prune=now`, so it turns an
  amend/branch/lease receipt into STOP. `hash -p <path> name…` points every
  listed name at the path, so any of them being `rm` keeps the STOP
  (`hash -p /x rm python; rm -rf dist`).
- **An embedding request can no longer hang forever.** The Ollama provider
  (keep-alive socket) and the OpenAI provider had no request deadline: an
  endpoint that accepted the connection and never answered left `embed()`
  pending, so the breaker never saw a failure and each call parked another
  socket. Both now reject after `timeoutMs` (default 60 s, well above a cold
  model load), which the breaker counts like any other provider error. A
  batch gets 1 s more per extra text (a 50-text backfill batch: 109 s), so a
  slow CPU-only model is not mistaken for a hung one. An Ollama URL that Node
  rejects outright (e.g. `ftp:`) fails the call without leaving a timer that
  would crash the daemon later. Contributed by @zzallirog (#685).

### Internal

- ci: the unguarded-pipe eval test ends on an event instead of racing a consumer's exit against a 4 s timer, and the five LaunchAgent update-check tests run on the Linux CI through a `platform`/`plutil` seam instead of being skipped (#940).

- `rm-archive.ts` split: retention and reconcile live in
  `rm-archive-reconcile.ts` (#680).

- **Oversized modules split, behaviour-neutral** (#680). Ten files over the
  800-line convention were cut along one responsibility each, code moved
  verbatim and every public export re-exported from its old path:
  `prompt-lane.ts` (1239 → 774), `http-hook-routes.ts` (1139 → 755),
  `bash-pre-lane.ts` (1070 → 444), `session-lane.ts` (1016 → 741),
  `telemetry-events.ts` (1003 → 593), `stop-lane.ts` (998 → 463),
  `settings.ts` (977 → 480), `scripts/stats.ts` (937 → 625),
  `cli/adapters/claude-code.ts` (888 → 439), `write-lane.ts` (874 → 659).
  The new neighbour modules are listed in the module map in
  `docs/architecture.md`. No logic change; tests that read sources by path
  follow the moved code.

- **Eight more oversized files split, behaviour-neutral** (#680). Code moved
  verbatim, public exports re-exported from the old paths:
  `telemetry-report.ts` (853 → 338, #1030), `webui-areas.ts` (957 → 184,
  #1031), `mcp-forwarder.ts` (818 → 430, #1032), `import-vault.ts`
  (809 → 644, #1033), `documents-write-handler.ts` (1775 → 210, #1034),
  `webui/js/renderer.js` (835 → 528, #1035), statusline `tui/sections.ts`
  (1555 → 786, #1036), `tool-handlers.ts` (851 → 195, #1037). The new
  neighbour modules are listed in the module map in `docs/architecture.md`.

- ci(#1019): the `max(bm25, dense)` overlap test decides through a gated fake arm and a 1 ms deadline instead of a stopwatch, and the in-flight test catches a sequential dispatch again (#1029).

- **Five design-level splits, behaviour-neutral** (#1039). Code moved verbatim, public exports unchanged. `segments/renderer.ts` (1020 → 754, #1062, output pinned by a golden test), `telemetry.ts` (1093 → 605, #1063, event-log format pinned byte for byte), `powerline.ts` (1084 → 301, #1064, ANSI output pinned by a snapshot test), core `search.ts` (1748 → 795, #1065, result order of 20 fixed queries pinned by a hash test), daemon `index.ts` (1110 → 256, #1067, start-up side effects in the same order, proven by boot-trace diffs). The new neighbour modules are listed in the module map in `docs/architecture.md`.

- ci: the #458 session-budget and #539 session-state tests wait on an explicit write sync point and assert properties instead of elapsed time, removing their fixed-sleep and stopwatch failure modes under parallel load (#1056, #1061).

- test(#1039): the powerline snapshot test formats the context token count with the process locale instead of the de_DE form, so it passes on en_US CI runners (#1069).

## [1.0.0] — 2026-09-14

### Added

- **`recall` takes a context budget, not just a count** (#487). `k` counts
  results; what costs context is text, and the same `k=5` answer varies by
  more than 2× in size depending on summary length. `recall` now accepts an
  optional `max_tokens` on MCP and REST (and on `/hook/recall`, the route the
  MCP forwarder actually uses): after ranking, the score floor and the
  evidence gate, hits are emitted in rank order until the serialized payload
  would exceed the budget; the rest are dropped whole — never truncated — and
  the response says so with `truncated_by_budget: true` and
  `dropped_by_budget: <n>`, so an agent can re-query with more room or
  `load_memory` what it needs. `k` stays the hard upper bound, the estimate is
  the context governor's own (chars/4, #266/#458) so the per-call and the
  session budget mean the same number, and the telemetry records the requested
  budget beside the delivered payload so #457 can attribute the saving.
  Without the parameter nothing changes — measured on the gold set (699
  queries × four budgets, 2,796 calls): no payload over budget, no call that
  dropped more than it had to, mean slack 66.5 tokens, and 52.5 % less recall
  payload at those budgets. `scripts/measure-recall-budget.ts` re-runs the
  measurement.

- **One cumulative context budget per session, across all six lanes — in
  shadow mode** (#458, first slice). The governor decided per lane call and
  no lane knew what the others had already spent in the same session, so a
  "global context budget" was a reusable trimming function, not a bound.
  The daemon now keeps a bounded, pseudonymous per-session ledger: every
  automatic lane (SessionStart, Prompt, Write/PreTool, Bash-pre, Bash-fail,
  Todo) charges the estimated tokens of the block it actually emitted — the
  same number it logs as `hint_tokens_est`, so the shadow reconciles with the
  #457 ledger by construction — and records the governor's decision against
  the remaining session allowance as a `budget_shadow` event: would this block
  still have fit, or would it have fallen? **Nothing is trimmed.** `clear`
  resets a session's ledger; `compact` and `resume` do not, because the
  injected text survives compaction. The provisional shadow budget is 7,500
  tokens per session — the p75 of hook-lane tokens per evaluable session in
  the 7- and 30-day ledger on 4 September — overridable via
  `BASTRA_SESSION_BUDGET_SHADOW` (`0` = count only); the live value is a
  separate, measured decision. The Telemetry tab gains a "Context budget —
  shadow" section: sessions touched, tokens that would not have been
  injected per lane and per day, the emission at which sessions first
  crossed, and a flag when the budget changed inside the window. The
  decision is per emission, like the stats.ts what-if, and reads as an upper
  bound on what a per-entry live governor would touch.

- **A Telemetry tab in the vault map — the measurements are visible in the
  product** (#463). Everything recall measures was readable only by running
  `packages/daemon/scripts/stats.ts` and reading a wall of monospace text. The
  map's view switch now carries a fifth entry, Telemetry, that renders the
  same series over the user's own event logs: recall quality (hit bands,
  surfaced → loaded → acted on, follow-through and rank of loaded hints, hint
  source split), the complete context tax (#457 ledger by lane / tool payload
  / presentation, tokens per day, top sessions, and the archival-candidate
  list with the #354 directive/fact split so a working rule never reads as
  waste), latency per lane and per day (median and p95), the evidence gate
  (§18.2 / C-085 acceptance criteria as progress, decision mix, divergence vs
  legacy on fused runs only) and the session-start block per part (#462).
  Every section names its gaps instead of drawing through them: unknown-size
  rows are a lower bound, starts without `hint_tokens_by_part` are counted
  separately, memories whose type predates `hinted_types` stay unverified.
  Served by a new loopback-only, `ui.enabled`-gated `GET /ui/telemetry?days=N`
  that opens only the day files inside the window and clamps the window to
  the log retention. Local only — nothing is uploaded or aggregated. No new
  instrumentation; `stats-governor.ts` moved from `scripts/` to `src/` so the
  daemon and the CLI report share one acceptance rule.

- **The context tax is now measured end to end — one ledger for hook
  injections and tool payloads** (#457). Two official views answered "how much
  context does Recall add" with different numerators: `Net-context-ROI` counted
  three hook lanes, the governor what-if six, and neither counted what
  `recall`, `load_memory` and `read_document` return — the bodies the model
  actually reads. `recall` events now carry the serialized payload size,
  `load_memory` the delivered size AFTER the lean/full projection (plus
  presentation and origin: hook hint, own recall, or cold), and a new
  `read_document` event records document reads. The Bash-fail and Todo lanes,
  which emitted text but never a token count, now record `hint_tokens_est`
  like every other lane. `context-ledger.ts` folds all of it per session with
  one rule for old rows: no size field means `unknown`, never zero — the total
  is a lower bound and says by how many emissions. `bastra logs --stats` prints
  the complete total with its lane / tool / presentation breakdown next to the
  historical ROI view; the estimator is chars/4 everywhere and labelled as
  such. No retrieval, presentation or loading behavior changes.

### Added

- **Regression tests for the SessionStart and TodoWrite lanes** (#373). Both
  lanes had no test of their own, which is how #372 — both stamping a fresh
  UUID instead of the hook payload's session — went unnoticed through the
  whole #356 series. The new tests pin the telemetry row of each lane: session
  id from the payload, synthetic UUID only as the fallback, `hook_version`
  present, the right event kind, the daemon-unreachable and gate branches, and
  for SessionStart the per-part token split.

### Added

- **The session-start block is measured per part** (#462, measurement only).
  152 session starts — 0.8 % of all hook emissions — carried 14.5 % of the
  entire context tax, and telemetry recorded one number for a block assembled
  from ten parts, so nobody could say which part spends the ~2,300 tokens a
  start costs. `session_hook_call` now carries `hint_tokens_by_part` (pinned,
  recalls, taxonomy, language, care, import, onboarding, update, patch,
  pending, doku; same chars/4 estimator, each part rounded on its own) and
  `bastra logs --stats` prints total, share, average per start and how many
  starts contained each part, plus the top parts per start source (startup /
  clear / compact / resume). No cadence or content changes — that decision
  follows the measurement.

### Added

- **Cross-surface instruction parity is enforced — in CI, in the package and
  in `bastra doctor`** (#456). Building on #455's generated projections: CI
  regenerates them and fails on any diff; a test compares the daemon
  package's shipped `skill/` and the plugin payload against the canonical
  source and checks the `npm pack` file list, so a release cannot carry a
  Cursor rule or plugin skill that disagrees with the skill. Every installed
  skill now carries one bundle revision (sha256 over the payload), and
  `bastra doctor` compares the installed copy for Claude Code, Claude Desktop
  and Codex/ChatGPT file by file against the shipped bundle instead of
  reporting "present" for any SKILL.md at the path — a stale or partial
  install is `broken`, and `--fix` refreshes exactly the differing files
  (the same comparison `install` already used). The Cursor adapter reports the
  current project's `.cursor/rules/bastra-recall.mdc` as up to date, stale or
  not installed.

### Changed

- **One canonical instruction source — the Cursor rule and the Codex/ChatGPT
  plugin skill are generated from `packages/skill/SKILL.md`** (#455). Two
  hand-authored copies of the Recall/Save policy existed beside the canonical
  skill and had already drifted from it: the Cursor rule carried fixed score
  guidance ("~100+ … below ~30 is noise") and its own "recall first" policy,
  the plugin a separately shortened one — so a policy change could land on
  Claude and leave Cursor with the opposite behavior (#7's "skill ≠ rules
  drift"). Generated projections rather than thin wrappers, because neither
  client can read a file it does not own: Cursor rules are self-contained
  `.mdc` files in the project, a Codex plugin ships its own SKILL.md. Each
  projection is the canonical body verbatim under client-specific metadata
  (display description, `alwaysApply`, install pointer) with a generated header
  carrying the canonical hash; the plugin dir now also carries the four
  reference files so every pointer resolves. `npm run skill:build` regenerates,
  every daemon build runs it, and a test fails on a stale or hand-edited copy.

### Changed

- **The assertion lane's hint is a statement about the environment, not three
  commands** (#384). It read "Do NOT assert numbers … Check the candidates
  below … write that you do not know instead of guessing" — an instruction in
  context has to be noticed, accepted and turned into output, and a
  prohibition names the very move it forbids. The block now states the facts:
  for a claim like this, model memory is not a source; the numbers come from
  the vault; a claim the vault does not answer is unknown and goes out as
  unknown; the candidates follow. Same trigger, same candidates, same floor.
  Re-measured on the #252 harness (one-memory vault, opus, trigger-form
  prompt): the previous wording stood at 7/7 with no invented figure, so the
  comparison can only rule out a regression, not show a gain.

### Changed

- **The evidence gate is ON by default** (#422, §18.2). The deterministic
  `required` / `optional` / `no_answer` decision from #264 ran in shadow since
  28.08.; it is now enforced: a hit the predicate marks `no_answer` is not
  injected. All three activation conditions were met on 03.09.: shadow
  acceptance via the decisions route (6,544 decisions, 40 sessions, largest
  24.3 %), every `required` / `no_answer` divergence explained by feature
  signature, and the §18.2 component gates within their thresholds on the full
  gold set (anti-query injection 1/28 = 3.6 %, false abstention 0/584,
  recall@3 delta −0.0034, identifier queries unchanged, invariants 0/0).
  Expected effect from the shadow stream: about 27 % of the decisions legacy
  served in the optional band fall silent (one signature: no evidence at all).
  `BASTRA_EVIDENCE_GATE=0` is the instant off-switch; `evidenceGate.enabled:
  false` in the CLI settings the durable one — that settings block was written
  but never read back before, so the file could not switch the gate; it can
  now. The daemon prints the gate state at startup either way.

### Added

- **The evidence-gate readout groups the `required` divergences by feature
  signature** (#422). §18.2 makes explaining every `required` / `no_answer`
  divergence a condition for switching the gate on; the readout counted the
  `required` ones (430 withheld, 995 promoted on 03.09.) without saying what
  they had in common. Both directions are now grouped like the `no_answer`
  view already was — on 03.09. every withheld case is arm agreement alone
  (coverage below one half, no identifier, no scope), every promoted case a
  second signal beside it or a full trigger match: the two-of-three rule,
  visible instead of argued.

### Fixed

- **`bastra install codex` switches Codex's planning tool on, instead of
  registering a hook that can never fire** (#506). Codex has shipped its
  `update_plan` tool disabled by default since `rust-v0.152.0`
  (`tools.update_plan.enabled`), so the `PreToolUse: ^update_plan$` hook the
  installer registers was dead by construction on a default installation — the
  seven days of zero plan events the issue opened with. Install now sets the
  key in `~/.codex/config.toml` itself and says so in its output; it appends a
  commented, bastra-marked block rather than re-serializing a file Codex owns,
  leaves every other line byte-for-byte intact, and a second run reports
  `already true` and writes nothing. A value the user deliberately set to
  `false` is a decision: it is reported, never overwritten. `bastra uninstall
  codex` removes exactly the block bastra wrote — a setting the user made
  themselves, or a managed block they edited, stays. `bastra doctor codex`
  reports the key as MISSING (repairable by re-running install) when it is
  absent, and names an explicit `false` as the reason the plan lane is silent.
  Install also spells out the Codex trust gate when it changed hook
  definitions: Codex trusts a hook by the hash of its exact command, so changed
  hooks stay silent until they are re-approved in `/hooks`.

- **Ollama autostart is a named `systemd --user` unit on Linux, not an unref'd
  orphan** (#496, contributed by @zzallirog in #497). `ensureServing()` only had
  a persistent-agent path for macOS (`brew services`); on Linux,
  `ollama.autostart` unconditionally fell through to a one-shot
  `spawn(..., {detached: true}); child.unref()` — invisible to `systemctl` and
  not tied to the daemon's lifecycle. It now starts ollama via
  `systemd-run --user --unit=bastra-ollama --collect -- ollama serve`: a named,
  visible, stoppable unit that `systemctl --user status/stop bastra-ollama` can
  see and manage. As on the brew path, the server is re-probed after the systemd attempt before the
  detached fallback runs, so a unit that binds slowly (or one that already
  exists) does not get a second, competing ollama on 11434. Falls back to the
  previous detached spawn only when `systemd-run` isn't available. macOS is
  untouched: the whole branch sits behind a `process.platform === "linux"` gate
  and the darwin log line still names brew services as the missing supervisor.
  **Still open in #496:** the unit carries no `Restart=` and no idle teardown, so
  it is named, visible and stoppable — not supervised. The idle-unload half (the
  Linux equivalent of the macOS story in #78, which unloads the *model*, not the
  server) remains unsolved. So does the environment: `systemd-run` starts the
  unit in the user manager's environment, so `OLLAMA_*` variables a plain spawn
  would have inherited do not reach it. That costs a slow start rather than a
  wrong one — with a non-default `OLLAMA_HOST` the unit binds 11434, the poll
  runs out its 15 s and the detached fallback then serves correctly — and
  choosing what to forward wants a machine with systemd to verify it on.

- **The context governor decides per entry, not per id** (#438). Kept
  candidates were tracked in a set keyed by id and the output filtered by that
  set, so with duplicate ids one accepted occurrence marked all of them as kept:
  a duplicate the report had dropped for the token budget was emitted anyway,
  and the item count (unique ids) did not match the output (entries). Each
  candidate now carries its index, and a second mention of the same id in one
  block is dropped as `duplicate_id` before it costs budget — the occurrence
  with the better priority is the one that stays. This was the prerequisite for
  a live cumulative budget (#458).

- **Hint blocks now say what they are: candidates, not the memories** (#465).
  The session-context header read "apply what fits, load_memory(id) for
  details" — an invitation to treat a one-line summary as the content and the
  body as optional depth. On 1–2 September an explicit override memory ranked
  top with score 163, was never loaded, and the session followed the opposite
  rule. Every surface now carries the same sentence, defined once in
  `band-wording.ts`: these are candidates (id, title, summary), NOT the
  memories themselves — nothing is in context until `load_memory(id)` is
  called and read; a summary is a pointer, not the rule. Session context,
  session-start block, prompt lane and write lane carry it on their REQUIRED
  and unfused headlines. A user should not have to counteract Recall's own
  wording in their agent instructions.

- **`acted_on` no longer weighs in heat and trust, and a load without a hint
  is `not_hinted`, not `below_floor`** (#469). `acted_on` fires when a loaded
  memory shares two tokens with the next tool input. On 1 September one Bash
  call closed three thematically unrelated memories as acted on at once, and
  across 84 episodes the match strength showed no gradient (median 4 for the
  non-surfaced cases, 3 for the surfaced ones). That signal counted double in
  the usage heat the map paints on nodes and was the up-step of the #160 trust
  shadow, so the 21.08. shadow reading (11 higher / 4 lower) rested on it.
  Heat and reach weight are now `loaded` alone; trust only demotes on
  shown-and-never-opened, which opening neutralises. The counter itself stays
  in the aggregate. And a direct `load_memory` with no hook hint carried
  `band: below_floor` with no score — ten such episodes in the window read as
  ten ranking failures. They are now `not_hinted`; the band quotas already
  excluded them, the label just stops lying. The curator's engagement
  timestamps and the reflex/adoption candidate counts are unchanged.

- **`archive_memory` now respects `sensitivity: private`** (#464). The read
  path hid private memories from external callers; the archive path did not,
  so an MCP caller could move a memory to the trash that it could neither load
  nor find — and learn from the success that the id existed. Archiving now
  answers exactly as loading does: as if the id were unknown. The Mac app keeps
  its `allow_private: true` override, mirroring `load_memory`.

- **Long prompts no longer lose the dense arm — the prompt lane fuses again
  where conventions matter most** (#466). On 02.09. 27 of 49 prompt-lane
  recalls came back `bm25`, every one of them on a prompt over ~1,000
  characters, with `vector_search_ms` sitting on `bm25_search_ms` + 2–7 ms or
  exactly on the 150 ms deadline — while Ollama answered the same embeds in
  25–66 ms. The arm was not slow; it was never asked in time. The dense request
  only leaves the process once the event loop is free, and #305's one-tick
  yield sends it only over a socket that is ALREADY open. `fetch` closes its
  connection after 4 s idle and prompt-lane calls are minutes apart, so the
  connect completed after BM25 had blocked the loop, the request went out
  behind the lexical pass, and a deadline armed at dispatch (#370) had by then
  charged the arm for the whole BM25 run. Without fusion the lane drops the
  REQUIRED band, the backoff bypass and the semantic reflex layer — a weaker
  signal on exactly the long, spoken prompts that carry the conventions.

  Two changes, no ranking effect (identical inputs to both arms, RRF
  unchanged). The Ollama provider now speaks over a keep-alive agent, so the
  turn-start prewarm (#361) warms the socket as well as the model and the
  request is on the wire during the yield — measured on a 1,500-character
  prompt with a 140 ms lexical block: warm socket 0 ms after the block, cold
  88–111 ms. And the deadline is armed when the arm is actually awaited, not
  when it is dispatched: work between the two is not the arm's time. A dense
  arm that is still slower than its budget after the wait keeps timing out.

  Before/after against the live daemon, six real prompts of ~1,500 and ~3,000
  characters, socket cold between calls: 0/6 fused before, 6/6 after (table in
  the commit). `dense-arm-dispatch.test.ts` gains a cold-socket case,
  the #370 deadline test is inverted.

## [0.9.2] — 2026-08-27

### Added

- **`bastra autostart on|off|status` — the daemon can now be kept running, and
  the LaunchAgent finally has an owner in the code.** A user reported that after
  a plain `brew upgrade` neither the plist was updated nor the daemon restarted.
  The investigation found an uncomfortable reason: nothing in this repository
  ever *wrote* a LaunchAgent plist. There were only places that read one,
  kickstarted it, or removed it on uninstall — `daemon-start.ts` says so
  verbatim: "no install path registers one". Whoever had one had written it by
  hand, and what was never written cannot be maintained by an update.

  The default does not change: without this command the daemon still starts on
  demand through the MCP forwarder and shuts down after 30 minutes idle, which
  is all Claude Code, Claude Desktop and Cursor need. Turning autostart on
  disables the idle shutdown.

  The real gain is ownership. `bastra update` now repoints its *own* autostart
  at the new installation after an upgrade — Homebrew puts every version in its
  own directory, and a plist holds an absolute path. `bastra doctor` reports one
  that points at nothing, or one that is installed but not loaded. Both were
  previously impossible.

  A hand-written plist is never touched. It usually points somewhere on purpose
  (a source checkout, a custom model setup), so `on` refuses and names `--force`.
  Ownership is recognised by a marker inside the plist, and the file is read
  through `plutil` rather than a homegrown XML parser — otherwise exactly the
  cases that matter (binary or unusually formatted files) would have been
  misread. Unreadable counts as foreign.

  No `service do` block in the Homebrew formula: Homebrew forces the label
  `homebrew.mxcl.bastra-recall` while the code checks `ai.n0mad.bastra-recall`,
  which would mean two autostart worlds competing for a port that exists once.
  The caveats now say what a plain `brew upgrade` does not do.

### Performance

- **Recall got roughly twice as fast, with an identical ranking.** MiniSearch
  searched every *occurrence* of a term separately — a trie walk plus prefix and
  fuzzy expansion, per occurrence. A long prompt repeats half its words (1186
  emitted against 649 unique in the median), so half the work was repetition.
  Each unique term is now searched once and weighted by how often it was asked
  (`boostTerm`), which is only free if the counting happens AFTER folding:
  grouped before folding gives 0/30 identical rankings, grouped after gives
  30/30, with a score delta of 1.77e-8 — float rounding from the changed
  addition order.

  Measured through the production path over 30 real prompts against 991
  memories: lexical arm p50 **1137 → 461 ms**, total recall p50
  **1327 → 689 ms**. Live against the running daemon on a real 7962-character
  prompt: 651 ms total, where the same shape used to sit near 1800 ms.

  No flag, no opt-in — this is on for everyone.

### Fixed

- **One id, one file, one transactional writer.** The vault had an id-based
  commit lock, but only `saveMemory` used it — `saveDocument`, `auditedRestore`,
  `mutateMemoryFile` and the area writers wrote past it. Reproduced: two parallel
  `saveDocument` calls for `a+b.pdf` and `a-b.pdf` both produced a sidecar with
  the derived id `doc-a-b-pdf`, and the vault silently loaded only one of them on
  the next start.

  The lock alone was not enough either. Under it the same index was asked again
  that the pre-check had already answered from; if that index came from another
  process and was stale, the second question also said `none`. Every
  ownership-changing writer now runs through `withIdClaim()`, and the answer
  under the lock is an authoritative disk scan, not an index. The scan is the
  price of this invariant, so it is measured rather than estimated — `onIdScan`
  reports directory count, file count, bytes and duration per operation.

- **Area operations serialise against saves and against each other.** A
  tombstone under `.bastra/areas/` answers the historical name question — "this
  shelf name moved away" — but it is not mutual exclusion. Between the tombstone
  check and the actual publish lie a target read, parsing, frontmatter assembly,
  a temp file and a rename; a rename running through that window left the save
  publishing into the old shelf, and both existed afterwards. Twelve parallel
  attempts at `carnexus → target-a` versus `carnexus → target-b` produced, in
  twelve of twelve runs, a tombstone pointing at the *loser's* target — an old
  client would have been redirected somewhere that does not exist.

  There is now a reader-writer lock beside the tombstone: saves take a shared
  claim (they do not exclude each other), while create, rename and delete take an
  exclusive one, for both source and target name, acquired in sorted order. The
  lock order across the whole vault is area claim before id claim. The key comes
  from the *resolved path*, not from the frontmatter scope, because an explicit
  `folder` can point at an entirely different shelf.

- **Rollbacks no longer delete someone else's version.** In the document hub the
  overwrite rollback removed the current original blindly and restored the backup
  blindly, swallowing every error. Reproduced: bastra replaces V1 with V2, an
  external writer then writes V3, the sidecar compare-and-swap correctly fails —
  and the rollback deleted V3 and restored V1. The sidecar protection had merely
  moved the data loss onto the original. The move rollback had the same shape and
  additionally reported success after a failure it had swallowed.

  Both now compare file identity against the state captured right after
  publishing, claim their target paths atomically (`link` instead of
  `exists` + `rename`) and report per file what stayed behind. `true` only when
  original *and* sidecar are verifiably back where they were.

- **An id claim now proves which file it belongs to.** `moveToTrashUnderClaim`
  took the caller's path on trust: with a genuine claim for A and the path of B,
  A stayed active, B disappeared from the vault, and the trash held B's content
  under A's name. The primitive now reads the raw bytes once and requires the
  file to hold the claim's memory — and the same read produces the audit
  evidence, so the version that moved and the version that was logged can no
  longer differ.

- **Audit records describe what actually happened.** Conflict marking took its
  "before" image from the vault cache while the disk held something else;
  restore logged the state from *before* the delete as `diff_after`, so a trash
  file edited in between was recorded as something that was never restored. Both
  now come from the mutation itself. And a failed audit append no longer turns an
  already committed mutation into an error — it returns `audit_warning` telling
  the caller not to retry, because the write has already happened.

- **`overwrite` is a patch, not a rebuild** — and a re-file keeps its metadata.
  A save sends only the fields it wants to change; everything else has to survive
  the refresh. When re-filing into another shelf the target did not exist yet, so
  the template was empty and the move silently dropped `created`, `related`,
  `sensitivity`, `source` and a lowered `confidence`. The template is now the
  source, read under the same transaction.

- **The file system answers questions about the file system.** Three places
  answered them from a path string instead: an unreadable file counted as absent
  and was replaced, a different spelling counted as a different file (on APFS the
  re-file trashed the very file it had just written), and "the string starts with
  the vault path" counted as "inside the vault", so a symlink in `folder` wrote
  outside successfully.

- **One score space per answer.** A recall that mixed arms reported numbers from
  different spaces as if they were comparable, and a mid-call degradation was not
  visible at all. Every hit now carries the arm set it was scored in — on the MCP
  path and on the hook path alike — and commons is a third arm rather than a
  second score space.

### Changed

- The publish workflow runs on Node 24, which bundles npm 11.19.0. OIDC trusted
  publishing needs npm >= 11.5.1, and the global `npm install -g npm@…` that
  provided it could not be pinned by hash — Scorecard flagged it. The step is
  gone; the npm that publishes is the one the pinned Node release brought.


### Fixed

- **Scope identity is one decision in core now, and two more places where a
  project was foreign to itself are closed.** Yesterday's fix folded the case in
  `isScopeCompatible()` alone; a counter-review found the class was still open.

  SessionStart asks for the project's memories by name and sends the raw
  directory segment, and the core compared `opts.scope` case-sensitively in the
  BM25, vector and hop paths — so `scope: "CarNexus"` returned nothing while
  `scope: "carnexus"` returned hits. Since global scopes kept answering, the
  failure read as "there is nothing for this project". Project-bound floors had
  the same defect in `listFloors()`, which is worse: floors are contractually
  guaranteed to be present, and they were silently absent instead.

  Rather than scattering more `.toLowerCase()`, comparison now lives in
  `core/scope.ts` — `normalizeScopeKey`, `scopeEquals`, `isScopeCompatible`,
  `GLOBAL_SCOPES` — and every comparison site uses it: the three core recall
  paths, the floor registry, `list_memorys`, the save-quality pool, the hook
  scope filter and the eval tool, whose private copy is gone. Stored frontmatter
  is untouched: any spelling stays loadable and is normalised only when compared.

  `detectProjectDetailed()` now reports `{raw, key, confidence}`, because the
  old fallback returned a name for every path — `/tmp/worktree/packages/core`
  became `core` — and callers could not tell detection from guessing.

  Correcting an earlier claim in this changelog: it was NOT "all four lanes".
  The write lane, SessionStart, the core recall filter and the floor registry
  were affected. The prompt and todo lanes were not — because they apply no
  project scope filter at all, which is its own finding in the opposite
  direction: foreign hits pass there where #110 would filter them.

- **A project whose directory is capitalised was foreign to its own memories.**
  `detectProject()` returns the directory segment as written — `CarNexus` for
  `~/Projekte/CarNexus` — while vault scopes are conventionally lowercase.
  `isScopeCompatible()` compared them case-sensitively, so in such a session the
  project's OWN memories failed the scope filter and were dropped from every
  score band, while global ones kept coming through. Silent, and precisely
  backwards. All four lanes that call `detectProject()` were affected. Both
  sides are folded now; the prefix family (`bastra` covering `bastra-recall`)
  and the separation between siblings (`bastra-io` vs `bastra-recall`) are
  unchanged and pinned by tests. Found while verifying the eval tool, not by
  anything that reported it.

- **The two-term anchor rule could still fire on a single query term.** It
  counted distinct word ORIGINS but not distinct matched TERMS, so
  `recall_when: "my-app your-app"` with the query `app` produced two origins
  from one term. It now requires a matching of size two — two origins covering
  two distinct significant terms (`|A ∪ B| >= 2`, checked across all pairs).

- **Two of the three control states in the candidate tool were unreachable or
  mislabelled.** `random-control-global-only` could not occur (recognition
  implied the scope existed), and `random-control-unscoped` was not unfiltered
  at all — with 191 globally-scoped memories the pool never empties, so all 16
  such candidates came from `all-projects` / `taxonomy` / `user-preference`.
  Recognition and scope existence are now two independent facts, and each state
  builds its pool explicitly.

- **Third counter-review round: the anchor counted spellings, the project
  detection proved nothing, and the worksheet still named its sources.**

  The two-term rule deduplicated before normalising, so `recall_when: "foo, foo"`
  produced two origins — `foo,` and `foo` — for one word. Same defect class as
  the previous round, one level down; dedup now keys on the word's normalised
  emission signature, while the identifier check keeps reading the raw spelling.

  The candidate tool decided "project unknown" by whether the scope-filtered
  pool came back empty. With 191 globally-scoped memories in the vault it never
  does, so a completely wrong detection looked like a clean one — which is why
  the earlier "fallback fires on 0 of 4" said nothing at all. Detection now
  reads the `cwd` field the transcripts actually carry on every user turn
  instead of guessing from the #-encoded directory name, reports whether it is
  confident, and the control sample is three-way: matched scope, recognised but
  global-only, and unrecognised. Measured again: 2 of 4 queries are unrecognised,
  both legitimately so.

  And the worksheet named its own sources — `above-inject-floor`,
  `random-control`, `dense-top`. Score-blind is not retrieval-blind: whoever
  reads that a candidate is already being injected labels it differently.
  Provenance moved to the meta file; the sheet carries id, title and an empty
  label. Those labels are supposed to decide whether the router ships, and a
  sheet that hands over the answer cannot decide that.

- **The cross-scope anchor stops counting tokenizer emissions as authored
  intent, and the candidate worksheet stops showing the answer while asking the
  question** (second counter-review round).

  The two-term rule ran over a phrase's flat token list — the tokenizer's dual
  emission. `recall_when: "foo bei foo"` counted `foo` twice, and a single
  `my-app` satisfied the rule through its own parts `my-app`/`my`/`app`, which
  bypassed the rarity condition outright. It now counts distinct words of the
  raw phrase, each at most once, and "significant" is finally implemented: the
  same stopword and length rule the reflex path has used since the 20.08.
  incident, moved to `core/stopwords.ts` rather than copied.

  Rarity measured the wrong thing. `docFreq()` sums across seven fields, so a
  term appearing in five triggers and ten bodies broke the threshold while
  being rare as a trigger — 607 such cases in the vault. `recallWhenDocFreq()`
  counts distinct memories carrying the term in `recall_when`, maintained at
  index time; its lifecycle (add → change → change back → remove → double
  remove) is pinned by a test, because a hand-maintained count drifts silently
  and this one decides which foreign memory may enter a session. The identifier
  check now runs on the RAW phrase — terms arrive folded, so camelCase was
  structurally invisible — and the `length >= 12` rule is gone: long natural
  words are ordinary in German, and 646 terms hung on it alone.

  On the eval side: the worksheet is now blind. Score, rank below the floor and
  distance to 30 move to a separate `*.meta.json`; the sheet carries id, title,
  provenance and an empty label, shuffled deterministically per query. Whoever
  sees the number labels the number. The below-floor margin rises to 10 behind
  `--below-floor-margin`, so "were five enough?" stays answerable afterwards.
  The control sample is query-hashed and scope-filtered instead of near-identical
  per query, with a MARKED fallback when project detection fails — measured, it
  fires on 0 of 4. And "found by no retriever" no longer counts hybrid-pool
  near-misses, which were found, just not inside the evaluated top 20.

### Added

- **A cost-based retrieval router, a fast lexical path, and the candidate set
  that has to judge them — all three deliberately inert for now** (#362
  Phases 0, 2 and 3).

  `routeRetrieval()` picks between hybrid, dense-primary, lexical-full and
  lexical-fast from what the search will COST (`terms_unique`, estimated at
  ~0.75 ms per unique term) and whether a dense arm exists — not from prompt
  length, which is a poor proxy: one live prompt carried 502 emitted but only
  25 unique terms. The decision is written to telemetry as `shadow_route` and
  changes nothing. On a real 7962-char prompt it chose `dense-primary` and
  estimated 584 ms against 644 ms measured.

  `bm25_no_fuzzy` is the fast lexical path (exact + prefix, 140 ms p50 /
  194 ms p90 against 1137 ms), default off, with a test that states the price
  outright: the typo stops finding its memory.

  `npm run candidate-union --workspace @bastra-recall/eval` builds the set both
  can finally be judged against — the union of dense top-N, lexical top-N,
  what is injected today, what sits just under the floor, and exact identifier
  hits. Over 12 queries it produced 545 candidates of which **19** are what
  today's answer contains, with 84 proposed only by the dense arm and 74 only
  by the lexical one. Those 158 are precisely what a set built from today's
  hits cannot contain, which is why every measurement so far was circular.

  All three stay inert until those candidates carry labels: they move ranks,
  and admission still hangs on a rank-derived score.

### Fixed

- **A recall that degrades mid-call now says so, names its score space, and
  stops lending a common word the authority to open a foreign project**
  (P0 points 2, 4 and 6 from `docs/recall-performance-handoff.md`).

  `recall-handler.ts` decided `hybridActive` from the circuit-breaker state
  BEFORE the search. A vector arm that misses its deadline or dies mid-call
  opens no breaker — it simply returns nothing and `recallHybrid` degrades to
  raw BM25 — so the handler kept calling that answer hybrid and computed
  `weak_result` / `no_home` for a fusion that never ran. It now reads the
  degradation off the same `done` stage the hook route already watched, and the
  response carries `score_kind` (`"rrf"` | `"bm25"`) plus `unfused` and
  `degraded`. No consumer has to infer the scale from the size of the number.

  The cross-scope bypass (#148) let a foreign-project memory into the session on
  one exact trigger term. After the anchor fix that term is at least verbatim,
  but a single ordinary word — "arbeit", "datei", "test" — sits in dozens of
  trigger phrases and declares nothing. `anchor_strength` now grades it the way
  `reflex.ts` has graded phrases since the 20.08. incident: two exact trigger
  terms, or one rare enough to speak for itself (document frequency from the
  live index, so rarity is a property of THIS vault). The bypass requires
  `"strong"`; an absent field keeps the pre-P0 behaviour, so an older daemon or
  a foreign caller never silently gets stricter.

- **Two correctness fixes in what reaches the model: the deliberate-trigger
  anchor stops accepting typos, and a degraded recall stops posing as a fused
  one** (P0 from `docs/recall-performance-handoff.md`).

  `matched_recall_when` means "the author declared exactly this situation as a
  trigger", and two permissions hang off it: the cross-scope bypass
  (`hook-skip.ts`) and the suppression of `weak_result` (`weak-result.ts`). It
  was read out of MiniSearch's `match` map, whose keys are DOCUMENT terms — so
  a prefix or fuzzy hit set it with a word the query never contained. Measured
  against the real vault, `obsidan` (one edit) and `tripwir` (a prefix) both
  claimed authored intent. It now requires a query term verbatim.

  When the dense arm times out, errors or is absent, `recallHybrid` returns raw
  MiniSearch scores instead of fused ones — an open-ended scale where the
  telemetry recorded 405,584 against a fused ceiling of 163.934. The endpoint
  says so via `unfused`/`degraded`; the prompt lane did not carry either field
  and measured the raw numbers against the 100 floor anyway: everything became
  REQUIRED, bypassed the backoff, and was announced as "both search paths
  agreed" while only one had run. The lane now carries both fields through to
  backoff, formatter and telemetry — no REQUIRED band, no bypass, no
  two-path claim, and the number is omitted rather than shown on a scale that
  cannot support a comparison. `write-lane.ts` already knew the field; this
  closes the same hole on the surface that was still open.

### Added

- **A rarity-based fuzzy switch for the lexical arm, plus the acceptance
  harness that measured it — and the measurement says it does not carry**
  (#362). The premise was that the BM25 time is the prefix/fuzzy EXPANSION of
  each query term rather than the term COUNT, so steering the expansion of
  common terms would be free where capping the query was not: no term is
  removed, so no document leaves the candidate set. In isolation that held
  (540 → 238 ms on the real vault, every baseline top-10 hit still inside the
  top 50). Through the production path it does not: `npm run bm25-expansion
  --workspace @bastra-recall/eval` runs 30 real prompts (2000–8000 chars) over
  the full hybrid pipeline and reports 1137 → 966 ms p50 at best, with one
  injectable id lost at every threshold that saves anything. Only `df ≤ 400`
  passes the ship rule, and it saves ~8 % against a ~3 % noise floor measured
  by running the baseline twice. The reason is structural: injection is
  decided by a rank-derived RRF score, so anything that permutes ranks moves
  hits across the floor of 100 — reordering is not qualitatively free, only
  cheaper-looking than removing. `bm25_fuzzy_rare_df_max` therefore ships
  default off, as the knob the harness measures with, not as a
  recommendation. The baseline it leaves behind is the usable result: the
  lexical arm sits at 1137 ms p50 / 1621 ms p90 on ordinary long prompts
  against a 200 ms target (#305).

## [0.9.1] — 2026-08-24

### Added

- **BM25 query cap (#362) lands as groundwork, off by default pending
  calibration** — the acceptance harness (15 probe queries, injection-relevant
  ids marked) found both measured budgets short of the ship bar (zero ids lost
  AND ≥90 % identical injectable sets): 200 chars lost an injection-relevant id
  on 15/15 queries (avg 2.27), 2000 chars still lost on 12/15 (avg 0.47), so
  `bm25_query_max_chars` stays unset — the mechanism (`bm25-query-cap.ts`)
  ships ready, only an explicit value activates it.

- **Stop, session and todo hook lanes join the compiled stub — the last three
  hook clients drop from ~80 ms node start to under 50 ms end-to-end** (#369).
  The lane logic moves from the CLI entries into stop/session/todo-lane
  modules behind `/hook/stop`, `/hook/session` and `/hook/todo` — the same
  daemon-side pattern the pre-lanes took in #343/#344. The thin clients and
  the compiled stub call them over HTTP with the #350 opt-in marker; without
  the marker, or against an old daemon, they degrade to the node fallback
  unchanged.

- **The embedding model is warmed at turn start — one small embed on
  `UserPromptSubmit`, fire-and-forget, so the assertion lane never lands
  cold** (#361). #305 is reopened for that lane: n=12, median 348 ms, p90
  749 ms, 25 % timeouts (19.–21.08.), while the prompt lane holds the ceiling
  at 191 ms median. The cold embedding model was the measured source of that
  variance before the per-arm deadline landed (#342: cold ~860 ms → 341 ms),
  and the deadline made a cold call *cheap*, not *good* — past 150 ms the
  dense arm is dropped (`degraded: "vector-arm-timeout"`) and the hit list
  comes back BM25-only. The lane arrives on time and says less.

  A turn has a known start: `UserPromptSubmit` fires before any tool call, and
  since #343 the daemon serves that lane itself, so it already sees every turn
  start — the warm call needs no new client call, no new budget line and no
  configuration. The lane never awaits it, never delays its response for it,
  and a failure is swallowed; by the time the turn's first assertion call
  fires seconds later, the model is resident. Not `keep_alive: -1`, which is
  what #78 rejected: that pins ~600 MB across idle gaps, whereas this model is
  only ever warm while a turn is actually running. A turn starting within 60 s
  of the last warm skips it — under the keep_alive the daemon already sends
  per embed (#78, default 10m) the model is certainly still resident, so the
  call would be pure noise, and a burst of short turns costs one embed per
  minute of work. It fires only when the dense arm is genuinely available,
  asked exactly as the recall path asks it: embedding index attached, and the
  #165 breaker not open (half-open passes — the warm call is a real embed and
  may serve as the breaker's single probe). And only against a local provider:
  the cold model this exists for is one whose residency the daemon governs via
  its per-request `keep_alive`, which a hosted embedding API is not — warming
  that one is one egress request per minute of active work for nothing.

  `prompt_hook_call` now carries `prewarm`: `"fired"`, `"skipped-debounce"`,
  `"skipped-hosted"` or `"skipped-no-provider"`. What decides the feature is the before/after on the
  same host over a week from `bastra logs --stats` — assertion-lane median /
  p90 / timeouts, and the count of `degraded: "vector-arm-timeout"` on the
  FIRST assertion call of a turn, which the prewarm is supposed to drive to
  zero. Whether the reopened 749 ms p90 is the cold model again or something
  else is the first thing that measurement answers; the prewarm removes the
  variable either way.

- **The compiled hook client ships per platform — `bastra install claude-code`
  downloads it on demand, sha256-verified against a manifest inside the
  package** (#350). #344 compiled the thin hook client with deno so every
  hook call starts in ~15–25 ms instead of node's ~86–89 ms — but only on
  hosts that ran `npm run build:stub`: a 168 MB binary does not fit npm. Two
  thirds of those 168 MB turned out to be the workspace's `node_modules`,
  which `deno compile` embeds whenever it finds a package.json next to the
  entry point — the stub imports none of it, and `--no-npm` brings the binary
  down to the deno runtime plus ~150 KB of our code (68 MB on arm64 macOS).
  The release workflow now builds `bastra-hook-<target>` for darwin arm64/x64 and
  linux x64/arm64 (the darwin pair on a macOS runner, where `codesign` proves
  the ad-hoc signature deno applies), attaches them to the GitHub release
  with `.sha256` files and a build-provenance attestation, and writes
  `stub/manifest.json` into the daemon package from the same run — so the
  installer verifies a download against the manifest it was installed with,
  never against something fetched next to the binary. The install asks once
  (`[Y/n]`), remembers the answer in `~/.bastra/hook-stub.json` so
  `bastra update` neither asks again nor silently loses the client, and takes
  `--stub` / `--no-stub` for scripts. Anything short of a verified binary —
  no manifest, no asset for the host, an npx runtime, a checksum mismatch —
  leaves the node client registered: the stub is acceleration, never a
  requirement. No Windows asset: the stub spawns `sh`/`ps`, which the Windows
  milestone owns. The deno flags moved from a package.json string into
  `scripts/build-stub.mjs`, the one place the workflow and the local build
  share — which is also where `--no-npm` now lives.

- **`packages/eval/src/band-occupancy.ts` — what the hook's two constants
  select, measured at the call the hook makes** (#302). #302 measured the bands
  once, at `RRF_K = 60`; #335 changed the scale under them and the closing
  comment left the re-measurement open. The instrument was a paragraph in an
  issue body, so re-asking meant re-arguing. It is a file now.

  The first version of it reproduced the original mistake and is worth stating
  because the correction is the feature: it called `recallHybrid(query, {k})`,
  and `/hook/recall` does not. That endpoint defaults `expand_hops` to 1, so a
  caller receives up to 2k hits — k seeds plus up to k one-hop neighbours,
  each scored `seed.score * 0.5 * link.score`, half a seed at best. On a
  649-memory vault at k=3 that is the whole difference between `dropped <30 =
  0.0%` and `2.6%`, and every dropped hit is a neighbour. No seed can reach the
  floor through that endpoint at all: `http.ts` clamps it to `k <= 10` and the
  k-th fused score is bounded below by `RRF_SCALE / (RRF_K + k)` = 32.79. So
  the floor at 30 is not inert, as #302 said it was — its job is narrow and
  real, and it is the only thing between the hook and a half-scored graph
  neighbour. `--hops` selects the shape and defaults to the hook's own; rows
  carry `hop` and `pos` so the two populations are never pooled.

  `--corpus` builds the vault from a BEIR corpus with the same code
  `rrf-k-beir.ts` uses, so the same question can be asked on something the
  reader can download. NFCorpus, 3633 documents: REQUIRED 58.5% on judged
  queries against 6.7% on absent ones at k=3, against 67.6% / 29.2% on a
  personal vault. The separation reproduces and is wider on the public corpus.
  The hop half does not reproduce there and is not claimed to — one document
  per memory means no `related_via` edges and no neighbours to score.

  `packages/eval/README.md` documents when each corpus is the finding and when
  it is the replication, why an absent query set is mandatory and has to be
  written per corpus, and why the harness prints two medians instead of one.

### Fixed

- **The two recall arms now overlap instead of running sequentially — BM25
  fires in the shadow of the dense arm's network roundtrip instead of after
  it** (#370). `recallHybrid` dispatched the dense-arm embed only after
  `this.mini.search()` had run to completion, even though the two arms share
  no data dependency (`fuseRRF` consumes both rank lists only after both
  return) — the wall clock paid their SUM instead of their MAX. Measured over
  n=1545 `hook_recall` events (19.–24.08.): `latency_ms_recall − (bm25 +
  vector)` sat at p50 1 ms / p90 2 ms, i.e. the stage timers summed exactly to
  the total and nothing overlapped. The dense arm is now dispatched first and
  awaited only after the BM25 pass, dropping the wall clock from p50 157 ms to
  p50 137 ms (prompt lane: 200 ms → 144 ms). Pure reordering — identical
  inputs into both arms, identical RRF result — with one invariant preserved:
  the dense-arm deadline (`abandonAfter`) is armed synchronously at dispatch,
  not at the `await`, so the reordering cannot silently widen its timeout
  budget. `vector.search`'s stage event now carries `overlapped: true`, since
  the two stage timers no longer partition the total.

- **`mode: none` only pays for a recall that could contribute — the wired pool
  and its 4h dedup are checked first** (#371). Since a50f849 (#217), `mode:
  none` — 91 % of prompts — ran a full-vault recall over ~955 memories and
  threw away everything not reflex-wired: p50 210 ms against p50 10 ms before
  19.08., with 83.5 % of those recalls injecting nothing. The lane now asks
  two query-independent questions first — is any memory wired reflex at all,
  and is at least one of them outside its 4h suppression window — and only
  then runs the recall; when it runs, it is byte-identical, so no hit that
  injects today is lost. Skips are visible as `recall_skipped` in
  `prompt_hook_call`.

- **`hook_recall` carries the session from the hook payload, and
  `ollama_lifecycle` says `session_id: null` instead of the boot id** (#363).
  cf411ca (#356) fixed the four hook-CLI lanes but not the daemon-side recall
  emitter: `logHookRecall` declared `Omit<…, 'session_id'>`, the type forbade
  the caller a session, and the boot UUID always won — on 22.08. 194
  `hook_recall` events sat under exactly 4 ids, the same 4 as
  `ollama_lifecycle`, i.e. 4 daemon boots. The value had long been in the
  route (`hookSessionId`) and fell out at the emitter. `ollama_lifecycle` has
  no session — `null` instead of a boot-id lie; the boot id stays as `run_id`
  so prewarm→unload pairing and boots-per-day stay readable.

- **Every generation call now names its own context window, and asks the model
  not to think** (#366, #367). `ollamaChat` is the only live chat client in the
  repo — the doc2query expander, the `/ui/chat` copilot, the far-bridge harvest
  and the expander compare tool all share it — and it sent neither
  `options.num_ctx` nor `think`. Without `num_ctx` the server default applies,
  and on the machine this was measured on that default is
  `OLLAMA_CONTEXT_LENGTH=262144` — above every installed model's maximum, so
  each one loads at its own ceiling: 262144 for `qwen3:4b`, a 36 GB KV cache on
  a 24 GB machine, 21.5 GB of it on the CPU side, 56.87 s to load — longer than
  the client's own timeout, which is why #143 recorded two models as failures
  that were never actually measured on expansion quality.

  Calls now send 4096 (the recipe `qwen3-recall`'s Modelfile already pinned —
  the one model that escaped the env, and only for that reason), overridable per
  call and via `BASTRA_OLLAMA_NUM_CTX`. Two lanes ask for more, each because its
  prompt is measurably bigger: the copilot (`buildQueryPrompt` carries the last
  4 messages at 2000 chars each ≈ 3k tokens) and the far-bridge harvest, whose
  rerank prompt is the largest in the repo — the candidate pool is
  `max(k*4, 20)` entries, uncapped downstream, at 200 chars each ≈ up to 5.4k
  tokens. That one was the sharper risk: over the limit Ollama truncates from
  the front, taking the query and the top candidates with it, and the harvest
  would have minted bridges from a silently shortened list.
  `packages/eval/src/persona-gen.ts` sends its own `num_ctx` on the same
  grounds. The request body is the right place for all of this rather than the
  server env: `options.num_ctx` overrides both that env and a Modelfile
  `PARAMETER`, while the env is a system-wide default governing every other
  Ollama use on the machine.

  `think: false` is the other half. A thinking model puts its entire reply into
  `message.thinking` and returns an empty `content` — `gemma4:12b` did exactly
  that on 8 of 8 sampled memories, `done_reason: "length"`, no error anywhere.
  Verified against the local Ollama that non-thinking models accept the field
  without complaint, so it is sent unconditionally rather than probed.

- **A failed expansion is no longer stamped into the vault as a finished one**
  (#367). `TriggerExpander.expand` wrote `recall_when_expanded` and the
  `recall_when_expanded_src` hash whenever it got that far, including when the
  model had returned nothing at all. The stamp is what made it unrecoverable:
  both `expand()` and `backfill()` skip a memory whose source hash matches, so
  an empty expansion written against an unchanged source is never regenerated —
  not by a restart, not by a reindex, not by a sweep, only by an author editing
  the memory. Pointed at a thinking model, the two paths that legitimately
  regenerate (every save from then on, and a deliberate
  `strip-trigger-expand.ts` re-expand) would have replaced the vault's ~4300
  phrases with empty arrays and frozen them there, silently.

  An empty *reply* is now treated as the failure it is: nothing written, nothing
  stamped, a log line naming the memory, and the next sweep retries it. The test
  is the raw reply, not the parse result — text that parses to nothing (the
  model echoed the existing triggers, or wrote only over-long lines) is a real
  answer for that source and still gets its stamp, because generation here is
  deterministic and retrying it would regenerate the identical nothing on every
  sweep. The self-test case is likewise untouched: when the model answered but
  no phrase survived filtering, the empty result and its stamp still persist,
  which is what keeps the reindex→embed→expand loop broken.

  A backfill sweep now also stops after five consecutive failed generations
  instead of discovering a broken model one call at a time — it runs on every
  daemon start, and a vault this size is hours of them. And the two swallowed
  errors on that path now log: an Ollama that rejects the request outright (an
  older server refusing `think`, a model no longer pulled) took doc2query out of
  service without a single line anywhere, which is quieter than the bug above.

- **A bare YAML date is still a date — an overwrite stops eating `created` and
  `valid_until`** (#364, #240). #240/A6 made overwrite a PATCH: every field a
  refresh does not send has to survive it, and `packages/core/src/save.ts`
  decided that with a type check against the value gray-matter parsed out of
  the file. YAML 1.1 parses a bare `created: 2020-01-01` into a JS `Date`, so
  the check said "not a string", the carry-over dropped the value, and the
  assembly fell through to its default: `created` restamped to today,
  `valid_until` and `last_reviewed_at` gone from the file entirely. The bare
  form is not an edge case — it is what Obsidian Properties writes and what a
  hand edit leaves; only files written by our own `matter.stringify` carry the
  quoted form the roundtrip test seeds, which is why the suite that exists
  precisely for this loss never saw it. The write path now coerces `Date` back
  to `YYYY-MM-DD` once, before any type check sees the value, the way
  `schema.ts` has always done on the read path; an unparsable date is left
  untouched rather than crashing `toISOString()`. Patch by zzallirog.

- **An overwrite stops eating `saved_at` — and stops poisoning gray-matter's
  parse cache** (#364, #240). Three leftovers from the fix above, all in
  `packages/core/src/save.ts`. The `Date`→`YYYY-MM-DD` coercion wrote into the
  object gray-matter caches per input string, so any later parse of identical
  content would have inherited a string where the file says `Date` — the very
  trap `related-enrich.ts` and `trigger-expand.ts` already warn about; the
  carry-over works on a copy now. `updated` left that coercion list, where it
  sat without a reader — `updated: today` restamps it on every write anyway.
  And the bookmark half never carried anything over: `saved_at` is a bookmark's
  capture time, not its write time, yet every overwrite restamped it — along
  with `url`, `og_image`, `read_status`, `categories` and `source_app`, which a
  summary-only refresh dropped from the file entirely. All six follow the same
  PATCH semantics as the rest of the frontmatter now.

- **The patch rollback copies bytes back and verifies them — `rolledBack` stops
  being a constant** (#365, item 1). `applySeries` in
  `packages/daemon/src/patch-registry.ts` discarded the `GitRun` of the reverse
  and reported `rolledBack: true` unconditionally — and a `--3way` merge cannot
  be undone by reversing the patch, so the operator was told the install runs
  unpatched while patched files sat on disk. The snapshot now lives at run level
  (first write wins, mode bits included), the reverse checks its exit status,
  and the copy-back has the last word: every file is read back and compared byte
  for byte. `rolledBack` is a measurement, `unrestored[]` names what did not go
  back, and `pendingPatchNotice` points at `~/.bastra/update-backups`;
  `last-run.json` grows additively. Reported by zzallirog.

- **A `private` memory is no longer named in someone else's file** (#365, item
  13). The auto-related enricher is the one write path that puts foreign ids
  into foreign memories, and `packages/core/src/related-enrich.ts` was the one
  place that never read `sensitivity` — every read path does (`search.ts`,
  `graph.ts`, the tool handlers), and `graph.ts` already suppresses exactly this
  edge rather than drawing it as a ghost silhouette. Any cosine neighbour above
  the threshold got a `related_via` entry plus a `- [[<id>]]` line in the body
  of whatever memory it sat near, and the id **is** the title
  (`id = slugify(title)`) — so the leak was the private title in plaintext,
  served to external MCP clients through `verbosity: 'full'`, through
  `read_document`'s raw body, and drawn as an edge in the Obsidian graph, two
  lines under a `sensitivity: team` nobody consulted.

  Private neighbours are dropped before the topN cut now, so they neither
  surface nor cost a visible neighbour its slot. The filter is one-directional:
  a private memory keeps its own `related_via` and its own auto-section,
  private neighbours included — that file carries the classification, and its
  content does not leave it; only the mention elsewhere was the leak. Existing
  edges heal without a migration script: the enricher's target/actual
  comparison sees the difference on the next embed (which fires on every save,
  cache hits included), rewrites the file exactly once, and is a no-op from
  there on. Reported by zzallirog.

- **The Ollama loopback guard classifies the host instead of its spelling, and
  fence-marker stripping runs to a fixpoint** (#365, items 8 and 10).
  `packages/core/src/ollama-egress.ts` tested the hostname text against
  `/^127\./`, so `127.evil.example` and `127.0.0.1.nip.io` read as loopback and
  memory text could leave the box, while `0.0.0.0`, `localhost.` and
  IPv4-mapped IPv6 were refused although they are local; `net.isIP` decides
  after a bracket strip now. In `scrub.ts`, `stripFenceMarkers` re-formed a
  working marker out of the halves of a nested spoof
  (`<recall-hints<recall-hints>>`) — it now iterates to a fixpoint, and an input
  that outruns the cap loses its angle brackets instead of handing back the
  fence the cap was meant to close. Reported by zzallirog.

- **A dead provider stops looking like an empty vault, and a warm query cache
  stops eating the deep pool** (#365, items 4, 5, 14 and 16). A provider error
  was indistinguishable from an empty vector arm, and the one-armed result was
  cached — `runtimeHealth()` now carries a monotonic `errorCount`,
  `packages/core/src/search.ts` compares it around the vector call, skips the
  cache and labels the result `vector-arm-error`. A query-cache hit fired
  `onCandidatePool` not at all (BM25) or with the served k hits (hybrid)
  instead of the deep pool; the pool travels in the cache entry now and is
  emitted on every hit, cloned only when a callback is set. Staleness treats a
  non-positive touch window as fresh on the `valid_until` branch too, and the
  ranking callback runs after damping, on the ranked list. No new await and no
  new I/O on the hot path. Reported by zzallirog.

- **The audit cache follows the file, and trash lookups stop at the id
  boundary** (#365, items 3 and 11). The ledger is cross-process, but
  `packages/core/src/audit-log.ts` held a per-instance `readAll` cache that hid
  foreign appends, so `lastDeleteFor` missed a delete sitting in the file. The
  cache is keyed on mtime + size instead; only `ENOENT` counts as a missing
  ledger, and any other stat error serves the warm cache or throws rather than
  reporting an unreadable log as an empty one. `latestTrashPathFor` matched by
  prefix, so `foo.bar.md` passed as a version of `foo`; it requires the exact
  stamp format now. Reported by zzallirog.

- **A vault under a dot-root is watched again, column-zero lists keep their key,
  and a finished recall stops saying it drags** (#365, items 2, 9 and 15). The
  watcher's dot filter in `packages/core/src/vault.ts` ran on the absolute path,
  so a vault under `~/.local/share` watched nothing at all; it filters relative
  to the root now, with a leading `..` only counting as an escape as a whole
  segment (`..sync/` stays ignored). `frontmatter-rescue.ts` treated a
  column-zero list item carrying `": "` as a key, silently dropping
  `recall_when` and logging a misleading damage entry. And the banter's duration
  checks skip terminal stages now (`done`, `cache.hit`, `error`), so a recall
  that is already finished no longer narrates itself as dragging. Reported by
  zzallirog.

- **`bridges harvest` judges with the configured model, `import vault` counts
  landings, and the update docstring stops denying its own body** (#365, items
  6, 7 and 12). The far-slice reranker in `packages/daemon/src/cli/bridges.ts`
  ignored the persisted generation model and read only the env/default pair —
  it calls `resolveGenerationModel()` the way the daemon does now
  (`BASTRA_EXPAND_MODEL` outranks `BASTRA_RERANK_MODEL` when both are set).
  `import-vault.ts` counted attempts in `byAdapter`, not imports; the increment
  moved next to the save. And the `update-check.ts` docstring described an
  auto-apply that has lived elsewhere since #81. Reported by zzallirog.

- **The audit log reads stat and content through one file handle, and
  `abandonAfter()` clamps its timer at the sink** — the release CodeQL pass
  flagged both: the ledger's separate `stat` + `readFile` left a TOCTOU window
  a concurrent rotate could fall into, and the deadline timer trusted its
  caller to bound the duration. `readAll()` now opens once and stats/reads the
  same descriptor; no timer outlives `MAX_DEADLINE_MS` (10 s) regardless of
  what a future caller passes.

## [0.9.0] — 2026-08-02

**Honest numbers, nothing silently lost.** The milestone this release closes is
45 issues wide, and they share one shape: not a crash, not an error, but a
number that was not true or a thing quietly missing while every surface
reported healthy. An update that installed the new version and left every
client running the old one. A doctor saying 7/7 healthy over a hook pointing at
a deleted runtime. An installer printing a map URL four lines above its own
"not reachable". A `curl | bash` that exited 0 having registered nothing.

0.8.9 was the test release for exactly this: its fixes were re-verified against
a real published release on a clean macOS VM before this one was cut. That pass
confirmed #304, #306, #307, #312, #317 and #318, and surfaced three more
findings, which are fixed below. The 0.8.9 section documents what came before
them.

### Fixed

- **An update no longer tells you your local patches survived when they did
  not** (#269, #303, #327). A source install has two roots — `dist/cli.js` sits
  in the daemon package root, while a patch made by `git format-patch` off the
  checkout addresses files from the repo root — and one variable stood for
  both. `git apply` run from a subdirectory does not fail on a path outside it:
  it prints `Skipped patch`, changes nothing, and exits 0, which the apply path
  recorded as *applied*. The skip guard that already existed on `--check` now
  covers the apply calls as well.

  `git apply --3way` was the second half. It is not a probe: when it cannot
  merge it writes `<<<<<<<` into the tree and stages it, and only *then* exits
  non-zero — so "it failed, therefore nothing happened" was false, and a patch
  reported *set aside* could leave a tree that no longer parsed. It now
  snapshots every file the patch addresses, restores them byte-for-byte on a
  failed merge, and runs against a copy of the index so a conflict cannot stage
  anything real. That snapshot includes the source side of a rename, which the
  `--numstat` plumbing does not report and which git writes C-quoted
  (`"sp\303\244t.txt"`) in the patch header; without it a failed 3-way took
  both paths with it. When the file list cannot be established at all, the
  3-way is declined rather than attempted unreversibly.

- **`curl https://bastra.io/install | bash` stopped after installing Homebrew
  on a first run** (#323). Under a pipe, bash reads the script from stdin
  incrementally, and a child that also reads stdin consumes the not-yet-parsed
  remainder — so `brew install` ate step 4/4. Nothing was registered: hooks
  0/7, all three surfaces missing, and `bastra --version` printed the new
  number with exit status 0, making the run indistinguishable from success.
  stdin is now redirected away from the script pipe for every child that could
  read it, the body moved into a `main()` called on the last line so the whole
  script is parsed before anything runs, and the installer verifies at the end
  that at least one AI client was actually registered.

- **The map URL the installer prints now opens** (#322). A fresh install left
  no daemon running — there is no LaunchAgent, and the forwarder only spawns on
  the first MCP call — so the one onboarding route documented as working
  without an AI session could not start without the thing it precedes.
  `bastra map` and the guided setup start the daemon and wait for `/health`
  first, and open nothing if it does not come up. `status` deliberately still
  starts nothing and reports the daemon as down instead.

- **The preserved Stop hook kept its old path across updates.** #48 made
  install preserve a Stop hook the user had opted into; it preserved the whole
  entry including its path, while every other event is rebuilt from the current
  definition. So the one hook that survives an update was the one still running
  replaced code — and `pruneOldRuntimes()` then deletes that directory, turning
  "runs old code" into "points at nothing". doctor reported 7/7 healthy
  throughout. The opt-in is what #48 protects; the path is not part of it.

- **The save-quality collision warning fired on 97.2% of saves** (#300). It
  filtered recall hits by an absolute floor of 30 on a scale that spans 0.3 to
  1861 on a real vault, so the floor passed the whole pool by construction and
  the penalty landed on almost every save — citing memories with no topical
  relation. A collision is now defined as what the field actually promises:
  another memory declaring *the same situation*, measured as containment
  between single `recall_when` sentences. Against 2516 scans on 661 memories
  with 33 verbatim-duplicate triggers as the gold set, the false rate drops
  from 90.4% to 0.9% at an unchanged 100% hit rate. Scans that fire at all:
  97.2% → 2.2%.

- **Ollama is detected on Windows** (#316, part of #84). `findExecutable()`
  split `PATH` on a hardcoded `":"` and probed for the POSIX executable bit, so
  on Windows nothing resolved and every tool was reported "not installed" while
  sitting on `PATH`. It now splits on `path.delimiter`, resolves through
  `PATHEXT`, and scopes the Homebrew fallbacks and ownership checks to
  non-Windows; POSIX behaviour is unchanged. Claude Desktop's config directory
  resolves per platform instead of being hardcoded to the macOS location. This
  is the detection half of #84 — automatic install and a persistent Ollama
  service on Windows are still open.

### Added

- **The Mindspace map gained a galactic core you can switch.** Nine cores
  behind a select under "Mindspace · Experimental" — classic, jets, Binary
  Hole, Feeding, Collapse, Double Pulse, Heartbeat, Quasar, Gravity Web. Adding
  one is a single entry in a registry. Gravity Web hangs its threads on the
  user's real memories rather than decorative points, which is a layout change
  and triggers a relayout; every other core is a pure decor swap and the
  shipped `classic` stays pixel-identical.

- **Two experimental Mindspace lab modes**, both additive — the shipped
  `universe` and `galaxy` modes and the whole rendering layer are untouched.
  `universe-lab` classifies each cluster onto the Hubble sequence from one
  measured property, the Gini coefficient of its degree distribution, and
  places them by 3D force relaxation over the bridge edges. `galaxy-lab` draws
  one Milky Way instead of galaxies orbiting galaxies: the user is Sgr A*, big
  projects are arms, sub-folders are star-forming knots on their project's arm.
  Star rotation follows a flat disc-galaxy curve rather than Kepler, so the
  outskirts still visibly move.

- **View and Activity moved into two popovers** at the top of the right rail
  ("Filters & Options"). Stacked, they had eaten most of its height.

### Changed

- **The daemon reads its version from `package.json` at runtime.** It sat as a
  literal in four places while `bump.mjs` only rewrites `package.json`, so the
  0.8.9 bump covered part of the tree only and the daemon reported 0.8.8 in
  `/health`, in the MCP handshake, and to the update check — which compares
  that very number against the published one. `bump.mjs` now refuses a version
  literal instead of rewriting it.

## [0.8.9] — 2026-08-02

A test release. Everything here came out of the v0.9 release gate (#213) — a
manual end-to-end walk through all three install paths, the onboarding block
and the import, on a clean macOS VM. Twelve findings, none of which stopped a
route from completing: they were cases where something was unclear, silently
absent, or reported a number that was not true. These are the fixes; v0.9
follows once they are verified against a real release.

### Fixed

- **An update from an npx-started process installed the new version and left
  every surface running the old one** (#304). `ensureStableForwarder` pins
  `~/.bastra/runtime/<version>/` using `VERSION` — a constant compiled into the
  *running* process. `bastra update` performed the npm upgrade and then
  re-registered in that same, old process, so it re-pinned its own old version,
  found last run's marker, reported `reused`, and the freshly installed code was
  referenced by nobody. Nothing failed: the installer succeeded, `bastra
  version` printed the new number, and the update was simply not in effect.
  The re-registration is now handed to the newly installed binary, and `bastra
  doctor` reports a stale pin — the quiet third case next to *missing* and
  *ephemeral*, which never breaks and just runs replaced code.

- **`npx bastra-recall install` left no `bastra` command** (#317). The guided
  setup completed, three clients were registered, the runtime was pinned — and
  every documented next step answered `command not found`. npx executes a
  package, it never installs one. The setup now offers the global install once
  at the end and runs it only on an explicit yes; declining prints a working
  invocation instead. Not a launcher shim, which would have pinned the `bastra`
  command to one version permanently — the stale-pin failure above, rebuilt at
  the entry point.

- **`import vault` reported a total its own breakdown contradicted** (#312).
  The synthetic curated-index node counted toward the total but through no
  adapter, so `57 + 16 = 73` was printed directly beneath a total of 74. The
  same pass sat behind `!dryRun`, so a preview predicted one node fewer than the
  run it previewed. Fixed by adding the missing category rather than reconciling
  the numbers.

- **A category created after page load only appeared on the map after a manual
  reload** (#307). Live updates carried the cluster alone while every node in
  the graph projection carries cluster + group + sub, and the client hardcoded
  the fallbacks on adopt. On a fresh vault the user cloud does not exist yet —
  it is created by the very memories being written — so the onboarding result
  sat there as loose points until someone reloaded.

- **The install prompt offered to create a vault that already existed**
  (#318). `Create ~/BastraVault (recommended)` was shown over a directory
  holding 74 memories. It now probes and says what it found, using the same
  loader the daemon indexes with rather than a second counter that could drift.

- **`Install Bastra.command` was documented as a release download and had never
  been attached to a release** (#306). The file only ever lived in
  `distribution/`; the documented download resolved to nothing.

### Added

- **A curl installer** (#320). `curl -fsSL https://bastra.io/install | bash` is
  now the recommended path for people who do not open terminals. The
  double-click script stays, and the README now says what actually happens with
  it: a browser download arrives without the executable bit and under
  quarantine, so it needs `chmod +x` and right-click → Open. That path was only
  ever tested from the repo copy, which has neither problem.

## [0.8.8] — 2026-07-28

### Fixed

- **Concurrent `saveMemory` calls no longer overwrite the writer that won the
  id first** (#285, #245 follow-up). They now commit under a per-target
  exclusive claim, compare the exact preimage again at commit time, and publish
  a new file without replacement. Callers that prove ownership first can pass
  that raw preimage as `expectedTarget`, so the proof and the write are one
  compare-and-swap operation; import does this for both notes and its synthetic
  index. A losing writer gets the stable `BASTRA_WRITE_CONFLICT` error and can
  retry from the current file instead of silently replacing it. A claim whose
  owner died mid-commit is reclaimed rather than blocking the id forever: it
  records the writing process and machine, and a later writer takes it once the
  owner is provably gone or the claim has aged past its window.

- **The hooks were losing one recall in sixteen, silently.** The budget that
  cuts a hook off if the daemon is slow sat at 250 ms — just under what a real
  recall costs. Measured over 30 days of actual use: 12,966 calls before an
  edit, median 60 ms, but a 90th percentile of 225 ms and 806 timeouts. Every
  one of those was an edit that should have been warned about a stored
  decision and wasn't, with nothing in the interface to show it. The ceiling is
  now 600 ms, which the same measurement puts at 65 % headroom. It costs
  nothing when the daemon is quick — a timeout is a ceiling, not a wait. (#252)

### Added

- **`bastra logs --stats` — the hook lanes, read out.** The event log already
  recorded which trigger fired, whether the daemon answered in time and whether
  anything came back; it just took a grep and a hand-written script to see it.
  One command now aggregates it per lane: how often each fired, how often it
  surfaced something, and where the latency sits against the budget. It found
  the timeout loss above on its first run — an average over all events had
  hidden it, because the lane that never recalls is fast and drags the mean
  down. (#279, first slice)

- **An update no longer replaces your local changes without saying so.** If you
  patched something in the installed package — as happened here for days while a
  locale fix waited to be merged — `bastra update` used to overwrite it silently,
  and the automatic update did it unattended. It now takes a fingerprint of the
  installation, notices what you changed, **copies those files aside before
  anything is replaced**, and asks before continuing. The automatic update
  refuses outright and leaves a note the next session shows you, rather than
  deciding for you. Reapplying your changes afterwards is a separate step, still
  to come. (#268)
- **Updates check where the package came from.** Every release is published
  through a protected workflow that signs it. Before installing, that signature
  is now verified. Deliberately narrow: only a genuinely bad signature blocks —
  an unreachable registry, an offline machine or an npm too old for the check
  are reported and let through, because a verifier that cannot run must not
  become the reason nobody can update. (#226)
- **The status panel shows both versions when they drift apart.** CLI and daemon
  can be on different versions after a partial update; until now one of them was
  quietly displayed as if it were both. `bastra doctor` says so too. (#225)
- **A dormant Ollama gets mentioned instead of ignored.** If semantic recall is
  off but a local Ollama is running, the panel now tells you it could be turned
  on. (#224)
- **Recall now also fires before a claim, not just before an edit.** The hook
  that reaches the assistant was bound to file edits — but writing a sentence
  edits nothing, so a draft reply, a changelog entry or an answer about "what
  we measured" came straight out of model memory while the vault held the
  number. That happened twice in one week here, once publicly. Asking for
  outbound text or for the project's measured state now recalls first, and the
  assistant is told to write that it doesn't know rather than guess when the
  vault has no answer. Deliberately narrow: two signals are needed, so "write
  a helper" still fires nothing. (#252)
- **The skill installs as a directory.** Both install paths — `bastra install`
  and `packages/skill/install.sh` — carried exactly one file, so any reference
  file next to `SKILL.md` would have been a dangling pointer. They now carry
  the whole skill, and the copy that ships inside the npm package is
  regenerated on every build instead of by hand (it had drifted three edits
  behind). Prerequisite for splitting the skill. (#232)
- **The skill got half its size back.** Its instructions had grown to the point
  where a third of them repeated what the tool descriptions already say on
  every turn — and every duplicated rule dilutes compliance with all the
  others. The core is now triggers only, half as long, and the mechanics live
  where they are read: in the tool descriptions, at the point of use. Four
  subsystems that fire on a minority of turns — project topology, establishing
  a convention, adopting imported memories, Commons — moved into reference
  files the assistant opens when their moment arrives, and each gate now names
  its own file so the pointer arrives with the signal instead of sitting in
  context all day. (#232)

### Fixed

- **The file-size hint stops scolding throwaway files.** A sandbox or lab
  directory is where oversized files are the point; the hint now stays quiet
  there and keeps working everywhere else. (#280)
- **Three things the code did but the docs never said.** From a field report on
  a mixed Russian/English vault: the bridge layer is latin-alphabet only, so a
  non-latin vault gets ordinary recall but no vocabulary expansion; reflex
  `recall_when` phrases must match *every* content word, which makes a
  sentence-length trigger a dead one, and the stopword list that softens that
  is German and English only; and the event log lives at `~/.bastra/logs/`,
  not inside the vault. Docs only — nothing behaved differently. (#257)

### Added

- **A memory can carry a command that proves it.** Notes that state facts about
  the world — "the daemon listens on 6723", "that file exists" — go stale
  quietly, and then keep being recalled as if they were still true. You can now
  attach a short command to such a memory (`verify_cmd`), and whoever loads it
  later sees it with a note: check this before relying on the claim. **Nothing
  runs it automatically** — not the daemon, not the background pass, nothing.
  It is shown, and the session decides under its own permission rules, because
  the command lives in your vault and is yours to judge. Turning a failed check
  into an actual staleness signal is a later step that needs its own security
  round. Shape borrowed from zzallirog's ida-box. (#235)

### Added

- **Recall can now say "this isn't in your vault at all".** There is a
  difference between finding the wrong note and finding nothing — and until now
  the daemon could not tell you which had happened, because on the hybrid search
  path a top result always looks confident. The new `no_home` signal fires when
  the best hit exists in only one of the two search arms, which is the shape an
  absent fact takes. It is deliberately narrower than `weak_result`: a wrong-but-
  real match still looks like a match, and pretending otherwise would make the
  signal lie. Both are recorded locally now, so "how often does my vault come up
  empty?" becomes a question with an answer. Found by zzallirog while
  dogfooding. (#230)

### Fixed

- **The hints your agent gets on every edit stop calling noise a strong match.**
  When you edit a file, bastra injects a few memories it thinks are relevant.
  The daemon already knew when none of them actually matched — on the hybrid
  search path a top score is high by construction, because a list always has a
  first element — but it only told the MCP path, never the hook path. So every
  `rm -rf` and every file edit got the same handful of unrelated memories under
  the heading "Strong matches". They are now labelled for what they are: ranked,
  but nothing anchored, treat as probably-not-relevant. The flag is also written
  to the local telemetry now — over 3,126 real recalls in a week it had read
  zero, which looked like health and was actually silence. (#249)

### Added

- **Every write the assistant makes now leaves a record.** The vault has kept an
  append-only audit log for a while, but it was only wired into the Mac app —
  the MCP and REST paths, which is how your AI actually writes, went past it. So
  the one surface that runs on its own was the one you could not review.
  `save_memory`, `save_product_doc` and `archive_memory` now append to
  `.bastra/audit-log.ndjson` with what changed, when, through which surface, and
  the state before and after. Telemetry was never a substitute — it can be
  switched off and is pruned after 90 days; this log is neither. If the log
  cannot be written, your save still succeeds. (#206)

## [0.8.7] — 2026-07-27

A patch release for one reason: two of these are paths on which data could
disappear without anyone being told. Those do not wait for a feature release.

### Added

- **A memory can now say "I am the new version of that one".** Pass `replaces`
  to `save_memory` and both memories record the link. The old one **stays in
  your vault** — still there, still findable by its id, still opening when
  something cites it. It becomes a previous version, not a deleted one, and
  opening it tells you a newer version exists. That is the difference from
  archiving, which retires a memory and takes it out of circulation. Nothing
  about ranking changes yet: a superseded memory is found exactly as before.
  This release lays the track — what a later version does with it (showing old
  versions as faded, letting you search them deliberately) is built on top.
  (#164)
- **Saving a memory now tells you when its triggers just repeat the summary.**
  On a real 471-note vault, 81% of notes had their first `recall_when` phrase as
  a verbatim copy of the summary — which spends the strongest search field on
  text that is already indexed at a lower weight, and leaves the trigger that
  should fire carrying no distinct signal. Rewriting those into real triggers
  moved that vault's recall@5 from 0.457 to 0.565 while making the notes
  *smaller*. `save_quality` now points at the ones that restate, and the
  guidance says it plainly: name the situation, not the content. Advisory only —
  it never blocks a save. Found and measured by zzallirog. (#238)

### Fixed

- **Half the galaxies were turning the wrong way.** Real spiral galaxies trail
  their arms — the outer tips lag behind the rotation, they never lead it. The
  map wound every disc the same direction while picking each galaxy's spin
  direction at random, so on any vault roughly half the galaxies rendered
  leading arms and read as spinning backwards. The winding now mirrors the spin
  sign, so both handednesses still occur across a universe and both are
  physically right. (#283)
- **The save-time duplicate warning stops inventing numbers.** It used to decide
  "this looks like a duplicate" from a raw search score — a number that grows
  when a word is repeated, grows with the size of your vault, and had no fixed
  meaning at any threshold. The result was unrelated memories presented as
  near-duplicates at five-digit "scores", nudging the agent toward overwriting
  the wrong note. Search now only proposes candidates; the decision runs on a
  real content overlap between 0 and 1, computed over the fields you actually
  wrote, and the penalty follows how similar the two memories are instead of how
  many candidates came back. Repeating a term cannot move it, and the same pair
  of memories scores the same on a small vault and a large one. Trigger
  collisions now say "matches 20 of 21 memories in this scope" instead of a bare
  count, and a count the search had to cut short is marked as a lower bound
  rather than printed as if it were exact. (#239)
- **A broken character no longer costs you the whole note.** The vault loader
  used to drop any memory whose frontmatter did not parse — an unknown escape
  sequence inside a quoted value, an unquoted line containing a `:` or a `·`,
  a missing required key — and the only trace was a warning on a daemon stderr
  nobody reads. On one contributor's vault that was 28 notes, invisible in
  Obsidian's file list and absent from every recall. The loader now rescues the
  frontmatter one entry at a time, fills what is missing from what it can know
  (the filename, the body, the file's own timestamp), and keeps the note in the
  index. Nothing is rewritten on disk: the repairs live in memory and are listed
  in the vault report under "Damaged frontmatter", so the damage is something
  you can see and fix rather than something that quietly happened. Structural
  strictness is unchanged — a file without a recognizable `type:` is still an
  ordinary note, not a memory. Reported by zzallirog. (#222)
- **The folder import stops guessing about who owns a node.** Four paths could
  still overwrite a stranger through `saveMemory(overwrite:true)` — which is
  temp+rename with no trash, so the loss is final. A prior import with no
  recorded source path now counts as foreign rather than as its own predecessor
  (this one hit every existing user on the first reimport after updating); a
  read error while checking ownership is refused instead of read as "nothing
  there", which matters on the cloud mounts this project supports; ownership is
  re-checked immediately before each write; and an exhausted id allocator skips
  the file rather than handing back an id it never verified. Every refusal is
  visible in the import's `skipped` list. Follow-up to #240, found by an
  adversarial counter-audit. (#245)
- **`bastra skills add` says what it actually did.** It reported that a ghost
  now renders as a skill while minting a fresh empty node beside the untouched
  ghost — because in an imported vault the name you know (`uncertainty-check`)
  and the id your notes link (`memory-uncertainty-check`) are different strings.
  The command now resolves the name against the ghosts that really exist, tells
  you which id it took, refuses when the name matches more than one, and admits
  when it adopted nothing at all. The help text no longer claims the link slug
  and the node id are always the same. Reported by zzallirog. (#223)
- **`bastra bridges harvest` no longer dies on a model it never pulled.**
  The far-slice reranker fired its default Ollama chat model blind and 404'd
  at the first case on any machine without it. Harvest now probes `/api/tags`
  first and resolves to an installed model — exact tag, same family, or any
  other chat model — and when nothing fits it says which model to pull instead
  of erroring mid-run. `BASTRA_RERANK_MODEL` still overrides. Reported by
  zzallirog.

### Security

- **The Commons target is allowlisted.** `BASTRA_COMMONS_REPO` fed both the
  clone and the contribution PR with no check on where it pointed, and the
  contribution path is egress — a redirected repo would receive your
  verification records. Only `github.com/n0mad-ai/…` is accepted now; anything
  else is refused before the clone and before the push, and it fails closed, so
  a local path or an unparseable value is refused rather than passed through to
  git. `BASTRA_ALLOW_REMOTE_COMMONS=1` opts in on purpose and prints the
  overridden target every time. Flagged by zzallirog during a security read.
  (#260)

## [0.8.6] — 2026-07-22

The mindspace stops being a picture of your vault and starts being a view of it
working. Alongside that, the import path came through an adversarial re-audit —
several findings were destructive, and they are the reason this release exists.

### Added

- **Activity travels the strands.** When a memory is recalled, read or written,
  the bolt now runs along the actual edges to its neighbours instead of cutting
  across empty space — memory to memory to memory. How far a bolt may leave its
  strand, how long activity keeps running, and whether it runs at all are
  sliders and a switch in the sidebar, because ambient motion is a preference,
  not a feature.
- **Nodes say why they glow.** Usage heat is drawn only where there is real
  demand rather than after a single graze, the demand clock carries a time term
  so old attention fades, and a node's tooltip explains its own brightness.
  `GET /api/v1/graph` now serves the raw counts behind the normalized share, so
  the number is auditable and not just pretty.
- **Live notices for recall.** Every hit that `recall` and the PreToolUse hook
  actually serve surfaces as a notice — you can watch which memories your agent
  is being handed while it works. The notices are a deck with a tick rail
  instead of a wall of cards, and the session history uses the same rail.
- **Local weather, opt-in.** The map can tint its backdrop with the weather
  where you are — picked by GPS or typed into a topbar chip that shows
  temperature, condition and place. Off until you choose a place; coordinates
  are rounded to ~11 km and the picker states plainly, before you decide, that
  they leave the machine.
- **Depth-true galaxy labels** in the universe view, and a re-tuned mindspace
  that reads as space rather than as a disc.
- **`GET /api/v1/health`** — reachability without spending a recall.
- **A TypeScript producer for the anno-check symbol table** (`tools/`), built
  from the compiler. The annotation gate's reference producer reads a code-graph
  engine we do not run; the format needs neither. Verified against the reference
  implementation's own fixture, symbol for symbol.
- **doc2query bridge for colloquial RU/UA → EN** in the eval corpus, with a
  register guard so documents already written in the target register are not
  expanded a second time.

### Fixed

- **`save_memory` with `overwrite` is a patch, not a replace** (#240, #239,
  #242). It silently dropped every field the caller did not resend — provenance,
  valence, relations. Overwriting to fix a typo could strip a memory bare.
- **Import never overwrites a foreign node** (#240). Provenance is checked
  before a write, and the automatic legacy migration was removed outright rather
  than made safer: it could lose data, and no import needs it.
- **No destructive or half-applied file operations** (#240/A4, A5). Trash moves
  are versioned, document writes cannot land partially, and a failed step leaves
  the vault as it was.
- **An import batch keeps its structure.** A single-batch import collapsed every
  memory into one cluster because the source hierarchy sat unread in
  `topic_path` — found and fixed by **zzallirog** (#243), whose PR also brought
  the re-announce cooldown for live notices.
- **A save no longer announces itself twice.** The save path indexes its own
  write and the watcher then reported the same file as a fresh add, so the
  topbar counter rose by two per save and only a reload put it straight.
- **A notice reaches its memory after a daemon restart.** The delivery cursor
  lives in daemon memory and resets to zero on restart, which silently swallowed
  the events an open map had not yet seen — including the birth of a node it
  then could not open.
- **A busy memory still announces itself.** The quiet window could be re-armed
  without bound by a steady writer, so a memory under load never surfaced at all.
- **Index detection judges prose per link**, not preamble length, so a genuine
  index is not mistaken for a note and vice versa.
- **`find_document` reports `docs_indexed`**, so an empty result is readable as
  "nothing indexed" rather than "nothing found".
- **The weather chip catches up** instead of showing a reading from hours ago
  when the tab has been in the background.

### Security

- **The map runs under a Content-Security-Policy** that bounds its egress to the
  hosts it actually needs.
- **Three patchable advisories pinned out** of the MCP SDK's dependency tail.
- The CSP test compares hosts instead of matching substrings, so a permissive
  policy can no longer pass by accident.
- `BASTRA_ALLOW_REMOTE_OLLAMA` is documented as the explicit opt-in it is.

## [0.8.5] — 2026-07-19

### Added
- **Intake adoption** (#217): imported memories start as lean "intake" nodes and
  are *adopted* into the full memory format when Claude actually uses one —
  adopt-on-touch (one per turn), adopt-merge when a duplicate check hits, or in
  bulk on request. A new **`archive_memory`** MCP tool retires the original
  (vault trash + forget) and stamps `superseded_by` on the archived copy, so the
  adoption stays auditable from both sides. The curator proposes adoption
  candidates for intake memories that keep earning recalls (≥ 2 acted-on recalls
  in 30 days; `BASTRA_ADOPTION_PROMOTION_MIN`) through the pending-suggestions
  relay — it never self-wires.
- **Opt-in galactic mindspace**: the map's Mindspace can render your own
  memories as a slowly rotating core with every area orbiting it. Two display
  controls: **Distance** — `woven` (areas pull inward by how much they share
  edges and usage heat with your memories) or `balanced` (spaced by size) — and
  an **orbital drift** toggle. Off by default; the standard Mindspace view is
  unchanged.
- **Persona-aware onboarding**: the onboarding interview adapts to a chosen lens
  — developer / business / personal / mixed. Developers get convention questions
  (file-size guide value in lines, which folder holds what); the answers become
  profile memories, and a named size guide is written straight to `size.guide`.
  Runs across the vault map, `bastra onboard` and the session hook.
- **Language-first recall** (#231): onboarding asks for your primary authoring
  language — 12 explicitly named languages recognized, with a statistical
  German/English detection fallback when none is named — and persists it as
  `language.primary`. The session hook injects a `<memory-language>` guide so
  memories get written in your language (genuine tech terms stay English), and
  `save_memory` returns a quality advisory when an English `recall_when` is saved
  on a non-English vault. The recall hook's query is now language-neutral (file
  identifier + topics, no English filler verbs), so an English template no longer
  spends recall's lexical vote on tokens a non-English vault can't contain — kill
  switch `BASTRA_HOOK_QUERY=english` restores the old action-verb template.
- **Score transparency** (#230): with `verbosity: "full"`, each recall hit now
  carries the RRF rank pair its score is built from — `rrf: { rank_bm25,
  rank_vector, raw }`. `recall` also returns a top-level `weak_result: true` when
  no returned hit actually matched a `recall_when` or title on the hybrid path —
  an explicit "nothing really matched here" signal that rides alongside the
  structurally-high rank score and filters nothing.
- **File-size guard hook**: a new `PreToolUse` check counts a code file's lines
  before every Write/Edit and injects a compact `<file-size-check>` block as the
  file nears the guide value — the size convention is enforced deterministically
  instead of relying on the agent to remember it. Thresholds resolve
  env > `bastra config set size.guide`/`size.critical` > built-in (500 guide /
  800 critical; test files 700 / 1000). Kill switch `BASTRA_SIZE_CHECK=off`.

### Fixed
- **Ring view — PROJECTS stays instance-browsing**: the PROJECTS ring now always
  shows one project at a time with the sidebar switcher, independent of the
  project count, instead of flipping to fan-out mode once the cluster count
  crossed the instance threshold under the user's feet.
- **Import: cleaner graphs from real vaults** (zzallirog 0.8.4 verification
  round): wikilinks written *inside* code spans no longer parse as edges (shared
  `stripCodeSpans` helper) — no more phantom edges/ghosts from prose *about*
  links; a file other notes link to is imported as a real hub, never skipped as a
  nav file; and `MEMORY.md` indexes are harvested into sections + per-file
  descriptions, tied together by a single navigation-hub node (a native
  Claude-Code memory went from 52 disconnected islands to 53 nodes / 50 edges /
  0 ghosts). The core graph's edge keys use unicode escapes instead of literal
  NUL bytes, so the graph file is no longer binary to grep and other tools.
- **Embedding backfill race** (#233): a save that lands in the drain end-window
  (queue already empty) no longer strands its embedding — fast sequential saves
  all get indexed.
- **Care flags keep their notes** (#228): the note field stays hidden until a
  flag kind is picked, and "Flag for session" no longer silently swallows a typed
  note when clicked before a kind is chosen.
- **Live updates are lossless** (#234): vault events are no longer dropped under
  load; reading the same memory several times collapses into one history entry
  with a ×N counter once the reads settle, and the panel polls by delivery
  sequence so nothing between polls is missed.
- **Mindspace flow sheen — steady tempo**: the sheen that glides along active
  strands now animates at a constant tempo regardless of strand length (a fixed
  wave period instead of per-line), and no longer speeds up the longer the map
  has been open (the phase wraps travelled distance before normalizing, killing
  the session-age time-dilation).
- **Semantic depth view is navigable** (map): in depth mode, drag rotates and
  shift-drag pans (the same orbit gesture as Mindspace), and the old auto-spin is
  now an opt-in hint toggle, off by default. The flat/depth toggle no longer
  leaks into views that don't have it.

## [0.8.4] — 2026-07-18

### Fixed
- **`import vault` slug-twin ghosts** (#219, zzallirog field report): body
  wikilink targets now go through the SAME slugify as the minted node ids —
  `[[feedback_gate_catalog]]` resolves onto `<label>-feedback-gate-catalog`
  instead of minting an underscored ghost twin. This one mismatch accounted
  for 81% (326/402) of the reported ghost count. Acceptance is the reporter's
  falsifiable prediction: re-importing the same vault should land the ghost
  count in the 60–80 range with edges climbing.
- **`import vault` walks archives** (#220): `_archive/` and `archive/`
  directories (any depth, case-insensitive) are now skipped by default —
  retired copies no longer mint `-2`/`-3` collision twins of live notes.
  New repeatable `--exclude <dir>` flag for vault-specific layouts; dotdirs
  and `node_modules` stay always-skipped.

## [0.8.3] — 2026-07-18

### Fixed
- **`import vault` self-ingest guard** (zzallirog field report): importing a
  folder that overlaps the vault — the vault itself, a subfolder, or a parent
  directory — now refuses with a clear message instead of writing a slugified
  copy of the vault into itself. For users whose memory directory *is* the
  vault this was the default first run; the daemon hid the echo (it scopes
  cleanly), but every other tool on the shared folder saw a half-duplicate
  corpus. Symlinks are resolved before the check.
- Every successful folder import now writes a `.bastra-imported` marker into
  `memories/imported/<label>/` (source, label, count, timestamp), so external
  tools walking the shared folder — atlas viewers, indexers, grep — can
  recognize and skip the machine-imported set.

### Added
- **Semantic view: depth mode** (zzallirog idea — "a wire between two things
  you've already made"): the server-side PCA now ships the third principal
  component as `z`, and the semantic view gets a flat/depth toggle in the
  sidebar (the spot the structure switch occupies in other views). Depth mode
  projects the meaning cloud through the Mindspace-style camera — slow drift,
  perspective size and fade, depth-sorted occlusion; the flat 2D layout stays
  byte-identical to before.

## [0.8.2] — 2026-07-18

### Added
- **Mindspace view** (#216): the map's new default view — a real universe over
  your vault: volume-spread galaxies, subgalaxies, solar systems, dwarfs,
  nebulae, background stars and shooting stars, fully mouse-navigable
  (recenter via button or hotkey `C`).
- **Areas manager** (#216): create, rename and delete top-level areas right in
  the browser — scopes are rewritten across memories, `dokumentationen/<scope>`
  follows, deletion goes to the vault trash, never hard-deletes.
- **Meta ring** (#216): taxonomy conventions and declared skills render as a
  superordinate ring level above the content rings.
- **Live updates** (#216/#217): an opt-in live mode (persisted topbar toggle) —
  new memories land as a supernova with preview card and seconds counter,
  reads/changes/deletes show as typed live notices with anti-spam rules, node
  flashes per notice kind, and newborn nodes join the running simulation
  clickable. A **session history** panel behind a topbar button lists what
  happened while you watched.
- **Human-like memory axes** (#217): optional `salience`, `emotion` and
  `recall_mode` frontmatter. High salience slows staleness aging; ranking gets
  a bounded salience multiplier in SHADOW mode by default (would-be re-ranking
  is logged, goes live only via `BASTRA_SALIENCE_RANK=live` after a measured
  lift). The map shows an emotion-colored **valence glow** and a usage-**heat
  core** per node.
- **Reflex lane** (#217): `POST /hook/reflex` matches prompts
  deterministically against the `recall_when` of `recall_mode: "reflex"`
  memories (token-AND, budgeted, per-session dedup) — the prompt hook fires it
  in parallel on every non-trivial prompt. Promotion stays user-confirmed: the
  curator proposes reflex candidates (≥3 acted-on recalls/30d) and
  episodic→semantic consolidation clusters via the pending-suggestions relay,
  never self-wiring.
- **Claude Desktop Extension** (#218): `bastra-recall-<version>.mcpb` —
  double-click install with the Bastra logo and a vault-folder picker; every
  GitHub release now carries the bundle as an asset, and
  **`bastra install claude-desktop --extension`** is the CLI on-ramp (fetch →
  dedupe config registration → open Desktop's install dialog). The MCP
  handshake now also ships `serverInfo.icons` + `title` (spec 2025-11-25) for
  the day Desktop renders them.

### Changed
- The map's CSS moved from one `app.css` to 15 module files (aggregator only
  `@import`s); the renderer uses glow sprites and viewport culling instead of
  per-frame gradients (#216).

## [0.8.1] — 2026-07-17

### Added
- **Onboarding interview** (#212): a fresh vault offers to seed itself — pick
  what your memory will mainly hold (developer / business / personal / mixed)
  and answer a handful of persona-aware questions; every answer becomes a
  profile memory immediately (`write_origin: "user-directed"`). Three
  surfaces, one catalog: the vault map auto-opens the wizard, `bastra onboard`
  runs it in the terminal, and the session hook guides an adaptive interview.
- **Import staging** (#208): `bastra import <file|->` stages memory lists from
  ChatGPT / Claude / Gemini exports (or free text) as checkbox candidates in
  `import-review.md` — the next AI session distills accepted ones WITH the
  user; nothing is saved without an accept. The map carries a visual import
  dialog (topbar ↓).
- **Chat-history mining** (#211): `bastra import <conversations.json>`
  recognizes the official ChatGPT/Claude data exports, keeps only the USER's
  own messages and queues them locally under `~/.bastra/`; the session combs
  the queue chunk-wise via `bastra import mine` and stages candidates through
  the same review gate. `bastra import clear` discards; the queue is deleted
  on drain.
- **Rules-file import** (#209): `bastra import rules` stages the list lines of
  local instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`,
  `.cursor/rules/`, `~/.claude/CLAUDE.md`) through the same gate.
- **Feedback channel** (#210): `bastra feedback <bug|idea>` opens a prefilled
  GitHub issue form (sanitized diagnostics — never paths, never content); the
  map links both forms in its sidebar.
- **Claude Desktop autonomy** (#214): the forwarder ships MCP server
  instructions in the handshake, marks the read tools with
  `readOnlyHint`/`destructiveHint` annotations (bulk-approvable in Desktop's
  permission UI), and appends the session context — pinned memories, durable
  preferences, conventions, open care/import/onboarding state — to the FIRST
  tool result of every hookless client session (`GET /hook/session-context`;
  Claude Code sessions are detected and skipped;
  `BASTRA_MCP_SESSION_CONTEXT=0` opts out).

- **Folder import** (#215): **`bastra import vault <dir> [label]`** — import a
  whole folder of foreign memory files in one command, no per-item review.
  A tolerant Claude-Code adapter reads both frontmatter variants (flat
  `type:` and nested `metadata.type`), files with or without `[[wikilinks]]`,
  and frontmatter-less legacy notes (YAML errors degrade gracefully instead
  of dropping the file); anything else falls back to a generic markdown
  adapter (title from the first H1 or filename, summary from the first
  paragraph). The CC `description` field — the format's declared recall cue —
  maps straight onto `summary` + `recall_when`, so a known format imports
  deterministically. Everything lands isolated under
  `memories/imported/<label>/` with namespaced ids and its own scope:
  nothing existing is read or modified, re-import is idempotent, and
  deleting that one folder removes the whole set. Hand-maintained index
  files (frontmatter-less link lists) are recognized as navigation and
  skipped — they don't become nodes and don't inflate the ghost count.
  The map's import dialog grew a matching folder section with a directory
  picker (`POST /ui/import-vault`, `GET /ui/fs` — directory names only,
  loopback + ui-gated).
- **Skills ring** (#215): **`bastra skills <list|add|remove>`** — a
  declare-once registry (`~/.bastra/skills.json`) for link targets that live
  on another surface, e.g. Claude Code skills. Declared ids render as solid
  nodes in the map's own `skills` ring instead of dashed "unwritten" ghosts,
  keep their place even when the last live link drops, and the curator stops
  reporting them as dangling links. Also available in the map: **"Mark as
  skill"** on any ghost node (`/ui/skills`). No path, no folder scan, no
  sync — the id is the whole declaration.

### Fixed
- **Search copilot** (`/ui/chat`): a truncated model response no longer leaks
  raw JSON into the chat (reply-value rescue), and the copilot never claims a
  memory "does not exist" — it says the search didn't surface it.

## [0.8.0] — 2026-07-16

### Added
- **Vault map** (#207): an interactive, local-only map of the vault at
  `http://127.0.0.1:6723/ui` — opt-in via `ui.enabled`, opened with the new
  **`bastra map`** command (also surfaced in `bastra status` and the install
  wizard). Three views: **Clouds** (force layout along the folder structure,
  draggable clouds with an animated evade + gravity-back comfort band),
  **Ring** (a drill-down wheel over the six memory building blocks — projects,
  people, self, knowledge, rules, artifacts — with per-project emblems and an
  instance switcher), and **Semantic** (positions from a PCA projection of the
  embedding vectors, plus dashed strands for *connections you never wrote*:
  semantically close pairs with no explicit link). Ghost nodes mark unwritten
  wikilink targets, bridge halos mark cross-cluster connectors. Renders from
  three open, token-gated endpoints (`GET /api/v1/graph`, `/graph/node`,
  `/graph/semantic`) — the web UI is one viewer among equals (#140); private
  memories never appear.
- **Search copilot** (#207): a chat docked beside the map's search results
  that deepens a search — it fans the question out into several recall
  queries, answers grounded in the notes' actual bodies, and pins its finds
  highlighted on top of the result list. Runs on the same local Ollama
  generation model as doc2query (`POST /ui/chat`, loopback-only); nothing
  leaves the machine.
- **Vault care** (#207): flag memories straight from the map (*delete*,
  *edit*, *write*, *note*) into an open `vault-care.md` checklist; the next
  AI session sees the open flags via the session hook and works the list off
  with you.
- **Capture admission rules** (#159): SKILL.md, the `save_memory` description,
  and two advisory `save_quality` checks now guard against memories that rot —
  negative capability claims without a fix, imperative self-directives, and
  stale-in-7-days artifacts.
- **`write_origin` provenance** (#158): memories carry who authored them
  (`user-directed` | `agent-session` | `capture-review`). Stamped at save
  time, preserved on overwrite, and user-directed memories are exempt from
  automated lifecycle passes (curator).

### Fixed
- **`reconcile()` heals in-place edits** (#199): files edited by external
  processes — Obsidian, scripts, a second machine, especially on cloud-storage
  mounts — no longer serve stale content until a daemon restart. Reconcile now
  stat-compares mtime/size per indexed file and re-reads on drift.

## [0.7.9] — 2026-07-07

### Fixed
- **`bastra-recall install` always reaches the guided wizard now.** Package-
  manager bin resolution (`npx` / `npm exec`) could route `bastra-recall
  <command>` to the daemon entry point, which then died with
  `FATAL: BASTRA_VAULT_PATH is not set` instead of running the CLI. The daemon
  entry now detects a CLI command (`install`, `doctor`, `status`, …) and
  delegates to the CLI — so `npx bastra-recall install` runs the install wizard
  regardless of which bin the package manager picks. The daemon path is
  unchanged when started with no command (as the forwarder does).

## [0.7.8] — 2026-07-07

### Fixed
- **`npx bastra-recall install` now launches the guided wizard** instead of
  crashing with `FATAL: BASTRA_VAULT_PATH is not set`. The unscoped wrapper
  package only exposed a `bastra` bin, so the `bastra-recall` command resolved
  to the **daemon's** `bastra-recall` bin (the raw daemon entry, which needs a
  vault env) rather than the CLI. Fix: the wrapper now also exposes a
  `bastra-recall` bin → CLI launcher, and the daemon's daemon-entry bin was
  renamed to `bastra-recall-daemon` to remove the name collision. Any bare
  `bastra install` / `npx bastra-recall install` on a terminal runs the wizard.

## [0.7.7] — 2026-07-07

### Added
- **Guided-install wizard, expanded to 8 steps**: beyond vault / clients /
  semantic recall / text model, the wizard now offers the Claude Code **Stop
  hook** (default on), **Bastra Commons** (community recipe vault, read-only,
  default off), **shared learned-recall bridges** (default off, only when
  Commons is on), **auto-update mode**, and **product-doc capture** — each a
  cancellable selection with safe defaults.
- **`bastra models` command** (`status` / `recommend` / `set <tag>`): inspect
  or set the local generation (doc2query + rerank) text model, hardware-tiered
  by this machine's RAM (`cli/hardware.ts`); the choice persists to
  cli-settings.json so Windows/Linux installs carry it too.

### Changed
- **Stop save-eval hook is now registered by default** (live-validated #48; it
  has been silent since the file-relay redesign — suggestions go to
  `pending-suggestions.json`, read by the next session, no chat noise). Opt out
  with `--no-stop-hook`. A silent background auto-update never bolts it onto a
  user who hasn't opted in — only a real `bastra install` / the wizard does.
- **Text-model wizard step also reaches existing users**: when semantic recall
  already runs on Ollama but no generation model is pulled yet, the wizard
  offers to add one (skipped for OpenAI-embedding installs, where the daemon's
  expander never runs).
- **Bastra Commons repository is now public** — anonymous read-only clone, no
  GitHub login required.

### Fixed
- **Commons clone can no longer hang on a git login prompt**: clone/pull run
  with `GIT_TERMINAL_PROMPT=0`, so an unreachable/private repo fails fast and
  the wizard continues instead of blocking.
- **Wizard robustness**: the text-model download no longer runs after a failed
  semantic-recall setup; bridges are enabled only when the Commons clone
  actually succeeded.

## [0.7.6] — 2026-07-04

> Versioning note: from this release on, the `-beta.N` suffix is dropped — the
> leading `0.` (pre-1.0) already signals beta status per SemVer.

### Added
- **Prompt-injection capture scan (#147)**: incoming third-party content
  (document/OCR ingest, bridge captures, externally-sourced saves) is scanned
  for injection markers — instructions addressed to the AI, authority framing,
  hidden/encoded text, exfiltration asks. Findings **flag, never block**:
  `save_document` stamps `injection_flags` into the sidecar and surfaces an
  `injection_warning` in the tool result, `save_memory` gets a non-blocking
  `save_quality` advisory, and the vault-health report lists flagged captures
  as a review section. Zero recall-path cost — the scan runs on capture only.
- **Embedding circuit breaker (#165)**: after 3 consecutive provider failures,
  hybrid recall silently degrades to BM25-only for a 60s cooldown (no
  per-query timeout tax); a half-open probe re-closes on recovery. Resets on
  Ollama autostart; `/health` carries the breaker snapshot; degraded recalls
  are marked in telemetry (`embedding_degraded`).
- **Identifier-preserving search tokenization (#162)**: dotted/hyphenated/
  underscored identifiers (`my-app.config.ts`, `chat-send`, `P2.2`) now match
  as units on BOTH index and query side (dual emission keeps all previous
  matches working). Query hygiene: 8000-char hostile-input cap at word
  boundaries, dangling-operator strip; bridge expansion terms structurally
  survive the cap.
- **Hook empty-streak backoff (#161)**: hint sources whose injections go
  unconsumed widen their cadence per session (cap 8×); any load/acted_on
  resets. Safety carve-outs: the bash-tripwire STOP warning never backs off,
  REQUIRED-band hints (score ≥ 100) always emit, explicit retrieval prompts
  are exempt. Suppressed emissions are logged for net-context-ROI.
- **Stable npx runtime (#180)**: installs from an npx cache copy the runtime
  to `~/.bastra/runtime/<version>/` and register ALL paths (forwarder, hooks,
  statusline) from there — cache eviction no longer breaks registrations.
  Old versions are pruned; `doctor` warns about remaining `_npx` paths.
- **Obsidian-resolvable doc cross-links (#188)**: document sidecars carry
  their doc-id as an Obsidian alias, so the enricher's `[[doc-id]]` links
  resolve to the sidecar instead of creating empty stray notes on click.
  The schema coerces any hand-edited alias shape — a memory is never
  rejected over `aliases`.

### Fixed
- **`uninstall all` removes the shared skill (#181)**: a final sweep deletes
  `~/.claude/skills/bastra-recall/` when no skill-sharing registration
  remains (surfaces whose uninstall failed count as still registered).

## [0.7.0-beta.5] — 2026-07-04

### Added
- **Guided install wizard (#185)**: bare `bastra install` on a terminal runs
  a guided setup with selection lists — memory vault (create `~/BastraVault`
  or pick a folder), AI clients (multiselect, detected ones preselected),
  semantic recall (enable / keyword-only). Ctrl-C cancels cleanly without
  writing anything; all scripted flows (`install all`, `--yes`, `--dry-run`,
  non-TTY) are unchanged and `--ollama`/`--no-ollama` are honored.
- **Self-improving lifecycle, Wave C (#186)**:
  - *Usage sidecar (#154)* — durable per-memory aggregate of
    surfaced/loaded/acted_on under `<vault>/.bastra/usage/`; "surfaced"
    counts only hints the hooks actually injected (post-filter feedback via
    `POST /hook/hinted`).
  - *Staleness curator, phase A (#155)* — deterministic score-only demotion
    of memories that keep surfacing without engagement. Review-first pass,
    ≥30 days of usage data required, floored/doc/taxonomy memories protected,
    any real load reactivates; survival-by-id now CI-pinned for curator
    demotions too.
  - *Vault-health report (#156)* — each curator run projects `REPORT.md`
    into the vault: stale candidates with usage numbers, floors awaiting
    re-affirmation, same-topic clusters, dangling wikilinks, 0-byte files.
    Manual trigger: `POST /curator/run` (dry-run by default).
- **First-run vault offer (#178, #179)**: on a fresh machine an interactive
  `bastra install` asks once to create `~/BastraVault` instead of erroring
  per surface; non-TTY/`--yes`/`--dry-run` keep deterministic behavior
  (pure decision function, unit-tested).

### Fixed
- **Daemon-aware embeddings status (#177)**: `bastra embeddings status` and
  the install-end prompt respect a RUNNING daemon whose environment already
  enables semantic recall — no more contradictory OFF notes or re-prompts.
- **`brew trust` for the tap (#182, #183)**: `Install Bastra.command` trusts
  the third-party tap before installing (new Homebrew security gate).
- **Double-click installer prompts (#185)**: the install log pipe made
  stdout non-TTY and silently skipped every interactive prompt — the guided
  setup now runs on `/dev/tty`, with a fallback to `install all` on older
  CLI versions.

## [0.7.0-beta.4] — 2026-07-03

### Fixed
- **Stale version-string constants**: `scripts/bump.mjs` now rewrites the
  hardcoded version constants (CLI `VERSION`, daemon `DAEMON_VERSION`,
  forwarder serverInfo) and fails loudly on a pattern miss — `/health` no
  longer reports an old version after a release.
- Homebrew formula (tap repo): build the full workspace root and ship pruned
  production `node_modules` — fixes 67 TS build errors and the
  `ERR_MODULE_NOT_FOUND: @bastra-recall/core` crash from release tarballs
  (#184).

## [0.7.0-beta.3] — 2026-07-03

### Added
- **Floor/pin primitive (#141, #142)**: push-by-state memories with an
  opaque per-entry handle `{memory_id, condition, reason, last_affirmed,
  affirmed_by, why}`; keyed `release(condition)`; `affirm` is an explicit
  call requiring `affirmed_by` + a fresh `why` (no why → the clock does not
  move). Expired floors drop back to ranked — unpin ≠ remove. Exposed via
  loopback REST (`/api/v1/floors`) and injected as a pinned block with an
  audit line.
- **Discoverable semantic recall (#79)**: new `bastra embeddings
  <on|off|status>` command, a one-time install-end prompt, and a doctor note
  — turning the embedding layer on is a single line instead of an env dance.
- **Wave A ingest hygiene (#149–#152)**: central pre-ingest scrubber strips
  bastra's own injected context blocks before heuristics/doc2query; injected
  hint blocks are fenced as reference-only; anti-thrash save semantics
  (terminal success note + consecutive-failure cap); trivial-prompt gate
  skips hint injection for bare acks and slash commands.
- **Wider acted_on surface (#144)**: a lightweight act-signal on every
  completed Bash command closes open recall episodes without letting
  unrelated commands kill them (`closeOnMiss=false` on the high-frequency
  path).
- **Three-arm survival harness (#103)**: `lexical · hybrid · expanded` eval
  arms with a far-split — measured on a real vault: hybrid rescues far
  recall (+16.5pp); the residual gap is ranking, not demand.
- **Survival substrate invariant (#146)**: demote is score-only (file
  byte-identical), soft-delete is append-only trash + audit, both CI-pinned
  (`survival-by-id.test.ts`) and documented as a citable contract in
  `docs/survival.md`.

### Fixed
- **Strong cross-scope recall hints (#148)**: a hit passes the #110
  foreign-scope filter only when it matched its hand-written `recall_when`
  AND sits in the REQUIRED band — deliberate cross-project relevance gets
  through, tag/topic-overlap noise stays filtered.
- `save_memory` update without an explicit folder no longer relocates the
  memory.
- Security: js-yaml 3.14.2 → 3.15.0 (GHSA-h67p-54hq-rp68).

## [0.7.0-beta.2] — 2026-06-28

### Added
- **doc2query slug-filter + corpus prune (#145, #143)**: a structural
  `isSlugChain` gate (plus a sharpened write-time prompt) drops slug-chains
  (`panel-close-fix`) and hallucinated tag-strings from `recall_when_expanded`
  before they reach the BM25 index — a small local model emits them despite the
  prompt, and they poison recall with noise terms. The gate keeps real search
  tokens (`z-index`, `gpt-4`, and idioms like `left-to-right` via a function-word
  seam heuristic). The new `prune-slug-expansions` maintenance script applies the
  same gate to *existing* expansions (340 slug entries removed across the vault,
  the good paraphrases and the clean files left untouched), so the stored corpus
  matches what new writes get.
- **doc2query trigger expansion (#117)**: a local Ollama model paraphrases each
  memory's `title`/`summary`/`recall_when` into *different* words at write time
  and indexes them (new `recall_when_expanded` frontmatter field, BM25 weight 2
  vs `recall_when`'s 5), so a reworded ("far") query weeks later still fires on
  the lexical layer with zero query-time model cost. The new `TriggerExpander`
  runs in the background (on every embed + a one-shot backfill sweep over
  existing memories), keeps only paraphrases that retrieve their own memory in a
  semantic self-test, and is loop-guarded by a source hash. On by default when
  Ollama is the embedding provider; `BASTRA_TRIGGER_EXPAND=0` disables it,
  `BASTRA_EXPAND_MODEL` overrides the model, and `BASTRA_EXPAND_TIMEOUT_MS`
  (default 120000) sizes the generation timeout — doc2query generation is far
  slower than a rerank judgment, so it gets its own generous timeout and the
  background expansion is hardened so a chat timeout can never crash the daemon.
- **`bastra token clear` (#97)**: removes the stored REST API token (browser/REST
  clients are locked out on the next daemon restart). `bastra` (the status panel)
  and `bastra status` now show whether a token is set, without printing it.
- **Product docs (opt-in)**: living user-facing documentation per project in
  `dokumentationen/<project>/` — one markdown file per feature area, written
  update-in-place via the new `save_product_doc` MCP/REST tool (stable id
  `doku-<project>-<area>`). Two settings drive it: `docs.mode`
  (`off`|`suggest`|`auto`, default `off`) and `docs.language` (default `en`),
  via `bastra config set`, the new loopback `GET/POST /settings/docs` endpoint
  (for the Mac-app options pane), or the settings file. With mode set, the
  SessionStart hook injects the capture instruction (`suggest` proposes first,
  `auto` writes autonomously) and the stop hook's feature-completion suggestion
  reminds about the doc. `type: doc` hits are damped (×0.5) in default `recall`
  so doc bodies never crowd out lessons; `find_document` ranks them undamped.
  The `bastra` panel shows the docs mode.
- **Bastra Commons (beta)**: `bastra commons enable|update|disable|status`
  git-syncs a community vault of verified engineering recipes to
  `~/.bastra/commons` and the daemon loads it as a second, strictly read-only
  BM25 index. `recall` fuses Commons hits (`scope: commons`) slightly below
  personal memories; on id collisions the personal memory wins and
  `load_memory` falls back to Commons. Best-practice status in the Commons is
  earned through independent verification records, never declared — see the
  wiki page "Bastra Commons".
- **Commons verify loop**: `bastra commons verify <recipe-id> <works|fails>
  ["env note"]` writes an append-only verification record
  (`verifications/<recipe>/<verifier>.json`, one per user+solution, history
  via git) and submits it as a mini pull request. The daemon counts merged
  records on boot and feeds them into the fusion ranking
  (`commonsRankFactor`: independent works lift a recipe, fails sink it —
  capped both ways). `load_memory` of a commons recipe returns the evidence
  counts plus a `verify_hint`, so agents close the loop right where the
  recipe was applied.
- Energy-aware Ollama model lifecycle (#78, #109): the daemon prewarms the
  embedding model on boot, sends a per-request `keep_alive`
  (`BASTRA_OLLAMA_KEEP_ALIVE`, default `10m`) via the native `/api/embed`
  endpoint, and unloads the model from Ollama RAM after an embed-idle window
  (`BASTRA_OLLAMA_IDLE_UNLOAD_MS`, default 10 min) — instead of pinning it
  forever with `OLLAMA_KEEP_ALIVE=-1`. New `ollama_lifecycle` telemetry events
  plus a RAM-residency summary in `stats.ts`.
- Daemon boot now restarts a stopped local Ollama (probe-first, loopback-only,
  honours `ollama.autostart`) when semantic recall is configured — previously
  only `bastra install` could start it, so killing the Mac app silently
  dropped recall to BM25.

### Changed
- Stop hook redesigned to be silent (#48): save-eval suggestions are written
  to `~/.bastra/pending-suggestions.json` and injected as additionalContext by
  the next SessionStart (consume-once, 7-day expiry) instead of `systemMessage`
  — which Claude Code rendered 1:1 into the chat as an undecipherable flood.
  Injected transcript turns (skill body, system-reminders) no longer feed the
  heuristics (the self-trigger defect). Still opt-in via
  `bastra install --with-stop-hook`.
- Daemon self-update (#81): with `update.mode=auto` the daemon stages updates
  itself (shared once-per-day throttle with the SessionStart path) and
  re-checks every 6 h — covers Claude Desktop, which has no hook surface. A
  LaunchAgent-owned daemon restarts on ≥15 min idle after staging so the new
  code actually goes live (launchd respawns it).
- Honest v0.7 scoreboard: `recall_episode` carries a `surfaced` flag so direct
  loads without a preceding hint no longer pollute the `below_floor` USE-rate
  band (#77); `stats.ts` adds a net-context-ROI report (injected hint tokens
  vs. acted-on loads, plus top context-tax memories as archival candidates,
  #72) and splits the USE-rate by hint source — bash-tripwire vs. write/edit
  (#71). MCP `load_memory` calls now join the real Claude Code session/turn
  via forwarder headers (`x-bastra-cc-session`/`x-bastra-cc-turn`, stamped by
  the prompt-hook into the session feed), making the acted-on join accurate
  with multiple concurrent sessions on one daemon (#74).
- Claude Desktop reliability (#78): the MCP forwarder holds tool calls while
  the daemon boots (health timeout 10 s → 60 s) and respawns a dead daemon
  once instead of erroring; the daemon skips idle self-shutdown when a
  LaunchAgent owns its lifecycle.
- Recall-hint hygiene: the same memory now appears in `<recall-hints>` at most
  once per session by default (`BASTRA_HOOK_MAX_SHOW`, #106), and hints from
  foreign project scopes are hard-filtered in all score bands (#107, #110).
- `save_memory` quality advisory (#108): trigger-collision counting applies
  the recall noise floor instead of reporting the raw top-k for every trigger.
- Memory-storage conventions moved into the shipped skill
  (`packages/skill/SKILL.md`), so every MCP surface gets them instead of them
  living in one vault: **people** store as one canonical memo per person under
  `memories/people/` (`id: <handle>`, `type: project-fact`, tag `person`), with
  project content linking in via `[[<handle>]]`; **contributor conversations**
  are captured autonomously on two rails (identity → `people/`, content →
  `project-fact`); and the self-learning taxonomy now establishes cluster homes
  proactively from **conversation context** (e.g. a stack of scanned invoices →
  a `buchhaltung/` home), not only when a vault cluster recurs three times. A
  new `docs/commons.md` documents the Commons sharing model end to end (opt-in,
  default-off, PR-gated, scrubbed-bridges-only, no auto-egress).
- The shipped skill re-anchors the **RECALL-first reflex** above the grown
  capture/convention sections, so the agent reaches for the vault before acting
  instead of being pulled toward the save machinery first.

### Security
- CORS is deny-by-default (#95): with `BASTRA_CORS_ORIGIN` unset no browser
  origin is allowed; `*` is an explicit opt-in and warns when combined with a
  minted API token.
- `bastra update` spawns brew/npm via vetted absolute paths with hard
  timeouts; a spawn killed by signal/timeout no longer counts as success (#91).

### Fixed
- **Telemetry join-state across daemon boots**: the recall→action correlation
  state lived only in memory and reset on every daemon restart, skewing the
  `recall_episode`/USE-rate join. It now persists across boots, so the acted-on
  numbers are honest rather than truncated at each restart.
- **`save_memory` tool-schema skew (#132)**: the stdio forwarder shipped its own
  static copy of the tool definitions, so the schema a client was told came from
  the forwarder's build while validation happened at the daemon. A long-lived
  shared daemon running older code in RAM (it deliberately doesn't restart on a
  `dist` rebuild) could then validate against a schema that differed from what
  the client saw — surfacing as a required argument arriving `undefined`. The
  forwarder now fetches the schemas from the daemon via a new token-free
  loopback `GET /tools` endpoint (single source of truth: `ALL_TOOL_DEFS`), so
  the client schema always matches the validator. Falls back to the bundled
  defs when the daemon isn't reachable yet.
- Zombie `mcp-forwarder` processes from Claude Desktop's `disclaimer` wrapper
  are now reaped — the forwarder detects the dead grandparent, the daemon
  sweeps stale forwarders on boot (#80).
- `/health` and `bastra status` report `semantic_recall: "degraded"` (with the
  last provider error) when the embedding provider dies at runtime, instead of
  silently advertising semantic recall while serving BM25-only (#92).
- Statusline memory count now stays correct across sessions. The daemon
  publishes the live vault size to a shared file — refreshed on every index
  change plus a periodic disk reconcile — and the statusline segment reads it.
  Previously an idle session kept showing a stale count after another session
  (or an external write the file watcher missed) changed the vault, because the
  per-session feed only refreshed on that session's own tool calls.

## [0.6.5-beta.1] — 2026-06-01

### Added
- Auto-update (opt-in): a new `update.mode` setting (`notify` default / `auto` /
  `off`) stored in `~/.bastra/cli-settings.json`. In `auto`, a new Claude Code
  session stages an update in the background (file swap, no daemon restart),
  throttled to once per day — the running session is never disrupted and the new
  code goes live on the next daemon start.
- `bastra` with no arguments now prints a status panel: version, update status,
  daemon health, and live vault size.
- `bastra config get|set update.mode` to read or change the update mode.
- `bastra update --staged` — swaps files without restarting the daemon (used by
  the session-start auto-update).
- Live memory count: `Vault.reconcile()` and `GET /vault/count` reconcile the
  index against disk, so the status panel's count stays correct even when the
  cloud-storage file watcher misses external writes or deletes.
- Public `fixtures/sample-vault` smoke fixture so recall quality can be tested
  from a fresh clone without private data.
- Security policy, Dependabot config, dependency review, CodeQL, OpenSSF
  Scorecard, and manual npm publish workflow with provenance.
- OpenAPI starter spec for REST / ChatGPT Actions integrations.

### Changed
- Smoke tests now run against the public sample vault.
- npm packaging is hardened for public workspaces and packaged Skill assets.
- Homebrew formula builds the full monorepo so daemon hooks and statusline are
  installed together.
- Claude Code Stop save-eval hook is opt-in (`--with-stop-hook`) because its
  multi-line suggestions can add terminal noise.

### Fixed
- Lockfile: restored the `@esbuild/*` platform-binary entries that a prior
  `npm update` had dropped. Without them `npm ci` (and the tsx test runner)
  failed on a clean install on the affected platform.

## [0.6.0-beta.1] — 2026-05-29

First public (pre-release) build. `0.x` signals the API may still change;
the `-beta` tag means it's feature-complete enough to use but may have rough
edges. Dogfooded daily against a real vault.

### Core
- **Memory vault** over plain markdown files with YAML frontmatter — your
  data stays as readable files you own.
- **Hybrid recall** — BM25 keyword search fused with optional embeddings
  (Ollama or OpenAI), with staleness ranking and a query cache.
- **Lean-by-default `recall`/`load_memory`** — `recall` returns slim
  candidates; `load_memory` fetches full content only for what you need
  (`verbosity:"full"` opts back in). ~32% smaller recall payloads.
- **`save_memory`** with typed entries (lesson, preference, decision,
  project-fact, …) and auto-related wikilink enrichment.
- **Documents** — `find_document` / `read_document` over PDFs, scans, notes.

### Daemon
- Single shared daemon (MCP over stdio + HTTP REST), spawned on demand by a
  forwarder so every AI client shares one vault/index — no N-copies sync bug.
- **Idle self-shutdown** (default 30 min, env-tunable) — keeps the process
  table clean; respawns on the next recall.
- Background update-check against GitHub releases.

### Reflex layer (hooks)
- SessionStart + PreToolUse hooks surface relevant memories automatically,
  before you write code or start a session.

### CLI & distribution
- `bastra install | uninstall | doctor | update` across Claude Code,
  Claude Desktop, and Cursor.
- Homebrew formula (head build) + double-click installer.

### Statusline
- Optional powerline-style statusline with a native `bastra` segment
  (live recall stats + vault size).

### Tooling
- CI (GitHub Actions): `npm ci` → build → type-check → test on a Node 20/22
  matrix, on every push and PR.

[Unreleased]: https://github.com/n0mad-ai/bastra-recall/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/n0mad-ai/bastra-recall/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/n0mad-ai/bastra-recall/compare/v1.1.8...v1.2.0
[1.1.8]: https://github.com/n0mad-ai/bastra-recall/compare/v1.1.1...v1.1.8
[1.1.1]: https://github.com/n0mad-ai/bastra-recall/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/n0mad-ai/bastra-recall/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v1.0.1
[1.0.0]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v1.0.0
[0.9.2]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.9.2
[0.9.1]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.9.1
[0.9.0]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.9.0
[0.8.9]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.9
[0.8.8]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.8
[0.8.7]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.7
[0.8.6]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.6
[0.8.5]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.5
[0.8.4]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.4
[0.8.3]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.3
[0.8.2]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.2
[0.8.1]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.1
[0.8.0]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.8.0
[0.7.9]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.7.9
[0.7.8]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.7.8
[0.7.7]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.7.7
[0.7.6]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.7.6
[0.7.0-beta.5]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.7.0-beta.5
[0.7.0-beta.4]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.7.0-beta.4
[0.7.0-beta.3]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.7.0-beta.3
[0.7.0-beta.2]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.7.0-beta.2
[0.6.5-beta.1]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.6.5-beta.1
[0.6.0-beta.1]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.6.0-beta.1
