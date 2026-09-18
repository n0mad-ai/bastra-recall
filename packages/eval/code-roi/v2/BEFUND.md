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
| Kontext (Median, 39 in beiden gelöst) | | 0,77 × | ≤ 1,25 × — **eingehalten** |

## Der eigentliche Befund

**`find_code` wurde in keinem der 44 Szenarien aufgerufen.** Das Tool war in
allen 44 Läufen verbunden und angeboten (geprüft im Init-Protokoll jedes
Laufs). Der Agent hat es nie gewählt, sondern mit grep und Lesen gearbeitet.

Damit misst der Vergleich zwei praktisch gleiche Arme, und die Unterschiede
oben sind Rauschen zwischen zwei Durchläufen desselben Vorgehens. Die Messung
beantwortet nicht, ob der Graph hilft, WENN er benutzt wird — sondern dass ein
Agent ihn so, wie das Tool heute angeboten wird, nicht benutzt. Außerdem
lösen beide Arme die Aufgabe schon zu knapp 90 %: Viel Luft nach oben gab es
für diese Aufgabenklasse in diesem Repository nicht.

## Was offen bleibt

- Ob `find_code` hilft, wenn der Agent es benutzt (erzwungen oder per
  Hinweis im Prompt) — das wäre eine neue, eigens zu registrierende Frage.
- Latenz-Gate und Hook-Block-Regel kommen aus der Alltags-Telemetrie
  (`bastra logs --stats`), nicht aus diesem Lauf; der Hook-Block hat noch
  keine 50 Blöcke.

## Nachvollziehen

Rohdaten (Szenarien, Wahrheit mit Prüfprotokoll, alle 88 Transkripte,
Graph-Hashes, `report.json`) liegen in `~/.bastra/eval/code-roi-v2/`.
Werkzeug: `mine.mjs`, `evidence.mjs`, `select.mjs`, `run-arms.mjs`,
`evaluate.mjs` in diesem Ordner. Kosten des Laufs: 13,15 $.
