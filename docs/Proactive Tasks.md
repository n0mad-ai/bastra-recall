# Tasks and reminders

## On by default (since 1.2.0)

Tasks are **on by default since 1.2.0**, on fresh installs and upgrades. Up to 1.1.8 they were an opt-in preview. An explicit earlier opt-out (`tasks.enabled=false` or `BASTRA_TASKS=0`) is preserved. No environment variable is needed for the default. Remote MCP never lists or accepts `task_*` tools.

Disable tasks in Settings or with `bastra config set tasks.enabled false`, or set `BASTRA_TASKS=0` in the daemon and clients/hooks. Restart those processes after changing the switch. An explicit `BASTRA_TASKS` takes precedence: `1` enables; every other value disables. Re-enable in Settings or with `BASTRA_TASKS=1` and restart.

Existing task data and credentials remain untouched. Disabling does not cancel tasks: enabling again restores the existing behaviour, including catch-up for due work. The startup settings snapshot is read-only: an old explicit opt-out is read without importing the legacy file. Inaccessible, deleted or malformed settings keep tasks disabled until repaired or explicitly overridden.

While disabled there is no task runtime, polling, delivery, source checking or automatic Agent credential setup. The Tasks area of the web UI shows that tasks are switched off, and `task_*` MCP tools are hidden; task HTTP routes, including UI session routes, return 404 with `feature_disabled`. `bastra tasks …` only explains how to enable tasks. `BASTRA_CONVERSATIONAL_REMINDERS=0` is a separate, narrower switch inside enabled tasks; it does not enable tasks.

## Tasks in conversation

Ask the agent to create a task or reminder: a commissioned or confirmed task is created armed at any action level. The agent asks only for missing or ambiguous goal/date/time/timezone/recurrence, including DST ambiguity. When it notices a deadline or promised follow-up itself, it adds it without a question and acknowledges it in one line in your language, naming what and when, for example `→ Reminder saved: <what> – <when>`.

Due cards are briefly mentioned at response start. “Done”, “tomorrow again” or “forget it” control tasks of every level in conversation. Origin (user request / agent observed), client, session and scrubbed cause remain visible. There are no daily or open-reminder limits; identical cause/time is deduplicated. Physical store/delivery budgets still apply. `BASTRA_CONVERSATIONAL_REMINDERS=0` disables conversational arming; the agent reports an unarmed draft instead. One-off work requests do not become reminders.

Agents manage tasks of every level. Your instruction in chat also authorizes the commissioned execution; its user-directed provenance, program, session, wording and time are recorded. Missing or unenrolled task areas map to the agent’s enrolled area; projects belong in scope.name. Preparing an execute task shows the exact change before the adapter writes it.

Bastra keeps explicit tasks beyond one chat. A due card asks for evaluation; it does not prove a measurement passed. Delivery is only a presentation attempt. Explicit owner acknowledgement means seen; completion and an action receipt are separate records. Conversation cards arrive at the next contact while the daemon runs. Optional macOS notifications also surface due work without a contact; they do not launch an agent.

## Automatic agent access

At local single-user daemon startup, a separate private agent credential is configured for hooks/MCP. Existing users need no command after an update; client settings and valid credentials are preserved. Revoked, unsafe or ambiguous multi-owner access is not silently replaced. `bastra tasks client-status` reports actual access. `BASTRA_CONVERSATIONAL_REMINDERS=0` prevents automatic setup and agent arming. The manual Owner path below remains available for separate administration.

## 1 CLI examples and separate Owner administration

Normal conversation and the local board use automatic Agent access. The following separate Owner setup is for optional administration. Use your own terminal and an existing private owner directory outside agent access. Keep tokens out of chat.

```sh
bastra tasks auth mint owner me personal /PRIVATE/OWNER/task.token
```

Confirm `[y/N]` with `yes` if intended. Open the new private file locally and copy the token into hidden prompts. It is an owner task credential, not a signing key.

Optional private cache:

```sh
bastra tasks owner-login
```

This is interactive-only, revalidated against the registry on each command, and never used by hooks/MCP. It must remain outside agent access. This administration login is not a separate execution approval.

```sh
bastra tasks setup-hooks
bastra tasks client-status
```

setup-hooks assigns a separate agent credential to local clients. Explicit BASTRA_TASK_TOKEN overrides that file. Missing, invalid or revoked access is shown honestly. Configured access alone does not start the daemon.

