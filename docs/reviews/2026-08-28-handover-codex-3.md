# Codex-Übergabe Nr. 3: Gegenreview 46ccbb2..HEAD

**Stand:** 28. August 2026
**Prüfumfang:** `46ccbb2..HEAD` (Stand beim Übergeben: ______, zuletzt gesehen `bde85d7`)
**Vorherige Übergaben:** [Nr. 1](2026-08-28-handover-codex-1.md) (`ad86155..320e19b`), [Nr. 2](2026-08-28-handover-codex-2.md) (`320e19b..46ccbb2`)
**Prüfregel:** P0 wird sofort gefixt, alles andere wird Issue

> Etappen B und C sind abgeschlossen: acht Commits, zwei Stränge, beide
> geschlossene Issues (#263, #265). Der Unterschied zu den ersten beiden
> Übergaben: Hier wurde nicht neben dem Produkt gemessen, sondern **im
> Produktpfad umgebaut** — der Ereignisstrom bekam vier neue Spalten, und der
> Sessionstart läuft durch einen neuen, geteilten Assembler. Die interessanten
> Befunde liegen deshalb nicht in Formeln, sondern in Rändern: Was passiert,
> wenn zwei nebenläufige Erheber in anderer Reihenfolge fertig werden, und wo
> laufen zwei Pipelines auseinander, die dasselbe zu tun behaupten.

## 1. Prüfumfang

`git log --oneline 46ccbb2..HEAD`, in Reihenfolge alt → neu:

| Commit | Strang | Betreff |
|---|---|---|
| `649753d` | **a** | client, Hook-Quelle, pseudonyme Session und Arm am Ereignisstrom (#263) |
| `d5a4875` | **a** | stats teilt nach Client und Hook-Quelle und normiert auf Ausspielungen (#263) |
| `cf0046a` | **b** | Die SessionStart-Lane wartet nicht mehr auf sich selbst (#265) |
| `d092f0a` | **b** | Ein geteilter Session-Assembler mit Projekt, Budgets und Marker (#265) |
| `7ad7f1b` | **b** | Die Hop-Regeln stehen im Code, nicht in der Score-Skalierung (#265) |
| `ee5c106` | **b** | Der Deadline-Test hält die Event-Loop offen (#265) |
| `289651c` | **b** | Die Hook-Recall-Pipeline ist aufrufbar, die Route ihr Aufsatz (#265) |
| `bde85d7` | **b** | Die SessionStart-Lane holt ihren Kontext in einem Aufruf (#265) |

Beide Issues sind geschlossen. Drei Checkboxen aus #263 sind dokumentiert nach
[#264](https://github.com/n0mad-ai/bastra-recall/issues/264) gewandert (Kommentar
am Issue) — sie stehen in Abschnitt 4, damit sie nicht als Lücke gemeldet werden.

---

## 2. Strang a — Telemetrie-Dimensionen (#263)

### 2.1 Was gebaut wurde

§21.1 nennt die Dimensionen als Releasevertrag, §17.4 sagt wofür: Die
Hook-Load-Quote hängt nicht allein am Ranking, also muss die Auswertung getrennt
nach Client, Hook-Quelle und Query-Klasse laufen. Bisher trugen `recall` und
`hook_recall` nur `tool_name` und `project` — keine Spalte, an der sich zwei
Oberflächen unterscheiden ließen; der MCP-Forwarder war von einer Hook-Lane
allein am Marker `tool_name: "mcp-forwarder"` zu erkennen, was der Code selbst als
Behelf kommentierte.

`649753d` legt vier Spalten an genau **einer** Stelle an
(`telemetry-dimensions.ts`): `client`, `hook_source`, gehashte Session,
Experimentarm. Produzenten liefern nur Hinweise. Dazu kommt die Hop-Herkunft je
Hit, die auf `RecallHit` längst stand und in der Telemetrie fehlte.

`d5a4875` liest sie: `stats.ts` schlüsselt die USE-rate-Tabelle und die
**Ertragsseite** des Netto-Kontext-ROI nach beiden Dimensionen auf, führt
Altbestand in einem eigenen `(pre-#263)`-Bucket und normiert `acted_on` auf
Ausspielungen — mit dem Nenner aus dem **bestehenden** Usage-Sidecar (C-071)
statt aus einer zweiten Zählung.

### 2.2 Invarianten, die ein Reviewer angreifen sollte

- **Kein Freitext in den Spalten.** `client` und `hook_source` laufen über
  Allowlisten (`telemetry-dimensions.ts:44`, `:63`), weil sie aus einem
  Loopback-Body kommen, den jeder lokale Prozess absetzen kann; ein
  durchgereichter String wäre ein Freitextfeld im Log. Eine unbekannte Oberfläche
  wird `unknown`, kein Fehler. Prüfen: Gibt es einen Produzenten, der an
  `normalizeClient`/`normalizeHookSource` (`:98`, `:103`) vorbei schreibt? Und
  landet der Rohtext eines erfundenen Clients wirklich **nirgends** — auch nicht
  in einem Debug-Feld, einer Fehlermeldung oder einem Timing-Label?
- **Das Pseudonym ist inhaltsfrei und stabil.** SHA-256, 16 Hex-Zeichen
  (`:116-118`). §23 verlangt, dass pseudonyme Experiment-Session-IDs keinen
  Query- oder Vault-Inhalt tragen; die heutige id ist eine harmlose Claude-UUID,
  aber sie kommt von außen, und der Daemon kann nicht erzwingen, was dort steht.
  Der Hash macht die Zusage strukturell statt vertrauensvoll. Prüfen: Bleibt die
  ungehashte Session an irgendeiner Stelle im Ereignis stehen? Und ist der Hash
  über alle Ereignisarten einer Session wirklich derselbe — sonst zerfällt die
  Session als Auswertungseinheit.
- **`unassigned` behauptet kein Experiment.** Der Arm wird deterministisch aus
  dem Pseudonym abgeleitet, damit eine Session in allen ihren Ereignissen im
  selben Arm bleibt; ohne registrierte Konfiguration ist er `unassigned`
  (`:92`, `:146`). Mindest-N, Zuweisungsfunktion und Konfiguration gehören nach
  §17.4 in eine versionierte Registrierung, nicht in den Code. Prüfen: Steht im
  Code doch eine Zuweisung, die sich als registrierte lesen ließe?
- **`dimensions` ist optional — als Altbestandsmarker, nicht aus Bequemlichkeit.**
  Ein Leser muss „vor #263 geschrieben" von „hat sich nicht ausgewiesen"
  unterscheiden können; in `stats.ts` ist das der `(pre-#263)`-Bucket gegen
  `unknown`. Zusammengeworfen sähe Altbestand wie ein Messwert aus. Prüfen: Gibt
  es einen Auswertungspfad, der beide zusammenwirft oder `dimensions === undefined`
  wie `unknown` behandelt?
- **Die Tokenseite des ROI bleibt bewusst ungeteilt — und sagt es.** Sie stammt
  aus Hook-CLI-Events, die eigene Prozesse mit eigenen Telemetrie-Interfaces
  schreiben; eine Zuordnung über die Session zu raten wäre eine Zahl mit einer
  Genauigkeit, die sie nicht hat. Prüfen: Wird irgendwo doch geteilt, oder liest
  sich die Ausgabe so, als wäre sie geteilt?
- **Normalisierung ist keine Bias-Korrektur.** Über den Exposure-Zahlen steht
  ausdrücklich, was sie sind: Die Division macht Raten vergleichbar und erklärt
  nicht, warum ein Memory ausgespielt wurde. Für eine kausale Aussage fehlen
  geloggte Auswahlwahrscheinlichkeiten, kontrollierte Exploration und die
  Behandlung nicht ausgespielter Kandidaten als zensiert (C-044). Prüfen: Legt
  eine Formulierung in der Ausgabe eine kausale Lesart nahe?
- **Unbekannter Nenner ist `unknown`, nie 0.** Ein Memory ohne Historie im
  Sidecar zählt `unknown` — 0 hieße „nie ausgespielt und deshalb nie genutzt",
  `unknown` heißt „der Nenner ist unbekannt", und eine Rate mit unbekanntem
  Nenner ist keine Rate. Ein Sidecar, der `surfaced=0` meldet, während Episoden
  `acted_on` tragen, ergibt eine undefinierte Rate und wird als solche gezeigt.
  Prüfen: Gibt es einen Pfad, auf dem daraus doch eine Zahl wird?

### 2.3 Wie verifiziert wurde

16 neue Tests (`telemetry-dimensions.test.ts`, 286 Zeilen), darunter drei
End-to-End über den echten HTTP-Server: Die Spalten kommen am JSONL an, ein
erfundener Client wird `unknown`, und sein Text taucht nirgends auf. `stats.ts`
wurde gegen ein synthetisches Log plus Fixture-Sidecar gefahren. Volle Suite 1917
Tests / 0 fail; `scripts/` wegen #419 separat typgeprüft. Details im
Abschlusskommentar von
[#263](https://github.com/n0mad-ai/bastra-recall/issues/263).

---

## 3. Strang b — Session-Assembler (#265)

### 3.1 Was gebaut wurde

Der Umbau lief in sechs Schritten, und die Reihenfolge ist Teil der Aussage.

`cf0046a` macht die SessionStart-Lane nebenläufig. #369 hatte die Pipeline aus
dem Hook-Prozess in den Daemon gezogen, aber die Aufrufe blieben echte
Loopback-Requests gegen den eigenen Server, strikt nacheinander: gemessener
Höchststand gleichzeitig offener Anfragen **1**, Budgets addierten sich auf 5×150 ms
plus 200 ms — in genau dem Budget, das §16.1 begrenzt. Jetzt zwei Wellen (Recalls,
dann Seitenabrufe). Drei Verhaltensänderungen gehören dazu: der `break` bei
unerreichbarem Daemon entfällt, der Status folgt einer festen Rangfolge
(unerreichbar vor Timeout vor Fehler) statt „wer zuletzt fehlschlug", und jeder
Seitenabruf bekommt seinen eigenen Fallback.

`d092f0a` baut den geteilten Assembler. §26.1 verlangt **einen**; es gab zwei —
die Lane für Claude Code (projektbewusst) und `buildSessionContext` für hooklose
Clients (absichtlich projektlos). Jetzt erhebt `session-assembler.ts` die
Abschnitte, und beide Verben sind Projektionen darauf: GET ist „projektlos, ohne
Budget" und liefert **Wort für Wort** denselben Text wie vorher, POST nimmt
`cwd`/`project`/`source`/`budget`.

`7ad7f1b` schreibt die Hop-Regeln aus C-046 in den Code, wo sie vorher durch
Zufälle galten. `ee5c106` repariert den Deadline-Test auf Node 22. `289651c` löst
`runHookRecall` aus der Route heraus. `bde85d7` schließt ab: ein POST
`/hook/session-context` statt zehn Loopback-Requests.

### 3.2 Invarianten, die ein Reviewer angreifen sollte

**Die Zwei-Pipelines-Wahrheit — der stärkste Angriffspunkt in diesem Bereich.**
`/hook/recall` und der MCP-`recallHandler` sind zwei *verschiedene* Pipelines,
nicht zwei Aufrufe derselben: Nur der Hook-Weg kennt den Scope-Filter
(#110 Fremd-Scope-Hardfilter plus #148 Bypass für absichtliche
Cross-Scope-Treffer), die Reflex-Hits aus dem tieferen Kandidatenpool und den
Router-Schatten (#362). `bde85d7` fährt den Assembler deshalb auf **`runHookRecall`**,
damit die Trefferauswahl dieselbe bleibt — der **GET-Weg bleibt bewusst auf
`recallHandler`**, weil ihn mitzunehmen eine stille Produktänderung für hooklose
Clients wäre. Das ist eine offene Entscheidung, notiert für #264. Prüfen: Ist die
Trennung an jeder Stelle bewusst gesetzt oder irgendwo geerbt? Und liefert der
GET-Weg heute Treffer, die ein Hook-Nutzer nie sähe — und umgekehrt?

- **`runHookRecall` ist wortgleich verschoben.** Verändert sind genau zwei
  Ränder: Der SSE-Kopf bleibt in der Route, die Stage-Events gehen über ein
  Callback nach draußen. Das Sammeln der Timings bleibt drin, weil die Telemetrie
  sie am Ende liest; die Leer-Query-Prüfung bleibt in der Route, weil sie
  Eingabeprüfung ist und keine Retrieval-Entscheidung. Kein Test musste angefasst
  werden — das ist hier die eigentliche Aussage, und zugleich die Schwäche des
  Belegs. Prüfen: Ist der Rumpf wirklich wortgleich (`git show 289651c` mit
  Blick auf die Ränder), und ist „kein Test angefasst" hier Evidenz oder nur
  Abwesenheit von Abdeckung?
- **Abschluss- gegen Prioritätsreihenfolge.** Die Rohantworten der nebenläufigen
  Erheber kommen in **Abschlussreihenfolge** zurück; für einen Aufrufer, der die
  Reihenfolge als **Priorität** liest, wäre das von Lauf zu Lauf verschieden.
  Jeder Recall trägt seinen Platz deshalb explizit mit (`session-assembler.ts:121`),
  und schon `cf0046a` stützte sich darauf, dass `mergeSessionHits` die Reihenfolge
  in `responses` als Priorität liest. Prüfen: Gibt es eine zweite Stelle, die
  Reihenfolge als Bedeutung liest, ohne den mitgeführten Platz zu benutzen? Das
  ist die Klasse von Fehler, die unter Last erst auftritt und in einem
  Stub-Test nie.
- **Textreihenfolge ≠ Budgetpriorität.** Die Blöcke behalten ihre gewachsene
  Reihenfolge im Text — daran hängt der Vertrag. Was ein knappes Budget überlebt,
  ist eine **zweite** Rangfolge daneben (`PRIORITY`, `:520`): gepinnte Floors
  zuerst, weil push-by-state nicht am Budget sterben darf, Onboarding zuletzt,
  weil ein Angebot wiederkommt. Prüfen: Sind die beiden Reihenfolgen wirklich
  entkoppelt, oder leitet sich eine aus der anderen ab?
- **Ein weggelassener Block sagt, warum.** `omitted: "empty" | "deadline" |
  "token_budget"` (`:127`, `:526`). Prüfen: Gibt es einen Weglassungsgrund ohne
  Marker?
- **Der §9.4-Marker wird gelesen, nicht geraten.** Meldet ein Recall `degraded`,
  gewinnt das vor `lexical_only`, denn dort war ein Arm geplant und fiel aus.
  `null` heißt „kein Recall gelaufen", nicht „vollständig", und ein
  Deadline-Abbruch ist Teilabdeckung, **nie** `no_answer`. Prüfen: Kann eine
  Kombination aus Deadline und leerem Ergebnis doch als `no_answer` herauskommen?
  Das ist eine Zusage an den Nutzer, keine Kosmetik.
- **`abandonAfter`: aufgeben statt abbrechen** (`:39`, `:478-480`), dieselbe
  Semantik wie bei den Recall-Armen. Prüfen: Läuft ein aufgegebener Erheber im
  Hintergrund weiter und schreibt dann noch Telemetrie oder in den Vault?
- **Die caps-Defaults gegen die Lane-Werte.** Der Assembler hat eigene Vorgaben
  (`MAX_PINNED = 5`, `MAX_HINTS = 3`, `MAX_CONVENTIONS = 4`, `MAX_PROJECT_HINTS = 3`,
  `:51-56`), die Lane setzt beide abweichenden Werte **ausdrücklich**:
  `caps: { conventions: 6, pinned: 0 }` (`session-lane.ts:134`), wobei `0`
  ungekappt heißt, weil `Infinity` kein JSON überlebt (`session-assembler.ts:370-375`),
  plus lane-seitig `TOTAL_HINTS_CAP = 7` (`session-lane.ts:62`). Ein Umzug ohne
  diese Zeilen wäre eine stille Produktänderung gewesen. Prüfen: Deckt sich das
  Ergebnis mit dem Verhalten vor `bde85d7` in **allen** Kombinationen — mit und
  ohne Projekt, mit leeren Floors, bei mehr als 7 Hints? Die `0`-als-ungekappt-
  Konvention ist der Punkt, an dem ein späterer Leser danebengreift.
- **Die `expand_hops`-Baseline hing an einer Auslassung.** `expand_hops` hat
  keinen Schema-Default; der Hop entsteht nur, weil `/hook/recall` ihn setzt, wenn
  der Aufrufer schweigt, und kein Hook fragt ihn an. Der Assembler hätte ihn beim
  Absorbieren der Lane-Recalls verloren, ohne dass es auffällt — genau die
  Fehlerklasse, die die Auflage nennt. Der Default steht jetzt im Assembler
  (`:308`), der GET-Weg setzt ausdrücklich `0` und behält sein Verhalten, weil der
  Forwarder-Vertrag keine Hops kennt. Prüfen: Gibt es einen dritten Aufrufer, der
  weder das eine noch das andere setzt?
- **Ein hop-only-Treffer wird nie `required`.** `bandHits` kennt den Hop und
  schließt ihn aus (`band-wording.ts:115`, `:121`: `h.score >= cut && h.hop !== "1-hop"`).
  Vorher galt das durch zwei Zufälle — die skalierte Rang-Summe deckelt einen
  Nachbarn bei rund 82, und der BM25-Fallback bandet über `unfused` ohnehin nicht.
  Beides kann kippen. Die Herkunft bleibt dabei serverseitig: `toLeanHit` liefert
  die sechs Felder des öffentlichen Vertrags, der Hop geht in Telemetrie und
  Debug, und die Lane bandet projizierte Hits ohne Hop unverändert. Prüfen: Greift
  die Regel wirklich **vor** der Projektion an allen Stellen, und kann ein
  hop-only-Treffer über den Lane-Pfad doch `required` werden?
- **Zusagen ohne Schalter werden als Abwesenheit geprüft.** Was im
  SessionStart-Budget nie läuft — Reranker, Cross-Encoder, Deep Recall — hat
  keinen Schalter, an dem man es prüfen könnte; also prüft der Test die
  Abwesenheit. Prüfen: Ist der Abwesenheitstest scharf, oder bestünde er auch,
  wenn die Komponente umbenannt würde?

### 3.3 Wie verifiziert wurde

`cf0046a` misst nicht die Wanduhr, sondern **wie viele Anfragen gleichzeitig offen
sind** — sequenziell ist das nie mehr als eine; der Peak stieg von 1 auf 6.
`bde85d7` misst am selben Stub: 10 Requests und Peak 6 werden zu 2 Requests und
Peak 2, 135 ms zu 49 ms. Der entscheidende Beleg daneben ist aber, dass das
**stdout-Dokument byte-identisch** blieb — verglichen gegen die Fassung aus
`289651c`, 5981 Bytes, gleiche Daten, gleiche Ausgabe. `d092f0a` liefert 446
Zeilen Tests für den Assembler und die Zusage, dass GET Wort für Wort denselben
Text liefert wie vorher; `7ad7f1b` 130 Zeilen für die Hop-Regeln.

**`ee5c106` ist als Diagnose lesenswert, nicht nur als Fix.** Auf Node 22 riss
`session-assembler.test.ts` ab Test 9 ab (`cancelledByParent`, „Promise resolution
is still pending but the event loop has already resolved"), Node 24 tolerierte es.
Die Ursache war **nicht** die absichtlich nie auflösende Promise, sondern die
**leere Event-Loop**: Eine Promise hält sie nicht offen, und der Timer in
`abandonAfter` ist mit gutem Grund `unref`'d, damit ein fertiger Hook-Prozess nicht
auf eine Deadline warten muss. Ein Test, der auf genau diese Deadline wartet und
sonst auf nichts, gibt Node nichts mehr zu tun — die Messung brach nach 1,5 ms ab,
wo 40 ms gemessen werden sollten. Prüfenswert: Gibt es weitere Tests, die auf
einen `unref`'d Timer warten und heute nur zufällig grün sind?

---

## 4. Bewusst nicht hier, sondern in #264

Drei Checkboxen aus #263 sind mit Begründung nach
[#264](https://github.com/n0mad-ai/bastra-recall/issues/264) gewandert — dort
liegen Feldliste und Produzent, und #264 nennt #263 selbst als Dependency, nicht
umgekehrt. Sie sind **keine Lücke** in diesem Prüfumfang:

1. Der Evidenz-Gate-Entscheid je Hit.
2. Die §10.3/§8.5-`no_answer`-Trennung. Vorarbeit ist erbracht: Keine heutige
   Klasse heißt `no_answer`.
3. Die Hop-Herkunft der *required*-Hits im Report — welcher Hit `required` ist,
   entscheidet erst der Evidenzentscheid.

Dazu die offene Entscheidung aus 3.2: ob der GET-Weg von `recallHandler` auf
`runHookRecall` nachzieht. Beides wartet an #264.

## 5. Bekannte offene Punkte — nicht neu suchen

| Issue | Kurz |
|---|---|
| [#264](https://github.com/n0mad-ai/bastra-recall/issues/264) | Deterministisches Evidenz-Gate. Nimmt die drei Checkboxen aus Abschnitt 4 und die GET-Pipeline-Entscheidung auf. |
| [#413](https://github.com/n0mad-ai/bastra-recall/issues/413) | Der hook-komponierte Filter fängt nur die englische Query-Form; 46 von 400 gestagten Queries betroffen. |
| [#415](https://github.com/n0mad-ai/bastra-recall/issues/415) | Bash-Tripwire feuert auf Prosa in einem Heredoc. |
| [#416](https://github.com/n0mad-ai/bastra-recall/issues/416) | `packages/eval/src/goldset-harvest.ts` enthält rohe NUL-Bytes. **Weiterhin: Diffs dieser Datei nur mit `git diff --text`**, `grep -rn` überspringt sie stillschweigend. |
| [#417](https://github.com/n0mad-ai/bastra-recall/issues/417) | Das Run-Artefakt speichert abgeleitete Ränge, nicht die Top-k-id-Listen. |
| [#418](https://github.com/n0mad-ai/bastra-recall/issues/418) | Autorenstufe: 150 associative, 40 C-036, 40 englische Fälle, vault-blind. |
| [#419](https://github.com/n0mad-ai/bastra-recall/issues/419) | `tsconfig` schließt `scripts/` aus — betrifft in diesem Bereich unmittelbar `packages/daemon/scripts/stats.ts` aus `d5a4875`, das deshalb separat typgeprüft wurde. |
| [#420](https://github.com/n0mad-ai/bastra-recall/issues/420) | Testläufe schreiben echte Artefakte nach `~/.bastra/eval-runs`. |

Aus den Übergaben Nr. 1 und Nr. 2 weiterhin offen und dort beschrieben: #377
(Meldestellen der Mutations-Telemetrie) sowie #379–#382 (v0.9.3-Write-Path-Härtung).

## 6. Prüfregeln

1. **P0 wird sofort gefixt.** Alles andere wird ein Issue — kein
   Sammel-Review-Dokument, keine Drive-by-Fixes an Nicht-P0-Befunden.
2. **Jeder Befund mit Referenz.** Commit-SHA und `datei.ts:zeile`.
3. **Der Prüfumfang ist der Diff, nicht das Repository.** Ältere Schwächen, auf die
   der Diff nur zeigt, sind ein Issue mit Hinweis darauf.
4. **Bei `packages/eval/src/goldset-harvest.ts`: `git diff --text`** (siehe #416).
5. **Gemessene Zahlen schlagen Plausibilität.** Wo dieses Dokument eine Messung
   nennt, steht der Weg zum Nachrechnen im verlinkten Issue-Kommentar. Eine Zahl
   anzuzweifeln ist willkommen — dann bitte mit einer Gegenmessung.
6. **Registrierte Zahlen sind ein eigener Prüfgegenstand** (aus Übergabe Nr. 2):
   Ist die Zahl aus einem Lauf hergeleitet oder gesetzt, hält sie gegen jeden
   hinterlegten Lauf, und ist die verworfene Vorgängerfassung noch aktenkundig?
7. **„Kein Test musste angefasst werden" ist eine Behauptung, keine Verifikation.**
   Sie kommt in diesem Bereich dreimal vor (`cf0046a`, `289651c`, sinngemäß
   `d092f0a`) und ist jedes Mal als Argument für Verhaltensgleichheit gemeint. Wo
   sie den Beleg trägt, gehört die Frage dazu, ob überhaupt ein Test das
   fragliche Verhalten abdeckt.
