# Proactive tasks: implementation design

Status: proposed contract for P0 review; no runtime is shipped by this document.
Owners: #403 storage/delivery, #404 evaluation, #475 freshness, #405 actions,
#450 approvals, #409 local coordination; integration #250, visibility #656.
The [build contract](../Proactive%20Tasks%20Build%20Plan.md) governs conflicts.

## One object, one service

Implement in the daemon, using its existing validation, redaction, authentication,
session assembler, background-job host and file transaction infrastructure.
All transports call the same task service. Tasks are independent of memory schema,
drafts, semantic rank and the consumable pending-suggestions relay.

The version-1 store is `<data-dir>/proactive-tasks.json` (explicit
`BASTRA_TASKS_PATH` override for isolated tests). Never derive it from a memory
file or use draft purge for its retention. Envelope:

```ts
type TaskStore = {
  schema_version: 1; revision: number;
  tasks: Task[]; events: Event[]; checkpoint: number;
  occurrences: Occurrence[]; proposals: Proposal[];
  approvals: Approval[]; intents: Intent[]; receipts: ActionReceipt[];
  controls: { muted: boolean; execution_stopped: boolean };
};
```

These are records in the owning task store, not parallel queues or proposal
engines. Use the existing reviewed-proposal machinery where it can represent
an exact action; persist its ID/binding here, never duplicate its authority.
The journal and checkpoint commit in the same snapshot as resulting occurrences.
Delivery receipts belong to occurrences and do not consume them on read.

`Task` includes `id`, `revision`, `created_at`, `updated_at`, original request,
request source/reference, authenticated creator/actor and owner domains,
personal/project/team scope, sensitivity, goal, resolution condition,
`state: pending|due|snoozed|resolved|cancelled|expired`, separate `armed` flag
and `review_reason`, schedule/predicate, timezone, reference instant, recurrence,
catch-up, action level (default notify), notification policy, evidence bindings,
optional decision/assumption binding, next check, last failure and audit history.
References contain stable ID, content revision/hash and source identity; unknown
provenance is explicit. History records actor, operation, before/after revisions,
time and reason; original requests are sanitized local data, never telemetry.

Read a missing store as first-run only on ENOENT. Malformed JSON, failed schema
validation, duplicate IDs, unsupported schema versions and I/O failures surface
typed errors and block mutations; never replace them with empty state. Keep the
original byte-for-byte. Explicit recovery validates a selected backup into a
new snapshot, keeps the damaged original and audits recovery. Migration is a
version dispatch with a fixture for the empty pre-feature state and a v1
round-trip; future-version input is refused. No memory migration.

Directories/files use 0700/0600. Enforce bounded serialized size and record counts;
reaching a limit reports backpressure, not deletion of unresolved work. History
and terminal data are retained locally until explicit owner archival; no automatic
expiry of a pending receipt. Secret redaction and injected-block scrubbing precede
persisting request/evidence text. Exact action bytes remain in private proposal
storage and do not enter memories, context cards or public telemetry unredacted.

## Canonical API and authority

| Operation | MCP | HTTP under `/api/v1/tasks` | CLI `bastra tasks` |
|---|---|---|---|
| Create proposal | `task_create` | POST `/` | `create` |
| Review/arm | `task_review` | POST `/:id/review` | `review` |
| List/get | `task_list`, `task_get` | GET `/`, GET `/:id` | `list`, `get` |
| Edit | `task_edit` | PATCH `/:id` | `edit` |
| Snooze | `task_snooze` | POST `/:id/snooze` | `snooze` |
| Acknowledge occurrence | `task_acknowledge` | POST `/:id/acknowledge` | `acknowledge` |
| Resolve/cancel/re-arm | `task_resolve`, `task_cancel`, `task_rearm` | POST `/:id/{resolve,cancel,rearm}` | `resolve`, `cancel`, `rearm` |
| Observe owner/tool event | `task_event` | POST `/events` | `event` |
| Delivery projection | `task_due` | GET `/due` | `due` |
| Prepare/execution request | `task_prepare`, `task_execute` | POST `/:id/{prepare,execute}` | `prepare`, `execute` |
| Status/controls | `task_status`, `task_control` | GET `/status`, POST `/controls` | `status`, `mute`, `stop`, `resume` |

Route literals precede `/:id`. UI `/ui/tasks` uses this service, with authenticated
browser requests; it has no independent storage or implicit approval endpoint.
Each mutation takes `expected_revision` (create takes an idempotency key). Replies
carry object revision and structured error `code`, `message`, `retryable`.
Conflicts return 409; unauthenticated 401, wrong owner 403, absent 404, invalid
422, unavailable lock/source or capacity 503. Transport parity tests compare
normalized results, including denial and conflict paths.

