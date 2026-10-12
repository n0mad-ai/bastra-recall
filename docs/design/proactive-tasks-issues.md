# C-097 owner checklists

Implementation in the stacked, unmerged PRs below; checks mean built/tested in the
local functional profile, not merged, shipped, stable-V2 approved or longitudinally
confirmed. No issue is closed. Final P10 independent review is separate from the
prior package/integration reviews. [Matrix](proactive-tasks-matrix.md),
[demo](proactive-tasks-demo.md), [synthetic registration](../../reports/proactive-tasks-functional-2026-10-11.md).

| Package | PR | Latest owning head |
|---|---|---|
| P0 design | #1159 | 007fbfa1 |
| stacked CI | #1163 | 72e869f9 |
| P1 store | #1164 | 0e9b4c9d |
| P2a contract | #1167 | 75181e25 |
| P2b transports | #1169 | fabbf14e |
| P2c safety/errors | #1170 | fd9ef56b |
| P3 events | #1171 | f94c4bba |
| P4 freshness/claim retry | #1172 | a3961cdf |
| P5a jobs/outbox | #1175 | 17d0f6d0 |
| P5b contact/hook delivery | #1179 | 4789eb03 |
| P6 reconsideration | #1180 | e618f063 |
| P7 trusted proof/lease | #1181 | 366c3814 |
| P9a initial CLI | #1182 | bc888745 |
| P8 execute/rollback | #1183 | b93ab169 |
| P9b UI/CLI corrections | #1184 | c8f7358f |
| P9c target/archive/recovery corrections | #1185 | ba468288 |
| P10 | final matrix/demo/docs PR | head in PR and builder handover |

## #250 integration

- [x] All 14 original cases mapped to executable final tests; real compiled daemon
  notify/prepare/execute, crash reconciliation and separately approved rollback.
- [x] Shared lifecycle/source/action contract across MCP/HTTP/CLI/UI and supported
  session/prompt/hookless contact; budget/coverage/unknown outcomes explicit.
- [x] Existing #402/#598/#410 evidence scopes retained, no duplicate evaluation epic.
- [ ] Final P10 independent review, merge/release and longitudinal confirmation.

## #403 commitment/lifecycle

- [x] Versioned independent store, absent/v1/v2/v3/corrupt/future migration/recovery;
  ordinary memory schema unchanged, request/owner/scope/source/evidence retained.
- [x] Create/review/list/get/edit/snooze/ack/resolve/cancel/rearm, monotone generation,
  expected revision, Owner gates and unarmed agent capture/DST ambiguity.
- [x] Durable occurrences/attempts, quiet/daily acknowledged re-presentation,
  overflow/relay-off/offline/multiple-client preservation; ack is not completion.
- [x] C-096 Keep/Change/Snooze/Stop, actual CAS new decision version, invalidation
  and no silent rebind; cold history/idempotency retained through repair.

## #404 triggers

- [x] Deterministic time/calendar/bounded repeat/catch-up, cursor/journal/replay,
  collision-safe event identities, A/B/A/B and two-process/crash/clock fixtures.
- [x] Actual registered file/Git/memory adapters and authenticated Owner/tool events;
  off-path daemon startup/contact/poll budget/backoff, no empty/unarmed periodic I/O.
- [x] New accepted events ordered, bypass old backoff and older in-flight cache;
  healthy snapshot after store fault clears only global I/O stop.
- [ ] Native provider/background client wakeup and optional external/webhook sources.

## #475 freshness

- [x] verified/refuted/stale/unavailable/inconclusive, real revision/state age,
  future-time/disabled-source/cached-drift rejection and unchanged checks write-free.
- [x] Versioned attributable premise evidence, negative/secret/hash/retry cases;
  no arbitrary verify_cmd, no invented source truth or substantive refutation.
- [ ] Broader claim/derivation graph and optional verifier/provider implementations.

## #405 action boundary

- [x] Notify and exact prepare without effect; trusted separate all-domain Ed25519
  proof, complete before/after/binding preview, expiry/deny/revoke/drift/replay gates.
- [x] One working reversible local-artifact-v1 adapter, intent/spending before effect,
  lock-scoped final checks, immutable receipts, exact-hash recovery/unknown and CAS rollback.
- [x] Owner target register/update/remove with protected control/key/vault/Git/auto-
  execution paths denied, package.json warning, safe stopped default and recovery.
- [ ] Provider messaging/email/Slack/GitHub/cloud/shell adapters and actual production
  OS-owned key isolation; no synthetic assertion establishes this boundary.

## #450 required approvers

- [x] All affected authenticated task/target/source domains, never implicit quorum.
- [x] Partial actor preview protection, wrong-domain/binding/nonce/signature denial,
  revoked/expired/missing domain and two-domain execute tests.
- [ ] Broader federation/shared-policy deliverables outside this local subset.

## #409 local coordination

- [x] Stable mapped actor identity, occurrence/action idempotency, live holder token,
  local strict process lock/fence, expiry/recovery/unknown and no old authority revival.
- [x] Multiple real processes cannot duplicate logical firing or signed effect;
  archived/readable spent proof survives repair; new recovery epoch also blocks old authority when recent unarchived IDs are unavailable.
- [ ] Federated leases, partitions, merge/echo-aware epistemic coordination.

## #656 visibility

- [x] Existing doctor feature row plus task_status projection/CLI/UI expose on/off,
  actual client/adapter coverage, next check/delivery/error/backpressure, budgets,
  stop/mute and recovery; no second feature ladder.
- [x] Explicit authored tasks stay deterministic opt-in; no learned auto-arming/default.
- [ ] Broader feature-ladder promotion/demotion policy outside this workstream.

## #402 / #598 / #410 evidence

- [x] #402: synthetic registration/profile/revisions/cases, false/missed/duplicate/
  acknowledgement/safety/cost definitions and aggregate functional report.
- [x] #598: readable cards, why/source state, Owner options/decline, private signing
  preview and real CLI/DOM/disposable-demo fixtures available for the existing study.
- [x] #410: local 14-case matrix, corruption/archive/permission/crash/fencing/recovery,
  actual reversible adapter and prior independent review corrections integrated.
- [ ] Human comprehension, false acceptance/rejection, interruption cost, longitudinal
  rates/net utility/causal benefit and stable V2 promotion criteria remain pending.
