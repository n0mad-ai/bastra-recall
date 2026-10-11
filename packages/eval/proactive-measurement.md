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

The registered matrix now has 24 cases, three repetitions each (72 required runs):
14 original build-plan rows, migration/containment rows, six P1/P2 cases and two
P3 review controls.
The observation interface is not a competing task/API/storage schema.

| Pinned clean feature head | Available cases | Replays passed | Full coverage |
|---|---:|---:|---|
| P2c #1170 `4041932736e24d4c78365fa9f3728376c12ca26f` | 6 | 18/18 | 18/66, pending |
| P3 #1171 `e78ff4f4808bafcc942759c69f584cf72d58f0b2` | 7 | 21/21 | 21/66, pending |

The first two rows above are the original mechanics-only registrations. They did
not test automatic start/contact/poll evaluation or returning A,B,A,B sources.
Under the new review registration, unchanged P3 e78ff4f4 produced **21 passing
and 6 failing replays / 27 observed of 72 required**: every automatic phase had
0 instead of 1 firing; file and Git each recorded 2 instead of 4 events. Both
controls failed all three repetitions. #402/#410 have observed functional failures;
#598 human confirmation remains pending. Corrected 4bc482fb independently produced 24 passing and 3 failing replays:
file/Git A,B,A,B now yields four events each in 3/3 repetitions; automatic
start/contact/polling still fails 3/3. Builder handover defers runtime wiring
to P5, so an internal engine alone cannot pass that control. Earlier mechanical passes are preserved, not relabelled.

Each revision is a separate segment; repeated observations across revisions are
not pooled into an empirical error rate. No human or longitudinal window started.
P5 delivery and P8 execution remain pending. Coverage also requires their P4/P6/
P7/P9/P10 dependencies where named by each case.

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
Timers keep their real monotonic clock. All 21 latest replays stopped every child
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
Missing stage dependencies leave their cases pending. Each named subrun must
execute before its combined assertion is returned. Violated invariants remain
failed even when other evidence is missing; incomplete rows are not evaluable.

```sh
node --import tsx --test packages/eval/__tests__/proactive-measurement.test.ts
npm run check:types --workspace=@bastra-recall/eval
```

Evaluator tests use manufactured rows only to test missing data, denial/failure
classification and incomplete gates. Those rows are not feature evidence.
Latest eval typechecks and six evaluator tests pass. Initial registration/evaluator
verification passed 37 tests. CI is tracked separately for each pushed eval head.

## Later stages

Check the builder handover for published P5/P8 heads, fetch clean measurement
worktrees, extend the eval driver against their published APIs and rerun affected
cases. Declare only implemented driver stages; a file or interface alone is not
coverage. Preserve earlier raw artifacts and code segments. Stop all created
processes in `finally`. Synthetic signing keys later test mechanics, not a real
human approval or protected owner key boundary.

Current observed invariant failures are reported as failed for #402/#410; the
unstarted human study stays pending. Adequate registered human,
longitudinal and independent-review evidence is still required. Consent and actual
opportunities are required before starting those windows; elapsed time cannot
change their verdicts.
