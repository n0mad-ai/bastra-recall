# Code-Awareness / Graphify — vollständiges Messdossier

Stand: 20.09.2026

Dieses Dokument fasst die registrierten Agentenläufe, Offline-Gates,
Populationen, Repositories und Schlussfolgerungen zusammen. Autoritative
Maschinendaten bleiben die jeweiligen `report.json`- und Registrierungsdateien.

## 1. Ergebnis in einem Satz

Graphify bildet wichtige Import- und Aufrufabhängigkeiten technisch ab, aber
weder das angebotene Werkzeug noch die aktuelle automatische Prompt-Zustellung
haben bisher einen zusätzlichen Agentennutzen gegenüber Grep nachgewiesen.

## 2. Produkt und Messcode

- Projekt: `bastra-recall`
- Repository: `n0mad-ai/bastra-recall`
- Graphify-Version in allen aktuellen Läufen: `0.9.63`
- Hauptbranch der Grundlage: `feat/572-code-awareness`, PR #582
- Zustellungsbranch: `feat/hook-delivered-impact`, PR #607
- Gemessener Zustellungs-Build:
  `973c6b8c496d9b2d34f12e1143f69485162ffc53`
- Modell: `claude-sonnet-5`
- Maximal 30 Turns pro Arm
- Agentenwerkzeuge in den isolierten Armen: Read, Grep, Glob; kein Bash,
  kein Edit, kein Web, keine Subagenten
- Graphify- und Wahrheitspfad laufen außerhalb des Agenten-Checkouts.

Zentrale Dateien:

- `packages/eval/code-roi/v2/run-arms-v3.mjs`
- `packages/eval/code-roi/v2/evaluate-v4.mjs`
- `packages/eval/code-roi/v2/evaluate-delivered.mjs`
- `packages/eval/code-roi/v2/test-truth.mjs`
- `packages/eval/registrations/code-awareness-change-impact.json`
- `packages/eval/registrations/code-awareness-delivered.json`

## 3. Messung v3 — `find_code` angeboten

### Frage

Nennt ein Agent mit angebotenem `find_code` mehr Dateien, die nach einer
historischen Änderung Typfehler tragen, als ein Agent mit Grep/Read allein?

### Population und Repository

- Repository: `bastra-recall`
- Historische Änderungen bis `5483f56`
- 45 Szenarien ausgewählt, 44 ausgewertet; ein Artefakt ausgeschlossen
- Wahrheit: neue TypeScript-Fehler nach Anwendung genau eines Datei-Diffs
- 88 frische Agentenläufe, zwei Arme
- Archiv: `~/.bastra/eval/code-roi-v2/`
- Registrierung: `code-awareness-roi.json`, Version 3
- Kosten: 13,15 USD Rechenwert

### Ergebnis

| Kennzahl | Ohne Graph | `find_code` angeboten | Differenz/Urteil |
| --- | ---: | ---: | --- |
| Recall | 89,39 % | 90,15 % | +0,76 Pp; Schwelle +10 Pp -> fail |
| Präzision | 91,57 % | 89,30 % | −2,27 Pp; Boden eingehalten |
| Recall-KI |  |  | `[0; +2,27 Pp]`; Untergrenze nicht > 0 |
| Kontext-Gate |  | `0,772x` | eingehalten |
| `find_code` genutzt |  | 0/44 | zentraler Befund |

Interpretation: Der Agent benutzte das Tool nie. Beide Arme arbeiteten
praktisch mit Grep/Read; der kleine Unterschied ist kein Graph-Effekt.

### Offline-Diagnose auf derselben, danach verbrannten Population

| Abfrage | Recall | Präzision | Vollständig |
| --- | ---: | ---: | ---: |
| Dateibasierter Graph | 87,4 % | 43,5 % | 36/44 |
| Symbolbasiert, Tiefe 1 | 91,3 % | 52,4 % | 39/44 |
| Symbolbasiert, Tiefe 2 | 95,8 % | 33,0 % | 41/44 |
| Symbol Tiefe 1 plus Grep | 95,5 % | 53,1 % | 42/44 |
| Symbol Tiefe 2 plus Grep | 100 % | 33,5 % | 44/44 |

