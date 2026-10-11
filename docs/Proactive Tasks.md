# Tasks and reminders

## Owner decision 2026-10-11: notify in conversation

Say “remind me …”: the agent first confirms what, weekday/date/time/timezone and recurrence with “Yes, add” / “No” or free-text refinement. Ambiguous time is clarified. It then creates an armed notify reminder directly. When it notices a deadline or promised follow-up itself, it adds it without a question and acknowledges in one line: `→ Erinnerung eingetragen: <was> – <wann>`.

Due cards are briefly mentioned at response start. “Done”, “tomorrow again” or “forget it” control notify in conversation. Origin (user request / agent observed), client, session and scrubbed cause remain visible. There are no daily or open-reminder limits; identical cause/time is deduplicated. Physical store/delivery budgets still apply. `BASTRA_CONVERSATIONAL_REMINDERS=0` disables conversational arming; the agent reports an unarmed draft instead. One-off work requests do not become reminders.

The server cannot prove claimed user intent. This residual boundary is consciously accepted: an unwanted reminder can be cancelled in conversation. Prepare/execute keep the existing approval path in this task; Daniel plans to discuss it later.

Bastra keeps explicit tasks beyond one chat. A due card asks for evaluation; it does not prove a measurement passed. Delivery is only a presentation attempt. Explicit owner acknowledgement means seen; completion and an action receipt are separate records. Delivery is at next contact while the daemon runs; an absent client is not automatically awakened.

## 1 From zero to your first card

Use your own terminal and an existing private owner directory outside agent access. Keep tokens out of chat.

```sh
bastra tasks auth mint owner me personal /PRIVATE/OWNER/task.token
```

Confirm `[y/N]` with `yes` if intended. Open the new private file locally and copy the token into hidden prompts. It is an owner task credential, not a signing key.

Optional private cache:

```sh
bastra tasks owner-login
```

This is interactive-only, revalidated against the registry on each command, and never used by hooks/MCP. It must remain outside agent access. Signing keys/passphrases stay separate.

```sh
bastra tasks setup-hooks
bastra tasks client-status
```

setup-hooks assigns a separate agent credential to local clients. Explicit BASTRA_TASK_TOKEN overrides that file. Missing, invalid or revoked access is shown honestly. Configured access alone does not start the daemon.

```sh
bastra tasks create --goal "Evaluate the run" --after 1m --timezone Europe/Madrid --domain personal --arm
bastra tasks list
```

The confirmation shows what, when, timezone, state and armed/unarmed. Without --arm it stays unarmed; prepare/execute agent proposals do. Owner review is explicit:

```sh
bastra tasks review TASK_ID
```

After the minute and a suitable contact/poll:

```sh
bastra tasks due
bastra tasks acknowledge TASK_ID --occurrence OCCURRENCE_ID
bastra tasks resolve TASK_ID
```

Copy IDs from the card. Acknowledge means seen, still open. Only resolve completes it. cancel stops it; rearm brings it back **unarmed**, with no renewed old approval. The normal CLI uses readable German output; --json remains the machine format.

## 2 Time, repeats and postponement

```sh
bastra tasks create --goal "Evaluate after seven days" --after 7d --timezone Europe/Madrid
bastra tasks create --goal "Daily review" --when 2026-10-12T18:00 --timezone Europe/Madrid --every 1d --count 3
bastra tasks snooze TASK_ID --until 18:00
```

After 7d means elapsed duration. Local --when uses the given timezone; an omitted timezone is explicitly reported as a system-timezone assumption. Local calendar repeats differ from elapsed days. Every repeat needs a count or --end. Nonexistent DST time rejects; ambiguous autumn time chooses the earlier instant but stays visibly unarmed until owner review. Simple snooze uses the next local 18:00; a full future date works too. The fixed agent 24-hour snooze ceiling applies to prepare/execute.

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

Execution is stopped by default. Only the owner can confirm execution-enable/resume with a protected configuration. No is the default, leaving state unchanged. Active reservations appear in status; `tasks release ID` releases your reservation without rolling back an effect or renewing proof.

