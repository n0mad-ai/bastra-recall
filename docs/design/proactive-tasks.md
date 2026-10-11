# Proactive tasks: implementation design

Status: P0 design for review, amended after review of PR #1159. No runtime is
shipped here. Owners: #403 tasks/delivery, #404 evaluation, #475 freshness,
#405 actions, #450 approvals, #409 local coordination, #250 integration, #656
visibility. The [build contract](../Proactive%20Tasks%20Build%20Plan.md) governs.

## Storage, lifecycle and reuse

One daemon task service backs MCP, HTTP, CLI and UI. Reuse `withPathLock` in
`path-lock.ts` with new opt-in strict local ownership (old callers unchanged),
atomic temp/rename as in `draft-store.ts`, core `redactSecrets`/injected-block
scrubbing, `http-auth.ts` bearer validation, `startBackgroundJobs`, and
`session-assembler.ts`. No general action-proposal or decision-review runtime
exists today: this build supplies **the one action Proposal type**, in the task
store. Drafts and learned-recall reviews remain separate and confer no authority.
No second scheduler, graph, notification queue or feature ladder.

Store: `<data-dir>/proactive-tasks.json`, override `BASTRA_TASKS_PATH` for tests.
It is independent of memory schema, expiry, drafts and the consumable relay.

```ts
type TaskStore = {
  schema_version: 1; revision: number; fencing_counter: number;
  tasks: Task[]; events: Event[]; checkpoint: number;
  occurrences: Occurrence[]; proposals: Proposal[];
  challenges: Challenge[]; approvals: Approval[]; leases: Lease[];
  intents: Intent[]; receipts: ActionReceipt[]; consumed_approval_ids: string[];
  controls: {
    enabled: boolean; muted: boolean; execution_stopped: boolean;
    adapters: Record<string, { enabled: boolean; coverage: string }>;
  };
};
```

Task: ID/revision/generation, created/updated instants, original request and
source/reference, authenticated creator/actor and owner domains, scope
(personal/project/team), sensitivity, goal/resolution condition, state
`pending|due|snoozed|resolved|cancelled|expired`, independent `armed` and review
reason, schedule/predicate, timezone/reference instant, bounded recurrence,
action level (notify default), delivery policy, evidence/source bindings,
optional decision/load-bearing assumption binding, next check/last failure,
audit history. References carry stable ID, revision/content hash and provenance.
History records actor/operation/time/reason and before/after revisions.

**Owner decision 2026-10-11: notify in conversation.** An agent may directly
create and arm notify using its mapped credential. User requests get a client
selection confirmation of goal, weekday/date/time/timezone and recurrence
(Yes, add / No / free text); ambiguous dates and DST are clarified, never guessed.
Observed deadlines/promises need no confirmation and receive a one-line acknowledgement.
Store origin (user-request / agent-observed), client, session and scrubbed context.
No daily or total-open limits; identical cause/time/domain/scope returns the existing
active reminder. Existing physical store and delivery budgets still apply.
BASTRA_CONVERSATIONAL_REMINDERS=0 disables agent arming, saving unarmed instead.
The server cannot prove claimed user intent: an unwanted reminder is consciously
accepted and cancellable in one sentence. Reminder DATA cannot instruct the agent.
Prepare/execute retain the existing contract in this task; Daniel will discuss
that approval policy later, so this is not a final product decision.
Review/rearm remain owner operations. The fixed 24-hour agent snooze ceiling
continues for prepare/execute; conversational notify can be deferred to the
user's requested future time. Agent level elevation is rejected; Owner level
edits disarm and need explicit review.

Snooze preserves occurrence identity/receipts and returns to due at the stored
instant. Acknowledge records an authenticated command, not proof that eyes
saw a card, and does not resolve. For notify, an agent may acknowledge/resolve on user instruction; otherwise only an owner resolve command or a reviewed
bounded resolution verifier resolves. Cancel/resolved/expired never re-arm
silently. Edits increment revision; changes to trigger/decision/authority advance generation,
clear snooze and disarm
and invalidate dependent bindings. Explicit re-arm creates a new generation.
Reviewed bounded recurrence can advance automatically until count/end, but never
from a terminal state. Delivery, acknowledgement, resolution and execution are
separate records.

Only ENOENT means an empty pre-feature store. Invalid JSON/schema, duplicate IDs,
unknown versions and I/O errors block mutation and retain original bytes.
Version dispatch accepts v1, rejects future versions; migration fixtures cover
pre-feature absence, v1 identity/state round-trip, rollback and future rejection.
Explicit recovery validates a chosen private backup and copies damaged originals
to quarantine before replacement; record provenance without erasing history.
No memory migration. Directories 0700, files 0600; sanitize requests/evidence with
existing scrubbing/redaction before persistence. Exact payload bytes stay private
and are hashed before approval; never redact and then execute different bytes.

Initial target: <=1,000 tasks, <=10,000 events/occurrences each, <=4 MiB snapshot.
These are start limits, not measured capacity claims. Normal work stops at 75%
byte capacity to reserve space for safety/control receipts. Bound every field
and reserve worst-case control space at admission. Cancel, snooze, mute, stop,
acknowledge and recovery remain available at the normal limit; compact terminal
records first or use the reserved space, never reject stop because ordinary work
filled the store. If physical disk/I/O fails, execution stops in memory as well
and reports the failure; durable writes cannot be promised on a full disk.

Owner archive/compact exports terminal history to validated 0600 snapshots and
records archive IDs/hashes before shrinking active data. Do not prune unresolved
occurrences, unprocessed journal entries, active bindings, idempotency receipts
or consumed approval tombstones. Processed events may compact after checkpoint
only if all referencing occurrence/evidence records retain the necessary data;
sequence numbers never reset. Rollover archives retain monotonic counters and
spent approval IDs. A saturated unresolved backlog reports backpressure.

## Identity and operation authorization