```sh
bastra tasks create --goal "Evaluate the run" --after 1m --timezone Europe/Madrid --domain personal --arm
bastra tasks list
```

The confirmation shows what, when, timezone, state and armed/unarmed. Without --arm it stays unarmed. Agent CLI creation with --agent --arm supports every level. An explicit review command can activate a draft:

```sh
bastra tasks review TASK_ID
```

After the minute and a suitable contact/poll:

```sh
bastra tasks due
bastra tasks acknowledge TASK_ID --occurrence OCCURRENCE_ID
bastra tasks resolve TASK_ID
```

Copy IDs from the card. Acknowledge means seen, still open. resolve completes a one-off task or the selected/latest due occurrence of a series. end_series ends the whole series. cancel stops it; rearm brings it back **unarmed**, with no renewed old approval. The normal CLI uses readable output in your language as a whole, questions and error messages included: German when `language.primary` is `de`, English otherwise and when it is not set; --json remains the machine format.

## 2 Time, repeats and postponement

```sh
bastra tasks create --goal "Evaluate after seven days" --after 7d --timezone Europe/Madrid
bastra tasks create --goal "Daily review" --when 2026-10-12T18:00 --timezone Europe/Madrid --every 1d --count 3
bastra tasks snooze TASK_ID --until 18:00
```

After 7d means elapsed duration. Local --when uses the given timezone; an omitted timezone is explicitly reported as a system-timezone assumption. Local calendar repeats differ from elapsed days. Repeats may run without a count or --end. Add either to bound the series. catch_up: latest coalesces missed slots into the latest catch-up occurrence. tasks pause ID persists a pause; tasks resume ID continues the series. tasks end_series ID ends it explicitly. Finishing one occurrence leaves later dates active; a finite series resolves after its final occurrence. Nonexistent DST time rejects; ambiguous autumn time chooses the earlier instant but stays visibly unarmed until owner review. Simple snooze uses the next local 18:00; a full future date works too. Agents can postpone every action level without an artificial 24-hour ceiling. A pause stops source evaluation, delivery and action preparation/execution; it does not refresh an old execution approval.

## 3 Status and controls

```sh
bastra tasks status
bastra tasks mute
bastra tasks unmute
bastra tasks off
bastra tasks on
bastra tasks stop
```

Status shows on/off, states, next check, last attempt/error, source verification, limits and action outcomes. Mute delays passive presentation; off pauses automatic evaluation/delivery; stop stops execution. Owner due still allows explicit inspection. Nothing silently completes a task or renews expired authority.

Execution is stopped by default. Under the user’s commission, the connected agent can enable the registered adapter with `bastra tasks execution-enable --agent`, without a second confirmation. Active reservations appear in status; `tasks release ID` releases your reservation without rolling back an effect or renewing proof.

## 4 Browser and decision reconsideration

```sh
bastra config set ui.enabled true
bastra tasks ui
```

