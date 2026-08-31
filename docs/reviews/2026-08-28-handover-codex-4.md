# Codex-Übergabe Nr. 4: Gegenreview f780cae..HEAD

**Stand:** 28. August 2026
**Prüfumfang:** `f780cae..HEAD` (Stand beim Übergeben: ______, zuletzt gesehen `f02361a`)
**Vorherige Übergaben:** [Nr. 1](2026-08-28-handover-codex-1.md), [Nr. 2](2026-08-28-handover-codex-2.md), [Nr. 3](2026-08-28-handover-codex-3.md) (`46ccbb2..f780cae`)
**Prüfregel:** P0 wird sofort gefixt, alles andere wird Issue

> Etappe D: sieben Commits, zwei Stränge, beide Issues (#264, #266) geschlossen.
> Beide bauen einen **Entscheider**, wo vorher eine Zahl oder eine verstreute
> Regel stand — und beide sind absichtlich **wirkungslos ausgeliefert**: Der
> Evidenzentscheid läuft im Schatten mit Flag auf AUS, der Context Governor
> läuft mit einem Budget, das effektiv auf null steht. Das ist die Prüfhaltung
> für diesen Bereich: Nicht „ist die Entscheidung richtig", sondern **„ist sie
> wirklich folgenlos, und wird sie es aufhören zu sein, ohne dass es jemand
> merkt"**. Der teuerste Fehler hier ist ein Pfad, der schon heute wirkt.

## 1. Prüfumfang

`git log --oneline f780cae..HEAD`, in Reihenfolge alt → neu:

| Commit | Strang | Betreff |
|---|---|---|
| `2cc1d6a` | **a** | Der deterministische Evidenzentscheid als Prädikat (#264) |
| `d1abff4` | **a** | Der Evidenzentscheid läuft im Schatten mit (#264) |
| `c30ee6d` | **a** | Der Evidenzentscheid bekommt seinen Schalter — aus (#264) |
| `48d7271` | **a** | stats wertet den Evidenzentscheid aus (#264) |
| `e7bc670` | **b** | Der Context Governor als eine Entscheidung (#266) |
| `095c5af` | **b** | Der Assembler trimmt nicht mehr selbst (#266) |
| `f02361a` | **b** | Die Hint-Lanes entscheiden die Wiedererwähnung nicht mehr selbst (#266) |

**Betriebszustand beim Übergeben:** Die Shadow-Acceptance-Uhr aus §18.2 läuft
seit dem Daemon-Neustart um 15:01 — die Freigabebedingung ist ≥14 Kalendertage
**oder** ≥500 protokollierte Hook-Entscheidungen, und `stats.ts` berichtet den
Fortschritt. Die Aktivierungs-Reihenfolge steht vollständig in
[#422](https://github.com/n0mad-ai/bastra-recall/issues/422); sie ist **nicht**
Teil dieses Prüfumfangs.

---

## 2. Strang a — Evidenzentscheid (#264, Aktivierung = #422)

### 2.1 Was gebaut wurde

Heute entscheidet eine Zahl, ob ein Treffer verbindlich ist: `score >= 100`. Auf
dem Hybridpfad ist dieser Score eine skalierte Rang-Summe mit Obergrenze 163,93 —
eine Unsinnsanfrage reißt die 100 mühelos, weil eine Liste immer ein erstes
Element hat. Auf dem BM25-Pfad ist derselbe Score unbegrenzt und sechsstellig.
§10.3 überträgt die alten Schwellen 30/100 ausdrücklich **nicht** auf die neue
Semantik.

`2cc1d6a` setzt an ihre Stelle einen erklärbaren Regelentscheid über benannte
Evidenz, in **core** und nicht im Daemon, weil §16.2 eine zentrale
Implementierung für Hooks und MCP-Recall verlangt: Die beiden Pipelines
unterscheiden sich, die Entscheidung darf es nicht. `required` verlangt einen
harten Anker — exakter Identifier-Treffer oder vollständig abgedeckter
handgeschriebener Trigger — **oder** mindestens zwei unabhängige Signale.

`d1abff4` lässt es im Schatten mitlaufen, auf dem Hook-Recall-Pfad direkt neben
`weak_result`: dort tragen die Treffer noch ihre Hop-Herkunft, die die Projektion
darunter wegwirft und die C-046 am Entscheidungspunkt verlangt. Beurteilt wird
gegen die **ursprüngliche** Anfrage, nicht gegen die brückenerweiterte — was der
Nutzer gefragt hat, nicht was die Suche daraus gemacht hat.

`c30ee6d` gibt ihm den Schalter (`evidenceGate.enabled`, Env-Überstimmung
`BASTRA_EVIDENCE_GATE`), Default AUS. `48d7271` gibt `stats.ts` drei Sichten:
Shadow-Acceptance-Fortschritt, Hop-Herkunft der `required`-Hits mit
C-046-Warnzeile, und die Abweichung Legacy gegen Entscheid.

### 2.2 Invarianten, die ein Reviewer angreifen sollte

- **Die Unabhängigkeits-Definition der zwei Signale — der stärkste Angriffspunkt
  im Strang.** „Unabhängig ist wörtlich gemeint: drei verschiedene Quellen, nicht
  zwei Ausprägungen derselben." Im Code sind es
  `recall_when_coverage > 0`, `arm_agreement`, `scope_match`
  (`evidence-decision.ts:226-231`), und `required` fällt bei
  `hardAnchor || independent >= 2` (`:233`). Prüfen: Sind die drei wirklich
  unabhängig? `arm_agreement` heißt, dass zwei Retrievalarme denselben Treffer
  hoch ranken — beide Arme sehen aber dieselben Felder, und `recall_when` ist
  eines davon. Wenn ein `recall_when`-Teiltreffer die Armübereinstimmung
  mitverursacht, sind zwei der drei Signale korreliert, und die Zwei-Signale-Regel
  ist faktisch eine Ein-Signal-Regel. Das ist kein Codefehler, den ein Test fängt;
  es ist die Frage, ob die Regel meint, was sie sagt.
- **Die Cue-Sperre ist strukturell, nicht ein Feld.** Ein abgeleiteter Cue kann
  keinen der beiden Wege zum harten Anker öffnen, weil `recall_when_coverage` nur
  den handgeschriebenen Trigger zählt (§10.2, C-030 — dokumentiert an `:217`).
  Für den Cue wurde bewusst **keine** Provenienz erfunden: Die Schicht ist in
  Produktion aus, und ein Feld dafür wäre Vorratscode. Prüfen: Trägt die
  strukturelle Sperre auch dann, wenn die Cue-Schicht später eingeschaltet wird —
  oder wandert dann ein Cue-Treffer über `cues_flat` unbemerkt in die
  Coverage-Berechnung? Das ist der Fall, in dem eine heute korrekte Zusage später
  still bricht.
- **Drei Sperren greifen vor jeder Signalstärke:** Graph-Hop (`:224`, C-046),
  abgelaufenes Ziel (`:223`, `:161`), abgeleiteter Cue. Prüfen: Greifen sie
  wirklich unabhängig von der Signalstärke, oder gibt es eine Kombination, in der
  ein harter Anker eine Sperre überstimmt?
- **Verbotene Felder sind abwesend, nicht erfunden.** Keine
  `relevance_probability` bis zur unabhängigen Kalibrierung, keine
  `source_confidence` aus dem heutigen `confidence`-Feld mit Default 1,0 (C-049),
  keine aus einem Rang zurückgerechnete Vektor-Ähnlichkeit. Fehlende Signale sind
  **abwesend**, nicht null. Prüfen: Steht irgendwo doch ein Default, der ein
  fehlendes Signal in ein negatives verwandelt? Der Unterschied entscheidet, ob
  eine spätere Auswertung „kein Signal" von „Signal war schwach" trennen kann.
- **Der Entscheid wirkt auf nichts.** Zwei Tests halten das auf dem
  **Laufzeitpfad** fest, nicht nur im Prädikat: je Treffer eine Entscheidung in
  derselben Reihenfolge, und auch ein `no_answer` entfernt niemanden aus der
  Antwort. Prüfen: Gibt es einen Pfad — Telemetrie, Banding, Projektion —, auf dem
  der Schattenlauf heute schon etwas verändert? Das ist der teuerste denkbare
  Befund in diesem Bereich.
- **Der atomare Fallback.** Fail-open, und geprüft: Ein Defekt im Entscheid lässt
  die Entscheidungsliste **leer**, und der Filter läuft nur, wenn sie da ist. Ein
  Controller-Defekt kostet damit keine Antwort, geht in keine Statistik und in
  keine Unterdrückung (C-047). Dafür hat `HookRecallDeps` eine **Injektionsnaht**
  bekommen — ein Defektpfad, der sich nur in echt zeigt, ist kein geprüfter
  Defektpfad. Prüfen: Ist „leer" wirklich der einzige Defektzustand? Eine
  **teilweise** gefüllte Liste — etwa ein Wurf mitten in `decideHits` (`:262`) —
  wäre der gefährliche Fall: Der Filter liefe, aber auf unvollständiger Grundlage.
- **Die Richtung der Env-Überstimmung.** `BASTRA_EVIDENCE_GATE` überstimmt die
  Einstellung und nicht umgekehrt, weil Ausmachen ohne Dateibearbeitung gehen muss:
  Der Rückfall ist die wichtigere Richtung. Das Flag wird **beim Boot** gelesen,
  nicht je Recall (der Hook-Pfad verträgt keinen Dateizugriff pro Aufruf), ein
  Umschalten wirkt also erst nach Neustart — der Rückfall bei einem Defekt
  dagegen sofort. Prüfen: Stimmt die Asymmetrie im Code, und kann ein scharfer
  Gate unbemerkt laufen? Die Boot-Meldung ist die einzige Sicherung dagegen.
- **§10.3 und §8.5 teilen kein Feld.** Eigene Ereignisklasse
  `evidence_decision` statt eines Feldes am Recall — der Entscheid hat einen
  anderen Lebenszyklus (er wird scharf geschaltet, der Recall bleibt) und eine
  andere Vertragsklasse. Das `no_answer` aus §10.3 ist **nicht** das aus §8.5, und
  ein gemeinsames Feld wäre die Einladung, sie zu addieren; ein Test prüft, dass
  der Recall keins von beidem trägt. Prüfen: Werden sie in `stats.ts` oder in
  einer Auswertung doch zusammengeführt?
- **Was nicht mitzählt, zählt begründet nicht mit.** Degradierte Läufe (ein
  Budget-Abbruch ist keine Abstention, C-047/C-052) und gescheiterte Entscheide
  (Zähler auf null, sichtbar, aber in keiner Statistik). Ein Entscheid ohne
  aufgezeichnete Hop-Herkunft ist „unbekannt", **nicht** „direct". Prüfen: Gibt
  es einen Zählpfad, der `unbekannt` als `direct` verbucht? Das würde die
  C-046-Warnzeile stumm schalten.
- **Die Score-Raum-Grenze der Abweichungssicht.** Verglichen werden nur
  **fusionierte** Läufe: Auf dem BM25-Fallback ist der Score unbegrenzt und die
  Cuts beschreiben nichts; ein Vergleich dort setzte ein Band voraus, das Legacy
  nie angelegt hat. Der Score-Raum kommt über die `recall_id` aus dem
  `hook_recall`-Event; fehlt es, wird die Entscheidung **übersprungen und
  gezählt** statt gegen ein geratenes Band gerechnet. Prüfen: Wie groß ist die
  übersprungene Menge, und kann sie so groß werden, dass die Abweichungssicht die
  Freigabebedingung aus §18.2 nur noch scheinbar erfüllt? Eine Abweichungsprüfung
  auf 40 % der Fälle ist keine Abweichungsprüfung.
- **Keine Inhalte im Event.** Kein Query-Rohtext, keine Frontmatter, kein Pfad
  (#377) — geprüft mit einer Anfrage, die einen Vault-Titel enthält. Prüfen:
  Trägt ein `abstain_reason` oder ein Debug-Feld doch Inhalt?

### 2.3 Wie verifiziert wurde

226 Zeilen Tests für das Prädikat, 218 für den Schattenlauf, 101 weitere für den
Schalter — darunter der über die Injektionsnaht geprüfte Defektpfad. Jedes Event
trägt seine Zählung, damit **beide** Bedingungen der Shadow-Acceptance aus §18.2
aus dem Log **rechenbar** statt geschätzt sind; das ist die eigentliche
Verifikationsleistung von `d1abff4`, und `48d7271` ist der Leser dazu.

**Noch nicht verifiziert und deshalb kein Befund:** Ob der Entscheid *besser*
entscheidet als die Zahl. Das ist genau die Frage, die #422 offenlässt —
Shadow-Acceptance, erklärte Abweichungen, Komponenten-Gates auf dem Goldset.
Solange die läuft, ist ein Befund der Form „der Entscheid liegt bei Fall X falsch"
zwar interessant, aber verfrüht; wertvoll ist ein Befund der Form „die
Abweichungssicht könnte X gar nicht zeigen".

---

## 3. Strang b — Context Governor (#266)

### 3.1 Was gebaut wurde

Kontextbudget gab es nur als verstreute Stückgrenzen: `TOTAL_HINTS_CAP` in der
Lane, `MAX_HINTS` im Assembler, `k` je Query, 220 Zeichen Summary-Kürzung, dazu
zwei eigene Wiedererwähnungs-Logiken in den Lanes. `hint_tokens_est` misst mit und
erzwingt nichts — **~519k injizierte Hint-Token für 82 acted-on Loads** im
30-Tage-Schnitt. Niemand entschied über das Ganze, weil niemand das Ganze sah.

`e7bc670` baut den Entscheider für die drei Fragen, die heute einen Freiheitsgrad
haben: wie viele Memories, wie viele Token, ob ein schon gezeigtes erneut erwähnt
werden darf. Titel/Summary gegen vollen Load hat keinen Freiheitsgrad — der volle
Load ist ein Werkzeug des Agenten; Zonenausschluss wartet auf M3, ein Feld dafür
wäre Vorratscode für ein Gate, das nicht bestanden ist.

`095c5af` löst das Trimmen im Assembler ab, `f02361a` die Wiedererwähnung in den
beiden Hint-Lanes.

### 3.2 Invarianten, die ein Reviewer angreifen sollte

- **Der Hebel steht auf null — und das ist der eigentliche Befund.** Beide Lanes
  rufen `governContext` **ohne Budget** auf. Das ist ihr heutiger effektiver Wert:
  `k` ist ein Retrieval-Parameter und keine Kontextgrenze, die 220-Zeichen-Kürzung
  ist Detailgrad und keine Menge. Es gab **nie** ein Budget. Ein Budget hier zu
  setzen wäre eine Verschärfung und gehört in eine Konfigurationsentscheidung mit
  gemessenen Zahlen (#354). Prüfen: Stimmt „es gab nie ein Budget" wirklich —
  oder wirkte eine der abgelösten Stückgrenzen faktisch als eine, sodass der Umbau
  eine stille Lockerung ist? Das ist die Umkehrung des üblichen Verdachts und
  deshalb leicht zu übersehen.
- **„Bereits gezeigt" bleibt in `session-state.ts`.** Der Governor bekommt das
  **Ergebnis**, nicht die Regel — sonst wäre aus der Vereinheitlichung eine
  Verlagerung geworden. Das 4h-Fenster, `MAX_SHOW` und der Load-Marker, der den
  Zähler zurücksetzt, bleiben dort. Prüfen: Ist wirklich nur das Ergebnis
  gewandert, oder ist ein Stück Semantik mitgekommen?
- **Ausgabe- gegen Prioritätsreihenfolge.** Zuerst fällt das schon Gezeigte, dann
  wird nach Priorität gefüllt (`context-governor.ts:148`), **ausgegeben wird in
  Eingabereihenfolge** (`:167`, dokumentiert an `:90`) — sonst verliert man den
  wichtigen Eintrag, der unten stand. Das ist dieselbe Trennung wie beim
  Session-Assembler in Übergabe Nr. 3 (Textreihenfolge ≠ Budgetpriorität), hier
  ein zweites Mal. Prüfen: Bleibt die Eingabereihenfolge auch dann erhalten, wenn
  Prioritäten gleich sind — und ist der Tiebreak (`a.i - b.i`) an allen
  Aufrufstellen der, den der Aufrufer erwartet?
- **Was allein das Budget sprengt, fällt ganz.** Ein halber Beleg ist keiner.
  Prüfen: Gibt es einen Pfad, auf dem ein Eintrag gekürzt statt gestrichen wird?
- **Jeder gestrichene Eintrag trägt seinen Grund.** Drei Gründe, mehr nicht:
  `already_shown`, `item_budget`, `token_budget` (`:81-87`). Ein stillschweigend
  gestrichener Kandidat wäre genau die Unsichtbarkeit, die #266 beheben soll.
  Prüfen: Fällt irgendwo etwas ohne Grund heraus — insbesondere in `095c5af`, wo
  die Streichgründe **durch** die `blocks`-Liste laufen müssen?
- **Zwei Dinge bleiben bewusst beim Aufrufer** (`095c5af`): Leere Abschnitte gehen
  gar nicht erst hinein — sie kämen mit 0 Token durch und stünden als
  *aufgenommen* da —, und ein Deadline-Abbruch behält seinen eigenen Grund, weil
  ein Abschnitt, der nie fertig wurde, nicht am Budget gescheitert ist. Prüfen:
  Ist diese Grenze sauber gezogen, oder kann ein leerer Abschnitt doch als
  aufgenommen erscheinen?
- **Der Governor sortiert nicht um, beschafft nichts nach und lernt nichts.** Er
  liest keine Hop-Herkunft (Trimmen darf die `related_via`-Sicht nicht als
  **Klasse** wegräumen), kein Deep Recall, kein Reranker, kein Index — und die
  Wiedererwähnung ist Sitzungszustand, **kein Nutzungssignal**. Alles vier ist mit
  Abwesenheitstests belegt. Prüfen: Sind die Abwesenheitstests scharf, oder
  bestünden sie auch nach einer Umbenennung? (Dieselbe Frage wie bei den
  SessionStart-Abwesenheitstests in Übergabe Nr. 3.) Und: Könnte die
  Wiedererwähnung über einen Umweg doch als Nutzungssignal gelesen werden?
- **`estimateTokens` gibt es nur noch einmal.** Der Assembler re-exportiert die
  Formel des Governors. Prüfen: Existiert eine dritte Schätzung irgendwo im
  Repository?

### 3.3 Wie verifiziert wurde

`095c5af`: **24 Konfigurationen** gegen die Fassung davor — mit und ohne Projekt,
sechs Token-Budgets von 0 bis 10000, Cross-Project an und aus. Verglichen wurde
neben dem gerenderten Text auch die **Report-Liste** mit Prioritäten, Schätzungen
und Streichgründen; null Unterschiede. `f02361a`: **200 zufällige Trefferlisten**
gegen die abgelöste Schleife, wörtlich nachgebaut — gleiche Menge, gleiche
Reihenfolge. `e7bc670`: 156 Zeilen Tests, darunter die vier Abwesenheitsbelege.

Beide Refactorings tragen den Satz „kein Test angepasst" — siehe **Prüfregel 7**.

Nebenbefund, der für die Prüfung nützlich ist: Die Bash-Lane erhöhte bisher nur
`droppedDedupCount` und verlor, **welche** Treffer es traf. Der Governor nennt
sie. Wo vorher nur gezählt wurde, gibt es jetzt eine Liste, an der sich eine
Regressionsfrage überhaupt erst stellen lässt.

## 4. Bekannte offene Punkte — nicht neu suchen

| Issue | Kurz |
|---|---|
| [#421](https://github.com/n0mad-ai/bastra-recall/issues/421) | Vereinheitlichung der Hook- und MCP-Recall-Pipelines — ein hookloser Client sieht heute eine andere Trefferauswahl. Aus Übergabe Nr. 3 als „Zwei-Pipelines-Wahrheit" bekannt, jetzt als V2-Issue erfasst. |
| [#422](https://github.com/n0mad-ai/bastra-recall/issues/422) | Aktivierung des Evidenzentscheids: Shadow-Acceptance, erklärte Abweichungen, Komponenten-Gates auf dem Goldset, Daniels Entscheidung, Legacy-Entfernung zuletzt. Die Reihenfolge steht dort; sie ist **nicht** Prüfgegenstand. |
| [#354](https://github.com/n0mad-ai/bastra-recall/issues/354) | Die Budget-Zahlen für den Governor. Der injizierte Kontext ist die Latenz — ~143k Hint-Token in fünf Tagen, und jeder Block bleibt im Transkript. |
| [#416](https://github.com/n0mad-ai/bastra-recall/issues/416) | `packages/eval/src/goldset-harvest.ts` enthält rohe NUL-Bytes. **Weiterhin: Diffs dieser Datei nur mit `git diff --text`**, `grep -rn` überspringt sie stillschweigend. |
| [#417](https://github.com/n0mad-ai/bastra-recall/issues/417) | Das Run-Artefakt speichert abgeleitete Ränge, nicht die Top-k-id-Listen. |
| [#413](https://github.com/n0mad-ai/bastra-recall/issues/413) | Der hook-komponierte Filter fängt nur die englische Query-Form. |
| [#415](https://github.com/n0mad-ai/bastra-recall/issues/415) | Bash-Tripwire feuert auf Prosa in einem Heredoc. |
| [#418](https://github.com/n0mad-ai/bastra-recall/issues/418) | Autorenstufe: 150 associative, 40 C-036, 40 englische Fälle, vault-blind. Blockiert unter anderem die Komponenten-Gates aus #422. |
| [#419](https://github.com/n0mad-ai/bastra-recall/issues/419) | `tsconfig` schließt `scripts/` aus — betrifft in diesem Bereich unmittelbar `packages/daemon/scripts/stats.ts` aus `48d7271`. |
| [#420](https://github.com/n0mad-ai/bastra-recall/issues/420) | Testläufe schreiben echte Artefakte nach `~/.bastra/eval-runs`. |

Aus den Übergaben Nr. 1 und Nr. 2 weiterhin offen und dort beschrieben: #377
(Meldestellen der Mutations-Telemetrie) sowie #379–#382 (v0.9.3-Write-Path-Härtung).

## 5. Prüfregeln

1. **P0 wird sofort gefixt.** Alles andere wird ein Issue — kein
   Sammel-Review-Dokument, keine Drive-by-Fixes an Nicht-P0-Befunden.
2. **Jeder Befund mit Referenz.** Commit-SHA und `datei.ts:zeile`.
3. **Der Prüfumfang ist der Diff, nicht das Repository.** Ältere Schwächen, auf die
   der Diff nur zeigt, sind ein Issue mit Hinweis darauf.
4. **Bei `packages/eval/src/goldset-harvest.ts`: `git diff --text`** (siehe #416).
5. **Gemessene Zahlen schlagen Plausibilität.** Wo dieses Dokument eine Messung
   nennt, steht der Weg zum Nachrechnen im verlinkten Issue-Kommentar. Eine Zahl
   anzuzweifeln ist willkommen — dann bitte mit einer Gegenmessung.
6. **Registrierte Zahlen sind ein eigener Prüfgegenstand:** Ist die Zahl aus einem
   Lauf hergeleitet oder gesetzt, hält sie gegen jeden hinterlegten Lauf, und ist
   die verworfene Vorgängerfassung noch aktenkundig?
7. **„Kein Test musste angefasst werden" ist eine Behauptung, keine Verifikation.**
   In diesem Bereich tragen `095c5af` und `f02361a` den Satz, beide als Argument
   für Verhaltensgleichheit. Beide stützen ihn hier immerhin mit einem eigenen
   Äquivalenzbeleg (24 Konfigurationen, 200 Listen) — die Frage bleibt, ob der
   Beleg den Raum abdeckt, in dem sich die Fassungen unterscheiden könnten.
8. **Wirkungslosigkeit ist in diesem Bereich die Hauptzusage.** Beide Stränge
   liefern absichtlich folgenlos aus. Ein Befund, der zeigt, dass heute doch etwas
   wirkt — im Schattenlauf, im Governor ohne Budget —, ist P0 und nicht Issue.