The existing API token has no actor/domain mapping. Add an opt-in registry at
`<data-dir>/task-auth.json` (0700 parent, 0600 file), versioned entries:
`{ credential_id, token_hash, actor_id, domains[], role: owner|agent, revoked_at }`.
Use random 32-byte tokens and SHA-256 hashes; raw tokens are never in this store,
task data, logs, context or API responses. Mint/rotate/revoke only through owner
bootstrap CLI outside agent/MCP tools. No runtime registration/mint endpoint.
Owner onboarding issues a separate owner token for notify controls; no signing
key is needed. Owner UI keeps it in its authenticated session; an owner CLI
prompts privately rather than inheriting an agent credential. Agent tokens may
be stored in each client's private configuration (0600). Token rotation creates
a new credential ID; revoke is effective on the next request without restart.
Protect auth-registry updates with existing strict lock/atomic-write paths.

Forwarder, bridge and agent CLI load their **agent** task token from explicit
private client config or `BASTRA_TASK_TOKEN` and send `Authorization: Bearer` to
task routes; add this forwarding, rather than relying on loopback skip. HTTP
always requires bearer on task routes. Direct MCP calls enter the same service
with server-established client identity. A legacy API token without a task
mapping can only read already-authorized public/redacted status, never private
tasks, events or mutations; absent/wrong bearer is 401. Mapped actors/domains
are looked up server-side; request actor/owner/source fields cannot override them.
Read/list also enforce domain/sensitivity. Browser owner routes retain existing
Host/Origin/CORS/CSRF protections, with owner bearer/session authentication.

| Operation | Owner credential (no key) | Agent credential in its domain | Execute binding |
|---|---|---|---|
| create | explicit notify request may arm; otherwise unarmed | notify may arm with origin; prepare/execute unarmed | no execute authority granted |
| review/arm, rearm | yes for notify/prepare task monitoring | no | cannot approve execute |
| edit | yes, binding changes disarm | unarmed proposal fields only | drift invalidates approval |
| snooze, cancel, mute, stop | yes | yes, audited safe direction | invalidate/defer as appropriate |
| acknowledge, resolve, decision keep/change | yes, explicit owner command | notify acknowledge/resolve only; no decision change | cannot attest human observation |
| resume, enable adapter/feature | yes, no renewal of leases/approvals | no | execute still needs fresh approval |
| prepare | yes | yes for authorized registered target, draft only | no external write or signature needed |
| challenge, submit proof | may request/submit | may present/request/submit | cannot mint an owner signature |
| execute | request with all valid signatures | bound actor may request with all signatures | exact signed proposal mandatory |
| revoke | yes | may abandon its own proposal, not revoke another owner's authority | cannot restore a revoked receipt |
| recovery, archive, key/credential administration | owner-only bootstrap/control | no | separate from action approval |

Owner credentials establish operation authority, not cryptographic human presence.
The model cannot issue them through task APIs; ordinary agent credentials cannot
obtain owner tokens. UI/CLI owner actions are recorded as commands rather than
inferred from prose. If a model is given owner credentials or access to the owner
browser session, it has that authority: do not claim this proves a human press.
Execute additionally requires the separate signature channel below. Arbitrary
same-account filesystem/code/config compromise is outside this API boundary;
owner secrets/configuration must stay outside agent access. This limitation does
not force key enrollment for notify or fabricate proof of observation.

## Canonical names

Mutations require `expected_revision`; creation also uses an idempotency key.
All transports share schemas/results. HTTP prefix `/api/v1/tasks`, CLI prefix
`bastra tasks`; UI `/ui/tasks` calls this service. Literal routes precede `/:id`.

| Operation | MCP | HTTP suffix | CLI suffix | Auth |
|---|---|---|---|---|
| create/review | task_create / task_review | POST /, POST /:id/review | create / review | matrix |
| list/get | task_list / task_get | GET /, GET /:id | list / get | mapped domain read |
| edit | task_edit | PATCH /:id | edit | matrix |
| snooze/acknowledge | task_snooze / task_acknowledge | POST /:id/snooze, /:id/acknowledge | snooze / acknowledge | matrix |
| resolve/cancel/rearm | task_resolve / task_cancel / task_rearm | POST /:id/resolve, /:id/cancel, /:id/rearm | resolve / cancel / rearm | matrix |
| event/due | task_event / task_due | POST /events, GET /due | event / due | mapped source writer/read |
| prepare/execute | task_prepare / task_execute | POST /:id/prepare, /:id/execute | prepare / execute | matrix |
| challenge/proof | task_challenge / task_approval_submit | POST /:id/challenge, /:id/approvals | challenge / approval-submit | scoped actor; signature for proof |
| revoke | task_approval_revoke | POST /:id/approvals/:approval/revoke | approval-revoke | owner |
| status/controls | task_status / task_control | GET /status, POST /controls | status / mute / stop / resume | read / matrix |
| adapter toggle | task_adapter_control | POST /adapters/:adapter | adapter enable / disable | owner enable; agent disable |
| lease acquire/release | task_lease_acquire / task_lease_release | POST /:id/lease, DELETE /:id/lease | lease-acquire / lease-release | bound actor |
| recovery/archive | task_recover / task_archive | POST /recovery, POST /archive | recover / archive | owner |
| enrollment status | task_approval_status | GET /approval-status | approval-status | domain redacted read |
| key/credential bootstrap | none | none | auth mint/rotate/revoke; approval-key init/rotate | owner outside runtime |

Structured errors: error/code/status/retryable. Successful task responses include
expected_revision; failed mutations preserve the stored revision. Common statuses:
401 absent credential, 403 wrong role/domain/actor, 404 absent, 409 revision/binding
conflict or spent challenge, 400 validation, 422 unknown owner, 503 lock/backpressure/
source unavailable. Expired/revoked/denied/stale signatures have distinct codes
(403 or 409). Recovery adds invalid_backup (422), corruption (503). Disabled
adapter/feature or stopped execution is 409. Lease conflicts/expiry are 409.
Status never exposes tokens, key bytes or private paths. Transport-parity tests
compare success, denial, drift, conflict and overflow results.

## Time and verified sources