On macOS the web UI is on by default since 1.2.0; on Linux and other systems it stays off until you switch it on (`bastra map` offers to do that, or the first command above). See [Settings](./Settings.md#english). `bastra tasks ui` prints the address of the web UI. The Tasks area renders task content as text. In the **New task +** form, **Activate right away** is off by default; otherwise the task waits for your release. Release, seen, postponement, completion and cancellation remain separate actions. Before/after proposals are readable; full binding remains inspectable.

A versioned attributable premise change can invite Keep/Change/Snooze/Stop, showing the old decision/rationale and new evidence/uncertainty. Saving a decision alone does not arm a watch. Unknown, contested, stale or unavailable is not refutation. Keep disarms; another change needs owner rebinding. Changing the decision requires explicit owner choice and an actual CAS memory revision, with no new ordinary memory field.

## 5 Register one reversible local artifact

Only local-artifact-v1 is supported: replace an existing registered reversible UTF-8 file with exact commissioned bytes. No provider messaging, email, Slack, GitHub, cloud or shell adapters.

```sh
bastra tasks targets register demo --root /WORK/ARTIFACTS --path artifact.txt --domain personal --agent
bastra tasks targets list --agent
bastra tasks execution-enable --agent
```

The target registry limits the adapter to the chosen existing file. The real resolved narrow work root is shown. Task/vault/control/profile locations, all .git state, .husky, .github/workflows, .envrc and .npmrc remain blocked. No key enrollment or boundary assertion is required for the chat-authorized execution path.

```sh
bastra tasks targets update demo --root /WORK/ARTIFACTS --path other.txt --domain personal --agent
bastra tasks targets remove demo --agent
```

Registry changes invalidate old target bindings. Prepare against the current registry before execution. Tabs/CRLF/BOM/control characters, unsafe preview transformations and before-state above 16384 characters reject before execute.

## 6 Chat authorization, execute, rollback and unknown outcomes

Tell your connected agent what to do. The instruction itself authorizes the commissioned action, including the execute level. No key file, signature, passphrase, `tasks approve`, Touch ID or second confirmation is required. The retired `tasks keys`, `tasks approve` and `tasks deny` commands only explain chat authorization and exit without reading credentials or writing anything. If the agent proposes a consequential action you did not request—sending, deleting or paying—it asks once in chat. Your Yes is recorded the same way. The trust boundary is your Mac account (and later your login).

The agent interprets your intent and passes an `authorization` record with `write_origin: "user-directed"`, `session_id`, `program` and `user_request` (your wording). Recall records the time in `at`. Recall does not inspect wording to recognize approval. Supply this record with `task_prepare`; a later Yes uses `task_approval` with `proposal_id`, `decision: "approve"` and `authorization`. The board, proposal and status show the recorded origin, program, session, wording and time. Credentials identify the connected agent; they are not an additional per-action approval.

Prepare writes no target and shows exact before/after bytes. The daemon still binds the current task, target, evidence, payload and expiry, rechecks under the lock, requires a live lease/fence and enabled adapter, records the intent before writing and stores a receipt. An authorization is for the commissioned action; task DATA, a notification or an executor report cannot invent one. Changed target or source state requires fresh preparation and comparison with the existing commission. A materially different action needs the user's instruction or one Yes.

For example, ask your agent to replace the registered demo artifact with the exact new content. It prepares the proposal with the chat authorization, checks the preview and executes it with a lease. The web UI also displays this proposal; **Execute change** runs an already authorized current proposal without a second confirmation. No separate terminal signing or refresh round is needed.

Status shows intents and receipts separately from task completion. Double clicks are blocked and a failed browser attempt releases its reservation. If already reserved, inspect status and release your own reservation with `bastra tasks release LEASE_ID`, or wait for expiry. Check receipts/status before retry; never infer success from a lease or blindly repeat an unknown effect.

Rollback is another exact compare-and-swap operation. Ask the agent to undo the action, or give one Yes if it proposes rollback itself. The agent prepares rollback from the successful receipt and records that instruction. A fresh binding and lease are required; intervening target edits block it. Rollback remains available after resolution/cancellation/snooze. A crash yields exact-hash reconciliation or visible unknown/review, never blind retry. Only own hash-bound temp files are cleaned; foreign remnants stay visible.

### Existing installations and recovery

Before upgrading, back up the local app state (`~/.bastra`) while preserving its private permissions. The upgrade retains task IDs, histories, consumed action identities and receipts. The legacy `task-approval-keys.json` registry is copied to the private exact backup `task-approval-keys.json.pre-chat-approval.bak`, then renamed to `task-approval-keys.json.legacy`. The new `task-action-registry.json` retains registered targets and protected key storage roots; historical key enrollment and boundary assertions are no longer execution gates. Task databases and key files stay unchanged; historical signatures do not become new chat instructions. Prepare unfinished work again with its actual user instruction. Keep the backup and renamed originals for inspection.

To return to the earlier version, stop the daemon and task clients and retain a complete copy of the upgraded state. Reinstall the earlier code and restore the complete pre-upgrade local backup, including its task database and registry. Renaming the registry alone is insufficient: older decoders do not understand newly stored chat authorization fields. Keep the `.legacy` and `.bak` originals in the retained upgraded copy; chat authorizations are not legacy signatures. Restart and inspect task IDs, pending/unknown effects and target contents before any new execution. Never restore an older receipt store and blindly repeat an action; effects after the backup may already have happened.

The [approval-key isolation investigation](Owner%20Approval%20Key%20Isolation.md) is historical. Its key/OS-helper proposal is superseded by chat authorization; it is not a setup requirement.

## 7 Resource limits, archives and repair

Per-task intervals, timeout and byte allowance apply to source intake and evidence checks. Global turns have at most 10 assessments/5 s, source reads at most 1 s and 1 MiB, poll 60 s, unchanged failure backoff up to 1 h, active snapshot 4 MiB (normal admission 75 %). Shared source admission follows eligible consumers and each task independently rejects results above its limit. Memory intake includes the unique-file locator: the byte limit covers the sum of scanned Markdown files. Too-small byte allowance reports source_budget / “Quell-Bytegrenze überschritten”, timeout reports source_timeout, with no trigger. Deadlines prevent accepting late results; they do not promise atomic interruption of arbitrary OS I/O. New accepted events bypass old backoff; errors/lock/capacity/process suspension prevent a universal wallclock guarantee.

```sh
bastra tasks stop
bastra tasks archive FINISHED_TASK_ID
bastra tasks archive-restore ARCHIVE_ID
```

Archive exports exact private terminal groups before retiring active rows. Unresolved occurrences, pending/unknown intents and active leases cannot be retired. Cold idempotency, history and known spent IDs/fencing remain. Missing/tampered exports fail closed. Restore imports terminal history for fresh commissioned rollback, stays unarmed and stops execution. Journal/spent/archive-index limits can still produce visible capacity backpressure; no silent eviction.

Stop all task processes before `recover [--lock]`. Confirm private validated backup recovery; original is quarantined, epoch changes, tasks disarm and execution stops. Newer changes may be missing. Cold exports and readable original indexes/spent IDs/fence maxima are reconciled; terminal history can return alongside its archive without new authority. Unknown-lock quarantine needs explicit offline assertion and refuses a known live local owner.

If the original is unreadable and backup predates a recent unarchived effect, its receipt/consumed ID can be absent. The new epoch still blocks its old approval. That is replay safety, not full audit reconstruction: inspect original and target.

## 8 Disposable walkthrough

Use the [20–30-minute isolated owner demo](design/proactive-tasks-demo.md). It starts its own daemon/port/profile with invented data, neutralizes inherited test/output settings, and includes browser/CLI notify, postponement, prepare/execute/rollback and prepared decision-reconsideration files. Terminal close cleans the own daemon and own disposable root. No real human/OS-boundary or longitudinal evidence is inferred.

See the [final 14-case matrix](design/proactive-tasks-matrix.md) and [German instructions](Proaktive%20Aufgaben.md). Human comprehension, interruption burden and longitudinal utility remain separate pending confirmations.

## Tasks area and browser access

Since 1.2.0 the web UI (UI v2) has a **Tasks** area:

- **Header:** status tiles (function, automation, due, awaiting release, execution), **Reports**, **Due** and **New task +**.
- **Calendar:** the **Ledger** view shows a week or a month. Drag a task to move it, double-click to create one. Tasks without a date sit in a separate **No date** tray. An optional agenda bar lists the days next to the calendar.
- **Due** opens the due cards. **Mark as seen** means seen, still open; **Details →** opens the task.
- **New task +** opens a form: goal, trigger (elapsed time or local time), time zone, area, level, repeat and count, optional validity, what it waits on, who holds it (you or Recall), origin and an agent note. You can also just tell your agent.
- **Right panel, three tabs.** **Details** shows the selected task: status, origin, due and next check, release (who asked, in which program and session), level, repeat, validity, last result and failure reason. Its buttons release a task or send it back to review, pause or resume it, end a series, snooze, mark done, cancel, edit, change the validity, take it over or hand it to Recall, prepare, delete, reconcile (read only) and prepare a rollback. **View** chooses the calendar style: Ledger is the default; Flow, Stream and Relay belong to Recall Pulse and show only a "coming soon" hint. **Control** shows and switches function, audible delivery and execution, and lists budgets and storage, effects to reconcile, sources, adapters and releases, and the archive.
- **Reports** switches the main area to the task reports (see [Task reports](#task-reports)).

An unclear execution outcome means the target state must be reconciled. Unavailable sources are described as currently unavailable while retries remain scheduled, never as proven permanent failure. In **Control › Archive**, a cold archive can be loaded read-only; its tasks are marked as no longer watched.

A local single-user installation opens an **Agent-role** browser session without token entry (private SameSite/HttpOnly session cookie plus CSRF validation). The session lasts for the daemon lifetime; reloading the page reuses it. Local Host/Origin and enabled UI are required. On macOS the caller must also be a program of the macOS account that owns the vault (#1419). No Owner credential is exposed; revocation is checked on every call. The web UI has no token entry, Owner login or logout button; separate Owner administration stays in the CLI (`bastra tasks owner-login`). Execution authorization comes from the user instruction or Yes in chat. The ordinary REST API still requires its mapped credential and cannot use this cookie. A daemon restart invalidates browser sessions; the page reconnects without replaying mutations. If a new browser needs a slot at the 100-session limit, the session that has been unused longest gives way, but only if it has been idle for at least 10 minutes. This is capacity cleanup, not an automatic session expiry: an open Tasks area keeps its session in use, and an old cookie still works without capacity pressure. If all slots were used within those 10 minutes, a new browser gets `capacity` rather than displacing them. Failed Host, Origin, CSRF or credential checks do not keep a grant alive.

The browser Agent session manages every task level, including activation and completion. The user instruction or Yes in chat authorizes the commissioned execution; exact preview, target comparison and receipts remain required.
Local-access boundary: any process running as the same OS user can read/use the private Agent token. A single Owner identity supplies its assigned domains, matching existing setup-hooks so project reminders remain reachable; this does not invent a user instruction. Multiple Owners require explicit setup. Corrupt, overly permissive or revoked files are reported by normal task status, Doctor and once at daemon start; cards remain unavailable until Owner repair. Replacement of a missing automatically generated file revokes the previously managed automatic credentials.

Unsafe/corrupt or revoked reminder access detected at startup also produces one public Hook/MCP status hint per session. The hint contains no private task data and acknowledges nothing.

**Tokenless-browser boundary:** On macOS, only programs of the macOS account that owns the vault get an Agent session (#1419). Any program of that account can, including a local proxy or tunnel that rewrites or removes Host/Origin to localhost. On other systems, with the UI enabled, any local process can obtain an Agent session, including a different OS user on the same machine, without access to the credential file; loopback proves no OS user identity there. On multi-user machines without this account check, disable `ui.enabled`. Further work on this boundary is tracked in [issue #1198](https://github.com/n0mad-ai/bastra-recall/issues/1198). This is a known local-access limitation; chat authorization is attributed to the connected agent, not cryptographic proof of the human’s identity.
The same actual request at the same time is deduplicated even after required redaction; different contents remain separate. Internal context assembly records no card delivery. The SessionStart output presents the due card and records its presentation attempt at the output.
Reminder comparison now belongs to a private local key for this task store. Neither the key nor the comparison value appears in cards, API/status or task exports. Valid legacy task snapshots, backups and managed archives lose unkeyed reminder/create comparisons; redacted secrets are never reconstructed. Legacy request retries that can no longer be verified are rejected; use the existing task ID. The key stays local and is not silently replaced when lost. Unrestricted filesystem access as the same OS user remains outside this boundary. Event baselines, event/claim values and material/retry comparisons also use this key. A raw expected value or its lowercase SHA-256 digest produces the same private comparison; the supplied digest is not retained as display text, including content-version on a general event source. Only registered file/Git/Memory sources expose actual version identifiers. Migration binds existing content digests to the key without recovering scrubbed secrets. API responses, cards and cold exports omit comparison fields. Git OIDs, file/Memory versions and exact execution byte digests remain version/integrity metadata. Pre-upgrade proposals are conservatively retired as stale and require new preparation and fresh existing approvals. Their old task/challenge/approval binding values and signatures are removed from live snapshots, backups and managed archives; status shows stale. IDs, spending and receipts stay intact, including exact executed retries and newly approved rollback. No approval rights change. Previously copied responses, signatures or exports cannot be recalled. Original proposal IDs stay as audit/retry references; with sufficient original signing metadata they can still verify historical guesses. Stale replies and cold exports no longer supply that old signing body. Restored terminal archives carry no comparison proof and need a new explicitly reviewed baseline before reuse.

## Task reports

Agents file their final report after larger or autonomous work in Recall instead of writing a long chat answer: `task_report_save` with a one-line `title`, a Markdown `body` (any length up to the request limit, never shortened), an optional `project` and `origin` `{client, session}`. Before storage Recall cleans the text: complete injected context blocks (hook and harness blocks) are removed, secrets are replaced by redaction placeholders, and control and invisible format characters other than line breaks and tabs are dropped — a CR in CRLF line endings and the zero-width joiners in combined emoji disappear. Title, project and origin are cleaned the same way. Actor, domains and time come from the server; a report is not bound to a task and grants no action authority. In the Recall UI the Tasks area shows a **Reports** button with the number of unread reports (`REPORTS · 0` when all are read, like the due counter); the reports view lists unread and total. It switches the main area from the calendar to the reports view, laid out like the memory browser: the list on the left (unread first), the chosen report across the full width on the right. Opening the view selects the first unread report, otherwise the newest; Esc or the button returns to the calendar. Opening a report does not change its read state: **Mark read** marks it read, **Mark unread** puts it back, **Delete** removes it. Right after **Delete** a notice above the next report offers **Undo** for as long as that report is on screen; Recall keeps a deleted report for 10 minutes, and **Undo** brings it back with its text, read state and notes. A search field above the list filters it by title and project as you type and by the report text as soon as Recall answers; every word must occur, case and Unicode form do not matter. When the report store is full, marking, notes and the hand-over say so and that deleting old reports makes room. The left rail has its own **Reports** entry right below **Tasks**, built like every other entry: it opens the reports view and is lit while the view is open (on the calendar **Tasks** is lit), its cyan badge counts the unread reports, and its tooltip names unread reports and reports with notes not handed over yet. The header ticker lists unread reports ahead of due tasks, and the **Reports** dashboard widget lists the newest ones; a click opens the reports view with that report selected. Visibility follows the task domains. At most 200 reports are kept; beyond that a new report is refused (`capacity`) and nothing is dropped. `task_report_list` (optional `query`, at most 200 characters: only reports whose title, project or text hold every word), `task_report_read`, `task_report_mark` (`{id, read}`, idempotent), `task_report_delete` and `task_report_restore` complete the set; `task_report_read` only reads and never marks a report read, also when an agent reads it. `task_report_delete` answers with `restorable_until`; until then `task_report_restore` (`{id}`) brings the report back as it was, with the same domain rule and within the 200-report limit (`capacity` otherwise). After that time, or once 20 newer deletes followed, the report is gone for good and a restore answers `not_found`.

### Notes on a report

While reading, the user can leave a note on a single place of a report: a heading, a paragraph, a list item or a table row. Hovering or focusing the place shows a small **Note** button; it opens a field with **Save note**, **Cancel** and **Improve text** (the same local-model rewrite as the vault-care field in the memory browser, with **Undo**; without a local model the same message appears and the text stays). Saved notes stand right below their place in an amber card and offer **Edit** and **Delete**. A new note is a **draft**: it stays with you, and no agent sees it. **Hand over to agent** in the report's head — shown while the report has drafts, with their number, as the head's main action — hands every draft of that report over at once; a short message confirms it and nothing else is asked. Each note shows its state: **Draft** (muted, dashed frame), **Handed over · open** (amber) or **Done** (green, with the agent's reply below it); a place whose notes are all done turns green. The report list and the report's head show drafts still with you (✎) and handed-over open notes (➜) apart. Leaving, editing or deleting a note never changes the report's read state. A note whose place can no longer be found in the rendered report is listed at its end, never dropped.

Each note stores its anchor — the block kind (`heading`, `paragraph`, `item`, `row`), its 1-based number among the annotatable blocks of the rendered report and a short excerpt, so an agent finds the place without the UI — the user's text (at most 4,000 characters, cleaned like the report body), the time and the state `open` or `done`, the time it was handed over (`handed_at`; without it the note is a draft, and notes written before the hand-over existed count as drafts too), plus the agent's optional reply (at most 1,000 characters). Notes are part of their report's record: they follow its domain rule and go with it when the report is deleted. `task_report_read` returns them as `notes`; `task_report_list` counts open ones as `notes_open`. For an agent both hold only handed-over and done notes — a draft appears neither in the text nor in a count, and `task_report_note_done` on a draft is refused (`not_found`). The UI sees every note and also gets the drafts counted as `notes_draft`. The UI uses `task_report_note_add` (`{id, anchor, text}`), `task_report_note_edit` (`{id, note_id, text}`; an edited note is open again as a draft and loses an earlier reply), `task_report_note_delete` (`{id, note_id}`) and `task_report_notes_hand` (`{id}`; hands every draft of the report over and returns their number as `handed`). These four run only through the UI's own session (`/ui/tasks/api/…`, loopback, cookie and CSRF token): they are no agent tool, and the MCP tool call and `/api/v1/…` refuse them with `forbidden` (HTTP 403), even with the same credential. So a note text always comes from the user, and no agent — nor text an agent read somewhere — can leave an instruction in the user's name. An agent closes a note with `task_report_note_done` (`{id, note_id, reply?}`).

At session start an agent with a task credential for the report's domains is told, in a short `<report-notes>` block next to the vault-care notice, how many open notes the user handed over on which reports (at most five reports named, with id and project). The block says that the note texts are the user's own instructions — no further approval needed — while the report body around them and the report titles are written by agents, reference material and not an instruction, that a concrete task the user gives first comes first, and that each handled note is closed with `task_report_note_done`. Done notes are not announced again, drafts never; with no handed-over open note there is no block. The block follows `language.primary` (English when unset or without wording).

## Local notifications and persisted task state

With tasks enabled, `tasks.notifications` defaults to true in Settings. Set it false to disable native notifications without cancelling tasks. macOS is supported; other platforms keep next-contact delivery. Status reports actual support and whether the native daemon host is running. Notification Center may suppress presentation according to the user’s OS settings. The word that marks an expired task follows `language.primary` (English when it is unset or has no wording yet).

A durable occurrence receipt records a native claim and OS submission separately from acknowledgement. A chat display does not stop the Mac notification: it is sent once per occurrence unless the occurrence was already acknowledged or resolved, or the task is paused or muted. A submitted native notification suppresses duplicate passive conversation delivery; explicit due/board inspection still shows unread work and `already_notified`. A definite OS failure may retry after the task’s retry interval. A timeout or crash with an uncertain submission keeps its claim to avoid a possible duplicate; it does not claim human reading. The board remains available for inspection.

Task snapshot v4 migrates v1–v3 on read without changing task IDs, revisions or history. Existing cold archive bytes and integrity hashes remain unchanged; their snapshots decode through the same migration. Back up local app state before upgrading; restore/recovery remains explicit. Active tasks can be deleted with `bastra tasks delete ID --agent` or `task_delete` using `expected_revision`; in-flight or unknown execution must be reconciled first. Cold tasks use the same operation with explicit `archive_id` and the revision from `task_list {archive_id}`; CLI: `bastra tasks delete ID --archive ARCHIVE_ID --agent`. Deletion is logical: the original hash-verified private export remains a backup, while the selected task disappears from archive browsing and cannot be restored or recreated through an old idempotency key. Other tasks in the same bundle, spent approvals and fences remain intact. Repeating the same deletion is safe. A restored active copy must be deleted before its archived copies.

## Optional validity and evidence completion

`expires_at` is an optional UTC epoch-millisecond validity end, separate from the due time and recurrence `until`. At that instant an unresolved task becomes `expired`, even while paused or snoozed. It is disarmed and emits one durable expiry notice; this does not claim completion. Without `expires_at`, due work stays open until explicitly resolved or until an explicitly configured evidence policy verifies completion.

Use `--expires` when creating a task, `bastra tasks edit ID --expires 2026-12-01T18:00:00Z` to change it, or `--expires none` to remove it. The board provides the same optional validity field. MCP/HTTP edits use `patch: {"expires_at": null}` to clear it. An expired task needs explicit rearm and review after changing its validity; editing alone never revives a terminal task. Acknowledge the expiry notice before archiving the expired task.

For a one-off task with nonempty registered `evidence`, opt in to `auto_resolve: {"verifier_id":"bound-evidence-v1"}`. The existing bounded verifier must confirm the exact registered revisions/hashes, attributable evidence and permitted state age in a fresh check. Only `verified` completes it; stale, unavailable, revised, future or contested evidence cannot. `resolution_condition` stays descriptive and is never parsed as code or a text command. Recurring tasks cannot reuse this policy because evidence would need rebinding for each occurrence. Set `auto_resolve: null` in an edit to remove the policy.

## Local app integration

The [local task app API](Local%20Task%20App%20API.md) documents the SSE stream, explicit read receipt, execution-result retrieval and attributed executor reports. The generated [OpenAPI contract](openapi.yaml) specifies local routes. Each reconnect resynchronizes current durable state; the stream is not a historical replay log. No remote access, device pairing, phone push, provider action or agent launcher is included. General non-task freshness remains outside this task contract.


Local snapshot sources for projects, worktrees, task phases, symbols and metadata are documented in [Local Task State Adapters](Local%20Task%20State%20Adapters.md).