## 4 Browser and decision reconsideration

```sh
bastra config set ui.enabled true
bastra tasks ui
```

The optional task page holds the token only in page memory and renders task content as text. Creation defaults unarmed. Review, acknowledgement, postponement, resolution and cancellation remain separate. Terminal buttons are disabled. Before/after proposals are readable; full binding remains inspectable.

A versioned attributable premise change can invite Keep/Change/Snooze/Stop, showing the old decision/rationale and new evidence/uncertainty. Saving a decision alone does not arm a watch. Unknown, contested, stale or unavailable is not refutation. Keep disarms; another change needs owner rebinding. Changing the decision requires explicit owner choice and an actual CAS memory revision, with no new ordinary memory field.

## 5 Register one reversible local artifact

Only local-artifact-v1 is supported: replace an existing registered reversible UTF-8 file with exact approved bytes. No provider messaging, email, Slack, GitHub, cloud or shell adapters.

```sh
bastra tasks targets register demo --root /WORK/ARTIFACTS --path artifact.txt --domain personal
bastra tasks targets list
bastra tasks keys enroll personal /PRIVATE/OWNER/approval-key.json
bastra tasks boundary
# Restart task processes to pin the changed registry.
bastra tasks execution-enable
```

Each question defaults No. Key enrollment asks for the hidden owner token, new hidden passphrase and repetition. boundary asks for the token and explicit assertion. Before signing, inspect the readable whole binding and exact bytes; approve asks for confirmation and the hidden key passphrase. Keys remain outside agent access.

The real resolved narrow work root is shown. Task/key/vault/control/profile locations, all .git state, .husky, .github/workflows, .envrc and .npmrc are blocked. Enclosing protected roots reject too. package.json receives a specific possible-script-execution warning; no extra capability follows. Outside the current project, a work-root warning precedes consent.

```sh
bastra tasks targets update demo --root /WORK/ARTIFACTS --path other.txt --domain personal
bastra tasks targets remove demo
```

Registry edits stop execution, reset protected_boundary, change the revision and stale old proofs. Never silently replace an ID. Restart and review again. Tabs/CRLF/BOM/control characters, unsafe preview transformations and before-state above 16384 characters reject before execute.

## 6 Approval, execute, rollback and unknown outcomes

Notify/prepare need no signing key or boundary assertion. Execute needs actual owner/agent OS isolation, all required domain signatures, current task/target/source/payload/expiry, a live actor reservation/fence and enabled execution. protected_boundary is an unverified owner assertion; unrestricted same-UID agents are outside it. A browser token, model claim or API boolean cannot sign.

Prepare writes no target. Approval binds exact before/after bytes and the whole context. The daemon rechecks under the lock and spends proof/persists intent before effect. Double clicks are blocked; a failed browser attempt releases its reservation. Check receipts/status before retry, never infer success from a lease.

A concrete owner flow after registering the target and enabling execution:

```sh
bastra tasks create --goal "Replace reviewed local artifact" --when 2000-01-01T00:00:00Z --timezone Europe/Madrid --domain personal --level execute --arm
bastra tasks ui
```

On the page, choose **Vorbereiten**, target ID and exact new bytes. Inspect the before/after preview, copy the proposal ID, then in your separate owner terminal:

```sh
bastra tasks approve PROPOSAL_ID personal /PRIVATE/OWNER/approval-key.json
```

Confirm the whole readable binding and enter the hidden passphrase. Refresh and reopen the same proposal on the page; exact execute is enabled only for complete current signatures. Status shows intents and receipts. If already reserved, inspect status and release your own reservation with `bastra tasks release LEASE_ID`, or wait up to 30 seconds; never blindly retry an unknown effect.

For rollback, select a successful receipt under **Wirkungen und Abgleich**, prepare rollback, separately sign its new proposal and execute it. Rollback is another newly signed exact CAS operation; intervening target edits block it. It remains available after resolution/cancellation/snooze. A crash yields exact-hash reconciliation or visible unknown/review, never blind retry. Only own hash-bound temp files are cleaned; foreign remnants stay visible and can be safely revisited.