Diese Zahlen sind Entwicklungsdiagnostik, kein Wirksamkeitsnachweis.

## 4. Messung v6 — `find_affected_files` angeboten und vorbefüllt

### Frage

Getrennte Urteile:

1. Adoption: Ruft der Agent `find_affected_files` freiwillig auf?
2. Wirkung: Verbessert eine vorbefüllte Graphantwort Recall bei vertretbarer
   Präzision und vertretbarem Kontext?

### Population und Repository

- Repository: `/Users/n0mad/Projekte/bastra-io`
- TypeScript-pnpm-Monorepo, 17 Pakete unter `@bastra`
- 194 Non-Merge-Commits, 452 TS/TSX-Dateien zum Mining-Zeitpunkt
- 40 historische, von Hand adjudizierte Szenarien
- Wahrheit: neue TypeScript-Fehler nach einem Datei-Diff
- Arme: A = Grep, B = Produktoberfläche angeboten, `prefilled` = volle
  Graphantwort ohne MCP-Oberfläche
- 120 Agentenarme
- Archiv: `~/.bastra/eval/code-roi-v4-bastra-io/`
- Registrierung: `code-awareness-change-impact.json`, Version 6
- Build: `389c0ff56f92fa04cfc10d27897d08e912175382`
- Build-Pin: `3165f078…`, keine gemischten Builds
- Kosten: 5,5023842 USD

### Ergebnis

| Kennzahl | A: Grep | B: angeboten | Prefilled |
| --- | ---: | ---: | ---: |
| Recall | 100 % | 100 % | 100 % |
| Präzision | 84,75 % | 85,67 % | 84,54 % |
| Median Input-Tokens | 24.616,5 | 58.308,5 | 23.564 |

- Adoption: 32/40 = 80 % -> Schwelle 70 %, `pass`.
- `find_code`: 0 Aufrufe; zählte nicht zur Adoption.
- Wirkung: Recall-Gewinn Prefilled − A = 0; KI `[0;0]` -> `fail`.
- Präzisionsverlust Prefilled − A = −0,21 Pp -> Guard bestanden.
- Kontext Prefilled/A = `0,95724` -> 4,28 % beobachtete Ersparnis.
- B/A Median-Kontext = ca. `2,37x`; Tooloberfläche war deutlich teurer.

Interpretation: Die optimierte Beschreibung erreicht Adoption in frischen
Messsitzungen. Die Population war aber zu leicht: Grep hatte bereits 100 %
Recall. Ein zusätzlicher Wirkungsnachweis war arithmetisch unmöglich.

## 5. Zustellungs-Messung — automatische Prompt-Lane

### Frage

Hilft ein ungefragt vor der ersten Suche zugestellter Produktblock dem Agenten,
dieselbe Aufgabe mit weniger Kontext und ohne Recall-/Präzisionsverlust zu
lösen?

### Population und Mining

- Repository: `/Users/n0mad/Projekte/bastra-recall-hook`
- Mining-HEAD:
  `c0667f1d7ee3a61b179a94bdc4fd91d60e218293`
- 887 Non-Merge-Commits und 180 unterschiedliche Kandidatendateien nach den
  Ausschlüssen zum Mining-Zeitpunkt
- 1.000 Kandidaten vollständig entschieden
- 44 akzeptierte Szenarien aus 32 Commits
- Pakete: 42 `packages/daemon`, 2 `packages/core`
- Wahrheit: `tests/v2`; eine Testdatei ist Wahrheit, wenn dieselbe Case-ID
  sauber besteht, mutiert zweimal fehlschlägt und sauber erneut besteht
  (A-B-B-A)
- Wahrheit ausschließlich aus Tests: 44; keine Typwahrheit in der Population
- Wahrheitsgröße: 34x eine, 6x zwei, 3x drei, 1x sieben Dateien
- Blindstellen: 8/44 = 18,18 %
- Ausschlüsse: 52 verbrannte Dateien aus früheren Populationen, zwei
  Pilot-Commits, `packages/daemon/src/code-graph/`, `packages/eval/`
