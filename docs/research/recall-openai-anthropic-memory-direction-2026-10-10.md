# OpenAI und Anthropic als Wettbewerber und Partner für Recall

Stand 10. Oktober 2026. Beide Anbieter entwickeln bereits dauerhafte Erinnerungen
und persönliche beziehungsweise arbeitsbezogene Agenten. Die Annahme, sie hätten
noch kein vergleichbares Gedächtnis, ist zu weitgehend. Einige öffentlich beschriebene
Mechanismen überschneiden sich deutlich mit Recall; ein Qualitätsvergleich auf
identischen Aufgaben steht aus.

## Was OpenAI bereits beschreibt

**ChatGPT und Codex haben Gedächtnisfunktionen mit unterschiedlichen Speichern.**
Die aktuelle Dokumentation unterscheidet ChatGPT-Memory von lokalen Codex-Memories.
Codex kann aus geeigneten abgeschlossenen Chats Dateien mit dauerhaftem Kontext und
Belegen erzeugen und im Hintergrund konsolidieren. Diese lokale Dateiablage ist daher
kein sicherer exklusiver Unterschied von Recall.
[Memories](https://learn.chatgpt.com/docs/customization/memories).

**Computer History verbindet erlaubte Computeraktivität mit Erinnerungen und einer
Timeline.** Die Funktion arbeitet auf macOS mit Interaktionsereignissen und
Accessibility-Kontext, erzeugt lokale Markdown-Erinnerungen und kann wiederkehrende
Abläufe als Skills oder Automationen vorschlagen. Sie enthält keine Screenshots oder
Audioaufnahmen. Ereignisse werden zur Zusammenfassung bei OpenAI verarbeitet; lokale
Speicherung bedeutet hier nicht durchgehend lokale Verarbeitung.
[Computer History](https://learn.chatgpt.com/docs/customization/computer-history).

**Dots ergänzt langfristige Verantwortung.** Neben relevantem ChatGPT-Kontext führt
ein Dot eigene Notizen über Vorlieben, Entscheidungen und laufende Arbeit. Diese sind
nicht identisch mit den gespeicherten ChatGPT-Erinnerungen. Zugewiesene Arbeit kann
zwischen Gesprächen fortgesetzt werden; über Sprache kann man sie besprechen.
[Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory),
[Dots Voice](https://learn.chatgpt.com/docs/dots/channels).

**Auch für Entwickler ist das Gedächtnisprinzip ausdrücklich vorgesehen.** Ein
OpenAI-Cookbook zeigt lokale strukturierte Profile und Notizen, Erfassung während
eines Laufs, Konsolidierung und selektive Kontextinjektion. Das ist ein dokumentiertes
Entwicklungsmuster und keine Aussage, dass ChatGPT intern exakt so implementiert ist.
[Context Personalization](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization).

## Was Anthropic bereits beschreibt

**Claude-Memory besteht inzwischen aus einzelnen Themen.** Es wird während der
Gespräche aktualisiert; Nutzer können Einträge ansehen, ändern und löschen. Chats und
Cloud-Cowork können dasselbe Gedächtnis verwenden. Projekte besitzen eigene
Gedächtnisbereiche. Lokale Cowork-Sitzungen verwenden diese Cloud-Memory-Verbindung
laut Dokumentation nicht. Chat-Suche und Gedächtnis sind getrennte Funktionen.
[Claude Chat Search and Memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context).

**Import und Export existieren bereits.** Der Import kann Informationen anderer
Assistenten in einzelne Claude-Einträge überführen und ist ausdrücklich experimentell.
Diese Möglichkeit belegt Migration, nicht kontinuierliche verlustfreie Synchronisierung
aller Anbieter. Portabilität allein als Schlagwort wäre deshalb ebenfalls zu wenig.
[Memory Import and Export](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude).

**Das API-Memory-Tool verwendet Speicher unter Kontrolle der Anwendung.** Claude
fordert Dateioperationen an, die die Anwendung auf eigener Infrastruktur ausführt.
Diese API-Funktion ist von der Memory-Funktion des Claude-Chatprodukts zu unterscheiden.
[Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).

**Claude Managed Agents kommt dem gemeinsamen Agentengedächtnis besonders nahe.**
Anthropic beschreibt exportierbare Dateien, einen Store für mehrere Agenten,
Zugriffsrechte, Audit-Logs mit Herkunft aus Agent und Sitzung sowie Rollback. Das sind
konkrete Überschneidungen mit Recall. Die berichteten Kundeneffekte sind
Anbieterangaben und werden hier nicht als unabhängiger Qualitätsbeleg übernommen.
[Managed Agents Memory](https://claude.com/resources/articles/claude-managed-agents-memory).

## Welche Richtung daraus erkennbar ist

Meine Schlussfolgerung aus diesen vorhandenen Funktionen: Die Produkte entwickeln
sich zu beständigen Agenten, die Kontext aus Gesprächen und zugelassenen Quellen
verwenden, Aufgaben ausführen und spätere Ergebnisse wieder in ihren Kontext aufnehmen.
OpenAI verbindet dies unter anderem mit Dots, lokalem Arbeitskontext und mehreren
Produktoberflächen. Anthropic verbindet Chat, Gedächtnis, Cloud-Arbeit, Connectoren
und kontrollierbare Agentenspeicher.

Das ist eine Ableitung aus veröffentlichten Mechanismen, keine Kenntnis interner
Roadmaps. Nicht öffentlich belegte künftige Eigenschaften dürfen weder als sicherer
Wettbewerbsvorteil von Recall noch als zugesagtes Feature der Anbieter gelten.

## Warum ihre Systeme nicht exakt wie Recall aufgebaut sind

Die internen Gründe und Prioritäten der Anbieter sind nicht öffentlich hinreichend
bekannt. Deshalb lässt sich die Frage nicht seriös mit „sie können es nicht“, „sie
haben es übersehen“ oder einer behaupteten Lock-in-Absicht beantworten.

Eine plausible Produktinterpretation ist, dass eine integrierte Assistentenoberfläche
und ein ausdrücklich verwalteter Wissensbestand unterschiedliche Schwerpunkte setzen:
reibungsloses Gespräch und Aufgabenabschluss einerseits; gemeinsame Datenbasis,
Herkunft, Zeit, Revisionen und Bereitstellung an verschiedene Clients andererseits.
Die Grenzen verlaufen jedoch nicht sauber zwischen den Anbietern: Die genannten
lokalen Dateien, clientseitigen Tools und Managed-Agent-Stores bieten schon mehrere
Eigenschaften der zweiten Gruppe.

Dauerhafte Erinnerung verlangt zudem Entscheidungen darüber, was aufgenommen wird,
wie Änderungen behandelt werden, welcher Kontext wann zugestellt wird und wie Nutzer
korrigieren. Das bloße Speichern einer Notiz beantwortet diese Fragen nicht. Codex-
Dokumentation zeigt etwa eine zeitversetzte Hintergrundverarbeitung und Quotenregeln;
Claude dokumentiert direkte Themenupdates und eigene Memory-Kontrollen. Die konkreten
Produktentscheidungen sind beobachtbar, ihre vollständigen internen Begründungen nicht.

## Was das für Recalls Geschäft bedeutet

Ein allgemeiner persönlicher Sprachassistent mit einigen gespeicherten Vorlieben
steht in direktem Wettbewerb mit großen integrierten Produkten. Er kann weiterhin
nützlich sein, aber ein Marktversprechen braucht einen nachvollziehbaren eigenen
Vorteil. Dasselbe gilt für Markdown, lokale Ablage, Import/Export oder gemeinsamen
Agentenspeicher: Diese Eigenschaften sind für sich genommen nicht exklusiv.

Für Recall sollten wir stattdessen konkrete Kombinationen und Wirkungen prüfen:

- Einen kanonischen, vom Nutzer kontrollierten Bestand bei tatsächlicher Nutzung
  mehrerer Anbieter und Clients konsistent halten.
- Herkunft, historische Gültigkeit, Konflikte und bestätigte Änderungen verständlich
  zeigen; vorhandene Teilfunktionen von geplanten V2-Funktionen unterscheiden.
- Korrekturen im passenden Handlungsmoment zuverlässig bereitstellen und Wiederholung
  auf beobachteten relevanten Gelegenheiten messen.
- Eigene Alltags- und Erlebnisprodukte schaffen, deren Wert über gespeicherte
  Vorlieben hinausgeht, etwa persönliche Wiki-/Sprachabläufe oder kreative Kontinuität.

Das sind mögliche Wettbewerbshypothesen, keine belegte Überlegenheit. Ein Vergleich
muss Recall, native Memory-Funktionen und einfache Alternativen auf denselben Aufgaben,
mit vergleichbaren Quellen, Berechtigungen und Budget testen.

OpenAI kann außerdem ein Integrationspartner sein: Sign in with ChatGPT erlaubt
berechtigten Nutzern in unterstützten Apps die Nutzung ihres Plans. Die Einführung
ist auf bestimmte Kategorien und ausgewählte private Apps begrenzt; daraus folgt
keine pauschale Berechtigung für eine kommerzielle Recall-App oder kostenloses Voice.
[Sign in with ChatGPT](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).

## Umgang mit bisherigen Recherchen

Frühere Berichte bleiben als datierte Recherche erhalten. Ihre Annahmen über
Einzigartigkeit müssen vor Verwendung in einem Pitch gegen diesen neueren offiziellen
Funktionsstand geprüft werden. Insbesondere sind „lokale Dateien“, „Gedächtnis über
Chats“, „Import/Export“ und „Agenten lernen aus vergangenen Sitzungen“ inzwischen
keine belastbaren alleinigen Alleinstellungsmerkmale.

Dieser Bericht ändert keine Produktentscheidung und weist keine interne Roadmap
nach. Er dokumentiert öffentliche Überschneidungen und daraus abgeleitete Fragen
für unsere nächste Positionierungs- und Vergleichsrunde.