Duration = stored reference instant + milliseconds. Calendar = local wall time,
IANA timezone, resolved instant/offset. Fixed initial policies: reject DST gap
(leaves unarmed; owner edits time), choose earlier overlap, catch up latest with
missed-slot count. No configurable alternate modes or QR handoff in this build.
Recurrence requires explicit finite count or end; no implicit endless loop.
Show timezone, resolved offset, overlap/catch-up policy and end before arm.
Calendar recurrence advances wall slots, duration recurrence advances instants.
Calendar slot ID = task/generation/local date-time; ambiguous overlap fires once
at the earlier offset. Example Europe/Madrid 2026-10-25 02:30 fires at 00:30Z,
not again at 01:30Z. Persist each resolved future slot before it is eligible;
tzdata changes never alter that stored instant. Newly generated slots use current
rules and record resolver/version; changed future offsets require owner review.
Clock forward may make slots due; rollback never un-fires or repeats a committed
slot. Checkpoint/slot cursor advance monotonically, not with the wall clock.

Sources actually implemented: clock; registered authenticated owner/tool exact
value events; allowlisted local artifact content versions; registered Git refs;
read-only bound memory ID/content hash/revision via `deps.vault.get(id)`, the
ID-locator/disk-authority path, and core `memoryRevision` over actual disk bytes
(the same revision contract as `load-memory-handler.ts`). Do not invoke the
telemetry-producing public load handler as a polling loop. The last adapter
checks decision and assumption before evaluation and
execute; missing/cancelled/superseded/revised binding disarms, preserving old
history and requiring explicit new review. No similarity or automatic rebinding.
Tests use an invented temporary vault only.

Composite IDs use domain-separated, unambiguous structured tuples, never a colon-
joined source/key. Journal dedup binds source ID/version/kind, ownership domains,
authenticated actor and producer key; occurrence identity binds task/generation/
ownership and occurrence key. Idempotency already hashes a canonical object. P7
approval bindings must use the same unambiguous canonical encoding. Existing
journal IDs remain unchanged: legacy source:key hashes are accepted only when
source ID/revision, actor and ownership domains match the current binding exactly.
A foreign source alias never returns the old ID; it gets its own framed event.
No memory migration or bulk journal rewrite is performed.

Manual `task_reconcile` is owner-only and requires every stored task ownership
domain; daemon-owned reconciliation is internal. Registration counters distinguish
A→B→A→B from unchanged polling. Watch cursors start at explicit owner arming,
so earlier journal events do not trigger a newly accepted task. File baselines
accept raw UTF-8 content or its SHA-256; Git baselines accept the full object ID.
Neither requires hashing the hash again.

Event: monotonic sequence, source ID/version, actor/domain, observed_at,
producer state_updated_at where meaningful, sensitivity, dedup key, bounded
value/evidence. For file/Git/memory revision observations, state_updated_at denotes the instant
the adapter observed that revision, not a producer heartbeat or live-state age.
Structured premise evidence separately requires its attributable producer timestamp;
reading an old status file now cannot refresh that timestamp. Future state_updated_at
or state_updated_at later than observed_at is inconclusive. Identical freshness
checks perform no writes; checked_at/clock read time alone never adds an audit.

File/ref sources observe snapshots at polling/contact, not every
intermediate change. Registered paths reject symlink/escape; Git uses a fixed
argument vector. No arbitrary shell expression, URL or execution of verify_cmd.

Concrete premise verifier `versioned-value-v1`: owner registers source ID,
allowed event producer actor/domain, claim/decision revisions, expected exact
baseline value and permitted structured evidence source. An authorized event
carries `{claim_id, claim_revision, value, evidence_id, evidence_revision,
state_updated_at}`. Read its registered evidence snapshot (read-only artifact or
memory reference), compare its content revision and exact attributed value.
Only a fresh, matching, uncontested snapshot that contradicts the registered
baseline refutes the load-bearing premise. Same value verifies unchanged; byte
arrival, unrelated claim, missing provenance or model prose cannot refute it.
Registration is owner-reviewed task data, not dynamically uploaded verifier code.
Verifier interface takes immutable binding/event and bounded source reader,
returns outcome/reason/source/revision/observed_at/state_updated_at/max_age/timeout.
At most 1 MiB and 1 second per check; no recursion or LLM attestation.

Outcomes verified/refuted/stale/unavailable/inconclusive retain actual state age.
No attributable producer timestamp for live-state evidence is inconclusive;
missing or future/contested data is not false. Apply source freshness both before
firing and immediately before execute. Initial engineering budgets (not measured):
100 checks/tick, 10/source, 1 MiB/source, 1 s/source, 5 s/tick, 60 s polling with
failure backoff up to 1 h. Per-task stop/end/backoff shown in owner confirmation.
Budget overflow remains checkpointed backlog.

C-096: a verified refutation creates one reconsideration occurrence bound to
commitment, decision/assumption revision and material event. Show original option/
reason, old/new premise and versioned/timestamped evidence, alternatives and
uncertainty. Keep consumes that material event; stop cancels monitoring; snooze
persists. Change records an owner-confirmed new decision content revision through
`editMemoryHandler`/core `mutateMemoryFile` with mandatory `expected_revision`,
keeps the prior decision/evidence snapshot in task history, and disarms the old
watch. This is revisioned confirmation, not a newly claimed temporal graph.
An unimplemented global claim/graph system is not claimed. Source-version arrival
alone may show a distinct unverified source-change notice, never a C-096 refutation
card. Fixtures: actual exact-value refutation (8); unchanged/irrelevant/missing/
stale/contested evidence (9); edit/cancel/supersede decision and assumption (10).

## Evaluation and delivery

Persist journal, due transition, stable occurrence and checkpoint atomically
before presenting. Occurrence = task/generation/slot or material-event key,
including bound decision/assumption revisions. Receipts record attempts **per
client/session/channel** with timestamp/result/attempt ID; stable occurrence IDs
survive retry and several clients. Owner acknowledgement has actor/credential
ID and operation time, never a client claim that a human saw it. Resolve remains
separate. Relay purge/disable/consume, disconnect or overflow never consumes work.

