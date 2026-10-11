# Tasks and reminders

Bastra persists explicit commitments outside a chat. The daemon catches up on startup, checks at contact and polls with budgets. Delivery is at the next suitable contact: an absent client is not automatically awakened. Attempted delivery, owner acknowledgement, resolution and an action receipt are separate records. Due time asks for evaluation; it never proves a measurement gate passed.

## First reminder

At your own terminal, with the daemon running:

```sh
bastra tasks auth mint owner me personal /PRIVATE/OWNER/task.token
bastra tasks owner-login
bastra tasks setup-hooks
bastra tasks client-status
bastra tasks create --goal "Evaluate the run" --after 7d --timezone Europe/Madrid --domain personal --arm
bastra tasks list
bastra tasks due
```

Use an existing private owner directory outside agent access; tokens must not enter chat. Copy the token from its private file into the hidden prompt. owner-login is an optional interactive-only private cache, revalidated on each command and never used by hooks/MCP. setup-hooks creates a separate agent credential for local clients. A missing/revoked client token is reported honestly; configured access alone does not start the daemon.

Creation confirms what, when, timezone and armed/unarmed. Agent proposals always stay unarmed; owner review is explicit. The default CLI uses readable German output; `--json` is the machine format. Bounded repeats use `--every 1d --count 3` or `--end`; local calendar repeats differ from elapsed duration. DST gaps reject; overlapping local CLI time chooses the earlier instant but stays visibly unarmed until owner review. `snooze ID --until 18:00` uses the task timezone. `rearm` is unarmed. Acknowledge does not resolve:

```sh
bastra tasks acknowledge TASK_ID --occurrence OCCURRENCE_ID
bastra tasks resolve TASK_ID
```

## Status, review and controls

`tasks status` shows on/off, states, next check, last attempt/error, source verification and budgets. `mute` delays passive presentation; `off` pauses automatic evaluation/delivery; `stop` stops execution. Owner `due` still permits explicit inspection. No control silently finishes work or renews expired authority. Per-task source interval, timeout and byte limit are visible. Global source turns are at most10 assessments/5s, source reads at most1s, poll60s, unchanged failure backoff up to1h, active snapshot4MiB (normal admission75%). New accepted events bypass old backoff and run in cursor order; errors/process suspension prevent a universal wallclock bound.

`bastra config set ui.enabled true` and `bastra tasks ui` open the optional tasks page. Tokens stay in page memory, task strings render as text, terminal controls are disabled. Versioned premise watches show old/new evidence and Keep/Change/Snooze/Stop; storing a decision alone never arms a watch. Keep disarms, requiring owner rebinding for another change. Unknown/contested/stale/unavailable is not a refutation.

## The single action adapter

Only `local-artifact-v1`: exact replacement of an existing registered reversible UTF-8 file. No provider messaging, email, Slack, GitHub, cloud or shell adapters. Tabs/CRLF/BOM/control characters, unsafe preview transformations and before-state over16384 characters reject before execute. Target paths never include task/key/vault/control/profile state, .git, .husky, .github/workflows, .envrc or .npmrc; enclosing roots to protected state reject too. package.json receives a specific possible-script-execution warning. A chosen narrow `--root` is the allowed work directory; outside the current project it is explicitly warned about.

```sh
bastra tasks targets register demo --root /WORK/ARTIFACTS --path artifact.txt --domain personal
bastra tasks keys enroll personal /PRIVATE/OWNER/approval-key.json
bastra tasks boundary
# Restart all task processes to pin the changed registry.
bastra tasks execution-enable
```

Targets can be listed, updated with the same options, or removed by the owner. Registry edits stop execution/reset the boundary and stale old proofs. `protected_boundary` is an unverified owner assertion that agents cannot access/change owner data, signing keys or runtime; unrestricted same-UID agents are outside this guarantee. Production must provide that separation. Notify/prepare need no signing keys or such assertion. Exact before/after preview and full task/target/revision/domain/hash binding precede separate CLI signing; every required domain signs. The browser token or a model statement cannot substitute. Execute rechecks under the lock, spends approval before the adapter, and records intent/receipt. A crash leads to exact-hash reconciliation or visible unknown/review, never blind retry. Rollback is another fresh signed CAS operation and works after resolution/cancellation/snooze as well.

## Retention and recovery

Owner `archive ID` exports exact private terminal groups before retiring active rows, retaining cold idempotency, history, consumed approval IDs and fencing. Unresolved occurrences, pending/unknown intents or active leases are never archived. `archive-restore ARCHIVE_ID` imports terminal history for review/fresh rollback while stopping execution. Missing/tampered exports fail closed. Journal/spent tombstone/archive-index limits can still produce visible capacity backpressure; no silent eviction.

Stop all task processes before `recover [--lock]`. Private validated backup recovery preserves the damaged original, changes epoch, disarms and stops execution. Newer changes may be missing; valid cold exports and readable original indexes/spent IDs/fence maxima are reconciled. Terminal history may return active alongside its archive without gaining authority. Unknown-lock quarantine needs an explicit offline assertion and refuses a known live local owner. Temp cleanup handles the target missing case and never deletes foreign remnants; those stay visible for safe retry.

See the [disposable owner demo](design/proactive-tasks-demo.md), [final14-case functional matrix](design/proactive-tasks-matrix.md) and [German instructions](Proaktive%20Aufgaben.md). Synthetic test approvals and functional success are not longitudinal utility or real human observation evidence.

Recovery limit: if the current original is unreadable and the last backup predates a recent unarchived effect, its consumed ID/receipt can be absent. Known archived/readable tombstones are unioned; the new epoch and stopped/unarmed state still block replay of old approval. This is safety, not complete historical audit reconstruction; inspect the quarantined original and target.
