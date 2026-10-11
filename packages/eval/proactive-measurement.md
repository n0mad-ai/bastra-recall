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

The registered matrix has 25 cases, three repetitions each (75 required runs).
On corrected P8 stack `f5f8f14924e72d446c65c8771c087c72f3d144ac`, the complete
P1/P2/P3/notify segment passed **48/48**, including ordinary passive contact,
seven-day synthetic clock advance, offline restart, relay overflow/off/purge,
multi-client identity and acknowledged unfinished work. The final full available
segment completed **72/75 observed: 66 passed, 6 failed, 3 pending**. The P10
migration case remains unavailable. All 72 child-process audits confirm cleanup;
zero blocked network attempts. Three failed material-premise rows also lack
owner-control ground truth because an automatic occurrence never appeared.
Those missing fields cannot count as successful owner controls.

Separate focused action segments each pass **3/3**: exact reversible write with
newly approved rollback, containment/revocation, two-domain approval/fencing,
forgery/drift, execution stop/adapter disable, actual daemon crashes and readonly
recovery, plus decision supersession. These use invented signatures and real
temporary target bytes/mtime, never human approval or an OS-protected key claim.

Historical P6 findings on `f5f8f149` prevented confirmation: an identical versioned-claim event
retry returns conflict, caused by an order-sensitive claim comparison. The
unknown-source runtime control fails 3/3 because irrelevant/contested events lack
persisted verification inside the preregistered 5s contact deadline; the actual
published verifier on those same files returns inconclusive. No false occurrence
or automatic decision reversal was observed. Setup/incomplete segments retain
their private artifacts and cannot count as passes.

The user-requested P3 review controls were registered in `cf2b64e4` before their
runs: original `e78ff4f4` fails automatic evaluation and file/Git A,B,A,B in 3/3
each. Returning transitions pass on corrected `4bc482fb`; automatic startup,
next-contact and periodic polling pass on P5a `87b80f3e` and corrected P8.
The independently found cross-domain source/key collision was registered in
`71143079`, fails on P4 `465a6800` and `84a241ed`, and passes on `b5a994ed` onward.
All original failed artifacts/protocol hashes remain unchanged.

Every head, driver revision and selected subset is a separate segment; counts
are never pooled into an empirical error rate. #402/#410 retain historical failed segments; current corrected focused
controls pass, and overall confirmation remains pending; #598 and longitudinal/independent combined
confirmation remain pending. No human or longitudinal window started.

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