P5 integration is mandatory: automatic firing without `task_reconcile`, one
startup catch-up after daemon boot, reconciliation at the next contact and 60 s
polling through the existing `daemon-jobs` host. `observeTaskSources` must be
reachable from that same job and manual owner reconciliation. Apply a 5 s/tick
budget and bounded failure backoff (up to 1 h), outside the hook hot path.
With no tasks, skip repeated store/source reads; a task mutation explicitly wakes
the existing job. Automatic and manual runs share the transaction/dedup path and
must produce exactly one logical occurrence, including process races. Tests must
start a daemon with an already due persisted task and observe one occurrence
without calling `task_reconcile`; missing automatic delivery is a failure.

Extend existing background-job host; startup/contact schedules bounded off-path
reconciliation. Session assembler adds cached `<bastra-due>` cards at session
start. Ongoing delivery uses `/hook/prompt` (Claude UserPromptSubmit/Codex prompt
lane where supported), via daemon prompt-lane output, not semantic recall rank.
Hook hot paths read the cached projection; changes/events immediately invalidate
cache and queue reconciliation off-path; existing job refreshes every 60 s while
daemon runs. A contact racing a refresh delivers at next suitable contact.
No unsupported provider hook or background wakeup guarantee is asserted.

Runtime wiring in P5 uses the daemon-jobs host for startup catch-up and 60 s polling;
contact/mutations only queue reconciliation after the response turn. Empty/unarmed
stores perform no periodic task I/O. A directory watcher observes task-file changes,
including creation after boot, without a second polling queue. Source checks rotate
under a 10-watched-task/source admission budget; pure evaluation keeps its 100-check
budget, snapshots share the bounded reader cache, and the tick admits no new source
work past 5 s. Failed checks back off per task from 60 s to 1 h; unrelated clock tasks
continue. Identical transactions do not rewrite snapshots. Actual presentation has
at most 3 cards/2 KiB, persistent retry budgets keyed by authenticated Actor/Role
(session/channel are informational, never an authority or quota identity) and
limits. Rendering never acknowledges or resolves; overflow remains pending. Explicit
`task_due` can read a larger bounded projection; passive integration follows in P5b.

Hookless MCP: shared tool-response finalizer attaches authorized due cards to
**every existing successful tool response**, under a 2 KiB/3-card budget. HTTP
JSON API replies add a reserved `proactive_due` projection; hookless clients need
no explicit task_due call. Errors cannot turn failed calls into success; clients
that discard attachments are declared unsupported for passive presentation and
can use task_due. Response formatting records attempted transport delivery only.
Overflow retains pending cards with a count/next-contact continuation; fairness
rotates unacknowledged IDs and retry budgets are visible. Hooks/HTTP/MCP/CLI carry
occurrence/client IDs to owner controls. Honest coverage is next-contact-only
without a tested opted-in wakeup adapter, even when daemon evaluation runs.

## Preparation, approval and local execution

prepare is a draft/diff only; notify/prepare needs no signing-key enrollment.
Proposal is the feature's sole exact-action object: versioned ID, task revision,
actor, target, operation, exact payload SHA-256, source/evidence/decision revisions,
scope/sensitivity, required approver domains and ownership-registry revision.
Determine affected domains from task ownership, registered target ownership,
read evidence source sensitivity/owner metadata and mutated scope. Missing owner
mapping blocks execute. Approval never inherits authority from a draft review.

Owner-key registry `<data-dir>/task-approval-keys.json`: versioned map domain to
Ed25519 public key/fingerprint/key ID, pinned in memory at daemon start; reload or
rotation requires explicit owner bootstrap/restart and invalidates approvals.
No API key enrollment. Private key separate from transport credentials, owner-held
and outside agent tools; encrypted PKCS#8 material in a 0600 envelope using
AES-256-GCM, random 16-byte salt, 12-byte nonce, 16-byte tag; scrypt N=32768,
r=8,p=1, 64 MiB max memory, 32-byte key. Unlock only through owner CLI /dev/tty;
never args/env/stdin/runtime tool. Display daemon-fetched exact binding/diff,
verify bytes/hash locally, then sign explicit approve/deny. If a safe preview
cannot show the exact effect, refuse approval. No unattended fallback.

Canonical domain-separated signature covers proposal ID/revision, actor,
resource/action/payload hash, required domains/registry revision, source/evidence/
decision revisions, scope/sensitivity, challenge nonce, expiry and approve/deny.
Challenges: random 32-byte nonce, max 5-minute TTL, persisted before presentation,
one per domain/binding. Proof submission verifies the pinned domain key and
consumes its challenge atomically; consumed challenge IDs persist across restart.
Every required domain signs the exact same versioned binding. Unresolved domains,
denied/expired/revoked/stale/missing signatures block the whole action; no quorum
or partial multi-owner execution. Approval IDs become permanently spent when
intent is committed, before adapter call. Reconciliation of that intent may use
its reserved receipts, but a reset/new intent cannot reuse them. Revocation is
owner-controlled and persistent; resume never renews a lease or signature.

Threat model: ordinary agent tokens, arbitrary source/actor/approved fields,
readable challenges, local network and automated browser clicks cannot sign.
CSRF/Host/bearer defenses are transport checks, not human proof. Owner-held key
and passphrase, pinned configuration and runtime integrity must be outside agent
authority. Same-UID unrestricted filesystem access, keylogging or compromised
runtime/configuration cannot be secured by this protocol. In that configuration
execute stays disabled until an owner establishes the protected boundary; notify
remains usable. Synthetic keys test mechanics, never claim a real human approval.
P7 independent review resolves this boundary before P8 construction.

Lease in task store: task/proposal ID, authenticated actor, holder token, expires_at,
monotonic fence allocated from store fencing_counter, state active/released/expired.
Grant/release under strict cross-process store lock; actor/fence/expiry checked in
same guarded transaction before intent/receipt. Local adapter holds that same lock
across final source/target validation, target CAS+rename and receipt. Never release
it for a network call; remote adapters are unsupported in this slice.