## 7 Resource limits, archives and repair

Per-task intervals, timeout and byte allowance apply to source intake and evidence checks. Global turns have at most 10 assessments/5 s, source reads at most 1 s and 1 MiB, poll 60 s, unchanged failure backoff up to 1 h, active snapshot 4 MiB (normal admission 75 %). Shared source admission follows eligible consumers and each task independently rejects results above its limit. Memory intake includes the unique-file locator: the byte limit covers the sum of scanned Markdown files. Too-small byte allowance reports source_budget / “Quell-Bytegrenze überschritten”, timeout reports source_timeout, with no trigger. Deadlines prevent accepting late results; they do not promise atomic interruption of arbitrary OS I/O. New accepted events bypass old backoff; errors/lock/capacity/process suspension prevent a universal wallclock guarantee.

```sh
bastra tasks stop
bastra tasks archive FINISHED_TASK_ID
bastra tasks archive-restore ARCHIVE_ID
```

Archive exports exact private terminal groups before retiring active rows. Unresolved occurrences, pending/unknown intents and active leases cannot be retired. Cold idempotency, history and known spent IDs/fencing remain. Missing/tampered exports fail closed. Restore imports terminal history for fresh approved rollback, stays unarmed and stops execution. Journal/spent/archive-index limits can still produce visible capacity backpressure; no silent eviction.

Stop all task processes before `recover [--lock]`. Confirm private validated backup recovery; original is quarantined, epoch changes, tasks disarm and execution stops. Newer changes may be missing. Cold exports and readable original indexes/spent IDs/fence maxima are reconciled; terminal history can return alongside its archive without new authority. Unknown-lock quarantine needs explicit offline assertion and refuses a known live local owner.

If the original is unreadable and backup predates a recent unarchived effect, its receipt/consumed ID can be absent. The new epoch still blocks its old approval. That is replay safety, not full audit reconstruction: inspect original and target.

## 8 Disposable walkthrough

Use the [20–30-minute isolated owner demo](design/proactive-tasks-demo.md). It starts its own daemon/port/profile with invented data, neutralizes inherited test/output settings, and includes browser/CLI notify, postponement, prepare/sign/execute/rollback and prepared decision-reconsideration files. Terminal close cleans the own daemon and own disposable root. No real human/OS-boundary or longitudinal evidence is inferred.

See the [final 14-case matrix](design/proactive-tasks-matrix.md) and [German instructions](Proaktive%20Aufgaben.md). Human comprehension, interruption burden and longitudinal utility remain separate pending confirmations.

Reminder comparison now belongs to a private local key for this task store. Neither the key nor the comparison value appears in cards, API/status or task exports. Valid legacy task snapshots, backups and managed archives lose unkeyed reminder/create comparisons; redacted secrets are never reconstructed. Legacy request retries that can no longer be verified are rejected; use the existing task ID. The key stays local and is not silently replaced when lost. Unrestricted filesystem access as the same OS user remains outside this boundary. Event baselines, event/claim values and material/retry comparisons also use this key. A raw expected value or its lowercase SHA-256 digest produces the same private comparison; the supplied digest is not retained as display text, including content-version on a general event source. Only registered file/Git/Memory sources expose actual version identifiers. Migration binds existing content digests to the key without recovering scrubbed secrets. API responses, cards and cold exports omit comparison fields. Git OIDs, file/Memory versions and exact execution byte digests remain version/integrity metadata. Pre-upgrade proposals are conservatively retired as stale and require new preparation and fresh existing approvals. Their old task/challenge/approval binding values and signatures are removed from live snapshots, backups and managed archives; status shows stale. IDs, spending and receipts stay intact, including exact executed retries and newly approved rollback. No approval rights change. Previously copied responses, signatures or exports cannot be recalled. Original proposal IDs stay as audit/retry references; with sufficient original signing metadata they can still verify historical guesses. Stale replies and cold exports no longer supply that old signing body. Restored terminal archives carry no comparison proof and need a new explicitly reviewed baseline before reuse.
