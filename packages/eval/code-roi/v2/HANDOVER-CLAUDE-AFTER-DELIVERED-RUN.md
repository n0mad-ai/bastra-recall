# Handover an Claude — Code-Awareness nach dem Zustellungs-Lauf

Stand: 20.09.2026  
Branch: `feat/hook-delivered-impact`  
HEAD des gemessenen Builds: `973c6b8c496d9b2d34f12e1143f69485162ffc53`  
PRs: #582 (Graph/Tool-Grundlage), #607 (automatische Zustellung, Draft)

## Kurzurteil

Graphify funktioniert als technische Abhängigkeitsquelle, aber die aktuelle
automatische Prompt-Zustellung erzeugt auf der registrierten Population keinen
nachweisbaren Agentennutzen.

- Der Zustellungs-Lauf ist vollständig: 44/44 Szenarien, 132/132 Arme,
  0 Abbrüche, 0 gemischte Builds, 14,615435 USD Rechenwert.
- Kontexturteil: `underpowered`. Nur 19 statt 37 A/D-Paare lösten die Aufgabe
  in beiden Armen mit Recall >= 0,8.
- Nutzungsurteil: `fail`. Die Überlappungsschwelle und der Präzisionsboden
  wurden erreicht, der Recall-Guard nicht.
- Arm A und D haben dieselbe Blocküberlappung: 0,54054. D minus A = 0.
- D spart über alle 44 Szenarien nur 1,845 % Median-Kontext; dieser Wert ist
  nicht registriert gesichert.

Das ist kein Beweis, dass Graphify nutzlos ist. Es ist ein Befund gegen die
aktuelle Produktintegration: Ein ungefragt vorangestellter Kandidatenblock
macht den Agenten nicht messbar besser.

## Autoritative Endzahlen

| Kennzahl | A: Grep | D: zugestellter Block | P: volle Graph-Antwort |
| --- | ---: | ---: | ---: |
| Recall | 46,92 % | 45,78 % | 48,05 % |
| Präzision | 37,18 % | 39,30 % | 39,56 % |
| Median Input-Tokens | 66.080,5 | 64.861,5 | 77.941,5 |

Weitere Werte:

- D − A Recall: −1,14 Prozentpunkte; Cluster-KI
  `[−6,67 Pp; +2,31 Pp]` -> Recall-Guard `fail`.
- D − A Präzision: +2,12 Prozentpunkte -> Guard bestanden.
- Blocknutzung D: 20/37 = 54,05 % -> Schwelle 50 % bestanden.
- Kontrollüberlappung A mit denselben Blockdateien: ebenfalls 20/37 = 54,05 %.
- Inkrementelle Überlappung D − A: 0.
- Kontext auf 19 beidseitig gelösten Paaren: D/A `0,84058`, aber KI
  `[0,72850; 1,47389]` -> nicht gesichert.
- Kontext über alle 44: D/A `0,98155` -> 1,845 % beobachtete Ersparnis.
- P gegen A Recall: +1,14 Pp, ungegated.
- P gegen D Kontext: `1,20166` -> volle Antwort ca. 20 % teurer als D.

Rohbericht:
`~/.bastra/eval/code-roi-delivered-recall-v2/report.json`

## Was du jetzt tun sollst

### 1. Messung unveränderlich abschließen

1. `packages/eval/registrations/code-awareness-delivered.json` auf
   `run_completed` setzen und einen `result`-Block aus dem Report ergänzen.
2. In `packages/eval/code-roi/v2/BEFUND.md` einen Abschnitt für Registrierung
   v3 / Zustellungs-Lauf ergänzen.
3. Exakt festhalten: Kontext `underpowered`, Nutzung `fail`. Kein kombiniertes
   Fantasieurteil bilden.
4. Keine Schwelle, Population, Clusterregel oder Wahrheitsdefinition nach dem
   Lauf verändern.
5. Build-Pin `08f115ad…`, Commit `973c6b8`, 44/44, 132 Arme, 0 Abbrüche und
   14,615435 USD dokumentieren.

### 2. PR #582 und PR #607 auseinanderhalten

Empfehlung:

- **PR #582 behalten/mergen:** Graphify-Index, Paketgrenzenauflösung,
  `find_affected_files`, Refresh/Locks, Limits, Telemetrie und Diagnose sind
  weiterhin eine wertvolle technische Grundlage.
- **PR #607 nicht als ungefragte Prompt-Automatik standardmäßig aktivieren.**
  Der registrierte Lauf rechtfertigt das nicht.
- Prompt-Zustellung entweder entfernen, standardmäßig deaktivieren oder hinter
  einen expliziten experimentellen Schalter stellen.
- Den symbolbasierten Write/Edit-Block getrennt behandeln. Dieser Lauf misst
  die UserPromptSubmit-Lane, nicht den Nutzen eines Blocks während eines echten
  Edits. Nicht aus dem Prompt-Fail automatisch auf den Edit-Hook schließen.
- `find_affected_files` als explizites Werkzeug behalten, aber nicht mit
  großer Kontext- oder Recall-Wirkung bewerben.

### 3. Produktkommunikation korrigieren

Keine Aussage wie „spart deutlich Kontext“ oder „findet mehr Dateien“.
Zulässig ist:

> Recall kann Graphify-Abhängigkeiten als Kandidaten bereitstellen. Auf den
> bisherigen Agentenmessungen ist ein zusätzlicher Nutzen gegenüber Grep nicht
> nachgewiesen.

### 4. Folgethemen als Issues führen

- Testdateien werden in `displayOrder()` nach hinten sortiert und können am
  Zehnerdeckel verschwinden.
- Mehrere eindeutige Symbole aus verschiedenen Dateien führen weiterhin zu
  Stille (#608); nicht per Mehrheitsdatei raten.
- Kandidatenzahl > 40 wird im Block wie eine exakte 40 dargestellt.
- Graph-Blindstellen: Typfluss (`require-field` 3/6), HTTP-/Event-/String-
  Verträge und Reflexion.
- Prüfen, ob der Write/Edit-Block ein eigenes Real-Session-Experiment verdient.

## Was du ausdrücklich nicht tun sollst

- Den Lauf erneut starten, um ein angenehmeres Ergebnis zu bekommen.
- Kontext auf allen 44 nachträglich zum registrierten Kontexturteil erklären.
- Die 37er-Mindestwerte oder die Recall-Untergrenze nach dem Ergebnis lockern.
- P als erfolgreichen Treatment-Arm darstellen; P war nur diagnostisch und
  nie gegatet.
- Prompt- und Write/Edit-Lane in einem Urteil vermischen.

## Verifikation des Laufs

- Szenarien: 44/44
- Arme: 132/132
- Abbrüche: 0
- `mixed_builds`: false
- Registrierung: `code-awareness-delivered`, Version 3
- Modell: `claude-sonnet-5`, max. 30 Turns
- Graphify: 0.9.63
- Cluster: 22 transitive Komponenten gemeinsamer Wahrheitsdateien