Opt-in strict path-lock mode disables **age-only takeover of a live same-host
PID**, checks holder token on commits, and fails closed on unknown/foreign owner.
Expired *action lease* can be replaced only after the store lock is acquired;
a live paused lock holder is not forcibly displaced. This deliberately sacrifices
availability during a paused process: no successor can write while it still holds
the lock, so check-to-rename preemption cannot allow a competing commit. A holder
resuming after action expiry must recheck and is denied. Dead-process lock recovery
reuses serialized reclaim/token ownership patterns, without live-owner takeover;
PID reuse/unknown liveness requires explicit owner recovery. Lease expiry denies
admission to a new commit; the final synchronous commit admitted under an exclusive
live-owner lock is indivisible relative to other task actors. A wall-clock deadline
cannot cancel a filesystem syscall already in progress. No successor is admitted
until that holder releases or is proven dead; this is the explicit fail-closed
tradeoff, rather than a claim of preemptive deadline cancellation. Same local filesystem
only. Existing lock callers retain defaults; regression tests cover draft/settings
callers and strict live-pause/dead-owner/reclaim contenders. This is #409's local
actor/lease/dedup subset, not federation or a second coordinator.

Reference adapter: exact UTF-8 replace of registered local artifact under allowlisted
root, path/symlink containment, content-revision CAS, temp+rename, private backup.
Persist intent/idempotency before call. Before-call restart rechecks binding/lease;
after-success/no-receipt reconciles exact target hash to approved bytes. Divergence
is unknown/review, never blind overwrite/retry. Rollback is a separately approved
exact CAS action against resulting revision, preserving intervening edits. Every
physical mutation has durable intended/observed outcome. Provider chat/email,
GitHub and all external-write adapters remain unsupported.

## Controls and evidence

UI/CLI expose open/due/snoozed/done and unarmed reasons, original request/why now,
evidence age, next check, last delivery/failure/backpressure and adapter coverage.
Persist enabled/muted/execution_stopped plus per-adapter enabled/coverage. Global
feature off stops evaluation/delivery/execute but preserves tasks/history and
read/owner recovery. Execution stop preserves notify/read/review. Mute defers
presentation, not resolution. Adapter disabled blocks its observation/action,
not unrelated tasks. Owner resume/enable never revives expired leases/approvals.
Project these controls/status into #656 inventory when present; no new ladder.

P1 storage/migration; P2 CRUD; P3 time/journal/adapters; P4 freshness; P5 delivery;
P6 reconsideration; P7 preparation/signatures/local leases; P8 execute after P7
review; P9 UI/status; P10 14-case matrix, migration/recovery/parity/demo/docs.
Later branches stack via merge, never rebase. Main-only PR CI trigger must be
expanded in a separate small infrastructure PR before stacked code PRs; P0 stays
docs-only. No lint script exists today: report that, never claim a lint pass.
Run build/typecheck/full suites with invented data/own port, no real vault/6723/
service files. Register #402/#598/#410 synthetic observation metadata separately
from pending longitudinal confirmation. End-to-end notify/prepare/execute demo
uses disposable artifacts; test approvals are labeled synthetic.


P5a delivery retention: each occurrence holds at most 100 recent Actor/Role attempt
summaries, with count/first/last/session/channel and a compacted-attempt total. Oldest
summaries roll over; the record limit never blocks presentation. Sessions cannot mint
new budgets. Agent attempts are rate/count bounded per Actor; owner presentation is
always available and does not inherit another actor's exhaustion. Acknowledgement,
resolution, occurrences and action receipts are never evicted by this compaction.
`task_due` is marked as writing its attempt receipt (readOnlyHint=false).

P5b passive delivery: authenticated cached cards appear on successful MCP, REST JSON,
session-context/session-hook and prompt-hook replies. Dedicated task credentials are
forwarded separately from legacy bearer tokens. Streaming MCP appends cards after
success; errors and unauthenticated clients receive none. Source evaluation is queued
outside the hook hot path. The bridge starts the shared job only with a dedicated
task credential and adds proactive_due beside successful results; consumers must
render that field (otherwise explicit task_due is the available coverage). No reply
or relay consumption is an acknowledgement or resolution.

P6 implementation: owner task_reconsider chooses keep/change/snooze/stop for one
current reconsideration occurrence. Keep resolves that material event, retaining
monitoring; change persists a disarmed intent before core ID/CAS memory mutation,
requires the exact decision revision, and keeps old decision/evidence in append-only
history. The exact planned resulting-byte hash is persisted in the task intent before the write and identifies a prior interrupted write; drift
requires review. Old bindings remain historical and are never rebound automatically.
Before each evaluation, bounded disk-authoritative decision AND assumption reads
reject revision/sensitivity/inactive/missing bindings, preserving history. Scope is
local revisioned memories, not a newly implemented global temporal graph.
P5b correction: injected due text is reference-only DATA, original requests quoted
in escaped JSON (no embedded closing tags). Passive presentation has an Actor/Role
minimum interval of 60s or configured retry interval, even for owners; explicit
owner task_due remains available regardless of others' budgets. Acknowledged but
unfinished work resurfaces passively at most daily. Pending state is preserved.
Small session budgets keep a compact availability card with the explicit due
command instead of silently dropping due work. P9/demo MUST provide one owner CLI
setup command for hook task credentials and show honest per-client missing-token
coverage. No automatic provider wakeup is claimed.

P6 correction: no proactive_change_id or other new field is added to the memory
schema. Idempotency belongs to the task intent (planned exact resulting-byte hash
and fixed updated date). Each occurrence snapshots its verified new premise from
that event, independent of later verification. Vault edit/remove notifications
immediately suppress bound cached cards; explicit due rechecks disk authority.
After keep, further premise changes require explicit owner rebinding/review; the
historical watch is disarmed and is never silently reinterpreted.

