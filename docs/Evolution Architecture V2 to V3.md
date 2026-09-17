# Bastra Recall – Evolution Architecture V2 → V3 / Evolutionsarchitektur V2 → V3

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

> **Status:** planning. None of this is built or approved.
> **As of:** 17 September 2026.
> **Source:** the V3.0 plan in [#401](https://github.com/n0mad-ai/bastra-recall/issues/401)
> with steps [#402](https://github.com/n0mad-ai/bastra-recall/issues/402)–[#410](https://github.com/n0mad-ai/bastra-recall/issues/410),
> the addendum [#450](https://github.com/n0mad-ai/bastra-recall/issues/450) and
> the milestone "V3.0 — Anticipatory, causal and shared memory".
> Where an issue and this document differ, the issue applies and this document
> is updated to match.
>
> **Language versions.** This file contains both language versions: English
> first, [German below](#deutsch). The German version was written first; both
> versions are maintained together.
>
> **Predecessor:** [`Evolution Architecture V1 to V2.md`](./Evolution%20Architecture%20V1%20to%20V2.md).
> V3 builds on its contracts and replaces none of them.

### 1. What this is about

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

### 2. Non-negotiable

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

### 3. Safety boundary

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

### 4. Entry condition

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

### 5. Global rules

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

### 6. The plan in nine steps

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

#### Phase A – Foundation

##### Step 01 – Entry gate ([#402](https://github.com/n0mad-ai/bastra-recall/issues/402))

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

#### Phase B – Prospective memory and anticipation

##### Step 02 – Commitments, deadlines and lifecycle ([#403](https://github.com/n0mad-ai/bastra-recall/issues/403))

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

##### Step 03 – Deterministic event and trigger engine ([#404](https://github.com/n0mad-ai/bastra-recall/issues/404))

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

##### Step 04 – Permissioned actions: notify, prepare, execute ([#405](https://github.com/n0mad-ai/bastra-recall/issues/405))

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

#### Phase C – Causal learning

##### Step 05 – Causal outcome memory ([#406](https://github.com/n0mad-ai/bastra-recall/issues/406))

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

##### Step 06 – Reviewed workflow and strategy synthesis ([#407](https://github.com/n0mad-ai/bastra-recall/issues/407))

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

#### Phase D – Federation and coordination

##### Step 07 – Federated personal, project and team memory ([#408](https://github.com/n0mad-ai/bastra-recall/issues/408))

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

##### Step 08 – Multi-agent coordination ([#409](https://github.com/n0mad-ai/bastra-recall/issues/409))

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

#### Phase E – Promotion

##### Step 09 – Promotion gate, security and rollback proof ([#410](https://github.com/n0mad-ai/bastra-recall/issues/410))

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

### 7. Open design questions

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

### 8. Cross-cutting metrics

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

<a id="deutsch"></a>

## Deutsch

> **Status:** Planung. Nichts davon ist gebaut oder freigegeben.
> **Stand:** 17. September 2026.
> **Quelle:** der V3.0-Plan in [#401](https://github.com/n0mad-ai/bastra-recall/issues/401)
> mit den Schritten [#402](https://github.com/n0mad-ai/bastra-recall/issues/402)–[#410](https://github.com/n0mad-ai/bastra-recall/issues/410),
> dem Nachtrag [#450](https://github.com/n0mad-ai/bastra-recall/issues/450) und
> Milestone „V3.0 — Anticipatory, causal and shared memory“.
> Weichen Issue und Dokument voneinander ab, gilt das Issue; das Dokument wird
> dann nachgezogen.
>
> **Sprachfassungen.** Diese Datei enthält beide Sprachfassungen: oben
> [Englisch](#english), darunter Deutsch. Die deutsche Fassung wurde zuerst
> geschrieben; beide Fassungen werden gemeinsam gepflegt.
>
> **Vorgänger:** [`Evolutionsarchitektur V1 zu V2.md`](./Evolutionsarchitektur%20V1%20zu%20V2.md).
> V3 baut auf dessen Verträgen auf und ersetzt keinen davon.

### 1. Worum es geht

V2 beantwortet die Frage: **Welche Erinnerung ist jetzt relevant?**

V3 beantwortet: **Was muss wann wieder auftauchen, wer muss es wissen, was darf
als Nächstes passieren – und hat es tatsächlich geholfen?**

Das Ziel ist kein autonomes Handeln um seiner selbst willen. Ziel ist ein
Gedächtnis, das zukünftige Zusagen einhält, den Nutzen seiner Eingriffe belegt
und ausdrücklich geteiltes Wissen koordiniert, ohne dass jemand die Kontrolle
über das eigene Gedächtnis verliert.

Dafür kommen sieben Bausteine hinzu:

1. **Prospektives Gedächtnis** – Zusagen und Fristen („erinnere mich, wenn X“).
2. **Deterministische Event- und Trigger-Engine** – erkennt verlässlich, wann
   eine Bedingung eintritt.
3. **Berechtigungsgebundene Handlungen** – benachrichtigen, vorbereiten und nur
   mit ausdrücklicher Berechtigung ausführen.
4. **Kausales Outcome-Gedächtnis** – unterscheidet „kam zusammen vor“ von „hat
   nachweislich geholfen“.
5. **Geprüfte Workflow-Synthese** – aus wiederholt erfolgreichen Abläufen werden
   Vorschläge für wiederverwendbare Abläufe, nie ungeprüfte Automatik.
6. **Föderiertes Gedächtnis** – persönlich, Projekt und Team über mehrere Geräte
   und Personen.
7. **Multi-Agent-Koordination** – mehrere Assistenten teilen Gedächtnis, ohne
   sich gegenseitig zu verstärken oder doppelt zu arbeiten.

### 2. Nicht verhandelbar

- Die Verträge aus V2.0 zu Herkunft, Enthaltung (`no_answer`), Review und
  Rollback bleiben das Fundament.
- Vorhersagen und geplante Handlungen werden nicht dadurch zu Fakten, dass sie
  erzeugt wurden.
- Gelernte Workflows können sich keine Berechtigungen erteilen.
- Persönliches Gedächtnis wird nie still durch geteiltes Gedächtnis
  überschrieben.
- Externe Wirkungen (Side Effects) brauchen eine ausdrückliche Berechtigung und
  eine Bestätigung.
- Sync-Konflikte bleiben sichtbar und werden nie allein nach dem jüngsten
  Zeitstempel entschieden.
- V3.0 ist erst fertig, wenn Vorausschau, kausales Lernen, Föderation und
  Koordination ihre eigenen gemessenen Schwellen bestanden haben.

Es gibt **kein Zieldatum**. Über den Fortschritt entscheiden Langzeitbelege und
Sicherheitsschwellen, nicht der Kalender.

### 3. Sicherheitsgrenze

Recall **darf**:

- vorausschauende Bedingungen erkennen,
- Handlungen vorbereiten,
- kausale Strategien in kontrollierten Experimenten lernen,
- wiederverwendbare Workflows vorschlagen,
- ausdrücklich geteiltes Wissen synchronisieren.

Recall **darf nicht**:

- Vorhersagen zu Fakten machen,
- ohne Berechtigung nach außen wirken,
- einen gelernten Workflow seine Rechte erweitern lassen,
- Sync-Konflikte verstecken,
- Mehrheitsmeinung als Wahrheit behandeln,
- persönliches Gedächtnis mit Team-Konsens überschreiben.

### 4. Eintrittsbedingung

- Der V2.0-Plan ([#386](https://github.com/n0mad-ai/bastra-recall/issues/386))
  und sein Freigabe-Gate ([#400](https://github.com/n0mad-ai/bastra-recall/issues/400))
  sind die Voraussetzung.
- Live-Arbeit an V3 beginnt erst, wenn V2.0 über längere Zeit stabil läuft,
  Rollback zuverlässig funktioniert, die Herkunft jeder Erinnerung vollständig
  ist und brauchbare Outcome-Daten vorliegen.
- Reine Recherche, Schemaentwürfe, Simulationen und synthetische Fehlertests
  dürfen früher beginnen.
- Jede V3-Komponente bekommt eine eigene gemessene Schwelle, einen eigenen
  Schalter und V2 als Rückfallebene.

### 5. Globale Regeln

1. Fakten, Vorhersagen, Absichten, Zusagen und Handlungen bleiben getrennte
   Objekte.
2. Eine fällige Bedingung ist kein Beleg dafür, dass ihre Aussage stimmt.
3. Modelle dürfen Trigger-Bedingungen vorschlagen; ob ein Ereignis eingetreten
   ist, bestätigen deterministische Quellen.
4. Die Standardstufe jeder Handlung ist die Benachrichtigung.
5. Berechtigungen sind ausdrücklich, begrenzt, befristet und widerrufbar.
6. Gelernte Strategien und Workflows können keine Berechtigungen schaffen oder
   erweitern.
7. Kausale Aussagen verlangen saubere Methodik: bekannte Auswahlwahrscheinlichkeit,
   Kontrollgruppe und Umgang mit fehlenden Beobachtungen.
8. Persönliches Gedächtnis und ungelöste Konflikte überleben das Teilen.
9. Wiederholung durch Agenten ist kein unabhängiger Beleg.
10. Jede V3-Komponente ist erklärbar, prüfbar und auf lokales V2
    zurücksetzbar.
11. V3.0 ist erst abgeschlossen, wenn Schritt 09 durchgängig belegt ist – nicht
    schon, wenn er gebaut ist.

### 6. Der Plan in neun Schritten

```text
V2.0 (#386 / #400)
  └─ 01 Eintrittsgate
       ├─ 02 Prospektives Gedächtnis
       │    └─ 03 Event- und Trigger-Engine
       │         └─ 04 Berechtigte Handlungen
       │              └─ 05 Kausales Outcome-Gedächtnis
       │                   └─ 06 Workflow-Synthese
       └─ 07 Föderiertes Gedächtnis   (braucht zusätzlich V2-Herkunft und -Identität)
            └─ 08 Multi-Agent-Koordination
  alle Pflicht-Eigenschaften ─→ 09 Freigabe-Gate V3.0
```

Die Reihenfolge hat Gründe:

- Zusagen müssen existieren, bevor etwas sie auslöst; Auslöser müssen
  verlässlich sein, bevor irgendetwas ausgeführt wird.
- Kausales Lernen braucht beobachtbare Eingriffe; Workflows brauchen
  belegte Erfolge.
- Föderation braucht stabile Identität, Versionen, Scope und Herkunft;
  Koordination braucht die Föderation.
- Das V2-Langzeitniveau ist für jede V3-Komponente das Rollback-Ziel.

#### Phase A – Fundament

##### Schritt 01 – Eintrittsgate ([#402](https://github.com/n0mad-ai/bastra-recall/issues/402))

V3 startet von einem über längere Zeit bewiesenen V2.0, nicht von einem
Eintagesvergleich. Bevor sich live etwas ändert, steht fest, wie Vorausschau,
kausale Eingriffe und Teilen bewertet werden.

- Beobachtungsfenster und Mindestmengen werden vorab festgelegt, getrennt nach
  Client, Projekt, Sprache und Trigger-Art.
- Eine Langzeit-Bewertung von V2 deckt Qualität, Fehlunterbrechungen,
  Zugänglichkeitsdrift, Drift gelernter Strategien, Rollback und den Erhalt der
  Herkunft ab.
- Testfälle für V3 umfassen fällige und bedingte Zusagen, verpasste und falsche
  Auslöser, verweigerte Berechtigungen, vorbereitete Handlungen, Sync-Konflikte
  und Echo-Schleifen zwischen Agenten.
- Für jede V3-Komponente gibt es festgelegte Abbruchkriterien und einen
  festen V2-Rückfallpunkt.
- Rohdaten von Personen und Teams bleiben lokal oder werden nur mit
  Einwilligung genutzt; öffentliche Berichte enthalten nur Aggregate.
- Kein V3-Feature geht live, das nur auf synthetischen Ergebnissen beruht.

#### Phase B – Prospektives Gedächtnis und Vorausschau

##### Schritt 02 – Zusagen, Fristen und Lebenszyklus ([#403](https://github.com/n0mad-ai/bastra-recall/issues/403))

Recall kann festhalten, was künftig wieder auftauchen muss, ohne einen Plan,
eine Vorhersage oder eine Erinnerung mit einem Fakt zu verwechseln. Ausgangspunkt
ist [#250](https://github.com/n0mad-ai/bastra-recall/issues/250): „Erinnere mich,
wenn X“ ist heute nicht erfüllbar.

Eine Zusage enthält mindestens:

- stabile ID, Quelle und Eigentümer,
- Scope (persönlich, Projekt, Team),
- deterministische Auslösebedingung und Fälligkeitsfenster,
- Zeitzone und Wiederholungsregel,
- Status `pending | due | snoozed | resolved | cancelled | expired`,
- die erwartete Stufe (Benachrichtigung oder Handlung),
- den Beleg oder die Bedingung, die sie erledigt,
- einen Schlüssel gegen Doppelauslösung und den Beleg der letzten Auslösung,
- Gültigkeit, Sensitivität und nötige Berechtigungen.

Regeln:

- Zuerst ein nur lesender Prototyp, danach die Entscheidung über das Schema.
- „Fällig“ heißt nicht „wahr“, sondern „muss geprüft oder gezeigt werden“.
- Eine erledigte oder abgesagte Zusage wird nicht still wieder scharf.
- Wiederholungen sind ausdrücklich und begrenzt.
- Zeitzone und Sommerzeit sind gespeichert, versioniert und testbar.
- Die erste Oberfläche ist der Sitzungsstart. Dieser Schritt wirkt nie nach
  außen.
- Eine einmalige Zusage löst pro Fälligkeit höchstens einmal aus; Offline-Zeit
  und „erst in der nächsten Sitzung“ verlieren kein fälliges Ereignis.

##### Schritt 03 – Deterministische Event- und Trigger-Engine ([#404](https://github.com/n0mad-ai/bastra-recall/issues/404))

Recall erkennt über eine lokale, wiederholbare Event-Engine, wann eine Bedingung
wirklich fällig wird. Modelle dürfen Bedingungen vorschlagen, aber nicht
selbst entscheiden, dass ein Ereignis eingetreten ist.

Ereignisquellen, jede mit eigener Berechtigung und eigener
Zuverlässigkeitsschwelle, zuerst lokal:

- Uhrzeit (monoton und Wanduhr) und Nachholen in der nächsten Sitzung,
- Projekt, Worktree und Aufgabenphase,
- Git-Refs, Releases und Repository-Zustand,
- Änderungen an Dateien, Pfaden und Symbolen,
- Zustand von Entitäten, Dokumenten und Versionen,
- ausdrückliche Ereignisse von Nutzer oder Werkzeugen,
- optional externe Connectoren und Webhooks.

Regeln:

- Ereignisse haben ein versioniertes Format mit Quelle, Zeitachsen,
  Duplikatschlüssel und Sensitivität.
- Ein Journal erlaubt Wiederholung und Wiederaufnahme nach Absturz. Eine
  Auslösung passiert logisch genau einmal, auch wenn die Zustellung
  wiederholt wird.
- Zuerst gilt „in der nächsten Sitzung“; Aufwecken im Hintergrund braucht eine
  eigene Freigabe und bleibt ressourcenbegrenzt.
- Jede Auslösung ist erklärbar: welches Ereignis, welche Bedingung.
- Uhrumstellung, Neustart oder Wiederholung erzeugen keine doppelte Auslösung.
- Fällt eine Quelle aus, wird das sichtbar und nie als „Bedingung nicht
  erfüllt“ gewertet.
- Die Auswertung blockiert nie die normalen Recall-Hooks.

##### Schritt 04 – Berechtigte Handlungen: benachrichtigen, vorbereiten, ausführen ([#405](https://github.com/n0mad-ai/bastra-recall/issues/405))

Eine fällige Zusage kann benachrichtigen, eine Handlung vorbereiten oder – nur
mit ausdrücklicher Berechtigung – eine begrenzte Handlung ausführen. Gedächtnis
wird nie zu einer stillschweigenden Vollmacht.

Stufen:

1. `notify` – nur Kontext zeigen (Standard).
2. `prepare` – Probelauf, Entwurf, Diff oder vorgeschlagener Befehl.
3. `execute` – genau die freigegebene Operation innerhalb einer begrenzten
   Berechtigung.

Regeln:

- Eine Berechtigung ist gebunden an Handelnden, Ressource, Aktion, Scope,
  Ablauf und Widerruf.
- Die Freigabe hat keine vorausgewählte Ausführen-Option. Jede verändernde
  Aktion zeigt vorher einen Probelauf und einen lesbaren Diff.
- Eine Freigabe für eine Aktion oder ein Ziel lässt sich nicht für ein anderes
  wiederverwenden.
- Ein gelernter Workflow kann Berechtigungen weder schaffen, erweitern,
  weitergeben noch verlängern.
- Teilweises Scheitern wird nie als „erledigt“ gemeldet.
- Geheimnisse und Berechtigungsmaterial landen nie im Gedächtnis oder in
  öffentlicher Telemetrie.
- Die Kette Zusage → Auslösung → Vorschlag → Freigabe → Handlung → Ergebnis
  ist lückenlos nachvollziehbar.
- Ein Widerruf wirkt vor der nächsten Aktion und übersteht einen Neustart.
- Wird Schritt 04 abgeschaltet, bleibt das prospektive Gedächtnis als reine
  Benachrichtigung erhalten.

#### Phase C – Kausales Lernen

##### Schritt 05 – Kausales Outcome-Gedächtnis ([#406](https://github.com/n0mad-ai/bastra-recall/issues/406))

Recall unterscheidet entlang der Kette
`Erinnerung → Entscheidung → Auslösung → Handlung → Ergebnis` zwischen
Zusammenhang und belegtem Nutzen. Es lernt nicht nur, welche Erinnerung genutzt
wurde, sondern ob ihr Auftauchen zu diesem Zeitpunkt das Ergebnis verbessert hat.

Regeln:

- Ergebnisse werden unterschieden: Erfolg, Fehlschlag, vermiedener Verstoß,
  Korrektur, wirkungslos, teilweise, unbekannt.
- Ohne bekannte Auswahlwahrscheinlichkeit, Kontrollgruppe und Umgang mit
  fehlenden Beobachtungen gibt es keine kausale Aussage.
- Eine erfolgreiche Aufgabe nach dem Zeigen beweist nicht, dass die Erinnerung
  den Erfolg verursacht hat.
- Nicht gezeigt und Schweigen zählen als „nicht beobachtet“, nicht als
  negativ.
- Experimente schließen zerstörerische, datenschutzkritische und riskante
  Handlungen aus.
- Beschreibende, zusammenhängende und kausale Berichte bleiben sichtbar
  getrennt.
- Das Ergebnis sind Vorschläge für Zeitpunkt, Unterbrechung, Routing und
  Handlungsstufe – nie eine Änderung an Fakten, nie mehr Rechte.
- Eine gelernte Strategie muss die feste Regel schlagen, bevor sie in eine
  Testphase geht. Ein Rollback entfernt die Strategie, nicht die gesammelten
  Episoden.

##### Schritt 06 – Geprüfte Workflow- und Strategie-Synthese ([#407](https://github.com/n0mad-ai/bastra-recall/issues/407))

Wiederholt erfolgreiche Abläufe können einen Vorschlag für einen
wiederverwendbaren Workflow ergeben – nie eine ungeprüfte autonome Routine.

Ein Vorschlag enthält Ziel und Anwendungsbedingungen, die Schritte mit
Verzweigungen, erwartete Zwischenergebnisse, bekannte Fehlerbilder und
Abbruchregeln, benötigte Ressourcen und Berechtigungen, die Quell-Episoden,
getestete Umgebungen, ein Prüfdatum und eine Version mit Rollback-Ziel.

Regeln:

- Häufigkeit ist kein Erfolg; nur belegte erfolgreiche Episoden zählen, und
  eine einzelne reicht nie.
- Ein Workflow übernimmt keine Rechte aus seinen Quell-Episoden.
- Er wird im Sandkasten gegen einfachere Strategien und gegen „nichts tun“
  verglichen und muss messbar besser sein.
- Ein Mensch nimmt an, ändert, lehnt ab oder zieht zurück.
- Fehlt eine Vorbedingung, enthält sich der Workflow, statt zu improvisieren.
- Erzeugter ausführbarer Inhalt gilt bis zur Prüfung als nicht
  vertrauenswürdig.
- Ändern sich Umgebung, Abhängigkeiten oder Belege, wird neu geprüft.
- Zurückziehen löscht weder Belege noch frühere Versionen.

#### Phase D – Föderation und Koordination

##### Schritt 07 – Föderiertes persönliches, Projekt- und Team-Gedächtnis ([#408](https://github.com/n0mad-ai/bastra-recall/issues/408))

Mehrere Geräte und Personen können ausgewählte Erinnerungen teilen, ohne dass
der Vault zu „der letzte Schreiber gewinnt“ wird oder persönlicher Kontext
verloren geht.

Scopes: persönlich, Projekt/Workspace, Team und – nur wenn ausdrücklich
aktiviert – Organisation/öffentlich. Teilen ist ausdrücklich und ergänzend: Eine
persönliche und eine Team-Aussage dürfen nebeneinander stehen und sichtbar
widersprechen.

Regeln:

- Geteilte Inhalte haben eine inhaltsbasierte Identität und Version.
- Offline zuerst: Ein Journal und ein deterministisches Abgleichverfahren
  führen Änderungen zusammen. Kein Zusammenführen allein nach Zeitstempel.
- Geteilte Scopes sind unterwegs und gespeichert verschlüsselt, mit
  Schlüsselwechsel und Widerruf. Widerrufene Geräte erhalten nichts Neues.
- Konflikte werden zu eigenen Objekten mit geprüftem Zusammenführen.
- Löschungen verbreiten sich, ohne nötige Historie zu zerstören und ohne
  Daten wiederauferstehen zu lassen.
- Metadaten verraten nicht, dass eine geschützte Erinnerung existiert.
- Offline-Änderungen bleiben ihrem Gerät und ihrer Person zugeordnet.
- Team-Konsens überschreibt nie persönliches Gedächtnis.
- Ein Sync-Fehler ist sichtbar und wird nie als „aktuell“ gemeldet.
- Die Zusammenführungsregeln stehen fest, bevor Transport und Speicher gewählt
  werden; ein Wechsel des Backends ändert sie nicht.
- Die Föderation lässt sich abkoppeln und hinterlässt einen konsistenten
  lokalen Vault.

Bestehende Arbeit zu Import und Geräte-Sync
([#299](https://github.com/n0mad-ai/bastra-recall/issues/299),
[#339](https://github.com/n0mad-ai/bastra-recall/issues/339),
[#341](https://github.com/n0mad-ai/bastra-recall/issues/341)) bleibt in ihrem
eigenen Milestone; Schritt 07 nutzt ihre Ergebnisse, ohne sie zu doppeln.

##### Schritt 08 – Multi-Agent-Koordination ([#409](https://github.com/n0mad-ai/bastra-recall/issues/409))

Mehrere Assistenten können geteiltes Gedächtnis beobachten und nutzen, ohne
Echo-Verstärkung, doppelte Arbeit, versteckte Zuständigkeit oder Wahrheit per
Mehrheit.

Regeln:

- Jede Beobachtung, jeder Vorschlag und jede Handlung trägt die Identität des
  Agenten und ihre Herkunft.
- Ereignisse werden über Agenten und Geräte hinweg dedupliziert, Schleifen
  erkannt.
- Offene Zusagen und vorbereitete Handlungen haben eine Zuständigkeit auf Zeit
  (Lease). Sie regelt die Arbeit, versteckt die Zusage aber nicht vor anderen.
- Geteilte Wissenszustände: `asserted | confirmed | contested | superseded | unknown`.
- Zustimmung mehrerer Agenten mit derselben Quelle ist kein unabhängiger Beleg;
  wiederholtes Zitieren derselben Quelle zählt einmal.
- Mehrheit begründet keine Wahrheit.
- Ein Agent kann nicht die Berechtigung eines anderen verbrauchen.
- Echos erhöhen weder Vertrauen, Gewicht, Rang noch gelernten Nutzen.
- Ungelöste Konflikte bleiben für alle Berechtigten sichtbar.
- Übergaben erhalten Belege, Zustand, Berechtigungen und Rollback-Ziel.
- Vor jeder gemeinsamen Ausführung läuft die Koordination zuerst als nur
  lesende Simulation. Sie lässt sich abschalten, das geteilte Gedächtnis bleibt
  lesbar.

#### Phase E – Freigabe

##### Schritt 09 – Freigabe-Gate, Sicherheit und Rollback-Nachweis ([#410](https://github.com/n0mad-ai/bastra-recall/issues/410))

V3.0 wird erst veröffentlicht, wenn Vorausschau, berechtigte Handlungen,
kausales Lernen, Workflow-Synthese, Föderation und Koordination als ein sicheres
Produkt zusammen funktionieren.

Nachweise:

- durchgängige Tests für lokal, nächste Sitzung, Hintergrund (freigegeben) und
  föderiert,
- Neuinstallation, Migration von V2, Offline-Update, Downgrade,
  Schlüsselwiderruf und vollständiger Rollback,
- Chaos-Tests für verlorene Weckrufe, doppelte Handlungen, verspätete
  Ergebnisse, Netztrennung, Zusammenführungskonflikte und Echo-Schleifen,
- Angriffstests auf Berechtigungen und eine Prüfung der Connector-Sandbox,
- Datenschutztests über Inhalte, Metadaten, Event-Journale, kausale Episoden
  und geteilte Berichte,
- Nutzertests zu Unterbrechungslast, Verständlichkeit von Freigaben,
  Konfliktprüfung und Wiederherstellung.

Checkliste für die Freigabe:

- V2.0 bleibt stabil und ist die getestete Rückfallebene.
- Fällige Zusagen gehen weder still verloren noch werden sie doppelt ausgelöst.
- Falsche und verpasste Auslösungen liegen innerhalb der festgelegten Schwellen.
- Vorhersagen, Absichten, Fakten und Handlungen bleiben getrennt.
- Externe Wirkungen verlangen und respektieren ausdrückliche Berechtigungen.
- Null Berechtigungsverstöße und null Lecks über Scope-Grenzen.
- Kausale Aussagen erfüllen die methodischen Anforderungen.
- Gelernte Workflows schlagen ihre Vergleichsstrategie und können keine Rechte
  erlangen.
- Sync verliert nichts still und hält Konflikte sichtbar.
- Geteilter Konsens kann persönliches Gedächtnis nicht überschreiben.
- Echos zwischen Agenten verstärken weder Belege noch Nutzen.
- Jede Handlung, jede Zusammenführung, jeder Workflow und jede gelernte
  Strategie ist erklärbar und zurücksetzbar.
- Ein globaler Notschalter führt ohne Datenverlust zurück auf lokales V2.

Optionale Komponenten, die ihre Schwelle nicht bestehen, bleiben aus. Eine
unbewiesene Pflicht-Eigenschaft hält V3.0 offen. Zeitdruck hebt keine Schwelle zu
Berechtigungen, Datenschutz, Kausalität, Sync-Integrität oder Rollback auf.

### 7. Offene Designfragen

Diese Punkte stammen aus einem externen, kritischen Review des Plans vom
28.08.2026 und hängen als Kommentare an den jeweiligen Issues. Sie sind noch
nicht entschieden.

- **Wessen Freigabe gilt bei mehreren Eigentümern?**
  ([#450](https://github.com/n0mad-ai/bastra-recall/issues/450)) Schritt 04
  geht von genau einer freigebenden Person aus. Betrifft eine Handlung
  persönliches Gedächtnis und Team-Gedächtnis zugleich, ist offen, ob jede
  betroffene Partei zustimmen muss, ob ein festgelegtes Quorum reicht und ob
  eine teilweise Ausführung erlaubt ist. Vorschlag: Die Freigabe wird zu einer
  Menge (eine je betroffenem Bereich), ausgeführt wird nur, wenn alle nötigen
  Freigaben oder ein ausdrücklich festgelegtes Quorum vorliegen. Das muss vor
  der Föderation entschieden werden.
- **Veraltete Freigaben** ([#405](https://github.com/n0mad-ai/bastra-recall/issues/405))
  Eine Berechtigung läuft nach Zeit ab oder wird widerrufen, aber nicht, wenn
  sich der freigegebene Inhalt bis zur Ausführung ändert. Vorschlag: Die
  Berechtigung bindet den Zustand, gegen den freigegeben wurde; bei der
  Ausführung wird erneut geprüft, und „veraltet“ wird ein eigenes Ergebnis
  neben „abgelaufen“ und „widerrufen“. Offen ist außerdem die Begründung, warum
  der Freigebende nicht der Vorschlagende sein darf.
- **Reihenfolge der kausalen Methoden**
  ([#406](https://github.com/n0mad-ai/bastra-recall/issues/406)) Vorschlag:
  zuerst die vorhandene Schwelle im Recall-Score als natürliches Experiment
  nutzen, danach eine zufällige Grauzone über den Canary-Mechanismus aus V2
  statt eigener Experimentiertechnik; die kleinste nachweisbare Wirkung vorab
  festlegen.

### 8. Übergreifende Kennzahlen

Jeder Schritt berichtet die zu ihm passenden Werte:

- Genauigkeit und Vollständigkeit hilfreicher Auslösungen, Anteil verpasster
  Auslösungen,
- Kosten von Unterbrechungen und Erledigungsquote von Zusagen,
- verweigerte oder verletzte Berechtigungen und doppelte Handlungen,
- Wirkung von Eingriffen mit Unsicherheit und fehlenden Beobachtungen,
- Übernahme, Erfolg, Enthaltung und Rollback von Workflows,
- Sync-Konflikte, stiller Verlust, Wiederherstellung und Konvergenz,
- Lecks über Scope- und Sensitivitätsgrenzen,
- Genauigkeit von Herkunft und Zuordnung,
- Echo-Verstärkung, doppelte Arbeit und Lease-Wiederherstellung bei mehreren
  Agenten,
- Latenz, Ressourcenverbrauch und Verhalten ohne Netz oder im
  eingeschränkten Betrieb.
