# Bastra Recall – Evolutionsarchitektur V1 → V2

> Status: Release- und Zielarchitektur; V1.0 ist der nächste verbindliche
> Releasevertrag, V2.0 das langfristige, messungsabhängige Zielbild
>
> Stand: 29. August 2026 (Vertragsänderung C-083, Vertragsergänzungen C-084
> und C-085, Präzisierung C-086; abgenommene Basis vom 26. Juli 2026 im
> Übrigen unverändert)
>
> Ausgangsstand: Bastra Recall 0.8.6, aktueller Vault, reale
> 30-Tage-Telemetrie und bestehende Eval-Geometrie
>
> **Diese Datei ist die maßgebliche Fassung.** Verbindlicher Ledgerstand:
> C-001–C-086, elf Reviewrunden, eine Vertragsänderung, zwei
> Vertragsergänzungen und eine Präzisierung; C-001–C-082 am 26. Juli 2026
> abgenommen, C-083 bis C-086 am 29. August 2026 entschieden.
>
> Entstehung: abgenommener Ausgangsstand C-001–C-028, fortgeschrieben durch die
> Revisionen C-029–C-039, C-040–C-048, C-049–C-054, C-055–C-059, C-060–C-062,
> C-063–C-067, C-068–C-073, C-074–C-077, C-078–C-079, C-080–C-081 und C-082
> sowie durch die Vertragsänderung C-083, die Vertragsergänzungen C-084 und
> C-085 und die Präzisierung C-086.
> Alle zwölf Zwischenfassungen und der Ausgangsstand liegen unverändert unter
> `docs/architecture-history/`; sie sind Belegmaterial, keine geltenden
> Verträge.
>
> **Sprachfassungen.** Diese deutsche Fassung ist der geprüfte Original- und
> Vertragstext. `docs/Evolution Architecture V1 to V2.md` ist eine Übersetzung
> davon; sie dient der Lesbarkeit, nicht der Auslegung. Weichen die Fassungen
> voneinander ab, gilt die deutsche. Jede Änderung wird zuerst hier vorgenommen
> und danach übersetzt, nie umgekehrt. Die frühere englische Fassung im Stand
> C-001–C-028 liegt im Archiv und ist überholt.
>
> Jede Passage ist über das Ledger in 0.4 und das Delta-Ledger in Abschnitt 28
> auf genau eine C-ID zurückführbar. Kein Eintrag deutet ein früheres Urteil um;
> wo ein neuer Eintrag einen älteren korrigiert, steht das als Korrekturverweis
> am älteren Eintrag.
>
> Die Product-Owner-Entscheidungen in Abschnitt 31 sind getroffen und binden
> die Umsetzung.
>
> Nächste freie ID: C-087. Ein neues Delta wird in dieser Datei fortgeschrieben
> und nicht mehr als eigene Revisionsdatei geführt.

## 0. Entscheidungs- und Reviewstatus

Dieses Dokument trennt fünf Ebenen:

1. **verifizierter Ist-Stand** – direkt durch Code, Telemetrie oder einen
   reproduzierbaren Run belegt;
2. **V1.0-Releasevertrag** – die kleinste Arbeit, die eine belastbare Mess-,
   Entscheidungs- und Kontrollbasis herstellt;
3. **V1.x-Evolution** – einzeln gegatete, rückwärtskompatible Schritte auf
   Basis realer Messungen;
4. **V2.0-Zielbild** – die gemeinsame Promotion der während V1.x bewiesenen
   Gedächtnisfunktionen;
5. **Hypothese** – darf jederzeit gemessen oder im Shadow untersucht werden,
   wird aber erst nach dem vorher definierten Gate zu Schema-, Vertrags- oder
   Live-Arbeit.

### 0.1 V1.0 – Mess- und Kontrollbasis

Der aktuelle Stand 0.8.6 erfüllt V1 noch nicht vollständig. V1.0 ist erreicht,
wenn ausschließlich folgende Grundlagen umgesetzt und nachgewiesen sind:

1. Messwahrheit und reproduzierbare Baselines herstellen;
2. einen deterministischen, erklärbaren Abstention- und Relevanzentscheid aus
   bereits vorhandenen Signalen bauen;
3. den vorhandenen Session-Context-Pfad zu einem gemeinsamen, projektfähigen
   und parallelen Server-Assembler weiterentwickeln;
4. ein globales Kontextbudget einführen und Retrievalqualität getrennt von
   Hook-Formulierung beziehungsweise Consumer-Verhalten messen.

V1.0 enthält keine neuen Memory-Typen, Claims, Graph-Kantentypen,
Dual-Vektoren, Chunking-, HNSW- oder Learned-Ranking-Live-Schicht.

### 0.2 Releaseleiter

| Release | Funktion | Freigabelogik |
|---|---|---|
| 0.8.6 | heutiger Vor-V1-Ist-Stand | Diagnosegrundlage, kein abgeschlossener V1-Vertrag |
| V1.0 | beobachtbare und selektive Mess-/Kontrollbasis | Abschnitt 0.1 und Definition of Done 26.1 vollständig erfüllt |
| V1.x | schrittweise Evolution | jeder Baustein einzeln durch das jeweils benannte Messgate freigegeben und rückwärtskompatibel ausgeliefert |
| V2.0 | vollständiges adaptives Gedächtnissystem | alle verpflichtenden V2-Eigenschaften aus 26.2 gemeinsam nachgewiesen |

Messung, Shadow-Betrieb und read-only Projektionen sind jederzeit zulässig.
Messgates gaten ausschließlich Schema-/Vertragsänderungen und
Live-Aktivierung. Ausnahme sind Qualitätsvergleiche, deren Interpretation die
M0-Baseline voraussetzt.

Accessibility/Asteroidengürtel, Deep Recall, Episodic Memory, Claims, Typed
Graph, Konsolidierung, Dual-Vektoren, HNSW und Learned Ranking bleiben als
V2-Zielbild im Dokument. Während V1.x dürfen nur die Bausteine dauerhaft in
Produktverhalten, Schema oder Verträgen umgesetzt beziehungsweise live
aktiviert werden, deren benanntes Messgate den Bedarf und die Sicherheit
belegt. Vorher bleiben sie auf Messung, Shadow, read-only oder isolierte
Experimente begrenzt.

V2.0 ist keine Sammelfreigabe für vorab gebaute Komponenten. Es ist die
Beförderung der während V1.x einzeln bewiesenen Teile zu einem stabilen
Gesamtsystem.

### 0.3 Reviewdisziplin

Gegenprüfungen unterscheiden strikt zwischen falschem Ist-Stand, Messproblem,
Architekturentscheidung und zukünftiger Hypothese. Jeder Einwand erhält eine
stabile ID, konkrete Passage, Urteil, Datei-/Zeilenevidenz oder reproduzierbaren
Befehl sowie eine minimale Korrektur. Bereits geklärte Punkte werden nur mit
neuer Evidenz erneut geöffnet.

### 0.4 Abgenommenes Review-Ledger

| ID | Urteil | Verbindliche Konsequenz im Dokument |
|---|---|---|
| C-001 | bestätigt | BM25-Rohscore und skalierter RRF dürfen keine gemeinsamen absoluten 30/100-Bänder mehr als Relevanzversprechen verwenden. |
| C-002 | bestätigt | **Präzisiert durch C-086:** Die Required-Bedingungen des Evidenzentscheids sind enger gefasst — Teilabdeckung zählt erst ab 50 %, der harte Identifier-Anker liest den Body nicht mehr. Das heutige `weak_result` ist nur ein informatives MCP-Signal und kein Hook-Gate; V1.0 führt einen echten Evidenzentscheid mit Abstention ein. |
| C-003 | korrigiert | Der produktive Candidate Pool ist `max(k × 4, 20)`, nicht überall 20; für Out-of-pool-Evals wird er explizit auf 100/200 erweitert. |
| C-004 | korrigiert | `GET /hook/session-context` existiert, ist aber projektlos und intern seriell; er wird erweitert, nicht unverändert als Ersatz für SessionStart eingesetzt. |
| C-005 | korrigiert | Bridges sind opt-in und ohne Pool ein No-op; auf dieser Instanz waren zwei Bridges aktiv und erweiterten in der Messperiode 853 Queries. Diese Feuerrate belegt Aktivität, nicht Nutzen oder Qualitätslift. |
| C-006 | bestätigt | `acted_on` ist ein Token-Overlap-Proxy und kein Goldlabel; V1.0 behauptet deshalb keine `relevance_probability`. |
| C-007 | qualifiziert | HNSW ist beim heutigen Vault nicht begründet, bleibt aber als ausdrücklich gegatete spätere Auto-Switch-Strategie spezifiziert. |
| C-008 | bestätigt | Vollständiges Mutation-Audit besteht heute nur im Mac-App-Bridge-Pfad; reguläre MCP-/HTTP-Saves sind davon nicht umfasst. |
| C-009 | bestätigt | Load-/Use-Quoten vermischen Retrieval, Hook-Formulierung, Consumer-Verhalten und Telemetrie-Zuordnung; V1.0 trennt diese Effekte experimentell. |
| C-010 | bestätigt | Die Ad-hoc-Baseline besitzt noch kein versioniertes Run-Artefakt und wird erst nach M0 zur offiziellen Baseline. |
| C-011 | bestätigt | Salience wirkt live auf die Staleness-Lebensdauer; direkter Rankingeinfluss bleibt standardmäßig Shadow-only. |
| C-012 | bestätigt | Die Produktions-Telemetrie weist für den BM25-Schritt p50 1 ms, p95 11 ms und p99 25 ms aus; die abweichende Ad-hoc-Zeile wird separat und als nicht archiviert gekennzeichnet. |
| C-013 | bestätigt | Accessibility und Typed Graph Evidence sind keine V1.0-Evidenzsignale; §10.2 trennt verfügbare V1-Signale von späteren V2-Signalen. |
| C-014 | bestätigt | Context-ROI ist eine System-Erfolgsmetrik und kein Live-Schaltgate des Evidenzentscheids; dessen Aktivierung hängt nur an retrieval-isolierten Gates. |
| C-015 | bestätigt | Die 45,2-%-Messung besitzt keine archivierte unabhängige Provenienz und wird als Ad-hoc-Paraphrasenmessung bezeichnet. |
| C-016 | bestätigt | Das absolute Recall@3-Ziel ist kein Schaltgate des klassifizierenden Evidenzentscheids; dieser muss den Recall gegenüber dem ungegateten Arm erhalten, während die absolute Coverage ab V1.0 als Systemziel beobachtet wird. |
| C-017 | bestätigt | Typed Graph, Versionen und Rekonsolidierung benötigen nach M4-Vorbereitung zusätzlich einen gesonderten Schemaentscheid; §25 benennt dieses Gate ausdrücklich. |
| C-018 | Product-Owner-Vorgabe | Messung, Shadow-Betrieb und read-only Projektionen bleiben jederzeit zulässig; Messgates beschränken Schema-/Vertragsänderungen und Live-Aktivierung, mit M0-Vorbehalt nur für interpretierte Qualitätsvergleiche. |
| C-019 | bestätigt | `acted_on` und die daraus berechneten Tokenkosten werden durchgängig als Token-Overlap-Proxy bezeichnet, nicht als nachweisliche Nutzung. |
| C-020 | bestätigt | V1.0-Telemetrie erhält `client`, `hook_source` und eine pseudonyme Session-Dimension, damit die beschlossenen Auswertungen und Experimentarme ausführbar sind. |
| C-021 | bestätigt | M0 liefert nach dem Baseline-Run versionierte numerische M1-Toleranzen. |
| C-022 | Product-Owner-Entscheid | **Ergänzt durch C-085:** Die Entscheidungs-Route verlangt zusätzlich Streuung über mindestens 20 Sessions bei höchstens 25 % Anteil je Session; gezählt wird pro Memory-Entscheidung. Shadow-Abnahme nach mindestens 14 Tagen oder 500 geloggten Hook-Entscheidungen; zusätzlich müssen Goldset-Gates bestehen und alle `required`/`no_answer`-Divergenzen erklärt sein. |
| C-023 | Product-Owner-Entscheid | Der Live-Evidenzentscheid läuft hinter einem Konfigurations-Flag mit sofortigem Fallback auf das heutige Floor-Verhalten; kein Hard-Cutover. |
| C-024 | Product-Owner-Entscheid | **Releasezuordnung geändert durch C-083:** Die Zuweisungs- und Fallzahlregel selbst gilt unverändert, aber das Erreichen des Mindest-N ist keine V1.0-Anforderung mehr. Retrieval-/Präsentationsexperimente weisen den Arm deterministisch pro pseudonymer Session-ID zu; Mindest-N pro Arm wird nach M0 versioniert festgelegt. |
| C-025 | Product-Owner-Entscheid | Private Run-Artefakte liegen unter `~/.bastra/eval-runs/<datum>-<hash>/`; das öffentliche Repo erhält nur aggregierte Reports ohne Vault-abgeleitete Query-Texte. |
| C-026 | bestätigt | Chunking wird nicht durch M2 freigegeben, sondern benötigt einen gesonderten Repräsentationsentscheid auf Basis einer Chunking-on/off-Ablation. |
| C-027 | bestätigt | Produktmetriken sind erst ab ihrer jeweils gegateten Datenquelle messbar; vorher bleiben sie ausdrücklich Zielbild. |
| C-028 | bestätigt | §19 definiert die zulässigen unabhängigen Query-Quellen, verbietet beim Formulieren den Zugriff auf Body, Summary und `recall_when` des Ziel-Memorys und macht die Provenienzfelder im Datensatzmanifest und privaten Run-Artefakt verbindlich. |
| C-029 | Architekturentscheidung | Fremdsystemzahlen werden mit ihrer Evidenzklasse geführt und sind niemals Messgate, Zielwert oder Abnahmekriterium; §2.3 hält die geprüften Grenzen der zitierten Messungen fest. |
| C-030 | Architekturentscheidung | Cue und Evidenz werden getrennt. `recall_when` bleibt der primäre autorisierte Cue; abgeleitete Cues starten als read-only Sidecar mit Herkunft und begründen für sich genommen nie `required`. |
| C-031 | Architekturentscheidung | Deep Recall ist ein eigener, bewusst ausgelöster Modus mit deterministischer Stufe 1 und agentischer Stufe 2; er wird gegen bloß größeres `k` ablated und läuft nie in einem Hook-Latenzbudget. |
| C-032 | Architekturentscheidung | Die vier Zeitachsen `occurred_at`, `valid_from`/`valid_to`, `recorded_at` und `derived_at` werden getrennt benannt; `created` und `updated` bleiben reine Dateizeiten. |
| C-033 | Architekturentscheidung | Herkunft wird als `provenance_class` an Claims und abgeleiteten Inhalten geführt statt als zweite Memory-Taxonomie; ein eigenes Meinungs-/Belief-Netz wird abgelehnt. |
| C-034 | Architekturentscheidung | Der Typed Graph erhält logische Sichten mit Hop-Budget statt getrennter physischer Graphen; kausale und temporale Kanten entstehen nie aus Ähnlichkeit, und jede Sicht braucht einen No-Graph-Kontrollarm. |
| C-035 | Architekturentscheidung | Konsolidierung äußert sich ausschließlich in benannten, nichtdestruktiven und reversiblen Proposal-Operatoren; jede archivierte Quelle bleibt über eine begrenzte Zahl typisierter Links erreichbar. |
| C-036 | Messproblem | Das Goldset erhält handlungsbezogene und assoziative Fallklassen; externe Standardbenchmarks bleiben V1.x-Adapterarbeit und sind kein V1.0-Releaseblocker. |
| C-037 | Messproblem | Nutzungssignale werden über `acted_on` hinaus erweitert und exposure-korrigiert ausgewertet; Nichtreaktion bleibt ein schwaches Negativ ohne Live-Wirkung vor M6. **Begriff korrigiert durch C-044:** es ist eine Exposure-*Normalisierung*, keine Bias-Korrektur. |
| C-038 | Messproblem | M5 misst zusätzlich zu Latenz und Recall den Qualitätszerfall bei Wachstum, insbesondere Abstention, Widerspruchsauflösung und temporale Fragen. **Abnahmekriterium ersetzt durch C-045:** verbindlich sind die numerischen Toleranzen aus 18.6.1. |
| C-039 | Hypothese | Gravity- und Hub-Dämpfung werden als zusätzliche M2-Ablationsarme geführt; sie ergänzen die bestehende Lifecycle-, Curator-, Doc- und Salience-Dämpfung, ersetzen sie nicht. |
| C-040 | Messproblem | Die Quellenmatrix in 29 führt je Fremdclaim kanonische Quelle, Version oder Commit, genaue Fundstelle, Abrufdatum und bei Messungen Reader, Judge, Top-k und Kontextbudget; fehlende Angaben werden als fehlend ausgewiesen. |
| C-041 | Architekturentscheidung | Das Zeitmodell wird vollständig bi-temporal: `recorded_at`/`retracted_at` bilden den Wissenszeitraum als Intervall ab. `valid_until` bleibt ausschließlich Lifecycle-Feld und wird weder mit `valid_to` gleichgesetzt noch automatisch migriert. |
| C-042 | Ist-Korrektur | Ein fehlendes `provenance_class` gilt niemals als `user_asserted`. Altbestand ohne eindeutige Zuordnung wird `unknown_legacy`; nur explizites `write_origin: user-directed` wird automatisch `user_asserted`. **Eingeschränkt durch C-049 und C-060, überholt durch C-063:** Die Importherkunft hat Vorrang, ein behauptetes `write_origin` ist keine Attestierung, und `user_asserted` entsteht ausschließlich über die bestätigte Review. |
| C-043 | Messproblem | Die Reduktion auf Bridge- und Horizon-Cues ist Hypothese, nicht Entscheidung: M2 vergleicht vier Cue-Arme. Provenienzfelder eines Cues werden nie ablated, nur seine Rankingwirkung; Cue- und Dämpfungsarm erhalten getrennte Gates. |
| C-044 | Messproblem | Die Division durch die Ausspielungszahl ist Exposure-Normalisierung, nicht Bias-Korrektur. Ein kausaler Utility-Lift setzt geloggte Auswahlwahrscheinlichkeiten, kontrollierte Exploration und die Behandlung nicht ausgespielter Kandidaten als zensiert voraus. |
| C-045 | Messproblem | Der Skalen- und Interferenztest wird von der Flat/HNSW-Entscheidung getrennt. M5 vergleicht beide Backends auf identischem Korpus, identischen Queries und identischer Konfiguration; die Qualitätskategorien erhalten nach der Baseline numerische Toleranzen. |
| C-046 | Ist-Korrektur | Der heute in Hooks aktive `related_via`-Hop bleibt als semantische Baseline und Kontrollarm erhalten, bis jede neue logische Sicht ihren eigenen Lift belegt. Ein Graph-Hop erzeugt allein niemals `required`. |
| C-047 | Architekturentscheidung | Die Deep-Recall-Abbruchbedingungen erhalten versionierte Höchstwerte und eine messbare Definition des Evidenzgewinns; ein Budgetabbruch wird als `inconclusive_budget_exhausted` ausgewiesen und nie als `no_answer`. **Korrigiert durch C-052, vervollständigt durch C-056:** verbindlich sind fünf Endbedingungen und vier Ergebniswerte. |
| C-048 | Architekturentscheidung | **Präzisiert durch C-062:** Beide Quoten gelten je Berechtigungs-, Scope- und Sensitivity-Kontext. Die Erreichbarkeitsgarantie erhält eine versionierte maximale Hop-Zahl und eine messbare Survival-/Zitationsquote; Accessibility-Operatoren werden von inhaltlichen Versionsoperatoren getrennt und benötigen einen eigenen Override-/Floor-Vertrag. |
| C-049 | Ist-Korrektur | Importherkunft hat Vorrang vor `write_origin`: Der Import stempelt auch maschinelle Inhalte als `user-directed`, deshalb wird nur ein nicht importierter, belegbar nutzergesteuerter Save automatisch `user_asserted`. `confidence` wird indexiert, wirkt aber nicht. **Eingeschränkt durch C-055 und C-060, überholt durch C-063:** auch nicht importiert genügt nicht, Attestierung ist kein Attribut des Schreibpfads — und der Bestätigungsbezug entsteht ausschließlich in der Recall-Oberfläche. |
| C-050 | Architekturentscheidung | Ein Widerspruch erzeugt zunächst einen konkurrierenden Claim, nicht `retracted_at`; `valid_to`, `recorded_at`/`retracted_at`, `valid_until`, `obsolete` und Soft Delete sind fünf getrennte Zustände ohne automatische Gleichsetzung. |
| C-051 | Messproblem | Die Cue-Arme bilden ein 2×2-faktorielles Design mit getrennt ausgewerteten Hauptwirkungen und Interaktion; Szenen-Cues brauchen entweder eine eigene Stufe nach M4 oder eine definierte read-only Episodenprojektion. **Ergänzt durch C-057:** Fallzahlregel, Explorativ-Kennzeichnung und konstante Versuchsumgebung. |
| C-052 | Architekturentscheidung | Ausbleibender Evidenzgewinn schließt nur den Ast, nicht den Lauf; `no_answer` setzt deterministische Erschöpfung aller Äste voraus. Der Ergebnisvertrag wird unverändert durch alle Oberflächen geführt, die Hop-Kennzeichnung bleibt serverintern. **Vervollständigt durch C-056:** Erfolgsbedingung, Prioritätsregel und vierter Ergebniswert; `limit: "other"` entfällt. |
| C-053 | Architekturentscheidung | Die Survival-Invariante wird vor jeder Klasse-A-Operation simuliert und blockiert oder erzeugt Provenienz-Shortcuts; `max_provenance_hops` = 2 ist Startkandidat. `SUPERSEDE` bleibt Klasse A mit sekundärer Sichtbarkeitswirkung ohne Accessibility-Override. **Vervollständigt durch C-058 und C-059, präzisiert durch C-062:** Atomarität und Ausweichkaskade, Abgrenzung gegen das Archivierungsprimitiv, Quoten je Berechtigungskontext. |
| C-054 | Messproblem | Ledger- und Quellenkonsistenz: Korrekturverweise an C-037 und C-038, Quellenzuordnung der AgentRunbook-Messzeile, angepasste `confidence`-Aussage (heute in 6.3), durchgängig C-055 als nächste freie ID. |
| C-055 | Ist-Korrektur | **Überholt.** Korrigiert durch C-060, beantwortet durch C-063, verschärft durch C-064 und C-070, korrigiert durch C-065 und C-069: Die unten stehende Konsequenz gilt nicht mehr — `user_asserted` entsteht ausschließlich über die bestätigte Review, und die Reviewberechtigung hängt weder an `write_origin` noch am Importstatus. Im Einzelnen: Ein Mutation-Audit genügt nicht; der Bestätigungsbezug entsteht in der Recall-Oberfläche; eine Bestätigung gilt für genau ein Memory und einen Inhaltsstand; `not_scheduled` ist keine Ausnahme mehr. Ein vom Caller gesetztes `write_origin: user-directed` ist keine Attestierung. `user_asserted` entsteht automatisch nur über einen serverseitig belegten vertrauenswürdigen Schreibpfad; die Review führt `confirmed_provenance_class` mit Auditbezug, und die Provenienzbestätigung ist ein eigener widerrufbarer Vertrag, kein Klasse-B-Override. |
| C-056 | Architekturentscheidung | Der Deep-Recall-Endzustandsvertrag wird vollständig: `answer_found` erhält eine eigene Endbedingung, Fundpriorität vor Grenze, `inconclusive_budget_exhausted` nur bei echter Ressourcengrenze, sonst `inconclusive_interrupted` mit `stop_reason`; Fehler bleiben Fehler. **Korrigiert durch C-061:** `controller_defect` verlässt Ergebniswerte und `stop_reason`. |
| C-057 | Messproblem | **Ergänzt durch C-066, korrigiert durch C-072:** Verbindlich sind die beiden Versuchsanlagen aus 18.3. Der Cue-Erzeugungsweg wird als eigener, vorab registrierter Faktor geführt. M0 legt Power und Mindest-N je Zelle des 2×2-Cue-Versuchs versioniert fest und stellt getrennte beschreibende und assoziative Goldfälle bereit; bei zu kleinem N bleibt die Interaktion explorativ und trägt keine Live-Freigabe. |
| C-058 | Architekturentscheidung | Provenienz-Shortcut und Sichtbarhalten eines Zwischenknotens sind Teil desselben atomaren Klasse-A-Vorschlags; für den nicht erfüllbaren Fall gibt es einen definierten, schleifenfreien Ausweg, und Shortcuts wahren Sensitivity-Grenzen. **Präzisiert durch C-062:** Die Sperre beruht auf einem strukturellen Fingerprint. |
| C-059 | Architekturentscheidung | `SUPERSEDE` arbeitet über Claim- und Versionsstatus und entspricht nicht dem heutigen `archive_memory`; historische Vorgänger bleiben über einen benannten Historical-/Deep-Recall-Index erreichbar, und Rollback stellt auch Speicherort und Indexierbarkeit wieder her. **Präzisiert redaktionell:** Der Zugriff darf als logische Sicht auf dem bestehenden Index beginnen. |
| C-060 | Ist-Korrektur | **Beantwortet durch C-063:** Der Bestätigungsbezug entsteht in der Recall-Oberfläche; kein Schreibpfad wird zum Attestor. Ein Mutation-Audit belegt die Mutation, nicht den Nutzerakt: Der Audit-Kontext wird vom Caller geliefert und fällt sonst auf `actor: user` zurück. Attestierung verlangt einen nicht vom speichernden Caller behauptbaren Bestätigungsbezug; ohne ihn entsteht kein automatisches `user_asserted`. |
| C-061 | Architekturentscheidung | `controller_defect` verlässt die Ergebniswerte und wird ein strukturierter Schnittstellenfehler mit read-only Teilzustand. `no_answer` bedeutet „keine entscheidungsfähige Antwort", nicht „keine Evidenz"; Teilabdeckung wird ausgewiesen. |
| C-062 | Architekturentscheidung | Survival- und Zitationsquote gelten je Berechtigungs-, Scope- und Sensitivity-Kontext mit Zielwert 100 % innerhalb jedes Kontextes; die Wiederholungssperre beruht auf einem strukturellen Fingerprint statt auf Zeit oder Cache. **Präzisiert durch C-067:** ein geänderter Fingerprint allein genügt nicht, der Vorschlag muss inhaltlich ein anderer sein. |
| C-063 | Product-Owner-Entscheid | **Korrigiert durch C-068 und C-069:** Die Oberfläche fragt progressiv nach und bildet sieben Provenienzklassen ab — Beobachtung, Ableitung und Vermutung bleiben getrennt; die Reviewberechtigung hängt weder an `write_origin` noch am Importstatus. Der Bestätigungsbezug entsteht in der Recall-Oberfläche: `user_asserted` entsteht ausschließlich durch die ausdrückliche Nutzerbestätigung beim Review, nie automatisch im Save-Pfad. Die vier Antwortmöglichkeiten der Oberfläche bilden vier Provenienzklassen ab. |
| C-064 | Product-Owner-Vorgabe | **Operationalisiert durch C-070:** Bindung an `memory_id` und den Hash des im Review dargestellten aussagetragenden Inhalts; Retrieval-, Darstellungs- und Betriebsmetadaten lösen keinen Verfall aus. Eine Bestätigung gilt für genau ein Memory in genau einem Inhaltsstand. Sie ist nicht übertragbar, nicht wiederverwendbar und verfällt bei inhaltlicher Änderung des bestätigten Memorys. |
| C-065 | Product-Owner-Entscheid | **Präzisiert durch C-071, korrigiert durch C-076:** Datenquelle für Prüfstufe 2 ist der vorhandene Usage-Sidecar; fehlende Historie bedeutet `unknown` und führt nicht automatisch nach Stufe 2. Der gesamte Bestand wird geprüft. `not_scheduled` bezeichnet nur noch die Warteschlangenposition und keine Ausnahme; die Prüfung läuft in vier Prioritätsstufen und endet je Memory mit geklärter oder ausdrücklich bestätigt unklarer Herkunft. |
| C-066 | Product-Owner-Entscheid | **Korrigiert durch C-072:** Für den Cue-Erzeugungsweg gelten die beiden Anlagen aus 18.3. Abschnitt 31 wird zum Entscheidungsprotokoll: Cue-Erzeugung vertagt und in M2 als vorab registrierter Faktor geprüft, genau ein handlungsorientierter externer Benchmark in V1.x, Deep Recall Stufe 2 erst nach Stufe-1-Messung, Herkunft jetzt read-only prüfen und Schemafelder gemeinsam nach M4. |
| C-067 | Product-Owner-Vorgabe | Ein abgelehnter Konsolidierungsvorschlag kehrt nur zurück, wenn er inhaltlich ein anderer ist; ein geänderter Fingerprint ist notwendige, aber nicht hinreichende Bedingung. **Operationalisiert durch C-073, widerspruchsfrei gemacht durch C-075:** geänderter struktureller Fingerprint, geänderter semantischer Vorschlagshash und benannte materielle Änderung. |
| C-068 | Ist-Korrektur | Die UI-Antwort „vom Agenten" wird nicht pauschal auf `agent_observed` abgebildet. Beobachtung, Ableitung und Vermutung bleiben getrennte Klassen; die Oberfläche fragt progressiv nach. |
| C-069 | Ist-Korrektur | **Verschärft durch C-077:** Der Vorschlagswert wird angezeigt und begründet, ist aber nicht vorausgewählt. Der gesamte Bestand ist review- und bestätigungsfähig. Importstatus und `write_origin` bestimmen ausschließlich die abgeleitete Ausgangsklasse und einen Vorschlagswert der Oberfläche, niemals die Reviewberechtigung. |
| C-070 | Architekturentscheidung | Der Bestätigungsbezug bindet an `memory_id` und einen Hash des im Review dargestellten aussagetragenden Inhalts. Retrieval-, Darstellungs- und Betriebsmetadaten lösen keinen Verfall aus. |
| C-071 | Ist-Korrektur | **Korrigiert durch C-076:** `unknown` macht ein Memory nicht automatisch zu Stufe 2; Floors und Pin taugen nicht als Zweitkriterium. Pro-Memory-Nutzungstelemetrie existiert bereits als Usage-Sidecar mit `surfaced`, `loaded`, `acted_on` und Zeitstempeln; Prüfstufe 2 benennt sie als Quelle. Fehlende Historie bedeutet `unknown`, nicht null. |
| C-072 | Messproblem | **Korrigiert durch C-074:** Anlage A hat zwei Bedingungen statt vier Zellen und verlangt eine Auswahl-/Holdout-Trennung; nur Anlage B misst Interaktionen. Der Versuch zum Cue-Erzeugungsweg wird eindeutig: entweder gepaarter Agent-gegen-Batch-Vergleich bei festgehaltenen Cue-Achsen (Anlage A) oder vollständig gekreuztes 2×2×2 mit eigenem Mindest-N (Anlage B). Die Anlage wird vor dem Lauf registriert. |
| C-073 | Architekturentscheidung | **Widerspruchsfrei gemacht durch C-075, kanonisiert durch C-079:** Der Hash entsteht aus einer versionierten kanonischen Struktur; statt Begründungsprosa geht ein Reason-Code ein, und die Quellversion ist eine semantische Inhaltsversion. Die Wiedervorlage eines abgelehnten Vorschlags verlangt geänderten strukturellen Fingerprint, geänderten semantischen Vorschlagshash **und** eine benannte materielle Änderung; gleicher Vorschlagsinhalt bleibt unterdrückt. |
| C-074 | Messproblem | Anlage A ist ein Zwei-Bedingungen-Vergleich, keine Vierzellenanlage: Die Cue-Konfiguration wird auf einem getrennten Auswahlteil bestimmt und auf einem unabhängigen Holdout verglichen, alternativ über eine vorab registrierte verschachtelte Auswertung. Nur Anlage B besitzt acht Zellen und kann Interaktionen messen. |
| C-075 | Architekturentscheidung | **Kanonisiert durch C-079:** Der Hash wird aus einer versionierten Struktur ohne freien Text gebildet. Der semantische Vorschlagshash umfasst Operatortyp, normalisierte Zieländerung, Quell-IDs und -Versionen, betroffene Kanten, Evidenz- und Begründungsstand sowie die Schutzkonfliktauflösung; die Wiedervorlage verlangt alle drei Bedingungen. |
| C-076 | Ist-Korrektur | **Ausführbar gemacht durch C-078:** Das Strukturkriterium wird vorab versioniert festgelegt. Fehlende Sidecar-Historie macht ein Memory nicht automatisch zu Stufe 2. Stufe 2 umfasst belegte hohe Nutzung und historieunbekannte Memories mit nachweislich hoher Strukturwirkung; Floors sind bereits Stufe 1, und eine unabhängige Pin-Quelle existiert am HEAD nicht. |
| C-077 | Product-Owner-Vorgabe | Keine Provenienzantwort ist vorausgewählt. Die abgeleitete Klasse erscheint als begründeter Systemvorschlag; `confirmed` entsteht nur durch aktive Auswahl, ein Weiter-Klick auf einen Default ist unwirksam. |
| C-078 | Messproblem | **Semantisch präzisiert durch C-080, belegpflichtig gemacht durch C-081:** Der Brückenbestandteil ist clusterübergreifende Nachbarschaft, und der Snapshot ist im Artefakt nachzuweisen. Die Grenze zwischen Prüfstufe 2 und 4 wird vor dem Aufbau der Warteschlange als versioniertes Strukturkriterium aus einem eingefrorenen Graph-Snapshot festgelegt und im Manifest gespeichert; sie gilt für historieunbekannte Memories außerhalb der Stufen 1 und 3, die Auswertung läuft 1 → 3 → 2 → 4, und Graphausfall führt konservativ zu Stufe 4. |
| C-079 | Architekturentscheidung | **Ergänzt durch C-081:** Ein Reason-Code außerhalb der geltenden Vokabularversion löst keine Wiedervorlage aus. Der semantische Vorschlagshash wird aus einer versionierten kanonischen Struktur gebildet und enthält keinen freien Erklärungstext; die Quellversion bezeichnet eine semantische Inhaltsversion, nicht `updated`. |
| C-080 | Ist-Korrektur | Das Feld `GraphNode.bridge` belegt weder eine graphentheoretische Brücke noch einen Artikulationsknoten: `buildGraph` setzt es, sobald ein Knoten Nachbarn in mindestens zwei unterschiedlichen fremden Clustern besitzt, ohne zu prüfen, ob diese Cluster ohne ihn unverbunden wären. Es bleibt Bestandteil des Strukturkriteriums, aber ausschließlich mit dieser Bedeutung; eine echte Artikulationsanalyse wäre zusätzliche Grapharbeit und wird nicht behauptet. |
| C-081 | Architekturentscheidung | **Gate korrigiert durch C-082:** Zuordnung und Nachweisartefakt sind jederzeit zulässige Sidecar-/Run-Artefakte nach C-018 und C-025 und an kein Messgate gebunden. Der eingefrorene Graph-Snapshot wird im Queue- beziehungsweise Run-Artefakt belegt — Projektionsschema und Version, Snapshot-Hash, Erstellungszeitpunkt, angewandtes Kriterium samt Schwellenwert oder Quantil und je zugeordnetem historieunbekannten Memory ID, `degree`, fremde Cluster beziehungsweise `bridge`-Wert und resultierende Stufe; alternativ content-addressed persistiert und referenziert. Ein Zeitstempel allein genügt nicht. Während eines laufenden Reviews wird nicht neu berechnet oder neu zugeordnet, ein Neustart setzt dieselbe Warteschlange fort. Ein unbekannter Reason-Code führt konservativ zu keiner Wiedervorlage. |
| C-082 | Ist-Korrektur | Das versionierte Queue- beziehungsweise Run-Artefakt der Bestandsprüfung fällt nicht unter M4 und nicht unter den Schemaentscheid aus 21.4: Es verändert weder Memory-Inhalt noch Vault-Schema und darf sofort persistiert werden. 21.4 greift erst, wenn Snapshot-, Queue- oder Reviewfelder in das Memory-Frontmatter beziehungsweise das persistente Memory-Schema übernommen werden. |
| C-083 | Vertragsänderung | V1.0 schuldet vom Retrieval-/Präsentationsexperiment aus 17.4 nur noch die vorab registrierte Anlage, die deterministische Armzuweisung und den ehrlichen Statusbericht (`underpowered` beziehungsweise `not_evaluable` nach 18.1). Der hinreichend besetzte Lauf — erreichtes Mindest-N je Arm, zweiter Hook-Wortlaut, je Session schaltbares Gate, erhobene Query-Klasse, unabhängige Relevanzlabels — ist nach 26.2 verschoben. Begründung ist gemessen: Die Versuchseinheit ist die Session, und die Ein-Nutzer-Population trägt in vertretbarer Zeit kein Mindest-N. |
| C-084 | Vertragsergänzung | Ab V1.0 steht das Frontmatter-Format unter einer ausdrücklichen Zusicherung (26.1): Pflichtfelder, Memory-Typen, Bedeutung der dokumentierten optionalen Felder und die Ladetoleranz ändern sich nur mit einem Major-Bump. Ein 1.x-Reader verlangt kein Formatversionsfeld. Unbekannte Schlüssel werden beim Laden toleriert, überleben einen `overwrite` aber nicht garantiert. Nicht gedeckt sind Ranking, interne `.bastra/`-Ablagen und Projektionsinhalte; die `recall`-Ausgabeform fällt unter den eigenen API-Vertrag. Eine Loader-Verschärfung ist nur unter der eng gefassten Sicherheitsausnahme ohne Major-Bump zulässig. |
| C-085 | Vertragsergänzung | Die 500-Entscheidungen-Route der Shadow-Abnahme (18.2) gilt nur bei Streuung: mindestens 20 verschiedene Sessions tragen die zählenden Entscheidungen, und keine einzelne Session stellt mehr als 25 % von ihnen. Die 14-Tage-Route bleibt unberührt. Klarstellung im selben Eintrag: Gezählt wird pro Memory-Entscheidung, nicht pro Hook-Aufruf — so ist die Schwelle implementiert und so ist sie gemeint. |
| C-086 | Präzisierung | Beide Wege zu `required` werden enger gefasst (10.3): Das Teilabdeckungs-Signal der Zwei-von-drei-Zählung zählt erst ab 50 % Trigger-Abdeckung statt ab dem ersten gemeinsamen Term, und der harte Identifier-Anker liest Titel, `recall_when` und Frontmatter statt zusätzlich den Body. Beziffert vor der Änderung: Anti-Query-Gate von 50 % auf 12,5 %, Recall@3 gegated, Identifier-Queries und Falsch-Abstention unverändert, längenneutral. Offen bleiben die zu kleine Anti-Probenmenge und die Kosten des Pflichtverlusts, die erst die Shadow-Telemetrie zeigt. |

**Abnahmestand 24.07.2026:** Vollabgleich Ledger C-001–C-027,
Gate-Messbarkeit, Ist-Behauptungs-Sweep (58 Aussagen, alle gedeckt),
Implementierer-Review. Künftige Gegenprüfungen betreffen ausschließlich
Änderungs-Deltas gegen diesen Stand.

**Finale Architekturabnahme 24.07.2026:** C-028 ist im finalen Delta-Review
bestätigt; es bestehen keine substanziellen offenen Deltas. Die abgenommene
Basis C-001–C-027 bleibt unverändert. Nächste freie ID: C-029. *(Historischer
Stand vom 24.07.2026. Die aktuell gültige nächste freie ID steht am Ende
dieses Abschnitts.)*

**Recherche-Delta-Revision 25.07.2026:** Gegenprüfung eines
Recherche-Briefings gegen die dort zitierten Primärquellen und gegen den
Code-Stand. Alle im Briefing genannten Quellen wurden abgerufen; eine URL war
tot, eine Zahlenreihe war ohne eigene Quelle zitiert, und neun Ist-Aussagen
über Bastra wurden am HEAD erneut belegt. Ergebnis sind die Deltas
C-029–C-039. Die Basis C-001–C-028 blieb unverändert gültig; kein früheres
Urteil wurde revidiert.

**Codex-Gegenreview der Revision, 25.07.2026:** Der
Gegenreview beanstandete neun Punkte an C-029–C-039 — fehlende
Reproduzierbarkeit der Quellenmatrix, ein nur halb bi-temporales Zeitmodell,
einen gefährlichen Provenienz-Fallback, eine unbelegte Cue-Reduktion, eine
falsch benannte Exposure-Korrektur, die Vermischung von Skalentest und
Backend-Entscheidung, den drohenden stillen Verlust der heutigen
Hop-Baseline, nicht ausführbare Deep-Recall-Abbruchbedingungen und eine
unmessbare Erreichbarkeitsgarantie. Alle neun sind bestätigt und als
C-040–C-048 eingearbeitet; drei davon korrigieren einen Fehler der
Vorgängerrevision, nicht nur eine Ungenauigkeit. Details in Abschnitt 28,
Quellenbelege in Abschnitt 29.

**Codex-Delta-Review, 25.07.2026:** Ein reiner Delta-Fix mit
sechs Punkten. Der schwerwiegendste ist C-049: Das in C-042 eingeführte
Provenienz-Mapping hätte über den Import-Pfad genau den Fehler wieder
eingeführt, den C-042 beheben sollte — der Import stempelt jeden Inhalt und
sogar einen maschinell erzeugten Navigations-Index als `user-directed`.
Zusätzlich waren zwei Ist-Aussagen zu präzisieren, drei Verträge zu schärfen
und fünf Konsistenzstellen zu bereinigen. C-001–C-048 bleiben unverändert;
korrigierte ältere Einträge tragen einen Korrekturverweis an Ort und Stelle.

**Abschließende Korrekturrunde, 25.07.2026:** Fünf Punkte,
davon zwei Ist-Korrekturen am Code-Stand. C-055 schließt die letzte Lücke der
Provenienzkette: Ein vom Caller behauptetes `write_origin` ist keine
Attestierung, weil der reguläre MCP-Save das Feld ungeprüft übernimmt. C-059
entkoppelt das künftige `SUPERSEDE` vom heutigen Archivierungsprimitiv, das den
Vorgänger nicht nur als `obsolete` markiert, sondern ihn aus dem lebenden Index
entfernt und in den Trash verschiebt. C-056 bis C-058 vervollständigen drei
Verträge, die in der Vorrunde noch Lücken hatten. Zwei redaktionelle
Klarstellungen ohne eigene C-ID betreffen `stale_status` und den zuletzt offenen
M5-Prüfpunkt.

**Letzter Delta-Fix, 25.07.2026:** Drei Punkte. C-060
korrigiert die Attestierungsdefinition aus C-055: Der Audit-Kontext des
Bridge-Pfads wird vom Caller geliefert und fällt sonst auf `actor: user`
zurück — ein Mutation-Audit belegt damit die Mutation, nicht den Nutzerakt.
C-061 nimmt `controller_defect` aus den Ergebniswerten heraus und präzisiert
`no_answer` gegen partielle Evidenz. C-062 macht die Survival-Garantie
berechtigungsbezogen und die Wiederholungssperre fingerprint-basiert. Drei
redaktionelle Korrekturen betreffen eine Codefundstelle, eine Zeilenzahl und
die zulässige Umsetzung des Historical-Zugriffs.

**Product-Owner-Entscheidungen, 25.07.2026:** Die vier in
Abschnitt 31 vorbereiteten Entscheidungen sind getroffen; die in C-060 offen
gelassene Provenienzfrage kommt als fünfte hinzu. Zwei davon wirken über
den Abschnitt hinaus: Der in C-060 offen gebliebene Bestätigungsbezug hat mit
der Recall-Oberfläche eine benannte Quelle (C-063), und die vollständige
Bestandsprüfung hebt die bisherige Aussetzungsregel für `not_scheduled` auf
(C-065). Zwei zuvor an den Product Owner delegierte technische Punkte werden zu
festen Qualitätsanforderungen: die Bindung einer Bestätigung an genau ein
Memory (C-064) und die Rückkehrregel für abgelehnte Vorschläge (C-067).
Abschnitt 31 ist damit kein Vorlagen-, sondern ein Protokollabschnitt.

**Gegenreview der Entscheidungsumsetzung, 25.07.2026:** Zwei
Blocker und vier Präzisierungen. Die Blocker betreffen beide die Umsetzung von
C-063: Die Oberfläche hätte drei epistemisch verschiedene Herkünfte auf eine
Klasse abgebildet (C-068), und ein stehengebliebener Ableitungssatz hätte die
Reviewberechtigung an Importstatus und `write_origin` gekoppelt — im Widerspruch
zur vollständigen Bestandsprüfung aus C-065 (C-069). Dazu kommen ein
Ist-Befund zur bereits vorhandenen Nutzungstelemetrie (C-071) und drei
Operationalisierungen: Bestätigungsbindung (C-070), Cue-Versuchsdesign (C-072)
und Vorschlagswiederholung (C-073).

**Abschließende Korrekturrunde, 26.07.2026 (diese Fassung):** Vier Punkte, die
sämtlich Regeln der Vorrunde betreffen. C-074 korrigiert eine rechnerisch
falsche Zellzahl: Anlage A hat zwei Bedingungen, nicht vier Zellen, und braucht
eine Holdout-Trennung oder eine vorab registrierte verschachtelte Auswertung,
damit die Auswahl der Cue-Konfiguration den Vergleich nicht kontaminiert. C-075 löst einen Zirkelschluss im Wiedervorlagevertrag —
der Vorschlagshash umfasste nur die Zustandsänderung, während Evidenz und
Begründung als materielle Änderung gelten sollten. C-076 korrigiert eine
empirisch unhaltbare Stufenzuordnung und stützt sich dabei auf den Code:
Floors sind bereits Stufe 1, und eine unabhängige Pin-Quelle existiert nicht.
C-077 verschärft die Oberflächenregel: keine vorausgewählte Antwort.

**Delta-Fix zu den Ermessenslücken, 26.07.2026:** Zwei Punkte, die dieselbe
Schwäche beheben: Eine Regel war formuliert, aber nicht ausführbar, und die
Lücke lag jeweils im Ermessen des Implementierers. C-078 legt die Grenze
zwischen Prüfstufe 2 und 4 vorab und versioniert fest, damit sie nicht während
des Laufs wandert. C-079 kanonisiert den semantischen Vorschlagshash, damit
eine bloße Umformulierung ihn nicht bewegt.

**Abschließender Delta-Fix, 26.07.2026 (diese Fassung):** Zwei Punkte, die
beide dieselbe Schwäche beheben: Eine ausführbar formulierte Regel stützte sich
auf eine Zusage, die weder der Code noch das Artefakt einlöst. C-080 zieht die
Bedeutung des `bridge`-Feldes auf das zurück, was `buildGraph` tatsächlich
berechnet — clusterübergreifende Nachbarschaft, keine bewiesene Trennwirkung.
C-081 macht den eingefrorenen Graph-Snapshot nachweispflichtig, damit die
Stufenzuordnung ohne den später veränderten Live-Graphen überprüfbar bleibt,
und sperrt die Wiedervorlage bei einem Reason-Code außerhalb des geltenden
Vokabulars.

**Ein-Satz-Delta-Fix, 26.07.2026 (diese Fassung):** Ein Gate-Widerspruch im
C-081-Block. Der Block hatte die persistente Gestalt des Nachweisartefakts unter
den Schemaentscheid nach M4 gestellt und damit eine Regel, die sofort gelten
soll, an ein Gate gebunden, das erst nach mehreren Messstufen fällt. C-082 hebt
das auf: Das Artefakt ist ein Sidecar-/Run-Artefakt nach C-018 und C-025.

**Vertragsänderung, 29.08.2026 (diese Fassung):** Erstmals ändert ein Eintrag
nicht ein Urteil, sondern den Umfang des V1.0-Releasevertrags selbst. C-083
nimmt das Erreichen des Mindest-N im Retrieval-/Präsentationsexperiment aus
26.1 heraus und verschiebt den hinreichend besetzten Lauf nach 26.2. Anlass ist
die Fallzahlmessung aus der Registrierung des Experiments: Die Versuchseinheit
ist nach 17.4 die Session, und auf der heutigen Ein-Nutzer-Population erreicht
kein Arm in vertretbarer Zeit eine tragfähige Besetzung. Was V1.0 schuldet,
bleibt vollständig prüfbar — Registrierung, deterministische Zuweisung und die
ehrliche Auskunft, dass ein Arm nicht auswertbar ist. Die ersetzte Fassung
bleibt in 26.1 als solche kenntlich; kein Urteil aus C-001–C-082 wird
umgedeutet.

**Vertragsergänzung, 29.08.2026 (diese Fassung):** C-084 schreibt die
Frontmatter- und Schemazusicherung fest, die V1.0 mit dem Wegfall der führenden
`0.` abgibt. Sie war bis dahin nirgends dokumentiert — weder in 26.1 noch in 22
noch in `docs/memory-schema.md` —, obwohl ab 1.0 jede Änderung am Vault-Format
einen Major-Bump verlangt. Der Eintrag verspricht ausschließlich, was der Code
heute hält: die zehn Pflichtfelder, die erkannten Typen, die Bedeutung der
optionalen Felder und die Ladetoleranz aus dem Rescue-Pfad. Ausdrücklich nicht
zugesichert sind Ranking, interne Ablagen, Projektionsinhalte und die
Erhaltung fremder Schlüssel über einen `overwrite` hinweg; die
`recall`-Ausgabeform ist gebunden, aber über den eigenen API-Vertrag.

**Vertragsergänzung, 29.08.2026 (diese Fassung):** C-085 bindet die
Entscheidungs-Route der Shadow-Abnahme an Streuung. Die Schwelle „500
Entscheidungen oder 14 Tage" kannte nur eine Menge; im realen Bestand stammten
2040 von 2052 geloggten Entscheidungen aus einer einzigen Session, womit ein
Arbeitstag das Tor formal gefüllt hätte. Künftig zählt die Entscheidungs-Route
nur bei mindestens 20 verschiedenen Sessions und höchstens 25 % Anteil je
Session; die 14-Tage-Route bleibt unberührt. Derselbe Eintrag hält die
Zähl-Lesart fest: pro Memory-Entscheidung, nicht pro Hook-Aufruf.

**Präzisierung, 29.08.2026 (diese Fassung):** C-086 fasst beide Wege zu
`required` enger. Die Zwei-von-drei-Zählung wertete jede Trigger-Abdeckung über
null als unabhängiges Signal, sodass ein einziger zufällig geteilter Term eine
Pflicht mittrug; künftig zählt sie erst ab 50 % Abdeckung. Der harte
Identifier-Anker suchte zusätzlich im Body und machte damit eine Erwähnung im
Fließtext zur Zuständigkeit; er liest künftig nur Titel, `recall_when` und
Frontmatter. Beide Verengungen wurden vor der Änderung beziffert: Das
Anti-Query-Gate fällt von 50 % auf 12,5 %, Recall@3 gegated, Identifier-Queries
und Falsch-Abstention bleiben unverändert. Zwei Vorbehalte stehen ausdrücklich
im Eintrag — acht Anti-Proben können die 5-%-Schwelle nicht darstellen, und die
Kosten des Pflichtverlusts sieht erst die Shadow-Telemetrie.

**Nächste freie ID: C-087.** Neue Delta-Reviews beginnen dort. Ein Urteil
ändert sich nur mit neuer Code-, Telemetrie- oder Run-Evidenz; Geschmacksfragen
werden als Architekturentscheidung statt als Faktenfehler markiert.

## 1. Zweck

Die Evolution von Bastra Recall V1 zu V2 soll nicht einfach mehr Erinnerungen
finden. Das System soll zunehmend zuverlässig entscheiden:

1. ob überhaupt eine Erinnerung relevant ist;
2. welche Art von Gedächtnis für die aktuelle Situation zuständig ist;
3. wie tief gesucht werden muss;
4. ob ein Memory spontan auftauchen, nur auf Nachfrage gefunden oder bewusst
   „aus der Ferne“ zurückgeholt werden soll;
5. wann einzelne Erfahrungen zu dauerhaftem Wissen konsolidiert werden;
6. wann altes Wissen nur schwerer zugänglich, historisch oder nachweislich
   überholt ist.

Der zentrale Produktsatz bleibt:

> Der Nutzer soll nicht für die KI mitdenken müssen.

Spätestens mit V1.0 wird eine zweite Bedingung operativ:

> Die KI soll den Nutzer nicht mit Erinnerungen belasten, die für die aktuelle
> Situation keine nachweisbare Relevanz haben.

## 2. Ausgangslage

Die heutige Architektur besitzt bereits starke Einzelbausteine:

- lokaler Markdown-/YAML-Vault als Source of Truth;
- BM25 mit hoch gewichtetem `recall_when`;
- optionale semantische Suche über Embeddings;
- RRF-Fusion von lexikalischen und semantischen Treffern;
- Doc2query-Trigger, optionale und opt-in aktivierte Sprach-Bridges sowie
  automatische Beziehungen;
- Staleness, Floors und Curator; Salience verlängert bereits die
  Staleness-Lebensdauer, ihr direkter Rankingeinfluss ist standardmäßig
  Shadow-only;
- Reflex-Memories mit expliziter Nutzerfreigabe;
- lokale Telemetrie für `surfaced`, `loaded` und `acted_on`;
- wiederherstellbares Löschen und stabile Memory-IDs; ein vollständiger
  Mutation-Audit existiert derzeit nur im Mac-App-Bridge-Pfad, nicht bei
  regulären MCP-/HTTP-Saves.

Diese Komponenten ergeben aber noch kein geschlossenes Modell für Aufmerksamkeit,
Vergessen, Wiedererinnern und Konsolidierung. Besonders die heutige
Score-Semantik führt dazu, dass nahezu jede Anfrage einen scheinbar starken
Top-Treffer erzeugt.

### 2.1 Verifizierte Momentaufnahme, noch kein reproduzierbarer Benchmark

Am 24. Juli 2026 read-only gemessene Größen auf dem aktuellen Vault mit 577
Memories:

| Messung | Ergebnis |
|---|---:|
| BM25-Schritt, 30-Tage-Produktionstelemetrie | n 22.819 · p50 1 ms · p95 11 ms · p99 25 ms |
| BM25-Ad-hoc-Benchmark, Methode nicht archiviert | p50 5,1 ms · p95 13,3 ms · p99 19,3 ms |
| PreTool-Hook gesamt | Median 141 ms · p95 255 ms |
| Recall-Anteil im Daemon | Median 95 ms · p95 223 ms |
| SessionStart | Median 381 ms · p95 499 ms |
| MCP-Recall | Median 105 ms · p95 200 ms |
| Ad-hoc-Paraphrasen, Provenienz nicht archiviert | Recall@1 45,2 % · Recall@3 57,1 % · MRR 0,521 |
| Anti-Query-Topscore | Median 137,7 |

30-Tage-Telemetrie:

| Signal | Ergebnis |
|---|---:|
| erreichbare PreTool-Aufrufe | 4.009 |
| Topscore ≥ heutiger Required-Schwelle | 4.006 · 99,9 % |
| ausgespielte Required-Hinweise | 16.762 |
| davon geladen | 153 · 0,9 % |
| davon als `acted_on` gewertet (Token-Overlap-Proxy) | 82 · 0,5 % der ausgespielten Hinweise |
| geschätzte injizierte Hint-Tokens | 519.588 |
| Tokens pro als `acted_on` gewertetem Memory (Proxy) | ca. 6.336 |

Die Telemetriegrößen stammen aus der bestehenden `stats.ts`-Methodik. Das
30-Tage-Fenster wandert; geringfügig andere Werte bei einem späteren Run sind
deshalb kein Widerspruch.

Die Produktionszeile zum BM25-Schritt stammt aus
`recall_stages.bm25_search_ms`; bei der Gegenprüfung am 24. Juli 2026 enthielt
das wandernde Fenster 22.819 passende Events. Die getrennten
BM25-Ad-hoc-, Paraphrasen- und Anti-Query-Werte wurden mit read-only Läufen
gemessen, aber noch nicht als versioniertes Run-Artefakt mit Befehlszeile,
Methode, Code-, Vault-, Modell-, Konfigurations- und Datensatz-Hash gespeichert.
Insbesondere ist für die 45,2-%-Paraphrasenmessung keine von der
Memory-Oberfläche unabhängige Provenienz archiviert. Diese Werte sind
diagnostische Hinweise und dürfen erst nach M0 als offizielle Baseline gelten.

Die Load- und `acted_on`-Quoten beweisen nicht, dass jeder ungeladene Hinweis
falsch war. Sie messen das Gesamtsystem aus Retrieval, Hook-Formulierung,
Consumer-Verhalten und Telemetrie-Zuordnung. `acted_on` ist heute selbst ein
lexikalischer Token-Overlap-Proxy. Die Werte zeigen dennoch eindeutig, dass der
aktuelle absolute Score kein belastbares Relevanzversprechen ist und das
Required-Band als interne Steuerungsgröße nicht kalibriert ist. Der sichtbare
Hook-Text nennt die Treffer bereits „hints, not obligations“; Scope- und
Suppression-Bypässe hängen intern aber weiterhin an der 100er-Schwelle.

Die in dieser Instanz aktivierten zwei Sprach-Bridges waren nicht nur
theoretisch verdrahtet: In der ausgewerteten 30-Tage-Momentaufnahme erweiterten
sie 853 Queries. Ohne Opt-in oder ohne Bridge-Pool bleibt die Schicht
definitionsgemäß ein No-op. Die 853 Erweiterungen messen ausschließlich, wie
oft eine Bridge feuerte; sie belegen weder Trefferqualität noch einen kausalen
Recall-Lift.

### 2.2 Hauptprobleme

1. **Rang ist keine Wahrscheinlichkeit.** BM25 und skalierter RRF leben in
   unterschiedlichen Score-Räumen, verwenden aber dieselben absoluten Floors.

2. **Es fehlt echte Abstention.** Ein Ranking besitzt immer einen ersten Platz,
   auch wenn die richtige Antwort „nichts Passendes vorhanden“ lautet.

3. **Assoziation ist stärker als Hemmung.** Embeddings, Query-Expansion und
   Graph-Hops erhöhen Reichweite, aber nicht automatisch Präzision.

4. **Episoden und dauerhaftes Wissen konkurrieren im selben Abrufraum.**

5. **Vergessen ist nur aus Einzelregeln zusammengesetzt.** Zeit, Salience,
   Curator-Demotion und Floors ergeben noch keine einheitliche, erklärbare
   Accessibility.

6. **Der heiße Pfad ist unnötig seriell.** SessionStart führt mehrere Recall- und
   Metadatenanfragen nacheinander aus.

7. **Die Eval-Sets sind teilweise zu klein oder nicht produktionsnah.** Kleine
   synthetische Sets erreichen Deckenwerte, während reale Paraphrasen deutlich
   schwächer abschneiden.

8. **Der Hybrid-Stresspfad ist nicht verlässlich verdrahtet.** Ein
   `packages/daemon/scripts/eval-stress.ts --hybrid`-Lauf bleibt im aktuellen
   Stress-Harness strukturell BM25-only, weil dort kein `EmbeddingIndex`
   angelegt wird. Andere spezialisierte Eval-Arme können bereits echte
   Embeddings verwenden; die Aussage gilt ausdrücklich dem Stress-Harness.

9. **Retrieval und Consumer-Verhalten sind in der ROI-Messung vermischt.**
   Niedrige Load-Raten können durch irrelevante Treffer, Hook-Sprache,
   Consumer-Compliance oder unvollständige Telemetrie-Zuordnung entstehen.

10. **Die aktuelle Qualitätsmessung hat noch keine Run-Provenienz.** Ohne
    versioniertes Artefakt ist eine echte Vorher-/Nachher-Entscheidung nicht
    reproduzierbar.

Die Punkte 1, 2, 6 bis 10 sind unmittelbar verifizierte Probleme des
V1.0-Releasevertrags. Die Punkte 3 bis 5 begründen das langfristige Zielbild,
sind aber noch kein Beleg dafür, dass die dazu beschriebenen späteren
Komponenten jetzt gebaut werden müssen.

### 2.3 Fremdsystem-Evidenz und ihre Grenzen

Am 25. Juli 2026 wurden die Quellen einer externen Recherche zu vergleichbaren
Agent-Memory-Systemen abgerufen und ihre Kernbehauptungen einzeln geprüft. Das
Ergebnis stützt die Richtung dieses Dokuments. Es ändert nichts am Ist-Stand
aus 2.1, und kein geprüftes System liefert eine unabhängig replizierte Messung,
die eine Bastra-Entscheidung tragen könnte.

Verbindliche Konsequenz:

- Jede Fremdzahl wird mit ihrer Evidenzklasse geführt: peer-reviewed,
  Preprint, produktiv implementierter Code beziehungsweise Dokumentation,
  Anbieterbenchmark oder Eigenmessung des jeweiligen Projekts.
- Fremdzahlen dürfen Designentscheidungen motivieren. Sie sind niemals
  Messgate, Zielwert oder Abnahmekriterium für Bastra.
- Unterschiedliche Reader, Judges, Prompts, Top-k, Kandidatenpools,
  Kontextbudgets und Datensatzversionen verbieten eine gemeinsame Rangliste.

Die belegten Grenzen der stärksten zitierten Zahlen:

- Hindsight berichtet 91,4 % LongMemEval und 89,6 % LoCoMo sowie Recall unter
  200 ms bei 10.000 Memory Units ohne Backbone-Aufruf. Die im Paper genannte
  unabhängige Reproduktion stammt von Virginia Tech und Washington Post; beide
  stellen Co-Autoren des Papers. In derselben Tabelle liegt auf LoCoMo ein
  Fremdsystem mit 90,0 % vor Hindsight.
- Zeps LoCoMo 94,7 % und LongMemEval 90,2 % stehen ausschließlich auf der
  eigenen Research-Seite; Reader und Judge sind dasselbe Modell. Das
  zugehörige Paper nennt ältere, abweichende Werte.
- MAGMAs LoCoMo-Vorsprung von 0,700 gegenüber 0,590, 0,580 und 0,481 gilt nur
  für die LLM-as-a-Judge-Metrik. Die Hyperparameter wurden laut Appendix auf
  LoCoMo optimiert, während die Vergleichssysteme mit Defaults liefen; bei den
  lexikalischen Metriken liegt ein Vergleichssystem vorn.
- Ori Mnemos meldet HotpotQA-Ergebnisse aus einem Lauf mit 50 Fragen, und die
  Zahlen im Haupt-README weichen von denen im `bench`-Verzeichnis ab.
- Mem0 erreicht mit der Managed-Pipeline 94,8 % auf LongMemEval bei Top 50 und
  92,5 % auf LoCoMo bei Top 200 — zwei verschiedene Retrieval-Tiefen, die nicht
  nebeneinandergestellt werden dürfen; bei gleicher Tiefe sind es 94,4 %
  beziehungsweise 91,8 %. Auf BEAM bei zehn Millionen Token Historie fällt
  dieselbe Pipeline auf 50,5 % Pass Rate, mit Durchschnittswerten von 0,163 für
  temporale Fragen, 0,325 für Widerspruchsauflösung und 0,400 für Abstention
  auf einer Skala von 0 bis 1; die zugehörigen Pass Rates lauten 20 %, 25 % und
  40 %. Der Lauf umfasst 200 der 2.000 offiziellen BEAM-Fragen.

Der letzte Punkt ist der wichtigste Einzelbefund der Recherche und der Grund
für das Delta an M5: Hohe Werte auf kurzen Konversationsbenchmarks sagen nichts
über Interferenz, Widerspruch und Abstention bei Wachstum. Genau diese
Eigenschaften sind Bastras Produktversprechen.

T-Mem, All-Mem und LongMemEval-V2 beziehungsweise AgentRunbook sind Preprints
ohne nachweisbare Annahme; für T-Mem ist zum Prüfzeitpunkt kein Code
veröffentlicht. Peer-reviewed belegt sind dagegen Hindsight als ACL-Demo,
MAGMA, Mem2ActBench und die Graph-Gegenposition aus derselben Konferenz.

## 3. Wissenschaftliche Leitplanken

Bastra simuliert kein biologisches Gehirn. V2 übernimmt nur Prinzipien, die sich
als nützliche Systemarchitektur übersetzen lassen.

### 3.1 Komplementäre Lernsysteme

Die Complementary-Learning-Systems-Theorie unterscheidet schnelles Lernen
einzelner Erfahrungen von langsamem Aufbau strukturierter Kenntnisse. Replay
verbindet beide Systeme.

Übertragung auf Bastra:

- schneller, append-only Episodenspeicher;
- langsamer, stabiler semantischer Speicher;
- regelmäßige, evidenzbasierte Konsolidierung statt sofortiger Generalisierung.

Quelle:
[Kumaran, Hassabis & McClelland – Complementary Learning Systems Theory Updated](https://pubmed.ncbi.nlm.nih.gov/27315762/)

### 3.2 Pattern Separation und Pattern Completion

Pattern Separation hält ähnliche Erfahrungen auseinander und reduziert
Interferenz. Pattern Completion rekonstruiert eine Erinnerung aus unvollständigen
Hinweisen.

Übertragung auf Bastra:

- getrennte Episoden, Versionen, Entities und Zeiträume;
- keine vorschnelle Verschmelzung ähnlicher Memories;
- BM25, Embeddings, Doc2query und Graph als Pattern-Completion-Werkzeuge;
- typed edges, Claims und Konflikterkennung als Pattern-Separation-Werkzeuge.

Quelle:
[Yassa & Stark – Pattern separation in the hippocampus](https://pubmed.ncbi.nlm.nih.gov/21788086/)

### 3.3 Replay und Konsolidierung

Offline-Reaktivierung kann neue und alte Erfahrungen integrieren und gleichzeitig
bestehendes Wissen schützen.

Übertragung auf Bastra:

- Curator als kontrollierter „Schlaf“-Pass;
- Mischung aus neuen, alten, erfolgreichen und widersprechenden Episoden;
- Vorschläge statt autonomer inhaltlicher Umschreibung;
- Beibehaltung der Ursprungsbelege.

Quelle:
[Singh, Norman & Schapiro – Sleep-dependent memory consolidation](https://pubmed.ncbi.nlm.nih.gov/36279437/)

### 3.4 Rekonsolidierung

Reaktivierte Erinnerungen können vorübergehend veränderbar werden und müssen
erneut stabilisiert werden. Die direkte biologische Evidenz stammt unter anderem
aus Tiermodellen; für Bastra ist dies eine Designanalogie, keine Gleichsetzung.

Übertragung auf Bastra:

- erfolgreicher Abruf eröffnet einen überprüfbaren Update-Kandidaten;
- neue Evidenz erzeugt eine Version oder `supersedes`-Beziehung;
- keine stille Überschreibung historischer Wahrheit.

Quelle:
[Nader, Schafe & LeDoux – Reconsolidation after retrieval](https://pubmed.ncbi.nlm.nih.gov/10963596/)

### 3.5 Adaptives Vergessen

Vergessen ist nicht nur Verlust. Die Unterdrückung konkurrierender Erinnerungen
kann zukünftige Interferenz reduzieren.

Übertragung auf Bastra:

- Zugänglichkeit reduzieren, nicht löschen;
- häufig ignorierte Konkurrenz dämpfen;
- erfolgreiche Wiederverwendung verstärken;
- Deep Recall erhält den Zugriff auf dormante Inhalte.

Quelle:
[Wimber et al. – Retrieval induces adaptive forgetting](https://pubmed.ncbi.nlm.nih.gov/25774450/)

## 4. Architekturprinzipien

1. **Hemmung vor zusätzlicher Assoziation.** Jede Erweiterung des Kandidatenraums
   braucht ein stärkeres Relevanz- oder Abstention-Gate.

2. **Zugänglichkeit ist nicht Existenz.** Ein Memory darf schwer erreichbar
   werden, ohne gelöscht zu werden.

3. **Rang ist nicht Vertrauen.** Interne Suchscores dürfen nie direkt als
   Nutzerversprechen ausgegeben werden.

4. **Keine Antwort ist ein gültiges Ergebnis.** `no_answer` ist ein normaler
   Systemzustand, kein Fehler.

5. **Arbeitskontext begrenzt Langzeitgedächtnis.** Ziel, Projekt, Dateien,
   Entities und Task-Phase filtern vor dem breiten Abruf.

6. **Episoden werden schnell gespeichert, Regeln langsam gelernt.**

7. **Jede Generalisierung behält ihre Evidenz.**

8. **Vergessen und Wiedererinnern müssen erklärbar sein.**

9. **Automatische Backend-Wahl wird gemessen, nicht geraten.**

10. **Human-in-the-loop bleibt für dauerhafte Regeln, Reflexe, Präferenzen,
    Konfliktauflösung und Löschung erhalten.**

11. **Local-first, Privacy und Survival-by-ID bleiben unverhandelbar.**

## 5. Zielbild

```text
Prompt / Tool Intent / Session Context
                |
                v
      Working-Memory Controller
      - goal, project, files, entities
      - task phase, recent errors, constraints
                |
                v
      Adaptive Retrieval Controller
      - exact/reflex lane
      - lexical lane
      - semantic lane
      - deep-recall lane
      - deadline + token budget
                |
       +--------+---------+
       |                  |
       v                  v
  Sparse Index       Vector Strategy
  BM25 / fields      Flat or HNSW
       |                  |
       +--------+---------+
                |
                v
        Candidate Evidence Set
        - lexical evidence
        - vector evidence
        - scope/time/source
        - accessibility
        - graph relations
                |
                v
      Deterministic Evidence Gate + Abstention
      - later: calibrated probability
                |
       +--------+---------+
       |                  |
       v                  v
  Normal Recall       Deep Recall
  Core + Orbit        Asteroidengürtel
       |                  |
       +--------+---------+
                |
                v
      bounded context / load-on-demand
                |
                v
      usage, correction and outcome signals
                |
                v
       Curator / Consolidation / Review
```

## 6. Gedächtnislagen

V2 trennt die Funktion von Memories, ohne den bestehenden Markdown-Vault
aufzugeben.

### 6.1 Working Memory

Flüchtiger Sitzungszustand, nicht automatisch dauerhaft:

- aktuelles Ziel;
- Projekt und Worktree;
- betroffene Dateien und Symbole;
- aktive Entities;
- aktuelle Task-Phase;
- jüngste Fehler und Korrekturen;
- bestätigte Constraints;
- offene Fragen;
- bereits geladene Memories.

Working Memory dient als Aufmerksamkeits- und Filtermodell. Es soll klein,
zeitnah und vollständig verwerfbar sein.

### 6.2 Episodic Memory

Neue Lane beziehungsweise neuer Memory-Typ `episode`:

- `occurred_at`;
- `session_id` oder stabiler Task-Bezug;
- Situation und Kontext;
- ausgeführte Handlung;
- Ergebnis;
- erfolgreich / fehlgeschlagen / teilweise;
- beteiligte Dateien, Symbole und Entities;
- Quelle oder Beleg;
- mögliche emotionale Salience;
- Links auf Entscheidungen, Lessons und andere Episoden.

Regeln:

- append-only als Standard;
- keine automatische Required-Injektion;
- primäre Nutzung für Deep Recall, Konsolidierung und Ursachensuche;
- alte Episoden dürfen verblassen, bleiben aber erhalten;
- ähnliche Episoden werden verknüpft, nicht still zusammengeführt.

### 6.3 Semantic Memory

Stabiles Wissen:

- Lessons;
- Decisions;
- Preferences;
- Project Facts;
- Workflows;
- References;
- Dokument-Sidecars.

V2 ergänzt beziehungsweise operationalisiert:

- strukturierte Claims;
- Evidenz-Links;
- `valid_from`;
- `valid_to`;
- `confidence`;
- `supersedes`;
- `contradicts`;
- `derived_from`;
- `last_verified_at`.

Semantische Memories entstehen aus expliziter Nutzeranweisung, gesicherter Quelle
oder bestätigter Konsolidierung.

#### Zeitachsen

Bi-temporal heißt: Beide Achsen sind **Intervalle**, nicht Zeitpunkte. Die Welt
kennt einen Gültigkeitszeitraum, das System einen Wissenszeitraum — und beide
können unabhängig voneinander enden:

| Feld | Achse | Bedeutung |
|---|---|---|
| `occurred_at` | Ereignis | wann das Ereignis stattgefunden hat |
| `valid_from` / `valid_to` | Weltgültigkeit | in welchem Zeitraum eine Aussage in der Welt gilt |
| `recorded_at` / `retracted_at` | Systemwissen | in welchem Zeitraum Recall die Aussage kannte und für gültig hielt |
| `derived_at` | Ableitung | wann eine abgeleitete Aussage erzeugt wurde, optional |

Ein einzelner `recorded_at`-Zeitpunkt genügt nicht. Erst das Paar
`recorded_at`/`retracted_at` beantwortet die Frage „was hielt das System am
Stichtag X für wahr?“ getrennt von „was war am Stichtag X tatsächlich wahr?“.
Ohne `retracted_at` wäre jede zurückgenommene Aussage rückwirkend so zu lesen,
als hätte das System sie nie geglaubt — womit sich Fehlentscheidungen der
Vergangenheit nicht mehr rekonstruieren ließen.

**Ein Widerspruch allein setzt `retracted_at` nicht.** Das wäre eine stille
automatische Entscheidung und stünde gegen die Regel aus Abschnitt 13, dass
Widersprüche sichtbar erklärt statt aufgelöst werden. Der Ablauf ist gestuft:

1. Ein erkannter Widerspruch erzeugt zunächst einen **sichtbaren
   Konfliktbefund** und einen `LINK`-Vorschlag für die `contradicts`-Kante.
   Beide Aussagen bleiben aktiv und sichtbar; der Konflikt wird ausgewiesen.
   Die Kante selbst wird erst nach Freigabe gemäß 14.4 persistiert — sie ist
   eine starke Kante und unterliegt damit der Evidenz- und Freigabepflicht aus
   Abschnitt 13.
2. `retracted_at` wird erst gesetzt durch eine **bestätigte Auflösung** — eine
   akzeptierte Korrektur oder ein bestätigtes `SUPERSEDE`.
3. Bleibt der Konflikt unaufgelöst, bleibt er offen. Ein offener Widerspruch
   ist ein gültiger Systemzustand und zählt in die Gedächtnisgesundheit nach
   Abschnitt 20, nicht in die Zeitachsen.

Gelöscht wird in keinem Schritt.

**`valid_until` ist keines dieser Felder.** Es existiert heute bereits und ist
ausschließlich ein Lifecycle- beziehungsweise Accessibility-Feld: Es wird an
genau einer Stelle gelesen und dort in einen Score-Multiplikator übersetzt —
`expired` dämpft auf 20 %, `aging` auf 85 %. Es schließt kein Memory aus dem
Recall aus, und es sagt nichts darüber, ob die Aussage in der Welt noch gilt.
Ein abgelaufenes `valid_until` bedeutet „dieses Memory soll seltener spontan
auftauchen“, ein erreichtes `valid_to` bedeutet „diese Aussage ist nicht mehr
wahr“. Das ist nicht dasselbe.

Daraus folgt verbindlich:

- `valid_until` wird **nicht** mit `valid_to` gleichgesetzt;
- `valid_until` wird **nicht** automatisch nach `valid_to` migriert;
- `valid_until` behält seine heutige Dämpfungswirkung unverändert;
- ein Memory kann gleichzeitig `valid_to` in der Zukunft und ein abgelaufenes
  `valid_until` haben — es ist dann wahr, aber schwer zugänglich. Genau diese
  Kombination ist der Grund, beide Felder zu trennen.

`created` und `updated` behalten ebenfalls ihre heutige Semantik als
Schreibzeiten und werden nicht nachträglich umgedeutet. Bemerkenswert und
absichtlich unverändert: `updated` speist heute die Staleness-Rechnung,
`created` nicht.

#### Fünf getrennte Zustände

Zeitliche Gültigkeit, systemseitiges Wissen, Zugänglichkeit, Ausblendung und
Löschung sind fünf verschiedene Dinge. Sie werden häufig verwechselt, weil sie
alle dazu führen können, dass ein Memory nicht mehr auftaucht:

| Zustand | Aussage | Ebene |
|---|---|---|
| `valid_to` erreicht | die Aussage gilt in der Welt nicht mehr | Claim |
| `retracted_at` gesetzt | das System hält die Aussage nicht mehr für gültig | Claim |
| `valid_until` abgelaufen | das Memory wird im Ranking gedämpft | Memory, Accessibility |
| `obsolete` gesetzt | das Memory ist aus dem normalen Recall entfernt | Memory |
| Soft Delete | die Datei liegt im wiederherstellbaren Papierkorb, mit Audit | Datei |

`stale_status` gehört ausdrücklich **nicht** in diese Aufzählung. Es ist kein
sechster semantischer Lifecycle-Zustand, sondern ausschließlich eine
persistierte UI- und Cache-Projektion: kein Wahrheitsfeld, kein Gate, kein
Ranking-Input. Es muss aus den maßgeblichen Lifecycle-Feldern jederzeit
reproduzierbar neu berechenbar sein, und eine Abweichung zwischen Projektion und
Neuberechnung ist ein Cache-Fehler, keine Zustandsänderung.

Zwischen diesen Zuständen gibt es **keine automatische Gleichsetzung und keine
automatische Migration**. Ein abgelaufenes `valid_until` macht keinen Claim
ungültig; `obsolete` sagt nichts über Wahrheit; ein Soft Delete ist kein
Widerspruch; und kein Zeitfeld setzt jemals selbsttätig `obsolete` oder löst
einen Soft Delete aus.

Für `valid_to` gilt eine Präzisierung: Es entfernt ein Memory nicht aus dem
Retrieval, verändert aber seine **Rolle**. Ein Claim jenseits seiner
Weltgültigkeit ist historisch im Sinne von 6.5 und wird nicht mehr als aktuelle
Regel injiziert; abgelaufene Gültigkeit zählt zudem nach 7.3 als negatives
Accessibility-Signal und geht damit in die berechnete Zone ein. Beides ist
gewollt und bleibt eine Wirkung auf Rolle und Zugänglichkeit — nicht auf
Existenz, Auffindbarkeit über die ID oder Deep Recall.

Eine bestätigte Operation darf mehrere dieser Zustände gezielt setzen — ein
angenommenes `SUPERSEDE` etwa `retracted_at` am Vorgänger-Claim und dessen
Ausblendung aus dem aktuellen Recall. Sie muss dann aber **im Operatorvertrag
ausweisen, welche Zustände sie berührt**, und jeder davon muss einzeln
zurückrollbar sein. Was der Operator nicht ausweist, setzt er nicht.

Für Regeln, Präferenzen, Lessons und Workflows ist `occurred_at` in der Regel
leer und `valid_to` optional; ein fehlendes `valid_to` bedeutet „gilt bis auf
Widerruf“ und nicht „unbegrenzt bewiesen“.

Diese Felder sind Schemaarbeit und hängen am gesonderten Schemaentscheid aus
21.4. Bis dahin existieren sie höchstens als abgeleitete read-only Projektion.
Vorbild ist ein produktiv implementiertes Fremdsystem, das genau diese vier
Marken führt — zwei auf der Transaktions- und zwei auf der Ereigniszeitlinie —
und widersprochene Fakten zeitlich invalidiert statt sie zu löschen. Bastra
weicht in einem Punkt bewusst ab: Dort invalidiert die Konflikterkennung
unmittelbar, hier erst die bestätigte Auflösung (siehe oben).

#### Herkunft

Herkunft wird als eigenes Feld geführt, nicht als zweite Memory-Taxonomie.
`provenance_class` unterscheidet:

| Wert | Bedeutung |
|---|---|
| `user_asserted` | vom Nutzer **bestätigt** — ausschließlich über die bestätigte Review, nie aus dem Schreibvorgang abgeleitet |
| `agent_observed` | vom Agenten beobachtetes Ereignis oder eigene Erfahrung |
| `derived` | aus anderen Memories oder Episoden abgeleitet |
| `hypothesis` | Vermutung ohne ausreichende Evidenz |
| `approved_rule` | vom Nutzer freigegebene Regel oder Reflex |
| `imported_unverified` | aus einem fremden Vault übernommen, Urheberschaft nicht geprüft |
| `unknown_legacy` | Herkunft nicht eindeutig rekonstruierbar |

Abgeleitete Inhalte tragen zusätzlich Generator, Version und Konfidenz,
referenzieren ihre Evidenz über `derived_from` und dürfen einen
`user_asserted`-Inhalt niemals still ersetzen. Ein eigenes Meinungs- oder
Belief-Netz wird nicht eingeführt: Ein System, das eigene Überzeugungen mit
selbstverstärkender Konfidenz führt, widerspricht dem Grundsatz, dass Bastra
Nutzerwissen verwaltet und nicht eigene Positionen bildet.

#### Fallback für den Altbestand

**Ein fehlendes `provenance_class` gilt niemals als `user_asserted`.** Der
Umkehrschluss wäre der gefährlichste denkbare Default: Er würde jedem
Altbestand die höchste Vertrauens- und Schutzklasse zusprechen und damit genau
die Grenze aufheben, die das Feld ziehen soll.

Der heutige Code stützt das: `write_origin` ist optional ohne Schema-Default,
und alle Schutzprüfungen vergleichen strikt gegen `user-directed`. Ein
Bestandsmemory ohne das Feld ist heute faktisch `agent-session` und damit
ungeschützt; beim nächsten Save wird `agent-session` materialisiert. Der Vault
enthält also keine Information, die eine Nutzerurheberschaft belegen würde.

Das Mapping ist **zweistufig und in dieser Reihenfolge auszuwerten**. Seine
beiden Stufen heißen hier **Mapping-Stufe 1 und 2**; sie haben nichts mit den
vier Prüfstufen der Bestandsprüfung weiter unten zu tun. Die
Reihenfolge ist nicht redaktionell, sondern trägt die Sicherheit des ganzen
Verfahrens:

**Mapping-Stufe 1 — Importherkunft prüfen. Sie hat Vorrang vor jedem anderen Signal.**

| Beobachtung | abgeleitete Klasse |
|---|---|
| `source` mit Import-Adapter-Präfix `<adapter>:<label>:<relKey>` | `imported_unverified` |
| `source` mit Präfix `index:<label>` | `imported_unverified` |
| `topic_path` beginnt mit `imported` oder Tag `imported` gesetzt | `imported_unverified` |
| vergleichbare maschinelle Quellkennzeichnung | `imported_unverified` |

Trifft eine dieser Bedingungen zu, endet die Auswertung hier. `write_origin`
wird in diesem Fall **nicht** ausgewertet.

**Mapping-Stufe 2 — nur für nicht importierte Memories.**

| Beobachtung | abgeleitete Klasse |
|---|---|
| `write_origin: user-directed`, mit oder ohne Auditkontext | `unknown_legacy` |
| `write_origin: capture-review` | `unknown_legacy` |
| `write_origin: agent-session` | `unknown_legacy` |
| `write_origin` fehlt | `unknown_legacy` |

Die Ableitung der Mapping-Stufen vergibt **keinen** Review-Status. Der Status ergibt sich
ausschließlich aus der Warteschlange der Bestandsprüfung und nicht aus
`write_origin`; andernfalls würde das Feld doch wieder über die Einreihung
mitentscheiden.

**Keine Beobachtung der Mapping-Stufe 2 erzeugt `user_asserted`.** Diese Klasse entsteht
ausschließlich über die bestätigte Review — siehe „Wo der Bestätigungsbezug
entsteht“ weiter unten. Die Ableitung aus dem Schreibvorgang kann eine
Nutzerurheberschaft nur *vermuten*, nie belegen.

#### Warum `write_origin` allein nicht genügt

`write_origin` ist ein Eingabefeld, kein Nachweis. Der reguläre MCP-Save
exponiert es im öffentlichen Tool-Schema und reicht den Wert des Aufrufers
unverändert an die Speicherfunktion durch, ohne Auditnachweis — ein vollständiges
Mutation-Audit besteht nach C-008 bis heute nur im Mac-Bridge-Pfad. Ein Agent,
der `user-directed` setzt, behauptet also lediglich, im Auftrag des Nutzers zu
schreiben. Genau diese Behauptung darf nicht die höchste Vertrauensklasse
auslösen.

#### Ein Mutation-Audit ist nicht dasselbe wie eine Attestierung

Auch der auditierte Bridge-Pfad ist **nicht allein durch sein Audit** attestiert.
Der Code belegt warum: Der Audit-Kontext wird dort aus den Aufrufparametern
gelesen und fällt, wenn der Caller keinen mitschickt, auf `{ actor: "user" }`
zurück. Die einzige inhaltliche Prüfung greift beim Wert `assistant`, der eine
Begründung erzwingt — ausgerechnet die Behauptung `actor: "user"` verlangt also
gar nichts. Ein Caller, der schlicht keinen Audit-Kontext übergibt, erhält den
Nutzer-Stempel geschenkt.

Daraus folgt die entscheidende Unterscheidung:

- Ein **Mutation-Audit** beantwortet: Was wurde wann von welchem Prozess
  geändert? Es ist für Nachvollziehbarkeit **notwendig**.
- Eine **Attestierung** beantwortet: Hat ein Mensch diese Aussage tatsächlich
  getätigt oder bestätigt? Dafür ist das Audit **nicht hinreichend**.

**Attestierung** heißt deshalb: Es existiert ein Bestätigungsbezug —
`user_action_ref` beziehungsweise `confirmation_ref` —, der

1. **serverseitig oder von einem vertrauenswürdigen UI-Adapter erzeugt** wurde,
   nicht vom speichernden Caller;
2. vom speichernden Caller **nicht selbst behauptbar** ist, also nicht schlicht
   als Parameter mitgeschickt werden kann;
3. auf einen konkreten, nachprüfbaren Nutzerakt verweist — eine Bestätigung,
   eine Eingabe, eine Freigabe — und nicht auf den Speichervorgang selbst;
4. später auflösbar bleibt, damit die Attestierung nachprüfbar ist.

Ohne einen solchen Bezug fällt der Save konservativ auf `unknown_legacy` mit
Reviewbedarf zurück. Das ist kein Misstrauen gegenüber dem Agenten, sondern die
Trennung zwischen *behauptet* und *belegt*: Nur die belegte Nutzerurheberschaft
trägt die Schutzwirkung, die `user_asserted` verspricht. Die bestätigte
Provenienz-Review ist der Weg dorthin — der einzige, und ein sichtbarer.

**Kein Bypass über das Klassenfeld.** Wird künftig `provenance_class` direkt im
Save übergeben, unterliegt der Wert `user_asserted` derselben Regel: Ohne
Attestierungsbezug wird er nicht übernommen, sondern wie ein nicht attestiertes
`user-directed` behandelt. Andernfalls entstünde genau die Umgehung, die diese
Regel verhindert.

**Auch der Mac-Bridge-Pfad ist nicht attestiert** — und soll es nach dem
Entscheid aus 31 auch nicht werden. Ein Schreibpfad zum Attestor zu erklären
wäre eine Vertrauensentscheidung ohne Beleg; der Bestätigungsbezug entsteht
stattdessen an der einzigen Stelle, an der ein Mensch nachweislich beteiligt
ist. Wo das ist, steht im nächsten Abschnitt.

#### Wo der Bestätigungsbezug entsteht

Kein Schreibpfad erzeugt einen solchen Bezug, und keiner soll es. Der
Product-Owner-Entscheid aus 31 legt die Quelle stattdessen an die einzige
Stelle, an der ein Mensch tatsächlich beteiligt ist: **die Prüfung eines
Memorys in der Recall-Oberfläche**.

Dort beantwortet der Nutzer eine einzige Frage — woher stammt das? Die
Oberfläche fragt dabei **progressiv**: eine kurze Hauptauswahl, und nur dort,
wo es nötig ist, eine Rückfrage.

| Hauptauswahl | Rückfrage | resultierende `provenance_class` |
|---|---|---|
| „Ja, das stammt von mir.“ | — | `user_asserted` |
| „Vom Agenten oder System.“ | „Direkt beobachtet?“ | `agent_observed` |
| „Vom Agenten oder System.“ | „Daraus abgeleitet?“ | `derived` |
| „Vom Agenten oder System.“ | „Eher eine Vermutung?“ | `hypothesis` |
| „Aus einem fremden Vault übernommen.“ | — | `imported_unverified`, bestätigt |
| „Unklar.“ | — | `unknown_legacy`, bestätigt |
| bei Regeln zusätzlich: „Diese Regel bestätige ich.“ | — | `approved_rule` |

Die Rückfrage ist nicht optional. Beobachtung, Ableitung und Vermutung sind
**drei verschiedene epistemische Zustände**, und die Klassentabelle führt sie
aus gutem Grund getrennt: Eine Agentenbeobachtung ist ein Ereignis, eine
Ableitung eine Schlussfolgerung aus anderen Memories, eine Vermutung eine
Aussage ohne ausreichende Evidenz. Sie gemeinsam auf `agent_observed`
abzubilden würde die Unterscheidung genau an der Stelle einebnen, an der sie
zum ersten Mal jemand mit Wissen treffen könnte — und `derived` und
`hypothesis` blieben dauerhaft leere Klassen.

Zwei Klicks statt einem sind der Preis dafür. Er fällt nur an, wenn der Nutzer
die Herkunft nicht bei sich selbst verortet. Vorbelegt ist auch die Rückfrage
nicht — siehe unten.

Der Klick auf „Ja, das stammt von mir“ **ist** der attestierte Nutzerakt. Er
erzeugt den Bestätigungsbezug, und er ist der einzige Weg, auf dem ein Memory
die Klasse `user_asserted` erreicht.

Die abgeleitete Ausgangsklasse aus dem Fallback-Mapping weiter oben in diesem
Abschnitt darf als **begründeter Systemvorschlag angezeigt** werden — etwa
„Dieses Memory stammt aus einem Import, deshalb vermutlich fremde Herkunft“.
**Vorausgewählt sein darf keine Antwort.**

Der Unterschied ist nicht kosmetisch. Eine vorbelegte Auswahl macht den
Bestätigungsklick zum Bestätigen einer Systemvermutung — und genau das war der
Grund, die Attestierung überhaupt an einen Nutzerakt zu binden. Ein Default,
den man wegklickt, belegt nichts. Deshalb gilt:

- Keine der Antworten ist beim Öffnen der Prüfung markiert.
- `confirmed` entsteht **nur**, wenn der Nutzer aktiv eine Antwort auswählt.
- Ein bloßer Weiter- oder Bestätigen-Klick ohne vorherige Auswahl ist
  **unwirksam** und erzeugt keinen Bestätigungsbezug.
- Die progressive Rückfrage bei „Vom Agenten oder System“ bleibt verpflichtend
  und ist ebenfalls nicht vorbelegt.

Die Ableitung ist eine Vermutung des Systems, die Antwort ist die Entscheidung
des Nutzers — und die Oberfläche darf beide nicht ununterscheidbar machen. Der
Nutzer kann in jedem Fall jede Antwort wählen, einschließlich „Ja, das stammt
von mir“.

Daraus folgt eine dauerhafte, nicht bloß übergangsweise Eigenschaft der
Architektur:

- Ein Save erzeugt **niemals automatisch** `user_asserted` — auch dann nicht,
  wenn später ein einheitliches Mutation-Audit für MCP- und HTTP-Saves
  existiert. Das Audit verbessert die Nachvollziehbarkeit und ändert an der
  Herkunftsfrage nichts.
- Die Rückfallregel auf `unknown_legacy` mit Reviewbedarf ist damit kein
  Provisorium, sondern der Normalfall des Schreibpfads.
- Der Weg zu `user_asserted` ist nicht versperrt, sondern verläuft
  ausschließlich sichtbar: über eine Entscheidung, die der Nutzer selbst
  getroffen hat und die er jederzeit widerrufen kann.

Was technisch hinter dem Klick gespeichert wird, ist Umsetzungsdetail; die
Anforderungen daran stehen im nächsten Abschnitt.

Der Grund für den Vorrang der Importprüfung ist ein Ist-Stand des Codes: Der
Vault-Import stempelt **jeden** übernommenen Inhalt mit
`write_origin: "user-directed"` — und zwar auch einen vollständig maschinell
erzeugten Navigations-Index über den Import. Ein einstufiges Mapping nach
`write_origin` würde also einen fremden Vault samt generierter Hilfsknoten
geschlossen zu Nutzeraussagen erklären. Das ist genau der Fehler, den die
Fallback-Regel verhindern soll, nur durch eine andere Tür.

Diese Ableitung bestimmt ausschließlich die **Ausgangsklasse** eines Memorys
und einen Vorschlagswert für die Oberfläche — niemals, ob es überhaupt geprüft
werden darf. Jedes Memory des gesamten Bestands ist review- und
bestätigungsfähig; das folgt zwingend aus dem Entscheid zur vollständigen
Bestandsprüfung. Ein importiertes Memory, ein `agent-session`-Memory und ein
Memory ohne `write_origin` können nach bestätigter Review ebenso
`user_asserted` werden wie jedes andere, wenn der Nutzer das so entscheidet.
Weder Importstatus noch `write_origin` schränken die Reviewberechtigung ein.
`agent-session` bedeutet lediglich, dass der Agent geschrieben hat — nicht, dass der Inhalt eine Agentenbeobachtung ist; eine vom
Nutzer diktierte Regel und eine selbstgezogene Schlussfolgerung sind darin
ununterscheidbar. Deshalb wird `agent-session` nicht nach `agent_observed`
gemappt, sondern nach `unknown_legacy`.

`confidence` wird für dieses Mapping ausdrücklich **nicht** herangezogen. Das
Feld besitzt einen Schema-Default von 1,0 und wird zwar als Metadatum in den
Suchindex aufgenommen und dort gespeichert, beeinflusst aber weder Ranking noch
Filterung noch den Evidenzentscheid. Es trägt deshalb keine Information, aus
der sich Herkunft ableiten ließe.

#### Review-Status statt Prosa-Vormerkung

Die Auflösung von `imported_unverified` und von `unknown_legacy` mit
Review-Status `pending` läuft nicht über eine unverbindliche Notiz, sondern
über ein benanntes Feld der Sidecar-Projektion:

| Feld | Werte |
|---|---|
| `provenance_review` | `pending`, `confirmed`, `rejected`, `not_scheduled` |
| `confirmed_provenance_class` | Pflichtfeld bei `confirmed`: die bestätigte Zielklasse aus der Klassentabelle |
| `provenance_reviewed_at` | Datum der Entscheidung |
| `provenance_review_ref` | Pflichtfeld bei `confirmed` und `rejected`: auflösbarer Entscheidungs- und Auditbezug |
| `provenance_review_note` | optionale Begründung |

`pending` ist der Startwert für jedes Memory, sobald es in einer Prüfstufe an
der Reihe ist — unabhängig von `write_origin` und Importstatus.

`not_scheduled` bedeutet ausschließlich **„derzeit nicht an der Reihe"** — es
ist keine Bestätigung, kein Qualitätsurteil und **keine Ausnahme von der
Prüfung**. Ein Memory mit `provenance_class: unknown_legacy` und
`provenance_review: not_scheduled` hat weiterhin unbekannte Herkunft; es steht
lediglich noch nicht an. Der frühere Name `not_required` war irreführend, weil
er nahelegte, die Frage sei geklärt; die frühere Lesart „eine Prüfung ergäbe
ohne neue Information nichts" ist mit dem Entscheid zur vollständigen
Bestandsprüfung hinfällig. `not_scheduled` bezeichnet ab hier ausschließlich die
Warteschlangenposition.

#### Der gesamte Bestand wird geprüft

Jedes Memory erhält am Ende eine geklärte Herkunft — oder ein ausdrücklich
bestätigtes „unklar". Der Unterschied zwischen einem abgeleiteten und einem
bestätigten `unknown_legacy` ist wesentlich: Das erste heißt „noch niemand hat
hingesehen", das zweite „jemand hat hingesehen und konnte es nicht klären". Nur
das zweite ist ein Ergebnis. Unterschieden werden sie über den Review-Status:
`pending` beziehungsweise `not_scheduled` gegenüber `confirmed` mit
`confirmed_provenance_class: unknown_legacy`.

Die Prüfung ist keine Liste von Hunderten Einträgen am Stück, sondern läuft in
vier Prioritätsstufen:

| Stufe | Mitgliedschaftskriterium | Begründung |
|---|---|---|
| 1 | Regeln, Präferenzen, Reflexe und gefloorte Memories | Sie wirken auf künftiges Verhalten und tragen die größte Schutzwirkung |
| 2 | Memories mit **belegter** hoher Nutzung sowie **nicht importierte** historieunbekannte Memories mit **nachweislich hoher Strukturwirkung** nach dem vorab versionierten Kriterium | Ihre Herkunft wirkt sich am häufigsten aus — entweder über die Nutzung oder über die Stellung im Graphen |
| 3 | importierte und als `imported_unverified` geführte Memories | Fremde Urheberschaft, heute pauschal ungeklärt |
| 4 | der übrige Bestand, einschließlich historieunbekannter Memories ohne hohe Strukturwirkung | sukzessive, ohne Zeitdruck |

Die Tabelle nennt **Mitgliedschaftskriterien**, nicht eine Reihenfolge: Sie
entscheidet, in welche Stufe ein Memory fällt. Innerhalb einer Stufe gilt
weiterhin keine feste Reihenfolge. Die Stufen sind eine Priorisierung der
Arbeit, keine Abstufung der Verbindlichkeit — auch Stufe 4 wird vollständig
geprüft.

Die vier Stufen sind vollständig und überschneidungsfrei. Die Zuordnung wird in
der festen Reihenfolge **1 → 3 → 2 → 4** ausgewertet, und die zuerst zutreffende
Stufe schließt jede weitere aus. Die Reihenfolge ist nicht beliebig: Stufe 1
steht vorn, weil Schutzwirkung schwerer wiegt als Nutzung; Stufe 3 steht vor
Stufe 2, weil die Importherkunft nach 6.3 Vorrang vor jedem anderen Signal hat —
ein importiertes Memory mit clusterübergreifender Verbindungsstellung bleibt
deshalb Stufe 3 und wandert nicht über das Strukturkriterium nach Stufe 2.

**Datenquelle für Stufe 2.** Die dafür nötige Pro-Memory-Nutzungstelemetrie
existiert bereits und muss nicht neu gebaut werden: Der Usage-Sidecar unter
`.bastra/usage/` führt je Memory-ID `surfaced`, `loaded` und `acted_on` samt
Zeitstempeln des jeweils letzten Ereignisses; daraus stehen eine
Heat-Berechnung und eine Reichweitenauswertung bereit. Die Priorisierung der
zweiten Stufe stützt sich auf diese Quelle.

Ein Memory **ohne** Historie im Sidecar gilt als `unknown` und ausdrücklich
nicht als `0`. Der Unterschied ist wesentlich: „nie ausgespielt worden" und
„keine Aufzeichnung vorhanden" führen zu gegensätzlichen Schlüssen, und der
Sidecar existiert erst seit einem bestimmten Stand.

Die ausführbare Konsequenz betrifft die **Stufenzuordnung**, nicht eine
Reihenfolge: Ein Memory ohne Sidecar-Historie wird weder als „nie genutzt"
gewertet noch pauschal nach Stufe 2 gezogen. Fehlende Historie ist kein
Nutzungsbeleg — sie ist gar keine Aussage über Nutzung.

Für **nicht importierte** historieunbekannte Memories, die nicht schon unter
Stufe 1 fallen, entscheidet deshalb ein **historieunabhängiges Kriterium über
die Stufenzugehörigkeit**: die **Strukturwirkung** im Graphen, also ein hoher
Verlinkungsgrad oder die Stellung als **clusterübergreifender
Verbindungsknoten**. Wer sie nachweislich besitzt, fällt in Stufe 2; wer sie
nicht besitzt, in Stufe 4.

#### Das Strukturkriterium wird vorab festgelegt

„Hohe Strukturwirkung" darf keine Ermessensfrage der Implementierung sein —
sonst verschiebt sich die Grenze zwischen Stufe 2 und Stufe 4 mit jeder
Auslegung, und die Abarbeitungsfolge zwischen den Stufen wäre nicht
reproduzierbar. Die Reihenfolge **innerhalb** einer Stufe bleibt davon unberührt
und weiterhin offen. Deshalb gilt:

**Vor dem Aufbau der Review-Warteschlange** wird aus einem **eingefrorenen
Graph-Snapshot** ein **versioniertes Strukturkriterium** bestimmt und im
Queue- beziehungsweise Run-Manifest gespeichert. Zulässige Bestandteile sind
ausschließlich:

- die Eigenschaft, **clusterübergreifender Verbindungsknoten** zu sein — der
  Knoten besitzt Nachbarn in mindestens zwei **unterschiedlichen fremden
  Clustern**; diese Eigenschaft wird von der Graph-Projektion bereits berechnet
  und im Feld `bridge` geführt;
- ein vorab festgelegter **Grad-Schwellenwert** oder ein **Grad-Quantil** über
  die Kantenzahl eines Knotens, die die Projektion ebenfalls bereits führt.

**Was das Feld `bridge` belegt — und was nicht.** Der Name des vorhandenen
Feldes legt mehr nahe, als der Code leistet, und das Dokument stützt sich
ausdrücklich nicht auf die naheliegende Lesart. `buildGraph` setzt `bridge`,
wenn ein Knoten Nachbarn in mindestens zwei unterschiedlichen fremden Clustern
besitzt (`packages/core/src/graph.ts:302`–`:305`). Geprüft wird dabei **nicht**,
ob diese Cluster ohne den Knoten tatsächlich unverbunden wären. Das Feld belegt
damit weder eine graphentheoretische Brücke — eine Kante, deren Entfernung eine
Komponente zerlegt — noch einen Artikulationsknoten, dessen Entfernung den
Graphen trennt. Es belegt genau eine Eigenschaft: **clusterübergreifende
Nachbarschaft**.

Diese Eigenschaft bleibt als Bestandteil des Strukturkriteriums zulässig, aber
ausschließlich mit dieser Bedeutung. Eine echte Artikulations- oder
Brückenanalyse wäre zusätzliche Grapharbeit — sie müsste den Zusammenhang des
Graphen ohne den jeweiligen Knoten prüfen — sie wird vom Ist-Code nicht
geleistet und in diesem Dokument nirgends behauptet. Wo im Folgenden von
**Verbindungsstellung** die Rede ist, ist stets die clusterübergreifende
Nachbarschaft gemeint, nie eine bewiesene Trennwirkung.

Der konkrete numerische Startwert — ob absoluter Schwellenwert oder Quantil und
in welcher Höhe — darf aus der read-only Verteilung des Bestands abgeleitet
werden. Er muss aber **vor der Zuordnung feststehen** und darf **während dieses
Review-Laufs nicht wandern**. Ein Kriterium, das sich mitbewegt, während der
Bestand geprüft wird, erzeugt eine Abarbeitungsfolge zwischen den Stufen, die
niemand nachvollziehen kann.

Daraus folgt die Abnahmebedingung: Jedes historieunbekannte Memory, das **weder
unter Stufe 1 noch unter Stufe 3 fällt**, muss durch das im Manifest
festgehaltene Kriterium **deterministisch genau einer** der beiden verbleibenden
Stufen zugeordnet werden können — Stufe 2 oder Stufe 4, ohne Rest und ohne
Ermessen. Gefloorte Regeln und importierte Memories ohne Nutzungshistorie sind
bereits über Stufe 1 beziehungsweise Stufe 3 erfasst; für sie stellt sich die
Frage nicht.

**Graphausfall.** Steht der Graph-Snapshot nicht zur Verfügung oder ist er
unvollständig, fällt das betroffene Memory **konservativ nach Stufe 4**. Eine
nicht belegbare Strukturwirkung ist keine Strukturwirkung; eine Höherstufung im
Zweifel würde Stufe 2 mit Memories füllen, über die nichts bekannt ist.

Dieser Fall wird **beim Aufbau der Warteschlange** entschieden. Ein späterer
Graphausfall bewegt eine bereits getroffene Zuordnung nicht — im laufenden
Review wird ohnehin nicht neu zugeordnet.

#### Der Snapshot muss die damalige Zuordnung belegen

„Eingefroren" ist keine Eigenschaft, die sich über einen Zeitstempel herstellen
lässt. Ein Zeitstempel sagt, **wann** gerechnet wurde, aber nicht, **worauf** —
und der Live-Graph verändert sich mit jedem Save, jeder neuen Verlinkung und
jeder Clusterneuberechnung. Eine Zuordnung, die nur auf einen Zeitpunkt
verweist, ist Wochen später nicht mehr überprüfbar: Wer sie nachrechnen will,
rechnet auf einem anderen Graphen und bekommt ein anderes Ergebnis. Deshalb
muss der Nachweis im Artefakt selbst liegen.

Das Artefakt liegt in derselben Sidecar-Projektion wie die Review-Felder; die
Nachweispflicht macht die Bestandsprüfung also nicht zu einem Schreibvorgang am
Memory-Inhalt. Es ist damit ein operationales Sidecar-/Run-Artefakt im Sinne von
C-018 und C-025 und darf **sofort** persistiert werden — es hängt weder an M4
noch am gesonderten Schemaentscheid aus 21.4. Erst wenn Snapshot-, Queue- oder
Reviewfelder in das Memory-Frontmatter beziehungsweise in das persistente
Memory-Schema übernommen werden sollen, greift 21.4. Das Queue- beziehungsweise
Run-Artefakt speichert mindestens:

- **Graph- und Projektionsschema samt Version** — nach welchen Regeln Cluster,
  Kanten und Grade überhaupt gebildet wurden;
- den **Snapshot-Hash** — welcher konkrete Graphzustand zugrunde lag;
- den **Erstellungszeitpunkt** des Snapshots;
- das **angewandte Strukturkriterium** samt seinem absoluten Schwellenwert oder
  seinem Quantil, im Wortlaut der versionierten Fassung;
- je zugeordnetem historieunbekannten Memory dessen **ID**, seinen **`degree`**,
  seine **fremden Cluster beziehungsweise seinen `bridge`-Wert** und die
  **resultierende Prüfstufe**.

**Zulässige Alternative.** Statt der Einzelwerte darf der vollständige Snapshot
**content-addressed persistiert** und aus dem Manifest über seinen Hash
referenziert werden. Beide Varianten sind gleichwertig, weil beide dieselbe
Bedingung erfüllen: Die damalige Zuordnung bleibt **ohne den später veränderten
Live-Graphen** nachvollziehbar. Was nicht genügt, ist ein Verweis auf „den
Graphen zum Zeitpunkt X" ohne festgehaltenen Zustand — genau das ist die Lücke,
die diese Regel schließt.

**Keine Neuberechnung im laufenden Review.** Während ein Review-Lauf offen ist,
findet weder eine Neuberechnung des Snapshots noch eine Neuzuordnung bereits
eingereihter Memories statt. Ein Memory, das beim Aufbau der Warteschlange in
Stufe 4 fiel, bleibt in Stufe 4, auch wenn es zwischenzeitlich Verlinkungen
gewinnt und nach dem aktuellen Graphen Stufe 2 erfüllen würde. Das ist gewollt:
Eine Warteschlange, die sich unter der Bearbeitung umsortiert, ist weder
abarbeitbar noch prüfbar. Neue Strukturwirkung kann sich erst in einem
**späteren** Lauf mit neuem Snapshot und neuer Kriteriumsversion auswirken.
Verloren geht dabei nichts: Auch Stufe 4 wird nach C-065 vollständig geprüft —
die Stufe entscheidet nur, wann ein Memory an die Reihe kommt, nicht ob.

**Neustart setzt fort.** Ein Neustart des Daemons oder ein Abbruch mitten im
Lauf beginnt keine neue Warteschlange, sondern setzt **dieselbe mit denselben
Zuordnungen** fort — das Manifest ist dafür die maßgebliche Quelle, nicht der
Live-Graph. Andernfalls entstünde bei jedem Neustart eine andere Reihenfolge,
und der Fortschritt der Prüfung wäre nicht mehr vergleichbar.

Ausdrücklich **nicht** als Kriterium verwendet werden Floor- und Pin-Status.
Gefloorte Memories sind bereits über Stufe 1 erfasst — sie erneut in Stufe 2 zu
führen wäre eine Doppelzuordnung. Und eine vom Floor unabhängige Pin-Quelle
existiert am HEAD nicht: Der Curator-Eingang setzt das Feld hart auf `false`,
und im Session-Hook ist „pinned" lediglich der Anzeigename des Floor-Blocks.
Ein Kriterium, das auf ein konstant leeres Feld zugreift, ist keines.

Stufe 2 hat damit zwei Mitgliedschaftswege — belegte hohe Nutzung, wo eine
Historie vorliegt, und nachgewiesene Strukturwirkung, wo keine vorliegt. Beide
sind Zugehörigkeitsfragen, keine Sortierungen.

`confirmed` darf ausschließlich durch eine ausdrückliche Nutzerentscheidung
gesetzt werden. Es benennt in `confirmed_provenance_class` die bestätigte
Zielklasse und in `provenance_review_ref` den Entscheidungs- und Auditbezug; ohne
beide Felder ist die Bestätigung unvollständig und bleibt wirkungslos.

**Eine Bestätigung gilt für genau ein Memory in genau einem Inhaltsstand.** Das
ist eine Sicherheitsanforderung und keine Umsetzungsfreiheit: Die Zustimmung zu
Memory A darf unter keinen Umständen für Memory B wirksam werden, und sie darf
auch für A nicht fortgelten, wenn sich A inhaltlich geändert hat. Daraus folgen
drei Eigenschaften des Bestätigungsbezugs:

- **Eindeutig gebunden.** Er verweist auf `memory_id` und auf einen Hash des
  **aussagetragenden Inhalts, wie er im Review dargestellt wurde**. Der Nutzer
  bestätigt, was er gesehen hat — nicht einen abstrakten Datensatz.
- **Nicht wiederverwendbar.** Er ist für genau diese eine Entscheidung gültig
  und kann nicht auf ein zweites Memory oder eine zweite Entscheidung
  angewandt werden.
- **Verfallend bei inhaltlicher Änderung.** Ändert sich der aussagetragende
  Inhalt, verliert die Bestätigung ihre Wirkung; das Memory fällt auf die
  abgeleitete Klasse zurück und erhält den Review-Status `pending`. Eine
  Umformulierung darf keine fremde Aussage unter eine alte Zustimmung schieben.

Was zum aussagetragenden Inhalt zählt, ist verbindlich abgegrenzt — sonst wäre
die Bestätigung entweder wertlos oder unbrauchbar kurzlebig:

| zählt zum Hash | zählt **nicht** zum Hash |
|---|---|
| Titel | Tags |
| Summary | `topic_path` |
| Body | `recall_when` und abgeleitete Cues |
| Typ und Scope, soweit im Review dargestellt | Ordner und Dateiort |
| die bestätigte Aussage selbst | Zeitstempel, `updated`, `last_reviewed_at` |
| | Heat, Reach und sämtliche Nutzungssignale |
| | `stale_status` und andere Projektionen |

Die rechte Spalte umfasst Retrieval-, Darstellungs- und Betriebsmetadaten. Sie
ändern sich im Normalbetrieb ständig — ein Recall-Treffer allein bewegt bereits
die Nutzungssignale. Würden sie den Verfall auslösen, wäre jede Bestätigung
binnen Stunden erloschen und die Prüfung eine Sisyphusarbeit. Umgekehrt gilt:
Ändert sich der Body, verfällt die Bestätigung — auch wenn der Titel gleich
bleibt.

Diese drei Punkte sind verbindlich; die Wahl des technischen Mittels ist es
nicht.

**Provenienz-Override-Vertrag.** Eine Bestätigung ist eine persistierte
Nutzerentscheidung und keine abgeleitete Projektion — sonst würde jede
Neuberechnung das Memory wieder auf `imported_unverified` zurückwerfen, weil die
Signale der Mapping-Stufe 1 in `source`, `topic_path` und Tags unverändert
bleiben. Sie ist
aber **kein Accessibility-Override der Klasse B** nach 14.4: Sie ändert nichts an
der Zugänglichkeit, sondern ausschließlich an der Herkunftsaussage. Dafür gilt
ein eigener Vertrag:

- Der Override wirkt allein auf `provenance_class` und überstimmt dort die
  Ableitung aus Mapping-Stufe 1 und 2 bis zum Widerruf oder bis zur inhaltlichen
  Änderung des bestätigten Memorys.
- Er ist an `confirmed_provenance_class` und `provenance_review_ref` gebunden
  und ohne diese nicht gültig.
- Er ist **jederzeit widerrufbar**: Ein Widerruf setzt `provenance_review` auf
  `rejected` oder `pending` zurück, und die abgeleitete Klasse gilt wieder.
- Er verändert weder Floors noch Pins noch Zonen und erzeugt keinen
  Klasse-B-Zustand.
- Er erlischt automatisch, sobald sich der bestätigte Inhaltsstand ändert;
  `provenance_review` fällt dann auf `pending`, und die abgeleitete Klasse gilt
  wieder (C-064).
- Er wird getrennt von Accessibility-Overrides protokolliert, damit ein
  Herkunftswiderruf keine Zugänglichkeitsentscheidung mitzieht.

Die abgeleiteten Statuswerte leben in der Sidecar-Projektion, nicht im
Markdown — sie hängen damit am selben Schemaentscheid wie die übrigen
Provenienzfelder und erzeugen vorher keine Vault-Änderung. Der bestätigte
Override selbst wird dagegen persistiert, weil er eine Nutzerentscheidung ist.

`unknown_legacy` und `imported_unverified` sind keine Vertrauensklassen,
sondern das Eingeständnis, dass die Herkunft unbekannt beziehungsweise
ungeprüft ist. Sie schützen nicht wie `user_asserted` und qualifizieren nicht
zum Überschreiben wie `derived`. Ein Memory verlässt diesen Zustand nur durch
eine ausdrückliche Nutzerbestätigung oder durch einen neuen Save mit expliziter
Klasse. Ein Massen-Rewrite des Vaults findet nicht statt.

### 6.4 Procedural / Reflex Memory

Die bestehende Reflex-Lane bleibt die prozedurale Schicht:

- deterministische Trigger;
- kleines Budget;
- keine fuzzy Selbstinjektion;
- Promotion nur nach Nutzerbestätigung;
- hohe Präzision vor Reichweite;
- jederzeit widerrufbar.

### 6.5 Historical Memory

Historical ist kein Löschzustand, sondern eine Abrufrolle:

- explizit ersetzt;
- zeitlich nicht mehr gültig;
- nur für Verlauf, Ursachenanalyse oder alte Projektstände relevant;
- über ID, Version, Zitat und Deep Recall weiterhin erreichbar;
- niemals als aktuelle Regel injizieren.

## 7. Adaptive Memory Accessibility

### 7.1 Definition

Accessibility ist ausdrücklich keine sechste Dämpfungsschicht. Wenn sie nach
erfolgreicher Evaluation live geht, vereinheitlicht und erklärt sie die
langfristigen Memory-Mechanismen, die heute getrennt als Staleness,
Curator-Demotion, Floors, Salience, Gültigkeit und später gegebenenfalls
Confidence wirken. Diese Mechanismen dürfen dann nicht zusätzlich noch einmal
unabhängig denselben Score multiplizieren.

Session-Dedup, Empty-Streak-Backoff und Turn-Kontext bleiben getrennte
Aufmerksamkeits- und Ausspielmechanismen. Sie beschreiben nicht die
Langzeitzugänglichkeit eines Memorys und fließen deshalb nicht in dessen
Accessibility ein.

Jedes Memory erhält eine berechnete `accessibility` zwischen 0 und 1. Sie ist
keine dauerhaft gespeicherte Wahrheit, sondern eine reproduzierbare Projektion
aus stabilen Feldern und Nutzungsdaten.

```text
accessibility =
    type_durability
  + successful_use_reinforcement
  + bounded_salience
  + source_confidence
  + explicit_floor
  + recent_verification
  - time_decay
  - repeated_non_use
  - contradiction_penalty
  - superseded_penalty
```

Die Formel beschreibt zunächst die Signalgruppen, nicht bereits eine
implementierte Score-Funktion. Exakte Gewichte, Zonen und selbst die Frage, ob
eine kontinuierliche Zahl stabiler ist als erklärbare Zustände, werden erst in
M3 entschieden. Die zugehörige V1.x-Stufe beginnt ausschließlich als read-only
Projektion im Sidecar und Mindspace.

### 7.2 Positive Signale

- expliziter Floor oder Pin;
- erfolgreicher `loaded` → `acted_on`-Pfad;
- wiederholte erfolgreiche Verwendung in verschiedenen Kontexten;
- aktuelle inhaltliche Bestätigung oder Aktualitätsreview — nicht die
  Provenienz-Review nach 6.3, die keine Zugänglichkeitswirkung hat;
- hohe und belegte Quellen-Confidence;
- moderat begrenzte Salience;
- explizite Nutzeranweisung;
- aktive Abhängigkeit durch eine aktuelle Decision oder einen Workflow.

### 7.3 Negative Signale

- explizites `superseded_by`;
- abgelaufene Gültigkeit;
- bestätigter Widerspruch;
- wiederholt ausgespielt, aber nicht geladen;
- geladen, danach verworfen oder korrigiert;
- lange nicht erfolgreich verwendet;
- veralteter Projektstand;
- geringe oder unbekannte Quellenqualität.

Nichtladen ist nur ein schwaches negatives Signal. Das System kann nicht sicher
beobachten, ob ein Hinweis indirekt geholfen hat. Eine explizite Korrektur oder
ein nachweislich ersetzender Claim ist deutlich stärker.

### 7.4 Harte Regeln

- Alter allein darf kein Memory löschen oder historisch erklären.
- Floors verhindern das automatische Absinken in den Asteroidengürtel.
- `user-directed` darf nicht automatisch inhaltlich verändert werden.
- Salience darf fehlende Query-Relevanz nicht überstimmen.
- Ein ungültiges Memory darf durch hohe Usage nicht wieder „aktuell“ werden.
- Exakte ID-, Zitat- und Versionsabrufe umgehen den Accessibility-Floor.
- Accessibility beeinflusst spontane Zugänglichkeit, nicht Datenexistenz.

### 7.5 Accessibility-Zonen

Die folgenden Grenzen sind Startbereiche für die Evaluation, keine endgültigen
Produktkonstanten:

| Accessibility | Zone | Verhalten |
|---:|---|---|
| 0,80–1,00 | Core | bei hoher Query-Relevanz spontan injizierbar |
| 0,50–0,79 | Orbit | normaler Recall |
| 0,20–0,49 | Outer Orbit | nur bei deutlicher Query-Übereinstimmung |
| 0,00–0,19 | Asteroidengürtel | keine automatische Injektion; Deep Recall |
| explizit ersetzt | Historical | nur zeitlich/historisch oder über Nachfolger |

Die Zonen dürfen nicht direkt aus Alter berechnet werden. Sie entstehen aus der
gesamten Accessibility-Funktion.

## 8. Asteroidengürtel und Deep Recall

### 8.1 Bedeutung

Der Asteroidengürtel visualisiert Erinnerungen, deren spontane Zugänglichkeit
stark gesunken ist. Er ist:

- kein Papierkorb;
- kein Löschzustand;
- kein separates Wahrheitsarchiv;
- vollständig durchsuchbar;
- bewusst von automatischer Kontextinjektion getrennt.

Er entspricht dem menschlich vertrauten Zustand:

> „Ich weiß, da war etwas, aber ich muss tiefer danach suchen.“

### 8.2 Visuelle Darstellung im Mindspace

- Core-Memories liegen hell und zentral.
- Orbit-Memories bilden die regulären Systeme und Galaxien.
- Outer-Orbit-Memories werden kleiner, dunkler und weiter außen dargestellt.
- Dormante Memories bilden einen Asteroidengürtel um die aktive innere Galaxie.
- Saliente Memories behalten einen erkennbaren farbigen Kern.
- Ersetzte Memories erscheinen gebrochen oder transparent und zeigen eine
  gerichtete Verbindung zum Nachfolger.
- Widersprüche erscheinen als gespannte oder farblich abgesetzte Kante.
- Beim Öffnen eines Memories wird der Accessibility-Grund erklärt.

Beispiel:

```text
Asteroidengürtel
  accessibility: 0,14
  letzter erfolgreicher Einsatz: vor 214 Tagen
  surfaced: 11
  loaded: 1
  acted_on: 0
  Status: dormant, nicht veraltet
```

### 8.3 Interaktion

Der Nutzer kann den Gürtel bewusst betreten:

- „Tiefer suchen“;
- „Auch verblasste Erinnerungen durchsuchen“;
- „Ich weiß, dass wir dazu früher etwas hatten“;
- Klick auf den Asteroidengürtel im Mindspace.

Beim Eintritt wird sichtbar, dass sich die Retrieval-Tiefe ändert:

1. normale Ergebnisse bleiben als Referenz erhalten;
2. dormante Ergebnisse erscheinen schrittweise;
3. alte Versionen und Episoden werden gruppiert;
4. Beziehungen und Widersprüche werden erklärt;
5. der Nutzer kann einen Treffer reaktivieren, bestätigen oder historisch
   belassen.

### 8.4 Technischer Deep-Recall-Pfad

Deep Recall:

1. öffnet den Dormant-Filter;
2. erhöht den Kandidatenpool;
3. aktiviert Query-Expansion und Sprach-Bridges;
4. durchsucht Episoden und Historical Memories;
5. erlaubt kontrollierte typed Graph Traversal;
6. verwendet einen stärkeren lokalen Reranker, sofern verfügbar;
7. gruppiert nach Zeit, Entity, Claim und Version;
8. liefert genau einen der vier Ergebniswerte aus 8.5 — `answer_found`,
   `no_answer` nur bei deterministischer Erschöpfung, sonst
   `inconclusive_budget_exhausted` beziehungsweise `inconclusive_interrupted`;
   ein Controllerdefekt wird stattdessen als `DeepRecallDefect` signalisiert
   und ist kein Ergebnis.

Deep Recall darf langsamer sein als Normal Recall. Er ist eine bewusste
Interaktion, kein impliziter Hook-Hot-Path.

### 8.5 Zwei Stufen statt „dasselbe Retrieval mit größerem k“

Deep Recall ist ausdrücklich kein Normal Recall mit erhöhtem `k`, gesenktem
Floor und mehr Tokens. Er hat zwei klar getrennte Stufen:

**Stufe 1 – strukturierter Deep Recall, deterministisch.** Dormant-Filter,
größerer Kandidatenpool, Query-Expansion und Bridges, Zeit- und Scope-Manifest,
exakte Identifier, gruppierte Ausgabe nach Zeit, Entity, Claim und Version.
Reproduzierbar, ohne Agentenschleife, im Sekundenbereich.

**Stufe 2 – agentischer Deep Recall, iterativ.** Zerlegung der Query in
Teilfragen, sichtbarer Suchbaum, gezielte Kombination von exakter, lexikalischer,
semantischer, zeitlicher und Graph-Suche je Ast, Markierung von Sackgassen,
Evidenzsammlung über IDs und Quellen, Konvergenzerkennung, Budgetmanager und
ausschließlich bewusst bestätigte Budgetverlängerung.

Beide Stufen liefern ihren Suchpfad mit. Die Abbruchbedingungen von Stufe 2 sind
explizit, ausführbar und nicht verhandelbar.

**Budgetgrenzen.** Jeder Deep-Recall-Lauf startet mit einem versionierten
Grenzwertsatz. Die konkreten Zahlen werden nach dem M0-Baseline-Run festgelegt
und gemeinsam mit der Konfiguration versioniert abgelegt; die Größen selbst sind
verbindlich:

| Grenze | Art | Wirkung bei Erreichen |
|---|---|---|
| maximale Laufzeit | hart | Lauf endet |
| maximales Tokenbudget | hart | Lauf endet |
| maximale Zahl offener Äste | weich | keine neuen Äste mehr |
| maximale Tiefe je Ast | weich | Ast wird geschlossen |
| maximale Zahl Provider-Aufrufe | weich | kein semantischer Arm mehr |
| maximale Zahl betrachteter Kandidaten | weich | kein Poolausbau mehr |

Harte Grenzen beenden den Lauf sofort. Weiche Grenzen beenden ihn nicht,
sondern verengen den Suchraum — und genau darin liegt eine Falle: Wenn wegen
einer erreichten weichen Grenze keine neuen Äste mehr geöffnet werden, kann der
Suchbaum formal leerlaufen, ohne dass der Vault ausgeschöpft wurde. Der
Controller merkt sich deshalb, ob eine weiche Grenze gegriffen hat.

**Evidenzgewinn.** Ein Schritt gilt genau dann als ertragreich, wenn er
mindestens eine bisher nicht gesehene Evidenz-ID liefert oder mindestens eine
offene Teilfrage beantwortet. Ein Schritt, der nur bereits bekannte IDs erneut
findet, zählt als ertraglos — unabhängig davon, wie hoch die Scores sind.

**Abbruch auf zwei Ebenen.** Ast und Lauf enden nach verschiedenen Regeln, und
die Verwechslung beider wäre folgenreich:

*Ast-Ebene.* Zwei aufeinanderfolgende Schritte ohne Evidenzgewinn schließen
**den betroffenen Ast**. Sie beenden nicht den Lauf. Solange andere Äste offen
sind, arbeitet der Controller dort weiter — ein einzelner erschöpfter Zweig
sagt nichts über den Rest des Suchbaums.

*Lauf-Ebene.* Der Lauf endet, wenn eine der folgenden Bedingungen eintritt:

0. **ausreichende, validierte Evidenz gefunden** — alle Teilfragen sind mit
   belastbarer, gegen die Evidenzregeln aus Abschnitt 10 geprüfter Evidenz
   beantwortet;
1. jede Teilfrage ist beantwortet oder aufgegeben und **kein zulässiger Ast ist
   mehr offen**, ohne dass eine weiche Grenze gegriffen hat — deterministische
   Erschöpfung;
2. eine **harte** Grenze ist erreicht;
3. der Suchbaum ist leergelaufen, **nachdem** eine weiche Grenze gegriffen hat;
4. der Lauf wurde ohne erreichte Grenze **von außen beendet** — Nutzerabbruch,
   Shutdown oder Widerruf der Freigabe.

Bedingung 0 ist der Erfolgsfall und wurde in der Vorfassung stillschweigend
vorausgesetzt; sie steht hier ausdrücklich, damit der Vertrag alle Ausgänge
abdeckt. Bedingung 1 ist die einzige, die eine negative Aussage über den Vault
erlaubt. Bedingung 3 sieht ihr von außen zum Verwechseln ähnlich — der Baum ist
in beiden Fällen leer —, sagt aber nur, dass der Controller nicht weitersuchen
durfte.

**Priorität bei Gleichzeitigkeit.** Fallen im selben Schritt der Eintritt von
**Endbedingung 0** — also die vollständige Beantwortung aller Teilfragen mit
validierter Evidenz — und das Erreichen einer Grenze zusammen, **gewinnt
Endbedingung 0**: Der Lauf endet mit `answer_found`. Die Evidenz ist gesammelt
und validiert; sie zu verwerfen, weil im selben Moment das Budget auslief, würde
Arbeit wegwerfen und dem Nutzer einen schlechteren Ausgang melden, als
tatsächlich erreicht wurde. Die erreichte Grenze wird dabei nicht
unterschlagen, sondern im Ergebnis mitgeführt.

Ein einzelner neuer Evidenztreffer, der Endbedingung 0 **nicht** erfüllt, ist
kein Fund im Sinne dieser Regel. Sind noch Teilfragen offen, endet der Lauf an
der Grenze mit `inconclusive_budget_exhausted`; die bereits gesammelte Evidenz
wird im Ergebnis mitgeführt, aber nicht als Antwort ausgegeben.

**Vier unterscheidbare Ergebnisse.** Der Ausgang wird nie zusammengefasst:

| Ergebnis | Endbedingung | Bedeutung |
|---|---|---|
| `answer_found` | 0 | belastbare, validierte Evidenz gefunden und mit Suchpfad ausgegeben |
| `no_answer` | 1 | die Suche war **deterministisch ausgeschöpft** und lieferte keine ausreichend vollständige, entscheidungsfähige Antwort |
| `inconclusive_budget_exhausted` | 2 oder 3 | eine Budget- oder Ressourcengrenze wurde tatsächlich erreicht; über das Vorhandensein von Evidenz ist nichts ausgesagt |
| `inconclusive_interrupted` | 4 | der Lauf wurde ohne erreichte Grenze von außen beendet; über das Vorhandensein von Evidenz ist nichts ausgesagt |

`no_answer` setzt Bedingung 1 voraus und nichts sonst. Jeder andere nicht
erfolgreiche Ausgang ist **inconclusive** — auch dann, wenn mehrere Äste
nacheinander ohne Gewinn geschlossen wurden und der Baum am Ende leer aussieht.

Die beiden inconclusive-Werte werden nicht vermischt:

- `inconclusive_budget_exhausted` ist ausschließlich zulässig, wenn eine der
  sechs Grenzen aus der Budgettabelle **tatsächlich erreicht** wurde. Das Feld
  `limit` benennt sie: Laufzeit, Tokens, Äste, Tiefe, Provider-Aufrufe oder
  Kandidaten. Ein Sammelwert `other` existiert nicht mehr — er hätte jeden
  beliebigen Abbruch als Budgetproblem ausgegeben.
- `inconclusive_interrupted` gilt ausschließlich für **reguläre externe
  Unterbrechungen**. Das strukturierte Feld `stop_reason` benennt die Ursache:
  `user_cancelled`, `shutdown` oder `permission_revoked`.

**Ein Controllerdefekt ist kein Ergebnis.** Ein Lauf, der stehen bleibt, während
noch Äste offen sind und keine Grenze gegriffen hat, hätte weitersuchen müssen.
Das ist ein Fehler der Implementierung und kein Zustand des Vaults — er gehört
deshalb weder unter die Ergebniswerte noch unter `stop_reason`. Er wird als
**strukturierter Schnittstellenfehler** signalisiert.

Damit der Aufrufer trotzdem eine ehrliche Diagnose erhält, darf dieser Fehler
einen **read-only Teilzustand** mitführen:

```ts
interface DeepRecallDefect {
  error: "controller_defect";
  defect_id: string;          // interne Defektkennung für die Telemetrie
  partial: {
    evidence: EvidenceRef[];  // bisher gesammelte Evidenz
    search_path: BranchNode[];
    open_branches: number;
    limits_reached: string[]; // ggf. bereits erreichte weiche Grenzen
  };
}
```

Der Teilzustand ist ausdrücklich **kein Ergebnis**: Er wird nicht in die
Abstention- oder Erfolgsstatistik gezählt, nicht als Antwort ausgegeben und
nicht in einen der vier Ergebniswerte übersetzt. Er dient der Diagnose und
nichts sonst.

`no_answer` trägt in diesem Objekt eine **stärkere Nachweispflicht** als der
gleichnamige Wert des Evidenzentscheids aus 10.3: Dort bedeutet er, dass die
vorhandene Evidenz für keine Ausspielung reicht; hier, dass die Suche
deterministisch ausgeschöpft war. Die beiden Werte werden nicht ineinander
übersetzt und nicht gegeneinander aufgerechnet.

**`no_answer` heißt nicht „keine Evidenz".** Es heißt: nach vollständiger,
deterministischer Erschöpfung liegt **keine ausreichend vollständige
beziehungsweise entscheidungsfähige Antwort** vor. Partielle belastbare Evidenz
kann dabei sehr wohl existieren — etwa wenn drei von fünf Teilfragen beantwortet
sind. Sie wird dann als solche ausgewiesen und nicht verschwiegen: Das
Ergebnisobjekt führt sie in `evidence` mit und benennt in
`unresolved_subquestions` die offen gebliebenen Teilfragen sowie in `coverage`
den Anteil beantworteter Teilfragen. Ein `no_answer` mit `coverage: 0.6` ist
eine andere Aussage als eines mit `coverage: 0` — und der Nutzer hat Anspruch
auf diesen Unterschied.

**Fehler bleiben Fehler.** Transportfehler, Zeitüberschreitungen der Verbindung,
Deserialisierungsfehler und interne Ausnahmen sind **keine** Recall-Ergebnisse.
Sie werden als Fehler der jeweiligen Schnittstelle signalisiert und niemals in
`no_answer` oder einen der beiden inconclusive-Werte übersetzt. Ein Aufrufer
muss unterscheiden können, ob der Vault nichts hergab oder ob die Anfrage nicht
zu Ende lief.

Ein Budgetabbruch darf niemals als `no_answer` ausgegeben werden. Beides sähe
für den Nutzer ähnlich aus, bedeutet aber das Gegenteil: Das eine ist eine
Aussage über den Vault, das andere eine Aussage über die Suchkosten. Die
Verwechslung würde zusätzlich die Abstention-Metriken aus 18.2 und die
Deep-Recall-Kennzahlen aus 18.4 verfälschen, weil abgebrochene Läufe dort als
korrekte Enthaltung gezählt würden.

Bei `inconclusive_budget_exhausted` bleibt die bewusste Budgetverlängerung die
einzige Fortsetzung; sie erfolgt nie automatisch.

**Oberflächenvertrag.** Das Ergebnis ist ein explizites Aufzählungsfeld in
einem eigenen Ergebnisobjekt, nicht eine Formulierung im Antworttext:

```ts
interface DeepRecallResult {
  outcome:
    | "answer_found"
    | "no_answer"
    | "inconclusive_budget_exhausted"
    | "inconclusive_interrupted";
  /** 0 = Evidenz gefunden, 1 = erschöpft, 2 = harte Grenze,
   *  3 = leergelaufen nach weicher Grenze,
   *  4 = ohne erreichte Grenze von außen beendet. */
  end_condition: 0 | 1 | 2 | 3 | 4;
  /** Pflicht bei outcome === "inconclusive_budget_exhausted".
   *  Zusätzlich gesetzt bei "answer_found", wenn im selben Schritt eine
   *  Grenze erreicht wurde — der Fund gewinnt, die Grenze bleibt sichtbar. */
  limit?: "runtime" | "tokens" | "branches" | "depth" | "provider_calls" | "candidates";
  /** Pflicht bei outcome === "inconclusive_interrupted".
   *  Ein Controllerdefekt gehört NICHT hierher — siehe DeepRecallDefect. */
  stop_reason?: "user_cancelled" | "shutdown" | "permission_revoked";
  evidence: EvidenceRef[];
  /** Offen gebliebene Teilfragen; bei no_answer aussagekräftig.
   *  Stufe 1 zerlegt nicht — dort gilt die Query selbst als einzige
   *  Teilfrage, das Feld ist also leer oder enthält genau sie. */
  unresolved_subquestions: string[];
  /** Anteil beantworteter Teilfragen, 0–1. In Stufe 1 folglich 0 oder 1. */
  coverage: number;
  search_path: BranchNode[];
  open_branches: number;
}
```

Dieses Objekt wird **unverändert** durch MCP, REST, CLI und Mindspace geführt.
Für jede dieser Oberflächen gilt:

- alle vier `outcome`-Werte bleiben unterscheidbar, und `end_condition`,
  `limit` sowie `stop_reason` werden unverändert mitgeführt;
- ein Budgetstatus wird weder durch HTTP- oder MCP-Fehlerbehandlung noch durch
  UI-Text in `no_answer` umgewandelt;
- ein Transport- oder interner Fehler ist keiner der vier Werte, sondern ein
  Fehler der jeweiligen Schnittstelle; ein Controllerdefekt wird als
  strukturierter Fehler mit read-only Teilzustand signalisiert und nie als
  Ergebnis;
- `unresolved_subquestions` und `coverage` werden bei `no_answer` mitgeführt,
  damit partielle Evidenz sichtbar bleibt;
- keine Oberfläche fasst die beiden inconclusive-Werte zu einem zusammen; wo
  eine Oberfläche nur einen Text zeigt, bleibt die Unterscheidung mindestens in
  der strukturierten Antwort und in der Telemetrie erhalten.

Die Hooks sind **kein Konsument des Deep Recall** — weder Stufe 1 noch Stufe 2
wird aus einem Hook gestartet; beide sind laut 8.4 bewusste Interaktionen und
mit dem PreTool-Budget aus 18.3 ohnehin unvereinbar. Der Oberflächenvertrag
berührt die Hook-Antwort deshalb nicht.

Ohne diese Bedingungen ist Stufe 2 nicht freigabefähig. Ein Deep Recall, der
ohne Abbruchkriterium läuft, ist kein Feature, sondern ein Kostenrisiko.

Die Stufung folgt einer belegten Messung aus dem Umfeld agentischer
Erfahrungsspeicher: Dort erreicht ein strukturierter Mehrpool-Ansatz rund
58,6 % bei etwa 27 Sekunden pro Query, während die vollständig agentische
Variante rund 74,9 % bei 108 bis 140 Sekunden erreicht. Beides sind
Eigenmessungen der Autoren auf ihrem eigenen Benchmark und damit kein Zielwert
für Bastra (siehe 2.3). Verwertbar ist die Struktur der Aussage: Der Aufpreis
der Agentenschleife ist erheblich und muss bei Bastra gegen Stufe 1 einzeln
nachgewiesen werden, statt als gegeben angenommen zu werden.

## 9. Adaptive Retrieval Controller

Der Controller entscheidet nicht nur, was rankt, sondern welcher Abrufpfad
überhaupt nötig ist.

### 9.1 Eingaben

- Query;
- Tool-Intent;
- Working Memory;
- Projekt und Scope;
- Dateien, Symbole und Entities;
- Zeitbudget;
- Tokenbudget;
- gewünschte Recall-Tiefe;
- Vault-Größe und Indexgesundheit;
- verfügbare lokale Modelle;
- bisherige Trefferstärke und Abstention-Signal.

### 9.2 Routing

```text
Exact ID / citation / filename
  -> direct lookup + BM25 evidence

Hard reflex trigger
  -> deterministic reflex lane

Clear lexical query
  -> BM25 first

Ambiguous or paraphrased query
  -> BM25 + semantic lane

Large vector set
  -> selected vector backend: Flat or HNSW

Explicit deep-memory intent
  -> full Deep Recall including Asteroidengürtel
```

### 9.3 Normal-Recall-Kaskade

1. Query normalisieren.
2. Working-Memory-Kontext und harte Filter bestimmen.
3. Exakte IDs, Symbole, Pfade und Reflex-Trigger prüfen.
4. BM25 ausführen.
5. Lexikalische Evidenz bewerten.
6. Bei eindeutigem Ergebnis semantischen Arm überspringen.
7. Bei Mehrdeutigkeit oder Paraphrase Vector Search ausführen.
8. Kandidaten zusammenführen, ohne Score-Räume vorzutäuschen.
9. Top-Kandidaten optional lokal reranken.
10. Duplikate und nahe Varianten diversifizieren.
11. Kandidaten per deterministischem Evidenzentscheid als `required`,
    `optional` oder `no_answer` klassifizieren.
12. Bei unzureichender Evidenz abstain.
13. Nur ein begrenztes Ergebnis- und Tokenbudget ausspielen.

Eine kalibrierte Wahrscheinlichkeit ersetzt diesen Schritt erst später, wenn
M0/M1 einen unabhängigen, versionierten Goldbestand und genügend
Kalibrierungsfälle bereitstellen.

### 9.4 Deadline-Verhalten

- BM25 ist der garantierte schnelle Pfad.
- Semantische Suche erhält ein eigenes Teilbudget.
- Bei Deadline wird ein Vector-Aufruf abgebrochen oder ignoriert.
- Ein unvollständiger Hybridpfad darf nicht so tun, als wäre er vollständig.
- Der Response kennzeichnet `lexical_only`, `hybrid`, `degraded` oder
  `deep_recall`.
- Hooks blockieren nie auf einen langsamen Reranker.
- Ein Cross-Encoder läuft grundsätzlich nicht im PreTool- oder
  SessionStart-Budget. Er bleibt auf Deep Recall und auf Läufe mit
  nachweislich freier Restlatenz beschränkt. Vergleichbare Fremdsysteme
  reranken jeden Recall mit einem Cross-Encoder; sie haben aber auch kein
  Hook-Budget von 150 ms einzuhalten.

## 10. Relevanzevidenz, Abstention und spätere Kalibrierung

### 10.1 Neues Ergebnisobjekt

Rohe Suchscores bleiben Diagnosewerte. Die konsumierbare Entscheidung verwendet
in V1.0 keine vorgetäuschte Wahrscheinlichkeit, sondern einen
deterministischen, erklärbaren Evidenzentscheid:

```ts
interface RecallDecisionHit {
  id: string;
  decision: "required" | "optional" | "no_answer";
  abstain_reason?: string;
  evidence: {
    exact_identifier: boolean;
    recall_when_coverage: number;
    lexical_rank?: number;
    lexical_score?: number;
    vector_rank?: number;
    vector_similarity?: number;
    arm_agreement: boolean;
    scope_match: boolean;
    temporal_status: string;
    source_confidence?: number;
  };
  // Erst nach unabhängiger Kalibrierung und ausreichenden Labels:
  relevance_probability?: number;
  // Erst ab der später gegateten Accessibility-Stufe:
  accessibility?: number;
}
```

Die vorhandenen `acted_on`-Ereignisse reichen nicht, um eine
Relevanzwahrscheinlichkeit zu behaupten: Das aktuelle Signal ist ein
Token-Overlap-Proxy und das 30-Tage-Fenster enthält nur eine kleine Zahl
positiver Hook-Episoden. `relevance_probability` bleibt deshalb absent, bis M0
ein unabhängiges Goldset und eine echte Kalibrierungsmessung bereitstellt.

### 10.2 Evidenzsignale nach Reifestufe

Für V1.0 verfügbar oder innerhalb des freigegebenen Releasevertrags
deterministisch ableitbar:

- vollständige und partielle `recall_when`-Abdeckung;
- Phrase statt beliebigem Einzelwort;
- exakte Identifier-, Pfad-, Symbol- und Entity-Matches;
- scope- und projektspezifische Übereinstimmung;
- normalisierte BM25-Evidenz;
- tatsächliche Vector Similarity;
- Rangübereinstimmung der Arme;
- Query-Typ;
- Quellenqualität; belegte Quellen-Confidence erst nach dem Schemaentscheid aus
  21.4, da das heutige `confidence`-Feld einen Default von 1,0 trägt und keine
  Herkunfts- oder Qualitätsinformation enthält (siehe 6.3);
- temporale Gültigkeit;
- erfolgreiche historische Nutzung;
- Neuheit und Duplikatgrad.

Erst in späteren, gesondert freizugebenden V1.x-/V2-Stufen:

- Accessibility nach bestandenem M3-Gate;
- Typed Graph Evidence nach eingeführtem und evaluiertem Kantenschema;
- Treffer auf abgeleiteten Cues nach bestandener Cue-Ablation und gesondertem
  Repräsentationsentscheid gemäß 11.4.

Ein Treffer auf einem abgeleiteten Cue öffnet höchstens den Kandidatenpfad zur
eigentlichen Evidenz. Er begründet für sich genommen niemals `required` und
wird nie selbst als Beleg ausgegeben.

### 10.3 Entscheidungen

Produktsemantik von V1.0:

- `required`: harter Anker oder mehrere voneinander unabhängige,
  deterministisch belegte Signale;
- `optional`: plausible Relevanz, aber keine sichere Pflicht;
- `no_answer`: die vorhandene Evidenz reicht für keine Ausspielung.

`deep-only` und `historical` kommen erst mit der gegateten Accessibility- und
Deep-Recall-Stufe hinzu.

Die alten absoluten Schwellen `30` und `100` werden nicht auf die neue Semantik
übertragen.

**Präzisierung der Required-Bedingungen (C-086).** Beide Wege zu `required`
waren zu weit gefasst, und der Fehler lag jeweils in der Begründungsqualität,
nicht in der Trefferqualität.

*Unabhängige Signale.* Die Zwei-von-drei-Zählung — Trigger-Abdeckung,
Rangübereinstimmung der Arme, Scope-Treffer — wertete bisher jede Abdeckung
über null als Signal. Ein einziger zufällig geteilter Term genügte damit als
eine der beiden Säulen einer Pflicht. Das Teilabdeckungs-Signal zählt künftig
erst **ab 50 % Abdeckung der Anfrageterme durch den handgeschriebenen
Trigger**. Die vollständige Abdeckung bleibt unverändert harter Anker.

> Ersetzte Lesart: ~~das Teilabdeckungs-Signal zählt, sobald ein Anfrageterm im
> `recall_when` vorkommt (`recall_when_coverage > 0`)~~.

*Harter Anker.* Der exakte Identifier-, Pfad- und Symboltreffer suchte bisher
auch im **Body** des Memorys. Ein Bezeichner, der irgendwo im Fließtext
vorkommt — in einem Codeblock, einem Zitat, einer Aufzählung von Dateien —,
begründete damit allein eine Pflicht. Der Anker liest künftig **Titel,
`recall_when` und Frontmatter**; der Body zählt nicht mehr.

> Ersetzte Lesart: ~~der Identifier-Heuhaufen umfasst Titel, `recall_when` und
> den Memory-Body~~.

Die Begründung ist die Trennung, die 10.2 ohnehin zieht: Titel, Trigger und
Frontmatter sind autorisierter Text, den jemand als Abrufsignal geschrieben
hat. Prosa im Body ist Inhalt. Ein Treffer dort belegt, dass das Memory das
Thema erwähnt — nicht, dass es für diese Anfrage zuständig ist. Wer den Body
als Anker liest, verwechselt Erwähnung mit Zuständigkeit.

**Messgrundlage.** Beide Verengungen sind vor der Änderung beziffert worden
(Läufe `2026-08-29-0e1dd5659433` und `2026-08-29-f5d803104893`, zehn
Gold-Dateien, 679 Fälle, alle Varianten auf demselben servierten Pool). Das
Anti-Query-Gate fällt von 50 % auf 12,5 % Fehlinjektion. Recall@3 gegated
(0,4743 gegen 0,4777 ungegated), Recall@3 auf Identifier-Queries (0,7429) und
die Falsch-Abstention (0,0000) sind in **allen** geprüften Varianten
unverändert: Keine der Verengungen nimmt den Goldtreffer aus den ersten drei
Rängen. Die Abdeckungsschwelle wirkt zudem längenneutral — der Pflichtrückgang
liegt über alle Query-Längen zwischen 58 % und 65 % —, während die geprüfte
Alternative „mindestens zwei getroffene Terme" genau dort kaum greift, wo die
Evidenz am schwächsten ist: 12 % Rückgang bei elf und mehr Termen.

Vom Body-Anker hingen 361 Pflichten ab. 49 von ihnen entfallen, die übrigen 312
bleiben Pflicht, tragen ihre Begründung aber jetzt aus der Zwei-von-drei-Zählung
statt aus einem Fund im Fließtext.

**Was diese Messung nicht zeigt.** Zwei Vorbehalte gehören zum Entscheid und
werden nicht wegformuliert. Erstens ist die 5-%-Schwelle des Anti-Query-Gates
auf acht Proben gar nicht darstellbar: Erreichbar sind nur 0 %, 12,5 %, 25 %
und so fort, die Schwelle liegt zwischen den ersten beiden Werten. Ob die
verengte Fassung sie hält, kann dieser Probensatz nicht beantworten; die
Probenmenge wird auf etwa zwanzig Anti-Queries erweitert. Zweitens ist der
Goldsatz blind für die Kosten des Pflichtverlusts: Gemessen wird, ob der
Goldtreffer auf Rang ≤ 3 überlebt, nicht ob die Memories, die keine Pflicht mehr
sind, in einer Sitzung genützt hätten. Beide Verengungen zusammen streichen
71 % aller Pflichten. Diese Kosten sieht erst die Shadow-Telemetrie nach dem
Deploy — die Entscheidung wird bewusst unter diesem Vorbehalt getroffen.

### 10.4 Training und Kalibrierung

Stufen:

1. deterministischer, erklärbarer Regelentscheid;
2. Shadow-Logging seiner Entscheidungen;
3. unabhängiges, versioniertes Goldset und kontrollierte Consumer-Experimente;
4. Offline-Kalibrierung erst bei ausreichenden und geeigneten Labels;
5. erst danach optional ein logistisches Modell oder kleiner Gradient-Booster;
6. `relevance_probability` nur bei nachgewiesener Kalibrierung ausgeben;
7. kein autonomes Online-Lernen ohne Rollback und Drift-Überwachung.

`surfaced-but-not-loaded` ist höchstens ein weak negative. `acted_on` ist
stärker, aber noch kein Goldlabel. Explizite Korrektur, Re-Query,
Nutzerverwerfung und unabhängig gelabelte Relevanz sind belastbarere Signale.

## 11. Embedding- und Vektorarchitektur

### 11.1 Feldbewusste Repräsentation

Ein einzelner monolithischer Vektor vermischt „wann soll das feuern?“ und „worum
geht es?“. V2 trennt:

#### Cue Vector

- `recall_when`;
- Titel;
- Tags;
- Aliases;
- Entities;
- Symbole;
- optional geprüfte `recall_when_expanded`.

#### Content Vector

- Summary;
- semantische Claims;
- Body-Chunks;
- Dokumentabschnitte;
- episodischer Kontext.

#### Struktur bleibt Filter

- Scope;
- Type;
- Zeit;
- Sensitivity;
- Accessibility-Zone;
- Historical-Status.

Strukturelle Felder werden nicht nur in Freitext eingebettet, sondern vor oder
während der Suche gefiltert.

### 11.2 Chunking

- lange Bodies werden abschnittsweise eingebettet;
- jeder Chunk behält Memory-ID, Heading und Offset;
- Memory-Ranking aggregiert Chunk-Evidenz;
- ein einzelner zufälliger Body-Anfang repräsentiert nicht mehr das gesamte
  Dokument;
- Ergebnis lädt weiterhin das Memory, nicht unkontrolliert alle Chunks.

Offline-Messungen und eine Chunking-on/off-Ablation auf langen Bodies sind
jederzeit zulässig. M2 testet Chunking nicht und kann es daher nicht
freigeben. Eine persistente Änderung der Vektor-/Indexrepräsentation durch
Cue-/Content-Dual-Vektoren oder Chunking benötigt einen gesonderten
Repräsentationsentscheid auf Basis dieser Ablationen; eine Live-Aktivierung
benötigt anschließend das zugehörige Qualitäts- und Migrationsgate.

### 11.3 Query-Embedding-Cache

- eigener Cache unabhängig vom finalen Recall-Response;
- Schlüssel enthält Modell, Dimension und normalisierte Query;
- begrenzte LRU-Größe;
- sichere Invalidierung bei Modellwechsel;
- SessionStart-Queries können vorgewärmt werden;
- keine dauerhafte Speicherung sensibler Query-Texte ohne explizite Entscheidung.

### 11.4 Cue-Schicht und Vertrauensklassen

Cue und Evidenz sind verschiedene Dinge. Ein Cue beantwortet „wann soll das
auftauchen?“, die Evidenz beantwortet „was steht da und warum stimmt es?“.
`recall_when` ist bereits heute ein handgeschriebener Zukunftscue, trägt im
BM25-Index das höchste Feldgewicht und bleibt die primäre autorisierte
Cue-Quelle. Es wird nicht ersetzt und nicht abgeschafft.

Zusätzliche Cues dürfen abgeleitet werden. Vier Familien kommen dafür in
Betracht:

| Cue-Familie | Frage | Achse |
|---|---|---|
| `descriptive_entity` | Welchem übergeordneten Begriff lässt sich dieser einzelne Fakt zuordnen? | Item, beschreibend |
| `associative_bridge` | In welcher künftigen Situation wäre dieser einzelne Fakt wichtig? | Item, assoziativ |
| `descriptive_scene` | Wie lässt sich die Situation dieser Episode beschreiben? | Szene, beschreibend |
| `associative_horizon` | Welche größere Lage oder Aufgabe macht diese ganze Episode relevant? | Szene, assoziativ |

Die Erwartung ist, dass nur die assoziative Achse einen eigenen Beitrag leistet,
weil Titel, Tags, `topic_path` und Summary die beschreibende Achse im
bestehenden Index bereits abdecken. Das ist jedoch eine **Hypothese und keine
Entscheidung**: Sie stützt sich auf eine Fremdarbeit und auf die Struktur des
heutigen BM25-Index, nicht auf eine Bastra-Messung. Welche Familien persistent
werden, entscheiden die Ablation in 18.3 und der anschließende gesonderte
Repräsentationsentscheid nach 11.2; bis dahin bleiben alle vier im Prüfumfang.

Dabei ist eine Stufenabhängigkeit zu beachten: `descriptive_entity` und
`associative_bridge` beziehen sich auf ein einzelnes Memory und sind auf dem
heutigen Bestand unmittelbar bildbar. `descriptive_scene` und
`associative_horizon` beziehen sich dagegen auf eine Episode oder Szene — ein
Gegenstand, den das Vault-Schema erst mit der M4-Stufe kennt. Die Cue-Ablation
muss deshalb ausweisen, auf welcher Stufe sie geprüft hat; siehe 18.3.

Regeln:

- jeder abgeleitete Cue trägt **immer** Ziel-ID des Memorys, Herkunft,
  Generatorversion, `derived_at`, Konfidenz und die Verbindung zur Evidenz;
  diese Felder sind Bestandteil des Cues und niemals Gegenstand einer
  Ablation — ablated wird ausschließlich seine Rankingwirkung;
- handgeschriebenes `recall_when` und abgeleiteter Cue haben verschiedene
  Vertrauensklassen und werden nie zu einem Feld verschmolzen;
- Cues öffnen Kandidaten, sind aber nie die ausgegebene Evidenz;
- die Schicht beginnt als read-only Sidecar-Projektion ohne jede
  Markdown-Änderung;
- eine persistente Aufnahme ins Vault-Schema benötigt denselben gesonderten
  Repräsentationsentscheid wie Dual-Vektoren und Chunking gemäß 11.2;
- Sensitivity, Scope und Egress-Regeln gelten für abgeleitete Cues unverändert;
- ein Cue, dessen Ziel-Memory sich ändert, wird als veraltet markiert, statt
  stillschweigend weiter zu feuern.

Ein Cue ohne auflösbare Ziel-ID oder ohne Evidenzverbindung ist kein
unvollständiger Cue, sondern ein ungültiger. Er wird verworfen, nicht
degradiert verwendet.

Rollback: Die Sidecar-Datei wird ignoriert. Retrieval verhält sich dann exakt
wie heute, weil `recall_when` und der BM25-Index unverändert bleiben.

## 12. Flat Search und HNSW

Dieser Abschnitt ist eine spätere Zielarchitektur. Der Vault mit zum
Messzeitpunkt 577 Memories begründet keine HNSW-Live-Aktivierung. Messungen,
Prototypen und Shadow-Vergleiche sind jederzeit zulässig. Recall soll bei
tatsächlich wachsender Vektormenge selbstständig und qualitätsgesichert zwischen
Flat und HNSW wechseln; live geht dieser Wechsel erst, wenn kontrolliertes
Profiling einen Flat-Search-Engpass und M5 den Qualitäts- und Latenzvorteil
belegen. Provider-Latenz allein ist kein HNSW-Argument.

### 12.1 Begriffe

Flat beziehungsweise Brute Force vergleicht den Query-Vektor mit jedem
gespeicherten Vektor. Das ist exakt, einfach und bei kleinen Vaults schnell.

HNSW bedeutet **Hierarchical Navigable Small World**. Es organisiert Vektoren in
einem mehrstufigen Nachbarschaftsgraphen und springt bei der Suche schnell in eine
wahrscheinlich relevante Region. Das ist deutlich skalierbarer, aber
approximativ.

### 12.2 Gemeinsame Schnittstelle

```ts
interface VectorSearchBackend {
  kind: "flat" | "hnsw";
  build(snapshot: VectorSnapshot): Promise<void>;
  upsert(items: VectorItem[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  search(query: Float32Array, options: VectorSearchOptions): Promise<VectorHit[]>;
  health(): VectorBackendHealth;
  snapshotId(): string;
}
```

Der Retrieval Controller kennt keine backend-spezifische Logik außerhalb dieser
Schnittstelle.

### 12.3 Automatische Wahl

Der Backend-Wechsel hängt nicht allein an einer magischen Memory-Zahl:

- Anzahl der Vektoren;
- Anzahl der Chunks;
- Vektordimension;
- gemessene Flat-p95-Latenz;
- verfügbare RAM-Menge;
- aktuelle Hardware;
- HNSW-Recall gegenüber Flat-Gold;
- Build- und Updatekosten;
- Fehlerrate und Indexgesundheit.

Startlogik:

1. Flat ist immer verfügbar und die Referenz.
2. Ab einer konfigurierbaren Größen- oder Latenzschwelle baut Recall HNSW im
   Hintergrund.
3. Shadow-Queries laufen gegen beide Backends.
4. HNSW wird nur aktiviert, wenn Geschwindigkeit und Qualitätsgate bestehen.
5. Der Wechsel erfolgt atomar auf einen vollständigen Snapshot.
6. Bei Korruption, Drift oder schlechter Qualität fällt Recall auf Flat zurück.
7. Manuelles Erzwingen bleibt für Diagnose möglich.

Praktische Erwartung, nicht harte Regel:

- unter einigen Tausend Vektoren meist Flat;
- zwischen einigen Tausend und 10.000 anhand realer p95-Messung entscheiden;
- ab deutlich größeren Chunk-/Memory-Mengen meist HNSW;
- Deep Recall darf bei kritischen Fällen Flat zur Verifikation nachziehen.

### 12.4 Qualitätsgate für HNSW

HNSW darf erst live gehen, wenn:

- Recall@10 gegenüber Flat mindestens 98 % erreicht;
- Gold-Recall@3 nicht relevant sinkt;
- keine Scope-/Sensitivity-Fehler auftreten;
- p95 messbar besser ist;
- Indexaufbau und inkrementelle Updates stabil sind;
- Neustart und Snapshot-Wiederherstellung getestet sind.

Die genauen Parameter wie `M`, `efConstruction` und `efSearch` werden durch
Benchmarking bestimmt und als Teil des Snapshot-Manifests gespeichert.

## 13. Typed Memory Graph

`related_via` bleibt als schwache semantische Nähe erhalten, darf aber nicht alle
Beziehungsarten vertreten.

V2-Beziehungen:

| Typ | Bedeutung |
|---|---|
| `related_to` | allgemeine semantische Nähe |
| `supports` | liefert Evidenz für einen Claim |
| `contradicts` | widerspricht einem Claim |
| `supersedes` | ersetzt eine ältere Version |
| `derived_from` | wurde aus Episode oder Quelle konsolidiert |
| `caused_by` | Ursache-Wirkung |
| `resolved_by` | Problem wurde dadurch gelöst |
| `applies_to` | gilt für Entity, Projekt, Datei oder Symbol |
| `example_of` | konkrete Episode eines semantischen Musters |

Regeln:

- automatische Cosine-Nähe erzeugt höchstens `related_to`;
- starke Kanten benötigen strukturelle Evidenz oder Bestätigung;
- Normal Recall traversiert höchstens kontrollierte typed edges;
- Deep Recall darf breiter traversieren;
- widersprechende oder historische Kanten werden sichtbar erklärt;
- Graph-Hops erhalten kein pauschales Score-Multiplikator-Modell.

### 13.1 Logische Sichten statt getrennter Graphen

Die Kantentypen werden zu logischen Sichten gebündelt — semantisch, temporal,
kausal und entity —, nicht zu getrennten physischen Graphen. Ein Vault dieser
Größenordnung rechtfertigt keine vierfache Speicherhaltung; der Gewinn liegt in
der getrennten Auswertbarkeit, nicht in getrennten Datenbanken. Der Query-Intent
bestimmt, welche Sichten mit welchem Hop-Budget überhaupt aktiv sind:

- Normal Recall nutzt höchstens die Entity- und die temporale Sicht mit einem
  harten Hop-Budget von eins;
- Deep Recall darf Sichten breiter kombinieren und mehrfach traversieren;
- kausale und temporale Kanten entstehen nie aus bloßer Ähnlichkeit, sondern
  benötigen strukturelle Evidenz oder eine Bestätigung;
- jede Sicht wird einzeln ablated und gegen einen No-Graph-Kontrollarm
  gemessen;
- eine Verbesserung des Gesamtergebnisses ohne bestandenen Kontrollarm gilt
  nicht als Beleg dafür, dass der Graph die Ursache war.

#### Die heutige Hop-Baseline bleibt erhalten

Diese Beschränkung darf nicht dazu führen, dass eine bereits produktive
Fähigkeit stillschweigend verschwindet. Der Hook-Pfad traversiert heute
standardmäßig **einen `related_via`-Hop** — und zwar nicht auf Wunsch der
Hooks, sondern weil der Hook-Endpunkt `expand_hops` von sich aus auf 1 setzt,
sofern der Aufrufer nicht ausdrücklich 0 sendet. Kein Hook sendet den Parameter.
Der MCP-Pfad hoppt umgekehrt nie; der Forwarder setzt ihn explizit auf 0. Diese
Asymmetrie ist der heutige Ist-Stand.

Der traversierte Kantentyp ist ausschließlich `related_via`, also die
automatisch erzeugte semantische Nähe — nicht das Wikilink-Array `related`,
das nur in die Graph-Projektion einfließt. In der Sprache von 13.1 ist das
genau die **semantische Sicht**, und sie ist damit die einzige heute live
erprobte. Sie bleibt erhalten:

- Die semantische Sicht mit Hop-Budget eins bleibt der produktive Zustand und
  gleichzeitig der **Kontrollarm**, gegen den jede neue Sicht antreten muss.
- Eine neue Sicht ersetzt sie nicht, sondern tritt neben sie, solange sie
  ihren eigenen Lift nicht belegt hat.
- Erst wenn eine Sicht ihren Lift gegenüber dieser Baseline und gegenüber dem
  No-Graph-Arm zeigt, darf über eine Umschichtung des Hop-Budgets entschieden
  werden.

#### Ein Hop erzeugt niemals allein `required`

Ein Treffer, der nur über eine Kante erreicht wurde, ist ein Kandidat und kein
Beleg. Das Ziel-Memory muss den regulären Evidenzentscheid aus Abschnitt 10 aus
eigener Kraft bestehen, um `required` zu werden.

Diese Regel schließt eine heute bestehende Lücke. Der Ist-Stand:

- Ein Hop-Nachbar erhält höchstens die Hälfte des rohen Seed-Scores.
- Die Herkunftskennzeichnung `hop` wird auf dem Weg zum Hook aus der Antwort
  herausprojiziert; der Hook sieht nur noch Titel, Typ, Scope, Summary und
  Score.
- Die `required`-Entscheidung fällt allein über die Score-Schwelle 100 und ist
  damit hop-blind.
- Auf dem Hybrid-Pfad ist der Score eine skalierte Rangsumme mit einer
  Obergrenze um 164, sodass ein Hop-Nachbar rechnerisch höchstens etwa 82
  erreicht und die Schwelle nicht überschreiten kann.
- Auf dem **BM25-only-Pfad** sind die Scores dagegen unbegrenzt. Dort kann der
  Nachbar eines sehr starken Treffers die 100 überschreiten und wird dann als
  `required` ausgespielt, ohne vom Hook als Hop erkennbar zu sein.

Die Trennung hängt heute also an einer zufälligen Eigenschaft der
Score-Skalierung — und ausgerechnet der degradierte Pfad ohne Embeddings, der
bei Providerausfall greift, besitzt diese Sicherung nicht. V1.0 macht die Regel
deshalb explizit, statt sich auf die Deckelung zu verlassen.

Voraussetzung dafür ist, dass die Hop-Herkunft dem Entscheidungspunkt zur
Verfügung steht. Der Evidenzentscheid fällt **serverseitig**, vor der
Projektion der Antwort — die Kennzeichnung muss deshalb nur bis dorthin
reichen und **nicht** Teil der öffentlichen Lean-Antwort werden. Die heutige
Lean-Projektion (ID, Titel, Typ, Scope, Summary, Score) bleibt unverändert; zusätzlich steht die
Hop-Herkunft in Telemetrie und Debug-Ausgabe zur Verfügung, wo sie für die
Auswertung nach 18.2 und 18.5 gebraucht wird. Rückwärtskompatibilität für
bestehende Clients ist damit gewahrt.

Der Kontrollarm ist keine Formalie. Eine peer-reviewte Vergleichsanalyse zerlegt
Graph- und Nicht-Graph-Memorysysteme in vergleichbare Komponenten und zeigt
beides: Ungeeignete Graphkonstruktion verschlechtert Ergebnisse, und starke
flache Baselines bleiben häufig konkurrenzfähig — aber gut konstruierte Kanten
aus Entity-Beschreibungen schlagen flache Indizes teilweise deutlich. Das
verbietet ein Dogma in beide Richtungen: weder „Graph immer“ noch „flach
reicht“. Entschieden wird pro Sicht und pro Query-Klasse, nicht global.

## 14. Konsolidierung als kontrollierter Schlaf-Pass

### 14.1 Eingang

Der Pass betrachtet eine Mischung aus:

- neuen Episoden;
- älteren ähnlichen Episoden;
- häufig erfolgreich verwendeten Memories;
- wiederholt ignorierten Kandidaten;
- Korrekturen;
- Widersprüchen;
- zeitlich abgelaufenen Decisions;
- bestehenden semantischen Regeln.

Nur die größten Topic-Path-Cluster zu betrachten reicht nicht.

### 14.2 Operationen

1. Episoden nach Entity, Claim, Ursache, Lösung und Ergebnis clustern.
2. Ähnliche Episoden bewusst getrennt halten.
3. Wiederkehrende Muster identifizieren.
4. Gegenbeispiele und Fehlschläge einbeziehen.
5. Widersprüche erkennen.
6. Kandidat für neue Lesson, Decision oder Workflow erzeugen.
7. Ursprungsbelege über `derived_from` erhalten.
8. Confidence und Gültigkeitsbereich vorschlagen.
9. Nutzerbestätigung einholen.
10. Episoden bestehen lassen und nur ihre Accessibility anpassen.

### 14.3 Replay-Mischung

Der Replay-Sampler darf nicht nur das zuletzt Häufige wählen:

- Anteil neuer Episoden;
- Anteil alter, noch relevanter Episoden;
- Anteil selten verwendeter, aber hoch salienter Memories;
- Anteil widersprechender oder korrigierter Fälle;
- Anteil zufälliger Kontrollfälle.

Dadurch wird verhindert, dass das System nur das bereits Dominante weiter
verstärkt.

### 14.4 Nichtdestruktive Topologie-Operatoren

Konsolidierung äußert sich ausschließlich in benannten, reversiblen
Vorschlägen. Es gibt keine freie inhaltliche Umschreibung. Die Operatoren
zerfallen in zwei Klassen, die nicht vermischt werden dürfen.

**Klasse A – Topologie- und Inhaltsoperatoren.** Sie verändern Bestand oder
Beziehungen und erzeugen Versionen:

| Operator | Wirkung |
|---|---|
| `SPLIT` | ein zu breites Memory wird in mehrere Nachfolger zerlegt |
| `MERGE` | mehrere Memories werden zu einem Nachfolger zusammengeführt |
| `UPDATE` | Inhalt oder Gültigkeit eines Memorys wird fortgeschrieben |
| `LINK` | eine typisierte Kante wird vorgeschlagen |
| `SUPERSEDE` | ein Memory wird als ersetzt markiert und bleibt zitierbar |

Für jeden Operator der Klasse A gilt:

- er referenziert alle Eingaben vollständig;
- er erzeugt eine neue Version oder abgeleitete Repräsentation und löscht keine
  Evidenz;
- er trägt Begründung und Konfidenz;
- er wird vor der Persistenz vom Nutzer freigegeben;
- er ist einzeln zurückrollbar, weil der Vorgängerzustand zitierbar bleibt;
- ein nicht angenommener Vorschlag hinterlässt keinen Zustand im Vault.

**Klasse B – Accessibility-Entscheidungen.** `DORMANT` und `REACTIVATE` sind
keine Inhaltsoperationen. Sie erzeugen keine Version, ändern keinen Text und
keine Kante, sondern wirken auf die Zugänglichkeit:

| Operator | Wirkung |
|---|---|
| `DORMANT` | die Zugänglichkeit wird gesenkt, Inhalt und Kanten bleiben unverändert |
| `REACTIVATE` | die Zugänglichkeit wird nach belegtem Bedarf angehoben |

Für Klasse B gilt gesondert:

- Accessibility ist laut 7.1 eine reproduzierbare Projektion und keine
  gespeicherte Wahrheit. Ein Operator, der sie als Version schriebe, würde
  genau diese Eigenschaft aufheben.
- Eine **dauerhafte** Zugänglichkeitsentscheidung des Nutzers wird deshalb nicht
  als Konsolidierungsvorschlag ausgeführt, sondern über einen eigenen
  Override-Vertrag festgehalten: einen expliziten Floor beziehungsweise Pin nach
  7.2 und 7.4, der die berechnete Projektion überstimmt, jederzeit sichtbar ist
  und jederzeit widerrufen werden kann.
- Ein Klasse-B-Vorschlag ohne solchen Override wirkt nur bis zur nächsten
  Neuberechnung der Projektion. Das ist beabsichtigt und wird dem Nutzer so
  angezeigt.
- `user-directed`-Memories und gefloorte Memories sind von automatischen
  `DORMANT`-Vorschlägen ausgenommen.

**Erreichbarkeitsgarantie.** Jede archivierte, dormante oder konsolidierte
Quelle bleibt vom sichtbaren Bestand aus über höchstens `max_provenance_hops`
typisierte Links erreichbar. Der Startwert zwei ist ein **zu prüfender
Kandidat**, keine gesetzte Konstante: Eine Ursprungsquelle, die erst durch
`SPLIT` und danach durch `MERGE` läuft, liegt danach genau zwei Hops entfernt —
die Grenze wird erreicht, aber noch nicht überschritten. Bereits eine weitere
Generation aus `UPDATE`, `MERGE` oder `SPLIT` überschreitet sie. Der Wert ist
versioniert abgelegt und wird nur mit dokumentierter Begründung geändert.

**Erhaltungsregel.** Weil die Grenze schon in der zweiten Generation greift,
genügt es nicht, sie zu benennen — sie muss durchgesetzt werden:

1. Vor der Annahme **jedes** Klasse-A-Operators wird die Survival-Invariante
   für den Zustand *nach* der Operation simuliert.
2. Ergibt die Simulation, dass eine Quelle außerhalb von
   `max_provenance_hops` läge, muss der Vorschlag die Invariante mit eigenen
   Mitteln wiederherstellen: durch typisierte **Provenienz-Shortcuts** vom
   neuen sichtbaren Memory zu den ursprünglichen Leaf-Quellen oder dadurch,
   dass ein geeigneter Zwischenknoten sichtbar bleibt.
3. Shortcut beziehungsweise sichtbarer Zwischenknoten sind **Bestandteil
   desselben atomaren Vorschlags** und werden gemeinsam mit ihm freigegeben.
   Es gibt keinen automatischen `LINK`-Nachtrag: Ein Shortcut, der nach der
   Operation separat und ungefragt entstünde, wäre eine autonome Graphmutation
   und verstieße gegen 13 und gegen die Freigabepflicht der Klasse A.
4. Der Vorschlag wird als Ganzes angenommen oder als Ganzes verworfen. Ein
   Teilzustand — Operation ausgeführt, Shortcut fehlt — darf nicht entstehen.
5. Shortcuts sind additiv. Sie **ersetzen und löschen die ursprüngliche
   Provenienzkette nicht**; die vollständige Ableitungsgeschichte bleibt
   traversierbar.
6. Shortcuts wahren **Sensitivity- und Scope-Grenzen**. Ein Shortcut, der eine
   private Quelle einem weniger geschützten Sichtbarkeitsbereich zugänglich
   machen würde, ist unzulässig — auch dann, wenn er die Invariante
   wiederherstellen würde. In diesem Fall gilt der Vorschlag als nicht
   erfüllbar; die Sensitivity-Regel aus 23 hat Vorrang vor der
   Erreichbarkeitsgarantie.
7. Die Prüfung gilt nach **jeder einzelnen Operation**, nicht erst am Ende
   eines Konsolidierungslaufs. Ein Lauf, der zwischenzeitlich die Invariante
   verletzt, ist auch dann unzulässig, wenn sein Endzustand sie wieder erfüllt.

**Wenn nichts davon greift.** Kann weder die Operation selbst noch ein
zulässiger, datenschutzkonformer Shortcut die Invariante erfüllen, gilt eine
feste Reihenfolge:

1. Die Operation wird **ohne Teilzustand abgebrochen**. Es entsteht kein
   Vault-Zustand, kein halber Shortcut, keine verwaiste Version.
2. Der betroffene Zwischenknoten bleibt sichtbar, statt in die Dormanz zu
   fallen — die Erreichbarkeit hat Vorrang vor der Aufräumwirkung der
   Konsolidierung.
3. Ergibt sich derselbe Konflikt wiederholt für dieselbe Struktur, erzeugt der
   Curator **einen** Vorschlag, `max_provenance_hops` zu erhöhen. Dieser
   Vorschlag ist eine gesonderte, gemessene Änderung nach 18.5 und keine
   stillschweigende Anpassung.

**Keine Schleifen.** Ein abgelehnter oder blockierter Vorschlag wird nicht
automatisch wiederholt. Der Curator merkt sich die Ablehnung über einen
**strukturellen Fingerprint** genau der Daten, die für die Invariante relevant
sind:

- Operatortyp;
- beteiligte Memory-IDs und deren semantische Inhaltsversion — dieselbe Größe
  wie im Hash, nicht `updated`;
- die betroffenen Provenienzkanten;
- Sichtbarkeit, Sensitivity und Scope der beteiligten Knoten;
- der geltende Wert von `max_provenance_hops`.

Dieselbe Operation wird erst wieder vorgeschlagen, wenn sich dieser Fingerprint
ändert. Ausdrücklich **nicht** ausreichend sind Änderungen an Cache-Inhalten,
Telemetriezählern, `stale_status` oder Zeitstempeln: Sie berühren die
Invariante nicht und dürfen einen blockierten Vorschlag nicht erneut
freigeben.

Ein geänderter Fingerprint ist dabei **notwendige, aber nicht hinreichende**
Bedingung. Aus Nutzersicht lautet die Regel: Derselbe abgelehnte Vorschlag
kommt nicht wieder; ein wirklich anderer, verbesserter Vorschlag darf wieder
erscheinen.

Damit das prüfbar ist, speichert der Curator neben dem strukturellen
Fingerprint einen **semantischen Vorschlagshash**. Er darf sich nicht auf die
vorgeschlagene Zustandsänderung beschränken: Gelten Evidenz, der Reason-Code der
Begründung und ein gelöster Schutzkonflikt als materielle Änderung, müssen sie in
kanonisierter Form auch im Hash liegen — sonst könnte eine materielle Änderung
vorliegen, während der Hash unverändert bleibt, und die Bedingungen widersprächen
einander.

Der Hash wird aus einer **versionierten kanonischen Struktur** gebildet und
enthält **keinen frei formulierten Erklärungstext**. Sonst könnte eine bloße
Umformulierung der Begründung eine Wiedervorlage auslösen — genau das, was die
Regel verhindern soll. Die Struktur umfasst mindestens:

| Bestandteil | Form |
|---|---|
| Operator | Enum-Wert, kein Freitext |
| Zielzustand | normalisierter Diff gegen den Ausgangszustand |
| Quellen | sortierte Quell-IDs mit ihrer **semantischen Inhaltsversion** |
| Kanten | sortierte Tupel der angelegten und entfernten Kanten |
| Evidenz | sortierte Evidenzreferenzen beziehungsweise Evidenz-Hashes |
| Begründung | **Reason-Code** aus einem festen Vokabular, keine Prosa |
| Schutzkonflikt | strukturierter Status und, falls vorhanden, dessen Auflösung |
| Schema | Version des Hash-Schemas selbst |

Drei Punkte daran sind nicht verhandelbar:

- **Sortierung und Normalisierung.** Alle Mengen werden vor dem Hashen sortiert
  und normalisiert; die Reihenfolge, in der ein Vorschlag entstanden ist, darf
  den Hash nicht bewegen.
- **Reason-Code statt Prosa.** Die menschenlesbare Begründung wird **separat
  protokolliert** und geht nicht in den Hash ein. Sie bleibt für den Nutzer
  sichtbar und für die Nachvollziehbarkeit erhalten — sie entscheidet nur nicht
  über die Wiedervorlage. Ändert sich die Sachlage wirklich, ändert sich der
  Reason-Code.
- **Semantische Inhaltsversion.** Die im Hash geführte Quellversion bezeichnet
  eine Version des **inhaltlich Ausgesagten**, nicht das Feld `updated`. Ein
  Speichervorgang ohne inhaltliche Änderung bewegt `updated`, aber nicht die
  semantische Version — und damit auch nicht den Hash.

**Unbekannter Reason-Code.** Das Vokabular ist versioniert und damit endlich.
Trifft der Curator auf einen Code, den die geltende Vokabularversion nicht
kennt — nach einem Downgrade etwa oder aus einem Vorschlag, den eine neuere
Fassung erzeugt hat —, gilt das **nicht** als benannte materielle Änderung: Es
findet **keine Wiedervorlage** statt, bis das versionierte Vokabular erweitert
wurde. Ein unbekannter Code belegt keine materielle Änderung, sondern nur, dass
sie nicht beurteilt werden kann. Die Gegenrichtung — im Zweifel wiedervorlegen —
würde jede Vokabularlücke in genau die Schleife verwandeln, gegen die C-067 und
C-073 angetreten sind.

Die semantische Inhaltsversion beruht auf derselben Abgrenzung des
aussagetragenden Inhalts wie der Bestätigungsbezug aus 6.3 — maßgeblich ist die
linke Spalte der dortigen Tabelle; Retrieval-, Darstellungs- und
Betriebsmetadaten zählen in beiden Fällen nicht. Die beiden Größen bleiben dennoch getrennt und werden
nicht gegeneinander ausgetauscht: Der Bestätigungsbezug bindet zusätzlich
`memory_id` und die konkrete Darstellung im Review, weil er eine
Nutzerentscheidung festhält; die semantische Inhaltsversion identifiziert nur
den Inhaltsstand einer Quelle innerhalb eines Vorschlags. Gleiche Definition
des Inhalts, verschiedene Zwecke.

Daraus folgt unmittelbar: Eine reine Umformulierung, ein Zeitstempel-Update oder
eine Metadatenänderung ermöglicht **keine** Wiedervorlage. Sie bewegen weder den
strukturellen Fingerprint noch den semantischen Vorschlagshash.

Eine Wiedervorlage setzt alle drei Bedingungen voraus:

1. einen **geänderten Fingerprint** nach der obigen Liste,
2. einen **geänderten semantischen Vorschlagshash**, und
3. eine **benannte materielle Änderung** am Vorschlag.

Als materiell gilt eine Änderung an mindestens einer dieser Größen:

- dem vorgeschlagenen **Zielzustand** — was nach der Operation gelten soll;
- der **Quellversion** der beteiligten Memories;
- der **Kantenmenge**, die die Operation anlegt oder entfernt;
- dem **Reason-Code** der Begründung, sofern er sich aufgrund neuer Evidenz
  ändert — eine bloß anders formulierte Begründung zählt nicht;
- einem zuvor **gelösten Schutzkonflikt** — etwa einer weggefallenen
  Sensitivity- oder Invariantenverletzung.

Ist der semantische Vorschlagshash unverändert, bleibt der Vorschlag
unterdrückt — unabhängig davon, wie sich der Fingerprint bewegt hat. Reine
Zeit-, Cache-, Telemetrie- und Projektionsänderungen sowie Umformulierungen der
Begründung bewegen weder den Fingerprint noch den Hash und bleiben damit auf
beiden Wegen ausgeschlossen. Lässt sich
keine der fünf Größen als geändert benennen, gilt der Vorschlag als derselbe.
Im Zweifel unterbleibt die Wiedervorlage: Ein verpasster Verbesserungsvorschlag
kostet weniger als ein Vorschlag, der jede Woche in leicht anderer Form
zurückkehrt. Andernfalls entstünde genau die Schleife, die diese Regel verhindert
— ein Vorschlag, der jede Nacht neu erscheint, weil sich ein
Projektionszeitstempel bewegt hat.

Ein Konsolidierungslauf, der an einer Struktur blockiert, überspringt sie und
läuft weiter; er wiederholt sie nicht innerhalb desselben Laufs und blockiert
nicht die übrigen Vorschläge.

Gemessen wird die Garantie über zwei Größen:

- **Survival-Quote:** Anteil der archivierten oder konsolidierten Quellen, die
  innerhalb von `max_provenance_hops` von einem sichtbaren Root aus erreichbar
  sind. Zielwert 100 %; jede Unterschreitung ist ein Fehler, kein Rauschen.
- **Zitationsquote:** Anteil der abgeleiteten Memories, deren sämtliche Inputs
  über auflösbare IDs referenziert und abrufbar sind.

**Beide Quoten gelten je Berechtigungs-, Scope- und Sensitivity-Kontext**, nicht
global. Eine globale Quote wäre entweder falsch oder gefährlich: Zählt sie
private Quellen im Nenner eines weniger privilegierten Aufrufers mit, meldet sie
einen Fehler, der keiner ist — oder sie verleitet dazu, die Erreichbarkeit durch
einen berechtigungsüberschreitenden Shortcut herzustellen. Deshalb gilt:

- Eine private Quelle muss von einem sichtbaren Root **desselben oder eines
  stärker geschützten Kontextes** aus erreichbar bleiben.
- Sie gehört **niemals in den Nenner** einer Quote, die für einen weniger
  privilegierten Aufrufer berechnet wird — dort existiert sie schlicht nicht.
- Der Zielwert bleibt **innerhalb jedes zulässigen Kontextes 100 %**.
- Existiert kein sicherer Pfad, bleibt die Quelle oder ein geeigneter
  Zwischenknoten **in ihrem eigenen geschützten Kontext sichtbar**. Es entsteht
  kein berechtigungsüberschreitender Shortcut — Privacy nach Abschnitt 23 hat
  weiterhin absoluten Vorrang vor der Erreichbarkeitsgarantie.

Eine sichtbare Memory darf eine archivierte Quelle repräsentieren, aber niemals
still deren Inhalt ersetzen. Der Asteroidengürtel ist damit eine
Zugänglichkeitsaussage und keine Löschung — die Konsolidierung darf diese
Eigenschaft nicht unterlaufen.

#### Sonderfall `SUPERSEDE`

`SUPERSEDE` bleibt ein Klasse-A-Operator: Es erzeugt eine Version und
verschiebt den Wahrheitsstand. Es besitzt daneben aber eine **sekundäre
Sichtbarkeitswirkung**, die klar begrenzt ist:

- Der Vorgänger ist nicht mehr aktuelle Wahrheit und wird im normalen Recall
  nicht mehr als geltende Aussage ausgespielt.
- Er bleibt historisch, über seine ID und über Deep Recall erreichbar.
- Diese Wirkung ist **keine Klasse-B-`DORMANT`-Entscheidung**. Sie folgt aus
  dem Versionsstand und nicht aus einer Zugänglichkeitsbewertung.
- Sie erzeugt **keinen dauerhaften Accessibility-Override**. Ein Floor oder Pin
  entsteht nur über den Weg aus dem Klasse-B-Abschnitt.
- Dass die Accessibility-Projektion aus 7.1 den Term `superseded_penalty`
  enthält und 7.5 für „explizit ersetzt“ die Zone Historical vorsieht, steht
  dazu nicht im Widerspruch: Beides sind **berechnete Projektionen** aus dem
  Versionsstand, keine gespeicherten Entscheidungen. `SUPERSEDE` setzt die
  Version; die Zone folgt daraus, ohne dass ein Operator sie schreibt.

**Abgrenzung gegen das heutige Archivierungsprimitiv.** `SUPERSEDE` arbeitet
grundsätzlich über Claim- und Versionsstatus. Es entspricht **nicht** dem
heutigen `archive_memory` und setzt **nicht** `obsolete: true`. Diese Abgrenzung
ist nötig, weil das vorhandene Primitiv weit mehr tut, als der Name nahelegt:

- Es verschiebt die Datei des Vorgängers in den Vault-Trash unter `.bastra/`.
- Es entfernt sie zusätzlich aus dem lebenden Vault-Index, sodass sie auch über
  ihre ID nicht mehr über den regulären Weg auffindbar ist.
- Es stempelt die Trash-Kopie best-effort mit `obsolete: true` und
  `superseded_by`.
- Der Normal Recall filtert `obsolete` ohnehin vollständig aus.

Ein `SUPERSEDE`, das dieses Primitiv wiederverwendete, würde den Vorgänger also
nicht historisch machen, sondern faktisch entfernen — und damit die Zusage
brechen, dass alte Versionen zitierbar bleiben.

**Migrationsregel.** Der Vorgänger bleibt im lebenden Vault. Seine Historizität
entsteht aus dem Versions- und Claim-Status, nicht aus einem Ortswechsel.
Erreichbar bleibt er über einen ausdrücklich benannten **Historical- und
Deep-Recall-Zugriff**, der ihn nach ID, Version und Zitat auflöst. Er ist die
technische Entsprechung der Abrufrolle Historical aus 6.5.

Die Architektur legt hier nur den **Zugriffsvertrag** fest, nicht die
Speicherform: Der Zugriff darf als logische Sicht auf dem bestehenden Index
beginnen. Eine physische Trennung wird erst notwendig, wenn eine Messung sie
begründet oder Berechtigungsanforderungen sie erzwingen.

Wird in einer Übergangsphase dennoch `obsolete` verwendet, gilt:

- Der historische Loader liest `obsolete`-Memories **ausdrücklich mit ein** —
  andernfalls wären sie über keinen Weg mehr erreichbar.
- Der Normal Recall filtert sie weiterhin aus; daran ändert sich nichts.
- Ein Vorgänger wird in dieser Phase nicht zusätzlich in den Trash verschoben
  und nicht aus dem Index entfernt.

**Rollback.** Der Rollback eines `SUPERSEDE` muss fünf Dinge wiederherstellen:

1. den **Versionsstatus** — der Vorgänger ist wieder die aktuelle Fassung;
2. den **Zeitstatus** — insbesondere ein gesetztes `retracted_at` am
   Vorgänger-Claim entfällt;
3. den **Speicherort** — die Datei liegt wieder im lebenden Vault, nicht im
   Trash;
4. die **Indexierbarkeit** — der Vorgänger ist wieder regulär indexiert und
   über seine ID auffindbar;
5. die **Sichtbarkeit** — er wird wieder als geltende Aussage ausgespielt.

Ein Rollback, der nur die Version zurücknimmt, ist unvollständig und gilt als
fehlgeschlagen.

## 15. Rekonsolidierung und Versionen

Erfolgreicher Abruf kann einen Review-Kandidaten erzeugen:

```text
Memory geladen
  -> im Tool-Kontext verwendet
  -> neue Evidenz oder Korrektur beobachtet
  -> Rekonsolidierungs-Kandidat
  -> no-op, bestätigen, patchen oder neue Version
```

Regeln:

- kein automatisches Überschreiben aufgrund eines einzelnen Toolaufrufs;
- alte Version bleibt zitierbar;
- aktuelle Version zeigt auf Vorgänger;
- Vorgänger zeigt auf Nachfolger;
- historische Queries können den damaligen Zustand abrufen;
- normale Queries bevorzugen aktuell gültige Claims;
- Konflikte werden nicht durch Recency allein entschieden.

## 16. Hook- und Session-Orchestrierung

### 16.1 SessionStart

Ein `GET /hook/session-context` existiert bereits. Er dient heute dem
MCP-Forwarder für hooklose Clients, ist bewusst projektlos, schließt
projektbezogene und `all-projects`-Hints aus und assembliert seine Quellen
ebenfalls weitgehend sequenziell. Er ist deshalb kein Drop-in-Ersatz für den
Claude-Code-SessionStart-Hook.

V1.0 baut keinen zweiten konkurrierenden Session-Context-Pfad. Der vorhandene
Server-Assembler wird zur gemeinsamen Implementierung erweitert:

```text
GET  /hook/session-context
  -> rückwärtskompatibler, projektloser Forwarder-Pfad

POST /hook/session-context
  -> cwd / project / source / budgets
  -> preferences
  -> project context
  -> cross-project rules
  -> floors
  -> taxonomy
  -> care/import/onboarding state
  -> health
```

Der Claude-Code-Hook ruft danach den projektfähigen Pfad einmal auf. Hooklose
Clients behalten den bisherigen GET-Vertrag. Serverseitig laufen unabhängige
Schritte parallel. Die Response besitzt:

- globales Zeitbudget;
- globales Tokenbudget;
- priorisierte Blöcke;
- klare Degraded-Kennzeichnung;
- Abbruch nichtkritischer Teile bei Deadline.

### 16.2 PreToolUse und Prompt

- exakte und lexikalische Prüfung zuerst;
- semantischer Arm nur bei Bedarf;
- kein pauschales Multi-Hop;
- `no_answer` wird respektiert;
- Required nur aus dem deterministischen Evidenzentscheid; eine kalibrierte
  Wahrscheinlichkeit kommt erst nach M1-Labelevidenz infrage;
- Backoff gilt auch für scheinbar starke Treffer, wenn deren Relevanz nicht
  unabhängig belegt ist;
- identische Routinglogik wird zentral geteilt.

### 16.3 Kontextbudget

Ein globaler Context Governor entscheidet:

- wie viele Memories ausgespielt werden;
- wie viele Token verbraucht werden;
- ob nur Titel/Summary oder voller Load nötig ist;
- ob ein bereits geladenes Memory erneut erwähnt werden darf;
- welche Zonen automatisch ausgeschlossen sind.

## 17. Lernen aus Nutzung

### 17.1 Positive Signale

- `loaded` und anschließend `acted_on`;
- explizites „Das war richtig“;
- wiederholte erfolgreiche Verwendung in unterschiedlichen Situationen;
- ein Memory verhindert nachweislich einen zuvor wiederkehrenden Fehler;
- ein Deep-Recall-Treffer wird reaktiviert.

### 17.2 Negative Signale

- Nutzer verwirft oder korrigiert den Treffer;
- unmittelbare Re-Query mit anderer Formulierung;
- geladen, aber als unpassend markiert;
- wiederholt ausgespielt und nie geladen;
- Claim wird durch neue Evidenz ersetzt.

### 17.3 Selektionsbias

Nur ausgespielte Memories können geladen werden. Deshalb gilt:

- `surfaced-not-loaded` ist kein sicherer Beweis für Irrelevanz;
- `acted_on` ist heute ein lexikalischer Proxy, kein Ground-Truth-Label;
- Out-of-pool-Fälle liefern keine direkten Rankinglabels;
- Learned Ranking wird zunächst ausschließlich shadow betrieben;
- Coverage und Rankingqualität werden getrennt gemessen;
- Exploration bleibt klein, kontrolliert und transparent.

### 17.4 Retrieval und Präsentation getrennt messen

Die Hook-Load-Quote hängt nicht allein vom Ranking ab. Für den
V1.0-Releasevertrag werden getrennte Arme benötigt:

1. identische Treffer mit unterschiedlicher Hook-Formulierung;
2. identische Formulierung mit und ohne deterministisches Abstention-Gate;
3. unabhängige Relevanzlabels für eine Stichprobe ausgespielter und
   zurückgehaltener Kandidaten;
4. Task-/Tool-Erfolg zusätzlich zu `loaded` und `acted_on`;
5. Auswertung getrennt nach Client, Hook-Quelle und Query-Klasse.

Die Arm-Zuweisung erfolgt deterministisch pro pseudonymer Session-ID. Eine
Session verbleibt für alle zugehörigen Ereignisse im selben Arm. Das Mindest-N
pro Arm wird nach dem M0-Baseline-Run festgelegt und gemeinsam mit
Zuweisungsfunktion und Experimentkonfiguration versioniert abgelegt.

**Releasezuordnung geändert durch C-083.** Die fünf vorstehenden Punkte
beschreiben das vollständige Experiment; sie sind ab dem 29.08.2026 nicht mehr
in dieser Vollständigkeit V1.0-Vertrag. V1.0 schuldet die vorab registrierte
Anlage, die deterministische Zuweisung und den ehrlichen Statusbericht nach
18.1; der hinreichend besetzte Lauf mit erreichtem Mindest-N, zweitem
Hook-Wortlaut, je Session schaltbarem Gate, erhobener Query-Klasse und
unabhängigen Relevanzlabels ist nach 26.2 verschoben. Verbindlich sind 26.1 und
26.2 in ihrer geänderten Fassung.

Tokens pro `acted_on` bleiben eine wichtige System-ROI-Metrik, werden aber nicht
als reine Retrieval-Precision interpretiert.

### 17.5 Nutzungssignale jenseits von `acted_on`

`acted_on` bleibt ein Token-Overlap-Proxy. Die folgenden Signale sind
belastbarer und werden erhoben, sobald sie ohne Schemaänderung verfügbar sind:

- explizite Annahme oder Ablehnung eines Hinweises;
- spätere Nennung einer Memory-ID im weiteren Verlauf;
- Edit einer Datei nach dem Recall, die der Hinweis betrifft;
- neue Memory, die erkennbar aus dem Hinweis entstanden ist;
- wiederholter Recall desselben Memorys über unterschiedlich formulierte
  Queries;
- Task- oder Tool-Erfolg;
- nachweislich vermiedener Regel- oder Sicherheitsverstoß;
- Korrektur nach falschem Recall;
- Reaktivierung eines dormanten Memorys nach Deep Recall;
- dokumentierte Sackgasse in einem Deep-Recall-Ast.

Pflichten für jede Auswertung dieser Signale:

- **Exposure-Normalisierung.** Ein häufig ausgespieltes Memory sammelt
  automatisch mehr positive Ereignisse und gilt deshalb nicht als besser
  belegt. Jedes Signal wird auf die Zahl seiner Ausspielungen normiert, und
  diese Normalisierung wird im Report als solche ausgewiesen.
- **Sie ist keine Korrektur des Selektionsbias.** Die Division durch die
  Ausspielungszahl macht Raten vergleichbar; sie sagt nichts darüber, warum ein
  Memory ausgespielt wurde. Der eigentliche Bias liegt darin, dass die Auswahl
  selbst vom bisherigen Ranking abhängt. Eine belastbare Bias-Korrektur setzt
  voraus:
  1. geloggte Auswahlwahrscheinlichkeiten beziehungsweise Propensities je
     Kandidat und Ausspielung;
  2. kontrollierte Exploration oder einen geeigneten randomisierten Arm, damit
     überhaupt Gegenbeobachtungen entstehen;
  3. die Behandlung nicht ausgespielter Kandidaten als zensiert und nicht als
     negativ.
  Solange diese drei Voraussetzungen nicht erfüllt sind, darf aus den Signalen
  **kein kausaler Utility-Lift** behauptet werden — weder im Report noch als
  Begründung für eine Live-Schaltung. Zulässig bleiben deskriptive Aussagen
  über beobachtete Raten.
- Nichtreaktion bleibt ein schwaches Negativ und wird nie als sicheres
  Negativlabel verwendet.
- Jedes Signal trägt Client, Hook-Quelle, pseudonyme Session und Experimentarm.
- Kein Signal wirkt live auf das Ranking vor bestandenem M6.
- Query-Rohtexte gehen nicht ohne gesonderte Datenschutzentscheidung in eine
  langfristige Lerndatenbank ein.

## 18. Messgates auf dem Weg von V1 zu V2

Die Messgates prüfen nicht nur Recall@k. Sie prüfen die gesamte
Entscheidungskette aus Coverage, Relevanz, Abstention, Accessibility, Latenz und
Kontextkosten.

### 18.0 Freigabestatus

Der V1.0-Releasevertrag umfasst M0, den deterministischen Teil von M1, den
gemeinsamen projektfähigen Session-Assembler und das
Kontext-/Consumer-Experiment aus Abschnitt 17.4. Messungen, Prototypen,
Shadow-Betrieb und read-only Projektionen für M2 bis M5 dürfen jederzeit
beginnen; Qualitätsvergleiche, die eine Referenzwirkung behaupten, werden erst
gegen eine belastbare M0-Baseline interpretiert. Ein reines M6-Shadow-Modell
setzt M0 und M1 voraus, nicht aber M3 bis M5. Schema-/Vertragsänderungen und
Live-Aktivierungen bleiben bis zum jeweils benannten Gate und einer expliziten
Freigabe gesperrt.

Die Bezeichnung `M` steht für Messgate. Sie ist bewusst von den
Produktversionen V1/V2 getrennt.

### 18.1 M0 – Messwahrheit herstellen

Ziel:

- sicherstellen, dass jeder Eval-Arm tatsächlich den produktiven Codepfad
  ausführt.

Arbeit:

- `packages/daemon/scripts/eval-stress.ts --hybrid` muss einen echten
  `EmbeddingIndex` anlegen;
- verwendetes Modell und Backend werden im Report ausgewiesen;
- die aktuelle Produktionsformel `max(k × 4, 20)` wird im Report ausgewiesen
  (beim Paraphrasen-Slice mit `k=10` heute 40, bei kleineren `k` meist 20);
- der Candidate Pool wird ausschließlich für die entsprechenden Evals
  explizit auf mindestens 100 oder 200 erweitert;
- Near, Far-in-pool und Far-out-of-pool werden getrennt gelabelt;
- veraltete Gold-IDs werden entfernt oder versioniert;
- Eval-Queries werden unabhängig von der aktuellen Memory-Oberfläche erstellt;
- Datensatzmanifest und privates Run-Artefakt führen für jeden Goldfall
  `origin_type`, `authoring_mode` und `origin_ref_hash`;
- Label-Shuffle-Null und Kontrollarm werden im Harness implementiert und im
  Report ausgewiesen;
- jeder Run erhält Code-, Vault-, Modell-, Konfigurations- und Datensatz-Hash;
- Befehlszeile, Roh-stdout/stderr, Manifest und strukturierte JSON-Ergebnisse
  werden unter `~/.bastra/eval-runs/<datum>-<hash>/` als versioniertes
  Run-Artefakt gespeichert;
- nach dem Baseline-Run werden die numerischen M1-Toleranzen festgelegt und
  versioniert abgelegt;
- im öffentlichen Repository werden ausschließlich aggregierte Reports ohne
  Vault-abgeleitete Query-Texte gespeichert. Die geringere
  Dritt-Reproduzierbarkeit wird zugunsten der Vault-Privacy akzeptiert;
- jede im Report zitierte Fremdzahl trägt ihre Evidenzklasse gemäß 2.3;
- ein späterer Standardbenchmark-Lauf wird nur mit Harness-Version, Modell-,
  Judge- und Promptversion, Kontextbudget, Top-k sowie getrennter Ausweisung
  von Retrieval- und Antwortmetrik archiviert;
- für den 2×2-Cue-Versuch aus 18.3 werden eine Power-Annahme und ein Mindest-N
  **je Zelle** festgelegt und versioniert abgelegt — getrennt für die
  Hauptwirkungen und für die Interaktion, deren Nachweis das größere N
  benötigt;
- das Goldset erhält getrennt ausgewiesene beschreibende und assoziative
  Fallmengen, damit beide Achsen unabhängig voneinander messbar sind;
- für den Cue-Erzeugungsweg aus 18.3 wird vor dem Lauf registriert und
  versioniert abgelegt, **welche der beiden zulässigen Anlagen** gefahren wird:
  Anlage A als gepaarter Zwei-Bedingungen-Vergleich bei festgehaltener
  Cue-Konfiguration — dann zusätzlich die Aufteilung in Auswahlteil und
  Holdout beziehungsweise das verschachtelte Auswertungsschema — oder Anlage B
  als vollständig gekreuztes 2×2×2 mit acht Zellen. In beiden Fällen werden
  Bedingungs- beziehungsweise Zellstruktur, Mindest-N je Bedingung oder Zelle
  und Auswertungsregel vorab festgelegt; für Anlage A entfällt jede
  Interaktionsauswertung.

Gate:

- kein stiller Arm-Fallback;
- keine unbekannten Gold-IDs;
- reproduzierbarer Report;
- Label-Shuffle-Null und Kontrollarm vorhanden;
- keine Fremdzahl ohne Evidenzklasse und keine gemeinsame Rangliste aus
  Messungen mit unterschiedlichem Reader, Judge, Top-k oder Kontextbudget;
- eine registrierte Cue-Versuchsanlage (A oder B) liegt versioniert vor — bei
  Anlage A mit zwei Bedingungen, Auswahl-/Holdout-Trennung und Mindest-N je
  Bedingung, bei Anlage B mit acht Zellen und Mindest-N je Zelle, jeweils samt
  Auswertungsregel.

### 18.2 M1 – Relevanz und Abstention

Hypothese:

> Ein deterministischer, erklärbarer Relevanz- und No-answer-Gate reduziert
> Fehlinjektionen stark, ohne den Recall echter Gold-Memories relevant zu
> verschlechtern.

Datensätze:

- echte unabhängige Paraphrasen;
- Anti-Halluzinationsqueries;
- Cross-Scope-Fälle;
- Identifier und technische Symbole;
- deutsche, englische und gemischte Queries;
- harte semantische Distraktoren;
- absichtlich leere Queries mit keinem passenden Memory.

Metriken:

- Recall@1/@3/@10;
- MRR und nDCG;
- Precision der Required-Band;
- False-Interrupt-Rate;
- Abstention Precision/Recall;
- unabhängige menschliche beziehungsweise kuratierte Relevanzlabels;
- Context-Tokens pro `acted_on`;
- Rate echter Golds, die fälschlich abstained wurden;
- Load-/Use-Rate getrennt nach Hook-Formulierung, Client und Hook-Quelle;
- Argumenttreue bei handlungsbezogenen Fällen, also die korrekte Übernahme
  gespeicherter Pfade, Limits, Präferenzen und Sicherheitsregeln in die
  Argumente eines Tool-Aufrufs;
- korrekte Nichtanwendung einer irrelevanten Memory;
- Premise Awareness bei Queries mit falscher Voraussetzung;
- falsche Anwendung einer inhaltlich richtigen Memory.

Die handlungsbezogenen Metriken haben einen konkreten Anlass: Eine peer-reviewte
Arbeit zur Anwendung von Erinnerung in Tool-Aufrufen misst für passives
Retrieval rund 30,7 Argument-F1 gegenüber rund 53,8 bei perfektem
Oracle-Retrieval. Das Finden der richtigen Evidenz ist damit der **dominante**
Engpass — aber nicht der einzige: Auch mit perfektem Retrieval bleiben knapp
die Hälfte der Argumente falsch. Die korrekte Anwendung einer richtig
gefundenen Erinnerung ist ein eigenes, ungelöstes Problem. Für Bastra folgt
daraus beides: Retrieval ist die Größe, die V1.0 verbessern will und deshalb
gemessen werden muss; und ein Fortschritt beim Retrieval darf nicht als
Fortschritt bei der Anwendung ausgegeben werden. Deshalb stehen Argumenttreue
und korrekte Nichtanwendung als eigene Metriken neben Recall@k.

Definitionen:

- `nDCG@k` verwendet die versionierte Relevanzskala `0 = irrelevant`,
  `1 = optional relevant`, `2 = klar relevant`; Fälle ohne abgestuftes
  Goldlabel werden nur mit MRR/Recall ausgewertet.
- `False-Interrupt-Rate` ist der Anteil der Gold-`no_answer`-Queries, bei denen
  der Hook trotzdem mindestens ein Memory automatisch injiziert.

AUROC, Calibration Error und `relevance_probability` werden erst in einer
späteren Kalibrierungsstufe verwendet, wenn M0/M1 genügend geeignete Labels
bereitstellen.

Vorläufige Komponenten-Schaltgates für den Evidenzentscheid:

- Anti-Query-Fehlinjektionen < 5 %;
- kein relevanter Recall@3-Verlust gegenüber demselben ungegateten
  Retrieval-Arm;
- Required benötigt harten Anker oder unabhängige Arm-Evidenz;
- kein relevanter Verlust bei Identifier-Queries;
- Falsch-Abstention bleibt unter der in M0 festgelegten Toleranz;
- ein Treffer auf einem abgeleiteten Cue erzeugt für sich genommen kein
  `required`;
- ein nur über einen Graph-Hop erreichter Treffer erzeugt für sich genommen
  kein `required`; der Report weist die Hop-Herkunft der Required-Treffer
  aus.

Recall@3 ≥ 85 % auf unabhängigen realen Paraphrasen, Context-Tokens pro
erfolgreicher Nutzung, Load-/Use-Rate und die zunächst angestrebte zehnfache
Context-ROI-Verbesserung werden ab V1.0 als Systemziele beobachtet. Sie sind
weder Live-Schaltgates des Evidenzentscheids noch vor Abschluss von M0 pauschale
V1.0-Releasebedingungen: Die absolute Coverage hängt auch vom Retrieval-Arm ab;
die übrigen Größen messen Retrieval, Hook-Formulierung, Consumer-Verhalten und
Telemetrie-Zuordnung gemeinsam.

Die numerischen Komponenten-Grenzen und die Systemziele werden erst nach dem
reproduzierbaren M0-Baseline-Run finalisiert.

Shadow-Abnahme:

- mindestens 14 Kalendertage oder mindestens 500 geloggte
  Hook-Entscheidungen; die Entscheidungs-Route gilt nur, wenn diese
  Entscheidungen aus **mindestens 20 verschiedenen Sessions** stammen und
  **keine einzelne Session mehr als 25 %** von ihnen stellt (C-085);
- alle retrieval-isolierten Komponentengates bestehen auf dem versionierten
  Goldset;
- jede beobachtete `required`/`no_answer`-Divergenz zwischen Legacy- und
  Evidenzentscheid ist durch Features, Reason-Code oder Review erklärbar;
- unerklärte Divergenzen blockieren die Live-Aktivierung.

**Streuungsanforderung an die Entscheidungs-Route (C-085).** Die Schwelle
kannte bislang nur eine Menge, keine Verteilung. Der Zweck des Shadow-Betriebs
ist aber, das Prädikat gegen die Verteilung echter Nutzung zu beobachten, und
eine Menge aus einer einzigen Sitzung ist keine Verteilung: Sie trägt einen
Vault-Zustand, ein Projekt, eine Arbeitsweise und einen Tagesrhythmus. Ein
einziger intensiver Arbeitstag konnte das Tor formal füllen. Die 14-Tage-Route
bleibt davon unberührt — Zeit erzeugt Streuung von allein und braucht keine
zusätzliche Auflage.

**Was gezählt wird.** Gezählt wird pro **Memory-Entscheidung**, nicht pro
Hook-Aufruf: Ein Aufruf, der über acht Kandidaten entscheidet, liefert acht
zählende Entscheidungen. So ist die Schwelle implementiert
(`packages/daemon/scripts/stats.ts`, `shadowDecisions`), und so ist sie
gemeint; die Formulierung „geloggte Hook-Entscheidungen" in C-022 bezeichnet
dieselbe Größe. Die Session-Zuordnung folgt derselben Zählung: Eine Session
zählt, sobald sie mindestens eine zählende Entscheidung trägt, und ihr Anteil
bemisst sich an den Entscheidungen, nicht an den Aufrufen.

Rollout und Rollback:

- Live-Aktivierung erfolgt hinter einem Konfigurations-Flag;
- bei Fehler, Drift oder operativer Unsicherheit fällt Recall sofort auf das
  heutige Score-/Floor-Verhalten zurück;
- es gibt keinen Hard-Cutover;
- der Legacy-Pfad wird erst nach dokumentiert stabilem Live-Betrieb und einer
  gesonderten Freigabe entfernt.

### 18.3 M2 – Adaptive Retrieval-Kaskade

Hypothese:

> BM25-first mit bedingtem Semantic Recall senkt p95, ohne die semantische
> Coverage zu verlieren.

Arme:

- heutiger Always-Hybrid-Pfad;
- BM25-only;
- adaptive Kaskade;
- adaptive Kaskade plus bedingter lokaler Reranker;
- adaptive Kaskade plus Gravity- und Hub-Dämpfung;
- flacher Kontrollarm ohne jede Graph-Sicht als Referenz für spätere
  Graph-Experimente.

Die Cue-Schicht wird read-only beziehungsweise im Shadow als **2×2-faktorielles
Design über die beiden Cue-Achsen** verglichen — nicht als vier beliebige
Varianten:

| Arm | beschreibende Achse | assoziative Achse |
|---|---|---|
| 1 — Referenz | aus | aus |
| 2 | ein | aus |
| 3 | aus | ein |
| 4 | ein | ein |

Ausgewertet werden getrennt:

- die **Hauptwirkung der beschreibenden Achse** aus dem Vergleich (2 gegen 1)
  und (4 gegen 3);
- die **Hauptwirkung der assoziativen Achse** aus (3 gegen 1) und (4 gegen 2);
- die **Interaktion** aus der Differenz beider Hauptwirkungen.

Diese Auswertung ist der Grund für das Design: Arm 4 verdeckt die Arme 2 und 3
nur dann, wenn man ihn als fünfte Variante gegen den Referenzarm liest. Als
Zelle eines faktoriellen Plans trägt er im Gegenteil zu beiden Hauptwirkungen
bei und liefert zusätzlich die Interaktion. Fällt die Interaktion deutlich
negativ aus, gehören die Achsen nicht gemeinsam live, auch wenn jede für sich
einen Lift zeigt.

**Stufenproblem und zulässige Varianten.** Die beschreibende und die assoziative
Achse existieren je einmal auf Item- und einmal auf Szenenebene, und die
Szenenebene setzt das Episoden- und Claim-Schema aus M4 voraus. M2 darf deshalb
nur eine der beiden folgenden Varianten fahren und muss im Report ausweisen,
welche:

**Variante (a) — gestuft, ohne neue Infrastruktur.** M2 prüft das 2×2 auf
Item-Ebene mit `descriptive_entity` und `associative_bridge`. Die Szenenebene
mit `descriptive_scene` und `associative_horizon` folgt nach M4 als eigene,
gleich aufgebaute Ablation. Dies ist der empfohlene Weg, weil er keine
Vorleistung braucht.

**Variante (b) — vollständig, mit Vorleistung.** M2 prüft alle vier Familien,
setzt dafür aber eine klar definierte read-only Episoden- beziehungsweise
Szenenprojektion voraus, samt benannter Datenquelle und eigenen Goldfällen für
szenenbezogene Treffer. Ohne diese Projektion sind Szenen-Cues nicht bildbar.

**Erzeugungsweg: zwei zulässige Versuchsanlagen.** Der Product-Owner-Entscheid
aus 31 vertagt die Wahl zwischen agentengenerierten und batch-generierten Cues
und gibt sie in M2 zur kontrollierten Prüfung. Dafür gibt es genau zwei
zulässige Anlagen, und **vor dem Lauf wird registriert, welche gefahren wird**:

**Anlage A — gepaarter Zwei-Bedingungen-Vergleich (empfohlen).** Die Cue-Achsen
werden auf **einer** Konfiguration festgehalten; verglichen werden genau **zwei
Bedingungen** — Agenten-Cues gegen Batch-Cues. Anlage A hat damit **zwei
Bedingungen und keine vier Zellen**: Die vier Zellen des 2×2 gehören zum
Cue-Achsenversuch und existieren hier nicht mehr, weil die Achsen festgehalten
sind. Der Vergleich ist gepaart, weil beide Erzeugungswege auf denselben
Goldfällen laufen; das senkt das nötige N erheblich.

Die festgehaltene Konfiguration darf **nicht** auf denselben Fällen bestimmt
werden, auf denen anschließend verglichen wird — sonst wäre der Vergleich durch
die Auswahl kontaminiert. Zulässig ist genau eines von beidem:

- ein vorab getrennter **Auswahlteil**, auf dem die Cue-Konfiguration bestimmt
  wird, und ein davon unabhängiger **Holdout**, auf dem der Erzeugungsweg
  verglichen wird; oder
- eine vorab registrierte **verschachtelte Auswertung**, die Auswahl und
  Vergleich innerhalb derselben Fallmenge sauber trennt.

Die Aufteilung beziehungsweise das Verschachtelungsschema ist Teil der
Registrierung nach 18.1.

Das Ergebnis von Anlage A gilt **nur für die festgehaltene Konfiguration**. Es
erlaubt **keine Interaktionsaussage**: Ob ein Erzeugungsweg auf einer anderen
Cue-Konfiguration anders abschneidet, bleibt unbeantwortet und darf nicht
behauptet werden.

**Anlage B — vollständig gekreuztes 2×2×2.** Der Erzeugungsweg tritt als dritter
Faktor neben die beiden Cue-Achsen. **Nur diese Anlage besitzt acht Zellen, und
nur sie kann Interaktionen zwischen Erzeugungsweg und Cue-Achse messen.** Sie
benötigt dafür ein **eigenes, entsprechend größeres Mindest-N je Zelle**, das
nach 18.1 vor dem Lauf festzulegen ist.

Eine dritte Möglichkeit gibt es nicht. Insbesondere ist es unzulässig, den
Erzeugungsweg während des Laufs oder nachträglich als zusätzlichen Arm
hinzuzunehmen: Das ergäbe ein unvollständig besetztes Design, dessen
Haupteffekte mit dem Erzeugungsweg konfundiert wären.

Ohne Variante (a) oder (b) darf ein M2-Report **nicht** behaupten, alle vier
Cue-Familien geprüft zu haben. Ein auf Item-Ebene gemessener Befund wird
nicht auf die Szenenebene übertragen.

**Statistische Ausführbarkeit.** Ein faktorielles Design ist nur so viel wert
wie seine Fallzahl. Deshalb gilt:

- Das nach M0 versionierte Mindest-N je Zelle ist Voraussetzung für jede
  Aussage über Hauptwirkungen und Interaktion. Für den Erzeugungswegversuch
  nach Anlage A gilt es entsprechend je **Bedingung**; Interaktionsaussagen
  entfallen dort ganz. Für die Interaktion liegt es
  höher als für die Hauptwirkungen — sie ist die schwächere Größe.
- Reicht das erreichbare N für die Interaktion nicht, wird sie im Report
  ausdrücklich als **explorativ** gekennzeichnet. Ein exploratives Ergebnis
  beschreibt eine Beobachtung; es trägt **keine Live-Freigabe** und kein Gate.
  Die Hauptwirkungen bleiben davon unberührt, sofern ihr eigenes Mindest-N
  erreicht ist.
- Reicht das N auch für die Hauptwirkungen nicht — beziehungsweise bei
  Anlage A für den Bedingungsvergleich —, ist der Arm nicht auswertbar und
  wird als solcher berichtet, nicht als Null-Befund.

**Konstante Umgebung im Erzeugungswegversuch.** Innerhalb des registrierten
Erzeugungswegversuchs bleiben Kaskade, Dämpfung, Reranker, Pool und
Query-Klassen über **alle Bedingungen der registrierten Anlage** konstant und
entsprechen dem für M2 festgelegten Referenz-Setup — zwei Bedingungen bei
Anlage A, acht Zellen bei Anlage B. Variiert wird dort ausschließlich, was die
registrierte Anlage als Faktor führt: bei Anlage A allein der Erzeugungsweg,
bei Anlage B die beiden Cue-Achsen und der Erzeugungsweg.

Die Konstanzregel für den **2×2-Cue-Achsenversuch** bleibt davon unberührt: Dort
bleibt die übrige Retrieval-Konfiguration über alle vier Zellen konstant, und
variiert werden ausschließlich die beiden Cue-Achsen. Die beiden Regeln gelten
nebeneinander für zwei verschiedene Versuche. Der Versuch wird **nicht** ungeplant mit den übrigen
M2-Armen vollständig gekreuzt: Ein solches Crossing vervielfacht die Zellen,
verwässert die Fallzahl je Zelle und macht jede Interaktionsaussage wertlos. Es
ist nur nach einem **vorab registrierten Design** zulässig, das die
Zellenstruktur, das Mindest-N je Zelle und die Auswertungsregel vor dem Lauf
festlegt und versioniert ablegt.

Ablated wird ausschließlich die Rankingwirkung eines Cues, niemals seine
Provenienz: Ziel-ID, Herkunft, Generatorversion und Evidenzverbindung sind in
jedem Arm vollständig vorhanden. Ein Arm, der Cues ohne Evidenzverbindung
ausspielt, wäre keine Negativkontrolle, sondern ein Verstoß gegen 11.4 und wird
nicht gefahren.

Gravity- und Hub-Dämpfung sind eigene Arme und keine Neuauflage der bereits
produktiven Dämpfung: Heute wirken Lifecycle-, Curator-, Doc- und
Salience-Multiplikatoren auf den vollen Kandidatenpool vor dem k-Schnitt.
Gravity-Dämpfung adressiert stattdessen semantisch nahe Treffer ohne
Query-Term-Überlappung, Hub-Dämpfung die Dominanz stark verlinkter Knoten.
Beide bleiben Hypothese, bis der Ablationsarm einen Präzisionsgewinn ohne
Recall-Verlust zeigt.

Metriken:

- p50/p95/p99;
- Provider-Aufrufe pro Recall;
- Query-Cache-Hitrate;
- Energie-/Modellresidenz;
- Recallqualität pro Query-Klasse;
- Timeout- und Degraded-Rate;
- Bridge- und Horizon-Recall@k auf assoziativen Goldfällen;
- Cue-to-Evidence-Precision und Rate falscher Assoziationen;
- assoziative False-Interrupt-Rate;
- Cue-Übertragung zwischen deutschen und englischen Queries.

Live-Gates:

- PreTool p95 < 150 ms;
- SessionStart p95 < 300 ms;
- BM25-eindeutige Queries lösen keinen unnötigen Provider-Aufruf aus;
- semantische Query-Klassen verlieren nicht mehr als die definierte Toleranz.

Cue- und Dämpfungsarme verfolgen verschiedene Ziele und erhalten deshalb
getrennte Gates:

- **Cue-Arm.** Die assoziative Coverage steigt messbar, während die
  False-Interrupt-Rate nicht schlechter und der Recall auf den übrigen
  Query-Klassen nicht schlechter wird. Eine gesenkte False-Interrupt-Rate
  allein qualifiziert einen Cue-Arm nicht — dafür ist er nicht gebaut.
- **Dämpfungsarm.** Die False-Interrupt-Rate sinkt messbar, ohne relevanten
  Recall-Verlust gegenüber dem identischen Arm ohne die zusätzliche
  Gravity-/Hub-Dämpfung.

Die numerischen Toleranzen beider Gates werden wie alle übrigen erst nach dem
M0-Baseline-Run festgelegt und versioniert abgelegt.

M2 gibt weiterhin keine persistente Repräsentationsänderung frei. Eine
dauerhafte Speicherung abgeleiteter Cues benötigt denselben gesonderten
Repräsentationsentscheid wie Chunking und Dual-Vektoren gemäß 11.2 und 11.4.

### 18.4 M3 – Accessibility und Asteroidengürtel

Hypothese:

> Ein zoniertes Accessibility-Modell reduziert spontane Interferenz, während
> Deep Recall alte Memories zuverlässig wiederfindet.

Testfälle:

- häufig erfolgreich verwendete aktuelle Memories;
- alte, nie gebrauchte Memories;
- alte, aber hoch saliente Memories;
- gefloorte Memories;
- ersetzte Decisions;
- widersprechende Claims;
- dormant Memory mit exaktem Identifier;
- bewusste Deep-Recall-Query;
- dieselbe Deep-Recall-Query gegen einen Kontrollarm mit lediglich
  vervierfachtem `k` und gesenktem Floor.

Metriken:

- korrekte Zonenklassifikation;
- spontane False-Injection-Rate aus dem Gürtel;
- Deep-Recall@k für dormante Golds;
- Erklärbarkeit der Zonenentscheidung;
- Reaktivierungsrate nach erfolgreichem Deep Recall;
- Survival-by-ID und Zitierbarkeit;
- Zeit bis zur ersten belastbaren Evidenz;
- Zahl der Suchäste, Sackgassenquote und Konvergenzquote;
- Budgetüberschreitungen und Zahl bewusster Budgetverlängerungen;
- Evidence Coverage und Zitationsvollständigkeit;
- Qualität der `no_answer`-Fälle, getrennt von der Rate der
  `inconclusive_budget_exhausted`- und der `inconclusive_interrupted`-Fälle;
- Coverage-Verteilung der `no_answer`-Fälle, damit vollständige Fehlanzeigen
  von teilbeantworteten Läufen unterscheidbar bleiben;
- Rate der Controllerdefekte, getrennt von allen Ergebniswerten geführt;
- Anteil der Läufe, die an einer Budgetgrenze statt an Erschöpfung enden,
  aufgeschlüsselt nach der zuerst erreichten Grenze;
- falsche Reaktivierungen.

Live-Gates:

- Floors sinken nie automatisch in Deep-only;
- Historical wird nie als aktuelle Regel ausgegeben;
- exakte IDs bleiben erreichbar;
- Deep Recall findet definierte dormante Golds;
- Normal Recall injiziert keine Belt-Memories ohne außergewöhnlich starke,
  explizit messbare Evidenz;
- weder Stufe 1 noch Stufe 2 aus 8.5 wird aus einem Hook heraus ausgelöst;
- Stufe 1 schlägt den `k`-Kontrollarm messbar, sonst ist der Deep-Recall-Modus
  nicht gerechtfertigt;
- Stufe 2 geht nur live, wenn sie gegenüber Stufe 1 einen eigenen, an Kosten
  und Latenz gemessenen Nutzen zeigt und ihre Abbruchbedingungen aus 8.5
  nachweislich greifen;
- kein Lauf gibt einen Budgetabbruch als `no_answer` aus; die vier Ergebnisse
  aus 8.5 sind in der Telemetrie unterscheidbar;
- kein Controllerdefekt erscheint als Ergebniswert oder als `stop_reason`; er
  wird als strukturierter Fehler mit read-only Teilzustand signalisiert und
  nicht in die Ergebnisstatistik gezählt;
- `no_answer` wird nie als „keine Evidenz vorhanden" ausgegeben, solange
  `coverage` größer als null **oder** `evidence` nicht leer ist;
- die Budgetgrenzen sind versioniert abgelegt und im Report ausgewiesen;
- ausbleibender Evidenzgewinn schließt nachweislich nur den betroffenen Ast:
  kein Lauf endet mit `no_answer`, solange die Telemetrie offene Äste ausweist;
- das Ergebnisobjekt aus 8.5 kommt an MCP, REST, CLI und Mindspace
  unterschiedbar an; kein Konsument bildet einen Budgetstatus auf `no_answer`
  ab und keiner fasst die beiden inconclusive-Werte zusammen;
- `inconclusive_budget_exhausted` tritt ausschließlich mit tatsächlich
  erreichter Grenze und gesetztem `limit` auf; eine reguläre externe
  Unterbrechung meldet `inconclusive_interrupted` mit einem `stop_reason` aus
  `user_cancelled`, `shutdown` oder `permission_revoked`; ein Controllerdefekt
  meldet keinen Ergebniswert, sondern `DeepRecallDefect`;
- ein Fund im selben Schritt wie eine erreichte Grenze ergibt `answer_found`
  mit mitgeführtem `limit`.

### 18.5 M4 – Episoden und Konsolidierung

Hypothese:

> Die Trennung von Episoden und Semantik reduziert Interferenz und erzeugt
> bessere dauerhafte Lessons.

Metriken:

- Cluster Precision;
- Anteil Generalisierungen mit vollständiger Evidenz;
- Gegenbeispiel-Abdeckung;
- Widerspruchserkennung;
- Nutzerannahme der Vorschläge;
- Rate falscher oder zu früher Generalisierungen;
- Retrievalqualität vor und nach Konsolidierung;
- Korrektheit von Punkt-in-der-Zeit-Abfragen über die vier Zeitachsen aus 6.3;
- Trennschärfe der `provenance_class` in Stichproben;
- Rate falscher Kanten und Entity-Linking-Fehler je logischer Sicht;
- Ergebnis jeder Sicht gegen den No-Graph-Kontrollarm;
- Reversibilität jeder ausgeführten Topologie-Operation.

Schema-/Live-Gates:

- keine autonome Regeländerung;
- jede Lesson verweist auf ihre Episoden oder Quelle;
- Widersprüche werden angezeigt, nicht still überschrieben;
- Episode bleibt nach Konsolidierung erhalten;
- ein erkannter Widerspruch erzeugt einen sichtbaren Konfliktbefund und einen
  `LINK`-Vorschlag für die `contradicts`-Kante, setzt aber kein `retracted_at`;
  zeitlich invalidiert wird ausschließlich durch eine bestätigte Auflösung;
- eine historische Aussage bleibt nach `SUPERSEDE` über ID, Version und Zitat
  erreichbar;
- die Survival-Quote nach 14.4 erreicht innerhalb jedes Berechtigungs-,
  Scope- und Sensitivity-Kontextes 100 % innerhalb von `max_provenance_hops`,
  und die Zitationsquote abgeleiteter Memories ist je Kontext vollständig;
- keine Quote zählt eine Quelle im Nenner eines Kontextes, in dem sie nicht
  sichtbar sein darf;
- die Wiederholungssperre reagiert auf den strukturellen Fingerprint aus 14.4
  und nicht auf Cache-, Telemetrie-, `stale_status`- oder
  Zeitstempeländerungen;
- ein abgelehnter Vorschlag kehrt nur zurück, wenn struktureller Fingerprint
  **und** semantischer Vorschlagshash sich geändert haben und mindestens eine
  der fünf materiellen Größen aus 14.4 benannt ist; der semantische Hash umfasst
  Operatortyp, normalisierte Zieländerung, Quell-IDs und -Versionen, betroffene
  Kanten, sortierte Evidenzreferenzen, Reason-Code, strukturierten
  Schutzkonfliktstatus samt Auflösung und die Hash-Schema-Version, gebildet aus
  einer versionierten kanonischen Struktur ohne freien Erklärungstext; die
  Quellversion ist eine semantische Inhaltsversion und nicht `updated`; Ablehnungsprotokoll, Hash und
  Vorschlagsvergleich sind je Struktur nachweisbar;
- die Survival-Invariante wird vor jeder einzelnen Klasse-A-Operation simuliert;
  Shortcut oder sichtbarer Zwischenknoten sind Teil desselben atomaren
  Vorschlags, und kein Zwischenzustand eines Konsolidierungslaufs verletzt sie;
- kein Shortcut entsteht als separater automatischer `LINK`, und keiner trägt
  eine private Quelle in einen weniger geschützten Sichtbarkeitsbereich;
- ein blockierter Vorschlag hinterlässt keinen Teilzustand und wird innerhalb
  desselben Laufs nicht wiederholt;
- eine Änderung von `max_provenance_hops` erfolgt ausschließlich als
  gesonderter, gemessener Vorschlag und nie als stillschweigende Anpassung;
- `SUPERSEDE` verschiebt den Vorgänger weder in den Trash noch aus dem Index;
  er bleibt über den Historical-/Deep-Recall-Zugriff nach ID, Version und
  Zitat auflösbar;
- ein `SUPERSEDE`-Rollback stellt Versionsstatus, Zeitstatus, Speicherort,
  Indexierbarkeit und Sichtbarkeit wieder her;
- eine Graph-Sicht geht nur live, wenn sie ihren No-Graph-Kontrollarm schlägt;
- jede Topologie-Operation der Klasse A ist vor der Persistenz freigegeben und
  einzeln zurückrollbar;
- kein Klasse-B-Operator erzeugt eine Version, und keine dauerhafte
  Zugänglichkeitsentscheidung entsteht ohne expliziten Floor- oder
  Pin-Override;
- `user_asserted` entsteht nur mit einem vom speichernden Caller nicht
  behauptbaren, später auflösbaren Bestätigungsbezug — nachrangig gegenüber der
  folgenden Zeile, die den Entstehungsort abschließend festlegt;
- ein direkt übergebenes `provenance_class: user_asserted` unterliegt derselben
  Prüfung und bildet keinen Bypass;
- `user_asserted` entsteht ausschließlich über eine bestätigte Review; kein
  Save-Pfad erzeugt die Klasse automatisch;
- jede Bestätigung ist an `memory_id` und den Hash des im Review dargestellten
  aussagetragenden Inhalts gebunden und verfällt bei dessen Änderung; eine
  Änderung an Retrieval-, Darstellungs- oder Betriebsmetadaten löst keinen
  Verfall aus;
- kein Memory ist von der Reviewberechtigung ausgeschlossen; Importstatus und
  `write_origin` bestimmen nur die Ausgangsklasse und den Vorschlagswert;
- die Oberfläche kann `agent_observed`, `derived` und `hypothesis` einzeln
  erreichen; kein Pfad fasst sie zu einer Klasse zusammen, und die Rückfrage ist
  nicht überspringbar;
- keine Antwort ist vorausgewählt; `confirmed` entsteht nur nach aktiver
  Auswahl, und ein Weiter-Klick ohne Auswahl erzeugt keinen
  Bestätigungsbezug;
- kein Memory bleibt dauerhaft ungeprüft: Am Ende der Bestandsprüfung trägt
  jedes entweder eine geklärte Klasse oder ein bestätigtes `unknown_legacy`;
- das Strukturkriterium für die Grenze zwischen Prüfstufe 2 und 4 liegt vor dem
  Aufbau der Warteschlange versioniert im Queue-Manifest vor, stammt aus einem
  eingefrorenen Graph-Snapshot und wandert während des Laufs nicht; jedes
  historieunbekannte Memory, das weder unter Stufe 1 noch unter Stufe 3 fällt,
  ist dadurch deterministisch genau einer der beiden verbleibenden Stufen
  zugeordnet, und bei fehlendem Snapshot fällt es nach Stufe 4;
- die Stufenzuordnung wird in der Reihenfolge 1 → 3 → 2 → 4 ausgewertet;
- kein Dokument und kein Manifest behauptet, das Feld `bridge` belege eine
  graphentheoretische Brücke oder einen Artikulationsknoten; es geht
  ausschließlich als clusterübergreifende Nachbarschaft — Nachbarn in
  mindestens zwei unterschiedlichen fremden Clustern — in das Strukturkriterium
  ein;
- das Queue- beziehungsweise Run-Artefakt belegt die Zuordnung ohne den
  Live-Graphen: Projektionsschema und Version, Snapshot-Hash,
  Erstellungszeitpunkt, angewandtes Kriterium samt Schwellenwert oder Quantil
  sowie je zugeordnetem historieunbekannten Memory dessen ID, `degree`, fremde
  Cluster beziehungsweise `bridge`-Wert und resultierende Stufe — alternativ ein
  content-addressed persistierter Snapshot samt Referenz;
- während eines laufenden Reviews findet weder eine Neuberechnung des Snapshots
  noch eine Neuzuordnung eingereihter Memories statt, und ein Neustart setzt
  dieselbe Warteschlange mit denselben Zuordnungen fort;
- ein Reason-Code, den die geltende Vokabularversion nicht kennt, löst keine
  Wiedervorlage aus.

Die Bedingungen zur Bestandsprüfung stehen hier, weil sie zusammen mit den
Provenienzfeldern geprüft werden — nicht, weil sie an M4 hingen. Zuordnung,
Snapshot und Nachweisartefakt sind Sidecar-/Run-Artefakte nach C-018 und C-025
und jederzeit zulässig; M4 bindet ausschließlich die persistenten Schemafelder.

### 18.6 M5 – Skalen- und Interferenztest sowie Flat/HNSW-Entscheidung

M5 beantwortet zwei verschiedene Fragen, die getrennt gemessen werden, weil sie
getrennte Ursachen haben: Wie zerfällt die Qualität, wenn der Vault wächst — und
lohnt sich ein anderes Vector-Backend? Ein gemeinsamer Lauf würde beides
vermischen und jeden Befund unbrauchbar machen.

#### 18.6.1 Skalen- und Interferenztest (backend-agnostisch)

Hypothese:

> Wachsender Vault erzeugt Interferenz, die sich nicht in der Latenz zeigt,
> sondern in Abstention, Widerspruchsauflösung und temporaler Genauigkeit.

Dieser Test ist eine Messung im Sinne von C-018 und darf jederzeit laufen. Er
gatet nichts und hängt an keinem Backend: Er wird auf **demselben** Backend über
alle Skalenstufen gefahren, damit ein beobachteter Abfall dem Wachstum und nicht
dem Index zuzuschreiben ist.

Skalen: aktueller Vault, 1.000, 3.000, 10.000, 50.000 Memories beziehungsweise
Chunks.

Heute messbare Kategorien:

- Abstention-Precision und -Recall auf den bestehenden Anti-Query- und
  `no_answer`-Fällen;
- Interferenz durch semantisch benachbarte Memories;
- Recall@1/@3/@10 und False-Interrupt-Rate je Skalenstufe;
- Latenz- und Degraded-Verhalten je Skalenstufe.

Erst nach M4 messbar, weil sie das Claim-, Versions- und Zeitschema
voraussetzen:

- Auflösung widersprechender Claims;
- temporale Fragen mit Versions- oder Gültigkeitsbezug;
- korrekte Reihenfolge zeitlich geordneter Ereignisse.

Diese zweite Gruppe wird vor M4 ausdrücklich nicht behauptet, nicht approximiert
und nicht als Lücke im Report verschwiegen; sie erscheint als „noch nicht
messbar, abhängig von M4“.

Die zuvor offene Frage, ob vier von sieben Kategorien für einen aussagekräftigen
Test genügen, ist entschieden: **Sie genügen.** Dieser Test gatet nichts — er
ist eine Messung im Sinne von C-018 und liefert einen Verlauf, keine
Freigabeentscheidung. Vier unabhängig messbare Kategorien zeigen einen
Interferenzanstieg unter Wachstum zuverlässig genug, um Handlungsbedarf zu
erkennen. Die drei M4-abhängigen Kategorien werden nach M4 ergänzt und dürfen
vorher unter keinen Umständen behauptet werden.

Toleranzen: Für jede heute messbare Kategorie wird nach dem M0-Baseline-Run ein
numerischer maximaler Abfall je Skalenverdopplung festgelegt und versioniert
abgelegt. Eine Ursachenbeschreibung dokumentiert einen Befund, ersetzt aber
niemals eine eingehaltene Toleranz: Ein verfehltes Ziel bleibt verfehlt, auch
wenn die Ursache bekannt ist.

Der Anlass ist belegt: Ein verbreitetes Fremdsystem erreicht auf kurzen
Konversationsbenchmarks Werte über 90 %, fällt aber bei zehn Millionen Token
Historie auf 50,5 % Pass Rate, mit deutlich schlechteren Teilwerten für
temporale Fragen, Widerspruchsauflösung und Abstention (siehe 2.3 für die
exakte Skala). Diese Zahlen stammen aus **verschiedenen Benchmarks mit
verschiedenen Aufgaben, Fragenmengen und Retrieval-Tiefen** und sind deshalb
kein isolierter Skalierungsbeweis: Sie zeigen nicht, dass Wachstum die Ursache
ist, sondern nur, dass niemand den Gegenbeweis erbracht hat. Sie sind der Grund,
selbst zu messen — mehr nicht. Absolutwerte des Fremdsystems sind kein Zielwert
(siehe 2.3); relevant ist ausschließlich der eigene Verlauf über die eigenen
Skalenstufen bei sonst identischem Aufbau.

#### 18.6.2 Flat/HNSW-Entscheidung (Live-Gate)

Hypothese:

> Automatische Backend-Wahl verbessert große Vaults, ohne relevante Treffer
> gegenüber exakter Flat Search zu verlieren.

Der Vergleich läuft auf **identischem Korpus, identischen Queries und
identischer Konfiguration**; die einzige Variable ist das Backend. Ein Vergleich
über verschiedene Korpusgrößen oder Konfigurationen hinweg ist kein
Backend-Vergleich.

Metriken:

- Buildzeit;
- RAM;
- Indexgröße;
- Update- und Delete-Latenz;
- Search-p50/p95/p99;
- Recall@3/@10 gegen Flat-Gold;
- Snapshot-Recovery;
- automatische Switch-Entscheidung;
- Fallback-Zeit.

Live-Gates:

- Recall@10 gegenüber Flat ≥ 98 % bei identischem Korpus und identischer
  Konfiguration;
- keine Sensitivity- oder Scope-Leaks;
- p95 tatsächlich besser;
- atomarer, wiederholbarer Switch;
- Flat-Fallback jederzeit funktionsfähig;
- keine Verschlechterung der in 18.6.1 gemessenen Qualitätskategorien über die
  dort festgelegten Toleranzen hinaus, gemessen auf demselben Korpus mit
  beiden Backends.

### 18.7 M6 – Learned Ranking und Accessibility

Ein reines Shadow-Modell darf nach abgeschlossenen M0 und M1 beginnen. M3 bis
M5 sind dafür keine Voraussetzung; Signale aus noch nicht existierenden Stufen
bleiben im Modell abwesend:

- Shadow-Modell;
- keine Live-Mutation;
- Zeit-Split statt zufälligem Split;
- Projekte und Personen getrennt evaluieren;
- positives, negatives und zensiertes Feedback unterscheiden;
- Driftmonitoring;
- reproduzierbarer Rollback;
- ausgewiesene Exposure-Normalisierung gemäß 17.5 auf jedem Nutzungssignal;
- eine Aussage über kausalen Lift erst, wenn Propensity-Logging, kontrollierte
  Exploration und die Zensur-Behandlung nicht ausgespielter Kandidaten
  vorliegen; bis dahin sind ausschließlich deskriptive Ratenvergleiche
  zulässig;
- Mindest-N je Query-, Client- und Hook-Klasse vor jeder Aussage über Lift;
- Co-Occurrence-Projektionen ausschließlich shadow und nur mit Hub-Kontrolle;
- eine Stufenentscheidung zwischen Ausführen, Überspringen und Aussetzen darf
  frühestens nach erreichtem Mindest-N überhaupt aktiv werden, und die
  Grundstufen BM25 und exakter Abruf bleiben immer garantiert verfügbar.

Live-Freigabe nur nach bestandenem M6, nachgewiesenem inkrementellem Lift über
den deterministischen Evidenzentscheid, erklärbarem Verhalten und
reproduzierbarem Rollback. Der Fallback ist die deterministische Reihenfolge des
Evidenzentscheids und nicht das Legacy-Score-Verhalten.

## 19. Eval-Datensätze

Der wachsende V1→V2-Goldbestand benötigt mindestens:

- unabhängige reale Paraphrasen;
- echte No-answer-Queries;
- harte semantische Distraktoren;
- Cross-Scope- und Cross-Project-Fälle;
- Zeit- und Versionsfragen;
- widersprechende Memories;
- exakte IDs, Pfade und Symbole;
- Deutsch, Englisch und gemischte technische Sprache;
- Episoden gegen semantische Regeln;
- Dormant- und Deep-Recall-Fälle;
- private und team/public Sensitivity;
- Dokumente mit langen Bodies;
- Query-Typen aus realer Hook-Telemetrie;
- handlungsbezogene Fälle, in denen eine frühere Regel, ein Pfad, ein Limit
  oder eine Sicherheitsvorgabe in die Argumente eines Tool-Aufrufs eingehen
  muss, einschließlich Fällen, in denen die korrekte Antwort das
  Nichtanwenden einer vorhandenen Memory ist;
- assoziative Fälle, deren Query dem Ziel-Memory weder lexikalisch noch
  semantisch ähnelt und die nur über den situativen Zusammenhang auflösbar
  sind;
- beschreibende Fälle, deren Query das Ziel-Memory über Begriff, Entity oder
  Szenenbeschreibung benennt. Beschreibende und assoziative Fälle werden
  getrennt ausgewiesen, weil sie die beiden Achsen des Cue-Versuchs aus 18.3
  unabhängig voneinander messbar machen müssen.

Jeder Fall erhält:

- Query;
- unabhängige Herkunft;
- erwartete IDs;
- akzeptable Alternativen;
- erwartete Zone;
- `no_answer` ja/nein;
- Scope;
- Zeitpunkt beziehungsweise Versionssicht;
- erlaubte Retrieval-Tiefe;
- Begründung des Goldlabels.

Zulässige unabhängige Query-Quellen sind datenschutzkonform aufbereitete reale
Session-Transkripte, ursprüngliche Task-Texte, Issue-/Incident-Beschreibungen,
direkt vom Nutzer formulierte Suchanfragen und eine unabhängig arbeitende
Zweitperson. Beim Formulieren oder Auswählen der Query dürfen Body, Summary und
`recall_when` des Ziel-Memorys nicht geöffnet werden. Die Zuordnung zum
Gold-Memory erfolgt erst danach durch einen getrennten Label-Schritt.

Für jeden Goldfall sind im Datensatzmanifest und im privaten Run-Artefakt
folgende Provenienzfelder verpflichtend:

- `origin_type`: `session_transcript`, `task_text`, `issue_incident`,
  `user_query` oder `second_person`;
- `authoring_mode`: wie die Query unabhängig gewonnen oder formuliert wurde;
- `origin_ref_hash`: datenschutzkonformer Hash der lokalen Herkunftsreferenz.

Rohtext oder eine auflösbare lokale Herkunftsreferenz bleiben privat und werden
nicht in aggregierte öffentliche Reports übernommen.

### 19.1 Externe Standardbenchmarks

Das lokale Goldset bleibt der maßgebliche Maßstab für Bastras Produktscope.
Externe Standardbenchmarks für Langzeitgedächtnis beantworten eine andere Frage
— externe Vergleichbarkeit — und sind deshalb Adapterarbeit in V1.x, nicht Teil
des V1.0-Releasevertrags. Insbesondere ist kein vollständiger Lauf eines
großskaligen Trajektorien-Benchmarks eine V1.0-Releasebedingung; ein
repräsentatives lokales Subset genügt für die erste Einordnung.

**Entschieden (31, Entscheidung 2):** Es wird **genau ein** externer Benchmark
adaptiert, und zwar ein **handlungsorientierter** — einer, der misst, ob eine
frühere Aussage korrekt in eine spätere Handlung eingeht, nicht ob sie
wiedergegeben werden kann. Er ist Adapterarbeit in V1.x und ausdrücklich kein
V1.0-Releaseblocker. Die kleinere Vergleichsbasis handlungsorientierter
Benchmarks wird bewusst in Kauf genommen, weil sie näher an Bastras
Produktscope liegt als ein konversationsorientierter Test.

Für jeden externen Lauf gelten die Regeln aus 2.3 und M0: Evidenzklasse,
Harness- und Modellversionen, Kontextbudget und Top-k werden mitgeführt, und
Retrieval- wird von Antwortqualität getrennt ausgewiesen. Ein externer Score ist
nie ein Live-Gate. Es wird ausdrücklich nicht auf einen einzelnen
Headline-Score optimiert.

## 20. Produktmetriken

Die Recall-Evolution optimiert nicht nur Suchtreffer:

Metriken werden erst mit der Datenquelle ihrer jeweils gegateten Stufe messbar.
Bis dahin beschreiben sie das Zielbild und dürfen nicht als vorhandene
Produkttelemetrie ausgegeben werden.

### Qualität

- Recall@k;
- MRR/nDCG;
- Required Precision;
- No-answer-Qualität;
- Konflikt- und Temporal Accuracy;
- Deep-Recall-Erfolg.

### Aufmerksamkeit

- Hook-Emissionen;
- geladene Hinweise;
- `acted_on`;
- Tokens pro erfolgreichem Einsatz;
- Wiederholungs- und Backoff-Rate;
- Anteil störender Hinweise.

### Geschwindigkeit

- p50/p95/p99 je Retrieval-Lane;
- Provider-Zeit;
- Cache-Hitrate;
- SessionStart-Zeit;
- Timeout- und Degraded-Rate.

### Gedächtnisgesundheit

- Episoden pro konsolidierter Lesson;
- ungeklärte Widersprüche;
- historische Versionen;
- Dormant-Anteil;
- reaktivierte Memories;
- veraltete Quellen;
- Anteil Memories ohne belastbare Evidenz.

## 21. Migration

### 21.1 V1.0 – Freigegebener Releasevertrag, keine Schemaänderung

- M0-Eval-Harness reparieren und reproduzierbare Run-Artefakte erzeugen;
- Score-, Evidenz-, Abstention- und No-answer-Telemetrie um `client`,
  `hook_source` und eine pseudonyme `session_id` erweitern;
- deterministischen Evidenzentscheid zunächst shadow ausführen und erst nach
  bestandenen retrieval-isolierten M1-Komponentengates aktiv schalten;
- den bestehenden Session-Context zu einem gemeinsamen, projektfähigen
  Assembler erweitern;
- unabhängige Serveranteile innerhalb dieses Assemblers parallelisieren;
- ein globales Kontext- und Latenzbudget einführen;
- Retrievalqualität und Wirkung der Hook-Formulierung in getrennten
  Experimentarmen messen.

### 21.2 V1.x/M2 – Adaptive Retrieval, live noch nicht freigegeben

Messung, Prototyp und Shadow-Betrieb sind jederzeit zulässig. Ein
Qualitätsvergleich wird erst gegen die M0-Baseline interpretiert. Eine
Live-Aktivierung erfolgt erst, wenn M2 sein Qualitäts- und Latenzgate erfüllt:

- BM25-first-Kaskade;
- bedingter semantischer Arm;
- Query-Embedding-Cache;
- Deadline- und Degraded-Verhalten;
- keine Verschlechterung der semantischen Query-Klassen.

### 21.3 V1.x/M3 – Accessibility und Deep Recall, live noch nicht freigegeben

Read-only Projektionen und Deep-Recall-Experimente sind jederzeit zulässig. Eine
Live-Aktivierung erfolgt erst, wenn M1 relevante alters-, konflikt- oder
zugänglichkeitsbedingte Interferenz nachweist und M3 sein Gate erfüllt. Die
Stufe beginnt ohne Schemaänderung:

- Accessibility ausschließlich als read-only Sidecar-Projektion;
- keine Markdown-Massenänderung;
- Zone und Gründe im UI anzeigen;
- Asteroidengürtel als read-only Projektion;
- Deep Recall experimentell und erst nach bestandenem M3-Gate live.

### 21.4 V1.x/M4 – Memory-Lanes, Claims und Konsolidierung, Schema/live noch nicht freigegeben

Isolierte Messungen, Fixture-/Sidecar-Prototypen und read-only Projektionen sind
jederzeit zulässig. Jede persistente Vault-Schema- oder Vertragsänderung
benötigt einen gesonderten Schemaentscheid auf Basis der bis dahin verfügbaren
Evidenz. Eine Live-Migration folgt ausschließlich nach bestandenem M4:

Memory-Lanes und Schema:

- `episode` ergänzen;
- optionale Claim-/Evidenzfelder;
- Version- und typed-edge-Schema;
- alte Memories bleiben vollständig kompatibel;
- Defaults werden aus bestehendem Type abgeleitet.

Konsolidierung:

- Replay-Sampler;
- Cluster und Widerspruchsvorschläge;
- Human Review;
- keine autonome semantische Mutation;
- ein Historical-/Deep-Recall-Zugriff, der superseded Vorgänger nach ID,
  Version und Zitat auflöst, bevor `SUPERSEDE` live geht — zunächst zulässig
  als logische Sicht auf dem bestehenden Index. Ohne diesen Zugriff gäbe es
  keinen Weg, der die Zitierbarkeit alter Versionen einlöst; das bestehende
  Archivierungsprimitiv leistet das ausdrücklich nicht (siehe 14.4).

### 21.5 V1.x/M5 – Vector Strategy, live noch nicht freigegeben

Messung, Prototyp und Shadow-Implementierung sind jederzeit zulässig. Eine
Live-Aktivierung erfolgt erst, wenn kontrolliertes Profiling auf der
Zielhardware einen realen Flat-Search-Engpass und M5 den Qualitäts- und
Latenzvorteil belegen. Providerlatenz allein ist kein Grund für HNSW:

- Backend-Abstraktion;
- Flat als Referenz;
- HNSW im Shadow;
- automatisches Qualitäts- und Latenzgate;
- atomarer Switch mit Fallback.

### 21.6 V1.x/M6 – Learned Layer, live noch nicht freigegeben

- reiner Shadow-Beginn nach stabiler Messgeometrie und abgeschlossenen M0/M1;
- M3–M5 sind für das Shadow-Modell keine Voraussetzung;
- shadow-first;
- zeitbasierte Offline-Evaluation;
- Live-Aktivierung nur nach bestandenem M6, expliziter Freigabe und
  nachgewiesenem Rollback.

### 21.7 V2.0 – Promotion statt Big-Bang

V2.0 wird erst vergeben, wenn die verpflichtenden Eigenschaften aus 26.2
gemeinsam nachgewiesen sind. Experimentelle V1.x-Funktionen werden nicht allein
durch ihre Existenz zu V2-Bestandteilen. Sie benötigen stabile Verträge,
Rückwärtskompatibilität, dokumentierte Migration, Rollback und ihre jeweils
bestandenen Messgates.

## 22. Rückwärtskompatibilität

- Markdown bleibt Source of Truth.
- Bestehende Memory-Typen bleiben gültig.
- `recall_when` bleibt das primäre handgeschriebene Abrufsignal.
- Bestehende IDs bleiben stabil.
- Alte Clients können weiterhin Lean-Hits erhalten.
- Neue Entscheidungs- und Evidenzfelder werden additiv eingeführt.
- Eine `relevance_probability` wird erst nach erfolgreicher Kalibrierung
  additiv angeboten; vorher bleibt sie abwesend.
- Ohne Embeddings funktioniert BM25 vollständig.
- Ohne HNSW funktioniert Flat Search vollständig.
- Ohne Accessibility-Sidecar gelten konservative Default-Zonen.
- Ohne Mindspace bleibt Deep Recall über API/CLI erreichbar.
- `valid_until` behält seine heutige Lifecycle-Semantik und wird nicht
  migriert; neue Zeitfelder kommen additiv daneben.
- Bestandsmemories ohne `provenance_class` gelten als `unknown_legacy`,
  importierte Bestände als `imported_unverified`; beide werden nicht massenhaft
  umgeschrieben.
- Ein `write_origin: user-directed` verliert keine Funktion — es führt
  lediglich nicht zu `user_asserted`. Da kein Schreibpfad einen
  Attestierungsbezug erzeugt und keiner ihn erzeugen soll, gilt das dauerhaft
  für alle Pfade; die Klasse entsteht ausschließlich über die bestätigte
  Review nach 6.3.
- Ein künftig direkt übergebenes `provenance_class` ändert daran nichts; der
  Wert `user_asserted` unterliegt derselben Attestierungsregel.
- Die Bestandsprüfung ändert keine Memory-Inhalte. Sie setzt ausschließlich
  Provenienz- und Review-Felder in der Sidecar-Projektion; ein ungeprüftes
  Memory bleibt uneingeschränkt auffindbar und nutzbar.
- `SUPERSEDE` verschiebt keinen Vorgänger in den Trash und entfernt ihn nicht
  aus dem Index; das bestehende Archivierungsprimitiv bleibt davon unberührt
  und behält seine heutige Bedeutung.
- Der heutige `related_via`-Hop im Hook-Pfad bleibt aktiv, bis eine Messung
  eine bessere Sicht belegt.
- Ab V1.0 steht das Frontmatter-Format unter der Zusicherung aus 26.1:
  Pflichtfelder, Memory-Typen und die Bedeutung der dokumentierten optionalen
  Felder ändern sich nur mit einem Major-Bump (C-084).
- Die Ladetoleranz ist Teil dieser Zusicherung. Reparatur fehlender
  Pflichtfelder, eintragsweise Rettung eines nicht parsenden Blocks, Verwerfen
  eines ungültigen optionalen Feldes, Kappen eines überlangen `summary` und
  Folgenlosigkeit unbekannter Schlüssel bleiben erhalten; sie zu verschärfen
  ist ein Breaking Change. Zulässig bleibt allein die eng gefasste
  Sicherheitsausnahme aus 26.1.
- Unbekannte Schlüssel werden beim Laden toleriert, überleben ein
  `save_memory` mit `overwrite` aber nicht garantiert: Dieser Pfad baut das
  Frontmatter aus seiner bekannten Feldliste neu.
- Ein 1.x-Reader verlangt kein Formatversionsfeld im Frontmatter. Eine von Hand
  angelegte Datei muss nichts deklarieren, um vollwertig zu sein; ein später
  additiv eingeführtes Versionsfeld dürfte nur optional sein.
- Alle in diesem Abschnitt genannten V2-Felder — insbesondere
  `provenance_class` und die Provenienz-/Review-Projektion samt
  `unknown_legacy` und `imported_unverified` — sind additiv geplant und
  existieren im V1-Schema **nicht**. Ihre Abwesenheit ist der definierte
  Zustand und kein Migrationsrückstand.
- Kein Release der 1er-Reihe schreibt Bestandsdateien in Masse um, um sein
  eigenes Format herzustellen.

## 23. Privacy und Sicherheit

- Kein neuer Cloudzwang.
- Query- und Memory-Embeddings respektieren bestehende Provider- und
  Egress-Regeln.
- Sensitivity wird vor Retrieval und erneut vor Ausgabe geprüft.
- HNSW darf keine ausgefilterten privaten IDs über Nachbarschaft oder Diagnose
  leaken.
- Working Memory wird standardmäßig nicht dauerhaft gespeichert.
- Episodenaufnahme folgt denselben Capture- und Injection-Schutzregeln.
- Nutzerinhalte werden niemals als ausführbare Anweisungen aus dem Vault
  behandelt.
- Pseudonyme Experiment-Session-IDs enthalten keinen Query- oder Vault-Inhalt.
- Rohartefakte aus Eval-Runs bleiben lokal; öffentliche Reports enthalten
  keine Vault-abgeleiteten Query-Texte.
- Deep Recall erweitert Reichweite, nicht Berechtigungen.
- Soft Delete und Survival-by-ID bleiben erhalten.
- Das bestehende Audit des Mac-Bridge-Mutationspfads bleibt erhalten. Ein
  einheitliches Audit für reguläre MCP-/HTTP-Mutationen ist gesonderte spätere
  Arbeit und wird hier nicht als bereits vorhandene Eigenschaft vorausgesetzt.
- Abgeleitete Cues, Manifeste und Graph-Projektionen unterliegen denselben
  Scope-, Sensitivity- und Egress-Regeln wie der zugrunde liegende Inhalt. Ein
  Manifest darf einen Filter nicht dadurch umgehen, dass es aggregiert.
- Deep Recall und Manifeste erweitern die Reichweite innerhalb bestehender
  Berechtigungen; sie erzeugen keine neuen.
- Nutzungssignale und Utility-Historie enthalten keine Query-Rohtexte, solange
  dafür keine gesonderte Datenschutzentscheidung vorliegt.

## 24. Was ausdrücklich nicht zuerst gebaut wird

- kein größeres Embedding-Modell als Antwort auf falsche Required-Hits;
- keine tieferen untypisierten Graph-Hops;
- keine aggressive automatische Triggervermehrung;
- kein aggressiveres automatisches Speichern;
- kein autonomes Umschreiben von Nutzerwissen;
- keine HNSW-Live-Schaltung ohne Flat-Vergleich;
- keine Salience-Live-Gewichtung ohne ausreichende Shadow-Evidenz;
- kein Learned Ranker auf einem fehlerhaften oder driftenden Kandidatenpool;
- kein Meinungs- oder Belief-Netz mit eigener, selbstverstärkender Konfidenz;
- keine getrennten physischen Graphdatenbanken je Relationstyp;
- kein Cross-Encoder im PreTool- oder SessionStart-Budget;
- keine automatische Ausführung von Konsolidierungs-Operatoren ohne Freigabe;
- keine Live-Gewichtung aus Q-Werten oder Co-Occurrence-Kanten ohne
  Exposure- und Hub-Kontrolle;
- keine zweite epistemische Memory-Taxonomie neben den bestehenden Typen;
- kein vollständiger Lauf eines großskaligen Trajektorien-Benchmarks als
  V1.0-Blocker;
- keine Ersetzung von Evidenz durch Cue- oder Triggertexte;
- keine Übernahme eines Fremdsystem-Zielwerts als Bastra-Gate;
- keine Behauptung eines kausalen Utility-Lifts ohne Propensity-Logging,
  kontrollierte Exploration und Zensur-Behandlung nicht ausgespielter
  Kandidaten;
- kein Deep-Recall-Budgetabbruch, der als `no_answer` ausgegeben wird;
- kein abgeleiteter Cue und kein Graph-Hop, der allein `required` erzeugt;
- keine Ablation, die die Provenienzfelder eines abgeleiteten Cues entfernt;
- keine automatische Migration von `valid_until` in ein Gültigkeitsfeld;
- kein Altbestand, der ohne explizite Herkunft als Nutzeraussage gilt;
- kein importierter Inhalt, der allein wegen seines Import-`write_origin` als
  Nutzeraussage gilt;
- kein `user_asserted` aus einem bloß behaupteten, nicht attestierten
  `write_origin`;
- kein `user_asserted`, das allein auf einem Mutation-Audit beruht;
- kein direkt übergebenes `provenance_class: user_asserted` als Bypass der
  Attestierungsregel;
- kein `SUPERSEDE`, das den Vorgänger aus dem lebenden Index entfernt oder in
  den Trash verschiebt;
- kein automatischer `LINK`-Nachtrag außerhalb eines freigegebenen Vorschlags;
- keine Live-Freigabe, die auf einer explorativ ausgewiesenen Interaktion
  beruht;
- kein Transport- oder interner Fehler, der als Recall-Ergebnis ausgegeben
  wird;
- kein Controllerdefekt, der als Ergebniswert oder `stop_reason` geführt wird;
- kein `no_answer`, das partielle belastbare Evidenz verschweigt;
- kein `user_asserted` ohne ausdrückliche Nutzerbestätigung in der Oberfläche;
- keine Bestätigung, die auf ein zweites Memory oder einen geänderten
  aussagetragenden Inhalt übertragen wird;
- kein Bestätigungsverfall, der durch reine Metadaten-, Nutzungs- oder
  Zeitstempeländerungen ausgelöst wird;
- keine Zusammenfassung von Beobachtung, Ableitung und Vermutung zu einer
  Provenienzklasse;
- keine Einschränkung der Reviewberechtigung nach Importstatus oder
  `write_origin`;
- keine vorausgewählte Provenienzantwort und kein `confirmed` aus einem
  Weiter-Klick auf einen Default;
- kein nachträgliches oder laufendes Hinzunehmen des Cue-Erzeugungswegs als
  zusätzlicher Arm außerhalb der registrierten Anlage;
- keine Interaktionsaussage aus Anlage A;
- kein frei formulierter Erklärungstext im semantischen Vorschlagshash;
- keine Wiedervorlage aus einer Umformulierung, einem Zeitstempel-Update oder
  einer Metadatenänderung;
- keine Bestimmung der festgehaltenen Cue-Konfiguration auf denselben Fällen,
  auf denen anschließend verglichen wird;
- keine Behandlung fehlender Usage-Historie als Nutzung null und keine
  automatische Zuordnung historieunbekannter Memories nach Stufe 2;
- kein Prüfkriterium, das auf Floor- oder Pin-Status zurückgreift — Floors sind
  Stufe 1, und eine unabhängige Pin-Quelle existiert nicht;
- kein Strukturkriterium, das erst während des Review-Laufs entsteht oder sich
  darin verändert;
- keine Höherstufung nach Stufe 2 bei fehlendem oder unvollständigem
  Graph-Snapshot;
- keine Behauptung, das Feld `bridge` belege eine graphentheoretische Brücke
  oder einen Artikulationsknoten;
- kein Zuordnungsnachweis, der allein auf einem Zeitstempel beruht und den
  zugrunde liegenden Graphzustand nicht festhält;
- keine Neuberechnung des Snapshots und keine Neuzuordnung eingereihter
  Memories während eines laufenden Reviews, und keine neu aufgebaute
  Warteschlange nach einem Neustart;
- keine Wiedervorlage aufgrund eines Reason-Codes, den die geltende
  Vokabularversion nicht kennt;
- kein Memory, das dauerhaft von der Provenienzprüfung ausgenommen bleibt;
- keine Wiedervorlage eines abgelehnten Vorschlags, der inhaltlich derselbe
  ist.

## 25. Umsetzungsreihenfolge

V1.0:

1. Messwahrheit und reproduzierbare Baselines.
2. Deterministische Relevanzevidenz und echte Abstention.
3. Gemeinsamer projektfähiger Session-Assembler mit interner Parallelisierung.
4. Globales Kontextbudget und getrenntes Retrieval-/Präsentationsexperiment.

Bis einschließlich Punkt 4 ist die Umsetzung als V1.0 freigegeben. Alle
folgenden Nummern ordnen Schema-/Vertragsänderungen und Live-Aktivierungen.
Messung, Shadow-Betrieb und read-only Projektionen bleiben unabhängig davon
zulässig; Qualitätsaussagen mit Referenzwirkung setzen M0 voraus:

5. BM25-first-Kaskade und Query-Embedding-Cache live nach bestandenem M2.
6. Abgeleitete Accessibility und Asteroidengürtel live nach M1-Nachweis und
   bestandenem M3. Die Provenienzprüfung des Bestands nach 6.3 läuft davon
   unabhängig als read-only Sidecar-Arbeit und ist an kein Gate gebunden.
7. Deep Recall Stufe 1 live nach bestandenem M3; Stufe 2 erst nach
   zusätzlichem Nachweis eigenen Nutzens gegenüber Stufe 1 gemäß 8.5.
8. Cue-/Content-Vektoren, abgeleitete Cue-Schicht und Chunking persistent oder
   live erst nach gesondertem Repräsentationsentscheid gemäß 11.2 und 11.4;
   M2 allein genügt nicht.
9. Episodic Memory, strukturierte Claims, die Zeitachsen aus 6.3 und die
   `provenance_class` persistent erst nach gesondertem Schemaentscheid, live
   nach bestandenem M4.
10. Typed Graph, logische Sichten, Versionen und Rekonsolidierung persistent
    erst nach gesondertem Schemaentscheid gemäß 21.4, live nach bestandenem M4
    und je Sicht bestandenem No-Graph-Kontrollarm.
11. Kontrollierte Konsolidierung mit den Proposal-Operatoren aus 14.4 live nach
    bestandenem M4.
12. Flat-/HNSW-Strategie live erst, wenn kontrolliertes Profiling einen
    Flat-Search-Engpass und M5 den Qualitäts- und Latenzvorteil belegen.
13. Learned Ranking shadow nach M0/M1, live erst nach bestandenem M6.

## 26. Definition of Done

### 26.1 Releasevertrag V1.0

V1.0 ist fertig, wenn:

- jeder Eval-Lauf als reproduzierbares, versioniertes Artefakt mit Code-,
  Vault-, Modell-, Konfigurations- und Datensatz-Hash vorliegt;
- der Hybrid-Stress-Eval nachweislich einen echten `EmbeddingIndex` benutzt und
  keinen stillen BM25-Fallback als Hybrid ausweist;
- keine unbekannten Gold-IDs oder unprotokollierten Candidate-Pool-Größen in
  die Auswertung eingehen;
- jeder Goldfall die verpflichtenden Provenienzfelder im Datensatzmanifest und
  privaten Run-Artefakt trägt;
- die numerischen M1-Toleranzen nach dem M0-Baseline-Run versioniert
  festgeschrieben sind;
- Run-Artefakte im privaten Eval-Verzeichnis vollständig sind und öffentliche
  Reports keine Vault-abgeleiteten Query-Texte enthalten;
- der deterministische Evidenzentscheid zunächst im Shadow geprüft wurde;
- der Shadow-Betrieb die festgelegte Mindestdauer beziehungsweise
  Mindestfallzahl erreicht und die retrieval-isolierten M1-Komponentengates vor
  der Live-Schaltung bestanden hat;
- die Live-Schaltung hinter einem Konfigurations-Flag liegt und der
  Score-/Floor-Legacy-Pfad als getesteter Fallback erhalten bleibt;
- Hook und Session-Context `no_answer` respektieren und schwache Treffer nicht
  allein wegen eines inkompatiblen Rohscores als Required behandeln;
- der gemeinsame Session-Assembler Projektpfad und Scope korrekt übernimmt,
  seine unabhängigen Serveranteile parallel ausführt und für vorhandene Clients
  kompatibel bleibt;
- ein globales Token- und Latenzbudget die gesamte Session-Antwort begrenzt;
- Retrievalqualität, Hook-Formulierung und Consumer-Verhalten getrennt
  ausgewertet werden;
- `client`, `hook_source` und pseudonyme Session-Zuordnung die dafür
  erforderlichen Telemetriedimensionen liefern;
- das Retrieval-/Präsentationsexperiment aus 17.4 vor jedem Lauf registriert
  ist, seine Arme deterministisch pro pseudonymer Session zugewiesen werden und
  seine Auswertung einen Arm unterhalb des Mindest-N ausdrücklich als **nicht
  auswertbar** ausweist statt als Nullbefund;
- Context-ROI als Systemmetrik reproduzierbar messbar ist, ohne die
  Live-Schaltung einer korrekten Retrievalentscheidung zirkulär zu steuern;
- dafür weder Vault-Schema, Memory-Typen noch Vector-Backend migriert werden.

**Vertragsänderung C-083, 29.08.2026 — Anforderung ersetzt.** Der vorstehende
Experimentpunkt trug bis zu diesem Datum die Fassung:

> ~~Experimentarme deterministisch pro Session zugewiesen werden und ihr nach
> M0 versioniertes Mindest-N erreicht haben;~~

Diese Fassung gilt nicht mehr. V1.0 schuldet die **Registrierung**, die
**deterministische Zuweisung** und einen **ehrlichen Statusbericht** —
`underpowered` beziehungsweise `not_evaluable` mit ausgewiesener Begründung.
Das Erreichen des Mindest-N und damit der ausgewertete, hinreichend besetzte
Lauf sind kein V1.0-Bestandteil mehr; sie wandern nach 26.2. Der Grund ist
gemessen und nicht abgewogen: Die Versuchseinheit aus 17.4 ist die Session,
und auf einer Ein-Nutzer-Population erreicht kein Arm in vertretbarer Zeit eine
tragfähige Fallzahl. Ein Releasevertrag, der eine Zahl fordert, die die
Population nicht hergibt, ist entweder unerfüllbar oder lädt dazu ein, einen
unterbesetzten Lauf als Befund auszugeben. Die Berichtsregel aus 18.1 bleibt
davon unberührt und wird durch diesen Eintrag ausdrücklich Teil des
V1.0-Vertrags.

**Frontmatter- und Schemazusicherung ab V1.0 (C-084).** Mit V1.0 entfällt das
Beta-Signal der führenden `0.`, und das Vault-Format steht ab dieser Version
unter einer ausdrücklichen Zusicherung. Markdown mit YAML-Frontmatter bleibt
Source of Truth. Die zehn Pflichtfelder — `id`, `title`, `type`, `summary`,
`topic_path`, `tags`, `scope`, `recall_when`, `created`, `updated` — behalten
Name, Typ und Bedeutung; die erkannten Memory-Typen bleiben gültig; die
dokumentierten optionalen Felder werden nicht umgedeutet. Ein unter einer
1.x-Version geschriebener Vault bleibt von jeder späteren 1.x-Version lesbar,
ohne Migrationsschritt.

Ein 1.x-Reader verlangt **kein Formatversionsfeld** im Frontmatter. Eine Datei
ohne ein solches Feld ist heute und in jeder späteren 1.x-Version vollwertig.
Ob ein Versionsfeld später additiv eingeführt wird, bleibt offen; es dürfte
dann nur optional sein und niemals Ladebedingung werden.

Ebenso zugesichert ist die Ladetoleranz selbst, weil sie die eigentliche Zusage
an einen handgepflegten Vault ist: fehlende Pflichtfelder werden aus Dateiname,
Body und Dateizeit repariert, ein nicht parsender Frontmatter-Block wird
eintragsweise gerettet, ein ungültiges optionales Feld wird verworfen statt die
Memory zu verlieren, ein überlanges `summary` wird beim Laden gekappt, und
unbekannte Schlüssel bleiben folgenlos. Reparaturen sind in-memory und werden
nie auf die Platte zurückgeschrieben. Den Loader strenger zu machen ist deshalb
ein Breaking Change und kein Bugfix.

Unbekannte Schlüssel werden beim **Laden** toleriert. Sie überleben ein
`save_memory` mit `overwrite` jedoch **nicht garantiert**: Dieser Pfad baut das
Frontmatter aus seiner bekannten Feldliste neu und trägt nur die Felder weiter,
die er kennt. Die Zusicherung deckt das Lesen, nicht die Erhaltung fremder
Felder über einen Rewrite hinweg.

Breaking und damit einen Major-Bump verlangen: ein Pflichtfeld entfernen,
umbenennen oder umtypisieren; einen Memory-Typ streichen oder umdeuten; ein
dokumentiertes optionales Feld entfernen; den Loader so verschärfen, dass eine
bisher ladende Datei nicht mehr lädt; die Auflösung über die `id` brechen; oder
eine Migration verlangen, ohne die ein bestehender Vault nicht mehr geladen
wird. Additiv und damit Minor sind: neue optionale Felder, neue Typen, weitere
Ladetoleranz, neue Projektionen und neue Schreibrouten neben den bestehenden.

Nicht Teil dieser Zusicherung sind Ranking, Trefferreihenfolge,
Staleness-Kurven und Triggergewichte; die internen Ablagen unter
`<vault>/.bastra/`; und die maschinell erzeugten Projektionsfelder, deren
Berechnungsweg sich jederzeit ändern darf, während Feldname und grobe Bedeutung
gedeckt bleiben. Die **Ausgabeform von `recall`** fällt nicht unter die
Schemazusicherung, sondern unter den eigenen API-Vertrag, der denselben
SemVer-Regeln folgt; sie ist damit gebunden, nur an anderer Stelle.

**Sicherheitsausnahme, eng gefasst.** Eine Verschärfung des Loaders ist
zulässig, ohne einen Major-Bump auszulösen, wenn alle vier Bedingungen erfüllt
sind: sie schließt eine konkrete, benannte Schwachstelle; sie wird im Changelog
ausdrücklich als sicherheitsbedingte Verschärfung ausgewiesen; die betroffene
Datei erzeugt einen **sichtbaren Fehler** statt still verworfen zu werden; und
der übrige Bestand bleibt so weit lesbar, wie es die Schwachstelle zulässt. Als
Freibrief für Aufräumarbeiten am Parser taugt die Ausnahme nicht — sie deckt
den Ernstfall und sonst nichts.

Innerhalb von 1.x gibt es keinen erzwungenen Migrationsschritt. Kein Release
schreibt Bestandsdateien in Masse um, um sein eigenes Format herzustellen; wo
neue Felder gebraucht werden, gilt ihre Abwesenheit als definierter Default —
so wie heute ein fehlendes `write_origin` als `agent-session` und ein fehlendes
`recall_mode` als `deliberate` gilt.

### 26.2 Promotion zu V2.0

V2.0 gilt nicht als fertig, wenn lediglich neue Komponenten existieren. Die
Promotion erfolgt erst, wenn:

- Recall zuverlässig nichts sagt, wenn nichts passt;
- Required wieder ein belastbares Relevanzversprechen ist;
- reale unabhängige Paraphrasen das Qualitätsgate erfüllen;
- Hook-Kontext deutlich weniger Tokens pro erfolgreicher Nutzung verbraucht;
- Normal Recall innerhalb des Latenzbudgets bleibt;
- der Asteroidengürtel Zugänglichkeit erklärt, ohne Memories zu verlieren;
- Deep Recall dormante Erinnerungen bewusst zurückholen kann;
- Episoden und dauerhafte Regeln getrennte Rollen besitzen;
- jede Konsolidierung ihre Evidenz behält;
- alte Versionen zitierbar bleiben;
- abgeleitete Inhalte ihre Herkunft tragen und keinen Nutzerfakt still
  ersetzen;
- Ereignis-, Gültigkeits-, Wissens- und Ableitungszeit getrennt beantwortbar
  sind;
- Deep Recall eine erschöpfte Suche, einen Budgetabbruch, eine Unterbrechung
  von außen und einen Implementierungsfehler unterscheidet;
- eine als Nutzeraussage geführte Memory einen belegten und nicht nur
  behaupteten Ursprung besitzt, nämlich eine ausdrückliche Nutzerbestätigung;
- der Bestand vollständig geprüft ist und jedes Memory eine geklärte oder
  bestätigt unklare Herkunft trägt, wobei Beobachtung, Ableitung und Vermutung
  unterscheidbar bleiben;
- Zugänglichkeitsentscheidungen von inhaltlichen Versionen getrennt bleiben;
- das Retrieval-/Präsentationsexperiment aus 17.4 mindestens einmal
  **hinreichend besetzt gelaufen** ist: Arm A mit einem zweiten Hook-Wortlaut,
  Arm B mit je Session schaltbarem Gate, beide mit erreichtem, nach M0
  versioniertem Mindest-N je Arm, mit erhobener Query-Klassen-Dimension und mit
  unabhängigen Relevanzlabels für ausgespielte und zurückgehaltene Kandidaten
  (C-083, aus 26.1 hierher verschoben);
- HNSW nur dann automatisch aktiviert wird, wenn es auf der aktuellen Hardware
  messbar sinnvoll und qualitativ sicher ist;
- jede adaptive Entscheidung shadow-getestet, erklärbar und zurückrollbar ist.

## 27. Kurzfassung

Bastra Recall 0.8.6 wird zuerst zu V1.0: einem reproduzierbar messbaren,
selektiven und kontrollierbaren Recall-System. Während V1.x werden weitere
Gedächtnisfunktionen nur nach bestandenen Messgates ergänzt. V2.0 bezeichnet
schließlich das gemeinsam bewiesene, adaptive und mehrschichtige
Gedächtnissystem:

- Working Memory steuert Aufmerksamkeit.
- Episodic Memory speichert Erfahrungen schnell und getrennt.
- Semantic Memory hält bestätigtes, stabiles Wissen.
- Reflex Memory trägt bewusst freigegebene Routinen.
- Accessibility steuert, wie leicht etwas spontan auftaucht.
- Der Asteroidengürtel bewahrt dormante Erinnerungen sichtbar und auffindbar.
- Deep Recall erlaubt bewusstes „Wühlen“ in alten Zusammenhängen.
- Ein adaptiver Controller wählt BM25, Flat Vector, HNSW oder Deep Recall nach
  Query, Vault, Hardware, Qualität und Zeitbudget.
- Deterministische Relevanzevidenz und Abstention verhindern zunächst, dass
  Rang mit Wahrheit verwechselt wird; eine kalibrierte Wahrscheinlichkeit darf
  später nur auf unabhängigen Labels aufsetzen.
- Konsolidierung und Rekonsolidierung entwickeln Wissen weiter, ohne seine
  Geschichte zu löschen.

Das Ziel ist nicht maximaler Recall. Das Ziel ist:

> Zur richtigen Zeit die richtige Erinnerung – und ansonsten Ruhe.

## 28. Delta-Ledger (C-029–C-086)

Dieser Abschnitt dokumentiert elf aufeinanderfolgende Runden von Deltas
gegenüber dem abgenommenen Stand C-001–C-028 sowie vier spätere Einträge zu
Vertrag und Prädikat. Jeder Eintrag nennt die betroffene
Passage, die Art des Deltas, die tragende Evidenz, das Gate, die Datenquelle,
das Abnahmekriterium und den Rollback. Kein Eintrag deutet ein früheres Urteil
um.

**Runde 1 — C-029 bis C-039** entstand aus der Gegenprüfung eines
Recherche-Briefings zu vergleichbaren Agent-Memory-Systemen. Diese Einträge
sind unverändert übernommen; wo eine spätere Korrektur sie berührt, ist das im
jeweiligen Eintrag der Runde 2 vermerkt.

**Runde 2 — C-040 bis C-048** entstand aus dem Codex-Gegenreview der Runde 1.
Drei dieser Einträge korrigieren einen Fehler und nicht nur eine Ungenauigkeit:
C-042 kehrt einen sicherheitsrelevant falschen Default um, C-046 verhindert den
stillen Verlust einer produktiven Fähigkeit und deckt zugleich eine bestehende
Lücke auf dem BM25-only-Pfad auf, und C-040 hat zwei Fehlzitate der Runde 1
aufgedeckt.

Welcher Eintrag der Runde 1 durch welchen der Runde 2 präzisiert oder korrigiert
wird — bei Abweichung gilt stets die Fassung der Runde 2:

| Runde 1 | wird präzisiert durch | Art |
|---|---|---|
| C-029 | C-040 | Präzisierung: Belegpflicht wird operationalisiert |
| C-030 | C-043 | Korrektur: die Cue-Reduktion war Hypothese, nicht Entscheidung |
| C-031 | C-047 | Präzisierung: Abbruchbedingungen werden ausführbar |
| C-032 | C-041 | Präzisierung: Wissensachse wird Intervall, `valid_until` abgegrenzt |
| C-033 | C-042 | Korrektur: Fallback war sicherheitsrelevant falsch |
| C-034 | C-046 | Korrektur: heutige Hop-Baseline wäre still entfallen |
| C-035 | C-048 | Präzisierung: Erreichbarkeit wird messbar, Operatorklassen getrennt |
| C-036 | redaktionell | Präzisierung: Retrieval ist dominanter, nicht alleiniger Engpass |
| C-037 | C-044 | Korrektur: Normalisierung ist keine Bias-Korrektur |
| C-038 | C-045 | Korrektur: Skalentest und Backend-Gate waren vermischt |
| C-039 | redaktionell | Präzisierung: Vergleichsarm ist nicht „ungedämpft“ |

**Runde 3 — C-049 bis C-054** entstand aus dem Codex-Delta-Review der Runde 2
und ist ein reiner Delta-Fix. C-049 ist der schwerwiegendste Eintrag: Das in
C-042 eingeführte Mapping hätte über den Import-Pfad genau den Fehler wieder
eingeführt, den C-042 beheben sollte. Die Zuordnung zur Runde 2:

| Runde 2 | wird präzisiert durch | Art |
|---|---|---|
| C-042 | C-049 | Korrektur: Importherkunft muss `write_origin` vorgehen |
| C-041 | C-050 | Präzisierung: Widerspruch setzt kein `retracted_at`; fünf Zustände abgegrenzt |
| C-043 | C-051 | Präzisierung: 2×2-Design mit Stufenausweis statt Armliste |
| C-047 | C-052 | Korrektur: Astabbruch beendete fälschlich den Lauf |
| C-046 | C-052 | Präzisierung: Hop-Kennzeichnung bleibt serverintern |
| C-048 | C-053 | Präzisierung: Invariante wird durchgesetzt, `SUPERSEDE` abgegrenzt |
| C-040, C-044, C-045 | C-054 | Konsistenz: Korrekturverweise, Quellenzuordnung, ID-Stand |

**Runde 4 — C-055 bis C-059** ist die abschließende Korrekturrunde. Sie
schließt zwei verbliebene Ist-Lücken und vervollständigt drei Verträge. Die
Zuordnung zur Runde 3:

| Runde 3 | wird präzisiert durch | Art |
|---|---|---|
| C-049 | C-055 | Korrektur: behauptetes `write_origin` ist keine Attestierung |
| C-052 | C-056 | Korrektur: `limit: "other"` wies Nicht-Budget-Abbrüche als Budgetproblem aus |
| C-051 | C-057 | Präzisierung: Fallzahlregel und konstante Versuchsumgebung |
| C-053 | C-058 | Präzisierung: Shortcut atomar, Ausweg definiert, Sensitivity gewahrt |
| C-053 | C-059 | Korrektur: `SUPERSEDE` war nicht gegen das Archivierungsprimitiv abgegrenzt |
| C-050 | redaktionell | Klarstellung: `stale_status` ist kein sechster Zustand |
| C-045 | redaktionell | Klarstellung: vier von sieben Kategorien genügen in 18.6.1 |

**Runde 5 — C-060 bis C-062** präzisiert drei Einträge aus Runde 4. Die
Zuordnung zur Runde 4:

| Runde 4 | wird präzisiert durch | Art |
|---|---|---|
| C-055 | C-060 | Korrektur: Mutation-Audit ist keine Attestierung |
| C-056 | C-061 | Korrektur: `controller_defect` war als `stop_reason` geführt und damit ein regulärer Endzustand |
| C-058 | C-062 | Präzisierung: Fingerprint-basierte Sperre statt „geänderte Memories" |
| C-048, C-053 | C-062 | Präzisierung: Survival- und Zitationsquote je Berechtigungskontext |
| C-059 | redaktionell | Klarstellung: Historical-Zugriff darf logische Sicht sein |

**Runde 6 — C-063 bis C-067** setzt die getroffenen Product-Owner-Entscheidungen
um. Die Zuordnung zu den Vorrunden:

| Vorrunde | wird beantwortet oder präzisiert durch | Art |
|---|---|---|
| C-060 | C-063 | Entscheid: Der Bestätigungsbezug entsteht in der Recall-Oberfläche |
| C-055 | C-064 | Verschärfung: Bestätigung gilt für genau ein Memory und einen Inhaltsstand |
| C-055 | C-065 | Korrektur: `not_scheduled` war eine Ausnahme, jetzt Warteschlangenposition |
| C-057 | C-066 | Präzisierung: Cue-Erzeugungsweg als vorab registrierter Faktor |
| C-062 | C-067 | Präzisierung: geänderter Fingerprint ist notwendig, nicht hinreichend |

**Runde 7 — C-068 bis C-073** ist der Gegenreview der Entscheidungsumsetzung.
Die Zuordnung zur Runde 6:

| Runde 6 | wird korrigiert oder operationalisiert durch | Art |
|---|---|---|
| C-063 | C-068 | Korrektur: drei Herkünfte waren auf eine Klasse abgebildet |
| C-063, C-065 | C-069 | Korrektur: Reviewberechtigung war an `write_origin` gekoppelt |
| C-064 | C-070 | Operationalisierung: Bindung an `memory_id` und Inhaltshash |
| C-065 | C-071 | Ist-Korrektur: die Nutzungstelemetrie existiert bereits |
| C-066 | C-072 | Korrektur: „Faktor, aber kein Arm" war keine Versuchsanlage |
| C-067 | C-073 | Operationalisierung: semantischer Vorschlagshash und materielle Änderung |

**Runde 8 — C-074 bis C-077** korrigiert vier Einträge aus Runde 7. Die
Zuordnung zur Runde 7:

| Runde 7 | wird korrigiert durch | Art |
|---|---|---|
| C-072 | C-074 | Korrektur: Anlage A hatte vier Zellen statt zwei Bedingungen |
| C-073 | C-075 | Korrektur: Hashumfang und materielle Änderung schlossen einander aus |
| C-071 | C-076 | Korrektur: `unknown` führte pauschal nach Stufe 2; Pin-Quelle existiert nicht |
| C-068, C-069 | C-077 | Verschärfung: keine vorbelegte Provenienzantwort, auch nicht bei der Rückfrage |

**Runde 9 — C-078 und C-079** schließt zwei Ermessenslücken: Beide Einträge
machen eine Regel ausführbar, deren Anwendung bis dahin der Implementierung
überlassen war:

| Runde 8 | wird ausführbar gemacht durch | Art |
|---|---|---|
| C-076 | C-078 | Präzisierung: Strukturkriterium vorab versioniert statt nach Ermessen |
| C-075 | C-079 | Präzisierung: kanonische Hashstruktur statt Freitext |

**Runde 10 — C-080 und C-081** korrigiert zwei Einträge aus Runde 9. Beide
betreffen dieselbe Schwachstelle: Eine Regel war ausführbar formuliert, stützte
sich aber auf eine Zusage, die weder der Code noch das Artefakt einlöst:

| Runde 9 | wird korrigiert durch | Art |
|---|---|---|
| C-078 | C-080 | Ist-Korrektur: `bridge` belegt clusterübergreifende Nachbarschaft, keine Trennwirkung |
| C-078, C-079 | C-081 | Nachweispflicht: Snapshot im Artefakt belegt, Neustart setzt fort, unbekannter Reason-Code sperrt |

**Runde 11 — C-082** ist ein Ein-Satz-Delta-Fix mit genau einem Eintrag. Er
beseitigt einen Gate-Widerspruch, den Runde 10 eingeführt hatte:

| Runde 10 | wird korrigiert durch | Art |
|---|---|---|
| C-081 | C-082 | Ist-Korrektur: das Nachweisartefakt hing an M4, obwohl es kein Schemafeld berührt |

**Vertragsänderung — C-083**, 29.08.2026, ist keine Reviewrunde. Sie korrigiert
kein Urteil, sondern ändert den Umfang des V1.0-Releasevertrags, nachdem die
Registrierung des Experiments seine Fallzahl gemessen hat:

| Bisheriger Vertrag | wird geändert durch | Art |
|---|---|---|
| C-024, 26.1 Experimentpunkt | C-083 | Vertragsänderung: Mindest-N-Erreichung wandert von 26.1 nach 26.2 |

**Vertragsergänzung — C-084**, 29.08.2026, ergänzt den V1.0-Vertrag um eine
Zusage, die bislang nur im Code stand und in keinem Dokument:

| Bisherige Lücke | wird geschlossen durch | Art |
|---|---|---|
| 26.1 und 22 ohne Frontmatter-Zusicherung | C-084 | Vertragsergänzung: Schemazusage, Ladetoleranz, Breaking-/Additiv-Grenze |

**Vertragsergänzung — C-085**, 29.08.2026, bindet eine bestehende Schwelle an
eine Bedingung, die ihr Zweck immer schon verlangte:

| Bisheriger Vertrag | wird ergänzt durch | Art |
|---|---|---|
| C-022, 18.2 Shadow-Abnahme | C-085 | Vertragsergänzung: Streuung über Sessions als Bedingung der Entscheidungs-Route |

**Präzisierung — C-086**, 29.08.2026, verengt das Required-Prädikat, nachdem
beide Verengungen auf demselben Pool beziffert waren:

| Bisherige Lesart | wird präzisiert durch | Art |
|---|---|---|
| C-002, 10.3 Required-Bedingungen | C-086 | Präzisierung: Teilabdeckung erst ab 50 %, Identifier-Anker ohne Body |

### C-029 – Evidenzklassen für Fremdsystemzahlen

- **Passage:** 2.3 (neu), 18.1 M0 unter Arbeit und Gate.
- **Art:** Architekturentscheidung mit Messfolge.
- **Evidenz:** Quellenprüfung vom 25. Juli 2026 (Abschnitt 29). Die im
  Hindsight-Paper genannte unabhängige Reproduktion stammt von Institutionen,
  die Co-Autoren stellen. Zeps Bestwerte stehen nur auf der eigenen
  Research-Seite und verwenden dasselbe Modell als Reader und als Judge.
  MAGMAs Hyperparameter wurden laut Appendix auf dem Vergleichsbenchmark
  optimiert, während die Baselines mit Defaults liefen. Oris Zahlen weichen
  zwischen Haupt-README und `bench`-Verzeichnis voneinander ab.
- **Gate:** M0.
- **Datenquelle:** Report-Metadaten des Eval-Harness, Quellenmatrix 29.
- **Abnahmekriterium:** Kein Report enthält eine Fremdzahl ohne Evidenzklasse;
  keine gemeinsame Rangliste über Messungen mit unterschiedlichem Reader,
  Judge, Top-k oder Kontextbudget.
- **Rollback:** Reine Dokumentations- und Reportregel ohne Laufzeitwirkung.

### C-030 – Trennung von Cue und Evidenz

- **Passage:** 10.2, 11.4 (neu), 18.2 M1 Schaltgates, 18.3 M2 Arme und
  Metriken, 25 Punkt 8.
- **Art:** Architekturentscheidung.
- **Evidenz:** T-Mem (Preprint) belegt die Unterscheidung nach Granularität und
  Orientierung sowie die bewusste Entkopplung von Trigger und Evidenzpfad.
  Bastras `recall_when` trägt bereits heute das höchste BM25-Feldgewicht
  (`packages/core/src/search.ts:179`), das maschinell expandierte Feld ein
  deutlich niedrigeres — die Vertrauensklassen sind also schon implementiert
  und werden hier nur konsequent fortgeschrieben.
- **Gate:** M2-Ablation und anschließend derselbe gesonderte
  Repräsentationsentscheid wie für Chunking und Dual-Vektoren.
- **Datenquelle:** assoziative Goldfälle aus 19, Sidecar-Projektion,
  M2-Report.
- **Abnahmekriterium:** Der Bridge-/Horizon-Arm hebt die assoziative Coverage
  oder senkt die False-Interrupt-Rate, ohne Recall@3 gegenüber dem Arm ohne
  Cues zu verschlechtern; ein Cue-Treffer erzeugt nie allein `required`.
- **Rollback:** Sidecar-Datei ignorieren. Da `recall_when` und der BM25-Index
  unverändert bleiben, entspricht das exakt dem heutigen Verhalten.
- **Abnahmekriterium ersetzt durch C-043.** Das vorstehende Oder-Kriterium
  („hebt die assoziative Coverage oder senkt die False-Interrupt-Rate“) hätte
  einen Cue-Arm allein durch gesenkte Fehlinjektionen bestehen lassen.
  Verbindlich sind die getrennten Gates je Armtyp aus 18.3.

### C-031 – Deep Recall als eigener zweistufiger Modus

- **Passage:** 8.5 (neu), 9.4, 18.4 M3, 25 Punkt 7.
- **Art:** Architekturentscheidung.
- **Evidenz:** Der LongMemEval-V2-Preprint misst für einen strukturierten
  Mehrpool-Ansatz rund 58,6 % bei etwa 27 Sekunden gegenüber rund 74,9 % bei
  108 bis 140 Sekunden für die vollständig agentische Variante. Beides sind
  Eigenmessungen und keine Zielwerte; verwertbar ist der belegte Kostensprung
  zwischen den beiden Bauformen. Ergänzend: Hindsight und Zep reranken jeden
  Recall per Cross-Encoder, ohne ein Hook-Budget einhalten zu müssen.
- **Gate:** M3, mit getrennter Freigabe für Stufe 2.
- **Datenquelle:** dormante Goldfälle, Branch- und Konvergenztelemetrie,
  Kontrollarm mit lediglich vervierfachtem `k`.
- **Abnahmekriterium:** Stufe 1 schlägt den `k`-Kontrollarm messbar; Stufe 2
  zeigt gegenüber Stufe 1 einen an Latenz und Kosten gemessenen Eigennutzen;
  die Abbruchbedingungen aus 8.5 greifen nachweislich.
- **Rollback:** Stufe 2 abschalten oder Deep Recall ganz deaktivieren. Normal
  Recall ist nicht betroffen, weil Deep Recall ein getrennter Modus ist.

### C-032 – Vier getrennt benannte Zeitachsen

- **Passage:** 6.3 Zeitachsen, 18.5 M4, 25 Punkt 9, 26.2.
- **Art:** Architekturentscheidung als Schemavorbereitung.
- **Evidenz:** Graphiti implementiert produktiv ein bi-temporales Modell mit
  vier Zeitstempeln und invalidiert widersprochene Fakten zeitlich, statt sie zu
  löschen — belegt in Preprint, Repository und Produktdokumentation. Bastra
  kennt heute nur Dateizeiten plus `valid_until`.
- **Gate:** M4 und der gesonderte Schemaentscheid aus 21.4.
- **Datenquelle:** Punkt-in-der-Zeit-Goldfälle, read-only Projektion.
- **Abnahmekriterium:** Punkt-in-der-Zeit-Abfragen liefern den damals gültigen
  Stand; kein Feld trägt zwei Bedeutungen; Altbestand ohne die neuen Felder
  bleibt uneingeschränkt gültig.
- **Rollback:** Die Felder sind additiv und optional. Projektion verwerfen
  stellt das heutige Verhalten her.

### C-033 – Herkunft als Feld statt als zweite Taxonomie

- **Passage:** 6.3 Herkunft, 18.5 M4, 24, 26.2.
- **Art:** Architekturentscheidung, einschließlich einer ausdrücklichen
  Ablehnung.
- **Evidenz:** Hindsight führt ein Opinion Network mit veränderlicher Konfidenz
  und nennt in den Limitations selbst, dass die Meinungsentwicklung nie mit
  Nutzerinnen und Nutzern validiert wurde. Eine solche Schicht widerspricht dem
  Grundsatz, dass Bastra Nutzerwissen verwaltet und keine eigenen Positionen
  bildet. Die vom Briefing vorgeschlagenen fünf epistemischen Memory-Arten
  würden zudem die bestehende Typ-Taxonomie verdoppeln.
- **Gate:** M4 und Schemaentscheid.
- **Datenquelle:** Stichprobenklassifikation, Konsolidierungs-Reviews.
- **Abnahmekriterium:** Die Klassen sind in einer Stichprobe trennscharf
  zuweisbar; kein `derived`-Inhalt ersetzt still einen `user_asserted`-Inhalt.
- **Rollback:** Feld additiv; ohne Feld gilt konservativ `user_asserted`, was
  dem heutigen Verhalten entspricht.
- **Korrigiert durch C-042.** Die vorstehende Rollback-Zeile ist falsch und
  wird nicht mehr angewandt: Ein fehlendes `provenance_class` gilt als
  `unknown_legacy`, niemals als `user_asserted`. Der Eintrag bleibt im
  Originalwortlaut stehen, weil das Ledger die Historie abbildet; verbindlich
  ist die Fassung in C-042 und 6.3.

### C-034 – Logische Graph-Sichten und No-Graph-Kontrollarm

- **Passage:** 13.1 (neu), 18.3 M2 Kontrollarm, 18.5 M4, 25 Punkt 10.
- **Art:** Architekturentscheidung.
- **Evidenz:** MAGMA belegt peer-reviewed den Nutzen orthogonaler Sichten mit
  Intent-Router, allerdings mit auf dem Benchmark optimierten Hyperparametern
  gegenüber Baselines mit Defaults. Die Graph-Gegenanalyse derselben Konferenz
  zeigt, dass ungeeignete Graphkonstruktion Ergebnisse verschlechtert und starke
  flache Baselines häufig konkurrenzfähig bleiben, gut konstruierte Kanten aus
  Entity-Beschreibungen flache Indizes aber teilweise deutlich schlagen.
- **Gate:** M4, einzeln je Sicht.
- **Datenquelle:** Ablation je Sicht gegen den flachen Kontrollarm.
- **Abnahmekriterium:** Eine Sicht geht nur live, wenn sie ihren Kontrollarm
  schlägt; kausale und temporale Kanten besitzen strukturelle Evidenz; das
  Hop-Budget von eins im Normal Recall wird eingehalten.
- **Rollback:** Sicht deaktivieren. `related_via` verhält sich dann wie heute.
- **Ergänzt durch C-046.** Die hier beschriebene Beschränkung des Normal Recall
  hätte die heute produktive semantische Hop-Baseline still entfernt. Sie
  bleibt als Kontrollarm erhalten, und ein Hop erzeugt niemals allein
  `required`.

### C-035 – Nichtdestruktive Proposal-Operatoren

- **Passage:** 14.4 (neu), 18.5 M4, 24, 25 Punkt 11.
- **Art:** Architekturentscheidung.
- **Evidenz:** All-Mem (Preprint) belegt eine begrenzte sichtbare Oberfläche mit
  hop-begrenzter Expansion in archivierte Evidenz sowie die Operatoren Split,
  Merge und Update bei unveränderlicher Evidenz. Das bestätigt den
  Asteroidengürtel unabhängig und liefert die fehlende Operator-Semantik für
  Abschnitt 14.
- **Gate:** M4.
- **Datenquelle:** Konsolidierungsläufe, Review-Protokolle.
- **Abnahmekriterium:** Jede Operation ist einzeln reversibel, Evidenz bleibt
  vollständig, die Erreichbarkeitsgarantie über typisierte Links gilt, und ohne
  Freigabe entsteht kein Vault-Zustand.
- **Rollback:** Vorschläge nicht anwenden. Ein nicht angenommener Vorschlag
  hinterlässt definitionsgemäß keinen Zustand.

### C-036 – Handlungsbezogene und assoziative Evaluation

- **Passage:** 18.2 M1 Metriken, 19, 19.1 (neu).
- **Art:** Messproblem.
- **Evidenz:** Eine peer-reviewte Arbeit zur Anwendung von Erinnerung in
  Tool-Aufrufen misst für passives Retrieval rund 30,7 gegenüber rund 53,8
  Argument-F1 bei perfektem Oracle-Retrieval. Das Finden der Evidenz ist damit
  der dominante, aber nicht der alleinige Engpass — selbst Oracle-Retrieval
  bleibt bei 53,8. T-Mem belegt zusätzlich Fälle, deren Cue dem Ziel weder
  lexikalisch noch semantisch ähnelt.
- **Gate:** M0 für Datensatz und Manifest, M1 für die Metriken.
- **Datenquelle:** lokales Goldset, optionale externe Adapter in V1.x.
- **Abnahmekriterium:** Beide Fallklassen sind mit vollständiger Provenienz im
  Goldset vorhanden; Argumenttreue und korrekte Nichtanwendung sind
  reproduzierbar messbar.
- **Rollback:** Fallklassen aus der Auswertung nehmen; die bestehenden Metriken
  bleiben unberührt.

### C-037 – Nutzungssignale und Exposure-Korrektur

- **Passage:** 17.5 (neu), 18.7 M6.
- **Art:** Messproblem.
- **Evidenz:** Ori Mnemos spezifiziert Q-Wert-Rewards mit Exposure-Korrektur
  und Bias-Cap. C-006 und C-019 halten bereits fest, dass `acted_on` nur ein
  Token-Overlap-Proxy ist; ohne Exposure-Korrektur misst jede darauf gestützte
  Auswertung die eigene bisherige Auswahl.
- **Gate:** M6 im Shadow, Live-Wirkung erst nach bestandenem M6.
- **Datenquelle:** erweiterte Telemetrie mit `client`, `hook_source` und
  pseudonymer Session gemäß C-020.
- **Abnahmekriterium:** Die Exposure-Korrektur ist im Report ausgewiesen, das
  Mindest-N je Query-, Client- und Hook-Klasse ist erreicht, und kein Signal
  wirkt vor M6 live.
- **Rollback:** Signale nur protokollieren. Fallback ist die deterministische
  Reihenfolge des Evidenzentscheids.
- **Begriff korrigiert durch C-044.** Dieser Eintrag spricht durchgehend von
  „Exposure-Korrektur“. Verbindlich ist die Bezeichnung
  **Exposure-Normalisierung**: Die Division durch die Ausspielungszahl macht
  Raten vergleichbar und behebt den Selektionsbias nicht. Der Eintrag bleibt im
  Originalwortlaut stehen, weil das Ledger die Historie abbildet; maßgeblich
  sind C-044 und 17.5.

### C-038 – M5 misst Qualitätszerfall unter Wachstum

- **Passage:** 18.6 M5.
- **Art:** Messproblem.
- **Evidenz:** Ein verbreitetes Fremdsystem erreicht auf kurzen
  Konversationsbenchmarks 94,8 % (Top 50) und 92,5 % (Top 200), fällt bei zehn
  Millionen Token Historie aber auf 50,5 % Pass Rate; die Teilkategorien
  temporale Fragen, Widerspruchsauflösung und Abstention liegen bei
  Durchschnittswerten von 0,163, 0,325 und 0,400 auf einer 0-bis-1-Skala. Siehe
  auch C-040: Die im Vorgängerdokument stehende Prozentlesart dieser drei Werte
  war falsch.
- **Gate:** M5.
- **Datenquelle:** die bestehenden Skalenstufen bis 50.000 Memories,
  angereichert um Goldfälle je Qualitätskategorie.
- **Abnahmekriterium:** Kein überproportionaler Abfall von Abstention-,
  Widerspruchs- oder Temporalqualität zwischen zwei Skalenstufen ohne benannte
  Ursache.
- **Rollback:** Reine Messerweiterung ohne Produktwirkung.
- **Abnahmekriterium ersetzt durch C-045.** Das vorstehende Kriterium „kein
  überproportionaler Abfall … ohne benannte Ursache“ ist nicht ausführbar: Es
  lässt sich weder bestehen noch verfehlen, und eine Ursachenbeschreibung hätte
  jedes Verfehlen entschuldigt. Verbindlich sind die nach der Baseline
  festzulegenden numerischen Toleranzen je Kategorie aus 18.6.1.

### C-039 – Gravity- und Hub-Dämpfung als Ablationsarme

- **Passage:** 18.3 M2 Arme.
- **Art:** Hypothese.
- **Evidenz:** Ori Mnemos dokumentiert beide Mechanismen als Post-Fusion-Schritt.
  Bastra dämpft heute ausschließlich über Lifecycle-, Curator-, Doc- und
  Salience-Multiplikatoren auf dem vollen Kandidatenpool vor dem k-Schnitt
  (`packages/core/src/search.ts:311`); die vorgeschlagenen Mechanismen greifen
  an anderer Stelle und ersetzen die bestehende Dämpfung nicht.
- **Gate:** M2.
- **Datenquelle:** M2-Ablationsarme auf dem versionierten Goldset.
- **Abnahmekriterium:** Präzisionsgewinn oder gesenkte False-Interrupt-Rate ohne
  Recall@3-Verlust gegenüber dem identischen Arm ohne die zusätzliche Gravity-
  und Hub-Dämpfung. Der Vergleichsarm ist ausdrücklich nicht „ungedämpft“: Die
  bestehende Lifecycle-, Curator-, Doc- und Salience-Dämpfung bleibt in beiden
  Armen aktiv.
- **Rollback:** Arm abschalten; die bestehende Dämpfung bleibt unverändert.

---

*Ab hier Runde 2: die Deltas aus dem Codex-Gegenreview der vorstehenden
Einträge.*

### C-040 – Reproduzierbare Quellenmatrix

- **Passage:** 29 vollständig neu gefasst, mit den Unterabschnitten 29.1 bis
  29.5; ergänzend 18.1 M0 unter Arbeit und Gate.
- **Art:** Messproblem.
- **Evidenz:** Die Matrix der Vorgängerrevision nannte je Fremdclaim nur System,
  Evidenzklasse und Urteil. Ohne Version, Fundstelle und Messkonfiguration ist
  keine dieser Aussagen nachprüfbar. Der Abruf aller Quellen am 25. Juli 2026
  hat das bestätigt und zugleich zwei eigene Fehlzitate aufgedeckt: die Lesart
  dreier BEAM-Durchschnittswerte als Prozentzahlen und die Behauptung, Ori
  dokumentiere kein Konvergenzkriterium. Von neunzehn geprüften Messungen
  nennen drei alle vier Konfigurationsgrößen; am häufigsten fehlt das
  Kontextbudget, am folgenreichsten der Judge.
- **Gate:** M0.
- **Datenquelle:** die Primärquellen selbst sowie die Report-Metadaten des
  Eval-Harness.
- **Abnahmekriterium:** Jede zitierte Fremdaussage trägt kanonischen Ort,
  Version oder Commit, Fundstelle und Abrufdatum; jede zitierte Messung
  zusätzlich Reader, Judge, Top-k und Kontextbudget oder den ausdrücklichen
  Vermerk, dass die Quelle die Angabe nicht macht. Geschätzte oder aus anderen
  Quellen übertragene Werte sind unzulässig.
- **Rollback:** Reine Dokumentations- und Reportregel ohne Laufzeitwirkung.

### C-041 – Vollständig bi-temporales Zeitmodell

- **Passage:** 6.3 Unterabschnitt Zeitachsen; 18.5 M4; 22; 24; 25 Punkt 9.
- **Art:** Architekturentscheidung.
- **Evidenz:** Die Vorgängerrevision führte `recorded_at` als Zeitpunkt. Damit
  ist die Wissensachse kein Intervall, und die Frage „was hielt das System am
  Stichtag X für wahr?“ bleibt unbeantwortbar. Ein produktiv implementiertes
  Fremdsystem führt an dieser Stelle vier Marken — zwei auf der Transaktions-
  und zwei auf der Ereigniszeitlinie — und invalidiert widersprochene Fakten
  zeitlich, statt sie zu löschen. Zum heutigen `valid_until` belegt der Code:
  Es wird an genau einer Stelle gelesen und dort ausschließlich in einen
  Score-Multiplikator übersetzt — 20 % bei abgelaufener, 85 % bei alternder
  Gültigkeit. Kein Codepfad schließt ein Memory deswegen aus. Ein Feld mit
  Weltgültigkeitssemantik existiert heute nicht, ebenso wenig ein Feld mit
  Ereigniszeitsemantik.
- **Gate:** M4 und der gesonderte Schemaentscheid aus 21.4.
- **Datenquelle:** Punkt-in-der-Zeit-Goldfälle über beide Achsen; read-only
  Projektion vor der Schemaentscheidung.
- **Abnahmekriterium:** Eine Punkt-in-der-Zeit-Abfrage liefert getrennt, was am
  Stichtag wahr war und was das System damals dafür hielt; kein Feld trägt zwei
  Bedeutungen; `valid_until` behält seine Dämpfungswirkung unverändert und wird
  nicht migriert.
- **Rollback:** Alle Felder sind additiv und optional. Wird die Projektion
  verworfen, verhält sich das System exakt wie heute, weil `valid_until`
  unangetastet blieb.

### C-042 – Sicherer Provenienz-Fallback

- **Passage:** 6.3 Unterabschnitt Herkunft, neuer Block „Fallback für den
  Altbestand“; 18.5 M4; 22; 24; Rollback-Zeile in C-033.
- **Art:** Ist-Korrektur eines Fehlers der Vorgängerrevision.
- **Evidenz:** Die Vorgängerrevision schrieb als Rollback „ohne Feld gilt
  konservativ `user_asserted`“. Das ist die gefährlichste mögliche Voreinstellung
  und zugleich sachlich falsch. Der Code belegt das Gegenteil: `write_origin`
  ist optional ohne Schema-Default, die Schreibkaskade endet auf
  `agent-session`, und sämtliche Schutzprüfungen vergleichen strikt gegen
  `user-directed`. Ein Bestandsmemory ohne das Feld ist heute faktisch
  ungeschützt. Der Vault enthält also gerade keine Information, die eine
  Nutzerurheberschaft belegen würde. Ergänzend: `confidence` besitzt einen
  Schema-Default von 1,0 und wird im gesamten Retrieval-Pfad nie gelesen, taugt
  also nicht als Herkunftssignal; `source` wird maschinell nur vom Vault-Import
  gesetzt.
- **Gate:** M4 und Schemaentscheid; die Regel selbst gilt sofort für jede
  Ableitung.
- **Datenquelle:** Stichprobenklassifikation über den Bestand;
  Konsolidierungs-Reviews.
- **Abnahmekriterium:** Kein Memory erhält automatisch `user_asserted`, außer
  es trägt explizit `write_origin: user-directed`; alles übrige wird
  `unknown_legacy`; `confidence` geht in kein Mapping ein; es findet kein
  Massen-Rewrite statt.
- **Rollback:** Das Feld ist additiv. Ohne es verhält sich das System wie heute;
  `unknown_legacy` erzeugt keinerlei Sonderbehandlung, sondern nur die
  Verweigerung einer unbelegten Einstufung.
- **Korrigiert durch C-049 in zwei Punkten.** Erstens ist das hier beschriebene
  einstufige Mapping unsicher: Der Vault-Import stempelt auch maschinelle
  Inhalte als `write_origin: user-directed`, weshalb die Importprüfung Vorrang
  hat und nur ein nicht importierter Save automatisch `user_asserted` wird.
  Zweitens ist die Formulierung, `confidence` werde „im gesamten Retrieval-Pfad
  nie gelesen“, sachlich falsch — das Feld wird beim Indexieren gelesen und im
  Suchindex gehalten, wirkt dort aber nicht. Zusätzlich eingeschränkt durch
  C-055 und C-060: Ohne einen nicht selbst behauptbaren Bestätigungsbezug
  entsteht auch bei nicht importierten Memories kein `user_asserted` — und
  Attestierung ist kein Attribut eines Schreibpfads. Nach C-063 entsteht
  `user_asserted` überhaupt nur über die bestätigte Review. Der Eintrag bleibt
  im Originalwortlaut stehen; maßgeblich sind C-049, C-055, C-060, C-063
  und 6.3.

### C-043 – Cue-Ablation statt vorweggenommener Reduktion

- **Passage:** 11.4; 18.3 M2 Arme, Metriken und Gates.
- **Art:** Messproblem.
- **Evidenz:** Die Vorgängerrevision reduzierte die vier Cue-Familien auf zwei
  und begründete das mit der Abdeckung der beschreibenden Achse durch Titel,
  Tags, `topic_path` und Summary. Diese Begründung ist plausibel, stützt sich
  aber auf eine Fremdarbeit und auf die Struktur des Index — nicht auf eine
  Bastra-Messung. Damit nahm sie das Ergebnis der Ablation vorweg, die sie im
  selben Dokument anordnete. Zweitens sah dieselbe Fassung Arme „mit und ohne
  Rückbindung an die Evidenz“ vor; ein Arm ohne Provenienz verstößt gegen die
  Regel aus 11.4 und wäre keine Negativkontrolle, sondern ein Regelbruch.
  Drittens verband ein einziges Gate die Cue- und die Dämpfungsarme mit einem
  Oder — womit ein Cue-Arm allein durch gesenkte Fehlinjektionen hätte bestehen
  können, ohne je assoziative Abdeckung zu liefern.
- **Gate:** M2, mit getrennten Gates je Armtyp.
- **Datenquelle:** assoziative Goldfälle nach 19; vier Cue-Arme als read-only
  beziehungsweise Shadow-Projektion.
- **Abnahmekriterium:** Cue-Arm — die assoziative Coverage steigt messbar, ohne
  Verschlechterung von False-Interrupt-Rate und Recall. Dämpfungsarm — die
  False-Interrupt-Rate sinkt ohne relevanten Recall-Verlust. Jeder abgeleitete
  Cue trägt in jedem Arm Ziel-ID, Herkunft, Generatorversion und
  Evidenzverbindung.
- **Rollback:** Sidecar ignorieren; das Retrieval verhält sich wie heute.

### C-044 – Exposure-Normalisierung ist keine Bias-Korrektur

- **Passage:** 17.5; 18.7 M6; 24.
- **Art:** Messproblem.
- **Evidenz:** Die Vorgängerrevision nannte die Division durch die
  Ausspielungszahl „Exposure-Korrektur“ und behauptete damit implizit, sie
  behebe den Selektionsbias. Sie macht Raten vergleichbar, mehr nicht: Warum ein
  Kandidat überhaupt ausgespielt wurde, hängt vom bisherigen Ranking ab, und
  genau das bleibt unbeobachtet. Auch das als Vorbild zitierte Fremdsystem
  normalisiert lediglich — es teilt den Reward durch die Exposure-Zahl hoch 0,5
  — und beansprucht keine Propensity-Korrektur.
- **Gate:** M6; vor Erfüllung der drei Voraussetzungen ist keine kausale
  Aussage zulässig.
- **Datenquelle:** Telemetrie mit `client`, `hook_source` und pseudonymer
  Session nach C-020; zusätzlich geloggte Auswahlwahrscheinlichkeiten und ein
  randomisierter beziehungsweise Explorationsarm.
- **Abnahmekriterium:** Der Report weist die Normalisierung als solche aus. Ein
  kausaler Utility-Lift wird erst behauptet, wenn Propensities geloggt sind,
  kontrollierte Exploration läuft und nicht ausgespielte Kandidaten als
  zensiert behandelt werden. Bis dahin sind ausschließlich deskriptive
  Ratenvergleiche zulässig.
- **Rollback:** Signale weiter protokollieren, keine Live-Wirkung; Fallback ist
  die deterministische Reihenfolge des Evidenzentscheids.

### C-045 – Skalentest und Backend-Entscheidung getrennt

- **Passage:** 18.6 neu gegliedert in 18.6.1 und 18.6.2.
- **Art:** Messproblem.
- **Evidenz:** Die Vorgängerrevision hängte die Qualitätskategorien an das
  Flat/HNSW-Gate. Damit wären Wachstumseffekte und Backend-Effekte in einem
  Lauf vermischt worden und kein Befund mehr einer Ursache zuzuordnen. Zweitens
  setzen drei der fünf Kategorien — Widerspruchsauflösung, temporale Fragen,
  Ereignisreihenfolge — ein Claim-, Versions- und Zeitschema voraus, das erst
  M4 liefert; sie waren im Gate aufgeführt, ohne messbar zu sein. Drittens ist
  „kein überproportionaler Abfall ohne benannte Ursache“ kein ausführbares
  Kriterium: Es lässt sich nicht bestehen oder verfehlen, und eine
  Ursachenbeschreibung hätte jedes Verfehlen entschuldigt.
- **Gate:** 18.6.1 gatet nichts und ist jederzeit als Messung zulässig; 18.6.2
  bleibt das Live-Gate M5.
- **Datenquelle:** Skalenstufen bis 50.000 Memories auf identischem Backend für
  den Interferenztest; identischer Korpus mit beiden Backends für den
  Backend-Vergleich.
- **Abnahmekriterium:** Der Backend-Vergleich variiert ausschließlich das
  Backend. Für jede heute messbare Qualitätskategorie liegt nach der Baseline
  ein numerischer maximaler Abfall je Skalenverdopplung versioniert vor; ein
  verfehlter Wert bleibt verfehlt, unabhängig von der Ursachenbeschreibung.
  M4-abhängige Kategorien erscheinen bis dahin als „noch nicht messbar“.
- **Rollback:** Reine Messgliederung ohne Produktwirkung.

### C-046 – Erhalt der heutigen Hop-Baseline und Hop-Regel für `required`

- **Passage:** 13.1, neue Unterabschnitte zur Hop-Baseline und zur
  `required`-Regel; 18.2 M1; 18.5 M4; 22; 24.
- **Art:** Ist-Korrektur.
- **Evidenz:** Die Beschränkung des Normal Recall auf die Entity- und die
  temporale Sicht hätte eine heute produktive Fähigkeit stillschweigend
  entfernt. Der Code belegt: Der Hook-Endpunkt setzt `expand_hops` von sich aus
  auf 1, sofern der Aufrufer nicht ausdrücklich 0 sendet; kein Hook sendet den
  Parameter. Traversiert wird ausschließlich `related_via`, also genau die
  semantische Sicht. Der MCP-Pfad hoppt dagegen nie. Zur `required`-Regel
  belegt derselbe Code eine offene Lücke: Ein Hop-Nachbar erhält höchstens die
  Hälfte des rohen Seed-Scores, die Herkunftskennzeichnung `hop` wird vor der
  Auslieferung an den Hook aus der Antwort projiziert, und die
  `required`-Entscheidung fällt allein über die Schwelle 100. Auf dem
  Hybrid-Pfad verhindert nur die Obergrenze der skalierten Rangsumme bei rund
  164, dass ein Nachbar diese Schwelle erreicht. Auf dem BM25-only-Pfad — dem
  Fallback bei fehlenden oder ausgefallenen Embeddings — existiert diese
  Sicherung nicht.
- **Gate:** M1 für die `required`-Regel; M4 für den Sichtenvergleich.
- **Datenquelle:** Goldfälle, deren Ziel nur über einen Hop erreichbar ist;
  Hook-Telemetrie mit erhaltener Hop-Kennzeichnung; Sichtenablation gegen die
  semantische Baseline und gegen den No-Graph-Arm.
- **Abnahmekriterium:** Die semantische Sicht mit Hop-Budget eins bleibt aktiv
  und dient als Kontrollarm; keine neue Sicht verdrängt sie ohne eigenen
  belegten Lift. Kein Treffer wird allein aufgrund einer Kante `required`; die
  Hop-Herkunft steht dem Evidenzentscheid zur Verfügung.
- **Rollback:** Sichten deaktivieren; `related_via` mit Hop-Budget eins ist der
  heutige Zustand und bleibt der Rückfallpunkt.

### C-047 – Ausführbare Deep-Recall-Abbruchbedingungen

- **Passage:** 8.5, Blöcke zu Budgetgrenzen, Evidenzgewinn, Abbruch und den
  drei Ergebnissen; 18.4 M3 Metriken und Gates; 24; 26.2.
- **Art:** Architekturentscheidung.
- **Evidenz:** Die Vorgängerrevision nannte drei qualitative
  Abbruchbedingungen. „Kein neuer Evidenzgewinn“ war undefiniert, und für
  Laufzeit, Tokens, Äste, Tiefe, Provider-Aufrufe und Kandidaten existierte
  keine Obergrenze. Schwerer wiegt, dass beide erschöpfenden Ausgänge und der
  Budgetabbruch in einem einzigen `no_answer` zusammengefallen wären. Das ist
  nicht nur für den Nutzer irreführend — es verfälscht die Abstention-Metriken
  aus 18.2, weil abgebrochene Läufe dort als korrekte Enthaltung gezählt
  würden.
- **Gate:** M3, mit gesonderter Freigabe für Stufe 2.
- **Datenquelle:** Branch-, Konvergenz- und Budgettelemetrie; dormante
  Goldfälle; Kontrollarm mit lediglich vervierfachtem `k`.
- **Abnahmekriterium:** Die Grenzwerte liegen versioniert vor und stehen im
  Report. Evidenzgewinn ist über neue Evidenz-IDs oder neu beantwortete
  Teilfragen definiert. Die drei Ergebnisse sind in der Telemetrie
  unterscheidbar, und kein Budgetabbruch wird als `no_answer` ausgegeben.
- **Rollback:** Stufe 2 abschalten; Stufe 1 und Normal Recall bleiben
  unberührt.
- **Korrigiert durch C-052.** Die hier eingeführte Abbruchbedingung „zwei
  aufeinanderfolgende Schritte ohne Evidenzgewinn“ beendete den gesamten Lauf
  und wurde `no_answer` zugeordnet. Verbindlich ist die Fassung in 8.5: Sie
  schließt nur den Ast, und `no_answer` setzt deterministische Erschöpfung
  voraus.
- **Vervollständigt durch C-056.** Die hier und in C-052 genannten „drei
  Ergebnisse“ sind überholt. Verbindlich sind die fünf Endbedingungen und vier
  Ergebniswerte aus 8.5.

### C-048 – Messbare Erreichbarkeit, getrennte Accessibility-Operatoren

- **Passage:** 14.4, gegliedert in Klasse A und Klasse B sowie den Block zur
  Erreichbarkeitsgarantie; 18.5 M4; 26.2.
- **Art:** Architekturentscheidung.
- **Evidenz:** „Eine begrenzte Zahl typisierter Links“ ist ohne Zahl nicht
  prüfbar; auch die als Vorbild zitierte Fremdarbeit führt an dieser Stelle nur
  ein Symbol und keinen Wert. Zweitens standen `DORMANT` und `REACTIVATE` in
  derselben Operatorliste wie `SPLIT`, `MERGE` und `UPDATE`, obwohl sie keinen
  Inhalt ändern. Das widerspricht 7.1: Accessibility ist dort ausdrücklich eine
  reproduzierbare Projektion und keine gespeicherte Wahrheit — ein Operator,
  der sie als Version schriebe, hübe genau diese Eigenschaft auf.
- **Gate:** M4.
- **Datenquelle:** Konsolidierungsläufe; Erreichbarkeitsprüfung über den
  archivierten Bestand; Review-Protokolle.
- **Abnahmekriterium:** `max_provenance_hops` liegt versioniert vor und beginnt
  bei zwei. Die Survival-Quote erreicht 100 %, die Zitationsquote abgeleiteter
  Memories ist vollständig.
- **Präzisiert durch C-062.** Beide Quoten sind hier global definiert. Eine
  globale Quote zählt private Quellen im Nenner eines Aufrufers mit, für den
  sie nicht existieren, oder verleitet zu einem berechtigungsüberschreitenden
  Shortcut. Verbindlich ist die Fassung in 14.4: Beide Quoten gelten je
  Berechtigungs-, Scope- und Sensitivity-Kontext mit Zielwert 100 % innerhalb
  jedes Kontextes. Kein Klasse-B-Operator erzeugt eine Version, und
  eine dauerhafte Zugänglichkeitsentscheidung entsteht nur über einen
  expliziten Floor- oder Pin-Override.
- **Rollback:** Vorschläge nicht anwenden. Klasse-B-Vorschläge wirken ohne
  Override ohnehin nur bis zur nächsten Neuberechnung der Projektion.

---

*Ab hier Runde 3: die Deltas aus dem Codex-Delta-Review der Runde 2. Ein reiner
Delta-Fix — Passagen ohne Befund wurden nicht angefasst.*

### C-049 – Importherkunft vor `write_origin`, korrigierte `confidence`-Aussage

- **Passage:** 6.3, Fallback-Block vollständig neu gefasst als zweistufiges
  Mapping mit neuem Unterabschnitt „Review-Status statt Prosa-Vormerkung“; neue
  Klasse `imported_unverified` in der Klassentabelle; Korrektur der
  `confidence`-Aussage in 6.3, in 10.2, im Delta-Eintrag C-042 samt Ledgerzeile
  und in 32; Ergänzung der Importklasse in 22 und der Verbotszeile in 24.
- **Art:** Ist-Korrektur.
- **Evidenz:** Der Vault-Import stempelt jeden übernommenen Inhalt mit
  `write_origin: "user-directed"` — belegt in
  `packages/daemon/src/import/adapters.ts:153`, dort zusammen mit
  `source: "<adapter>:<label>:<relKey>"`. Dasselbe gilt in
  `packages/daemon/src/import-vault.ts:369` für einen **vollständig maschinell
  erzeugten Navigations-Index**, dort mit `source: "index:<label>"`,
  `topic_path: ["imported", <label>]` und dem Tag `imported`. Das in C-042
  eingeführte einstufige Mapping hätte damit einen fremden Vault samt
  generierter Hilfsknoten geschlossen zu Nutzeraussagen erklärt — genau der
  Fehler, den C-042 beheben sollte, nur durch eine andere Tür. Zur zweiten
  Korrektur: `confidence` wird sehr wohl gelesen, nämlich beim Indexieren
  (`packages/core/src/search.ts:724`), und als `storeField` im Suchindex
  gehalten (`search.ts:106` und `search.ts:175`). Die Aussage „wird beim
  Retrieval nirgends gelesen“ war falsch; richtig ist, dass das Feld weder
  Ranking noch Filterung noch den Evidenzentscheid beeinflusst.
- **Gate:** M4 und Schemaentscheid; die Vorrangregel gilt sofort für jede
  Ableitung.
- **Datenquelle:** `source`, `topic_path` und Tags des Bestandsmemorys für
  Stufe 1; `write_origin` ausschließlich für Stufe 2; Review-Status in der
  Sidecar-Projektion.
- **Abnahmekriterium:** Kein importiertes Memory erhält automatisch
  `user_asserted`; die Importprüfung läuft nachweislich vor der
  `write_origin`-Auswertung; `capture-review` landet konservativ auf
  `unknown_legacy` mit Review-Status `pending`; `confidence` geht in kein
  Mapping ein und wird im Dokument nicht mehr als ungelesen bezeichnet.
- **Rollback:** Additive Sidecar-Felder. Ohne sie verhält sich das System wie
  heute; `imported_unverified` erzeugt keine Sonderbehandlung, sondern nur die
  Verweigerung einer unbelegten Einstufung.
- **Ergänzt und eingeschränkt durch C-055 und C-060, überholt durch C-063.**
  Dieser Eintrag sichert die Importherkunft ab, behandelt ein nicht importiertes
  `write_origin: user-directed` aber weiterhin als hinreichend. Verbindlich ist
  die Fassung in 6.3: Attestierung ist kein Attribut eines Schreibpfads, kein
  Schreibpfad erfüllt sie — auch künftig keiner —, und `user_asserted` entsteht
  überhaupt nur über die bestätigte Review. Der Review-Status heißt jetzt `not_scheduled` statt
  `not_required`, und die Bestätigung läuft über einen eigenen
  Provenienz-Override-Vertrag statt über 14.4 Klasse B.

### C-050 – Widerspruch, Zeitachsen und die übrigen Zustände abgegrenzt

- **Passage:** 6.3 Zeitachsen, gestufter Widerspruchsablauf, Abgrenzung von
  `valid_to` gegen Rolle und Accessibility sowie neuer Unterabschnitt „Fünf
  getrennte Zustände“; nachgezogene Gate-Zeile in 18.5.
- **Art:** Architekturentscheidung.
- **Evidenz:** Die Formulierung „Ein Widerspruch setzt deshalb `retracted_at`“
  war zu stark. Sie hätte eine automatische Wahrheitsentscheidung aus einer
  bloßen Konflikterkennung abgeleitet und damit gegen die Regel aus Abschnitt
  13 verstoßen, dass widersprechende Kanten sichtbar erklärt und nicht still
  aufgelöst werden. Zweitens standen `valid_to`, `recorded_at`/`retracted_at`,
  `valid_until`, `obsolete` und Soft Delete unverbunden nebeneinander, obwohl
  sie sich in der Wirkung ähneln — alle fünf können dazu führen, dass ein
  Memory nicht mehr auftaucht — und in der Bedeutung nicht.
- **Gate:** M4 und Schemaentscheid.
- **Datenquelle:** Goldfälle mit offenen und mit aufgelösten Widersprüchen;
  Operatorprotokolle.
- **Abnahmekriterium:** Ein erkannter Widerspruch erzeugt einen konkurrierenden
  Claim beziehungsweise eine `contradicts`-Kante und setzt kein `retracted_at`;
  dieses wird ausschließlich durch bestätigte Auflösung, akzeptierte Korrektur
  oder bestätigtes `SUPERSEDE` gesetzt. Keine automatische Gleichsetzung oder
  Migration zwischen den fünf Zuständen; eine Operation, die mehrere berührt,
  weist das im Operatorvertrag aus.
- **Rollback:** Ein offener Widerspruch ist der Ausgangszustand. Wird die
  Auflösung zurückgenommen, entfällt `retracted_at` und beide Aussagen sind
  wieder aktiv.

### C-051 – Cue-Ablation als 2×2-Design mit Stufenausweis

- **Passage:** 18.3, Cue-Abschnitt neu gefasst; 11.4 um die Stufenabhängigkeit
  ergänzt; 30 umformuliert.
- **Art:** Messproblem.
- **Evidenz:** Die vier Arme aus der Vorgängerrevision waren als Liste
  formuliert. Gelesen als vier Varianten gegen einen Referenzarm verdeckt der
  Kombinationsarm die Einzelarme; gelesen als Zellen eines faktoriellen Plans
  über die beiden Achsen tut er das nicht, sondern liefert zusätzlich die
  Interaktion. Zweitens beziehen sich `descriptive_scene` und
  `associative_horizon` auf Episoden beziehungsweise Szenen — ein Gegenstand,
  den das Vault-Schema erst mit M4 kennt. M2 hätte also über zwei Familien
  berichtet, die es gar nicht bilden kann. Drittens las sich die
  Zurückstellung in Abschnitt 30 wie eine bereits getroffene Ablehnung der
  beschreibenden Achse.
- **Gate:** M2 für die Item-Ebene; M4 für die Szenenebene, sofern Variante (a)
  gewählt wird.
- **Datenquelle:** assoziative und beschreibende Goldfälle nach 19; für
  Variante (b) zusätzlich eine benannte read-only Episoden- beziehungsweise
  Szenenprojektion mit eigenen Goldfällen.
- **Abnahmekriterium:** Der Report weist Hauptwirkung je Achse und Interaktion
  getrennt aus und benennt, welche der beiden Varianten gefahren wurde. Ein auf
  Item-Ebene gemessener Befund wird nicht auf die Szenenebene übertragen. Kein
  Report behauptet ohne eine der beiden Varianten, alle vier Familien geprüft
  zu haben.
- **Rollback:** Sidecar ignorieren; das Retrieval verhält sich wie heute.
- **Ergänzt durch C-057.** Das Design bleibt gültig; Fallzahlregel,
  Explorativ-Kennzeichnung und die Konstanz der übrigen Retrieval-Konfiguration
  sind in 18.1 und 18.3 nachgetragen.

### C-052 – Ast- und Laufabbruch getrennt, Ergebnisvertrag über alle Oberflächen

- **Passage:** 8.5, Abbruchabschnitt neu gefasst, Budgetgrenzen in harte und
  weiche getrennt und um den Oberflächenvertrag ergänzt; 8.4 Punkt 8
  nachgezogen; 13.1, Schlussabsatz zur Hop-Kennzeichnung; 18.2 und 18.4.
- **Art:** Architekturentscheidung.
- **Evidenz:** Die Vorgängerrevision ließ „zwei aufeinanderfolgende Schritte
  ohne Evidenzgewinn“ den gesamten Lauf beenden und ordnete diesen Ausgang
  zudem `no_answer` zu. Beides ist falsch: Ein erschöpfter Zweig sagt nichts
  über die übrigen offenen Äste, und ein Lauf, der mit offenen Ästen stehen
  bleibt, hat gerade nicht gezeigt, dass die Suche erschöpft war. In dieser
  Form hätte die Regel dieselbe Metrikverfälschung erzeugt, die C-047
  verhindern wollte. Zweitens war der Ergebnisvertrag nur für die
  Deep-Recall-Stufe beschrieben, nicht für die Oberflächen, über die er
  ausgeliefert wird.
- **Gate:** M3.
- **Datenquelle:** Branch- und Konvergenztelemetrie mit Zahl offener Äste je
  Abbruch; Oberflächenprotokolle von MCP, REST, CLI und Mindspace.
- **Abnahmekriterium:** Ausbleibender Evidenzgewinn schließt nur den Ast.
  `no_answer` tritt ausschließlich nach deterministischer Erschöpfung aller
  Teilfragen und zulässigen Äste auf. Das Ergebnisobjekt wird unverändert durch
  MCP, REST, CLI und Mindspace geführt; kein Budgetstatus wird durch Fehler-
  oder UI-Behandlung in `no_answer` umgewandelt. Die Hooks sind kein Konsument
  der Stufe 2.
- **Rollback:** Stufe 2 abschalten; Stufe 1 und Normal Recall bleiben
  unberührt. Die Lean-Projektion der Hook-Antwort bleibt in jedem Fall
  unverändert, da die Hop-Kennzeichnung serverintern bleibt.
- **Vervollständigt durch C-056, präzisiert durch C-061.** Der hier festgelegte
  Vertrag deckte die Erfolgsbedingung nicht ab und ließ nicht budgetbedingte
  Abbrüche über `limit: "other"` als Budgetproblem erscheinen. Verbindlich ist
  die Fassung in 8.5 mit fünf Endbedingungen und vier Ergebniswerten;
  `no_answer` bedeutet dort „keine entscheidungsfähige Antwort“ und nicht
  „keine Evidenz“.

### C-053 – Erhaltungsregel für die Survival-Invariante, Sonderfall `SUPERSEDE`

- **Passage:** 14.4, Erreichbarkeitsgarantie um die Erhaltungsregel erweitert,
  neuer Unterabschnitt zu `SUPERSEDE`; 18.5.
- **Art:** Architekturentscheidung.
- **Evidenz:** `SPLIT` gefolgt von `MERGE` bringt eine Ursprungsquelle auf
  genau zwei Provenienz-Hops — die Grenze wird erreicht, aber nicht
  überschritten. Bereits eine weitere Generation überschreitet sie. Ein
  Startwert ohne Durchsetzungsmechanismus wäre damit in der zweiten
  Konsolidierungsrunde wirkungslos. Zum zweiten Punkt: `SUPERSEDE` verschiebt
  den Wahrheitsstand und wirkt dadurch auch auf die Sichtbarkeit des
  Vorgängers. Ohne ausdrückliche Abgrenzung wäre unklar, ob daraus eine
  Accessibility-Entscheidung der Klasse B folgt — was der Trennung aus C-048
  widerspräche.
- **Gate:** M4.
- **Datenquelle:** Simulation der Invariante je Operation; Erreichbarkeitslauf
  über den archivierten Bestand nach jedem Konsolidierungsschritt;
  Rollback-Protokolle.
- **Abnahmekriterium:** `max_provenance_hops` = 2 gilt als Startkandidat und
  wird durch die Messung bestätigt oder korrigiert. Vor jeder einzelnen
  Klasse-A-Operation wird die Invariante simuliert; die Operation wird
  blockiert oder erzeugt additive Provenienz-Shortcuts, welche die ursprüngliche
  Kette nicht ersetzen. Kein Zwischenzustand eines Laufs verletzt die
  Invariante. `SUPERSEDE` bleibt Klasse A, erzeugt keinen dauerhaften
  Accessibility-Override, und sein Rollback stellt Versions- und Zeitstatus
  sowie die aktuelle Sichtbarkeit wieder her.
- **Rollback:** Vorschläge nicht anwenden. Eine blockierte Operation
  hinterlässt keinen Zustand.
- **Vervollständigt durch C-058 und C-059, präzisiert durch C-062.** Das
  Verhältnis von Operation und Shortcut, der nicht erfüllbare Fall und die
  Sensitivity-Schranke sind in 14.4 nachgetragen; die Abgrenzung von
  `SUPERSEDE` gegen das heutige Archivierungsprimitiv folgt aus C-059. Survival-
  und Zitationsquote gelten nach C-062 je Berechtigungskontext.

### C-054 – Ledger- und Quellenkonsistenz

- **Passage:** 0.4 Ledgerzeilen zu C-037 und C-038; die Delta-Einträge C-037
  und C-038 in Abschnitt 28; 29.3 Zeile zu AgentRunbook; 32; sämtliche Angaben
  zur nächsten freien ID.
- **Art:** Messproblem beziehungsweise Redaktionsfehler.
- **Evidenz:** Fünf Inkonsistenzen aus der Vorgängerfassung: C-037 sprach
  weiterhin von „Exposure-Korrektur“, obwohl C-044 den Begriff korrigiert;
  C-038 führte weiterhin das durch C-045 ersetzte, nicht ausführbare
  Abnahmekriterium; die AgentRunbook-Messzeile in 29.3 nannte nur „Tabelle 2“
  ohne Quellenbezug und war damit nur indirekt auflösbar; die Zusammenfassung in
  32 stützte sich auf die inzwischen korrigierte `confidence`-Aussage; und die
  nächste freie ID stand an drei Stellen auf dem alten Wert.
- **Gate:** entfällt — Dokumentkonsistenz.
- **Datenquelle:** das Dokument selbst.
- **Abnahmekriterium:** Jeder korrigierte Alteintrag trägt an Ort und Stelle
  einen Korrekturverweis auf den korrigierenden Eintrag, analog zur bereits
  bestehenden Behandlung von C-033 durch C-042. Jede Messzeile in 29.3 ist über
  Quelle, Version und Fundstelle auflösbar. Die nächste freie ID lautet an allen
  Stellen C-055.
- **Rollback:** Rein redaktionell, ohne Laufzeit- oder Vertragswirkung.

---

*Ab hier Runde 4: die Deltas der abschließenden Korrekturrunde.*

### C-055 – Provenienz-Attestierung und Review-Vertrag

- **Passage:** 6.3, Stufe-2-Tabelle um die Attestierungsbedingung erweitert,
  neuer Unterabschnitt „Warum `write_origin` allein nicht genügt“;
  Review-Status-Block um `confirmed_provenance_class`,
  `provenance_review_ref` und den Provenienz-Override-Vertrag erweitert,
  `not_required` in `not_scheduled` umbenannt; 22; 24; 26.2.
- **Art:** Ist-Korrektur.
- **Evidenz:** `write_origin` ist im öffentlichen MCP-Tool-Schema exponiert
  (`packages/daemon/src/tool-handlers.ts:1338`), und der Save-Handler reicht die
  Eingabe unverändert an `saveMemory` durch
  (`packages/daemon/src/tool-handlers.ts:857`) — ohne Audit-Wrapper. Nach C-008
  existiert ein vollständiges Mutation-Audit bis heute nur im
  Mac-Bridge-Pfad. Ein über MCP gesetztes `user-directed` ist damit eine
  Behauptung des Aufrufers und kein Nachweis eines Nutzerakts. C-049 hatte die
  Importherkunft abgesichert, aber diese zweite Lücke offen gelassen: Auch ein
  nicht importierter Save kann das Feld frei setzen.
- **Gate:** M4 und Schemaentscheid; die Attestierungsregel gilt sofort für jede
  Ableitung.
- **Datenquelle:** Schreibpfad und Auditbezug des jeweiligen Saves;
  Review-Entscheidungen mit `confirmed_provenance_class` und
  `provenance_review_ref`.
- **Abnahmekriterium:** `user_asserted` entsteht automatisch nur bei
  attestiertem Schreibpfad mit auflösbarem Auditbezug; ein behauptetes
  `user-directed` ohne Attestierung fällt auf `unknown_legacy` mit
  Review-Status `pending`. Die Importprüfung behält absoluten Vorrang. Eine
  Bestätigung ohne `confirmed_provenance_class` und `provenance_review_ref` ist
  unwirksam. Der Provenienz-Override berührt weder Floors noch Pins noch Zonen
  und ist jederzeit widerrufbar. `not_scheduled` wird nirgends als Bestätigung
  gelesen.
- **Rollback:** Additive Sidecar- und Overridefelder. Ohne sie verhält sich das
  System wie heute; die Rückfallregel verschärft ausschließlich die Ableitung
  und verändert keinen Schreibpfad. Sobald ein einheitliches Mutation-Audit
  existiert, entfällt die Rückfallregel für die dann attestierten Pfade.
- **Beantwortet durch C-063, verschärft durch C-064 und C-070, korrigiert durch
  C-065 und C-069.** Der Bestätigungsbezug entsteht in der Recall-Oberfläche;
  eine Bestätigung bindet an `memory_id` und den Hash des im Review
  dargestellten aussagetragenden Inhalts; `not_scheduled` ist keine Ausnahme von
  der Prüfung mehr, sondern nur noch die Warteschlangenposition; und die
  Reviewberechtigung hängt weder an `write_origin` noch am Importstatus.
- **Korrigiert durch C-060.** Dieser Eintrag setzt den auditierten
  Mac-Bridge-Pfad mit einem attestierten Pfad gleich und knüpft die Aufhebung
  der Rückfallregel an das einheitliche Mutation-Audit. Beides ist zu schwach:
  Der Audit-Kontext wird vom Caller geliefert und fällt sonst auf
  `actor: user` zurück. Verbindlich ist die Fassung in 6.3 — Attestierung
  verlangt einen nicht selbst behauptbaren Bestätigungsbezug, und kein heutiger
  Pfad erfüllt ihn.

### C-056 – Vollständiger Deep-Recall-Endzustandsvertrag

- **Passage:** 8.4 Punkt 8; 8.5, Lauf-Endbedingungen um Bedingung 0 und 4
  erweitert, Prioritätsregel bei Gleichzeitigkeit, Ergebnistabelle um
  `inconclusive_interrupted` erweitert, Interface um `end_condition` und
  `stop_reason` erweitert und `limit: "other"` entfernt, Oberflächenvertrag
  nachgezogen; 18.4; 24; 26.2; Korrekturverweise an C-047 und C-052 in 0.4 und
  28.
- **Art:** Architekturentscheidung.
- **Evidenz:** Der Vertrag aus C-052 deckte nur die negativen Ausgänge
  vollständig ab. Die Erfolgsbedingung war stillschweigend vorausgesetzt, der
  Fall „Fund und Grenze im selben Schritt“ ungeregelt, und der in der Vorrunde
  eingeführte Auffangwert `limit: "other"` hätte jeden beliebigen Abbruch als
  Budgetproblem ausgewiesen — einschließlich eines Nutzerabbruchs oder eines
  Shutdowns. Damit wäre dieselbe Verwechslung entstanden, die C-052 zwischen
  `no_answer` und Budgetabbruch verhindern sollte, nur eine Ebene tiefer.
- **Gate:** M3.
- **Datenquelle:** Branch-, Konvergenz- und Budgettelemetrie mit
  `end_condition`, `limit` und `stop_reason`; Oberflächenprotokolle von MCP,
  REST, CLI und Mindspace.
- **Abnahmekriterium:** Jeder Lauf endet in genau einer der fünf
  Endbedingungen und meldet genau einen der vier Ergebniswerte. Ein Fund
  gewinnt gegen eine gleichzeitig erreichte Grenze, die dann im Feld `limit`
  sichtbar bleibt. `inconclusive_budget_exhausted` tritt nur bei tatsächlich
  erreichter Grenze auf. Transport- und interne Fehler erscheinen als Fehler
  der Schnittstelle, nie als Ergebniswert. Keine Oberfläche fasst die beiden
  inconclusive-Werte zusammen.
- **Rollback:** Stufe 2 abschalten; Stufe 1 und Normal Recall bleiben
  unberührt. Der Vertrag ist additiv gegenüber C-052 — bestehende Konsumenten,
  die nur drei Werte kennen, behandeln `inconclusive_interrupted` wie einen
  unbekannten Wert und dürfen ihn nicht auf `no_answer` abbilden.
- **Korrigiert durch C-061.** Der hier eingeführte `stop_reason`-Wert
  `controller_defect` machte einen Implementierungsfehler zu einem regulären
  Endzustand. Verbindlich ist die Fassung in 8.5: Ein Controllerdefekt ist ein
  strukturierter Schnittstellenfehler mit read-only Teilzustand.

### C-057 – Statistisch ausführbarer 2×2-Cue-Versuch

- **Passage:** 18.1 M0 um Power- und Mindest-N-Regel sowie getrennte
  Goldfallmengen erweitert; 18.3 um „Statistische Ausführbarkeit“ und
  „Konstante Umgebung“ erweitert; 24.
- **Art:** Messproblem.
- **Evidenz:** C-051 hat das faktorielle Design eingeführt, aber keine
  Fallzahlregel. Die Interaktion ist die schwächste Größe des Plans und
  benötigt das größte N; ohne vorab festgelegtes Mindest-N wäre ein
  Interaktionsbefund nicht von Rauschen zu unterscheiden — und würde
  gleichwohl über eine Live-Freigabe entscheiden. Zweitens war nicht geregelt,
  ob der Cue-Versuch mit den übrigen M2-Armen gekreuzt wird; ein ungeplantes
  vollständiges Crossing vervielfacht die Zellen und macht jede
  Interaktionsaussage wertlos.
- **Gate:** M0 legt fest, M2 wertet aus.
- **Datenquelle:** die in 19 getrennt ausgewiesenen beschreibenden und
  assoziativen Fallmengen; versionierte Power-Annahme und Mindest-N je Zelle.
- **Abnahmekriterium:** Mindest-N je Zelle liegt vor der Auswertung
  versioniert vor, getrennt für Hauptwirkungen und Interaktion. Wird es für die
  Interaktion nicht erreicht, ist sie als explorativ gekennzeichnet und trägt
  weder Gate noch Live-Freigabe. Die übrige Retrieval-Konfiguration ist über
  alle vier Zellen konstant; ein Crossing mit anderen M2-Armen findet nur nach
  vorab registriertem Design statt.
- **Rollback:** Reine Versuchsplanung ohne Produktwirkung.
- **Ergänzt durch C-066, korrigiert durch C-072 und C-074.** Fallzahl- und
  Konstanzregel dieses Eintrags gelten für den 2×2-Cue-Achsenversuch. Für den
  Erzeugungsweg sind die beiden Anlagen aus 18.3 verbindlich; bei Anlage A gilt
  das Mindest-N je Bedingung, und eine Interaktion wird dort nicht
  ausgewertet.

### C-058 – Atomare Survival-Invariante und unverklemmbarer Ausweg

- **Passage:** 14.4, Erhaltungsregel von fünf auf sieben Punkte erweitert,
  neue Blöcke „Wenn nichts davon greift“ und „Keine Schleifen“; 18.5; 24.
- **Art:** Architekturentscheidung.
- **Evidenz:** C-053 ließ offen, in welchem Verhältnis Operation und Shortcut
  stehen. Ein separat nachgetragener Shortcut wäre eine autonome Graphmutation
  und verstieße gegen die Freigabepflicht aus 13 und 14.4; eine Operation ohne
  ihren Shortcut hinterließe einen Teilzustand, der die Invariante verletzt.
  Zweitens war der Fall ungeregelt, in dem weder Operation noch Shortcut
  zulässig sind — dort drohte entweder ein dauerhaft blockierter
  Konsolidierungslauf oder eine automatische Wiederholungsschleife. Drittens
  fehlte die Sensitivity-Schranke: Ein Shortcut, der die Erreichbarkeit
  herstellt, indem er eine private Quelle in einen weniger geschützten Bereich
  verlinkt, würde Abschnitt 23 verletzen.
- **Gate:** M4.
- **Datenquelle:** Simulationsprotokoll je Operation; Ablehnungs- und
  Blockadeprotokoll je Struktur; Sensitivity-Prüfung je Shortcut.
- **Abnahmekriterium:** Shortcut beziehungsweise sichtbarer Zwischenknoten sind
  Teil desselben atomaren Vorschlags; kein automatischer `LINK`-Nachtrag; kein
  Teilzustand nach Abbruch; kein Shortcut über eine Sensitivity-Grenze; keine
  Wiederholung derselben blockierten Operation innerhalb eines Laufs; eine
  Änderung von `max_provenance_hops` erfolgt nur als gesonderter, gemessener
  Vorschlag.
- **Rollback:** Vorschläge nicht anwenden. Ein blockierter Vorschlag
  hinterlässt keinen Zustand, und der Lauf läuft an der übersprungenen Struktur
  vorbei weiter.
- **Präzisiert durch C-062.** Die hier genannte Sperre „bis sich die
  zugrunde liegenden Memories oder `max_provenance_hops` geändert haben" war zu
  unscharf; verbindlich ist der strukturelle Fingerprint aus 14.4. Ebenso
  gelten Survival- und Zitationsquote je Berechtigungskontext.

### C-059 – `SUPERSEDE`, `obsolete` und Trash entkoppelt

- **Passage:** 14.4, `SUPERSEDE`-Abschnitt um Abgrenzung, Migrationsregel und
  fünfteiligen Rollback erweitert; 18.5; 21.4; 22; 24.
- **Art:** Architekturentscheidung mit Ist-Korrektur.
- **Evidenz:** Das heutige Archivierungsprimitiv tut weit mehr als eine
  Markierung: `archiveMemoryHandler` verschiebt die Datei mit `moveToTrash` in
  den Vault-Trash (`packages/daemon/src/tool-handlers.ts:928`), entfernt sie
  über `forgetFile` aus dem lebenden Index (`:929`) und stempelt die
  Trash-Kopie best-effort mit `obsolete: true` und `superseded_by` (`:934`).
  Der Normal Recall filtert `obsolete` ohnehin vollständig aus
  (`packages/core/src/search.ts:746`). Ein `SUPERSEDE`, das dieses Primitiv
  wiederverwendete, machte den Vorgänger nicht historisch, sondern
  unauffindbar — und bräche die in 15 und 26.2 zugesagte Zitierbarkeit alter
  Versionen.
- **Gate:** M4; der Historical-Index ist Voraussetzung der Live-Schaltung.
- **Datenquelle:** Auflösungsproben über ID, Version und Zitat gegen den
  Historical-/Deep-Recall-Index; Rollback-Protokolle mit allen fünf
  wiederhergestellten Größen.
- **Abnahmekriterium:** `SUPERSEDE` arbeitet ausschließlich über Claim- und
  Versionsstatus, verschiebt nichts in den Trash und entfernt nichts aus dem
  Index. Jeder superseded Vorgänger ist über den Historical-Index nach ID,
  Version und Zitat auflösbar. Wird übergangsweise `obsolete` gesetzt, liest
  der historische Loader es ausdrücklich ein, während der Normal Recall es
  weiterhin ausschließt. Ein Rollback stellt Versionsstatus, Zeitstatus,
  Speicherort, Indexierbarkeit und Sichtbarkeit wieder her.
- **Rollback:** Ohne Historical-Index geht `SUPERSEDE` nicht live; das
  bestehende Archivierungsprimitiv bleibt unverändert und behält seine heutige
  Bedeutung — laut seiner Dokumentation im Code das Abschluss-Primitiv der
  Intake-Adoption (`packages/daemon/src/tool-handlers.ts:899`).

---

*Ab hier Runde 5: der abschließende Delta-Fix.*

### C-060 – Attestierung ist mehr als ein Mutation-Audit

- **Passage:** 6.3, Stufe-2-Tabelle, Attestierungsdefinition vollständig neu
  gefasst als Unterabschnitt „Ein Mutation-Audit ist nicht dasselbe wie eine
  Attestierung“, Klassentabelle; 18.5 Gates; 22; 24.
- **Art:** Ist-Korrektur.
- **Evidenz:** C-055 hatte den auditierten Mac-Bridge-Pfad als attestiert
  eingestuft. Der Code trägt das nicht: Der Audit-Kontext wird dort aus den
  Aufrufparametern gelesen und, wenn der Caller keinen mitschickt, auf
  `{ actor: "user" }` defaultet — `packages/daemon/src/bridge.ts:322` und
  `:325`, gleichlautend an zwei weiteren Stellen (`:350`, `:379`). Die einzige
  inhaltliche Prüfung greift beim Wert `assistant`, der eine Begründung
  erzwingt (`packages/core/src/audit-save.ts:49`); die Behauptung
  `actor: "user"` verlangt gar nichts. Ein Audit belegt damit die Mutation,
  nicht den Nutzerakt.
- **Gate:** M4 und Schemaentscheid; die Regel gilt sofort für jede Ableitung.
- **Datenquelle:** Bestätigungsbezug `user_action_ref` beziehungsweise
  `confirmation_ref` des jeweiligen Saves; Provenienz-Reviews.
- **Abnahmekriterium:** `user_asserted` entsteht automatisch nur mit einem
  Bestätigungsbezug, der serverseitig oder von einem vertrauenswürdigen
  UI-Adapter erzeugt wurde, vom speichernden Caller nicht behauptbar ist, auf
  einen konkreten Nutzerakt verweist und auflösbar bleibt. Ein vollständiges
  Mutation-Audit allein genügt nicht. Ein direkt übergebenes
  `provenance_class: user_asserted` unterliegt derselben Regel. Soll der
  Mac-Client als Attestor gelten, ist die Trust-Grenze benannt und durch eine
  vom Save-Aufruf getrennte Nutzeraktionsreferenz belegt.
- **Rollback:** Reine Ableitungsregel; kein Schreibpfad wird verändert. Die
  bestätigte Provenienz-Review bleibt der offene Weg zu `user_asserted`.
- **Beantwortet durch C-063.** Dieser Eintrag lässt offen, ob ein Schreibpfad
  künftig attestieren kann, und nennt den Mac-Client als möglichen Attestor.
  Verbindlich ist die Fassung in 6.3: Der Bestätigungsbezug entsteht
  ausschließlich in der Recall-Oberfläche, kein Schreibpfad wird zum Attestor,
  und ein einheitliches Mutation-Audit hebt die Rückfallregel nicht auf.

### C-061 – Controllerdefekt ist kein Ergebnis, `no_answer` kein Evidenzverbot

- **Passage:** 8.4 Punkt 8; 8.5, Endbedingung 4 auf externe Unterbrechungen
  eingegrenzt,
  `controller_defect` aus Ergebnistabelle und `stop_reason` entfernt, neuer
  Fehlervertrag `DeepRecallDefect`, `no_answer`-Abgrenzung um Teilabdeckung
  erweitert, Ergebnisobjekt um `unresolved_subquestions` und `coverage`
  erweitert, Oberflächenvertrag nachgezogen; 18.4 Metriken und Gates; 24;
  26.2.
- **Art:** Architekturentscheidung.
- **Evidenz:** C-056 führte `controller_defect` als `stop_reason` und machte
  damit einen Implementierungsfehler zu einem regulären Endzustand — er wäre in
  die Ergebnisstatistik eingegangen und hätte dieselbe Metrikverfälschung
  erzeugt, gegen die C-047 und C-052 angetreten waren. Zweitens behauptete die
  `no_answer`-Definition „es existiert nachweislich keine belastbare Evidenz“.
  Das ist stärker als das, was ein erschöpfter Lauf zeigen kann: Er zeigt, dass
  keine entscheidungsfähige Antwort zustande kam — partielle Evidenz kann
  vorliegen und wurde bislang stillschweigend verworfen.
- **Gate:** M3.
- **Datenquelle:** Telemetrie mit getrennter Defektrate, Coverage-Verteilung
  der `no_answer`-Fälle und `unresolved_subquestions` je Lauf.
- **Abnahmekriterium:** Kein Controllerdefekt erscheint als Ergebniswert oder
  `stop_reason`; er wird als strukturierter Fehler mit read-only Teilzustand
  signalisiert und nicht in die Ergebnisstatistik gezählt.
  `inconclusive_interrupted` bleibt auf `user_cancelled`, `shutdown` und
  `permission_revoked` beschränkt. `no_answer` wird nie als „keine Evidenz
  vorhanden“ ausgegeben, solange `coverage` größer als null oder `evidence`
  nicht leer ist.
- **Rollback:** Stufe 2 abschalten. Der Fehlervertrag ist additiv: Konsumenten,
  die ihn nicht kennen, sehen einen Schnittstellenfehler statt eines
  Ergebnisses — was der gewünschten Semantik entspricht.

### C-062 – Berechtigungsbezogene Survival-Garantie, stabile Wiederholungssperre

- **Passage:** 14.4, Quotendefinition um Berechtigungs-, Scope- und
  Sensitivity-Kontext erweitert, Block „Keine Schleifen“ auf einen
  strukturellen Fingerprint umgestellt; 18.5.
- **Art:** Architekturentscheidung.
- **Evidenz:** C-048 führte Survival- und Zitationsquote als globale Größen
  ein (Messblock in 14.4); C-053 und C-058 haben sie unverändert übernommen.
  Eine globale Quote ist entweder falsch — sie zählt private Quellen im Nenner
  eines Aufrufers, für den sie nicht existieren — oder gefährlich, weil sie
  dazu verleitet, die Erreichbarkeit über einen berechtigungsüberschreitenden
  Shortcut herzustellen. Genau das verbietet C-058 Punkt 6 bereits, ohne dass
  die Quote es abbildete. Zweitens war die von C-058 eingeführte
  Wiederholungssperre an „geänderte Memories“ geknüpft, ohne zu sagen, welche
  Änderung zählt: Ein bewegter
  Zeitstempel oder ein neu berechneter `stale_status` hätte denselben
  blockierten Vorschlag jede Nacht erneut freigegeben.
- **Gate:** M4.
- **Datenquelle:** Erreichbarkeitslauf je Berechtigungs-, Scope- und
  Sensitivity-Kontext; Fingerprint-Protokoll je blockiertem Vorschlag.
- **Abnahmekriterium:** Beide Quoten erreichen innerhalb jedes zulässigen
  Kontextes 100 %; keine Quelle steht im Nenner eines Kontextes, in dem sie
  nicht sichtbar sein darf; existiert kein sicherer Pfad, bleibt die Quelle
  oder ein Zwischenknoten im eigenen geschützten Kontext sichtbar, ohne
  berechtigungsüberschreitenden Shortcut. Die Sperre reagiert ausschließlich auf
  den strukturellen Fingerprint und nicht auf Cache-, Telemetrie-,
  `stale_status`- oder Zeitstempeländerungen.
- **Rollback:** Reine Mess- und Sperrregel ohne Produktwirkung; ohne sie gilt
  die globale Quote der Vorfassung, die den Privacy-Vorrang aus 23 aber nicht
  korrekt abbildet.
- **Präzisiert durch C-067.** Das hier formulierte Abnahmekriterium macht den
  strukturellen Fingerprint zur alleinigen Bedingung. Er ist notwendig, aber
  nicht hinreichend; verbindlich ist die Rückkehrregel aus 14.4.

---

*Ab hier Runde 6: die Umsetzung der am 25. Juli 2026 getroffenen
Product-Owner-Entscheidungen.*

### C-063 – Der Bestätigungsbezug entsteht in der Recall-Oberfläche

- **Passage:** 6.3, neuer Unterabschnitt „Wo der Bestätigungsbezug entsteht“ mit
  der Zuordnung der vier Antwortmöglichkeiten zu vier Provenienzklassen;
  Einleitungssatz der Attestierungsdefinition; 18.5 Gates; 31 Entscheidung 5.
- **Art:** Product-Owner-Entscheid.
- **Evidenz:** C-060 hatte festgestellt, dass kein Schreibpfad einen
  Bestätigungsbezug erzeugt, und die Frage, wo einer entstehen soll,
  ausdrücklich als Produktentscheidung offen gelassen. Sie ist entschieden: Der
  Bezug entsteht bei der sichtbaren Prüfung eines Memorys, nicht im Save.
- **Gate:** M4 und Schemaentscheid für die persistenten Felder; die Regel selbst
  gilt sofort.
- **Datenquelle:** Review-Entscheidungen mit `confirmed_provenance_class` und
  `provenance_review_ref`.
- **Abnahmekriterium:** `user_asserted` entsteht ausschließlich über eine
  bestätigte Review. Kein Save-Pfad erzeugt die Klasse automatisch — auch nicht
  nach Einführung eines einheitlichen Mutation-Audits. Die vier
  Antwortmöglichkeiten der Oberfläche bilden `user_asserted`, `agent_observed`,
  bestätigtes `unknown_legacy` und `approved_rule` ab.
- **Rollback:** Ohne Oberfläche bleibt der Bestand auf den abgeleiteten Klassen
  stehen; das ist der heutige Zustand und kein Verlust. Eine erteilte
  Bestätigung ist jederzeit widerrufbar (Provenienz-Override-Vertrag, 6.3).
- **Korrigiert durch C-068 und C-069.** Die hier genannte Zuordnung der vier
  Antwortmöglichkeiten fasst Beobachtung, Ableitung und Vermutung zu
  `agent_observed` zusammen; verbindlich ist die progressive Auswahl aus 6.3.
  Zudem schränkt weder Importstatus noch `write_origin` die Reviewberechtigung
  ein — jedes Memory des Bestands ist bestätigungsfähig.

### C-064 – Eine Bestätigung gilt für genau ein Memory

- **Passage:** 6.3, Review-Vertrag um die drei Bindungseigenschaften erweitert;
  18.5 Gates; 24; 31 Vorbemerkung.
- **Art:** Product-Owner-Vorgabe, aufgenommen als Sicherheitsanforderung.
- **Evidenz:** Der Review-Vertrag verlangte bislang nur einen „auflösbaren
  Entscheidungs- und Auditbezug“. Damit war nicht ausgeschlossen, dass eine
  Zustimmung für Memory A auf Memory B wirkt oder eine Bestätigung eine spätere
  Umformulierung desselben Memorys überdauert. Beides würde die Schutzwirkung
  von `user_asserted` aushöhlen, ohne dass es jemandem auffiele.
- **Gate:** M4 und Schemaentscheid.
- **Datenquelle:** Bestätigungsbezüge und Inhaltsstände der bestätigten
  Memories.
- **Abnahmekriterium:** Jeder Bestätigungsbezug ist an Identität und
  Inhaltsstand genau eines Memorys gebunden, nicht wiederverwendbar und
  verfällt bei inhaltlicher Änderung; das betroffene Memory fällt dann auf die
  abgeleitete Klasse mit Review-Status `pending` zurück.
- **Rollback:** Additive Felder; ohne sie gilt der abgeleitete Zustand. Ein
  verfallener Bezug erzeugt keinen Schaden, sondern nur erneuten Prüfbedarf.
- **Operationalisiert durch C-070.** „Inhaltsstand“ ist hier nicht abgegrenzt;
  verbindlich ist die Bindung an `memory_id` und den Hash des im Review
  dargestellten aussagetragenden Inhalts, wobei Retrieval-, Darstellungs- und
  Betriebsmetadaten keinen Verfall auslösen.

### C-065 – Vollständige Bestandsprüfung in vier Prioritätsstufen

- **Passage:** 6.3, `not_scheduled` neu definiert, neuer Unterabschnitt „Der
  gesamte Bestand wird geprüft“ mit der Stufentabelle; 18.5 Gates; 22; 24; 25
  Punkt 6; 26.2; 31 Entscheidung 5.
- **Art:** Product-Owner-Entscheid.
- **Evidenz:** Die bisherige Fassung nahm `agent-session` und fehlendes
  `write_origin` von der Prüfung aus — mit der Begründung, eine Einzelfallprüfung
  ergäbe ohne neue Information nichts. Das war eine Annahme über den Nutzen, keine
  über die Machbarkeit, und sie ließ den größten Teil des Bestands dauerhaft
  ungeklärt. Der Entscheid kehrt das um.
- **Gate:** keines — die Prüfung ist read-only Sidecar-Arbeit im Sinne von C-018
  und an kein Messgate gebunden.
- **Datenquelle:** der Vault-Bestand selbst; für die Priorisierung der zweiten
  Stufe der vorhandene Usage-Sidecar mit `surfaced`, `loaded`, `acted_on` und
  Zeitstempeln (siehe C-071).
- **Abnahmekriterium:** Kein Memory bleibt dauerhaft ungeprüft. Am Ende trägt
  jedes entweder eine geklärte Klasse oder ein bestätigtes `unknown_legacy` mit
  Review-Status `confirmed`. `not_scheduled` erscheint ausschließlich als
  Warteschlangenposition und nie als Ergebnis.
- **Rollback:** Die Prüfung ändert keine Memory-Inhalte und lässt sich jederzeit
  unterbrechen; ein ungeprüftes Memory bleibt uneingeschränkt auffindbar und
  nutzbar.
- **Präzisiert durch C-071, korrigiert durch C-076, ausführbar gemacht durch
  C-078.** Die Datenquelle für Prüfstufe 2 ist der vorhandene Usage-Sidecar; es
  ist keine neue Telemetrie zu bauen, und fehlende Historie bedeutet `unknown`,
  nicht null. Sie macht ein Memory aber nicht automatisch zu Stufe 2 — dort
  entscheidet die Strukturwirkung nach dem vorab versionierten Kriterium aus
  6.3.

### C-066 – Abschnitt 31 wird zum Entscheidungsprotokoll

- **Passage:** 31 vollständig neu gefasst; 18.1 um die Registrierung des
  Erzeugungswegs erweitert; 18.3 um den Erzeugungsweg als vorab registrierten
  Faktor erweitert; 19.1 um den entschiedenen Benchmarktyp erweitert.
- **Art:** Product-Owner-Entscheid.
- **Evidenz:** Abschnitt 31 führte vier Entscheidungen als Vorlage mit dem
  ausdrücklichen Status „keine dieser vier Entscheidungen ist getroffen“. Alle
  vier sind entschieden, und die in C-060 offen gelassene Provenienzfrage tritt
  als fünfte hinzu; der Abschnitt beschreibt damit einen überholten Zustand.
  Zwei Entscheidungen ziehen inhaltliche Folgen nach sich, die nicht im Abschnitt
  selbst stehen können: die Wahl des Benchmarktyps gehört nach 19.1, und die
  Prüfung des Cue-Erzeugungswegs berührt das Versuchsdesign aus C-057.
- **Gate:** M0 legt die Registrierung des Erzeugungswegs fest und M2 wertet ihn
  aus; V1.x für den Benchmark; M3 für Deep Recall Stufe 2; M4 für den
  gemeinsamen Schemaentscheid.
- **Datenquelle:** je Entscheidung die in 31 benannte.
- **Abnahmekriterium:** Der Erzeugungsweg wird als eigener, vorab registrierter
  Faktor mit eigener Zellstruktur und eigenem Mindest-N geprüft und nicht
  ungeplant mit dem 2×2 der Cue-Achsen gekreuzt. Genau ein externer Benchmark
  wird adaptiert, und zwar ein handlungsorientierter, außerhalb des
  V1.0-Vertrags. Stufe 2 des Deep Recall wird erst nach der Stufe-1-Messung
  gebaut. Zeitachsen und Herkunft werden gemeinsam nach M4 migriert, die
  Herkunftsprüfung beginnt sofort read-only.
- **Rollback:** Eine Entscheidung wird nicht zurückgenommen, sondern durch eine
  neue mit eigener C-ID ersetzt. Der Protokollcharakter des Abschnitts bleibt
  erhalten.
- **Korrigiert durch C-072.** Die hier verlangte Registrierung eines „eigenen
  Faktors, aber keines zusätzlichen Arms“ beschreibt keine auswertbare
  Versuchsanlage. Verbindlich sind die beiden Anlagen aus 18.3.

### C-067 – Rückkehrregel für abgelehnte Vorschläge

- **Passage:** 14.4, Block „Keine Schleifen“ um die Hinreichend-Bedingung
  erweitert; 24; 31 Vorbemerkung.
- **Art:** Product-Owner-Vorgabe, aufgenommen als Qualitätsanforderung.
- **Evidenz:** C-062 knüpft die Wiedervorlage an einen geänderten strukturellen
  Fingerprint. Das ist notwendig, aber nicht hinreichend: Ein Vorschlag, der
  sich nur in einer Randgröße unterscheidet, hat einen anderen Fingerprint und
  wäre trotzdem für den Nutzer derselbe abgelehnte Vorschlag. Aus Produktsicht
  zählt nicht die Datenänderung, sondern ob der Vorschlag inhaltlich ein
  anderer und besserer ist.
- **Gate:** M4.
- **Datenquelle:** Ablehnungsprotokoll je Struktur; Vergleich von Vorschlag und
  Vorgänger.
- **Abnahmekriterium:** Derselbe abgelehnte Vorschlag kehrt nicht zurück. Ein
  inhaltlich anderer, verbesserter Vorschlag darf erscheinen. Ein geänderter
  Fingerprint allein genügt nicht; im Zweifel unterbleibt die Wiedervorlage.
- **Rollback:** Konservativer Fallback ist das Unterbleiben der Wiedervorlage —
  ein verpasster Vorschlag statt eines wiederkehrenden.
- **Operationalisiert durch C-073.** „Inhaltlich ein anderer“ ist hier keine
  prüfbare Größe; verbindlich sind der semantische Vorschlagshash und die fünf
  materiellen Größen aus 14.4.

---

*Ab hier Runde 7: der Gegenreview der Entscheidungsumsetzung.*

### C-068 – Beobachtung, Ableitung und Vermutung bleiben getrennt

- **Passage:** 6.3, Tabelle der Oberflächenauswahl auf eine progressive
  Hauptauswahl mit Rückfrage umgestellt und um die Antwort für importierte
  Inhalte ergänzt; 7.2 Begriffsklärung; 18.5 Gates; 24; 26.2; 31
  Entscheidung 5.
- **Art:** Ist-Korrektur.
- **Evidenz:** C-063 bildete die Antwort „Das hat der Agent beobachtet oder
  abgeleitet“ vollständig auf `agent_observed` ab. Die Klassentabelle in 6.3
  führt `agent_observed`, `derived` und `hypothesis` aber als drei verschiedene
  epistemische Zustände — ein beobachtetes Ereignis, eine Schlussfolgerung aus
  anderen Memories und eine Aussage ohne ausreichende Evidenz. Die Zusammenfassung
  hätte die Unterscheidung ausgerechnet an der einzigen Stelle eingeebnet, an der
  ein Mensch sie treffen kann; `derived` und `hypothesis` wären dauerhaft leere
  Klassen geblieben.
- **Gate:** M4 und Schemaentscheid für die persistenten Felder; die Regel gilt
  sofort für die Gestaltung der Prüfung.
- **Datenquelle:** Review-Entscheidungen mit `confirmed_provenance_class`.
- **Abnahmekriterium:** Die Oberfläche fragt bei der Auswahl „Vom Agenten oder
  System“ nach, ob direkt beobachtet, abgeleitet oder vermutet; die drei
  Antworten führen auf `agent_observed`, `derived` und `hypothesis`. Keine
  Zusammenfassung zu einer Klasse. Die Rückfrage ist weder vorbelegt noch
  überspringbar.
- **Rollback:** Ohne Rückfrage bleibt die Klasse `unknown_legacy` mit
  Review-Status `pending` — der Zustand vor der Prüfung. Eine falsche
  Vereinheitlichung wäre schlechter als keine Antwort.

### C-069 – Der gesamte Bestand ist review- und bestätigungsfähig

- **Passage:** 6.3, Ableitungssatz nach den Stufentabellen ersetzt, Review-Status
  aus der Stufe-2-Ableitung entfernt, Absatz zum Vorschlagswert im Abschnitt „Wo
  der Bestätigungsbezug entsteht“ ergänzt; 18.5 Gates; 24; Korrekturverweise an
  C-055 in 0.4 und 28.
- **Art:** Ist-Korrektur.
- **Evidenz:** Nach der Einarbeitung von C-063 blieb der Satz stehen, ein nicht
  importierter Save mit `write_origin: user-directed` sei „die einzige
  Konstellation, die überhaupt für eine spätere Bestätigung in Betracht kommt“.
  Das widerspricht C-065 unmittelbar: Wenn der gesamte Bestand geprüft wird,
  kann die Reviewberechtigung nicht von Importstatus oder `write_origin`
  abhängen. Die Formulierung hätte drei Viertel des Bestands faktisch von der
  Bestätigung ausgeschlossen und damit den Entscheid ausgehöhlt.
- **Gate:** M4 und Schemaentscheid; die Regel gilt sofort.
- **Datenquelle:** Review-Warteschlange über den gesamten Bestand.
- **Abnahmekriterium:** Kein Memory ist von der Review ausgeschlossen.
  Importstatus und `write_origin` bestimmen ausschließlich die abgeleitete
  Ausgangsklasse und den Vorschlagswert der Oberfläche; jede Antwort bleibt in
  jedem Fall wählbar, einschließlich „Ja, das stammt von mir“.
- **Rollback:** Keiner nötig — die Regel entfernt eine Einschränkung, die nie
  beabsichtigt war.
- **Verschärft durch C-077.** Der hier eingeführte Vorschlagswert durfte die
  Auswahl „vorbelegen“. Verbindlich ist die Fassung in 6.3: Der Vorschlag wird
  angezeigt und begründet, aber keine Antwort ist vorausgewählt; ein
  Weiter-Klick auf einen Default erzeugt kein `confirmed`.

### C-070 – Bestätigung an Memory-ID und Inhaltshash gebunden

- **Passage:** 6.3, die drei Bindungseigenschaften präzisiert und um die
  Abgrenzungstabelle erweitert; 18.5 Gates; 24.
- **Art:** Architekturentscheidung.
- **Evidenz:** C-064 band die Bestätigung an „Identität und Inhaltsstand“, ohne
  zu sagen, was zum Inhaltsstand zählt. Ohne diese Abgrenzung wäre die Regel in
  eine von zwei Richtungen unbrauchbar geworden: Zählt jedes Feld, erlischt jede
  Bestätigung binnen Stunden, weil bereits ein Recall-Treffer die
  Nutzungssignale bewegt. Zählt zu wenig, lässt sich eine fremde Aussage unter
  eine alte Zustimmung schieben.
- **Gate:** M4 und Schemaentscheid.
- **Datenquelle:** der im Review dargestellte Inhalt und dessen Hash.
- **Abnahmekriterium:** Der Bestätigungsbezug bindet an `memory_id` und einen
  Hash des im Review dargestellten aussagetragenden Inhalts — Titel, Summary,
  Body und die bestätigte Aussage. Tags, `topic_path`, `recall_when`,
  abgeleitete Cues, Ordner, Zeitstempel, Heat, Reach und Nutzungssignale zählen
  nicht dazu und lösen keinen Verfall aus. Eine Änderung des Bodys lässt die
  Bestätigung verfallen, auch bei gleichem Titel.
- **Rollback:** Additive Felder; ohne sie gilt die abgeleitete Klasse. Ein
  verfallener Bezug erzeugt Prüfbedarf, keinen Schaden.

### C-071 – Die Nutzungstelemetrie für Prüfstufe 2 existiert bereits

- **Passage:** 6.3, neuer Absatz „Datenquelle für Stufe 2“ nach der
  Stufentabelle samt historieunabhängigem Zweitkriterium; 24; C-065
  Datenquellenfeld.
- **Art:** Ist-Korrektur.
- **Evidenz:** Die Priorisierung der zweiten Prüfstufe nach Nutzungshäufigkeit
  war als offener Punkt geführt, weil eine Pro-Memory-Telemetrie zu fehlen
  schien. Sie existiert: Der Usage-Sidecar unter `.bastra/usage/` führt je
  Memory-ID `surfaced`, `loaded` und `acted_on` sowie die Zeitstempel des
  jeweils letzten Ereignisses; eine Heat- und eine Reichweitenberechnung stehen
  bereit, und der Sink ist im Daemon angeschlossen. Es ist keine neue Telemetrie
  zu bauen.
- **Gate:** keines — die Quelle ist vorhanden und wird gelesen, nicht
  geschaffen.
- **Datenquelle:** der Usage-Sidecar.
- **Abnahmekriterium:** Prüfstufe 2 benennt den Usage-Sidecar als Quelle. Ein
  Memory ohne Historie gilt als `unknown` und nicht als `0`; solche Memories
  werden gesondert geführt und nicht ans Ende der Stufe sortiert. Kein Dokument
  behauptet, für Stufe 2 sei neue Telemetrie erforderlich.
- **Rollback:** Fällt die Quelle aus, entscheidet für alle Memories das
  historieunabhängige Kriterium aus 6.3 — die Strukturwirkung nach dem vorab
  versionierten Maßstab aus C-078; fällt auch der Graph-Snapshot aus, fallen
  sie nach Stufe 4. Die Prüfung bleibt in beiden Fällen vollständig, nur ihre
  Priorisierung wird gröber.
- **Korrigiert durch C-076.** Fehlende Historie führt nicht automatisch nach
  Stufe 2, und Floor- oder Pin-Status taugen nicht als Zweitkriterium — Floors
  sind Stufe 1, und eine unabhängige Pin-Quelle existiert am HEAD nicht.
  Verbindlich ist die Stufenzuordnung aus 6.3.

### C-072 – Zwei zulässige Anlagen für den Cue-Erzeugungsversuch

- **Passage:** 18.1 Arbeits- und Gate-Liste; 18.3, Abschnitt zum Erzeugungsweg
  vollständig neu gefasst und Absatz „Konstante Umgebung“ auf die registrierte
  Anlage konditioniert; 24; 31 Entscheidung 1 Auflage.
- **Art:** Messproblem.
- **Evidenz:** C-066 führte den Erzeugungsweg als „eigenen, vorab registrierten
  Faktor“ und stellte zugleich fest, er sei „kein zusätzlicher Arm im 2×2“. Das
  ist keine Versuchsanlage, sondern deren Vermeidung: Ein Faktor, der weder
  gekreuzt noch getrennt gefahren wird, hat keine definierte Zellstruktur, und
  die Formulierung ließ offen, wie überhaupt ausgewertet werden soll.
- **Gate:** M0 registriert, M2 wertet aus.
- **Datenquelle:** dieselben Goldfälle wie der Cue-Versuch; bei Anlage A
  paarweise über beide Erzeugungswege.
- **Abnahmekriterium:** Vor dem Lauf ist registriert, welche der beiden Anlagen
  gefahren wird — gepaarter Vergleich bei festgehaltenen Cue-Achsen oder
  vollständig gekreuztes 2×2×2 mit eigenem, größerem Mindest-N je Zelle. Ein
  nachträgliches Hinzunehmen des Erzeugungswegs als zusätzlicher Arm ist
  unzulässig.
- **Rollback:** Der Versuch entfällt; die Entscheidung über den Erzeugungsweg
  bleibt vertagt, was dem heutigen Zustand entspricht.
- **Korrigiert durch C-074.** Anlage A hat zwei Bedingungen statt vier Zellen,
  verlangt eine Auswahl-/Holdout-Trennung oder eine registrierte verschachtelte
  Auswertung und erlaubt keine Interaktionsaussage. Verbindlich ist die Fassung
  in 18.3.

### C-073 – Wiedervorlage verlangt Inhaltsänderung, nicht nur Fingerprint

- **Passage:** 14.4, Block zur Rückkehrregel um Inhaltshash und die fünf
  materiellen Größen erweitert; 18.5 Gates.
- **Art:** Architekturentscheidung.
- **Evidenz:** C-067 legte fest, dass ein geänderter Fingerprint nicht genügt,
  ohne zu sagen, was zusätzlich gelten muss. „Inhaltlich ein anderer“ war
  damit selbst keine prüfbare Größe: Jede Implementierung hätte die Grenze
  woanders gezogen, und im Zweifel hätte der Fingerprint entschieden — also
  genau das, was C-067 ausschließen wollte.
- **Gate:** M4.
- **Datenquelle:** Ablehnungsprotokoll je Struktur mit strukturellem
  Fingerprint und semantischem Vorschlagshash.
- **Abnahmekriterium:** Eine Wiedervorlage setzt einen geänderten Fingerprint
  **und** einen geänderten semantischen Vorschlagshash **und** mindestens eine
  benannte materielle Änderung voraus — an Zielzustand, Quellversion, Kantenmenge,
  Reason-Code der Begründung auf Basis neuer Evidenz oder einem gelösten
  Schutzkonflikt. Bei unverändertem Inhaltshash
  bleibt der Vorschlag unterdrückt, unabhängig vom Fingerprint. Lässt sich keine
  der fünf Größen benennen, gilt der Vorschlag als derselbe.
- **Rollback:** Konservativer Fallback ist das Unterbleiben der Wiedervorlage.
- **Widerspruchsfrei gemacht durch C-075, kanonisiert durch C-079.** Der hier
  genannte „Hash des normalisierten Vorschlagsinhalts“ umfasste nur die
  Zustandsänderung, während Evidenz, Begründung und Schutzkonfliktauflösung als
  materielle Änderung galten — eine materielle Änderung hätte den Hash also
  unberührt lassen können. Verbindlich sind der Umfang und die kanonische Form
  aus 14.4: Reason-Code statt Prosa, semantische Inhaltsversion statt
  `updated`.

---

*Ab hier Runde 8: die abschließende Korrekturrunde.*

### C-074 – Anlage A hat zwei Bedingungen, nicht vier Zellen

- **Passage:** 18.3, Anlage A und B neu gefasst, Absatz „Statistische
  Ausführbarkeit“ um Anlage A ergänzt, Absatz „Konstante Umgebung“ auf
  Bedingungen statt Zellen umgestellt und im Geltungsbereich abgegrenzt; 18.1
  Arbeits- und Gate-Liste; 24; 31 Entscheidung 1 Auflage; Ledgerzeile C-072
  und Delta-Blöcke C-057 und C-072.
- **Art:** Messproblem.
- **Evidenz:** C-072 beschrieb Anlage A als Vergleich „bei festgehaltenen
  Cue-Achsen“ und ließ zugleich die Rede von vier Zellen stehen. Beides
  zusammen geht nicht: Sind die Achsen festgehalten, existiert das 2×2 nicht
  mehr, und es bleiben genau zwei Bedingungen — Agenten- gegen Batch-Cues.
  Zweitens fehlte jede Trennung zwischen der Auswahl der festzuhaltenden
  Konfiguration und dem anschließenden Vergleich; wird beides auf denselben
  Fällen gemacht, ist der Vergleich durch die Auswahl kontaminiert. Drittens
  legte die Formulierung nahe, auch Anlage A könne etwas über Wechselwirkungen
  aussagen — das kann nur ein gekreuztes Design.
- **Gate:** M0 registriert, M2 wertet aus.
- **Datenquelle:** getrennter Auswahlteil und unabhängiger Holdout
  beziehungsweise ein vorab registriertes verschachteltes Auswertungsschema.
- **Abnahmekriterium:** Anlage A wird als Zwei-Bedingungen-Vergleich geführt,
  mit vorab registrierter Auswahl-/Holdout-Trennung oder Verschachtelung. Ihr
  Ergebnis gilt nur für die festgehaltene Konfiguration; eine Interaktionsaussage
  wird nicht behauptet. Nur Anlage B führt acht Zellen und darf Interaktionen
  auswerten.
- **Rollback:** Ohne registrierte Anlage findet der Versuch nicht statt; die
  Entscheidung über den Erzeugungsweg bleibt vertagt.

### C-075 – Der semantische Vorschlagshash umfasst auch Evidenz und Begründung

- **Passage:** 14.4, Hashdefinition um sechs Bestandteile erweitert und
  Ausschluss reiner Zeit-, Cache-, Telemetrie- und Projektionsänderungen
  ergänzt; 18.5 Gates; C-073 Datenquelle und Abnahmekriterium.
- **Art:** Architekturentscheidung.
- **Evidenz:** C-073 definierte den Hash als „Hash des normalisierten
  Vorschlagsinhalts — also der vorgeschlagenen Zustandsänderung selbst, nicht
  ihres Umfelds“ und zählte zugleich Begründung auf Basis neuer Evidenz und
  gelösten Schutzkonflikt zu den materiellen Änderungen. Das ist in sich
  widersprüchlich: Eine materielle Änderung an der Begründung hätte den Hash
  unberührt gelassen, womit Bedingung 2 und Bedingung 3 einander ausschlössen —
  eine Wiedervorlage wäre für zwei der fünf Größen unmöglich gewesen.
- **Gate:** M4.
- **Datenquelle:** Ablehnungsprotokoll je Struktur mit Fingerprint und
  semantischem Vorschlagshash.
- **Abnahmekriterium:** Der semantische Vorschlagshash umfasst mindestens
  Operatortyp, normalisierte Zieländerung, Quell-IDs und -Versionen, betroffene
  Kanten, Evidenz- und Begründungsstand sowie die Schutzkonfliktauflösung; die
  kanonische Form regelt C-079. Eine
  Wiedervorlage verlangt geänderten Fingerprint, geänderten Hash und eine
  benannte materielle Änderung. Reine Zeit-, Cache-, Telemetrie- und
  Projektionsänderungen bewegen weder Fingerprint noch Hash.
- **Rollback:** Konservativer Fallback bleibt das Unterbleiben der
  Wiedervorlage.
- **Kanonisiert durch C-079.** Dieser Eintrag benennt die Bestandteile des
  Hashes, aber nicht ihre Form. Verbindlich ist die kanonische Struktur aus
  14.4: Reason-Code statt Prosa, semantische Inhaltsversion statt `updated`,
  sortierte Mengen und eine Hash-Schema-Version.

### C-076 – `unknown` führt nicht automatisch nach Stufe 2

- **Passage:** 6.3, Stufentabelle auf Mitgliedschaftskriterien umgestellt und um
  die Vollständigkeitsaussage ergänzt, Absatz zur fehlenden Historie neu
  gefasst; 24; C-071 Rollback und Korrekturverweis; Ledgerzeilen C-065 und
  C-071.
- **Art:** Ist-Korrektur.
- **Evidenz:** C-071 zog alle historieunbekannten Memories nach Stufe 2 und
  bot als Zweitkriterium „Floor- oder Pin-Status und Verlinkungsgrad“ an.
  Beides ist unhaltbar. Fehlende Historie ist keine Aussage über Nutzung — sie
  rechtfertigt keine Höherstufung, sondern nur eine andere Zuordnungsregel.
  Floors sind bereits über Stufe 1 erfasst, ihre Wiederverwendung in Stufe 2
  wäre eine Doppelzuordnung. Und eine vom Floor unabhängige Pin-Quelle
  existiert am HEAD nicht: Der Curator-Eingang setzt `pinned` hart auf `false`
  (`packages/daemon/src/curator-run.ts:108`), und im Session-Hook ist „pinned“
  nur der Anzeigename des Floor-Blocks
  (`packages/daemon/src/session-hook.ts:36` und `:174`).
- **Gate:** keines — die Zuordnung ist read-only Sidecar-Arbeit.
- **Datenquelle:** Usage-Sidecar für die belegte Nutzung; Graphstruktur für die
  Strukturwirkung.
- **Abnahmekriterium:** Stufe 2 umfasst Memories mit belegter hoher Nutzung
  sowie historieunbekannte Memories mit nachweislich hoher Strukturwirkung —
  hoher Verlinkungsgrad oder clusterübergreifende Verbindungsstellung.
  Importierte Memories bleiben
  Stufe 3, der übrige unbekannte Bestand Stufe 4. Kein Kriterium greift auf
  Floor- oder Pin-Status zurück. Die vier Stufen sind vollständig und
  überschneidungsfrei, und ihre Kriterien sind von der Reihenfolge innerhalb
  einer Stufe unterschieden.
- **Rollback:** Fällt die Strukturauswertung aus, fallen historieunbekannte
  Memories nach Stufe 4; die Prüfung bleibt vollständig.
- **Ausführbar gemacht durch C-078, semantisch präzisiert durch C-080.**
  „Nachweislich hohe Strukturwirkung“ war hier nicht definiert und lag damit im
  Ermessen der Implementierung. Verbindlich ist das vorab versionierte
  Kriterium aus 6.3; „Verbindungsstellung“ bezeichnet dort ausschließlich
  clusterübergreifende Nachbarschaft.

### C-077 – Keine vorbelegte Provenienzantwort

- **Passage:** 6.3, Absatz zum Systemvorschlag neu gefasst, Hinweis auf eine
  vorbelegte Rückfrage entfernt; 18.5 Gates; 24; 31 Entscheidung 5;
  Korrekturverweise an C-068 und C-069 sowie Ledgerzeile C-069.
- **Art:** Product-Owner-Vorgabe.
- **Evidenz:** C-069 erlaubte, die abgeleitete Ausgangsklasse als
  Vorschlagswert „vorzubelegen“. Eine vorbelegte Auswahl macht den
  Bestätigungsklick zum Wegklicken einer Systemvermutung — und hebt damit genau
  die Eigenschaft auf, um derentwillen die Attestierung nach C-063 überhaupt an
  einen Nutzerakt gebunden wurde. Ein Default, den man bestätigt, belegt keine
  Urheberschaft.
- **Gate:** M4; die Regel gilt sofort für die Gestaltung der Prüfung.
- **Datenquelle:** Review-Protokoll mit der Unterscheidung zwischen aktiver
  Auswahl und bloßem Weiter-Klick.
- **Abnahmekriterium:** Keine Antwort ist beim Öffnen der Prüfung markiert.
  `confirmed` entsteht nur nach aktiver Auswahl; ein Weiter- oder
  Bestätigen-Klick ohne vorherige Auswahl erzeugt keinen Bestätigungsbezug. Die
  progressive Rückfrage bleibt verpflichtend und ist ebenfalls nicht vorbelegt.
  Der Systemvorschlag darf angezeigt und begründet werden.
- **Rollback:** Ohne Auswahl bleibt der Review-Status `pending` — der Zustand
  vor der Prüfung. Eine unbeantwortete Prüfung ist besser als eine
  scheinbeantwortete.

---

*Ab hier Runde 9: der finale Delta-Fix.*

### C-078 – Das Strukturkriterium wird vorab versioniert festgelegt

- **Passage:** 6.3, Stufentabelle Zeile 2 präzisiert, neuer Unterabschnitt „Das
  Strukturkriterium wird vorab festgelegt“ samt Auswertungsreihenfolge
  1 → 3 → 2 → 4; 18.5 Gates; 24; Ledgerzeilen C-076 und C-078;
  Korrekturverweise an den Delta-Einträgen C-065, C-071 und C-076.
- **Art:** Messproblem.
- **Evidenz:** C-076 verlegte die Grenze zwischen Prüfstufe 2 und 4 auf
  „nachweislich hohe Strukturwirkung“, ohne zu sagen, was das heißt. Damit lag
  die Grenze im Ermessen der Implementierung: Zwei Läufe über denselben Bestand
  hätten verschiedene Warteschlangen erzeugt, und ein während des Laufs
  nachjustierter Schwellenwert hätte eine Reihenfolge produziert, die niemand
  rekonstruieren kann. Die beiden zulässigen Bestandteile sind bereits
  vorhanden: Die Graph-Projektion führt je Knoten die Kantenzahl und markiert
  einen Knoten im Feld `bridge`, sobald er Nachbarn in mindestens zwei
  unterschiedlichen fremden Clustern besitzt.
- **Gate:** keines — die Zuordnung ist read-only Sidecar-Arbeit im Sinne von
  C-018. Die Nachweispflicht liegt beim Queue-Manifest.
- **Datenquelle:** ein eingefrorener Graph-Snapshot; die read-only
  Bestandsverteilung für die Herleitung des Startwerts.
- **Abnahmekriterium:** Das Kriterium liegt vor dem Aufbau der Warteschlange
  versioniert im Queue- beziehungsweise Run-Manifest vor und besteht
  ausschließlich aus clusterübergreifender Verbindungsstellung und
  Grad-Schwellenwert oder Grad-Quantil. Der numerische Wert steht vor der Zuordnung fest und wandert
  während des Laufs nicht. Jedes historieunbekannte Memory außerhalb der
  Stufen 1 und 3 ist dadurch deterministisch genau Stufe 2 oder Stufe 4
  zugeordnet; die Auswertung läuft in der Reihenfolge 1 → 3 → 2 → 4. Fehlt oder
  bricht der Snapshot, fällt das Memory nach Stufe 4.
- **Rollback:** Ohne Snapshot fällt der gesamte historieunbekannte Bestand nach
  Stufe 4; die Prüfung bleibt vollständig, nur ihre Priorisierung wird gröber.
- **Semantisch präzisiert durch C-080, belegpflichtig gemacht durch C-081.**
  Die hier genannte Brückeneigenschaft ist clusterübergreifende Nachbarschaft
  und kein Nachweis einer Trennwirkung. „Eingefroren“ verlangt zusätzlich den
  Nachweis im Queue- beziehungsweise Run-Artefakt; ein Zeitstempel allein
  genügt nicht.

### C-079 – Der semantische Vorschlagshash wird kanonisch gebildet

- **Passage:** 14.4, Hashdefinition durch die kanonische Struktur ersetzt,
  materielle Größe „Begründung“ auf den Reason-Code umgestellt,
  Ausschlussliste um Umformulierungen erweitert; 18.5 Gates; 24; C-075
  Abnahmekriterium; Ledgerzeile C-075.
- **Art:** Architekturentscheidung.
- **Evidenz:** C-075 zählte auf, **was** in den Hash gehört, aber nicht, **in
  welcher Form**. „Evidenz- und Begründungsstand“ ließ offen, ob die Begründung
  als Prosa eingeht — dann hätte eine bloße Umformulierung den Hash bewegt und
  eine Wiedervorlage ermöglicht, also genau die Schleife erzeugt, gegen die
  C-067 und C-073 angetreten sind. Ebenso offen war, ob „Quellversion“ das Feld
  `updated` meint; da ein Save ohne inhaltliche Änderung `updated` bewegt, hätte
  auch das eine Wiedervorlage ausgelöst.
- **Gate:** M4.
- **Datenquelle:** die kanonische Struktur selbst, versioniert über die
  Hash-Schema-Version; das separate Begründungsprotokoll.
- **Abnahmekriterium:** Der Hash wird aus einer versionierten kanonischen
  Struktur gebildet, die Operator-Enum, normalisierten Zielzustands-Diff,
  sortierte Quell-IDs mit semantischen Inhaltsversionen, sortierte
  Kanten-Tupel, sortierte Evidenzreferenzen, Reason-Code, strukturierten
  Schutzkonfliktstatus samt Auflösung und die Schema-Version umfasst. Er
  enthält keinen freien Erklärungstext. Die menschenlesbare Begründung wird
  separat protokolliert und bewegt den Hash nicht. Eine Umformulierung, ein
  Zeitstempel-Update oder eine Metadatenänderung ermöglicht keine
  Wiedervorlage.
- **Rollback:** Konservativer Fallback bleibt das Unterbleiben der
  Wiedervorlage. Eine Änderung der Hash-Schema-Version invalidiert bestehende
  Ablehnungsprotokolle nicht, sondern führt sie unter ihrer alten Version
  weiter.
- **Ergänzt durch C-081.** Der Reason-Code setzt ein endliches, versioniertes
  Vokabular voraus. Ein Code außerhalb der geltenden Vokabularversion löst
  keine Wiedervorlage aus, bis das Vokabular erweitert wurde.

---

*Ab hier Runde 10: der abschließende Delta-Fix.*

### C-080 – `bridge` belegt clusterübergreifende Nachbarschaft, keine Trennwirkung

- **Passage:** 6.3, Bestandteil des Strukturkriteriums neu gefasst und um den
  Abgrenzungsabsatz „Was das Feld `bridge` belegt — und was nicht“ erweitert,
  Stufe-3-Vorrangsatz und historieunabhängiges Kriterium nachgezogen; 18.5
  Gates; 24; 32 Ist-Claims; Ledgerzeile C-078; Korrekturverweise an den
  Delta-Einträgen C-076 und C-078.
- **Art:** Ist-Korrektur.
- **Evidenz:** C-078 nahm die Brückeneigenschaft mit der Lesart „verbindet
  mindestens zwei sonst getrennte Cluster“ in das Strukturkriterium auf. Der
  Code trägt das nicht: `bridgeFor` sammelt die Cluster der Nachbarn eines
  Knotens, entfernt den eigenen und liefert die Restliste, sobald zwei
  verschiedene fremde Cluster übrig bleiben
  (`packages/core/src/graph.ts:302`–`:305`). Ob diese Cluster **ohne** den
  Knoten unverbunden wären, wird nie geprüft — dafür müsste der Zusammenhang
  des Graphen ohne ihn berechnet werden. Ein Knoten, dessen fremde Cluster über
  ein Dutzend andere Wege verbunden sind, trägt damit dasselbe Feld wie ein
  echter Artikulationsknoten. Das Feld ist ein brauchbares Strukturmerkmal,
  aber nicht das, was sein Name nahelegt.
- **Gate:** keines — reine Semantikkorrektur an einer read-only Auswertung; das
  Kriterium selbst bleibt unverändert.
- **Datenquelle:** die Graph-Projektion selbst. `bridge` ist die sortierte
  Liste der fremden Nachbarcluster, kein Trennungsnachweis.
- **Abnahmekriterium:** Kein Dokument und kein Manifest behauptet, `bridge`
  belege eine graphentheoretische Brücke oder einen Artikulationsknoten. Wo die
  Eigenschaft in das Strukturkriterium eingeht, ist sie als
  **clusterübergreifende Nachbarschaft** benannt — Nachbarn in mindestens zwei
  unterschiedlichen fremden Clustern. Eine echte Artikulations- oder
  Brückenanalyse ist ausdrücklich als zusätzliche, heute nicht geleistete
  Grapharbeit gekennzeichnet.
- **Rollback:** Keiner nötig — die Korrektur nimmt eine Behauptung zurück, ohne
  das Kriterium zu verändern. Fiele die Eigenschaft ganz weg, bliebe der
  Grad-Schwellenwert als alleiniger Bestandteil; die Zuordnung würde gröber,
  aber nicht falsch.

### C-081 – Der eingefrorene Snapshot wird im Artefakt belegt

- **Passage:** 6.3, neuer Unterabschnitt „Der Snapshot muss die damalige
  Zuordnung belegen“; 14.4, Absatz „Unbekannter Reason-Code“; 18.5 Gates; 24;
  Ledgerzeilen C-078 und C-079; Korrekturverweise an den Delta-Einträgen C-078
  und C-079.
- **Art:** Architekturentscheidung.
- **Evidenz:** C-078 verlangte einen „eingefrorenen Graph-Snapshot“, ohne zu
  sagen, woran das Einfrieren erkennbar ist. Ein Zeitstempel sagt, **wann**
  gerechnet wurde, nicht **worauf**; der Live-Graph bewegt sich mit jedem Save,
  jeder neuen Verlinkung und jeder Clusterneuberechnung. Eine Zuordnung, die
  nur auf einen Zeitpunkt verweist, ist Wochen später nicht mehr nachrechenbar
  — wer es versucht, rechnet auf einem anderen Graphen und erhält ein anderes
  Ergebnis. Zweitens ließ C-078 offen, was ein Neustart mitten im Lauf tut;
  ohne Regel hätte jeder Neustart eine andere Warteschlange erzeugt und den
  Fortschritt unvergleichbar gemacht. Drittens setzt C-079 einen Reason-Code
  aus einem festen Vokabular voraus, ohne den Fall zu regeln, dass ein Code
  darin fehlt.
- **Gate:** keines. Zuordnung und Nachweisartefakt sind jederzeit zulässige
  Sidecar-/Run-Artefakte nach C-018 und C-025. Kann das Artefakt nicht
  geschrieben werden, startet der Lauf nicht.
- **Datenquelle:** das Queue- beziehungsweise Run-Artefakt; alternativ der
  content-addressed persistierte Snapshot samt Referenz aus dem Manifest.
- **Abnahmekriterium:** Das Artefakt speichert mindestens Graph- und
  Projektionsschema samt Version, den Snapshot-Hash, den Erstellungszeitpunkt,
  das angewandte Strukturkriterium samt absolutem Schwellenwert oder Quantil
  sowie je zugeordnetem historieunbekannten Memory dessen ID, `degree`, fremde
  Cluster beziehungsweise `bridge`-Wert und die resultierende Prüfstufe;
  zulässige Alternative ist der vollständige, content-addressed persistierte
  Snapshot mit Referenz. In beiden Varianten ist die damalige Zuordnung ohne
  den später veränderten Live-Graphen nachvollziehbar. Während eines laufenden
  Reviews findet weder eine Neuberechnung noch eine Neuzuordnung statt, und ein
  Neustart setzt dieselbe Warteschlange mit denselben Zuordnungen fort. Ein
  Reason-Code außerhalb der geltenden Vokabularversion löst keine Wiedervorlage
  aus.
- **Rollback:** Die Nachweispflicht ist additiv und ändert die Zuordnungsregel
  nicht. Lässt sich das Artefakt nicht schreiben, wird der Lauf nicht gestartet
  — eine nicht belegbare Warteschlange ist schlechter als keine. Für den
  Reason-Code bleibt der konservative Fallback das Unterbleiben der
  Wiedervorlage.
- **Gate korrigiert durch C-082.** Die ursprüngliche Fassung stellte die
  persistente Gestalt des Artefakts unter den Schemaentscheid nach M4. Das war
  falsch: Das Artefakt berührt kein Memory-Frontmatter und kein Vault-Schema.
  Verbindlich ist der oben stehende Gate-Text.

---

*Ab hier Runde 11: der Ein-Satz-Delta-Fix.*

### C-082 – Das Nachweisartefakt hängt an keinem Messgate

- **Passage:** 6.3, Absatz zur Sidecar-Lage des Artefakts um die Sofortzulässigkeit
  und die 21.4-Abgrenzung erweitert; 18.5 Schlussbemerkung zur Gate-Zugehörigkeit;
  Ledgerzeile C-081; Gate und Korrekturverweis im Delta-Eintrag C-081; 32.
- **Art:** Ist-Korrektur.
- **Evidenz:** Der C-081-Block hielt fest, die Zuordnung bleibe read-only
  Sidecar-Arbeit im Sinne von C-018, stellte aber im selben Atemzug die
  „persistente Gestalt des Artefakts“ unter den Schemaentscheid nach M4. Beides
  zusammen ist widersprüchlich: Die Nachweispflicht soll sofort gelten — ohne
  Artefakt startet der Lauf nach derselben Regel gar nicht —, während M4 erst
  nach mehreren Messstufen fällt. In der Lesart des Gates hätte die
  Bestandsprüfung bis M4 überhaupt nicht laufen dürfen, obwohl C-065 sie
  ausdrücklich an kein Gate bindet und C-066 sie „sofort read-only“ beginnen
  lässt. Der Widerspruch beruht auf einer Verwechslung: Das Artefakt ist ein
  operationales Run-Artefakt in der Sidecar-Projektion, kein persistentes
  Schemafeld. Es verändert weder Memory-Inhalt noch Vault-Schema; private
  Run-Artefakte sind nach C-025 ohnehin vorgesehen.
- **Gate:** keines. Zuordnung und Nachweisartefakt sind jederzeit zulässige
  Sidecar-/Run-Artefakte nach C-018 und C-025. Kann das Artefakt nicht
  geschrieben werden, startet der Lauf nicht.
- **Datenquelle:** das Artefakt selbst; die Abgrenzung zwischen Sidecar-
  Projektion und persistentem Memory-Schema aus 21.4.
- **Abnahmekriterium:** Kein Gate-Verweis bindet das Queue- beziehungsweise
  Run-Artefakt, den Graph-Snapshot oder die Stufenzuordnung an M4 oder an den
  Schemaentscheid aus 21.4. Sie dürfen sofort persistiert werden. 21.4 greift
  ausschließlich dann, wenn Snapshot-, Queue- oder Reviewfelder in das
  Memory-Frontmatter beziehungsweise in das persistente Memory-Schema
  übernommen werden sollen.
- **Rollback:** Keiner nötig — die Korrektur entfernt eine Gate-Bindung, die nie
  beabsichtigt war und keine Schutzwirkung hatte. Die Nachweispflicht aus C-081
  bleibt unverändert bestehen.

---

*Ab hier die Vertragsänderung vom 29.08.2026. Sie ist keine Reviewrunde: kein
Urteil wird umgedeutet, geändert wird der Umfang des Releasevertrags.*

### C-083 – Das Präsentationsexperiment liefert in V1.0 die Anlage, nicht den besetzten Lauf

- **Passage:** 26.1 Experimentpunkt neu gefasst, ersetzte Fassung als solche
  kenntlich; 26.2 um den hinreichend besetzten Lauf ergänzt; 17.4
  Releasezuordnung; Ledgerzeile C-024 mit Änderungsverweis, neue Ledgerzeile
  C-083; 0.4 Abnahmeblock und nächste freie ID; 28 Überschrift, Zuordnung und
  dieser Eintrag; 33.
- **Art:** Vertragsänderung.
- **Evidenz:** Die Registrierung des Experiments
  (`packages/eval/registrations/presentation-experiment.json`, #267) hat die
  Fallzahl gemessen statt geschätzt. Über 14 Tage auf dem Ein-Nutzer-Vault:
  3876 Hook-Recall-Ereignisse, aber nur 80 unterscheidbare Sessions, davon 16
  mit überhaupt einem geladenen Ereignis. Die Versuchseinheit ist nach 17.4 die
  Session — die armstabile Zuweisung clustert alle Ereignisse einer Sitzung —,
  weshalb die Gegenrechnung über Ausspielungen nicht gilt. Bei zwei Bedingungen
  ergeben sich 18 Tage für 50, 35 Tage für 100 und 88 Tage für 50
  ergebnistragende Sessions je Arm; bei Basisraten um 1 % trägt keine dieser
  Besetzungen eine Aussage. Der strukturelle Grund steht über der Rechnung:
  17.4 setzt eine Population voraus, dieser Vault hat einen Nutzer. Hinzu
  kommen drei Voraussetzungen, die keine Fallzahlfrage sind — Arm A hat keinen
  zweiten Hook-Wortlaut (`band-wording.ts` führt genau eine Fassung je Fall),
  Arm B verlangt ein je Session schaltbares Gate und muss die
  Shadow-Acceptance abwarten, weil halbscharfe Sessions genau die Beobachtung
  verunreinigen würden, aus der die Freigabe folgt, und die nach 17.4 bindende
  Query-Klassen-Dimension wird heute nicht erhoben.
- **Gate:** keines. Die Änderung entfernt eine Anforderung aus dem
  V1.0-Vertrag und fügt keine Live-Wirkung hinzu. Registrierung, Zuweisung und
  Statusbericht sind nach C-018 jederzeit zulässige Mess- und Sidecar-Arbeit.
- **Datenquelle:** die Registrierung selbst samt ihrem `underpowered_fallback`;
  die Ereignisprotokolle unter `~/.bastra/logs/events-*.jsonl` für das Fenster
  15.–28.08.2026; die Zuweisungsfunktion `assignArm` in
  `packages/daemon/src/telemetry-dimensions.ts`.
- **Abnahmekriterium:** V1.0 gilt in diesem Punkt als erfüllt, wenn die Anlage
  vor jedem Lauf registriert ist, die Armzuweisung deterministisch und
  session-stabil erfolgt und die Auswertung einen Arm unterhalb seines
  Mindest-N als nicht auswertbar ausweist — mit ausgewiesener Begründung und
  ohne Nullbefund. Kein Bericht darf aus einem unterbesetzten Arm ein „kein
  Unterschied gefunden“ machen. Für V2.0 gilt der Punkt aus 26.2.
- **Rollback:** Die Änderung ist rein vertraglich und ohne Codewirkung; sie
  lässt sich durch Rückgängigmachen dieser Passagen aufheben. Fällt der Grund
  weg — eine Mehrnutzer-Population entsteht, oder die Versuchseinheit wird
  bewusst geändert —, wandert die Anforderung nach einem neuen Eintrag zurück
  in 26.1. Eine Änderung der Versuchseinheit wäre selbst eine Änderung an 17.4
  und keine Konfiguration.

---

*Ab hier die Vertragsergänzung vom 29.08.2026.*

### C-084 – Die Frontmatter-Zusicherung ab V1.0

- **Passage:** 26.1 neuer Zusicherungsblock; 22 um sechs Spiegelstriche
  ergänzt; Ledgerzeile C-084; 0.4 Abnahmeblock und nächste freie ID; 28
  Überschrift, Zuordnung und dieser Eintrag; 34. Außerhalb dieser Datei:
  `docs/memory-schema.md`, Abschnitt „Compatibility Promise (1.0)“.
- **Art:** Vertragsergänzung.
- **Evidenz:** Mit 1.0.0 entfällt das SemVer-Beta-Signal der führenden `0.`;
  ab dann verlangt jede Breaking-Änderung am Vault-Format einen Major-Bump.
  Was das Format zusichert, stand bis dahin in keinem Dokument — weder in 26.1
  noch in 22 noch in `docs/memory-schema.md`. Der Inhalt der Zusage ist am Code
  belegt: die zehn Pflichtfelder in `packages/core/src/schema.ts`, die
  Reparatur- und Rettungslogik in `packages/core/src/frontmatter-rescue.ts`,
  das Verwerfen ungültiger optionaler Felder und das Kappen überlanger
  `summary`-Werte im Parser, und die feste Feldliste des Overwrite-Pfads in
  `packages/core/src/save.ts`. Aus derselben Prüfung stammt eine Klarstellung
  zu diesem Abschnitt: `provenance_class`, `unknown_legacy` und
  `imported_unverified` existieren im V1-Schema nicht; 22 las sich bislang, als
  wären sie Bestand.
- **Gate:** keines. Die Ergänzung dokumentiert bestehendes Verhalten und ändert
  weder Code noch Schema.
- **Datenquelle:** der Code selbst; `docs/memory-schema.md` als
  Nutzerdokumentation derselben Zusage.
- **Abnahmekriterium:** Die drei Fassungen — 26.1, 22 und
  `docs/memory-schema.md` — sagen dasselbe, und keine von ihnen verspricht
  etwas, das der Code nicht hält. Insbesondere: kein Versprechen, dass niemals
  ein Formatversionsfeld eingeführt wird, sondern nur, dass ein 1.x-Reader
  keines verlangt; keine Zusage über die Erhaltung unbekannter Schlüssel über
  einen `overwrite` hinweg; und keine Behauptung, die `recall`-Ausgabeform sei
  ungebunden — sie fällt unter den eigenen API-Vertrag.
- **Rollback:** Rein dokumentarisch und ohne Codewirkung. Sollte sich die
  Ladetoleranz als Angriffsfläche erweisen, greift die eng gefasste
  Sicherheitsausnahme aus 26.1 — vier Bedingungen, darunter ein sichtbarer
  Fehler statt stillem Verwerfen; sie ersetzt keinen Major-Bump für alles
  Übrige.

---

*Ab hier die Vertragsergänzung C-085 vom 29.08.2026.*

### C-085 – Die Entscheidungs-Route der Shadow-Abnahme verlangt Streuung

- **Passage:** 18.2 Shadow-Abnahme um die Streuungsbedingung und die
  Zähl-Lesart erweitert; Ledgerzeile C-022 mit Ergänzungsverweis, neue
  Ledgerzeile C-085; 0.4 Abnahmeblock und nächste freie ID; 28 Überschrift,
  Zuordnung und dieser Eintrag; 35.
- **Art:** Vertragsergänzung.
- **Evidenz:** Die Schwelle aus C-022 nennt eine Menge und keine Verteilung.
  Im realen Bestand über 91 Logtage tragen die
  `evidence_decision`-Ereignisse 2052 Memory-Entscheidungen — davon **2040 aus
  einer einzigen Session**, die drei übrigen Sessions steuern zusammen zwölf
  bei. Die 500er-Schwelle wäre damit viermal erfüllt, ohne dass je eine zweite
  Arbeitssituation beobachtet worden wäre. Das widerspricht dem in 18.2
  festgehaltenen Zweck des Shadow-Betriebs, das Prädikat gegen die Verteilung
  echter Nutzung zu beobachten: Eine Sitzung trägt einen Vault-Zustand, ein
  Projekt, eine Arbeitsweise und einen Tagesrhythmus. Zur Kalibrierung der
  Zahl: Im selben 14-Tage-Fenster tragen 132 verschiedene Sessions
  `hook_call`-Ereignisse, im Tagesmittel etwa neun und an einzelnen Tagen bis
  27. Zwanzig verschiedene Sessions sind auf dieser Nutzung also erreichbar,
  ohne dass ein einzelner Arbeitstag sie zuverlässig allein liefert — und die
  Anteilsgrenze fängt den beobachteten Fall ab, dass zwar viele Sessions
  zählen, eine davon aber praktisch alles beiträgt.
- **Gate:** keines. Die Ergänzung verschärft eine Abnahmebedingung und schaltet
  nichts live; sie kann sofort gelten.
- **Datenquelle:** die Ereignisprotokolle unter `~/.bastra/logs/events-*.jsonl`
  (`kind: "evidence_decision"`, Feld `session_id`); die Auswertung in
  `packages/daemon/scripts/stats.ts`.
- **Abnahmekriterium:** Die Entscheidungs-Route gilt als erfüllt, wenn die
  zählenden Entscheidungen aus mindestens 20 verschiedenen Sessions stammen und
  keine einzelne Session mehr als 25 % von ihnen stellt. Die 14-Tage-Route
  bleibt ohne zusätzliche Bedingung. Gezählt wird pro Memory-Entscheidung, nicht
  pro Hook-Aufruf; eine Session zählt, sobald sie eine zählende Entscheidung
  trägt.
- **Rollback:** Rein vertraglich, ohne Codewirkung. Erweist sich die
  Sessionzahl auf einer größeren Population als zu niedrig oder die
  Anteilsgrenze als zu streng, werden beide nach dem M0-Baseline-Run mit den
  übrigen numerischen Größen versioniert nachgezogen; bis dahin gelten die hier
  festgeschriebenen Werte. Wer die schnellere Route nicht erreicht, verliert
  nichts — die 14-Tage-Route bleibt offen.

---

*Ab hier die Präzisierung C-086 vom 29.08.2026.*

### C-086 – Beide Wege zu `required` werden enger gefasst

- **Passage:** 10.3 um die präzisierten Required-Bedingungen, die Messgrundlage
  und die Vorbehalte erweitert, ersetzte Lesarten kenntlich; Ledgerzeile C-002
  mit Präzisierungsverweis, neue Ledgerzeile C-086; 0.4 Abnahmeblock und
  nächste freie ID; 28 Überschrift, Zuordnung und dieser Eintrag; 36.
- **Art:** Präzisierung.
- **Evidenz:** Beide Wege zu `required` waren in der Begründungsqualität zu
  weit, nicht in der Trefferqualität. Die Zwei-von-drei-Zählung wertete jede
  Trigger-Abdeckung über null als eines der beiden nötigen Signale — ein
  einzelner zufällig geteilter Term genügte. Der harte Identifier-Anker suchte
  zusätzlich im Body; ein Bezeichner in einem Codeblock oder einer Dateiliste
  begründete damit allein eine Pflicht, obwohl ein Fund in Prosa nur belegt,
  dass das Memory das Thema erwähnt, und nicht, dass es zuständig ist. 10.2
  trennt autorisierten Abruftext von Inhalt bereits; das Prädikat tat es nicht.
  Beide Verengungen wurden **vor** der Änderung beziffert (Läufe
  `2026-08-29-0e1dd5659433` und `2026-08-29-f5d803104893`, zehn Gold-Dateien,
  679 Fälle, sechs Varianten auf demselben servierten Pool, damit ein
  Unterschied zwischen zwei Zeilen die Regel ist und nichts sonst): Das
  Anti-Query-Gate fällt von 0,5000 auf 0,1250, während Recall@3 gegated
  (0,4743 gegen 0,4777 ungegated), Recall@3 auf Identifier-Queries (0,7429) und
  die Falsch-Abstention (0,0000) in allen sechs Varianten identisch bleiben.
  Die Abdeckungsschwelle wirkt längenneutral (58–65 % Pflichtrückgang über alle
  Query-Längen), die geprüfte Alternative „mindestens zwei getroffene Terme"
  dagegen nicht: Sie greift bei elf und mehr Termen nur mit 12 % Rückgang,
  also genau dort am schwächsten, wo ein einzelner geteilter Term die
  schwächste Evidenz ist. Auf dem Body-Anker ruhten 361 Pflichten; 49 entfallen,
  312 bleiben Pflicht auf der Zwei-von-drei-Zählung.
- **Gate:** keines für die Schattenmessung; die Live-Schaltung des
  Evidenzentscheids bleibt an 18.2 und das Konfigurations-Flag aus C-023
  gebunden.
- **Datenquelle:** die beiden privaten Run-Artefakte unter
  `~/.bastra/eval-runs/` samt ihren `NOTES.md`; der Verifikationslauf
  `2026-08-29-50163fb9a0d0` nach der Umsetzung; das Prädikat in
  `packages/core/src/evidence-decision.ts`.
- **Abnahmekriterium:** Das Teilabdeckungs-Signal zählt erst ab einer Abdeckung
  von 0,5; die vollständige Abdeckung bleibt harter Anker. Der Identifier-Anker
  liest Titel, `recall_when` und Frontmatter und nicht den Body. Beides ist im
  Report der Komponentengates nach 18.2 auszuweisen. Umgesetzt in `b30486e`
  (`MIN_TRIGGER_COVERAGE = 0.5`, Body aus dem Identifier-Heuhaufen entfernt) und
  gegengerechnet: Der Lauf `2026-08-29-50163fb9a0d0` reproduziert die
  Vorhersage der Variantenrechnung über alle 679 Fälle mit null Abweichungen.
- **Rollback:** Beide Schwellen sind Konstanten des Prädikats und ohne
  Datenmigration zurückzunehmen. Zwei Vorbehalte bleiben ausdrücklich offen und
  werden nicht als erledigt geführt: Die 5-%-Schwelle des Anti-Query-Gates ist
  auf acht Proben nicht darstellbar — erreichbar sind nur 0 %, 12,5 %, 25 % und
  so fort —, weshalb die Probenmenge auf etwa zwanzig Anti-Queries erweitert
  wird; und die Kosten des Pflichtverlusts (beide Verengungen zusammen streichen
  71 % aller Pflichten) sieht der Goldsatz nicht, sondern erst die
  Shadow-Telemetrie nach dem Deploy. Zeigt sie, dass gestrichene Pflichten in
  Sitzungen gefehlt haben, ist die Abdeckungsschwelle die erste Größe, die
  zurückgedreht wird.

## 29. Quellen- und Behauptungsmatrix

Alle Angaben wurden am **25. Juli 2026** durch Abruf der jeweiligen Primärquelle
erhoben. Diese Fassung ersetzt die knappe Matrix der Vorgängerrevision, die
weder Versionen noch Fundstellen noch Messkonfigurationen enthielt und damit
nicht nachprüfbar war.

### 29.1 Zitierregel

Jede Fremdaussage, die in diesem Dokument als Begründung auftaucht, muss
belegbar sein durch:

1. den kanonischen Quellenort — DOI, wenn vergeben, sonst die stabile
   arXiv-`abs`-, Anthology- oder Repository-URL;
2. die Version — arXiv-Versionsnummer mit Datum, Commit-SHA mit Datum oder
   Proceedings-Seitenzahlen; bei undatierten Anbieterseiten der Vermerk „nicht
   versioniert“ samt etwaigem `dateModified`;
3. die genaue Fundstelle — Tabelle, Abschnitt, Seite oder README-Abschnitt;
4. das Abrufdatum;
5. bei Messungen zusätzlich Reader, Judge, Top-k und Kontextbudget.

Fehlt eine dieser Angaben in der Quelle, wird sie als **fehlend ausgewiesen**
und nicht ergänzt, geschätzt oder aus einer anderen Quelle übertragen. Die
Lückenliste in 29.3 ist Teil des Belegs, nicht ein Mangel daran.

### 29.2 Quellenverzeichnis

| Kurzname | Kanonischer Ort | Version / Stand |
|---|---|---|
| Hindsight (Demo) | `doi:10.18653/v1/2026.acl-demo.27` | ACL 2026 System Demonstrations, S. 275–285 |
| Hindsight (Vollfassung) | `doi:10.48550/arXiv.2512.12818` | v1, 2025-12-14, 28 Seiten |
| Hindsight (Code) | `github.com/vectorize-io/hindsight` | `ed120a2`, 2026-07-24, MIT |
| Zep/Graphiti (Paper) | `doi:10.48550/arXiv.2501.13956` | v1, 2025-01-20, 12 Seiten |
| Zep (Anbieterzahlen) | `getzep.com/research` | nicht versioniert, `dateModified` 2026-05-28 |
| Graphiti (Code) | `github.com/getzep/graphiti` | `3bb2d0b`, 2026-07-23 |
| Mem0 (Benchmarks) | `github.com/mem0ai/memory-benchmarks` | `4b61c5d`, 2026-05-13, Apache 2.0 |
| Mem0 (SDK) | `github.com/mem0ai/mem0` | `d653b63`, 2026-07-24 |
| Mem0 (Paper) | `doi:10.48550/arXiv.2504.19413` | v1, 2025-04-28 |
| BEAM | `doi:10.48550/arXiv.2510.27246` | v2, 2026-02-21; ICLR 2026 |
| T-Mem | `arxiv.org/abs/2606.15405` | v1, 2026-06-13; kein DOI, kein Code |
| All-Mem (Paper) | `arxiv.org/abs/2603.19595` | v2, 2026-06-15; kein DOI |
| All-Mem (Code) | `github.com/LvCan926/All-Mem` | `f5d6912`, 2026-06-15, MIT |
| MAGMA (Paper) | `doi:10.18653/v1/2026.acl-long.1709` | ACL 2026 Long Papers, S. 36848–36865 |
| MAGMA (Code) | `github.com/FredJiang0324/MAGMA` | `467cb70`, 2026-07-10 |
| Mem2ActBench | `doi:10.18653/v1/2026.acl-long.370` | ACL 2026 Long Papers, S. 8173–8190 |
| Graph-Gegenanalyse | `doi:10.18653/v1/2026.acl-long.1232` | ACL 2026 Long Papers, S. 26758–26782 |
| Graph-Gegenanalyse (Code) | `github.com/AvatarMemory/UnifiedMem` | `3df9428`, 2026-04-18 |
| LongMemEval-V2 (Paper) | `arxiv.org/abs/2605.12493` | v1, 2026-05-12; kein DOI |
| LongMemEval-V2 (Code) | `github.com/xiaowu0162/LongMemEval-V2` | `6f020ac`, 2026-07-19 |
| Ori Mnemos | `github.com/aayoawoyemi/Ori-Mnemos` | `8afc915`, 2026-07-22, v0.6.0, Apache 2.0 |

Nicht erreichbar zum Abrufdatum: das im Mem2ActBench-Paper zugesagte Code- und
Datenrepository (`github.com/Cantaloupe-M/Mem2ActBench`, HTTP 404). Die im
Recherche-Briefing zitierte Mem0-Graph-Dokumentationsseite unter
`/open-source/features/graph-memory` existiert nicht mehr; die Funktion wurde
aus dem Open-Source-SDK entfernt, nicht nur die Seite verschoben.

### 29.3 Messungen und ihr Setup

| Messung | Fundstelle | Reader | Judge | Top-k | Kontextbudget |
|---|---|---|---|---|---|
| Hindsight 91,4 % LongMemEval / 89,6 % LoCoMo (Gemini-3); 83,6 / 83,2 (20B) | Demo, Tabelle 2, S. 280 | je Zeile verschieden; Gemini-3 Pro nur als finaler Antwortgenerator, Memory-Stack GPT-OSS-120b | in der Demo **nicht angegeben**; Vollfassung nennt GPT-OSS-120b, Temperatur 0,0, binär | **nicht angegeben** | **nicht angegeben**; Vollfassung enthält an dieser Stelle einen unausgefüllten Platzhalter |
| Hindsight Recall unter 200 ms bei 10.000 Units | Demo, §4.2, S. 279 | entfällt, Backbone-Aufruf ausdrücklich ausgeschlossen | entfällt | 20–50 Kandidaten vor dem Reranking | **nicht angegeben** |
| Zep LoCoMo 94,7 % / LongMemEval 90,2 % | `getzep.com/research`, Kennzahlenblöcke | gpt-5.4, Reasoning mittel | gpt-5.4 mit Chain-of-Thought — **Reader und Judge identisch** | 20 Edges, 10 Nodes, 10 Episoden, 5 Thread-Summaries, 5 Observations, danach Cross-Encoder | kein vorgegebenes Budget; gemessener Median 5.760 bzw. 4.408 Tokens |
| Mem0 LongMemEval 94,8 % | Benchmarks-README, Platform-Tabelle | **nicht angegeben**; CLI-Default gpt-4o | **nicht angegeben**; CLI-Default gpt-4o | Top 50 | **nicht angegeben** |
| Mem0 LoCoMo 92,5 % | Benchmarks-README, Platform-Tabelle | **nicht angegeben** | **nicht angegeben** | Top 200 | **nicht angegeben** |
| Mem0 BEAM 10M, Pass Rate 50,5 % | Benchmarks-README, BEAM-Tabelle | **nicht angegeben** | **nicht angegeben** | Top 200 | **nicht angegeben**; „10M“ ist die Konversationslänge, nicht das Kontextfenster |
| MAGMA LoCoMo 0,700 | Tabelle 1, S. 36854 | gpt-4o-mini, Temperatur 0,0, für alle Systeme | gpt-4o-mini, Temperatur 0,0, kontinuierliche Skala | Vektor-Top-k 20, RRF-k 60, max. Tiefe 5, max. 200 Knoten | kein konfiguriertes Budget; gemessen 3,37k Tokens/Query |
| MAGMA lexikalisch F1/BLEU-1 | Tabelle 9, Anhang F, S. 36864 | gpt-4o-mini | kein LLM-Judge, token-level F1 und BLEU-1 | wie Tabelle 1 | **nicht angegeben** |
| Mem2ActBench A-Mem 35,93 / LTMemory 35,32 | Tabelle 3, S. 8179 | Qwen2.5-7B/32B/72B-Instruct, Temperatur 0,0 | kein LLM-Judge; Argument-F1, BLEU-1, Tool Accuracy | **nicht angegeben** | **nicht angegeben** |
| Mem2ActBench Oracle 53,8 / bester passiver Retriever 30,7 | Tabelle 4, S. 8179 | **nicht angegeben** | kein LLM-Judge | Hybrid bei k=5 als bestes passives Ergebnis; Oracle ohne k | **nicht angegeben** |
| Graph-Gegenanalyse DescGraph gegen flach | Tabelle 4, S. 26763 | LLaMA-3.1-8B für Extraktion und Antwort | kein Judge, reine Retrieval-Metriken R@5/R@10 | Top-k der Initial Activation **nicht beziffert** | **nicht angegeben** |
| Graph-Gegenanalyse End-to-End | Tabellen 7 und 8, S. 26765 | zwei Konfigurationen: LLaMA-3.1-8B mit Contriever, sowie gpt-4o-mini für Extraktion und GPT-4o für Antwort | gpt-4o für LongMemEval, gpt-4o-mini für HaluMem | Top-5 bzw. Top-20 Werte im Antwortkontext | **nicht angegeben** |
| AgentRunbook-C 72,5 % / -R 57,8 % mit Latenzen | LongMemEval-V2, `arXiv:2605.12493` v1, Tabelle 2 | durchgängig Qwen3.5-9B; Controller Qwen3.5-9B bzw. GPT-5.4-mini | deterministische Evaluatoren plus GPT-5.2 für Gotchas und Abstention | **nicht angegeben** | 200k Tokens Truncation |
| T-Mem LoCoMo | §4.3 | GPT-4o-mini | GPT-4o-mini | Betriebspunkt (15, 5, 15, 10) | **nicht angegeben** |
| T-Mem LoCoMo-Plus | §4.3 | GPT-4o | Gemini-2.5-Flash — **anderes Paar als auf LoCoMo** | Betriebspunkt (15, 5, 15, 10) | **nicht angegeben** |
| All-Mem LoCoMo / LongMemEval-s | §4.3, Tabelle 2 | GPT-4o-mini, Temperatur 0 | GPT-4o | k=10 Anker, L=40 Expansion, K=16 final | kein Token-Cap; „matched budget“ ohne Zahl |
| Ori HotpotQA, n=50 | `bench/README.md` | **nicht angegeben** | **nicht angegeben** | k=5 implizit über R@5 | **nicht angegeben** |
| Ori LoCoMo, n=695 | `bench/README.md` | GPT-4.1-mini | **nicht angegeben** | **nicht angegeben** | **nicht angegeben** |
| BEAM Hauptmessung | §4, Tabelle 1, S. 8 | GPT-4.1-nano, Gemini-2.0-flash, Qwen2.5-32B-AWQ, Llama-4-Maverick-fp8 | Nugget-basierter LLM-Judge, **Modell nicht genannt** | RAG-Baseline Top 5; Ablation über 5/10/15/20 | 1M bei den proprietären Modellen, 128k bzw. 32k bei Qwen |

Von neunzehn geprüften Messungen nennen **drei** alle vier Konfigurationsgrößen.
Am häufigsten fehlt das Kontextbudget, am folgenreichsten der Judge. Das ist der
sachliche Grund für die Regel aus C-029, keine Fremdzahl als Gate zu verwenden:
Man könnte sie überwiegend gar nicht nachstellen.

### 29.4 Belegstellen der übernommenen Aussagen

| Aussage im Dokument | Quelle | Fundstelle | Urteil |
|---|---|---|---|
| Vier epistemische Netze mit Konfidenz auf Meinungen | Hindsight Demo | §3.1, S. 276–277 | bestätigt |
| Zwei Zeitmarken je Einheit: Ereignisintervall und Lernzeitpunkt | Hindsight Demo | §3.3, S. 277–278 | bestätigt; die Quelle verwendet das Wort „bi-temporal“ selbst nicht |
| Vier-Kanal-Recall mit RRF, Cross-Encoder und Tokenbudget | Hindsight Demo | §3.2, S. 277; §4.1, S. 278 | bestätigt |
| Observation-Konsolidierung mit Proof Count und Freshness-Trend | Hindsight Demo | §3.3, S. 278; Anhang D, S. 285 | bestätigt |
| Reproduktion durch Institutionen, die Co-Autoren stellen | Hindsight Demo | Acknowledgements, S. 282; Affiliationen S. 275 | bestätigt |
| Bi-temporales Modell mit vier Kantenzeitmarken | Zep/Graphiti | §2.1, S. 2; §2.2.3, S. 3 | bestätigt; Namen `t'_created`, `t'_expired`, `t_valid`, `t_invalid` |
| Invalidierung statt Löschung | Zep/Graphiti + README | §2.2.3, S. 3; README „Temporal Fact Management“ | bestätigt |
| Vier orthogonale Sichten mit Intent-Router | MAGMA | §3.2, S. 36851; §3.3, S. 36851 | bestätigt |
| Hyperparameter auf dem Berichtsbenchmark optimiert | MAGMA | Anhang B.1, S. 36860 | bestätigt |
| Lexikalisch führt nicht MAGMA | MAGMA | Tabelle 9, Anhang F, S. 36864 | bestätigt |
| Ungeeignete Graphkonstruktion verschlechtert Ergebnisse | Graph-Gegenanalyse | §5, S. 26766 | bestätigt |
| Gut konstruierte Entity-Beschreibungen schlagen flache Indizes | Graph-Gegenanalyse | §4.4, Tabelle 4, S. 26763 | bestätigt |
| Befunde generalisieren nicht auf Nicht-Dialog-Aufgaben | Graph-Gegenanalyse | Limitations, S. 26766 | bestätigt |
| Retrieval ist der dominante Engpass | Mem2ActBench | §5.1, S. 8178 | bestätigt |
| Anwendung bleibt auch bei perfektem Retrieval ein Problem | Mem2ActBench | Abstract S. 8173; §5.2, §5.4, §5.5, S. 8178–8180 | bestätigt |
| Zwei Achsen, vier Triggerfamilien, Write-Time-Erzeugung | T-Mem | Figure 1, §1; §3.2.3; §3.1 | bestätigt |
| Trigger bleiben vom Evidenzpfad getrennt | T-Mem | §3.1 | bestätigt |
| Begrenzte sichtbare Oberfläche mit hop-begrenzter Expansion | All-Mem | §3.1, §3.2 | bestätigt |
| Split/Merge/Update erhalten unveränderliche Evidenz | All-Mem | §3.3 | bestätigt |
| Strukturierter Mehrpool-Ansatz gegen agentische Suche | LongMemEval-V2 | Tabelle 2 | bestätigt: 58,6 % bei 26,9 s und 57,0 % bei 25,8 s für die RAG-Variante; 74,9 % bei 108,3 s und 70,1 % bei 139,9 s für die agentische |
| Gravity- und Hub-Dämpfung | Ori Mnemos | README, Abschnitt Retrieval Intelligence | bestätigt; Gravity halbiert bei null Query-Term-Overlap, Hub bestraft ab P90-Grad |
| Exposure-Behandlung ist eine Normalisierung | Ori Mnemos | `RETRIEVAL_INTELLIGENCE_SPEC.md`, Abschnitt Exposure-aware correction | bestätigt: Division durch die Exposure-Zahl hoch 0,5 — keine Propensity-Korrektur |
| Rekursive Exploration mit Abbruchkriterium | Ori Mnemos | `docs/recursive-explore.md` | **korrigiert**: ein Kriterium ist dokumentiert, mit Tiefenlimit 2 und Notizlimit 30 |
| BEAM misst zehn Fähigkeiten bis zehn Millionen Token | BEAM | §2.2; Tabelle 1, S. 8 | bestätigt; 100 Konversationen, 2.000 Fragen |

### 29.5 Berichtigte Fehlzitate

Die folgenden Aussagen standen so in der Vorgängerrevision beziehungsweise im
zugrunde liegenden Recherche-Briefing und sind falsch. Sie sind in dieser
Fassung korrigiert:

1. **BEAM-Teilwerte als Prozentzahlen.** 0,163, 0,325 und 0,400 sind
   Durchschnittswerte auf einer Skala von 0 bis 1, keine Prozentwerte. Die
   zugehörigen Pass Rates lauten 20 %, 25 % und 40 %. Die Formulierung „16,3 %
   Temporal Reasoning“ war eine Fehllesart.
2. **Vermischte Retrieval-Tiefen.** 94,8 % auf LongMemEval ist ein
   Top-50-Wert, 92,5 % auf LoCoMo ein Top-200-Wert. Nebeneinandergestellt
   suggerieren sie eine Vergleichbarkeit, die nicht besteht.
3. **Ori ohne Konvergenzkriterium.** Die Vorgängerrevision hielt fest, ein
   Abbruchkriterium der rekursiven Exploration sei nicht auffindbar. Es ist
   dokumentiert, nur nicht in README oder Spezifikation, sondern in
   `docs/recursive-explore.md`. Die Vorprüfung hatte diese Datei nicht gelesen.
4. **„Multi-Session Reasoning“ als BEAM-Fähigkeit.** Der Benchmark führt zehn
   Fähigkeiten; diese ist nicht darunter. Die inhaltlich nächste heißt
   „Multi-Hop Reasoning“. Die Bezeichnung stammt aus dem Ergebnis-README des
   messenden Anbieters.
5. **Mem0-Paper als Beleg für die aktuellen Zahlen.** Das Paper von 2025 deckt
   nur die ältere LoCoMo-Evaluation ab. Wer 94,8 % oder 92,5 % damit belegt,
   zitiert falsch.

Punkt 1 und 3 sind eigene Fehler dieser Dokumentlinie, nicht des Briefings.
Beide wären mit den Anforderungen aus 29.1 nicht entstanden — was die
Begründung für C-040 liefert.

## 30. Ausdrücklich verworfen oder zurückgestellt

Verworfen, weil es Bastras Grundsätzen widerspricht:

- ein Meinungs- oder Belief-Netz mit eigener, selbstverstärkender Konfidenz;
- fünf zusätzliche epistemische Memory-Typen neben den bestehenden Typen;
- vier getrennte physische Graphdatenbanken;
- Cross-Encoder-Reranking in jedem Hook-Aufruf;
- Live-Lernen aus Q-Werten oder Co-Occurrence ohne Exposure- und Hub-Kontrolle;
- automatische Ausführung von Konsolidierungs-Operatoren ohne Freigabe;
- Übernahme eines Fremdsystem-Scores als Bastra-Gate oder -Zielwert.

Zurückgestellt, weil der Nutzen für den heutigen Scope nicht belegt ist:

- die **Persistenz** beschreibender Item- und Szenen-Cues als eigene Felder,
  solange die Ablation aus 18.3 ihren eigenen Beitrag nicht belegt und der
  gesonderte Repräsentationsentscheid nach 11.2 nicht gefallen ist. Die
  Vermutung, dass Titel, Tags, `topic_path` und Summary diese Achse bereits
  abdecken, ist der Grund für die Zurückstellung — nicht für einen Verzicht auf
  die Prüfung. Die beschreibende Achse bleibt vollwertiger Faktor des
  2×2-Designs;
- multimodale Episoden und Bildschirmerfahrung;
- ein Multi-Agenten-Konsolidierungsapparat;
- vollständige Läufe großskaliger Trajektorien-Benchmarks;
- HNSW, unverändert gegenüber C-007 und M5;
- ein lernender Stufen-Controller, der Pipeline-Schritte überspringt oder
  aussetzt, vor Erreichen des Mindest-N.

## 31. Getroffene Product-Owner-Entscheidungen

**Status: am 25. Juli 2026 entschieden.** Die fünf Entscheidungen binden die
Umsetzung; die betroffenen Passagen sind in dieser Fassung nachgezogen. Zwei
Punkte, die zuvor als Entscheidungen aufbereitet waren, sind keine
Product-Owner-Fragen, sondern Qualitätsanforderungen: die Bindung einer
Bestätigung an genau ein Memory (C-064, ausgeführt in 6.3) und die Rückkehrregel
für abgelehnte Vorschläge (C-067, ausgeführt in 14.4). Sie stehen dort als feste
Anforderung und nicht mehr als Wahl.

### Entscheidung 1 – Erzeugung der abgeleiteten Cues

**Entschieden: vertagt, mit Auflage.** Ob abgeleitete Cues vom schreibenden
Agenten beim Save oder von einem reproduzierbaren Offline-Batch erzeugt werden,
wird nicht jetzt festgelegt. Stattdessen wird der Erzeugungsweg in M2
kontrolliert geprüft.

**Auflage:** Nach 18.3 gibt es genau zwei zulässige Versuchsanlagen — Anlage A,
der gepaarte Agent-gegen-Batch-Vergleich mit **zwei Bedingungen** bei
festgehaltener Cue-Konfiguration und getrenntem Auswahl- und Holdout-Teil oder
vorab registrierter verschachtelter Auswertung (empfohlen), oder Anlage B, ein vollständig gekreuztes 2×2×2 mit acht Zellen und
eigenem, größerem Mindest-N. Welche Anlage gefahren wird, ist vor dem Lauf zu
registrieren. Nur Anlage B erlaubt Interaktionsaussagen. Ein
nachträgliches Hinzunehmen als zusätzlicher Arm ist unzulässig, weil die
Haupteffekte dann mit dem Erzeugungsweg konfundiert wären.

**Auswirkung:** keine auf Release oder Schema. Die Entscheidung fällt nach dem
M2-Lauf auf Basis von Messung statt Vermutung.

### Entscheidung 2 – Externer Benchmark

**Entschieden: ja, genau einer, handlungsorientiert, in V1.x.** Bastra adaptiert
einen externen Benchmark, der misst, ob eine frühere Aussage korrekt in eine
spätere Handlung eingeht — nicht, ob sie wiedergegeben werden kann.

**Begründung:** Ein handlungsorientierter Test liegt näher an Bastras
Produktscope als ein konversationsorientierter; die kleinere Vergleichsbasis
wird bewusst in Kauf genommen. Genau einer, weil jeder weitere Adapter
laufenden Pflegeaufwand für Harness-, Modell- und Judge-Versionen erzeugt.

**Auswirkung:** Kein V1.0-Releaseblocker; die Zuordnung steht in 19.1. Jeder Lauf
erfüllt die Metadatenpflicht aus C-040. Die in 2.3 benannte Beweislücke wird
damit im Grundsatz geschlossen, nicht vollständig.

### Entscheidung 3 – Deep Recall Stufe 2

**Entschieden: erst nach der Stufe-1-Messung.** Die agentische Stufe 2 wird nur
gebaut, wenn sie gegenüber Stufe 1 einen an Kosten und Latenz gemessenen
Eigennutzen zeigt.

**Begründung:** Die Fremdmessung legt einen erheblichen Kostensprung für die
Agentenschleife nahe, dessen Nutzen für einen Vault dieser Größe unbelegt ist.
Stufe 1 könnte das Deep-Recall-Versprechen aus Abschnitt 8 bereits einlösen.

**Auswirkung:** keine. Stufe 1 ist unabhängig nutzbar; die Reihenfolge steht
bereits in 25 Punkt 7 und im M3-Gate in 18.4.

### Entscheidung 4 – Zeit- und Herkunftsschema

**Entschieden: Herkunft jetzt read-only prüfen, persistente Schemafelder
gemeinsam nach M4.** Die Provenienzprüfung nach 6.3 beginnt sofort in der
Sidecar-Projektion. Die persistenten Felder für Zeitachsen und Herkunft werden
später in **einem** gemeinsamen Schemaentscheid nach M4-Vorbereitung migriert.

**Begründung:** Die Herkunftsfrage ist eine Korrektheitsfrage und drängt; das
Zeitmodell ist eine Ausdrucksfrage und kann warten. Beide Feldgruppen haben
dieselben Konsumenten, weshalb eine gemeinsame Migration billiger ist als zwei.

**Auswirkung:** Die Prüfung läuft ohne Vault-Änderung. `valid_until` wird in
keiner Variante angefasst — siehe C-041. Rückwärtskompatibilität nach 22 bleibt
gewahrt.

### Entscheidung 5 – Bestätigung der Nutzerherkunft

**Entschieden: durch ausdrückliche Bestätigung in der Recall-Oberfläche; der
gesamte Bestand wird geprüft.** Ein Memory erreicht die Klasse `user_asserted`
ausschließlich dadurch, dass der Nutzer beim Review „Ja, das stammt von mir"
wählt. Der Save-Pfad erzeugt sie nie automatisch — auch nicht nach Einführung
eines einheitlichen Mutation-Audits.

**Begründung:** Ein Agent kann heute selbst behaupten, eine Aussage stamme vom
Nutzer, und der Code prüft das nicht (siehe C-060). Der einzige Ort, an dem ein
Mensch nachweislich beteiligt ist, ist die sichtbare Prüfung. Damit ist die
Rückfallregel kein Provisorium, sondern der Normalfall.

**Auswirkung:** Die Oberfläche bildet die Herkunft progressiv auf sieben
Provenienzklassen ab und hält Beobachtung, Ableitung und Vermutung getrennt
(6.3). Die Reviewberechtigung gilt für den gesamten Bestand; Importstatus und
`write_origin` liefern nur einen angezeigten, nicht vorausgewählten
Systemvorschlag. `not_scheduled` bezeichnet nur noch die
Warteschlangenposition; die frühere Aussetzung für `agent-session` und fehlendes
`write_origin` entfällt. Die Prüfung läuft in vier Prioritätsstufen und endet je
Memory mit geklärter oder ausdrücklich bestätigt unklarer Herkunft.

### Was weiterhin offen ist

Diese Entscheidungen legen das Produktverhalten fest, nicht seine Umsetzung.
Offen bleiben insbesondere: die konkrete Gestalt des Bestätigungsbezugs in der
Oberfläche; die Reihenfolge innerhalb der vier Prüfstufen; die Wahl des
konkreten handlungsorientierten Benchmarks; und alle numerischen Größen, die
erst nach dem M0-Baseline-Run entstehen.

## 32. Übergabe nach dem Ein-Satz-Delta-Fix

**Was geändert wurde.** Diese Fassung fügt das Delta C-082 hinzu. Geändert
wurden ausschließlich die folgenden Zeilenbereiche:

| Passage | Zeilen | Delta |
|---|---|---|
| Titel und Präambel | 1–31 | C-082, Promotion |
| 0.4 Korrekturverweis und Ledgerzeile C-081, neue Zeile C-082 | 183–184 | C-082 |
| 0.4 Abnahmeblock und nächste freie ID | 296–302 | C-082 |
| 6.3 Sofortzulässigkeit des Nachweisartefakts und 21.4-Abgrenzung | 1251–1256 | C-082 |
| 18.5 Schlussbemerkung zur Gate-Zugehörigkeit | 3418–3423 | C-082 |
| 28 Überschrift und Rundenzahl | 4063–4065 | C-082 |
| 28 Rundenlabel 10 entklammert, Runde-11-Zuordnungstabelle | 4182–4196 | C-082 |
| 28 Gate im Delta-Eintrag C-081 | 5720–5722 | C-082 |
| 28 Korrekturverweis an C-081 und Delta-Block C-082 | 5742–5782 | C-082 |
| 32 dieser Abschnitt | ab 6058 | — |

Alle übrigen Passagen sind unangetastet. Produktcode und die zwölf Fassungen
unter `docs/architecture-history/` wurden nicht verändert. Titel und Präambel
tragen zusätzlich die Promotion dieser Datei auf den kanonischen Pfad: Sie
führen keine Revisionsnummer mehr und benennen die Datei als maßgeblich.

**Was das Delta behebt.** C-081 hatte die Nachweispflicht für den eingefrorenen
Graph-Snapshot eingeführt und im selben Block festgehalten, die Zuordnung
bleibe read-only Sidecar-Arbeit im Sinne von C-018 — stellte aber die
persistente Gestalt des Artefakts unter den Schemaentscheid nach M4. Das ist
widersprüchlich: Ohne Artefakt startet der Lauf nach derselben Regel gar nicht,
während M4 erst nach mehreren Messstufen fällt. Gelesen als Gate hätte die
Bestandsprüfung damit bis M4 nicht laufen dürfen, obwohl C-065 sie an kein Gate
bindet und C-066 sie ausdrücklich sofort read-only beginnen lässt.

Der Widerspruch beruhte auf einer Verwechslung von Sidecar-Projektion und
persistentem Memory-Schema. Das Queue- beziehungsweise Run-Artefakt berührt
weder Memory-Frontmatter noch Vault-Schema; private Run-Artefakte sind nach
C-025 ohnehin vorgesehen. Der verbindliche Gate-Text lautet jetzt: keines —
Zuordnung und Nachweisartefakt sind jederzeit zulässige Sidecar-/Run-Artefakte
nach C-018 und C-025, und kann das Artefakt nicht geschrieben werden, startet
der Lauf nicht. Abschnitt 21.4 greift erst, wenn Snapshot-, Queue- oder
Reviewfelder in das Memory-Frontmatter beziehungsweise in das persistente
Memory-Schema übernommen werden sollen.

**Was besonders zu prüfen ist.**

1. Ob der Grad-Schwellenwert absolut oder als Quantil sinnvoller ist — das
   Dokument lässt beides zu und überlässt die Wahl der Herleitung aus der
   Bestandsverteilung.
2. Welche der beiden von C-081 zugelassenen Nachweisvarianten gewählt wird —
   die Einzelwerte im Manifest oder der content-addressed persistierte
   Snapshot. Die erste ist kompakter, die zweite erlaubt auch eine
   nachträgliche Neuberechnung mit anderem Kriterium.
3. Ob das Reason-Code-Vokabular vollständig genug ist, um jede materielle
   Begründungsänderung abzubilden, ohne zum Freitext zu degenerieren — die
   Sperre bei unbekanntem Code aus C-081 macht eine Lücke unschädlich, aber
   nicht folgenlos: Jeder fehlende Code unterdrückt eine womöglich berechtigte
   Wiedervorlage.
4. Ob die semantische Inhaltsversion aus dem bestehenden Schema ableitbar ist
   oder ein eigenes Feld benötigt — dann fiele sie unter den Schemaentscheid aus
   21.4. Diese Frage bleibt von C-082 unberührt: Sie betrifft ein persistentes
   Schemafeld, nicht ein Run-Artefakt.
5. Ob eine echte Artikulationsanalyse den Aufwand lohnt. C-080 schließt sie
   nicht aus, sondern hält nur fest, dass sie heute nicht existiert; ob das
   gröbere Signal für die Stufenzuordnung genügt, zeigt erst der erste Lauf.

**Noch offen.** Die konkrete Gestalt des Bestätigungsbezugs in der Oberfläche;
die Reihenfolge innerhalb der vier Prüfstufen; die Wahl des konkreten
handlungsorientierten Benchmarks; alle numerischen Größen nach dem
M0-Baseline-Run, jetzt einschließlich des Grad-Schwellenwerts aus C-078;
`max_provenance_hops` = 2 als Startkandidat. Die englische Übersetzung dieses
Stands liegt unter `docs/Evolution Architecture V1 to V2.md`; die alte Fassung
im Stand C-001–C-028 ist ins Archiv gewandert. Nebenbefund ohne C-ID: Die Daemon-README
beschreibt abgelaufene Memories als „(or excluded if expired)"; der Code dämpft
sie nur auf 20 %.

**Nächste freie ID: C-083.** *(Historischer Stand vom 26.07.2026. Die aktuell
gültige nächste freie ID steht am Ende von Abschnitt 36.)*

## 33. Übergabe nach der Vertragsänderung C-083

**Was geändert wurde.** Diese Fassung fügt die Vertragsänderung C-083 hinzu.
Geändert wurden ausschließlich die folgenden Passagen:

| Passage | Delta |
|---|---|
| Präambel: Ledgerstand, Entstehung, Stand-Datum, nächste freie ID | C-083 |
| 0.4 Änderungsverweis an C-024, neue Ledgerzeile C-083 | C-083 |
| 0.4 Abnahmeblock und nächste freie ID | C-083 |
| 17.4 Releasezuordnung des Experiments | C-083 |
| 26.1 Experimentpunkt neu gefasst, ersetzte Fassung kenntlich | C-083 |
| 26.2 hinreichend besetzter Lauf ergänzt | C-083 |
| 28 Überschrift, Vorspann, Zuordnungstabelle, Delta-Eintrag C-083 | C-083 |
| 32 Klammervermerk zur historischen ID | C-083 |
| 33 dieser Abschnitt | — |

Alle übrigen Passagen sind unangetastet. Produktcode, die Registrierung des
Experiments und die Fassungen unter `docs/architecture-history/` wurden nicht
verändert.

**Was die Änderung bewirkt.** Der V1.0-Releasevertrag verlangte, dass die
Experimentarme „ihr nach M0 versioniertes Mindest-N erreicht haben“. Diese
Anforderung ist auf der heutigen Population nicht erfüllbar, und das ist seit
der Registrierung des Experiments gemessen statt vermutet: Die Versuchseinheit
ist die Session, der Vault hat einen Nutzer, und selbst 50 ergebnistragende
Sessions je Arm lägen rund 88 Tage entfernt. Ein Vertrag, der eine unerreichbare
Zahl fordert, blockiert entweder das Release oder lädt dazu ein, einen
unterbesetzten Lauf als Befund auszugeben — beides schlechter als die ehrliche
Auskunft.

V1.0 schuldet deshalb ab sofort drei prüfbare Dinge: die vor jedem Lauf
registrierte Anlage, die deterministische und session-stabile Armzuweisung und
den ehrlichen Statusbericht nach 18.1, der einen unterbesetzten Arm als **nicht
auswertbar** ausweist statt als Nullbefund. Der hinreichend besetzte Lauf steht
in 26.2 und bleibt Voraussetzung der Promotion nach V2.0. Die ersetzte Fassung
bleibt in 26.1 sichtbar; die Zuweisungs- und Fallzahlregel aus C-024 gilt
unverändert, nur ihre Releasezuordnung hat sich verschoben.

**Was besonders zu prüfen ist.**

1. Ob die Wiederaufnahme an eine Mehrnutzer-Population gebunden bleibt oder ob
   die Versuchseinheit bewusst geändert wird — je Turn statt je Session wäre
   eine Änderung an 17.4 und verlangt einen eigenen Eintrag, keine
   Konfiguration.
2. Ob der Statusbericht als Vertragsbestandteil eine eigene abnehmbare
   Ausgabe braucht — heute trägt die Registrierung das Verdikt, ein Report
   existiert noch nicht.
3. Ob die drei nicht-fallzahlbedingten Voraussetzungen — zweiter Hook-Wortlaut,
   je Session schaltbares Gate, Query-Klassen-Dimension — in 26.2 einzeln
   gegatet oder gemeinsam mit dem Lauf abgenommen werden.

**Noch offen.** Unverändert die offenen Punkte aus Abschnitt 32, jetzt
zusätzlich der zweite Hook-Wortlaut für Arm A als Produkt- und Textentscheidung
und die Aktivierungsentscheidung, von der Arm B abhängt.

**Nächste freie ID: C-084.** *(Stand dieses Abschnitts. Die aktuell gültige
nächste freie ID steht am Ende von Abschnitt 36.)*

## 34. Übergabe nach der Vertragsergänzung C-084

**Was geändert wurde.** Diese Fassung fügt die Vertragsergänzung C-084 hinzu.
Geändert wurden ausschließlich die folgenden Passagen:

| Passage | Delta |
|---|---|
| Präambel: Ledgerstand, Entstehung, Stand-Datum, nächste freie ID | C-084 |
| 0.4 neue Ledgerzeile C-084 | C-084 |
| 0.4 Abnahmeblock und nächste freie ID | C-084 |
| 22 sechs Spiegelstriche zur Zusicherung und zum V2-Feldstatus | C-084 |
| 26.1 Zusicherungsblock | C-084 |
| 28 Überschrift, Vorspann, Zuordnungstabelle, Delta-Eintrag C-084 | C-084 |
| 33 Vermerk zur ID | C-084 |
| 34 dieser Abschnitt | — |

Außerhalb dieser Datei trägt `docs/memory-schema.md` denselben Inhalt als
Abschnitt „Compatibility Promise (1.0)“. Produktcode wurde nicht verändert.

**Was die Ergänzung bewirkt.** Mit 1.0.0 fällt das Beta-Signal der führenden
`0.`, und ab dann verlangt jede Breaking-Änderung am Vault-Format einen
Major-Bump. Was genau zugesichert ist, stand bis dahin nirgends. C-084 schließt
diese Lücke und verspricht ausschließlich, was der Code hält: Pflichtfelder,
Typen, Bedeutung der optionalen Felder — und die Ladetoleranz, weil sie die
eigentliche Zusage an einen handgepflegten Vault ist. Vier Stellen sind bewusst
eng gefasst: Ein 1.x-Reader verlangt kein Formatversionsfeld, ohne dass damit
ein späteres optionales Feld ausgeschlossen wäre. Die `recall`-Ausgabeform ist
gebunden, aber über den API-Vertrag statt über das Schema. Unbekannte Schlüssel
werden beim Laden toleriert und überleben einen `overwrite` nicht garantiert.
Und die Sicherheitsausnahme trägt vier Bedingungen, darunter einen sichtbaren
Fehler statt stillem Verwerfen.

**Was besonders zu prüfen ist.**

1. ~~Ob die Erhaltungslücke beim `overwrite` bestehen bleiben soll oder ob der
   Save-Pfad unbekannte Schlüssel künftig durchreicht~~ — **entschieden am
   29.08.2026: Der Save-Pfad reicht sie durch.** Bei einem `overwrite` wird
   jeder Schlüssel, den der Save-Pfad nicht selbst verwaltet, unverändert aus
   dem bestehenden Frontmatter übernommen; die verwalteten Felder behalten ihre
   heutige Semantik und gewinnen jede Namenskollision. Der Vertragswortlaut in
   C-084 bleibt, wie er ist: Die Lücke ist im Code geschlossen, nicht in eine
   Zusage verwandelt — über andere Wege als diesen kann ein Schlüssel weiterhin
   verlorengehen, und eine Garantie müsste sie alle benennen.
2. Ob die Sicherheitsausnahme je Anwendung eine C-ID bekommt. Der Text verlangt
   heute nur den Changelog-Ausweis.
3. Ob `docs/memory-schema.md` als Nutzerdokumentation zusätzlich auf 26.1
   verweisen soll, damit die beiden Fassungen nicht auseinanderlaufen.

**Nächste freie ID: C-085.** *(Stand dieses Abschnitts. Die aktuell gültige
nächste freie ID steht am Ende von Abschnitt 36.)*

## 35. Übergabe nach der Vertragsergänzung C-085

**Was geändert wurde.** Diese Fassung fügt die Vertragsergänzung C-085 hinzu.
Geändert wurden ausschließlich die folgenden Passagen:

| Passage | Delta |
|---|---|
| Präambel: Ledgerstand, Entstehung, Stand-Datum, nächste freie ID | C-085 |
| 0.4 Ergänzungsverweis an C-022, neue Ledgerzeile C-085 | C-085 |
| 0.4 Abnahmeblock und nächste freie ID | C-085 |
| 18.2 Shadow-Abnahme: Streuungsbedingung und Zähl-Lesart | C-085 |
| 28 Überschrift, Vorspann, Zuordnungstabelle, Delta-Eintrag C-085 | C-085 |
| 34 Vermerk zur ID | C-085 |
| 35 dieser Abschnitt | — |

Alle übrigen Passagen sind unangetastet. Produktcode wurde nicht verändert; die
Auswertung in `packages/daemon/scripts/stats.ts` erfüllt die neue Bedingung
heute noch nicht und muss sie nachziehen.

**Was die Ergänzung bewirkt.** Die Shadow-Abnahme kannte zwei gleichwertige
Routen: 500 geloggte Entscheidungen oder 14 Kalendertage. Die erste zählte nur
eine Menge. Im realen Bestand stammen 2040 von 2052 Entscheidungen aus einer
Session — die Schwelle wäre viermal erfüllt, ohne dass je eine zweite
Arbeitssituation beobachtet worden wäre. Genau das soll der Shadow-Betrieb
verhindern. Die Entscheidungs-Route verlangt deshalb künftig mindestens 20
verschiedene Sessions und höchstens 25 % Anteil je Session. Die 14-Tage-Route
bleibt unverändert: Zeit erzeugt Streuung von allein.

Im selben Eintrag steht die Zähl-Lesart, die bis dahin nur im Code stand:
Gezählt wird pro Memory-Entscheidung, nicht pro Hook-Aufruf. Ein Aufruf über
acht Kandidaten liefert acht zählende Entscheidungen — so rechnet
`stats.ts`, und die Formulierung „geloggte Hook-Entscheidungen" in C-022
bezeichnet dieselbe Größe.

**Was besonders zu prüfen ist.**

1. Ob 20 Sessions und 25 % nach dem M0-Baseline-Run als versionierte Zahlen
   bestätigt oder nachgezogen werden. Beide Werte sind aus der heutigen
   Ein-Nutzer-Nutzung kalibriert und teilen deren Grenzen.
2. Ob `stats.ts` die Bedingung als eigene Zeile ausweisen soll — heute meldet
   die Ausgabe nur Entscheidungen und Tage, sodass eine erreichte Schwelle ohne
   Streuung als „REACHED" erschiene.
3. Ob dieselbe Streuungsanforderung für den Präsentationsexperiment-Arm aus
   17.4 gelten soll. Dort ist die Session bereits die Versuchseinheit, weshalb
   die Frage sich anders stellt — aber sie stellt sich.

**Nächste freie ID: C-086.** *(Stand dieses Abschnitts. Die aktuell gültige
nächste freie ID steht am Ende von Abschnitt 36.)*

## 36. Übergabe nach der Präzisierung C-086

**Was geändert wurde.** Diese Fassung fügt die Präzisierung C-086 hinzu.
Geändert wurden ausschließlich die folgenden Passagen:

| Passage | Delta |
|---|---|
| Präambel: Ledgerstand, Entstehung, Stand-Datum, nächste freie ID | C-086 |
| 0.4 Präzisierungsverweis an C-002, neue Ledgerzeile C-086 | C-086 |
| 0.4 Abnahmeblock und nächste freie ID | C-086 |
| 10.3 Required-Bedingungen, Messgrundlage, Vorbehalte | C-086 |
| 28 Überschrift, Vorspann, Zuordnungstabelle, Delta-Eintrag C-086 | C-086 |
| 35 Vermerk zur ID | C-086 |
| 36 dieser Abschnitt | — |

Alle übrigen Passagen sind unangetastet. Der Produktcode trägt die Änderung
inzwischen: `packages/core/src/evidence-decision.ts` exportiert
`MIN_TRIGGER_COVERAGE = 0.5` und führt den Body nicht mehr im
Identifier-Heuhaufen (Commit `b30486e`). Verifiziert durch den Lauf
`2026-08-29-50163fb9a0d0`: Das geänderte Prädikat reproduziert die Vorhersage
der Variantenrechnung über alle 679 Fälle ohne eine einzige Abweichung — acht
verglichene Felder je Fall, 5432 Werte. Im Daemon wirkt die Änderung erst nach
einem Neustart; die Shadow-Beobachtung beginnt damit neu.

**Was die Präzisierung bewirkt.** Die Produktsemantik von `required` — harter
Anker oder mehrere unabhängige Signale — blieb unverändert; korrigiert wird,
was als Anker und was als unabhängiges Signal durchging. Ein einzelner geteilter
Term ist keine unabhängige Evidenz, und ein Bezeichner im Fließtext ist kein
Anker. Beides zusammen erzeugte Pflichten, deren Begründung der Prüfung nicht
standhielt: 361 Pflichten ruhten allein auf einem Fund im Body.

Die Messung ist der eigentliche Gehalt des Eintrags. Sie lief **vor** der
Änderung und über sechs Varianten auf demselben Pool, weshalb ein Unterschied
zwischen zwei Zeilen die Regel ist und kein zweiter Lauf. Das Ergebnis ist
ungewöhnlich eindeutig: Das Anti-Query-Gate viertelt sich, und keine der drei
Qualitätsgrößen bewegt sich um eine einzige Stelle.

**Was besonders zu prüfen ist.**

1. Ob die 5-%-Schwelle des Anti-Query-Gates nach der Erweiterung auf etwa
   zwanzig Anti-Queries hält. Vorher ist die Frage nicht beantwortbar, und der
   heutige Wert von 1/8 darf nicht als Bestehen gelesen werden.
2. Ob die Shadow-Telemetrie nach dem Deploy Pflichten vermisst, die jetzt
   entfallen. 71 % weniger Pflichten sind ein großer Eingriff, dessen Kosten
   dieser Goldsatz strukturell nicht sehen kann.
3. Ob die Schwelle 0,5 nach dem M0-Baseline-Run versioniert bestätigt wird. Sie
   ist heute aus der Längenaufschlüsselung begründet, nicht aus einer
   Kalibrierung.

**Nächste freie ID: C-087.**