P7 implemented contract: store v2 migrates v1 only when all action arrays were
empty; proposals/challenges/approvals/leases are strict schemas. Intents/receipts
remain empty until independently reviewed P8. Preparation reads only registered
canonical local UTF-8 targets; no target writes. All affected ownership domains
(task/target/evidence sources) are required, exact payload/source/task/registry
bindings are signed. Approval records are reverified against their consumed
challenge and pinned Ed25519 key, with wall AND boot-monotonic expiry. Owner
CLI keys enroll / approve / deny unlocks encrypted keys only through /dev/tty,
shows JSON-quoted exact before/after bytes and defaults confirmation to No.
Missing protected boundary prevents lease authority; configuration is pinned at
startup, rotation requires restart. Same-UID unrestricted runtime/key/config
access remains outside the protection claim; execute remains absent in P7.
Lease grants are serialized with monotone fences and hashed holder tokens;
release/revoke stay available even if target/key configuration becomes unavailable.
P8 construction MUST await independent review of this complete P7 protocol.

P9a user contract: bastra tasks create accepts human options (--goal, --after 7d
or --when local-time plus --timezone, --domain, explicit --arm); defaults unarmed.
The shipped CLI is packages/daemon/dist/cli.js (no packages/cli directory). list
and due print readable what/when/timezone/armed/state with IDs; --json retains the
machine contract. The short hook card's bastra tasks due command is process-tested.
Owner tasks setup-hooks issues a separate domain-scoped agent credential into one
private 0600 config; hooks and MCP use it without shell env changes. An explicit
BASTRA_TASK_TOKEN overrides it. client-status reports absent/revoked credentials
and reminds that a running daemon is required. Shared #656 doctor inventory
reports configuration without claiming authentication or wakeup.
Status/controls expose open work, receipts, source/adapter/key state and job/backoff.
Mute/off/stop preserve history, tasks and spent authority; resume renews nothing.
P7 review correction (binding contract): canonical object keys and source IDs use
UTF-16 code-unit lexical order (< / >), independent of locale. Missing or disabled
local-artifact-v1 adapter means NOT enabled: no lease/write; preparation stays
read-only and available. Each owner domain reports missing/stale/expired/revoked/
denied separately. Only full-domain actors read proposal payload/target preview;
explicit partial-domain OWNERS may see exact effects to sign their domain.
Key enroll refuses an existing domain. Rotate requires a fresh mapped owner
credential and unlock/proof of the old matching private key; every key change
resets protected_boundary=false and execution_stopped=true. protected_boundary
true is the OWNER'S unverified assertion that agents cannot write the data dir,
private key or runtime; it is not an OS permission check. Registry pin is per
process start (including bridge/stdio), not a global daemon pin. P8 execution
will be hosted only by the long-lived daemon; bridge/stdio clients forward to it.
Owner CLI validates its local registry hash and domain key against daemon binding
and shows the COMPLETE signature object plus concrete target path and byte diff.
Challenge reuse is one live unconsumed challenge per domain/binding. Distinct
HTTP/MCP/CLI codes preserve signed deny/revoke/expiry/staleness/consumption.
Stop/resume may retain unexpired proofs; it never renews expired proofs/leases.
P8 must recheck everything under store lock and durably spend exact approval IDs
before the adapter, then check stop/adapter/lease/proof revocation again. Lease
alone is never authority. os.uptime on macOS has second resolution and derives
from wall/boot time; this is a documented platform limit, not a claim of perfect
monotonic time under arbitrary host clock manipulation.

The latest exact proof per owner domain is authoritative; revocation/expiry of it
never falls back to an older approval. A changed on-disk registry blocks the
pinned process until restart. Key rotation stops execution before writing key
configuration. Hidden terminal input enables raw/no-echo before displaying its
prompt; unattended stdin is rejected. Execute remains absent until this correction
is published; P8 then implements intent/spending/adapter under the reviewed guard.
Canonical API names used by this implementation are task_prepare, task_proposal,
task_challenge, task_approval, task_revoke_approval, task_lease and task_release,
with their /api/v1/<name> POST routes (OpenAPI). They supersede draft aliases in
the initial route table; no partially implemented REST execute alias is advertised.

P8 local reference adapter: task_execute / task_intent_reconcile /
task_rollback_prepare are daemon-hosted POST tools; bridge/standalone stdio
forward to the configured daemon. Store v3 migrates v2 only with empty execution
arrays. The SAME strict store lock spans validated/spent intent, private backup,
final live authority/source/target check, UTF-8 target CAS+rename and receipt.
No network/provider call or shell execution. The target keeps its existing mode;
backup and task records are private. All exact approval IDs are durably spent
before adapter effects; neither a second lease nor a retry/new intent can reuse
them. Lease holder, actor, fence, boot/wall expiry, source/decision/task binding,
registry, feature/stop/adapter and every reserved proof are rechecked. A source
event arriving but not evaluated blocks writing. Sources are bounded reads.
A successful write is a receipt, never an invented owner acknowledgement or
resolution. Crash before/after rename leaves a pending intent and spent proofs;
startup/contact recovery observes exact resulting hash and records reconciled
or unknown WITHOUT writing/retrying. Explicit reconcile uses the same rule.
Rollback prepares a new exact CAS proposal from the bound private backup and
requires NEW signatures/lease; intervening edits prohibit it. Unknown outcomes
require owner review, no blind retry. Normal admission reserves receipt capacity.
Local atomicity is relative to compliant task actors under the live-owner lock.
A final synchronous read/CAS/rename cannot prevent arbitrary uncoordinated owner
filesystem writes between syscalls; hostile same-UID runtime/filesystem access
remains outside the declared protected boundary. No arbitrary external-writer
transaction or preemptive cancellation of an admitted filesystem syscall claimed.
Owner boundary declaration is explicit/unverified, stops execution and requires
process restart; execution-enable confirms activating only the local adapter and
lifting the stop. execution_stopped defaults true and only owner changes it.