- Population-Hash: `00042d158dd12496a5051f524f91bfc0375e3c800b942724d48e1067ba336ca6`
- Ausschluss-Hash: `df87de2c3566d64b890620a4c4f8eb52fdc2bf1f15077b998b38c1b0d3ad8318`
- Archiv: `~/.bastra/eval/code-roi-delivered-recall-v2/`

CarNexus wurde als Population geprüft, aber verworfen: `tests/` ist dort
gitignored und es existieren im historischen Archiv keine getrackten Tests,
also keine reproduzierbare tests/v2-Wahrheit. Code-Awareness wurde unabhängig
davon für CarNexus aktiviert; sein lokaler Graph umfasste 792 Dateien und
6,0 MB, ist aber kein Teil dieses Messlaufs.

### Wahrheitskonzentration und Cluster

- 35 unterschiedliche Wahrheitsdateien
- `session-assembler.test.ts`: in 15 Szenarien, 11-mal allein
- CLI-Help/Flag/Completion-Verbund: 8 Szenarien
- Log-Stats-Verbund: 2 Szenarien
- 19 Einzelcluster
- Insgesamt 22 transitive Wahrheits-Komponenten

Der Bootstrap resampelt diese 22 Komponenten, nicht 44 geänderte Dateien als
scheinbar unabhängige Antworten.

### Produktblock vor dem Lauf

- 37/44 Szenarien erhalten einen Block; 7 bleiben still
- Basis: 24 `symbols`, 13 `whole_file`
- Median 3 gelistete Dateien, Maximum 10
- Median 188 geschätzte Block-Token
- Nur 15/37 Blöcke nennen mindestens eine Wahrheitsdatei
- Testdateien werden im Produkt nach hinten sortiert und nach 10 Zeilen
  abgeschnitten; das blieb unverändert, damit das ausgelieferte Produkt
  gemessen wird

### Laufbedingungen

- Registrierung: `code-awareness-delivered.json`, Version 3
- Build: `973c6b8c496d9b2d34f12e1143f69485162ffc53`
- Build-Pin: `08f115ad…`
- Arme: A = Grep, D = echter `promptImpactNote()`-Block, P = volle
  `find_affected_files`-Antwort, nur diagnostisch
- 44 Szenarien, 132 Arme
- 0 Abbrüche, 0 fehlende Arme, keine gemischten Builds
- Kosten: 14,615435 USD, Deckel 40 USD
- Mindestwerte vor dem Lauf: 37 gelöste Kontextpaare und 37 beobachtete Blöcke

### Endergebnis

| Kennzahl | A: Grep | D: Zustellung | P: volle Antwort |
| --- | ---: | ---: | ---: |
| Recall | 46,92 % | 45,78 % | 48,05 % |
| Präzision | 37,18 % | 39,30 % | 39,56 % |
| Median Input-Tokens | 66.080,5 | 64.861,5 | 77.941,5 |

#### Kontexturteil: `underpowered`

- Nur 19 A/D-Paare erreichten in beiden Armen Recall >= 0,8; benötigt waren 37.
- D/A auf diesen 19: `0,84058`.
- 95-%-Cluster-KI: `[0,72850; 1,47389]`; obere Grenze < 1 verfehlt.
- D/A über alle 44, ungegated: `0,98155` -> 1,845 % beobachtete Ersparnis.

#### Nutzungsurteil: `fail`

- 37/37 mögliche Blöcke beobachtet.
- D-Blocküberlappung: 20/37 = 54,05 % -> Punktschwelle bestanden.
- A-Überlappung mit denselben Blockdateien: ebenfalls 20/37 = 54,05 %.
- Inkrementelle Überlappung D − A: 0.
- Präzision D − A: +2,12 Pp -> Guard bestanden.
- Recall D − A: −1,14 Pp.
- Recall-KI: `[−6,67 Pp; +2,31 Pp]`; Untergrenze >= 0 verfehlt.

