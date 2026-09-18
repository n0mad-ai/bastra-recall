# Code-Awareness: „Was bricht?“ — Messung 18.09.2026 (Registrierung v3)

Frage: Nennt ein Agent mit `find_code` mehr der Dateien, die eine geplante
Änderung wirklich bricht? 44 historische Änderungen, je zwei frische,
isolierte Agenten (claude-sonnet-5): einer ohne Graph, einer mit `find_code`.
Wahrheit: neue Typfehler nach der Änderung, außerhalb des Repos, von Hand
geprüft (ein Szenario als Artefakt ausgeschlossen).

## Ergebnis: **Schwelle nicht erreicht (`fail`)**

| | ohne Graph | mit `find_code` | Schwelle |
|---|---|---|---|
| gefundene betroffene Dateien (Recall) | 89,4 % | 90,2 % | +10 Pp — gemessen **+0,8 Pp** |
| 95-%-Intervall des Unterschieds | | | Untergrenze > 0 — gemessen **0,0** |
| Präzision | 91,6 % | 89,3 % | ≥ −5 Pp — **eingehalten** (−2,3) |
| Suchergebnis-Kontext (Zeichen aus Tool-Ergebnissen, Median, 39 in beiden gelöst) | | 0,77 × | ≤ 1,25 × — **eingehalten** |

Der Kontext-Gate misst, wie registriert, nur die Zeichen der Tool-Ergebnisse.
Auf denselben 39 Paaren liegen die tatsächlichen Input-Tokens des Modells bei
0,90 × und die medianen Laufkosten bei 1,11 × — der Graph-Arm war also nicht
billiger, obwohl er das Tool nie benutzt hat. Beides ist nicht gegated und
hier nur zur Einordnung genannt.

## Der eigentliche Befund

**`find_code` wurde in keinem der 44 Szenarien aufgerufen.** Das Tool war in
allen 44 Läufen verbunden und angeboten (geprüft im Init-Protokoll jedes
Laufs). Der Agent hat es nie gewählt, sondern mit grep und Lesen gearbeitet.

Damit misst der Vergleich zwei praktisch gleiche Arme, und die Unterschiede
oben sind Rauschen zwischen zwei Durchläufen desselben Vorgehens: 43 von 44
Paaren haben exakt denselben Recall, der gesamte Unterschied stammt aus einem
Szenario (S36, 0,33 → 0,67), in dem der Graph-Arm ohne Graph-Nutzung eine
richtige Datei mehr nannte. Die Messung
beantwortet nicht, ob der Graph hilft, WENN er benutzt wird — sondern dass ein
Agent ihn so, wie das Tool heute angeboten wird, nicht benutzt. Außerdem
lösen beide Arme die Aufgabe schon zu knapp 90 %: Viel Luft nach oben gab es
für diese Aufgabenklasse in diesem Repository nicht.

## Was offen bleibt

- Ob `find_code` hilft, wenn der Agent es benutzt (erzwungen oder per
  Hinweis im Prompt) — das wäre eine neue, eigens zu registrierende Frage.
- **Latenz (Gate, nicht auswertbar):** Write/Edit-Lane ohne Code-Awareness
  (10.–16.09., n = 735) p50 56 ms / p90 86 ms; mit Code-Awareness auf dem
  aktuellen Stand (ab 18.09. 06:42, n = 11) p50 75 ms / p90 87 ms. Das ist
  ein Vorher/Nachher-Vergleich, kein gepaarter Kontrollarm, und n = 11 trägt
  kein Urteil. Beide p90 liegen unter 200 ms.
- **Hook-Block (Regel ≥ 15 % befolgt nach ≥ 50 Blöcken, nicht auswertbar):**
  6 Blöcke bei 822 Write/Edit-Aufrufen im Log. Drei davon stammen aus der
  Zeit vor der Befolgungs-Telemetrie, die anderen drei aus Testaufrufen am
  18.09. (Sessions `probe-584-*`), nicht aus echter Arbeit. Auswertbare Blöcke
  aus echten Sessions: **0 von 50**.

## Nachvollziehen

Rohdaten (Szenarien, Wahrheit mit Prüfprotokoll, alle 88 Transkripte,
Graph-Hashes, `report.json`) liegen in `~/.bastra/eval/code-roi-v2/`.
Werkzeug: `mine.mjs`, `evidence.mjs`, `select.mjs`, `run-arms.mjs`,
`evaluate.mjs` in diesem Ordner. Kosten des Laufs: 13,15 $.

## Nachtrag: Enthält der Graph die Antwort überhaupt?

Diagnose ohne Agent (`graph-ceiling.mjs`): die Abhängigen der geänderten
Datei, eine Stufe, direkt aus dem Graphen jedes Szenarios, gegen die Wahrheit.

| | Graph allein | Agent ohne Graph |
|---|---|---|
| Recall | 87,4 % | 89,4 % |
| Präzision | 43,5 % | 91,6 % |

Sechs der acht Lücken sind Änderungen in `packages/core`, die in
`packages/daemon` brechen: Der Graph löst Importe über das Workspace-Paket
(`@bastra-recall/core`) nicht auf. Die niedrige Präzision kommt daher, dass
jede importierende Datei zählt, auch ohne Nutzung des geänderten Symbols.
Ein Werkzeug auf dieser Datenbasis kann einen Agenten mit grep für diese
Aufgabe kaum schlagen, unabhängig von Name und Beschreibung.

## Nachtrag 2: symbolbasierte Abfrage (#582, 18.09.2026)

Beide Ursachen sind behoben (`affected.ts`, `external-refs.ts`,
`workspace-packages.ts`): gefragt wird nach den Symbolen, die der Diff
anfasst, und die Paketgrenze wird über die `package.json` der
Workspace-Pakete aufgelöst. Diagnose wieder ohne Agent
(`affected-ceiling.mjs`), gleiche Wahrheit, dieselben 44 Szenarien:

| | Recall | Präzision | vollständig |
|---|---|---|---|
| Dateiabfrage (Stand v3) | 87,4 % | 43,5 % | 36/44 |
| Symbolabfrage, 1 Stufe | **91,3 %** | **52,4 %** | 39/44 |
| Symbolabfrage, 2 Stufen | 95,8 % | 33,0 % | 41/44 |
| Symbolabfrage 1 Stufe ∪ grep-Arm | 95,5 % | 53,1 % | 42/44 |
| Symbolabfrage 2 Stufen ∪ grep-Arm | 100,0 % | 33,5 % | 44/44 |

**Diese Zahlen sind kein Wirksamkeitsnachweis.** Die 44 Szenarien sind mit
dem Bau dieser Abfrage zu Entwicklungsdaten geworden — Entwurfsentscheidungen
(Vorrang des spezifischen Export-Eintrags, die Schwelle für die
Namensprüfung, Deckel auf Dateien statt Treffern) wurden an genau diesen
Lücken getroffen. Eine Aussage über die Wirkung braucht frische Szenarien und
eine eigene Registrierung; Entwurf:
`packages/eval/registrations/code-awareness-change-impact.draft.json`.