P8 review correction: the reference adapter admits only before-state that can
be re-proposed exactly (<=16384 characters, cleanText-stable UTF-8, no Tab/CRLF/
BOM/control/format/injected/secret-like text). Prepare AND execute reject other
before-state with adapter_not_reversible before spending/writing. This is an
explicit reversible plain-artifact subset, not a general file editor. Receipt-
bound rollback ignores the old task's trigger/lifecycle/evidence; it binds the
CURRENT task metadata, target, registry and original receipt, requires new exact
proofs/lease, preserves terminal/snoozed state, and never rearms the task.
Owner status lists bounded intents/receipts without paths/payloads, hashes/target
IDs/outcomes/rollback candidate and capacity. Unknown appends a task audit/review
hint "Abgleich nötig" and appears in the due card; a new pending/unknown outcome
gets one quiet-window/budget exception per actor, then normal quiet rules resume.
Reconciliation removes only its own non-symlink bounded temp with matching hash
in the registered target directory. Capacity checks occur before schema/commit;
intent limit is exactly1000, with archive controls following P9c. resume uses the
same readable owner confirmation as execution-enable (No default). Adapter status
uses enabled===true, identical to lease/write admission. Hardlinked names retain
old bytes when the registered name is replaced; special mode bits are not copied,
ordinary permissions are preserved; directory authority permits replacing a
read-only (0444) file. These filesystem effects must be understood at approval.
Automatic event visibility: an accepted journal event queues an off-path job
immediately. Each failed/unchanged check may back off (60s up to 1h), but a NEW
event ID/sequence, binding or source registry version bypasses that backoff. The
cache key is captured from the snapshot actually assessed, never from a newer
snapshot that arrived while assessment was running. Budget-deferred new events
queue another bounded turn, not a wait for the old failure's retry deadline.
Irrelevant/contested/unknown/stale results are persisted when materially changed;
only identical checks suppress writes. Before the first event, no verification
is invented (owner status says waiting for an event). Healthy small-cohort tests
require persisted result AND logical occurrence within 5 s; 5s is not a universal
wall-clock SLA. A healthy daemon with no contention/capacity/storage failure
admits an event at next queued contact or latest 60 s periodic wake, then bounded
cohorts of 10 assessments (source intake 5 s; decision guard later adds its own bounded
intake). With N eligible watchers, budget-deferred work drains in ceil(N/10)
turns. Filesystem commits/syscalls and process suspension cannot be given a hard
wall-clock upper bound; errors/capacity/backoff remain visible and no result is
falsely inferred. Unchanged failing sources without a new event retain up to 1 h
retry backoff. Measurement should wait for the saved event-specific verification
and occurrence, not just the first verification commit (evaluation is a separate
atomic commit).

Journal assessment is ordered per task cursor: the first unprocessed source event
is checked before any later event. A later irrelevant/contested event cannot hide
an earlier accepted change. An unassessed middle event is never silently skipped.
The material cache also contains the latest journal identity, so new intake wakes
checks held on an older inconclusive event; completed cursor advancement queues
the next bounded turn. These guarantees concern accepted journal events; file/Git
observation remains periodic snapshot observation, not a filesystem event log.

P9 owner surfaces: separate tasks page at /ui/tasks.html (existing optional WebUI),
explicit Owner token kept only in page memory. All task strings use textContent;
no inline HTML from memories, events, wishes or draft payloads. Task CRUD, owner
review/ack/resolve/reconsider choices, status/controls, exact proposal preview,
existing CLI signing and authorized lease/execute are connected to the same routes.
CLI default is readable German; --json remains the stable machine format. Explicit
Owner due inspection survives mute/off/ack; passive delivery obeys the controls.
Ambiguous local CLI creation remains unarmed and states its earlier-offset choice.
Owner credential cache is interactive-only, outside agent access by Owner setup;
never read by hook/MCP/agent authorization and not a signing substitute.

P9c retention/recovery: v3 gains an optional/default-empty cold archive index and
optional intent temp_cleanup_pending metadata (no memory-schema change, no action
capability migration). Export private validated exact terminal groups before an
archive-kind guard commit; the guard independently verifies hash and predecessor,
terminal/unarmed state, resolved occurrences, no pending/unknown intents, no active
leases, execution stop and exact-only row retirement. Keep active event journal,
checkpoint/fence counters and permanently consumed approval IDs. Cold task/intent
indexes retain create/execute idempotency; missing/tampered archive fails closed.
Restore imports terminal history/receipts for fresh approved rollback, keeps the
index and stops execution; never renews old authority. Max1000 archive entries,
max10000 spent tombstones and journal rows remain bounded backpressure, not automatic
unsafe purge. Orphan export before index commit is harmless and private. The last
backup may omit newer changes; quarantine preserves the damaged current original.
Owner recovery changes epoch, disarms all and stops execution. Offline unknown-lock
quarantine requires explicit stopped-process attestation, refuses known live local
owners. Public lock diagnostics never include the private task-store path.

Owner target registration uses CLI options and refuses silent ID replacement,
noncanonical/symlink boundaries and nonreversible existing bytes. Every registry
edit stops execution/resets protected_boundary; restart pins new revision. Only
local-artifact-v1 is supported, no provider/cloud/chat/email/GitHub/shell writes.
Temp cleanup resolves registered parent independently of target leaf existence,
checks own intent filename/no symlink/bounded exact approved hash; a changed registry
or foreign rest remains visible with temp_cleanup_pending and can be safely retried
after review. Receipt/outcome is immutable; cleanup never retries a target write.
Task HTTP requires the shared loopback Host predicate in addition to mapped bearer
and existing Origin gate. CLI reason codes are bounded, no raw Zod/filesystem data;
UI terminal controls are disabled, exact before/after text shown before signature,
full signed binding remains inspectable. Global/per-task source budgets are visible.

