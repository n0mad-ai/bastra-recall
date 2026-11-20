# Before/after replay of the behaviour-neutral refactors, 2026-11-18

Issues #1511, #1512, #1513, #1525, #1526, #1528 and #1530 ask for characterization that is green on the old code before the first structural commit. The golden tests and the restructuring landed in one squashed commit, so that order can no longer be shown from history. This report does the next best thing after the fact: it runs the golden and characterization tests against the old source, unchanged, in a separate worktree. It was run by an agent that wrote none of the refactors. No product code was changed for it.

What this does **not** replace: a comparison recorded before the restructuring, timing identity (the goldens normalize every `*_ms` value and clock), and an independent attempt to break the refactors with new inputs (except #1528, where one exists).

## Commits

| Issue | First structural commit | Old code (its parent) | Tests replayed |
|---|---|---|---|
| #1511 prompt lane | `e11740d9` | `eba66497` | `packages/daemon/__tests__/prompt-lane-golden.test.ts` (+ `.snapshot`) |
| #1512 session lane | `e11740d9` | `eba66497` | `session-lane-golden.test.ts` (+ `.snapshot`) |
| #1513 hook recall | `e11740d9` | `eba66497` | `hook-recall-golden.test.ts` (+ `.snapshot`) |
| #1525 write lane, gate state | `e11740d9` | `eba66497` | `write-lane-golden.test.ts`, `gate-lane-state-golden.test.ts` (+ `.snapshot`) |
| #1526 task evaluation | `e11740d9` | `eba66497` | `task-actions.test.ts`, `task-events.test.ts` (no golden file exists for it) |
| #1530 statusline | `e11740d9` | `eba66497` | `tools/__tests__/statusline-tui-segments.test.mjs`, `codex-panel-poll.test.mjs`, `codex-projection-records.test.mjs`, `panel-designs.test.mjs` |
| #1528 `redactSecrets` | `eba66497` | `cb23b903` | see its own section |

`e11740d9` names #1511, #1512, #1513, #1525, #1526 and #1530 in its message and is the commit that restructured their target files; `eba66497` touched some of them with small changes only. The golden files were added in `e11740d9`. Because that commit is a batch, it also carries behaviour changes in the same areas; they explain every difference below.

## Method

```sh
git worktree add --detach <scratch>/alt-eba66497 eba66497
cd <scratch>/alt-eba66497
npm ci
npm run build --workspace=@bastra-recall/core
npm run build --workspace=@bastra-recall/daemon
# for each test file (and .snapshot) listed above:
git show <rev>:<file> > <scratch>/alt-eba66497/<file>
nice -n 15 node --import tsx --import ./scripts/test-env.mjs --test --test-concurrency=2 --test-timeout=60000 <files of one issue>
```

Two test revisions were replayed against the old code: **A**, the tests as recorded in `e11740d9`; **B**, today's tests (`02e4e0f7`). B was also run against today's code. Node 24.16.0, macOS arm64. Each issue's files ran as one group.

## Result

| Issue | A on old code | B on old code | B on today's code |
|---|---|---|---|
| #1511 | 18/18 | 18/18 | 18/18 |
| #1512 | 10/10 | 10/10 | 10/10 |
| #1513 | 1/8 (7 differ, score values only) | 1/8 (same) | 8/8 |
| #1525 | 28/28 | 27/28 (1 differs, later fix) | 28/28 |
| #1526 | 49/50 (1 test of a behaviour fix) | 49/50 (same) | 50/50 |
| #1530 | 40/40 | 41/41 | 41/41 |

### The differences, explained

- **#1513**: in all seven cases the only differing values are `score` and `top_score`, 47 values, each exactly 0.286 times the golden value on the old code. `e11740d9` also changed `packages/core/src/search-staleness.ts` (#1567): the multiplier for a memory that is `expired` by type age alone went from 0.2 to 0.7, and 0.2 / 0.7 = 0.286. The fixture memories are expired by type age. Hit order, ids, telemetry fields and everything else in the payloads are identical. So the golden matches the old orchestration once the intended ranking change is factored out, but this replay cannot show that without that one change.
- **#1525**, B only: `gate state golden — a subagent leaves the pending must-load alone` expects `agentToolCalls` per agent; that snapshot was updated by the later fix `a3078a63` ("count rule kernel cadence separately for each agent"). A, the version from `e11740d9`, is green on the old code.
- **#1526**: `#1599 a full store does not hide an already scheduled reminder from next contact` tests the #1599 fix shipped in the same batch; it is red on the old code by design. The 49 other task tests are green.

## #1528: `redactSecrets` across the split

Old code: `cb23b903` (parent of `eba66497`). Code after the split: `eba66497`.

| Check | Result |
|---|---|
| Core suite at `cb23b903` (its own tests) | 917 pass, 0 fail, 1 todo of 918 |
| Core suite at `eba66497` (its own tests) | 931 pass, 0 fail, 1 todo of 932 |
| The `cb23b903` core tests (114 files) on `eba66497` code | 914 pass, 2 fail, 1 cancelled, 1 todo of 918. The three are in `commit-claim-recovery.test.ts` and `save-concurrency.test.ts`, which `eba66497` itself adjusted for a claim change; none is a redaction or scrub test |
| Today's `redact-secrets-differential` fixture (20,000 seeded inputs, outputs frozen from `cb23b903`), harness outside the repo | `cb23b903`: 20,000 of 20,000 equal. `eba66497`: 20,000 of 20,000 equal. The 274 listed #1625 exceptions give the old frozen output on both, as expected, because #1625 came later |
| Today's redaction/scrub tests (9 files) on `cb23b903` | 184 of 192 pass. `redact-secrets-corpus.test.ts` is green. The 8 failures test later additions (#1625 PSK in questions, invisible-character and markup defusing from later commits) plus the differential test, which fails only on the 274 #1625 exceptions |

The differential harness (`node --import tsx diff1528.mts <checkout>`) loads `src/scrub.ts` of the checkout and today's fixture, and counts equal and differing outputs separately for regular and exception cases.

## Limits

- After the fact: the old code is the exact source from git, so the comparison is the same one a recorded run would have made; what cannot be shown is that it was made before the restructuring.
- Timing: no golden covers time points or deadlines (#1511, #1512, #1513, #1525 name them). For #1512, #1513 and #1525 this is closed by the timing tests in the addendum below; #1511 is not covered.
- #1513 differs by the #1567 ranking change from the same batch. Isolating it would need the old daemon code with the new staleness multipliers, which is a code change and was not done.
- #1526 has no golden file; the replay uses the task tests that existed at both commits.

## Addendum 2026-11-20: timing

Four test files pin the clock-derived values the goldens normalize. They mock `Date` (and `setTimeout` where the deadline is a plain timer), inject elapsed time through seams the lanes already have, and let a socket timeout expire through a spy on `node:http`'s `request` (`packages/daemon/__tests__/loopback-request-spy.ts`). No assertion depends on the wall clock.

| Issue | File | What is pinned |
|---|---|---|
| #1512 | `session-lane-timing.test.ts` | health probe 200 ms capped / 80 ms floor; context call timeout and `budget.time_ms` 1500 − elapsed, 60 ms floor; `vector_deadline_ms` 350, `lexical_only` when cold; `hook_budget_ms` 1500; `latency_ms_total`; probe started before the context call; a timed-out context call or probe answers like the failed or healthy case |
| #1513 | `hook-recall-timing.test.ts` | dense-arm deadline 150 ms default, clamped 50..10000; content recall after the prompt recall with the same deadline; `lexical_only` without a dense arm; `latency_ms_recall`, `latency_ms_total`, payload `latency_ms`, content `latency_ms`; shadow-router budget; a stuck dense arm abandoned at exactly its deadline, served lexically, `degraded: vector-arm-timeout` |
| #1525 | `write-lane-timing.test.ts` | recall awaited at 599 ms, given up at exactly 600 ms with the same answer as no daemon (size note alone), status `timeout`; a recall answered at 599 ms is used; `latency_ms_total` |
| #1525 | `gate-lane-timing.test.ts` | pending must-load claimed into a deny at 499 ms of the 500 ms budget; from 500 ms (or at a caller's absolute deadline) the call passes, nothing is claimed, the ids are reported unclaimed |

Each file was also run with its lane module replaced by the source of `eba66497` (the old file copied next to today's modules under a temporary name, the test's import pointed at it, both removed afterwards). Only the lane file itself is old; the modules it imports are today's.

| File | Today's code | Lane file of `eba66497` |
|---|---|---|
| `session-lane-timing.test.ts` | 7/7 | 7/7 |
| `hook-recall-timing.test.ts` | 6/6 | 6/6 |
| `write-lane-timing.test.ts` | 3/3 | 3/3 |
| `gate-lane-timing.test.ts` | 3/3 | 3/3 |

Stability: all four files 10 runs in a row with six busy-loop processes beside them, 190/190; once more in a copy of the tree without git metadata, 19/19.

Not covered: the write lane's 50 ms floor for the recall and the size note's quarter-budget deadline (no seam moves the clock before them without a code change; #1538 has its own test), the gate's late-response branch after a successful write, and the draft band's deadline.
