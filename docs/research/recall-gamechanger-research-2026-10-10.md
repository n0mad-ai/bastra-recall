# Weitere Entwicklungsmöglichkeiten für Bastra Recall

Stand 10. Oktober 2026. Die stärksten zusätzlichen Richtungen sind aus meiner Sicht
eine nachvollziehbare Verbindung von Entscheidungen, Dokumenten und Code, gezielter
Wissenserwerb mit wenigen nützlichen Rückfragen sowie selektives Gedächtnis für visuelle
Arbeitskontexte. Diese Richtungen sind Diskussionsvorschläge. Die bereits beschlossene
Ergänzung C-096 ist in der [V2-Planung](../Evolution%20Plan%20V2.md) enthalten; die
folgenden Rechercheideen erweitern deren Umfang noch nicht.

Die Untersuchung verbindet zwanzig Primärquellen mit dem bestehenden Plan und den
GitHub-Issues. Fremde Ergebnisse beschreiben die jeweiligen Versuchsbedingungen und
sind keine Messung von Recall. Eine ausführliche Funktions- oder Benchmarkreproduktion
ist hier nicht erfolgt.

## Was die Forschung für unsere Richtung bedeutet

Der Vergleich EvoMemBench untersucht unterschiedliche Formen von Gedächtnis und
unterscheidet Wissen von Ausführung sowie Lernen innerhalb und zwischen Episoden.
Sein Befund ist für die Produktentscheidung zentral: Lange Kontexte bleiben starke
Vergleichsarme, und keine Gedächtnisform gewinnt in allen Situationen. Daraus leite
ich ab, dass Recall mehrere Aufgaben bedienen sollte, deren Nutzen getrennt geprüft
wird. Mehr gespeicherte Informationen allein sind kein Erfolgsmaß.
[EvoMemBench](https://arxiv.org/abs/2605.18421).

Hindsight trennt Erinnern und reflektierende Synthese mit zeitlichen und
entitätsbezogenen Strukturen. MemOS behandelt Text, Aktivierungszustände und
Modellparameter als unterschiedliche Gedächtnisformen. Das sind hilfreiche
Vergleichsmodelle; vieles davon liegt bereits in unserem Plan. Hindsights eigenes
Belief-/Opinion-Netz bleibt mit unserer Entscheidung gegen selbstverstärkende
Agentenüberzeugungen unvereinbar.
[Hindsight](https://arxiv.org/abs/2512.12818),
[MemOS](https://arxiv.org/abs/2507.03724).

## Ein Arbeitsgraph verbindet Gründe mit dem tatsächlichen System

**Produktidee:** Recall beantwortet eine Frage entlang der Kette
Produktanforderung → Entscheidung und Annahme → Dokument → Implementierung →
Test → beobachtetes Ergebnis. Jede Verbindung benennt ihre Quelle und Version.

Ein Beispiel wäre: „Wenn wir diese Anforderung ändern, welche Entscheidung müssen
wir neu bewerten, welche Stellen sind betroffen und welche Tests belegen heute das
versprochene Verhalten?“ Die Ausgabe würde bestätigte Abhängigkeiten, mögliche
Auswirkungen und fehlende Belege getrennt ausweisen.

Graphifys aktuelles Upstream-README beschreibt neben deterministischem Code-Parsing
auch Dokumente und Medien, Rationale-/ADR-Verbindungen und eine Trennung zwischen
EXTRACTED und INFERRED. Dokumente und Medien nutzen einen semantischen Modellpass.
Diese Fähigkeiten machen das Projekt als mögliche Quelle interessant; sie sind keine
Aussage über den Funktionsumfang oder Nutzen unserer installierten Integration.
[Graphify](https://github.com/Graphify-Labs/graphify).

**Abgleich:** Recall baut heute bewusst mit `extract --code-only`; der Reader
filtert Abhängigkeitsrelationen und EXTRACTED-Herkunft. Die Grenze ist Teil von C-089
und bleibt bestehen. #628 diskutiert bereits Struktur, Namen und Git-Historie;
#629/#668 diskutieren Tests aus gemessener Ausführung. #394/#395 und C-096 liefern
die Entscheidungsseite. Neu wäre die belegte Verbindung dieser Seiten zu einer
Produktfähigkeit; eine Erweiterung auf Dokumentextraktion benötigt einen eigenen
Entscheid und ein isoliertes Experiment. Ein größeres Graphify-Update allein erfüllt
sie nicht. [Build-Grenze](../../packages/daemon/src/code-graph/build.ts),
[Reader](../../packages/daemon/src/code-graph/reader.ts),
[Issue 628](https://github.com/n0mad-ai/bastra-recall/issues/628),
[Issue 668](https://github.com/n0mad-ai/bastra-recall/issues/668).

**Erster Versuch:** Einen vorhandenen, dokumentierten Produktablauf mit Entscheidung,
wenigen Codeorten und echten Tests von Hand verknüpfen. Vergleichen, ob Recall richtige
Auswirkungen findet, falsche Verbindungen vermeidet und die Untersuchung beschleunigt.
Grep/Read, Codegraph allein und dieselben Informationen ohne Graph sind Vergleichsarme.
Die Kette darf weder einen fehlenden Test als vorhandenen Beleg darstellen noch aus
Code-Nähe die Ursache einer Entscheidung erfinden.

## Recall erwirbt gezielt fehlendes Wissen

**Produktidee:** Recall erkennt bei einer aktuellen Aufgabe, welche fehlende Antwort
den weiteren Weg tatsächlich verändern würde. Es schaut zuerst in das vorhandene
Gedächtnis und die zugelassenen Quellen. Nur wenn die verbleibende Frage relevant
ist, stellt es sie einmal passend zum Arbeitsfluss.

Beispiel: „Bezieht sich deine Wartungsgrenze auf laufende Kosten oder auf deinen
persönlichen Zeitaufwand?“ Diese Antwort könnte mehrere künftige Entscheidungen
verbessern. Eine bereits beantwortete Frage sollte nicht erneut auftauchen; ihre
Gültigkeit und ihr Kontext bleiben dennoch überprüfbar.

Die Value-of-Information-Arbeiten gewichten den erwarteten Nutzen einer Frage gegen
Antwortaufwand und Kosten eines falschen Handelns. REVOIR berücksichtigt zusätzlich,
dass leicht korrigierbare Ergebnisse eine sofortige Rückfrage weniger wertvoll machen
können. Ein sehr aktuelles Preprint untersucht trainierte Klärungsstrategien mit
menschlichen Teilnehmern bei der Rekonstruktion von Bildern. Dessen Aussage ist auf
diese Aufgabe und die gewählten Nutzensurrogate begrenzt.
[Value of Information](https://arxiv.org/abs/2601.06407),
[REVOIR](https://arxiv.org/abs/2609.37588),
[Learning to Clarify](https://arxiv.org/abs/2610.04719).

**Abgleich:** #459 entdeckt bereits fehlende oder schlecht erreichbare Erinnerungen;
#271 reviewt Herkunft; #403 legt offene Aufgaben vor. Neu wäre eine Entscheidung,
welche Wissenslücke sich durch eine Rückfrage zu schließen lohnt. Das ist kein neues
dauerhaftes Belief-Netz. Kurzlebige Alternativen zur Interpretation einer Aufgabe
werden nicht als Nutzerfakten gespeichert. Bestätigte dauerhafte Antworten nutzen den
bestehenden Capture-Pfad. [Issue 459](https://github.com/n0mad-ai/bastra-recall/issues/459).

**Erster Versuch:** Auf identischen Aufgaben Recall allein, eine einfache feste
Rückfrageregel und eine nutzenorientierte Auswahl vergleichen. Entscheidend sind
Ergebnisqualität, tatsächlich notwendige Fragen, wiederholte Fragen, Zeitaufwand und
späterer Nutzen bestätigter Antworten. Die Kostenabschätzung des Modells ist ein
Vorschlag, kein objektives Maß für Daniels Geduld.

## Visuelle Arbeitskontexte gezielt erinnern

**Produktidee:** Recall kann auf einen früher betrachteten Inhalt zurückgreifen, auch
wenn er nie als Textnotiz gespeichert wurde: eine Diagrammvariante, eine relevante
Ansicht oder eine Auswahl zwischen Angeboten. Auf die Frage „die Variante von gestern“
kämen zeitlich zugeordnete Kandidaten mit Originalbeleg und passendem Kontext.

LightMem-Ego demonstriert zeitlich ausgerichtete Audio-/Bildströme und gestuftes
Gedächtnis für persönliche Assistenz. MeMento untersucht die Verdichtung relevanter
multimodaler Information anhand von Nutzerpräferenzen. CausalCache untersucht, wann
ältere Bildbelege innerhalb eines festen visuellen Budgets wieder in hoher Auflösung
bereitgestellt werden sollten. Diese Ergebnisse motivieren selektive Belegaufbewahrung
anstelle eines stetig wachsenden Rohverlaufs.
[LightMem-Ego](https://arxiv.org/abs/2607.11487),
[MeMento](https://arxiv.org/abs/2608.01456),
[CausalCache](https://arxiv.org/abs/2608.22577).

**Abgleich:** Multimodale Episoden und Bildschirmerfahrung sind in Architektur §30
bereits ausdrücklich zurückgestellt. Es wäre daher eine Neubewertung dieser
zurückgestellten Richtung. Dokument-Intake, Ereignisse und Provenienz liefern
Anschlüsse; dieses Rechercheergebnis aktiviert keine Aufnahmefunktion.

**Erster Versuch:** Ausschließlich ausdrücklich ausgewählte Bilder einer Aufgabe
übernehmen, etwa mehrere Designvarianten. Prüfen, ob zeitlich entfernte relevante
Details besser wiedergefunden werden als mit OCR, Kurzbeschreibung und aktuellem
Kontext allein. Speicherung, Löschung, lokale Verarbeitung und erlaubte Quellen sind
sichtbare Produktentscheidungen; Hintergrundaufnahme bleibt ein eigener Opt-in.

## Fortsetzbares Arbeitsgedächtnis über Sitzungen und Apps

**Produktidee:** Ein neuer Agent übernimmt offene Arbeit mit aktuellen Belegen:
welche Datensätze bereits bearbeitet wurden, welche Schritte noch ausstehen, welche
Annahme zuletzt geprüft wurde und welche Handlung noch keine Bestätigung hat. Der
übernommene Zustand wird mit der aktuellen Umgebung abgeglichen, bevor daraus
weitere Handlungen entstehen.

ATMem modelliert Informationen mitsamt ihrer Rolle und Bearbeitungsstatus. Dadurch
soll ein korrekter erinnerter Wert nicht versehentlich ein zweites Mal verarbeitet
werden. MemGUI-Bench richtet seine Evaluation auf Gedächtnisanforderungen über
Handlungen und Sitzungen aus. Das sind sinnvollere Vergleichsaufgaben für diese
Idee als ausschließlich Fragen über vergangenen Gesprächsinhalt.
[ATMem](https://arxiv.org/abs/2606.31612),
[MemGUI-Bench](https://arxiv.org/abs/2602.06075).

**Abgleich:** Working Memory §6.1, Zusagen #403, Recovery #404 und Koordination #409
enthalten bereits wesentliche Teile. Ein überprüfbarer Checkpoint über Clientwechsel
hinweg wäre eine Produktpräzisierung, kein vollständig neuer Gedächtnisbereich.
Temporärer Fortschritt bleibt Arbeitszustand und wird nicht als dauerhafte Lesson
gespeichert. [Issue 409](https://github.com/n0mad-ai/bastra-recall/issues/409).

**Erster Versuch:** Eine mehrstufige Aufgabe an einer unklaren Bestätigung unterbrechen,
Client wechseln und fortsetzen. Wiederholungen, verlorene Arbeit und zu prüfende
Zustände erfassen. Eine Übergabezusammenfassung dient als einfacher Vergleichsarm.

## Gelernte Vorgehensweisen vor ihrer Anwendung erproben

**Produktidee:** Recall schlägt eine gelernte Vorgehensweise vor und führt sie zuerst
in einer begrenzten nachgebildeten Umgebung aus. Der Nutzer sieht den erprobten Ablauf,
sein Ergebnis und die Bedingungen, unter denen er scheitert.

Agent World Model erzeugt ausführbare, datenbankgestützte Umgebungen für Tool-Agenten.
Seine Untersuchung liefert einen Ansatz für überprüfbare Zustandsübergänge, keine
Garantie, die tatsächliche Arbeitsumgebung korrekt abzubilden. Die Autoren nennen
Unterschiede zu realen Situationen und Grenzen der semantischen Prüfung explizit.
[Agent World Model](https://arxiv.org/abs/2602.10090).

**Abgleich:** Sandboxvergleich in #407, Replay #389 und geprüfte Handlungen #405 sind
bereits geplant. Ein aus konkreten Ereignissen abgeleitetes begrenztes Umgebungsmodell
wäre eine spätere Erweiterung dieser Prüfung. Es ersetzt weder echte Evidenz noch
Berechtigung und speichert simulierte Ereignisse nicht als Tatsachen.

**Erster Versuch:** Ein kleiner lokaler Datei-/Statusablauf mit deterministischen
Übergängen, absichtlichen Ausfällen und bekanntem Sollzustand. Prüfen, ob die Probe
Fehler findet, die ein gewöhnlicher Dry-run übersieht. Ein umfassender persönlicher
Digital Twin wäre dafür kein notwendiger erster Schritt.

## Bessere Methoden innerhalb der vorhandenen Planung

ReasoningBank destilliert Strategien aus erfolgreichen und fehlgeschlagenen
Erfahrungen. Agent Workflow Memory leitet wiederverwendbare Abläufe ab. CA3Mem
untersucht die Neukombination von Erfahrungen in einem Graphen. Für Recall sind
sie methodische Kandidaten für #396/#407 und C-096s Querverbindungen. Die Bestätigung
von Fakten und Regeln bleibt dabei im bestehenden Reviewprozess.
[ReasoningBank](https://arxiv.org/abs/2509.25140),
[Agent Workflow Memory](https://arxiv.org/abs/2409.07429),
[CA3Mem](https://ojs.aaai.org/index.php/AAAI/article/view/38300).

ACE entwickelt Kontext als inkrementell gepflegtes Playbook. MemEvolve untersucht
zusätzlich die Anpassung der Gedächtnisarchitektur. ACE-GraphRAG wählt die
Zusammenstellung von Kontext anhand von Aufgabe und Graphstruktur. Das liefert
Ideen für #389/#390/#391/#399; ein neuer autonomer Optimierer würde deren
Zuständigkeiten duplizieren. Verbesserungsvorschläge müssen gegen einen festgehaltenen
Vergleich und zurückgehaltene Aufgaben geprüft werden.
[ACE](https://arxiv.org/abs/2510.04618),
[MemEvolve](https://proceedings.mlr.press/v306/zhang26fa.html),
[ACE-GraphRAG](https://arxiv.org/abs/2608.01269).

Lokales Fine-Tuning ist bereits in #1128 als eigene, auf Daniels Instanz begrenzte
Untersuchung erfasst. MemOS liefert einen Vergleich für unterschiedliche
Gedächtnisrepräsentationen, aber keine Begründung, dieses Vorhaben neu anzulegen
oder jetzt auf alle Nutzer auszuweiten.
[Issue 1128](https://github.com/n0mad-ai/bastra-recall/issues/1128).

## Welche nächste Diskussion am meisten verspricht

| Richtung | Gegenüber unserem Plan | Einschätzung |
|---|---|---|
| Entscheidungen mit Dokumenten, Code und Tests verbinden | Vorhandene Teile; die durchgehende belegte Produktkette fehlt | Stärkster Anschluss an Graphify und C-096 |
| Gezielter Wissenserwerb durch nützliche Fragen | Neuer Auswahlmechanismus auf vorhandenen Lücken-/Capture-Bausteinen | Stärkster unmittelbarer Hebel gegen Wiedererklären |
| Selektives visuelles Gedächtnis | Bereits zurückgestellt, erneut zu bewerten | Großer Sprung für persönliche Assistenz; eigenen kleinen Versuch wert |
| Fortsetzbare Arbeitszustände | Überwiegend geplant; Clientwechsel präzisieren | Hoher praktischer Nutzen, wenig Grund für einen neuen Featurebereich |
| Erprobung in einer begrenzten nachgebildeten Umgebung | Sandbox/Replay geplant; Umgebungsmodell ergänzbar | Interessante spätere Richtung, höherer Aufwand |
| Architekturlernen, Playbooks und lokales Fine-Tuning | Bestehende Workstreams | Methoden vergleichen und vorhandene Issues schärfen |

Meine Priorität für unsere nächste Diskussion ist die Kombination der ersten beiden
Richtungen. Recall könnte erklären, warum etwas existiert und welche Folgen eine
Änderung hätte, und gezielt die eine Information erfragen, die für eine tragfähige
Entscheidung noch fehlt. Für eine dritte, deutlich größere Produktrichtung würde ich
das selektive visuelle Gedächtnis diskutieren.

Als Erfolgskriterium schlage ich vor: Weniger Wiedererklärungen und wiederholte Fehler,
bessere nachvollziehbare Entscheidungen und geringerer Aufwand für Übergaben. Diese
Wirkung müsste im Alltag gegen vorhandenes Recall, lange Kontexte und einfache
Zusammenfassungen geprüft werden. Ein weiteres Tool, das angeboten, aber nicht im
richtigen Moment genutzt wird, genügt dafür nicht; #666 und #1119 behandeln genau die
Zustellungs- und Befolgungsfrage.

## Primärquellen und ihre Rolle

| Quelle | Rolle für diese Bewertung |
|---|---|
| [Graphify](https://github.com/Graphify-Labs/graphify) | Upstream-Fähigkeiten und Trennung extrahierter/erschlossener Beziehungen |
| [Hindsight](https://arxiv.org/abs/2512.12818) | Zeit-/Entity-Struktur und reflektierende Synthese |
| [MemOS](https://arxiv.org/abs/2507.03724) | Unterschiedliche Gedächtnisformen und Lebenszyklen |
| [EvoMemBench](https://arxiv.org/abs/2605.18421) | Vergleich von Wissen, Ausführung und langen Kontexten |
| [Value of Information](https://arxiv.org/abs/2601.06407) | Nutzen und Kosten einer Rückfrage |
| [REVOIR](https://arxiv.org/abs/2609.37588) | Fragen versus Handeln unter möglicher späterer Korrektur |
| [Learning to Clarify](https://arxiv.org/abs/2610.04719) | Menschliche Evaluation; auf Bildrekonstruktion begrenzt |
| [LightMem-Ego](https://arxiv.org/abs/2607.11487) | Zeitlich geordnetes persönliches Audio-/Bildgedächtnis |
| [MeMento](https://arxiv.org/abs/2608.01456) | Präferenzbezogene multimodale Verdichtung |
| [CausalCache](https://arxiv.org/abs/2608.22577) | Gezielte Wiederherstellung älterer Bildbelege |
| [ATMem](https://arxiv.org/abs/2606.31612) | Werte mit Rolle und Bearbeitungsstatus |
| [MemGUI-Bench](https://arxiv.org/abs/2602.06075) | Gedächtnislastige GUI-Aufgaben über Sitzungen hinweg |
| [Agent World Model](https://arxiv.org/abs/2602.10090) | Ausführbare synthetische Tool-Umgebungen und ihre Grenzen |
| [ReasoningBank](https://arxiv.org/abs/2509.25140) | Strategien aus Erfolgen und Fehlschlägen |
| [Agent Workflow Memory](https://arxiv.org/abs/2409.07429) | Ableitung wiederverwendbarer Abläufe |
| [CA3Mem](https://ojs.aaai.org/index.php/AAAI/article/view/38300) | Neukombination und assoziativer Abruf von Erfahrungen |
| [ACE](https://arxiv.org/abs/2510.04618) | Inkrementell gepflegte Kontext-Playbooks |
| [MemEvolve](https://proceedings.mlr.press/v306/zhang26fa.html) | Anpassung der Gedächtnisarchitektur |
| [ACE-GraphRAG](https://arxiv.org/abs/2608.01269) | Aufgabenbezogene Kontextzusammenstellung im Graphen |
| [Chain-of-Memory](https://arxiv.org/abs/2506.18158) | Expliziter Aufgaben-/Bildschirmkontext bei Appwechseln; ergänzender Vergleich zur Fortsetzung |