Bind actor/domain to server-side configured credentials, never to a JSON
`actor`, `owner`, `source=user` or `approved=true`. Reuse bearer validation but
require a bearer for task API even where existing APIs allow loopback skip.
MCP and CLI obtain their configured transport identity; missing identities may
inspect only authorized projections and cannot mutate or attribute owner events.
Read/list enforce ownership/sensitivity too. Per-actor credentials are mapped
to domains; a shared transport token alone does not prove a human or another owner.

Agent capture creates an unarmed pending proposal. Ambiguous time, source or
authority leaves it unarmed with a readable question. Only a trusted owner
confirmation can arm/re-arm or attest human acknowledgement/resolution. No
memory hit, repeated quote or draft confirmation supplies this proof. Owner
review signs the exact task revision, schedule and requested operation using
the review channel below; agent transports may submit that proof but cannot
produce it. Reads and rendering only record attempted delivery. Automatic
resolution is allowed only by an explicitly registered bounded evidence verifier.

Snooze preserves occurrence IDs/receipts, defers presentation until its stored
instant and returns to due; it does not create another firing. Resolve/cancel
invalidate outstanding bindings. Edit increments revision, disarms and requires
review of changed predicates/authority; old occurrence history remains readable.
Re-arm is explicit, starts a new generation and never resurrects an old capability.
Recurrence alone advances under its reviewed bounded schedule; terminal states
do not advance. Acknowledgement leaves an unfinished task open/due.

## Time, sources and occurrences

Duration schedules store `reference_at + duration_ms` as an instant; calendar
schedules store local date/time, IANA timezone and resolved instant. Invalid zones
or ambiguous policies cannot arm. DST gap policy is reject or shift forward by
the gap; overlap is earlier or later offset. Show the resolved timestamp/offset
in review. Calendar recurrence retains wall time; elapsed recurrence retains
duration. Use the same deterministic timezone resolver on every transport.

Every recurrence has finite count and/or end instant and explicit catch-up:
`latest` coalesces missed intervals into one occurrence with a missed count;
`all` journals each missed slot within the configured budget, retaining backlog.
An explicit `skip` policy records skipped slots in history. Never silently drop
because of budget. Slot IDs derive from task ID, generation and scheduled slot,
not evaluation time. Clock rollback never lowers checkpoint or next slot.

`Event` has journal sequence, source ID/version, actor/domain, observed_at,
state_updated_at where attributable, sensitivity, dedup key and bounded payload.
Sources: clock; authenticated configured owner/tool event; registered local
artifact content hash/version; registered repository Git ref. Read files/refs
under registered path roots, reject symlinks/escape; Git uses an allowlisted
argument vector, never saved shell text. Declare observations as polling/next
contact snapshots; unobserved intermediate file changes are not claimed.

Predicates are a small validated tagged union: time-due, named event with exact
value, content-version change, Git-ref change, or registered substantive premise
verifier. No arbitrary expression, network URL, shell or stored `verify_cmd`.
Source/version arrival can request review, not attest substantive refutation.

Verification returns `verified|refuted|stale|unavailable|inconclusive` plus source,
revision, observed_at, producer state_updated_at when meaningful, max_age,
timeout and reason/evidence. Lack of a trustworthy producer timestamp for a
live-state claim is inconclusive. Missing/future/contested data never becomes
false or a confirmed change. Refuted means the registered substantive predicate
was contradicted by attributable fresh evidence, not merely that bytes changed.

Evaluation is outside the hook hot path. Extend the existing background-job
host and invoke bounded reconciliation at startup/contact. Hooks consume cached
due projections and arrange off-path evaluation. Next-contact-only is the initial
declared coverage; optional wakeup capability is explicitly opt-in and shown
unsupported until its adapter is actually tested. No new scheduler/service file.
Default limits: 100 evaluations/tick, 10/source, 1 MiB/source, 1 s/source, 5 s/tick;
poll no faster than 60 s, failures back off to 1 h. Per-task limits and end/stop
conditions are shown before arming. Overflow remains checkpointed backlog.

Occurrence identity binds task/generation, decision/assumption revision where
present and material-event key. A transaction persists event, due transition,
checkpoint and occurrence before presentation. Several clients retry the same
ID. A receipt stores attempted delivery, supported human acknowledgement and
resolution separately. Response overflow, disconnect, relay disabled/consumed
or purge only delays presentation. Retry interval/count budgets and last failure
are visible; exhaustion requires review and never resolves a task.

C-096 cards show original option/rationale, load-bearing premise, old/new evidence
versions/timestamps, affected alternatives and uncertainty. Keep consumes that
material event without repeating it; change creates a reviewed new version through
existing proposal/version machinery, never mutates the decision automatically.
Snooze/stop persist. Supersession disarms the old watch; explicit review is required
to bind a new decision version.

## Trusted interactive review and actions

The approval boundary must withstand a model with every ordinary MCP/HTTP/CLI
credential, ability to set source/actor fields, read review responses and automate
the browser. A localhost address, CSRF nonce, terminal prompt, click, bearer token
or client-supplied human flag is insufficient. They prove transport, not a human.

