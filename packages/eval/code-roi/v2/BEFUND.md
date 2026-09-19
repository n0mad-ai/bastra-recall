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
eine eigene Registrierung:
`packages/eval/registrations/code-awareness-change-impact.json` (v4,
drei Arme: `A` nur grep, `B` Tools angeboten, `prefilled` Antwort im Prompt).

v4 fällt **zwei getrennte Urteile** statt eines gemeinsamen: `adoption`
(ruft ein Agent das Tool überhaupt? — Arm B, ≥ 70 % der Szenarien) und
`effect` (hilft die Antwort? — `prefilled` gegen `A`: Recall ≥ +5 Pp mit
KI-Untergrenze > 0, Präzision ≥ −5 Pp, Kontext ≤ 1,25×). Es gibt bewusst
kein zusammengefasstes Urteil: ein Werkzeug, das niemand aufruft, dessen
Antwort aber hilft, und eines, das alle aufrufen und das nichts bringt,
sind entgegengesetzte Befunde und verlangen entgegengesetzte Arbeit.

## Mechanismus-Gate (#582, offline neu ausgewertet 19.09.2026)

Frage, absichtlich eng: Von den Wahrheitsdateien, die in einem **anderen**
Workspace-Paket liegen als die geänderte Datei — wie viele nennt
`find_affected_files` bei Tiefe 1? Kein Agent, kein Geld. Das Gate ist der
Boden unter der Wirksamkeitsmessung: findet die Paketbrücke diese Dateien
offline nicht, wird sie keine Beschreibung einem Agenten finden lassen.

Ausgewertet werden **zwei Wege getrennt**: `explicit` gibt dem Werkzeug den
Symbolnamen direkt (die Obergrenze der Graph-Abfrage), `product` nur Datei und
Diff — der Weg, den ein Nutzeraufruf nimmt, einschließlich `diffSymbols` und
`symbol-spans.ts`. Die erste Auswertung kannte nur `explicit` und maß damit
nicht das Produkt.

| Teil | Szenarien | übergreifende Wahrheitsdateien | gefunden | Anteil | Urteil |
|---|---|---|---|---|---|
| historisch (bastra-io) | 2 | 2 | 2 | **1,00** | `not_evaluable` (n < 8) |
| synthetisch, gegated | 9 | 15 | 15 | **1,00** | **`pass`** (verlangt 1,00) |
| synthetisch, gesamt | 14 | 21 | 18 | 0,857 | berichtet, nicht gegated |

**Beide Wege liefern identische Zahlen, Zeile für Zeile.** Das ist selbst ein
Befund: der Schritt vom Diff zu den Symbolen verliert auf dieser Stichprobe
nichts, die drei Fehlschläge gehören also dem Graphen, nicht dem Diff-Leser.

Der historische Teil hat n = 2 — die gesamte Historie von bastra-io gibt in
111 `packages/`-Kandidaten nicht mehr her. Das ist ein Klempner-Ergebnis, kein
Messwert; der entschiedene Mindest-n ist 8, also `not_evaluable`.

**Root-Fehler behoben, neu ausgewertet 19.09.2026 (HEAD `3493508`).**
`mechanism-gate.mjs` übergab `symbolSpans` bisher nur `runs/<id>/graph` als
Root — ohne die Quelldateien. `symbolSpans` fand dadurch keine Datei, gab
`null` zurück, und `diffSymbols` fiel **für jedes Szenario** auf `whole_file`
zurück; die Symbol-Verengung, die dieses Gate eigentlich prüfen soll, lief nie.
Root jetzt wie in `scenario-root.mjs` / `mutation-gate-score.mjs` aus Tree +
Graph zusammengesetzt (Symlink-Root), Diff weiterhin über `diffForTree(diff,
"old")` gewendet. Belegt per Diagnose: S02 engt jetzt von 16 Symbolen
(voller Datei-Fallback) auf 1 Symbol (`NormalizedEvent`) ein; S01 bleibt bei
`whole_file`, aber jetzt aus einem echten Grund — der Diff ändert einen
Top-Level-Template-String (`ACTIONS_SYSTEM`), den der Indexer nicht als Symbol
führt, also greift die dokumentierte „sichere Seite" aus `affected.ts`, nicht
mehr ein fehlender Root. **Endergebnis unverändert:** 2/2 gefunden, Anteil
1,00, weiterhin `not_evaluable` (n < 8) — jetzt aber über den echten
Produktpfad erzielt statt über den Fallback.

