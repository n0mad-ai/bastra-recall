# Code-Awareness gegen den No-Graph-Kontrollarm — Messung 17./18.09.2026

Primärmetrik der Preregistrierung: **Suchtokens bis zur richtigen Stelle**.
Zwei Durchgänge: eine skriptgestützte Messung über 40 Szenarien, und ein Lauf
mit zwei echten Agenten über dieselben 40.

Reproduzieren: `packages/eval/code-roi/measure.mjs`, `measure-deps.mjs`,
`objective.mjs`, Auswertung mit `evaluate.mjs`.

## Urteil: **nicht entscheidbar** (`underpowered`)

Die Preregistrierung verlangt, `underpowered` zu melden statt ein Urteil zu
fällen, das die Stichprobe nicht trägt. Das ist hier der Fall — Begründung
unten. Was belegt ist und was nicht, steht getrennt.

## Agentenlauf, 40 Symbole, je ein Arm

| | Kontrollarm (grep) | Graph-Arm (find_code) |
|---|---|---|
| richtig | 40/40 | 39/40 |
| Tool-Aufrufe | 16 | 39 |
| Zeichen gesamt | 24.221 | 36.235 |

So gelesen verliert der Graph deutlich. **Der Vergleich ist aber unfair**, und
zwar zugunsten des Kontrollarms: Er durfte **bündeln**. 30 der 40 Symbole hat
er in 6 Aufrufen mit zusammen 3.512 Zeichen erledigt, weil er alle 40 Fragen
auf einmal kannte. Ein Agent in einer echten Sitzung kennt eine Frage.

## Derselbe Lauf, nur die einzeln gesuchten Symbole (N = 10)

Gepaart auf denselben Symbolen, beide Arme eine Frage zur Zeit:

| | grep | find_code |
|---|---|---|
| Median | 802 Zeichen | 959 Zeichen |
| Mittelwert | **2.070** | **1.141** |
| billiger in | 5 von 10 | 5 von 10 |

Median und Mittelwert zeigen in verschiedene Richtungen, und genau darin liegt
die Erkenntnis: **grep ist meistens etwas billiger und gelegentlich
katastrophal teuer.** `recallHandler` kostete per grep 12.367 Zeichen, per
`find_code` 2.064 — Faktor sechs. Der Graph ist gleichmäßig, grep ist eine
Wette auf die Verbreitung des Namens.

## Skriptmessung, 40 Szenarien

| | find_code | gezielter grep | breiter grep |
|---|---|---|---|
| gefunden | **40/40** | **23/40** | 40/40 |
| Median | 770 Zeichen | 79 | 202 |

Der gezielte grep ist zehnmal billiger, findet aber nur 58 %. Die fehlenden
17 Fälle kosten eine zweite Runde, die diese Messung nicht mitzählt.

## Warum das Urteil `underpowered` lautet

1. **N = 10 im einzigen fairen Vergleich.** Die Preregistrierung verlangt
   N ≥ 30. Dass der Kontrollarm bündeln durfte, hat 30 Szenarien für den
   gepaarten Vergleich unbrauchbar gemacht — ein Fehler im Aufbau, nicht im
   Ergebnis.
2. **Runden und Zeichen sind selbstberichtet.** Die Korrektheit ist objektiv
   gegen die Ground Truth geprüft, der Aufwand nicht.
3. **Ein Arm war kontaminiert.** Der erste Graph-Arm stieß bei der Arbeit auf
   `scenarios.json` und hat die Antworten gesehen. Er hat das von sich aus
   gemeldet; sein Lauf ist deshalb nicht in der Wertung.
4. **Die Ground Truth hat eine Lücke.** `resolveEmbedding` existiert zweimal
   als lokale Funktion (`bridge.ts:165`, `index.ts:1002`). Mein Filter prüfte
   nur auf mehrfache `export function`, nicht auf lokale Doppelung. Beide Arme
   stolperten darüber; der Graph-Arm zählt es als einzigen Fehler.

## Was unabhängig davon belegt ist

- `find_code` findet **40/40**, der gezielte grep **23/40**.
- Der Graph vermeidet Ausreißer: schlechtester Fall 2.064 gegen 12.367 Zeichen.
- Lane-Latenz mit beiden Blöcken p90 9,6 ms gegen ein 200-ms-Ziel.
- Watcher: neue oder gelöschte Datei nach 10 s im Graphen (zugesagt: 30 s).
- Stop-Hook 24 ms, Daemon-RSS 191 MB, Platz für rund 24 Repos.

## Was zu tun wäre, um zu entscheiden

Ein zweiter Agentenlauf, in dem **beide** Arme strikt ein Symbol pro Aufruf
bearbeiten, mit N ≥ 30 und ohne lesbare Ground Truth im Repo. Erst dann trägt
die Stichprobe ein Urteil.