P9c review correction: recover --lock is admitted by the central flag table and
covered through the real compiled CLI/PTY for known-live rejection, unknown-owner
quarantine and default-No. Registration resolves the actual root before consent;
fixed denials cover task/key directories (key_storage_roots is optional private
registry metadata populated on enrollment), home .bastra, configured vault, agent/
hook/service configuration, shell profiles and any root encompassing protected
locations. The explicitly chosen narrow --root is the allowed work directory;
outside current cwd it receives a clear warning. Owner update/remove stop execution,
reset declaration and change registry revision, never renew proofs. Missing paths,
syntax, refusal and task-lock errors have specific bounded German feedback.
Backup recovery declares potential loss of newer changes, validates private cold
exports, rebuilds missing indexes and unions spent IDs/fence maxima from readable
original and validated exports. Active restored terminal history can coexist with
its archive; no identity reuse or hidden deletion. Corrupt exports fail closed.

P9c r2: fixed target denial includes all .git state (directory or worktree-control file), .husky, .github/workflows, .envrc and .npmrc, normalized case. package.json remains eligible with an explicit automatic-script warning before consent; it gains no extra capability. Regression asserts consumed approval status from cold archive AND recovered active snapshot, and old proof cannot acquire lease or produce another write.

P10 final recovery probe: a valid committed snapshot or successful healthy refresh clears the global store-I/O stop, permitting an accepted NEW event at queued contact instead of inheriting an old hour retry deadline. Source-specific unchanged-failure backoff remains unchanged. Regression reproduced the missed occurrence before the correction and checks exactly one within 5 s afterward.

P10 explicit due inspection reads the authoritative store (it already records a durable attempt), so it cannot contradict a just-read durable due state during fsync/watch/cache publication lag. Passive hook attachments remain cached/off-path. Deterministic stale-cache regression plus the final real-process package run cover this boundary.

P10 card budget correction: measure actual escaped DATA JSON bytes, shorten oversized cards with a stable task/occurrence identity and bastra tasks get detail command. Standard-budget reconsideration retains old/new premise, bounded reason/evidence and Owner choices. When even an actionable card cannot fit, show an availability notice instead of silence, retain overflow/pending and do not fabricate a per-occurrence attempt. CLI/UI understand both forms; passive standard-budget delivery uses the same projection.

P10 intake-budget correction: file buffers/stat admission, memory reader/locator and Git output/process deadline receive the eligible consumer byte/timeout caps before intake. Shared sources use the largest selected eligible admission; each consumer checks recorded actual bytes/ms and a smaller consumer cannot fire from a larger one. Resource reinspection can amend cost metadata without creating a material event or refreshing state age; unchanged admissibility does not write. Legacy missing cost metadata is unavailable until inspected. Recovery only retains known archived/readable spent IDs; an unreadable current store and older pre-spend backup can omit a recent unarchived receipt/tombstone. New epoch, disarm and stop prevent old-proof replay even then; audit reconstruction is not claimed.

P10 demo correction: actor-owned live reservation contention reports `lease_busy` (409), not generic conflict. A full-domain Owner may release only its own reservation by ID; agents still require exact holder token and fence. Release never renews spent proof or changes target/receipt. The UI admits one click at a time and releases its exact holder after a failed attempt; reopening and reviewing are explicit, not automatic retry.

### P11 local automatic access

On local single-user daemon/bridge startup, ensure a separate 0600 Agent credential
in the existing hook fallback file. Preserve valid config and explicit env overrides;
never overwrite unsafe files or reactivate revoked credentials. With no Owner use
personal; with one Owner identity use its mapped domains; multiple Owner identities
require explicit setup. No client-setting rewrites, no Owner credential in hook/MCP,
no signing capability. BASTRA_CONVERSATIONAL_REMINDERS=0 disables automatic setup.

P11b review clarifications: the automatically shared local Agent receives the same
assigned domains as the single local Owner identity, matching existing setup-hooks;
otherwise reminders in an existing project domain would silently remain invisible.
Multiple Owner identities still require explicit setup. This conveys Agent operation
rights in those domains, never Owner review/signatures. Any local process running as
the same OS user can read/use this private token. Same-UID unrestricted processes
are not an isolation boundary; protected execute configuration/keys must stay separate.
Unsafe/corrupt or revoked token files are not silently reactivated: normal task status,
Doctor and the once-per-start warning report unavailable cards with the remedy. If
an automatic token file disappeared, its formerly managed local-agent credentials
are revoked in the same registry transaction that issues the replacement.

R5 integration corrections: conversational duplicate identity is a SHA-256 of
canonical pre-scrub reminder definition (request/goal/resolution/cause and schedule,
recurrence/domain/scope/evidence), excluding session/client/idempotency key. Persist
only the digest, never the raw secret. Rows without a digest and edited definitions
are conservatively not merged. Internal SessionStart context requests explicitly
use assembly_only and omit task credentials; the assembler neither projects cards
nor touches quiet/delivery state. The outer Hook response alone includes/records
its card; hookless MCP context remains an actual forwarded output.
### R6 private comparison correction

Reminder and create-request identity now use purpose-separated HMAC-SHA-256 with
a random 256-bit key belonging only to this task-store path. The private 0600
no-follow key is neither a token nor Owner/signing authority. It never enters
Task JSON, backups, exports, cards, status, browser responses or logs. Comparison
fields are removed from all canonical tool/HTTP results. Cold exports omit both
reminder and create comparison values; private create bindings stay in the existing
live archive index so exact retries still return the original archived identity.

Valid legacy live snapshots/backups lose unkeyed reminder/create values. Managed
cold exports are cleaned with a resumable private archive/index migration under
the existing store lock. Old raw text is not reconstructed. A legacy retry whose
comparison is no longer recoverable fails closed; use the existing task ID rather
than treating matching redaction placeholders as proof. Losing or weakening an
already-used key fails closed, never silently issues a replacement. Full filesystem
access as the same OS user remains outside this boundary.

Audit of earlier P3/P4 remains separate: task-events.ts taskValueHash(value),
claim.value_hash and task-service.ts expected_hash are still unkeyed pre-scrub
comparisons. For low-entropy masked input they have the same dictionary-oracle
property. This correction does not change their producer/verifier/version-binding
contract; it does NOT claim those older fields are confidential. File/Git/Memory
version digests and exact adapter byte hashes likewise remain integrity metadata.
