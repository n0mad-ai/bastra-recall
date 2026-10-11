# Proactive tasks and reminders implementation contract

Owner request: 2026-10-11. Contract addition C-097. Build the existing priority
workstream #250/#403/#404/#405 now, including C-096 decision-assumption resurfacing.
This is a build plan, not shipped functionality. #402/#598/#410 confirmation runs stay
parallel in milestone #30. C-095 release rules remain; completing or measuring all of
V2 is not a prerequisite for this implementation.

## Release and issue ownership

The 1.1.0 release cut has its own owner/session. This work does not merge, tag or
publish that release, change its notes or bump its version. Its checked handover
covers drafts/review/relay, notices, service startup and other release work; the
prospective runtime was not found in the inspected core/daemon sources.

[v1.1.1 follow-ups](https://github.com/n0mad-ai/bastra-recall/milestone/32) initially
owns #1151, whose fix PR #1152 was explicitly excluded from 1.1.0. Do not duplicate
that issue or assume the old PR base is release-ready. The brainstorming did not
establish another new 1.1.0 runtime defect. New independently verified patch findings
can join this milestone; V2 product expansion is not indiscriminately reassigned to it.

| Existing owner | Build responsibility |
|---|---|
| #250 | Integrated workstream checklist and end-to-end product cases |
| #403 | Commitment object, lifecycle, CRUD, review and acknowledged delivery |
| #404 | Time/predicate events, durable journal, firing, recovery and opted-in wakeup adapters |
| #405 | Notify/prepare/execute, trusted approvals, capabilities and action receipts |
| #475 | Freshness/verifier outcomes consumed by predicate and pre-execution checks |
| #450 | Required approver domains and conservative multi-owner default |
| #409 | Reuse lease/actor/dedup contracts; first local coordination here, federation later |
| #402 | Trigger/delivery observation registration and reports |
| #598/#410 | Review usability and combined end-to-end confirmation |
| #656 | Feature/mode visibility; explicit user reminders are not silently learned policies |

No second scheduler, graph, proposal store, outcome spine or notification queue is
created alongside the owning component. Extend existing reusable infrastructure.

## Brainstorming incorporated in this build

1. Revisit a decision when a **load-bearing assumption** demonstrably changes.
2. Follow up on a measurement without saying elapsed time proves the gate passed.
3. Notify only on the registered actionable/material change; batch or quiet unchanged
   observations. Delivery, acknowledgement and resolution remain different events.
4. Make tasks usable without coding: plain request plus a readable confirmation,
   visible pending/due/snoozed/resolved state and accessible correction/cancellation.
5. Use the same data/API across supported clients; a client without background wakeup
   still receives due work at next contact and clearly declares that limitation.
6. Preserve evidence/revisions, verify freshness and invalidate stale approval.
7. Repeated delivery or multiple agents do not duplicate logical firing or side effects.

Voice, Dots integration, personal wiki, OCR/document-management UI, company radar,
customer simulation, learned workflows and other paid experiences remain separate
workstreams. This build gives them a reusable task/event/action foundation; it does
not claim to implement them. Native provider memory and undocumented hooks are not
assumed to supply these guarantees.

## 1 Commitment data and capture under #403

A persisted, versioned commitment is a task object, not a memory expiry field or a
promoted draft. Include ID/revision, original request/source, authenticated creator
and owner, personal/project scope, sensitivity, goal, resolution condition, due
predicate/window, timezone, recurrence/catch-up policy, action level, notification
policy, source/evidence references and content revisions/hashes. Assumption watches
also bind the decision and the explicitly identified load-bearing claim/premise.

Expose one canonical contract through MCP, authenticated HTTP, CLI and the daemon
UI: create/review, list/get, edit with expected revision, snooze, acknowledge, resolve,
cancel and explicit re-arm. Establish names from the existing command/tool convention
and document them before code; do not publish competing schemas per transport.

Explicit owner requests may create commitments; generated suggestions remain proposals
until accepted. An ambiguous time/source/authority is clarified once or stays visibly
unarmed. A model's claimed source=user, harvested quote, repeated request, draft review
confirm, copied text or recall hit cannot alone create an armed task or permission.
No hidden background checks are introduced by saving a decision.

Lifecycle includes pending/due/snoozed/resolved/cancelled/expired. Attempted delivery,
acknowledgement and execution have separate records. Acknowledging does not resolve;
resolving uses an explicit owner action or the declared validated evidence condition.
State edits invalidate older relevant triggers/proposals/capabilities. Preserve history
and prevent silent re-arm, rebinding or resurrection after cancel/supersession.

Use existing memory IDs/content versions and validated evidence snapshots. Persistent
commitment storage needs its own backward-compatible schema/migration decision within
#403; it must not quietly mutate the memory schema. Do not require completion of the
entire #394/#395 claim/graph feature to notify from an explicit versioned watch.
Adapters must retain references usable by those later representations. Unresolvable,
changed or contested evidence is unknown/stale, never a fabricated confirmed claim.

## 2 Time, events and freshness under #404/#475

Persist before evaluating. Use bounded deterministic predicates and a durable event
journal with source/version, timestamps, deduplication key and checkpoint. Reconcile
at startup, next contact and an opted-in background schedule; never rely on an
in-memory seven-day timer. At least time, explicit authenticated owner/tool events,
local file/content-version and Git-ref changes form functional source adapters.
Declare every adapter's observation coverage and unavailable outcome.

Relative-duration and local-calendar schedules are distinct. Resolve against a
recorded reference instant/timezone. Define and show DST gap/overlap policy before
arming, recurrence count/end and catch-up behavior. Freeze clocks in fixtures; cover
clock rollback, missed intervals, sleep, prolonged offline, restart and process races.

Source checks return verified/refuted/stale/unavailable/inconclusive with source
identity/revision, observed_at, state_updated_at where meaningful, max_age and timeout.
Missing data, a changed document or a new release alone cannot attest a substantive
premise change. A failed source is never “condition not met”. Do not execute stored
verify_cmd strings: they remain display-only unless separately registered as bounded,
authorized verifier operations. No arbitrary shell predicate or LLM attestation.

Evaluate pending checks off the hook hot path. Budget observations, polling, retries
and notifications per task/source and globally, with visible backpressure. A source
failure/degraded transition may merit one notice; unchanged/non-actionable checks stay
quiet. Polling frequency, error backoff and termination are explicit before arming.

## 3 Delivery and control under #403

Due work is independent of semantic ranking, loaded memory count and draft promotion.
Integrate with the shared session assembler, next suitable ongoing-session hook and
hookless MCP/HTTP entry points. The current pending-suggestions relay is bounded,
expires and consumes on read: it may carry a projection, never own the durable task.
BASTRA_PENDING_RELAY=0 or drafts purge must not delete or resolve commitments.

Use a task-owned outbox/occurrence receipt contract within #403. Rendering a response
or writing a relay file is an attempted delivery; only a supported acknowledged
receipt records acknowledgement. A caller-declared user saw it or localhost address
cannot attest human observation. Unacknowledged/overflow/disconnected deliveries stay
pending and retry with bounds; stable occurrence IDs make the retry recognizable.

Never ask the user to approve an abstract action without context. A due card displays
why now, due/source age, original request, relevant evidence, action level and controls.
Decision reconsideration additionally displays original option/reason, old/new premise
and evidence, affected alternatives and uncertainty; offer keep/change/snooze/stop.
An accepted decision change is a confirmed new version, not an automatic reversal.
Keeping does not repeatedly fire the same material event; snooze/cancel persist.

Provide a minimal usable daemon UI and CLI, not only a developer tool. Include status,
next check, last delivery/failure, quiet/mute settings, global stop and recovery.
Mute defers delivery without resolving; stopping execution leaves read/review and
notification-only recovery available. Local OS notification/background agent wakeup
is an explicit adapter/capability. If unavailable, report next-contact-only honestly;
never claim a notification while the client/computer is offline or unsupported.

## 4 Preparation, approval and execution under #405/#450

notify is the default context/local-delivery level. Sending an email/chat message or
mutating a connected app is already an external side effect, even when called a
notification, and needs the corresponding capability. prepare creates a draft/diff
and must not send, publish or change the external target.

Approval binds authenticated owner/domain, actor, resource, exact action/payload hash,
source/evidence revisions, scope, sensitivity, expiry and revocation. The proposal
producer cannot attest the approving human. Document the trusted interactive review
channel and its transport threat model before execute is enabled; a tool or agent
cannot gain authority by emitting approved=true or a source=user field. Unsupported
clients may propose/notify but cannot manufacture an approval receipt.

Check those bindings and freshness again immediately before execution. Target, source,
payload, ownership or decision-version drift yields stale and a new review; expired,
revoked and denied are distinct. The notification/proposal has to be presented for
review before any external effect. A broad earlier yes or an old receipt is insufficient.

Persist intent and idempotency before the call, then store the action receipt/outcome.
Test crash windows before the call, after remote success but before the local receipt,
and during recovery. Where a provider supports idempotency or reconciliation, reuse it.
Where it does not, an uncertain result is unknown/requires review; never blindly retry
or promise universal exactly-once external execution. Logical firing is exactly once;
physical delivery can retry. Partial completion is never reported as completed.

All affected authenticated owner domains must approve by default. No implicit quorum,
no partial execution under just one domain's approval. This settles #450's default
for this build; a future alternative quorum needs an explicit separate specification.
Single-owner execution is usable now. Unresolved owner identity blocks execution;
federation itself stays #408/#409. Local concurrent agents use leases/fencing/revision
checks so an expired lease cannot write or spend another actor's capability.

Ship an allowlisted connector interface and at least one actual reversible reference
adapter: an exact approved update to a registered local artifact, with path containment,
content revision checks and rollback. Test it end to end in an isolated temporary root.
Arbitrary shell execution is not the reference adapter. Describe which real adapters
are supported/unsupported; provider-specific email/GitHub/etc. adapters share this
contract when implemented and cannot inherit ungranted capabilities. Approval and
deduplication must work before any such adapter is enabled.

## 5 Storage, visibility and tests

Reuse cross-process locks, atomic writes, auth/private-access checks, budgets,
redaction and versioned event patterns. Private paths, credentials and capability
material do not enter memory bodies or public reports. Original requests/evidence
have documented local retention and sensitivity. Corruption must be surfaced with
recoverable originals; it cannot be silently replaced with an empty task store.

Register explicit feature controls/status in #656's inventory when present; otherwise
provide a compatible status projection, not a second ladder. Owner-authored reminders
are opt-in deterministic work, not a learned policy requiring a statistical lift to
be useful. Learned routing/auto-arming remains proposal/review-controlled. Measurements
may run alongside safe functional development; safety/data-integrity checks cannot.

| End-to-end case | Required outcome |
|---|---|
| Evaluate a run after seven days | A persisted due task asks to evaluate; elapsed time is not gate passed |
| Deadline within a running session | Next suitable delivery, independent of recall ranking |
| Client absent/offline/restart | No lost due item; honest next-contact/background mode |
| Output overflow or relay disabled/purged | Durable task remains pending; no fabricated acknowledgement |
| Same occurrence in several clients | One logical firing; stable retry IDs; no duplicated resolution/effect |
| Acknowledged but unfinished | Remains due/open until explicitly/evidentially resolved |
| DST, recurrence and clock rollback | Declared deterministic policy, no duplicate occurrence |
| Assumption really changes | One evidenced reconsideration; old decision remains until confirmed change |
| Irrelevant, stale, failed or contested source | No fabricated premise change; explicit unknown/stale/failure |
| Decision edited/cancelled/superseded | Old watch/approval cannot silently bind to the new revision |
| prepare, old approval, forged user claim | No external write; fresh trusted exact approval required |
| Crash after external success, receipt absent | Reconcile or unknown/review; no unsafe automatic retry |
| Multi-owner or expired lease | All required approvals and current owner fencing, otherwise no execute |
| Kill switch or adapter disabled | Safe stopped state; task/evidence/history preserved |

## Build sequence and return to Claude's caller

1. Lock schema/API/actor/approval and recurrence decisions in a short reviewed design;
   read-only projections may be used to validate UX, but no unacknowledged proposal is
   left as the product's only implementation. Implement #403 with migration tests.
2. Implement #404 plus the needed #475 source checks and connect #403 delivery across
   supported clients. Complete notify and decision-reconsideration scenarios.
3. Implement #405 and #450's conservative approval default, reference adapter and local
   lease subset. No external execute before independent review of this boundary.
4. Run the matrix, transport parity, migration/recovery and permission fixtures. Register
   #402 runs alongside; attach private reproducible artifacts and public aggregates.
5. Independently review integration and the corrected revision, not only each module.
   Report supported adapters/client modes, unimplemented published deliverables and
   unresolved evidence. An extension interface alone is not a working adapter.

Use an isolated checkout and invented data. No real vault, live daemon port, service
files, provider messages, production writes or release workflow. Own PRs with checked
CI; no merge/tag/release without the owner session. Follow repository rules for model
and reviewer selection. A missing required component is part of this build, not a
reason to claim completion or defer it invisibly.

Return PR URLs/heads, issue checklist per owner, tests actually run, review findings
and their resolution, client/adapter coverage and #402 registration links. Notify,
prepare and execute must each have end-to-end evidence; longitudinal benefit can
remain pending. The work is build-ready here, not already built or dispatched.
