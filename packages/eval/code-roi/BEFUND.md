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

---

# Nachtrag 18.09.2026: sauberer Lauf, und eine Korrektur

Nach zwei behobenen Fehlern im Aufbau (Lösungen lagen im Repo; "eindeutig"
zählte nur Exporte) wurde auf **34 wirklich eindeutigen** Symbolen neu
gemessen.

## Korrektur an einem früheren Befund

Oben stand: *"der gezielte grep findet nur 23 von 40"*. **Das war ein
Artefakt der mehrdeutigen Szenarien**, nicht eine Eigenschaft von grep. Auf
den bereinigten 34 Symbolen findet der gezielte grep **34/34** — genau wie
`find_code`. Die Aussage ist zurückgezogen.

## Objektive Messung, 34 eindeutige Symbole

| | Median | Summe | schlimmster Fall |
|---|---|---|---|
| gezielter `grep` | **128** | 5.438 | — |
| breiter `grep` | 978 | 33.497 | 3.297 |
| `find_code` | 602 | 23.678 | **1.173** |

Treffer: gezielter grep 34/34, `find_code` 34/34.

**Das ist das differenzierte Bild:**

- Gegen einen **perfekt gezielten** grep verliert die Karte klar — Faktor 4,7
  im Median. Wer die Deklarationsform und die genaue Schreibweise kennt,
  braucht sie nicht.
- Gegen einen **breiten** grep — den man schreibt, wenn man das nicht schon
  weiß — gewinnt sie: 602 gegen 978 im Median.
- Sie ist **vorhersagbar**: schlimmster Fall 1.173 Zeichen gegen 3.297. Der
  Graph kennt keinen Ausreißer, grep schon.

## Agentenlauf (find_code-Arm)

34/34 gefunden, ein Aufruf je Symbol, **kein einziges `unavailable`**, keine
Ausweichung auf grep, 23.679 Zeichen — deckungsgleich mit der objektiven
Messung, was den Selbstbericht dieses Arms bestätigt.

Der Kontrollarm-Lauf ist inzwischen ebenfalls durch — Ergebnis unten.

## Was damit belegt ist

Die Frage "spart es Kontext" hat keine Ja/Nein-Antwort, sondern hängt davon
ab, was der Vergleich ist:

- Gegen einen Agenten, der die exakte Deklarationsform schon kennt: **nein**.
- Gegen einen, der sie nicht kennt: **ja**, und zusätzlich ohne Ausreißer.

Welcher Fall häufiger ist, entscheidet über den Nutzen — und das lässt sich
nur an echten Sitzungen ablesen, nicht an einem Repo-Durchlauf. Die
Telemetrie dafür steht jetzt (`bastra logs --stats`, Abschnitt
`code search ROI`).

---

# Ergebnis des sauberen Laufs (N = 34) — entscheidbar

Beide Arme, je ein Aufruf pro Symbol, kein Bündeln, Lösungen außerhalb des
Repos, nur eindeutige Symbole. **Beide 34/34 richtig.**

| | Kontrollarm (grep) | Graph-Arm (find_code) |
|---|---|---|
| Runden | 35 | 34 |
| Zeichen gesamt | 25.374 | **23.679** |
| Median | **508** | 602 |
| schlimmster Fall | 2.358 | **1.173** |
| billiger in | **21 von 34** | 13 von 34 |

## Gegen die preregistrierte Schwelle

- Verlangt: **≥ 25 % Reduktion**. Gemessen: **6,7 %**.
- Verlangt: die Differenz **hält über Szenarien**. Gemessen: der Kontrollarm
  ist in **21 von 34** Fällen billiger.

**Die Schwelle wird nicht erreicht. Das Kriterium ist nicht erfüllt.**

Diesmal ist das ein Urteil und kein `underpowered`: N = 34 über dem Minimum,
Ground Truth unabhängig verifiziert, keine Kontamination, kein Bündeln, und
der Selbstbericht des Graph-Arms deckt sich auf das Zeichen mit der
objektiven Messung.

## Der Befund dahinter

**Der erhoffte Mechanismus existiert bei dieser Aufgabe nicht.** Der Graph
sollte gewinnen, indem er Such-RUNDEN spart. Gemessen: 34 gegen 35 Runden —
praktisch gleich. Ein gezielter grep braucht für "wo ist X definiert" ebenso
einen Versuch wie eine Graphabfrage. Wo nichts zu sparen ist, spart auch ein
Index nichts.

**Was der Graph dafür kann:** Er hat keine teuren Ausreißer. Schlimmster Fall
1.173 gegen 2.358 Zeichen, und in der früheren Messung 2.064 gegen 12.367 bei
einem stark verbreiteten Namen. Der Graph ist gleichmäßig; grep ist eine
Wette auf die Verbreitung des gesuchten Namens.

Das ist ein realer, aber schmaler Vorteil: Vorhersagbarkeit statt Ersparnis.

## Konsequenz

Für die Aufgabenklasse "finde die Definition eines Symbols" ist der Nutzen
**nicht belegt** — nach der Regel, die wir uns vorher gegeben haben.

Nicht gemessen und offen bleibt die Aufgabenklasse, für die es eigentlich
gebaut ist: "was bricht, wenn ich diese Datei ändere". Ein grep auf Importe
beantwortet das nur, wenn man die richtigen Namen schon kennt, und die frühere
Messung zeigte dort einen grep-Recall von 100 % — allerdings auf Szenarien mit
demselben Mehrdeutigkeitsproblem, das den ersten Lauf entwertet hat. Diese
Klasse müsste sauber nachgemessen werden, bevor irgendjemand über die
Abschaltung entscheidet.