Use an owner-controlled signing key distinct from transport credentials. The
reference channel is an interactive owner CLI which shows the daemon-fetched
exact task/proposal and then unlocks an encrypted signing key with an owner-held
passphrase read from `/dev/tty` (never args, env, stdin or an agent API). No
unattended approval fallback. The configured owner public-key fingerprint/domain
is pinned at daemon startup; key enrollment is explicit owner bootstrap outside
agent tools, and changing it invalidates approvals/requires restart. An agent
cannot enroll a new approver through the runtime. UI provides the readable review
and command/QR handoff; MCP/HTTP/CLI can present and submit signed receipts but
cannot mint them. Unsupported clients stay notify/prepare-only until owner review.

Signature covers a domain-separated canonical binding: task/proposal ID and
revision, operation, actor, owner/domain set, exact target/action/payload SHA-256,
evidence/source/decision revisions, scope/sensitivity, challenge nonce, expiry.
Server issues a single-use challenge only after presenting the complete review;
verify signature against pinned key, bindings, expiry and revocation again at
execute, including after restart. No signing of caller-supplied opaque hashes:
the owner client fetches bytes, computes/verifies the binding and displays them.
Sanitize terminal controls without changing signed bytes; ambiguous/redacted
mutation previews block approval rather than hide the proposed effect.

Threat boundary: owner key/passphrase and daemon configuration must be outside
the agent's authority. A compromised OS account/root, keylogger, owner sharing
the passphrase, or agent replacing daemon code/config cannot be repaired by an
HTTP protocol. Do not claim protection against these. In same-user development
with unrestricted filesystem tools, no secure owner separation is established:
execute remains disabled unless the owner establishes a protected configuration
and key boundary. Tests use synthetic keys and do not claim a real human press.
P7 independent review must confirm enrollment, key isolation and this limitation
before P8 begins; if isolation cannot be established, report that required gap
and keep execute unavailable instead of accepting a model's self-approval.

prepare creates only a private draft/diff and exact binding, never touches target.
Every affected authenticated owner domain signs; unresolved owners, missing
signatures, denied/expired/revoked/stale bindings block the whole operation.
No quorum or partial cross-domain action. Editing owners or proposal invalidates
old receipts. Execute requires the proposal's actor and a current fenced lease;
an agent cannot spend another actor's signed approval.

Reuse the cross-process path lock with `requireLock`, extending it for owner-token
checks and dead-owner recovery rather than introducing a second coordinator.
Existing age-only takeover is insufficient for these writes: fail closed while
the same-host PID is alive; check token/expiry immediately before commit. No await
between the final ownership check and local guarded rename. Remote/shared stores
are unsupported. Expired action leases cannot commit intent, receipt or target.

Reference adapter: exact UTF-8 replace of an explicitly registered local artifact
under an isolated allowlisted root, content hash/revision CAS, no symlink/path
escape, temp+rename, private backup and rollback bound to the resulting revision.
Hold local coordination across final source/target verification and write.
Persist intent/idempotency before adapter call. Before-call crash resumes only
after lease/binding recheck. Success-without-receipt reconciles target to exact
approved bytes; divergence becomes unknown/review, never blind overwrite/retry.
Rollback is a separately reviewed exact action, not a bypass of newer edits.
Email, provider chat, GitHub writes and other external connectors are unsupported.

## Controls, review evidence and PR boundaries

UI/CLI show open/due/snoozed/done, unarmed review reasons, next check, original
request/why now/evidence age, last delivery/error/backpressure and actual adapter
coverage. Mute preserves outbox; global stop denies execution and preserves
read/review/notify. Resume never renews approval. Project status projects into
#656's existing inventory when available; no second feature ladder.

P1 storage/migration; P2 canonical CRUD; P3 journal/time/source adapters; P4
freshness; P5 delivery; P6 reconsideration; P7 preparation/approval/leases; P8
reference execution only after P7 review; P9 UI/status; P10 integration/docs.
Later PRs stack on the previous branch. Existing CI targets only main: before
creating stacked code PRs extend its PR trigger in a separate small reviewed
infrastructure PR, preserving main pushes and every existing check.

Map tests to all 14 rows of the build-contract matrix, plus auth/transport parity,
schema round-trip/corruption/recovery, cross-process contention, expired lease,
enrollment/self-approval/drift/revocation and adapter rollback. Run build, typecheck
and full suites in isolated data dirs, own free ports; no real vault/6723/services.
Repository currently has no lint script: use existing checks and report this
explicitly; do not claim a lint run. Register #402/#598/#410 observation metadata
and reproducible synthetic runs separately from pending longitudinal evidence.
The final demo covers real notify, prepare and signed execute in a disposable
root; synthetic approvals demonstrate mechanics, not human approval provenance.
