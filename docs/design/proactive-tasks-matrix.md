# Final C-097 functional matrix

Scope: the stacked unmerged proactive build through P10, 2026-10-11. All fixtures
are invented, local and isolated; no production vault/service/port6723/provider
write. These are functional/security observations, not a longitudinal benefit
verdict, measured human acknowledgement, production OS isolation or stable release.
The [owner demo](proactive-tasks-demo.md) uses the actual compiled CLI and daemon.

Run from the repository root after build:

```sh
node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/task-*.test.ts
npm run check:types
npm test
```

The package's `npm test` also uses URL-derived module/repository paths for process
fixtures; it does not rely on the invoking working directory. No lint script exists.
Case references below are tests actually included in the final suite. The final
real-process smoke combines notify/prepare/execute, SIGKILL after target success
before receipt, restart reconciliation, identical retry and fresh approved rollback.

| # | Build-plan case | Executable evidence / assertion |
|---|---|---|
| 1 | Evaluate after seven days | `task-events.test.ts`: persisted seven-day duration catches up once after restart, asks to evaluate and never says gate passed. `task-final-e2e.test.ts`: actual daemon due card retains this distinction. |
| 2 | Deadline within running session | `task-runtime.test.ts`: contact catches new deadline before polling cadence; `task-passive-delivery.test.ts`: real session/prompt hooks and HTTP/MCP success receive cached work independently of recall. Final daemon creates→contact→due without manual reconcile. |
| 3 | Absent/offline/restart | Real isolated daemon startup catch-up in `task-runtime.test.ts`; final daemon stop/restart preserves stable occurrence/ack. Coverage explicitly next-contact-only, no absent-client wakeup claim. |
| 4 | Overflow/relay disabled or purged | `task-outbox.test.ts`: bounded projection/relay-off preserves pending occurrence and no fabricated attempt/ack. `task-passive-delivery.test.ts`: compact card survives tiny session budget. Final real daemon with relay off plus256-byte due overflow retains task; relay storage is not task authority. |
| 5 | Same occurrence in multiple clients | Outbox multiple-client rotation, Actor/Role budgets and120 varying-session attack; event two-process reconcile and final daemon restart preserve one occurrence. Execution two compiled processes share one effect/receipt. |
| 6 | Acknowledged but unfinished | Outbox attempts/ack/resolve are separate; passive quiet/daily acknowledged re-presentation tested. Final real daemon acknowledgement remains due after restart until explicit owner resolve. |
| 7 | DST/recurrence/clock rollback | `task-events.test.ts`: Madrid gap/earlier overlap, bounded elapsed/calendar recurrence, missed-slot catch-up, later gap and backwards clock; no duplicate. `task-friendly-cli.test.ts`: ambiguous local CLI creation stays unarmed and repeat requires bound. |
| 8 | Assumption really changes | `task-reconsideration.test.ts`: real Decision/Assumption file revisions → evidence → one card; Keep/Change/Snooze/Stop, actual CAS new memory version, retry/rollback of change intent. Old decision persists until confirmed change; no new memory field. Runtime queues new accepted claims automatically. |
| 9 | Irrelevant/stale/failed/contested | `task-freshness.test.ts` all five outcomes and unsafe evidence; `task-runtime.test.ts` persisted irrelevant/contested within contact cycle, new event bypasses backoff, controlled in-flight event race. Ordered event test prevents later irrelevant event hiding earlier true refutation. No invented occurrence. |
| 10 | Decision edited/cancelled/superseded | Reconsideration real disk edit/missing/inactive/supersession disarms, cached card withdrawal and unchanged check quiet; action/source/decision drift rejects old bindings. No automatic rebind. |
| 11 | Prepare/old approval/forged user | `task-actions.test.ts`, `task-signing-cli.test.ts`: exact draft only, self-approval/replay/drift/denial/revocation/expiry/partial domains/other bindings reject, full preview before private signing. Final daemon prepare leaves target byte-identical. |
| 12 | External success, receipt absent | `task-execution.test.ts` SIGKILL before/after rename and during reconciliation; `task-final-e2e.test.ts` kills actual HTTP-hosting daemon after rename, restart records reconciled from exact hash, retry keeps same receipt/mtime; divergence stays unknown, no blind retry. |
| 13 | Multi-owner/expired lease | P7 all-domain proofs, local actor/holder/fence and two compiled contenders; execute two domains including revoked/expired/missing, expired resumed holder and late state/evidence change; no second/unauthorized effect. Fresh rollback independently approved in real final daemon. |
| 14 | Kill switch/adapter off | Task controls require Owner/all domains; feature-off/stop/adapter-disabled reject challenge/lease/execute as applicable and preserve task/history. Final daemon status reports off/disabled and retained receipts. Resume/enable default-No via real signing/maintenance PTY. |

Additional final checks: HTTP/MCP/CLI parity and400/401/403/404/409 errors, Host and
Origin gates even with valid token, secret comparisons and collision-safe keys,
canonical claim/create/execute retries and cross-locale signatures, v1/v2→v3 and
unsupported/corrupt preservation, archive cold idempotency/fresh rollback, missing
leaf temp cleanup/foreign remainder visibility, older-backup archive reconciliation,
retained spent proof after archive/repair and epoch replay protection when newer unarchived IDs are missing, Git/automatic control target denial, package.json warning, healthy event clears global I/O stop after recovered store, protected target roots and real compiled recover --lock/target CLI, safe text UI and
state-aware controls. `task-demo-shell.test.ts` exercises the documented isolated
shell, real setup-hooks/target registration and own-daemon restart without hand
editing the registry. All child processes and artifacts use private disposable data.

## Coverage and remaining evidence

Working sources: time, authenticated Owner/tool journal, registered local file
content revision, Git ref and memory ID/revision; versioned-value-v1 premise evidence.
File/Git observe periodic snapshots, not every transient filesystem change. No
arbitrary verify_cmd execution. Working action adapter: local-artifact-v1 only.
Supported presentation: REST/MCP/bridge success, session-start and prompt hooks,
explicit CLI/optional browser. Dedicated task credentials/setup required; hookless
clients see work on contact, native provider wakeups are unsupported.

Contact/startup jobs run off the hook hot path. New accepted events bypass old
backoff and drain in bounded groups (at most10 assessments/5s source intake per
turn, plus bounded decision guards); periodic admission within the next60s healthy
wake. Five seconds is a small healthy-fixture target, not a hard bound on lock/I/O
failure or process suspension. Unchanged failures can back off to1h; status projects
why/next check/budgets. No periodic task I/O with empty/unarmed work. Exactly one
logical occurrence survives automatic/manual overlap.

#402 registers synthetic trigger/delivery/duplicate/error checks; #598 retains
human comprehension/interruption outcomes as pending; #410 receives this local
functional/security integration and independent-review history. Federation,
longitudinal utility, causal benefit, native wakeup and real OS-held key separation
are not implemented/proven by this matrix. No issue or release is closed/promoted.