#### Diagnostischer voller Arm P

- P − A Recall: +1,14 Pp, nicht gegatet und nicht gesichert.
- P/D Kontext: `1,20166`; die volle Antwort ist ca. 20 % teurer als D.

## 6. Offline-Mechanismus-Gates

Diese Gates prüfen, ob der Graph die mechanische Antwort enthalten kann; sie
prüfen keinen Agentennutzen.

- Historisch, paketübergreifend: 2/2 gefunden, aber `not_evaluable`, weil
  Mindest-n 8.
- Synthetisch gegatet:
  - `rename-export`: 10/10
  - `require-param`: 5/5
  - zusammen 15/15 -> `pass`
- `require-field`: 3/6, nur berichtet.
- Gesamt synthetisch: 18/21 = 85,7 %, nur berichtet.

Die drei Type-Flow-Fehler stammen aus `PublishInput`: Verbraucher bauen
Objektliterale, nennen den Typ aber weder in einer Import- noch Aufrufkante.

## 7. Latenz und reale Telemetrie

Aus dem ersten v3-Befund:

- Write/Edit-Lane ohne Code-Awareness: n=735, p50 56 ms, p90 86 ms
- mit Code-Awareness: n=11, p50 75 ms, p90 87 ms
- beide p90 unter dem 200-ms-Ziel; Vergleich wegen n=11 nicht wertbar
- automatische Hook-Befolgung damals nicht auswertbar: keine 50 echten Blöcke

Die später gebaute Blockberechnung selbst wurde lokal im Sub-Millisekunden-
Bereich gemessen; für Produktentscheidungen zählt dennoch die komplette Lane.

## 8. Was bewiesen und nicht bewiesen ist

### Bewiesen

- Graphify/Recall kann Import- und Aufrufabhängigkeiten einschließlich
  Workspace-Paketgrenzen mechanisch finden.
- Die Tool-Adoption kann in frischen Messsitzungen durch Oberfläche und
  Instructions auf 80 % gebracht werden.
- Die aktuelle automatische Prompt-Zustellung liefert keinen inkrementellen
  Nutzungsbeleg gegenüber dem Kontrollarm.
- Volle Graphantworten kosten deutlich mehr Kontext als kompakte Blöcke.

### Nicht bewiesen

- Dass Graphify allgemein nutzlos ist.
- Dass der symbolbasierte Write/Edit-Block während echter Implementierungsarbeit
  keinen Nutzen hat; der finale Lauf misst die Prompt-Lane.
- Eine statistisch gesicherte Kontextersparnis.
- Ein Recall-Gewinn durch automatische Zustellung oder vollständige Prefills.

## 9. Produktfolgerung

1. Graphify-Grundlage, Index, Paketauflösung, explizite Tools und Telemetrie
   behalten.
2. Automatische Prompt-Zustellung nicht ohne Weiteres standardmäßig aktivieren.
3. Prompt- und Write/Edit-Lane getrennt entscheiden und messen.
4. Keine großen Kontext- oder Recall-Versprechen kommunizieren.
5. Vor einem weiteren Agentenlauf zuerst offline klären, ob bessere Kanten,
   besseres Ranking oder eine andere Integrationsform die 15/37-Abdeckung
   substanziell verbessert.

## 10. Autoritative Artefakte

- v3: `~/.bastra/eval/code-roi-v2/report.json`
- v6: `~/.bastra/eval/code-roi-v4-bastra-io/report.json`
- Zustellung: `~/.bastra/eval/code-roi-delivered-recall-v2/report.json`
- v3/v6 Befund: `packages/eval/code-roi/v2/BEFUND.md`
- Zustellungspopulation:
  `packages/eval/registrations/code-awareness-delivered.population.md`
- Registrierungen:
  - `packages/eval/registrations/code-awareness-roi.json`
  - `packages/eval/registrations/code-awareness-change-impact.json`
  - `packages/eval/registrations/code-awareness-delivered.json`