**Synthetisch, nach Operator:** `rename-export` 10/10, `require-param` 5/5 —
beide gegated und erfüllt; `require-field` **3/6**, nur berichtet. Nach
Quellpaket: `packages/db` 5/5, `packages/ai` 3/3, `packages/payments` 3/3,
`packages/social` 7/10.

**Die drei Fehlschläge, eine Ursache.** Alle stammen aus derselben Mutation:
ein Pflichtfeld in `PublishInput` (`packages/social/src/adapter.ts`).
Verfehlt: `app/admin/_actions/posts.ts`, `app/admin/_lib/engagement.ts`,
`app/api/smm/cron/route.ts`. Im Graphen hat `PublishInput` 13 Abhängige —
**alle innerhalb von `packages/social`**. Die drei App-Dateien nennen den Typ
nirgends: sie bauen Objektliterale, die erst über eine Funktionssignatur zu
`PublishInput` fließen. Es gibt also weder eine Import- noch eine Aufrufkante,
die man verfolgen könnte — der Bruch ist eine Folge des **Typflusses**, und
extrahierte Import-/Aufrufkanten können ihn grundsätzlich nicht sehen. Das ist
die bekannte Grenze aus `affected.ts` („candidates, not proof"), gemessen statt
behauptet. Nicht behoben, wie beauftragt.

## Schwellen der Gates (entschieden 19.09.2026 von Daniel Nevoigt)

Die Zahlen standen vor der Entscheidung, die Entscheidung fiel danach — in
dieser Reihenfolge, und nur so ist sie etwas wert.

- **Historisches Gate:** `min_share_found` 0,80, Mindest-n 8
  übergreifende Wahrheitsdateien. Heute 2 vorhanden → `not_evaluable`.
- **Synthetisches Gate, geteilt:** `rename-export` und `require-param` brechen
  einen Namen bzw. einen Aufruf — Kanten, die der Graph extrahiert. Sie werden
  mit **1,00** verlangt. `require-field` bricht über den **Typfluss**: der
  Verbraucher baut ein Objektliteral, das den Typ erst über eine
  Funktionssignatur erreicht und ihn nirgends nennt. Es gibt keine Import- und
  keine Aufrufkante, der Graph modelliert das bewusst nicht — dieser Operator
  wird nur **berichtet**, nicht gegated. Der Gesamtwert (18/21) wird berichtet
  und ist kein alleiniges Pass-Kriterium.
- Jedes Gate meldet **pass / fail / not_evaluable je Teil**; es gibt kein
  zusammengefasstes Gate-Urteil, aus demselben Grund, aus dem `adoption` und
  `effect` nie zusammengefasst werden.

## v6 Endergebnis (19.09.2026, Build 389c0ff)

Hauptlauf abgeschlossen: 40 von 40 Szenarien, 120 von 120 Armen, keine
Abbrüche, kein gemischter Build (`build-pin.json`, Signatur `3165f078…`,
durchgehend HEAD `389c0ff`). Report erzeugt mit `evaluate-v4.mjs` aus
`~/.bastra/eval/code-roi-v4-bastra-io/report.json`; alle Zahlen unten
stammen aus diesem Report. Stichprobe ausschließlich bastra-io (n = 40) —
die Pooling-Regel griff nicht, weil ein Repo allein bereits 40 Szenarien
lieferte (`population.pooling.used_only_when_short`), die 7 frischen
bastra-recall-Szenarien blieben Reserve.

Verlauf in vier Helfungen (Häppchen), erkennbar an den Lücken zwischen den
Transkript-Zeitstempeln: S01–S08 (15:49–15:54 Uhr), S09–S16 (16:07–16:15,
+13 Min. Pause), S17–S24 (16:19–16:24, +4,6 Min.), S25–S40 (16:28–16:40,
+4 Min.) — also 8 → 16 → 24 → 40 Szenarien, durchgehend derselbe Build.

| | grep (A) | angeboten (B) | prefilled | Schwelle | Ergebnis |
|---|---|---|---|---|---|
| Recall | 100,0 % | 100,0 % | 100,0 % | — | — |
| Recall-Gewinn (prefilled − A) | | | **0,0 Pp** | ≥ +5 Pp, KI-Untergrenze > 0 | KI **[0,0]** → **fail** |
| Präzision (Δ prefilled − A) | 84,75 % | 85,67 % | 84,54 % (**−0,21 Pp**) | ≥ −5 Pp | eingehalten |
| Median Input-Tokens | 24.616,5 | 58.308,5 | 23.564 | prefilled ≤ 1,25 × A | **0,9572×** eingehalten |
| Kontextverhältnis, alle 40 (nicht gegated) | | | 0,9572 | — | identisch zum gegateten Wert — alle 40 Paare in beiden Armen gelöst |
| Adoption (`find_affected_files`, Arm B) | | **32/40 = 80,0 %** | | ≥ 70 % | **pass** |
| `find_code`-Aufrufe (nur berichtet) | 0 | 0 | 0 | — | — |
| Kosten des Laufs | 1,6324 $ | 2,1219 $ | 1,7481 $ | Summe **5,5024 $** von 40 $ Deckel | eingehalten |

**Adoption: `pass`. Effect: `fail`.** Kein zusammengefasstes Urteil, wie
registriert. Gates unverändert gegenüber oben: historisch `not_evaluable`
(n = 2 < Mindest-n 8), synthetisch gegated **pass** (15/15), `require-field`
weiterhin 3/6, nur berichtet.

### Ehrliche Einordnung

**(a) Adoption in Messsitzungen ≠ echter Betrieb.** In frischen, isolierten
Sessions mit sofort geladenem Werkzeug und beim Connect vorgelesenen
Server-Instructions ruft der Agent `find_affected_files` in 80 % der Fälle
auf — die Schwelle von 70 % ist erreicht. Am 19.09. hat aber **kein
einziger Agent im echten Tagesbetrieb** das Tool freiwillig genutzt
(Lane-Telemetrie, außerhalb dieser Registrierung erhoben). Der Unterschied
liegt im Aufbau selbst: Im Messaufbau werden Instructions beim Connect
vorgelesen und alle Tools sofort geladen (`--strict-mcp-config`); in
echten, laufenden Sessions ist ein MCP-Tool typischerweise **deferred**
(siehe `known_harness_deviation` in der Registrierung), und die
Instructions sind aus dem Kontext längst verschwunden. Der Adoption-`pass`
gilt für den gemessenen Aufbau, nicht für den Alltag.

**(b) Effect ist in dieser Stichprobe nicht messbar — ein Befund über die
Population, nicht über das Werkzeug.** Alle drei Arme lösen alle 40
Szenarien mit 100 % Recall; grep allein reicht in bastra-io für diese
Aufgabenklasse offenbar durchgehend aus. Der Gewinn ist damit mechanisch
0,0 Pp bei einem Konfidenzintervall von [0,0] — es gibt schlicht keine
Varianz, an der sich ein Effekt zeigen könnte. Das sagt nichts darüber, ob
eine korrekte Antwort einem Agenten helfen würde, wenn er sie bräuchte; es
sagt, dass diese 40 historischen Änderungen in bastra-io keinen Fall
enthalten, in dem grep allein scheitert. Die Registrierung hat sich vorab
auf einen Recall-Gewinn festgelegt (`recall_gain_min: 0,05`, KI-Untergrenze
> 0) — das Urteil lautet deshalb korrekt **`fail`** und wird hier nicht
umgedeutet, nur weil die Population keinen Spielraum bot.

**(c) Kontext: die erhoffte Ersparnis bestätigt sich nicht.** `prefilled`
liegt mit median 23.564 Token 4,3 % **unter** grep (0,9572×) — ein echter,
aber kleiner Vorsprung, kein nennenswerter Kostenvorteil. Das tatsächlich
**angebotene** Werkzeug (Arm B) kostet median **2,37×** so viele Token wie
grep (58.308,5 vs. 24.616,5) für einen Präzisionsgewinn von deutlich unter
einem Punkt (+0,92 Pp) und keinen Recall-Gewinn.

**(d) Konsequenz.** Die v6-Population (bastra-io, diese 40 Szenarien) ist
für diese Frage verbraucht: grep erreicht dort nachweislich 100 % Recall,
eine Wiederholung auf denselben oder ähnlich gezogenen Szenarien würde das
nur bestätigen. Die nächste Messung (Zustellung per Hook, PR #607) braucht
entweder (1) eine neue, **vorher eingefrorene** Population mit echtem
Kontrollarm-Headroom — Fälle, in denen grep nachweislich nicht auf 100 %
kommt — oder (2) ein eigenes, vorab registriertes Ziel „Zustellung +
Kontextkosten" statt „Recall-Gewinn", weil (a) und (c) zeigen, dass die
offenen Fragen genau dort liegen: ob das Tool im echten Betrieb überhaupt
erreicht wird, und was es kostet, wenn es erreicht wird.

Rohdaten (Szenarien, Wahrheit, 120 Transkripte, `build-pin.json`,
`report.json`) liegen in `~/.bastra/eval/code-roi-v4-bastra-io/`.
Ergebnisblock in der Registrierung:
`packages/eval/registrations/code-awareness-change-impact.json` → `result`.
