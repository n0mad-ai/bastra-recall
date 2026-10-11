# Proactive measurements (#402 / #598 / #410)

[Measurement milestone #30](https://github.com/n0mad-ai/bastra-recall/milestone/30).
Registrations use the existing JSON registration directory and version/amendment
convention. They were committed before runs in `c65394bf`; version 2 only records
[P0 #1159](https://github.com/n0mad-ai/bastra-recall/pull/1159), proposed design head
`313621f8a85648603c83c5eb106405fbc0b51d50`. No statistical threshold changed. #402 version 3 clarifies three total runs per
scenario to match the prepared matrix, before any feature/study observations;
prior setup manifests contained zero observations.

- [#402 trigger/delivery](registrations/proactive-402.json): labelled due and
  non-trigger opportunities, separate attempts/acknowledgements/resolutions,
  14-day minimum and minimum denominators per supported profile. Time alone
  cannot pass this window.
- [#598 review/correction](registrations/proactive-598.json): 24 consented humans,
  counterbalanced presentation comparison, false acceptance and true rejection
  measured separately. Synthetic responses cannot stand in for human decisions.
- [#410 safety/recovery](registrations/proactive-410.json): full proactive matrix,
  real reversible reference adapter, recovery and independent integrated-head
  review. This covers the proactive slice, not the whole federated V2 checklist.

## Prepared fixtures and published-contract dependencies

`src/proactive-measurement.ts` defines the 14 build-plan matrix rows and two
additional migration/containment rows, with three repetitions each: 48 runs.
Each stimulus names separate failure/control subruns where applicable. A driver
must actually exercise every named subrun before returning `*_all_subruns`.
The resulting counts are functional coverage, never empirical sample sizes.
The fixture IDs/observable assertions are a measurement interface, not an API,
task schema, second scheduler, or alternative storage contract.

P0 declares `task_create`/`task_review` and `/api/v1/tasks`, proposal-versus-armed
state, expected revisions, signed owner review, stable occurrence slots and
next-contact-only coverage. The proposed store is task-owned; render/relay reads
cannot attest acknowledgement. Clock/DST fixtures must follow its reviewed
reject/shift-forward and earlier/later policies. Synthetic signing keys may
exercise signatures in temporary roots, but cannot prove owner isolation or
human approval. P0 explicitly leaves execute disabled without a protected owner
key/configuration boundary. The #410 study must retain this limitation.

Waiting on **P2 (canonical CRUD)**, **P5 (delivery)** and **P8 (execution)**:
PR numbers have not been published at preparation time. P1/P3/P4/P6/P7/P9/P10
also gate their corresponding matrix rows. No guessed JSON DTO or runtime
feature adapter is implemented before these contracts exist.

## Run now

From the isolated eval checkout, choose a fresh child of the existing private
archive (the runner rejects output elsewhere and refuses overwrites):

```sh
node --import tsx packages/eval/src/proactive-measurement-run.ts \
  --out-dir ~/.bastra/eval-runs/proactive-a-20261011-contract-pending
```

Without a driver this records versions/hashes and **0/48 observed runs, pending**.
It does not start a longitudinal window or a daemon. Raw manifests/receipts go
only to private 0700/0600 artifacts; console output is aggregate only.

```sh
node --import tsx --test packages/eval/__tests__/proactive-measurement.test.ts
npm run check:types --workspace=@bastra-recall/eval
```

These verify the measurement evaluator's refusal of missing observations,
fabricated acknowledgements, unsafe effects and duplicate/unregistered rows.
Manufactured responses inside tests are evaluator test data, not feature evidence.

## Bind the real driver after publication

Implement an eval-only module exporting the `FeatureDriver` interface from
`src/proactive-measurement-run.ts`. Pin its feature SHA, actual published P-stage
PR numbers, P0 design hash, supported client/adapter and profile. Invoke only
published APIs or services of that clean feature worktree, using the per-run
invented data root and loopback port supplied by the host (never 6723). Install
synthetic credentials/keys only inside that root; do not load the real user's
configuration. Tear down every started process in `finally`, preserving data.

```sh
node --import tsx packages/eval/src/proactive-measurement-run.ts \
  --out-dir ~/.bastra/eval-runs/NEW-PRIVATE-RUN \
  --driver ./packages/eval/src/PUBLISHED-CONTRACT-DRIVER.ts \
  --feature-root ~/.codex/worktrees/ISOLATED-FEATURE-HEAD
```

That driver file is deliberately not provided yet. The host runs only cases
whose complete stage dependencies are declared published; missing stages keep
coverage pending. Each driver observation must include local raw receipts,
state snapshots and artifact before/after hashes, not just `passed=true`.
Independent review of the driver must check its derivation of each assertion.
The host is not an OS sandbox: the eval driver is trusted code reviewed before
use; the assigned directory/port is its mandatory scope, not an enforcement
claim. Never load an unreviewed contributor module as a driver.

Every row is privately saved before the next scenario. Known invariant failures
remain failed even if another observation is missing. Incomplete evidence is
not evaluable. Changed code/config/profile creates a new version segment.
Public reports contain counts/hashes/revisions only; do not publish private
artifacts, their paths, credentials, original requests or participant IDs.
Longitudinal/human studies need their consented profile and adequate registered
samples; today's window start remains null.
