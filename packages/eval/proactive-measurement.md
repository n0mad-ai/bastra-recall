# Proactive measurements (#402 / #598 / #410)

Measurement PR [#1158](https://github.com/n0mad-ai/bastra-recall/pull/1158), milestone
[#30](https://github.com/n0mad-ai/bastra-recall/milestone/30). Protocols were committed
before observations in `c65394bf`. Later amendments pin reviewed P0/P1/P2 contracts,
clarify three total repetitions, and register six P1/P2 mechanics cases in `22e62f25`
before any runtime run. Independent-review controls were added in `cf2b64e4`
BEFORE those new runs (#402 v5, #598/#410 v4), preserving the earlier protocols.
Longitudinal/human thresholds remain unchanged.

- [#402 trigger/delivery](registrations/proactive-402.json): 14-day minimum and
  labelled due/non-trigger denominators. Delivery, acknowledgement and resolution
  remain separate. A green synthetic case cannot pass this window.
- [#598 review/correction](registrations/proactive-598.json): 24 consented humans,
  counterbalanced presentation comparison with false acceptance/true rejection.
- [#410 safety/recovery](registrations/proactive-410.json): proactive matrix,
  reversible reference adapter and independent integrated-head review. This cannot
  pass the whole shared/federated V2 checklist or replace #400.

## Current functional evidence

Owner decision **11 October 2026** explicitly changes conversational notify
arming and control rights. Three prior case definitions (nine row expectations)
are preserved exactly in each registration and labelled **durch Owner-Entscheidung
11.10. ersetzt**. The new definitions grant notify arming/resolution/unbounded
snooze; Owner review/rearm and prepare/execute guards stay unchanged. Historical
raw pass/fail outcomes are not rewritten.

Frozen P11 #1197 `375702ffe81565b2a5ca2122024d53bd52afd98b` complete run:
**93 passed, 0 failed, 0 pending, 0 missing/not evaluable**. It covers all75 original
case positions under the explicitly amended expectations plus18 new rows (six
new cases×3), registered before runtime in #402 v20/#598/#410 v19.

New rows test actual session-hook.js and prompt-hook.js processes with a fresh
empty-access daemon that provisions its own private Agent file, without env token,
manual mint or setup command. One frame/attempt, no implicit acknowledgement,
stable restart access and unchanged synthetic existing client settings are checked.
Other new rows test no upgrade, same content/time dedup across client/session/key,
identical redacted secret requests versus distinct raw secrets, conversation
ack/snooze30→60days/resolve/cancel and a finite40-reminder two-day quota probe.
Two separate hook-focused validation segments also pass3/3 each; not pooled.

All93 full-run child cleanup audits pass, zero blocked network attempts,0700/0600
raw archives. Existing budgets/time limits stay unchanged. Human confirmation via
AskUserQuestion, actual conversational understanding, visual UI-tab/OS/large-vault/
longitudinal and final independent stable gates are not inferred from tool/hook
fixtures. No human or longitudinal window started. #1198 access boundaries remain
outside this measurement request; the intentionally accepted policy is not
silently tightened by the harness.

The actual driver `src/proactive-p2-driver.ts` launches the built feature daemon,
uses real HTTP, an MCP stdio forwarder process and CLI subprocesses. It checks
agent-versus-owner authority, revocation/rotation, idempotency, CAS, lifecycle,
restart and explicit stopped-daemon P1 backup recovery. Owner HTTP credentials
are invented test credentials, not human provenance. CLI coverage uses agent
mode; owner `/dev/tty` interaction, direct-MCP and bridge processes are not claimed.
Recovery uses the published P1 storage primitive because no recovery transport
exists yet. It does not attest the future P9 owner recovery UI/CLI.

P3 additionally replays Madrid DST gap/overlap, calendar versus elapsed recurrence,
latest catch-up, restart and clock rollback through the real daemon's reconcile
API. A child-only preload reads a fixture clock file; no feature source changes.
Timers keep their real monotonic clock.
For later integrated runs, CRUD-only tasks use the fixed reference instant plus
24 hours, keeping them future-due throughout the authorized day. Trigger cases
override the schedule explicitly. The first private evidence row records whether
the child fixture clock is active. Earlier private artifacts are preserved; their
first clock-mode description was generic, while their frozen-clock steps and the
preload/config hashes record the actual injected-clock operation. All 21 latest replays stopped every child
and recorded zero denied outbound connection attempts.

## Reproduce in an isolated checkout

Fetch the pinned head into a new worktree under `~/.codex/worktrees/`. Install
its lockfile and build core, statusline and daemon there. The task driver reads
that tree's built modules; it records the head, lockfile/build hashes and driver/
network-preload hashes. It rejects tracked modifications. No production daemon,
vault, services or provider writes are used.

```sh
node --import tsx packages/eval/src/proactive-measurement-run.ts \
  --out-dir ~/.bastra/eval-runs/NEW-PRIVATE-RUN \
  --driver packages/eval/src/proactive-p2-driver.ts \
  --feature-root ~/.codex/worktrees/ISOLATED-PINNED-FEATURE-HEAD
```

The host creates a fresh data root and OS-assigned loopback port for each replay,
persists its manifest before feature calls and writes every raw row privately.
The driver passes a clean child environment with a temporary home, empty invented
vault, task/credential paths, embeddings/update checks off and auto-spawn disabled.
Its network preload only permits the assigned loopback port, refuses 6723 and
records denied connections. This is a trusted Node driver boundary, not an OS
sandbox for arbitrary imported code. No unreviewed module may be loaded as driver.

Raw receipts/state/errors/requests stay in 0700/0600 private artifacts under the
existing eval-run archive. Public registration sections contain only counts,
hashes and revisions. Output paths outside that archive and overwrites are refused.
Without a driver the runner writes a pending setup report with zero observations.
For a focused corrected-head replay, `--case REGISTERED-ID` runs only that
registered case (three repetitions); all other matrix rows remain pending and
the private manifest records the selection. No unregistered case can be run.
Missing stage dependencies leave their cases pending. Each named subrun must
execute before its combined assertion is returned. Violated invariants remain
failed even when other evidence is missing; incomplete rows are not evaluable.

```sh
node --import tsx --test packages/eval/__tests__/proactive-measurement.test.ts
npm run check:types --workspace=@bastra-recall/eval
```

Evaluator tests use manufactured rows only to test missing data, denial/failure
classification and incomplete gates. Those rows are not feature evidence.
Before P5 observations, the prospective protocol adds 5500ms of quiescence
with the fixture clock held before due after each automatic-test task creation.
The host requires zero occurrences, then advances the clock. This separates
startup, next-contact and periodic-poll paths from a queued create-mutation wake.
Previously failed P3 artifacts keep their original protocol hashes/verdicts.

Latest eval typechecks and six evaluator tests pass. Initial registration/evaluator
verification passed 37 tests. CI is tracked separately for each pushed eval head.

## Later stages

P5/P8 published heads have been pulled into clean measurement worktrees and
the real-runtime driver has been extended. Continue checking the builder handover
for corrected heads and rerun affected cases. Declare only implemented driver stages; a file or interface alone is not
coverage. Preserve earlier raw artifacts and code segments. Stop all created
processes in `finally`. Synthetic signing keys later test mechanics, not a real
human approval or protected owner key boundary.

Earlier observed invariant failures remain failed in their historical segments.
Corrected tuple/automatic controls pass. Claim-retry and freshness
correction segments are reported independently; combined confirmation remains unavailable. The
unstarted human study stays pending. Adequate registered human,
longitudinal and independent-review evidence is still required. Consent and actual
opportunities are required before starting those windows; elapsed time cannot
change their verdicts.

Prospective delivery procedure (protocol #402 v8, #598/#410 v7): six existing P5 matrix cases now have real isolated daemon handlers. Frozen clock advance is synthetic only; no manual reconcile. Ordinary health API contact tests passive delivery with an empty vault. Five occurrences test bounded projection, relay-off restart and actual isolated drafts purge; actor-distinct contacts test stable occurrence IDs; acknowledgement is checked separately from resolution after restart. CLI uses shipped --json. P8 action handlers and measurement-only SIGKILL preload are implemented; source-file hashes are included in each manifest. Protocol #402 v13 and #598/#410 v12 pin the P6 real-file and action procedures. The host also records explicit supported case IDs, so published APIs alone cannot fabricate matrix coverage.

Prospective focused correction replay: #402 v14, #598/#410 v13 pin corrected P8 b93ab169. The builder documents a 5s limit for small synthetic fixtures, excluding universal syscall/contention guarantees. The two previously failed P6 cases now require exact accepted-event verification and (for material change) one durable occurrence within a single shared 5000ms host-clock interval after event acceptance. No stop at the first verification commit, no manual reconcile, no extension of the old limit. Prior red segments remain immutable.

Corrected P8 `b93ab1694cbb7fab0bfd811ca3b468c4e957ae87`: both focused cases pass 3/3, six passed / zero failed / zero missing fields. Exact Claim retry retains the same event ID; actual irrelevant/contested states are persisted; all 27 event-specific subruns complete inside the shared 5000ms bound (maximum 110ms). Owner keep/change/snooze/stop and real disk CAS/restart controls complete. All six child cleanup audits pass, zero blocked network attempts. Other 69 matrix rows are unmeasured on this head; historical failed rows are unchanged and are not pooled with this correction. Human/longitudinal/full integrated confirmation remains pending.

Prospective complete P10 replay: #402 v15, #598/#410 v14 freeze draft #1186 df3abfca before all 25 cases ×3 =75 observations. The migration handler uses original published v1 decoder/schema for a valid historical fixture and downgrade rejection, current daemon migration/write routes, and authenticated HTTP backup recovery of truncated/duplicate/future snapshots with quarantine/older-backup warnings and unchanged neighbor sentinels. All prior thresholds and failed segments are retained. Later builder pushes do not change this run head.

Prospective card correction at frozen2f9e0300: #402 v16/#598/#410 v15. Material-premise three rows retain standard task_due input{} (default2048 bytes) and every existing semantic/deadline/owner-control assertion. Separate regression runs the other72 rows using `--exclude-case material-premise-change`, recorded in manifest; selected/excluded filters cannot combine or name unregistered cases. No historical failed row is replaced and no enlarged budget is used.

Before the first card-fix runtime replay, #402 v17/#598/#410 v16 prospectively adapt tiny-budget overflow observation to the published generic availability notice. An untargeted notice has no task/occurrence ID and cannot count as a specific delivery/acknowledgement. Durable overflow/retention and stable IDs remain required; material task_due stays at default2048. Earlier empty-output observations remain unchanged.

Prospective final-head replay: #402 v18/#598/#410 v17 freeze #1186 d77cdb42 before one complete25×3=75-row run. Driver, dataset, assertions, default2048-byte due budget, tiny256-byte overflow probe, normal16384-byte inspection, shared5s premise boundary,65s polling boundary and5500ms quiescence remain unchanged. No filters or pooling with prior heads. Source-budget/demo changes are measured only at the pinned new head, without inferring human/longitudinal/stable gate success.

Prospective daily closing replay: #402 v19/#598/#410 v18 freeze #1186 e8485af7 before a complete 25×3=75-row run with no filters. Driver/runner/dataset/stimuli/assertions and budgets/deadlines are unchanged from d77cdb42. Documentation/browser text/Memory diagnosis changes are measured only through the existing registered scenarios, without inferring unregistered human/UI or special Memory-budget-negative results. Earlier artifacts remain immutable.

Owner decision11.10.2026 notify conversation contract supersedes three authority/lifecycle case definitions (p2-auth-boundaries, p2-transport-parity, p2-owner-lifecycle). Exact old definitions/status **durch Owner-Entscheidung 11.10. ersetzt** are preserved in registration; previous raw pass/fail observations unchanged. Prospective #402 v20/#598/#410 v19 measure all75 original-case positions under explicitly amended expectations plus18 new rows (six new cases×3=93). New cases cover actual session/prompt hooks with automatic empty-start access, no upgrade, raw-content dedup through redaction, conversation controls and finite40-reminder quota probe. Prepare/execute guards and budgets stay unchanged. No real human confirmation/understanding or unlimited-storage theorem is claimed.

Prospective keyed comparison replay: #402 v21/#598/#410 v20 freeze eaf5da01 for all93 rows. Existing tuple case adds exact event retry/stableID and drift409 guards; existing migration case adds valid old content-SHA main/backup migration with keyed equality and same original event ID. Claim retries, A/B/A/B, premises and dedup remain required. Public comparison removal does not relax behavioural assertions. Budgets/Owner expectations unchanged; reference day advanced to12Oct+24h for future CRUD controls. Earlier definitions/results preserved.
