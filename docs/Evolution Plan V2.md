# Bastra Recall — Unified V2 evolution plan / Gemeinsamer V2-Evolutionsplan

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

**Owner decision: 2026-10-04, C-095.** This is the shared roadmap for the former
V2 and V3 scopes. It describes planned work, not shipped capabilities. The
[technical architecture](./Evolution%20Architecture%20V1%20to%20V2.md), especially
sections 42–44, preserves the detailed contracts. German is the governing version.

### One roadmap, three kinds of work

- **Build:** [milestone #19](https://github.com/n0mad-ai/bastra-recall/milestone/19),
  tracker [#386](https://github.com/n0mad-ai/bastra-recall/issues/386).
- **Measure and confirm:** [milestone #30](https://github.com/n0mad-ai/bastra-recall/milestone/30).
  Windows, experiments and evidence run alongside development. They never block
  unrelated implementation or beta delivery. Split mixed issues into code and evidence.
- **Experiment separately:** [milestone #29](https://github.com/n0mad-ai/bastra-recall/milestone/29)
  owns all code-awareness/Graphify work, including its measurements. It is outside
  the version roadmap and is never a beta or stable V2 requirement.

The former V3 milestone #25 and tracker #401 are superseded, not completed products.
V3 functions do not require a fully measured or released V2 first.

### Beta and stable releases

Incremental releases with outstanding confirmations use `2.0.0-beta.N`. Their
release notes identify enabled features, opt-in/shadow modes, pending/failed/not-evaluable
evidence, known limitations and rollback. Beta may include safe, explicitly opted-in
feature trials before longitudinal proof; it never silently promotes an unconfirmed
learned policy to the normal default or claims proven benefit.

Functional tests, safe migration, data integrity, permission/privacy boundaries and
rollback are required for the affected beta feature. Models cannot fabricate events,
permissions or confirmed facts. External execution stays explicitly permissioned.
A time window is not a substitute for these checks.

Stable `2.0.0` is approved only through [#400](https://github.com/n0mad-ai/bastra-recall/issues/400):
all mandatory functions are implemented and confirmed against registered criteria,
with end-to-end, migration/recovery and security evidence. At least two documented
adversarial review rounds must cover the combined system, with follow-up review
of changes and traceable resolution of every release finding. These reviews are
required future work; this roadmap change does not claim they have happened.

Pending, failed and insufficient evidence keeps stable V2 open; beta development
continues. Optional HNSW can remain off with confirmed Flat fallback. Mandatory
functions cannot be silently made optional to declare stable V2 complete.

### Workstreams and real dependencies

| Area | Implementation | Technical prerequisites / evidence |
|---|---|---|
| Usage and safe evolution | #388 outcomes, #589 explicit feedback, #389 proposals/replay, #390 review/canary/rollback, #656 feature inventory | #387 baseline collection runs in parallel; instrumentation precedes meaningful learning |
| Proactive tasks and reminders — first product priority | #250/#403 commitments, #404 time/events and recovery, #405 notify/prepare/execute | persist commitment before trigger; notify before external execution; #402 evidence runs in parallel |
| Adaptive recall | #391 routing/cues, #392 accessibility/active-time forgetting, #393 Deep Recall, #399 ranking | candidate retrieval before deeper search; outcome data for learning; feature controls before beta activation |
| Memory structure | #394 roles/claims/time/provenance, #395 graph/version views, #396 consolidation | schema/provenance before graph mutation; reviewed reversible proposals before consolidation |
| Representation and scale | #397 cue/content/chunking decision, #398 backend interface/switch/fallback | representation before backend comparison; empirical runs in #1058 separated from implementation |
| Causal learning and workflows | #406 causal outcomes, #407 reviewed workflows | observed interventions with attributable outcomes before causal claims; successful evidence before learned workflow approval |
| Federation and coordination | #408 sharing, #409 multi-agent coordination, #450 owner approval | identity/version/provenance and deterministic conflict handling; federation before shared execution; read-only simulation first |
| Freshness and routines | #475 source freshness; #256 reviewed local routine/patch persistence | explicit source age/failure outcomes; routines inherit no automatic permissions |
| Stable V2 | #400 shared release approval | all mandatory workstreams confirmed; #410 cross-system validation and multiple adversarial reviews |

No measurement issue or final release approval is a blanket prerequisite for starting
a workstream. Baselines must be recorded before interpreting a comparison, not before
writing a new feature. Feature-specific security and integrity dependencies remain.

### Product-flow additions — C-096, 2026-10-10

The missing parts of five product ideas attach to existing workstreams; there is
no second graph, trigger engine or learning pipeline. Detailed contracts and
acceptance controls are in architecture §44. These are planned, not shipped.

- **Decision assumptions and reconsideration:** #394 represents evidenced reasons,
  alternatives and load-bearing assumption claims; #395 links their versions.
  Explicit #403 commitments and #404 predicates monitor authorized fresh sources
  (#475). A changed premise surfaces a review with old/new evidence, not an
  automatic reversal. Keep/change/snooze/stop and deduplicated recovery use existing
  lifecycle, delivery and #389/#390 review.
- **Approach checks before action:** #391 reuses the bounded hook/cue cascade to
  match an available proposed approach against evidenced failures. #1119 owns the
  action-time delivery decision. Conditions and counterexamples matter, not words.
- **Recurrence after correction:** #388/#589 trace correction → relevant opportunity
  → retrieval → actual delivery → application → outcome; #406 distinguishes where
  repetition arose. No later opportunity or missing outcome is not success.
- **Evidenced cross-project insights:** #396 extends consolidation with reviewable
  patterns, sources, differences and counterexamples; #391/#459/#393 discover and
  inspect candidates. Durable lessons/links still use existing reviewed operators.
- **Current vs historical knowledge:** reuse existing version/conflict/write-origin
  mechanisms; complete bitemporal/provenance work stays #394/#395/#359. Memory
  expiry is not world validity. No duplicate feature is created.

#387 registers controls/costs, #402 reconsideration triggers/delivery, #598 review
comprehension and #410 end-to-end confirmation, all in #30. #400 includes this
feature/evidence mapping in stable V2 approval; C-095 beta/parallel-measurement rules
remain. Graphify and its specific compliance study #666 remain experimental in #29.

### First slice: measurement follow-ups

Create a project task with source, owner, start/due timestamp, timezone, resolution
condition and state. Deliver it when due at session start and the next suitable hook
in a running session, independently of semantic search. Delivery, acknowledgement and
completion are separate; offline time, restart and retries lose no pending task.

For a seven-day measurement window, the reminder says **“evaluate the gate”**, not
**“gate passed”**. Insufficient observations remain inconclusive. Persist deadlines;
do not rely on a seven-day in-memory timer. Background agent wakeup is a separately
opted-in client capability; next-session delivery is the initial cross-client baseline.

### Measurement operation

Each run records the feature/profile and code/configuration versions, the registered
question, corpus/sample plan, observation window, criteria, evidence and verdict.
Useful states distinguish pending, running, passed, failed and not evaluable. A release
during a window is allowed: retain the old artifacts and segment or restart the affected
run. Never mix changed treatments or call elapsed time proof of sufficient evidence.

Implementation #458 (context budget) and #163 (excerpt mode) remains in #19;
confirmation runs #1059 and #1060 belong to #30. #398 owns backend implementation,
with scale/backend confirmation in #1058.

Measurements confirm the affected feature and feed #400. Security, permission,
provenance and no-data-loss invariants apply continuously, including in beta.

<a id="deutsch"></a>

## Deutsch

**Product-Owner-Entscheidung: 04.10.2026, C-095.** Dies ist die gemeinsame Roadmap
für die bisherigen V2- und V3-Umfänge. Sie beschreibt geplante Arbeit, keine bereits
ausgelieferten Fähigkeiten. Die [technische Architektur](./Evolutionsarchitektur%20V1%20zu%20V2.md),
insbesondere Abschnitte 42–44, erhält die detaillierten Verträge. Deutsch ist maßgeblich.

### Eine Roadmap, drei Arten von Arbeit

- **Bauen:** [Milestone #19](https://github.com/n0mad-ai/bastra-recall/milestone/19),
  Tracker [#386](https://github.com/n0mad-ai/bastra-recall/issues/386).
- **Messen und bestätigen:** [Milestone #30](https://github.com/n0mad-ai/bastra-recall/milestone/30).
  Zeitfenster, Experimente und Nachweise laufen parallel zur Entwicklung. Sie blockieren
  keine andere Implementierung oder Beta-Auslieferung. Gemischte Issues werden in
  Code und Nachweis getrennt.
- **Separat experimentieren:** [Milestone #29](https://github.com/n0mad-ai/bastra-recall/milestone/29)
  enthält sämtliche Code-Awareness-/Graphify-Arbeit einschließlich ihrer Messungen.
  Sie liegt außerhalb der Versionsroadmap und ist kein Beta- oder stabiles V2-Kriterium.

Der frühere V3-Milestone #25 und Tracker #401 sind abgelöst; das bedeutet keine
Produktfertigstellung. Bisherige V3-Funktionen benötigen vorher keinen vollständig
vermessenen oder freigegebenen V2-Release.

### Beta und stabile Releases

Zwischenreleases mit offenen Funktionsbestätigungen heißen `2.0.0-beta.N`.
Ihre Releasehinweise nennen aktive Funktionen, Opt-in-/Shadow-Modi, offene,
gescheiterte oder nicht auswertbare Nachweise, Einschränkungen und Rollback.
Beta darf sichere, ausdrücklich aktivierte Funktionsversuche vor einem Langzeitnachweis
enthalten; ein unbestätigtes Lernverfahren wird dadurch weder still zum normalen
Standard noch als nachweislich nützlich bezeichnet.

Funktionsprüfungen, sichere Migration, Datenintegrität, Berechtigungs-/Privacy-Grenzen
und Rollback sind für die jeweilige Beta-Funktion erforderlich. Modelle dürfen keine
Ereignisse, Berechtigungen oder bestätigten Fakten erfinden. Externe Ausführung bleibt
ausdrücklich berechtigungsgebunden. Ein Zeitfenster ersetzt diese Prüfungen nicht.

Die stabile `2.0.0` wird ausschließlich über [#400](https://github.com/n0mad-ai/bastra-recall/issues/400)
freigegeben: Alle Pflichtfunktionen sind umgesetzt und nach registrierten Kriterien
bestätigt; Ende-zu-Ende-, Migrations-/Recovery- und Sicherheitsnachweise liegen vor.
Mindestens zwei dokumentierte adversarielle Reviewrunden müssen das Gesamtsystem
abdecken, einschließlich Nachprüfung nach Änderungen und nachvollziehbarer Auflösung
aller Freigabebefunde. Diese Reviews sind zukünftige Pflichtarbeit; der Roadmap-Neuschnitt
behauptet nicht, dass sie bereits stattgefunden haben.

Offene, gescheiterte oder unzureichende Nachweise halten die stabile V2 offen;
Beta-Entwicklung geht weiter. Optionales HNSW darf mit bestätigtem Flat-Fallback
ausgeschaltet bleiben. Pflichtfunktionen werden nicht still optional gemacht,
um die stabile V2 für fertig zu erklären.

### Arbeitsbereiche und echte Abhängigkeiten

| Bereich | Implementierung | Technische Voraussetzungen / Nachweise |
|---|---|---|
| Nutzung und sichere Evolution | #388 Outcomes, #589 ausdrückliches Feedback, #389 Vorschläge/Replay, #390 Review/Canary/Rollback, #656 Funktionsinventar | #387-Baseline parallel; Instrumentierung vor aussagekräftigem Lernen |
| Proaktive Aufgaben und Erinnerungen — erste Produktpriorität | #250/#403 Zusagen, #404 Zeit/Events und Recovery, #405 notify/prepare/execute | Aufgabe vor Trigger persistieren; Hinweis vor externer Ausführung; #402-Nachweise parallel |
| Adaptiver Recall | #391 Routing/Cues, #392 Accessibility/aktives Vergessen, #393 Deep Recall, #399 Ranking | Kandidatensuche vor tiefer Suche; Nutzungsdaten für Lernen; Funktionskontrollen vor Beta-Aktivierung |
| Gedächtnisstruktur | #394 Rollen/Claims/Zeit/Herkunft, #395 Graph/Versionen, #396 Konsolidierung | Schema/Herkunft vor Graphänderungen; reviewte reversible Vorschläge vor Konsolidierung |
| Repräsentation und Skalierung | #397 Cue-/Content-/Chunking-Entscheid, #398 Backend-Schnittstelle/Wechsel/Fallback | Repräsentation vor Backendvergleich; Messläufe in #1058 getrennt von Implementierung |
| Kausales Lernen und Workflows | #406 kausale Outcomes, #407 reviewte Workflows | beobachtete Eingriffe mit zuordenbaren Outcomes vor Kausalaussagen; erfolgreiche Evidenz vor Workflow-Freigabe |
| Federation und Koordination | #408 Teilen, #409 Multi-Agent-Koordination, #450 Eigentümerfreigabe | Identität/Version/Herkunft und deterministische Konfliktbehandlung; Federation vor geteilter Ausführung; zuerst read-only Simulation |
| Aktualität und Routinen | #475 Quellenaktualität; #256 reviewte lokale Routinen-/Patchpersistenz | explizites Quellenalter und Fehlerzustände; Routinen erben keine automatischen Rechte |
| Stabile V2 | #400 gemeinsame Freigabe | alle Pflichtbereiche bestätigt; #410 Gesamtsystemvalidierung und mehrere adversarielle Reviews |

Kein Messissue und keine finale Releasefreigabe ist eine pauschale Voraussetzung,
um einen Arbeitsbereich anzufangen. Baselines werden vor der Interpretation eines
Vergleichs erfasst, nicht vor dem Schreiben einer neuen Funktion. Funktionsbezogene
Sicherheits- und Integritätsabhängigkeiten bleiben bestehen.

### Ergänzte Produktabläufe — C-096, 10.10.2026

Die fehlenden Teile der fünf Produktideen docken an vorhandene Arbeitsbereiche an;
kein zweiter Graph, keine zweite Trigger-Engine oder Lernpipeline. Detailverträge
und Abnahme-Kontrollfälle stehen in Architektur §44. Geplant, nicht ausgeliefert.

- **Entscheidungsannahmen und Neubewertung:** #394 erfasst belegte Gründe,
  Alternativen und tragende Annahmen als Claims; #395 verknüpft ihre Versionen.
  Ausdrückliche Zusagen #403 und Prädikate #404 überwachen autorisierte frische
  Quellen (#475). Eine geänderte Voraussetzung legt einen Review mit altem/neuem
  Beleg vor, keine automatische Umkehr. Beibehalten/ändern/zurückstellen/beenden
  und deduplizierte Wiederaufnahme nutzen Lebenszyklus, Zustellung und #389/#390.
- **Vorgehensprüfung vor einer Handlung:** #391 nutzt die begrenzte Hook-/Cue-Kaskade
  für ein verfügbares Vorgehen und belegte Fehlschläge. #1119 besitzt die Entscheidung
  zur Aktionszustellung. Bedingungen und Gegenbeispiele zählen, nicht gleiche Wörter.
- **Wiederholung nach einer Korrektur:** #388/#589 verbinden Korrektur → relevante
  Gelegenheit → Retrieval → tatsächliche Zustellung → Anwendung → Ergebnis;
  #406 unterscheidet die Fehlerstelle. Keine Gelegenheit/Beobachtung ist kein Erfolg.
- **Belegte projektübergreifende Einsichten:** #396 erweitert Konsolidierung um
  reviewbare Muster, Quellen, Unterschiede und Gegenbeispiele; #391/#459/#393 finden
  und prüfen Kandidaten. Dauerhafte Lessons/Links nutzen die reviewten Operatoren.
- **Aktuelles und historisches Wissen:** vorhandene Versions-/Konflikt-/
  Schreibherkunftsmechanismen wiederverwenden; bi-temporaler Ausbau und Provenienz
  bleiben #394/#395/#359. Memory-Ablauf ist keine Weltgültigkeit. Kein Doppelprojekt.

#387 registriert Kontrollen/Kosten, #402 Neubewertungstrigger/Zustellung, #598
Review-Verständlichkeit und #410 Ende-zu-Ende-Bestätigung, alle in #30. #400 nimmt
Funktions-/Evidenzzuordnung in die stabile V2-Abnahme auf; C-095s Beta-/Parallelregeln
bleiben. Graphify und seine Befolgungsstudie #666 bleiben experimentell in #29.

### Erster Funktionsschnitt: Messauswertungen wieder vorlegen

Eine Projektaufgabe erhält Quelle, Owner, Start-/Fälligkeitszeit, Zeitzone,
Erledigungsbedingung und Status. Fällige Aufgaben erscheinen beim Sessionstart
und am nächsten geeigneten Hook einer laufenden Sitzung, unabhängig von der
semantischen Suche. Zustellung, Empfangsbestätigung und Erledigung sind getrennt;
Offline-Zeit, Neustart und Wiederholungen verlieren keine offene Aufgabe.

Bei einem siebentägigen Messfenster heißt die Erinnerung **„Gate auswerten“**,
nicht **„Gate bestanden“**. Zu wenige Beobachtungen bleiben nicht auswertbar.
Fristen werden persistiert; ein siebentägiger Timer im Arbeitsspeicher reicht nicht.
Ein ruhender Agent wird nur über eine separat aktivierte Clientfähigkeit geweckt;
Vorlage beim nächsten Kontakt ist zunächst die gemeinsame Client-Basis.

### Betrieb der Messungen

Jeder Lauf nennt Funktion/Profil, Code-/Konfigurationsversionen, registrierte Frage,
Korpus-/Stichprobenplan, Beobachtungsfenster, Kriterien, Evidenz und Urteil.
Offen, laufend, bestanden, gescheitert und nicht auswertbar bleiben unterscheidbar.
Ein Release während eines Fensters ist erlaubt: alte Artefakte erhalten und betroffene
Läufe segmentieren oder neu starten. Geänderte Versuchsbedingungen werden nicht
vermischt; abgelaufene Zeit beweist keine ausreichende Datenlage.

Implementierung #458 (Kontextbudget) und #163 (Ausschnittmodus) bleibt in #19;
die Nachweise #1059 und #1060 liegen in #30. #398 enthält den Backend-Bau,
#1058 den Skalierungs-/Backendvergleich.

Messungen bestätigen die jeweilige Funktion und fließen in #400 ein. Sicherheits-,
Berechtigungs-, Herkunfts- und Datenerhaltungsregeln gelten durchgehend, auch in Beta.
