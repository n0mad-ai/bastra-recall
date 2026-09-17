# Bastra Recall – Evolution Architecture V2 → V3

> **Status:** planning. None of this is built or approved.
> **As of:** 17 September 2026.
> **Source:** the V3.0 plan in [#401](https://github.com/n0mad-ai/bastra-recall/issues/401)
> with steps [#402](https://github.com/n0mad-ai/bastra-recall/issues/402)–[#410](https://github.com/n0mad-ai/bastra-recall/issues/410),
> the addendum [#450](https://github.com/n0mad-ai/bastra-recall/issues/450) and
> the milestone "V3.0 — Anticipatory, causal and shared memory".
> Where an issue and this document differ, the issue applies and this document
> is updated to match.
>
> **Language versions.** The German version,
> [`Evolutionsarchitektur V2 zu V3.md`](./Evolutionsarchitektur%20V2%20zu%20V3.md),
> is the original. This file is a translation.
>
> **Predecessor:** [`Evolution Architecture V1 to V2.md`](./Evolution%20Architecture%20V1%20to%20V2.md).
> V3 builds on its contracts and replaces none of them.

## 1. What this is about

V2 answers: **Which memory is relevant now?**

V3 answers: **What must resurface when, who needs to know, what may happen next,
and did it actually help?**

The goal is not autonomous action for its own sake. The goal is a memory that
keeps future commitments, proves the value of its interventions and coordinates
explicitly shared knowledge, without anyone losing control over their own
memory.

Seven building blocks are added:

1. **Prospective memory** – commitments and deadlines ("remind me when X").
2. **Deterministic event and trigger engine** – reliably detects when a
   condition occurs.
3. **Permissioned actions** – notify, prepare, and execute only with an explicit
   capability.
4. **Causal outcome memory** – separates "happened together" from "demonstrably
   helped".
5. **Reviewed workflow synthesis** – repeated successful sequences become
   proposals for reusable workflows, never unreviewed automation.
6. **Federated memory** – personal, project and team, across devices and
   people.
7. **Multi-agent coordination** – several assistants share memory without
   amplifying each other or duplicating work.

## 2. Non-negotiable

- V2.0's contracts on provenance, abstention (`no_answer`), review and rollback
  remain the foundation.
- Predictions and planned actions do not become facts because they were
  generated.
- Learned workflows cannot grant themselves permissions.
- Personal memory is never silently overwritten by shared memory.
- External side effects require an explicit capability and a confirmation.
- Sync conflicts stay visible and are never resolved by the latest timestamp
  alone.
- V3.0 is done only when anticipation, causal learning, federation and
  coordination have passed their own measured gates.

There is **no due date**. Longitudinal evidence and safety gates decide
progress, not the calendar.

## 3. Safety boundary

Recall **may**:

- detect prospective conditions,
- prepare actions,
- learn causal policies in controlled experiments,
- propose reusable workflows,
- synchronize explicitly shared knowledge.

Recall **may not**:

- turn predictions into facts,
- act externally without a capability,
- let a learned workflow widen its permissions,
- hide sync conflicts,
- treat majority agreement as truth,
- overwrite personal memory with team consensus.

## 4. Entry condition

- The V2.0 plan ([#386](https://github.com/n0mad-ai/bastra-recall/issues/386))
  and its promotion gate ([#400](https://github.com/n0mad-ai/bastra-recall/issues/400))
  are the prerequisite.
- Live V3 work starts only once V2.0 runs stably over time, rollback works
  reliably, the provenance of every memory is complete and usable outcome data
  exists.
- Read-only research, schema drafts, simulations and synthetic fault tests may
  start earlier.
- Every V3 component gets its own measured gate, its own switch and V2 as its
  fallback.

## 5. Global rules

1. Facts, predictions, intentions, commitments and actions remain separate
   objects.
2. A due condition is not evidence that its proposition is true.
3. Models may propose trigger predicates; deterministic sources attest whether
   an event occurred.
4. The default level of every action is notification.
5. Capabilities are explicit, scoped, expiring and revocable.
6. Learned policies and workflows cannot create or widen permissions.
7. Causal claims require sound method: known selection probability, a control
   group and handling of unobserved cases.
8. Personal memory and unresolved conflicts survive sharing.
9. Repetition by agents is not independent evidence.
10. Every V3 component is explainable, auditable and can be rolled back to
    local V2.
11. V3.0 is complete only when step 09 is proven end to end – not merely once it
    is built.

## 6. The plan in nine steps

```text
V2.0 (#386 / #400)
  └─ 01 Entry gate
       ├─ 02 Prospective memory
       │    └─ 03 Event and trigger engine
       │         └─ 04 Permissioned actions
       │              └─ 05 Causal outcome memory
       │                   └─ 06 Workflow synthesis
       └─ 07 Federated memory   (also needs V2 provenance and identity)
            └─ 08 Multi-agent coordination
  all mandatory properties ─→ 09 V3.0 promotion gate
```

The order has reasons:

- Commitments must exist before anything triggers them; triggers must be
  reliable before anything is executed.
- Causal learning needs observable interventions; workflows need proven
  successes.
- Federation needs stable identity, versions, scope and provenance;
  coordination needs federation.
- The long-term V2 level is the rollback target for every V3 component.

### Phase A – Foundation

#### Step 01 – Entry gate ([#402](https://github.com/n0mad-ai/bastra-recall/issues/402))

V3 starts from a V2.0 that has been proven over time, not from a one-day
comparison. Before anything changes live, it is fixed how anticipation, causal
intervention and sharing are evaluated.

- Observation windows and minimum sample sizes are fixed in advance, per
  client, project, language and trigger type.
- A long-term V2 scorecard covers quality, false interruptions, accessibility
  drift, drift of learned policies, rollback and provenance survival.
- V3 test cases cover due and conditional commitments, missed and false
  triggers, denied permissions, prepared actions, sync conflicts and echo loops
  between agents.
- Every V3 component has fixed kill criteria and a fixed V2 rollback point.
- Raw personal and team data stays local or is used only with consent; public
  reports contain aggregates only.
- No V3 feature goes live on synthetic results alone.

### Phase B – Prospective memory and anticipation

#### Step 02 – Commitments, deadlines and lifecycle ([#403](https://github.com/n0mad-ai/bastra-recall/issues/403))

Recall can record what must resurface in the future without confusing a plan, a
prediction or a reminder with a fact. The starting point is
[#250](https://github.com/n0mad-ai/bastra-recall/issues/250): "remind me when
X" cannot be fulfilled today.

A commitment carries at least:

- stable ID, source and owner,
- scope (personal, project, team),
- deterministic trigger predicate and due window,
- timezone and recurrence policy,
- status `pending | due | snoozed | resolved | cancelled | expired`,
- the expected level (notification or action),
- the evidence or condition that resolves it,
- a key against double firing and the receipt of the last firing,
- validity, sensitivity and required permissions.

Rules:

- A read-only prototype comes first, then the schema decision.
- "Due" does not mean "true"; it means "must be checked or surfaced".
- A resolved or cancelled commitment does not silently re-arm.
- Recurrence is explicit and bounded.
- Timezone and daylight saving time are stored, versioned and testable.
- The first surface is session start. This step never acts externally.
- A one-shot commitment fires at most once per due transition; offline time and
  "only in the next session" never lose a due event.

#### Step 03 – Deterministic event and trigger engine ([#404](https://github.com/n0mad-ai/bastra-recall/issues/404))

Recall detects when a condition actually becomes due through a local,
replayable event engine. Models may propose conditions, but cannot decide on
their own that an event occurred.

Event sources, each behind its own permission and reliability gate, local
first:

- time (monotonic and wall clock) and catch-up in the next session,
- project, worktree and task phase,
- Git refs, releases and repository state,
- changes to files, paths and symbols,
- state of entities, documents and versions,
- explicit events from the user or tools,
- optionally external connectors and webhooks.

Rules:

- Events have a versioned format with source, time axes, deduplication key and
  sensitivity.
- A journal allows replay and recovery after a crash. A trigger fires logically
  exactly once, even if delivery is retried.
- "In the next session" comes first; background wakeups need their own opt-in
  and stay resource-bounded.
- Every firing is explainable: which event, which condition.
- Clock changes, restarts or retries never create a duplicate firing.
- A failing source is visible and never counted as "condition not met".
- Evaluation never blocks the normal recall hooks.

#### Step 04 – Permissioned actions: notify, prepare, execute ([#405](https://github.com/n0mad-ai/bastra-recall/issues/405))

A due commitment can notify, prepare an action or – only with an explicit
capability – execute a bounded action. Memory never becomes ambient authority.

Levels:

1. `notify` – surface context only (default).
2. `prepare` – dry run, draft, diff or proposed command.
3. `execute` – exactly the approved operation within a scoped capability.

Rules:

- A capability is bound to actor, resource, action, scope, expiry and
  revocation.
- Approval has no preselected execute option. Every mutating action shows a dry
  run and a readable diff first.
- Approval for one action or target cannot be reused for another.
- A learned workflow can neither create, widen, delegate nor renew a
  capability.
- Partial failure is never reported as completed.
- Secrets and capability material never enter memory or public telemetry.
- The chain commitment → trigger → proposal → approval → action → outcome is
  fully traceable.
- A revocation takes effect before the next action and survives a restart.
- If step 04 is switched off, prospective memory remains as notification only.

### Phase C – Causal learning

#### Step 05 – Causal outcome memory ([#406](https://github.com/n0mad-ai/bastra-recall/issues/406))

Along the chain `memory → decision → trigger → action → outcome`, Recall
separates correlation from demonstrated value. It learns not only which memory
was used, but whether surfacing it at that moment improved the result.

Rules:

- Outcomes are distinguished: success, failure, avoided violation, correction,
  no effect, partial, unknown.
- Without known selection probability, a control group and handling of
  unobserved cases, there is no causal claim.
- A successful task after exposure does not prove that the memory caused the
  success.
- Not shown and silence count as "not observed", not as negative.
- Experiments exclude destructive, privacy-sensitive and high-risk actions.
- Descriptive, associational and causal reports stay visibly separate.
- The output is proposals for timing, interruption, routing and action level –
  never a change to facts, never more permissions.
- A learned policy must beat the fixed rule before it enters a test phase. A
  rollback removes the policy, not the collected episodes.

#### Step 06 – Reviewed workflow and strategy synthesis ([#407](https://github.com/n0mad-ai/bastra-recall/issues/407))

Repeated successful sequences can yield a proposal for a reusable workflow –
never an unreviewed autonomous routine.

A proposal records goal and applicability conditions, steps with branches,
expected intermediate results, known failure modes and abort rules, required
resources and permissions, source episodes, tested environments, a review date
and a version with a rollback target.

Rules:

- Frequency is not success; only proven successful episodes count, and a single
  one is never enough.
- A workflow does not inherit permissions from its source episodes.
- It is compared in a sandbox against simpler strategies and against "do
  nothing", and must be measurably better.
- A human accepts, edits, rejects or retires it.
- If a precondition is missing, the workflow abstains instead of improvising.
- Generated executable content is untrusted until reviewed.
- Changes to environment, dependencies or evidence trigger a new review.
- Retirement deletes neither evidence nor earlier versions.

### Phase D – Federation and coordination

#### Step 07 – Federated personal, project and team memory ([#408](https://github.com/n0mad-ai/bastra-recall/issues/408))

Several devices and people can share selected memories without the vault
turning into "last writer wins" and without losing personal context.

Scopes: personal, project/workspace, team and – only when explicitly enabled –
organization/public. Sharing is explicit and additive: a personal and a team
claim may coexist and visibly contradict each other.

Rules:

- Shared content has a content-based identity and version.
- Offline first: a journal and a deterministic reconciliation procedure merge
  changes. No merging by timestamp alone.
- Shared scopes are encrypted in transit and at rest, with key rotation and
  revocation. Revoked devices receive nothing new.
- Conflicts become objects of their own with a reviewed merge.
- Deletions propagate without destroying required history and without
  resurrecting data.
- Metadata does not reveal that a protected memory exists.
- Offline edits stay attributed to their device and person.
- Team consensus never overwrites personal memory.
- A sync failure is visible and never reported as up to date.
- The merge rules are fixed before transport and storage are chosen; changing
  the backend does not change them.
- Federation can be detached and leaves a consistent local vault.

Existing import and device-sync work
([#299](https://github.com/n0mad-ai/bastra-recall/issues/299),
[#339](https://github.com/n0mad-ai/bastra-recall/issues/339),
[#341](https://github.com/n0mad-ai/bastra-recall/issues/341)) stays in its own
milestone; step 07 uses its results without duplicating them.

#### Step 08 – Multi-agent coordination ([#409](https://github.com/n0mad-ai/bastra-recall/issues/409))

Several assistants can observe and use shared memory without echo
amplification, duplicate work, hidden ownership or truth by majority.

Rules:

- Every observation, proposal and action carries the agent's identity and its
  provenance.
- Events are deduplicated across agents and devices, and loops are detected.
- Open commitments and prepared actions have time-limited ownership (a lease).
  It coordinates work but does not hide the commitment from others.
- Shared knowledge states: `asserted | confirmed | contested | superseded | unknown`.
- Agreement between agents with the same source is not independent evidence;
  repeated citation of the same source counts once.
- A majority does not establish truth.
- One agent cannot spend another agent's capability.
- Echoes raise neither confidence, weight, rank nor learned utility.
- Unresolved conflicts stay visible to everyone authorized.
- Handoffs preserve evidence, state, permissions and rollback target.
- Before any shared execution, coordination first runs as a read-only
  simulation. It can be switched off while shared memory stays readable.

### Phase E – Promotion

#### Step 09 – Promotion gate, security and rollback proof ([#410](https://github.com/n0mad-ai/bastra-recall/issues/410))

V3.0 ships only when anticipation, permissioned actions, causal learning,
workflow synthesis, federation and coordination work together as one safe
product.

Evidence:

- end-to-end tests for local, next session, background (opted in) and
  federated,
- clean install, migration from V2, offline upgrade, downgrade, key revocation
  and full rollback,
- chaos tests for lost wakeups, duplicate actions, delayed outcomes, network
  partitions, merge conflicts and echo loops,
- attack tests against permissions and a review of the connector sandbox,
- privacy tests across content, metadata, event journals, causal episodes and
  shared reports,
- user tests on interruption burden, clarity of approvals, conflict review and
  recovery.

Promotion checklist:

- V2.0 remains stable and is the tested fallback.
- Due commitments are neither silently lost nor fired twice.
- False and missed triggers stay within the fixed thresholds.
- Predictions, intentions, facts and actions stay separate.
- External effects require and respect explicit capabilities.
- Zero permission violations and zero leaks across scope boundaries.
- Causal claims meet the methodological requirements.
- Learned workflows beat their comparison strategy and cannot gain permissions.
- Sync loses nothing silently and keeps conflicts visible.
- Shared consensus cannot overwrite personal memory.
- Echoes between agents amplify neither evidence nor utility.
- Every action, merge, workflow and learned policy is explainable and can be
  rolled back.
- A global kill switch returns to local V2 without data loss.

Optional components that fail their gate stay off. An unproven mandatory
property keeps V3.0 open. Time pressure lifts no gate on permissions, privacy,
causality, sync integrity or rollback.

## 7. Open design questions

These points come from an external critical review of the plan on 28 August
2026 and are attached as comments to the respective issues. They are not decided
yet.

- **Whose approval counts when there are several owners?**
  ([#450](https://github.com/n0mad-ai/bastra-recall/issues/450)) Step 04
  assumes exactly one approving person. When an action touches personal and
  team memory at the same time, it is open whether every affected party must
  approve, whether a defined quorum is enough, and whether partial execution is
  allowed. Proposal: approval becomes a set (one per affected domain), and
  execution happens only when all required approvals or an explicitly defined
  quorum are present. This must be decided before federation.
- **Stale approvals** ([#405](https://github.com/n0mad-ai/bastra-recall/issues/405))
  A capability expires over time or is revoked, but not when the approved
  content changes before execution. Proposal: the capability binds the state it
  was approved against; it is checked again at execution time, and "stale"
  becomes an outcome of its own next to "expired" and "revoked". Also open: the
  reasoning why the approver must not be the proposer.
- **Order of causal methods**
  ([#406](https://github.com/n0mad-ai/bastra-recall/issues/406)) Proposal: first
  use the existing threshold in the recall score as a natural experiment, then a
  randomized grey zone via V2's canary mechanism instead of separate
  experimentation machinery; fix the smallest detectable effect in advance.

## 8. Cross-cutting metrics

Each step reports the values that apply to it:

- precision and recall of helpful triggers, rate of missed triggers,
- cost of interruptions and completion rate of commitments,
- denied or violated permissions and duplicate actions,
- effect of interventions with uncertainty and unobserved cases,
- adoption, success, abstention and rollback of workflows,
- sync conflicts, silent loss, recovery and convergence,
- leaks across scope and sensitivity boundaries,
- accuracy of provenance and attribution,
- echo amplification, duplicate work and lease recovery across agents,
- latency, resource use and behavior offline or in degraded mode.
