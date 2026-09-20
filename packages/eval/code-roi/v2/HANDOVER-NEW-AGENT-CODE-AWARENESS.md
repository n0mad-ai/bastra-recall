# Auftrag für einen neuen Agenten — Warum hilft Graphify dem Agenten noch nicht?

Du bekommst eine abgeschlossene, negative Messung. Deine Aufgabe ist zunächst
**Analyse und Ideengenerierung**, nicht sofortige Implementierung.

## Ziel

Finde heraus, welche Produkt- oder Graphänderung dafür sorgen könnte, dass
Graphify bei „Was bricht, wenn ich diese Datei ändere?" einen echten Vorteil
gegenüber Grep liefert — entweder bessere Antworten, zuverlässig weniger
Kontext oder beides.

## Gesicherter Stand

### Graphify kann technisch richtige Beziehungen liefern

- Synthetisches Mechanismus-Gate für Namens-/Aufrufbrüche: 15/15 bestanden.
- Typfluss `require-field`: nur 3/6; bekannte Modellgrenze.
- Symbolbasierte Offline-Abfrage auf verbrannten Entwicklungsdaten:
  96,6 % Recall, 47,4 % Präzision, 42/44 vollständig.

Diese Zahlen belegen Mechanik, nicht Agentennutzen.

### Agentenmessungen

1. **v3, angebotenes `find_code`, bastra-recall:** 0/44 Toolnutzungen;
   Recall +0,8 Pp, nicht signifikant.
2. **v6, `find_affected_files`, bastra-io:** Adoption 32/40 = 80 %, aber alle
   Arme bereits 100 % Recall; kein Effekt. Prefill 4,3 % weniger Kontext,
   Tool-Arm 2,37x so viele Median-Input-Tokens wie Grep.
3. **Zustellungs-Lauf, bastra-recall tests/v2:** D Recall 45,78 % gegen A
   46,92 %; D Präzision 39,30 % gegen A 37,18 %; D/A Kontext über alle
   Szenarien 0,98155. Nutzung fail, Kontext underpowered.

## Auffälligkeiten, die du erklären sollst

1. Nur 15 von 37 zugestellten Blöcken enthalten überhaupt eine Wahrheitsdatei.
2. Testdateien werden im Produkt ans Ende sortiert; der Block kappt nach
   10 Dateien. In dieser Population sind Testdateien die Wahrheit.
3. D und A nennen gleich häufig mindestens eine Datei aus dem Block
   (20/37). Die Zustellung erzeugt keinen inkrementellen Überlappungswert.
4. Die volle Graph-Antwort P verbessert Recall nur um 1,14 Pp gegenüber A,
   kostet aber deutlich mehr Kontext.
5. Sieben von 44 Prompts erzeugen keinen Block.
6. Acht von 44 Szenarien sind bekannte statische-Graph-Blindstellen.
7. Nur 19 A/D-Paare erreichen Recall >= 0,8 in beiden Armen. Die Aufgabe ist
   für beide Verfahren schwer; das Kontexturteil wird dadurch underpowered.
8. Der Graph modelliert Importe/Aufrufe gut, aber nicht Typfluss,
   HTTP-Routen, Eventnamen, String-Verträge, Reflexion oder Laufzeitregister.

## Fragen, die du beantworten sollst

1. Ist das Hauptproblem **Graphabdeckung**, **Ranking/Blockinhalt**,
   **Zustellzeitpunkt**, **Agentenverhalten** oder die Kombination?
2. Welche Information müsste der Agent bekommen, damit er tatsächlich eine
   zusätzliche richtige Datei findet, statt nur einen Kandidatenblock zu sehen?
3. Sollte Recall Text zustellen, Suchschritte steuern oder automatisch eine
   Graph+Grep-Analyse ausführen und nur das verdichtete Ergebnis liefern?
4. Wie lässt sich die schlechte Präzision verbessern, ohne Recall zu verlieren?
5. Sollten Tests bei „was bricht" höher gerankt werden als Produktionsimporte?
6. Welche zusätzlichen Kanten wären am wertvollsten: Typfluss, Routen,
   Events, Konfigurationsschlüssel oder Test-zu-Subjekt-Beziehungen?
7. Kann der Agent aus Relation, Quellzeile und Symbol einen besseren nächsten
   Suchschritt bekommen als aus einer bloßen Dateiliste?

## Denkbare Richtungen — nicht als Vorgabe

- Graph nicht als Textblock zeigen, sondern intern eine begrenzte Grep-/Read-
  Strategie daraus ableiten.
- Kandidaten nach Änderungsart und Nutzerfrage ordnen: Tests bei
  Test-/Breakage-Fragen hoch, Produktion bei Implementierungsfragen hoch.
- Nur Kandidaten zustellen, für die Graphkante plus Textbeleg vorliegen.
- Einen kombinierten Resolver bauen: Graphkanten + Symbol-Grep + Route/Event-
  Literale + TypeScript-Diagnostik.
- Den Block als kleine Beweiskette statt Liste formulieren:
  „Symbol X geändert -> Datei Y ruft X in Zeile Z auf".
- Prompt-Lane und Write/Edit-Lane unterschiedlich behandeln.
- Für Mehrdatei-/Mehrsymbolfragen mehrere begrenzte Teilantworten statt
  Mehrheitsraten.
- Graphify um ausgewählte Contract-Kanten ergänzen, statt jede statische
  Beziehung modellieren zu wollen.

## Arbeitsweise und Grenzen

- Lies zuerst:
  - `packages/eval/code-roi/v2/CODE-AWARENESS-MEASUREMENTS.md`
  - `packages/eval/code-roi/v2/BEFUND.md`
  - `packages/eval/registrations/code-awareness-delivered.json`
  - `~/.bastra/eval/code-roi-delivered-recall-v2/report.json`
- V3-, v6- und delivered-Populationen sind verbrannt. Nicht auf ihren
  Einzelresultaten optimieren.
- Keine Schwelle nachträglich ändern und keinen bestehenden Report umdeuten.
- Zunächst keine Produktänderung committen.
- Liefere 3–5 priorisierte Lösungsansätze. Für jeden:
  - vermutete Ursache,
  - konkrete Änderung,
  - erwarteter Effekt auf Recall/Präzision/Kontext,
  - Risiken und Blindstellen,
  - kleinstes billiges Experiment,
  - Kriterium, bei dem der Ansatz verworfen wird.
- Bevorzuge einen kleinen offline überprüfbaren Mechanismustest vor einem
  weiteren bezahlten Agentenlauf.

## Gewünschtes Endergebnis

Eine Empfehlung, welche **eine** Richtung als Nächstes gebaut werden sollte,
welche Teile von PR #607 dafür behalten werden und welche abgeschaltet bleiben.

