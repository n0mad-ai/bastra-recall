# Codex-Übergabe Nr. 2: Gegenreview 320e19b..HEAD

**Stand:** 28. August 2026
**Prüfumfang:** `320e19b..HEAD` (Stand beim Übergeben: ______, zuletzt gesehen `fdf5a4b`)
**Vorherige Übergabe:** [`docs/reviews/2026-08-28-handover-codex-1.md`](2026-08-28-handover-codex-1.md) (`ad86155..320e19b`)
**Prüfregel:** P0 wird sofort gefixt, alles andere wird Issue

> Etappe A ist abgeschlossen. Diese Übergabe deckt die zehn Commits danach ab:
> den Abschluss von M1 (die zweite registrierte Toleranz steht jetzt auf einem
> Prädikat, das feuern kann), das Split-Werkzeug für den Holdout, und die
> Cue-Schicht. Zur Cue-Schicht gehört ein Befund, der die Prüfhaltung ändert —
> Abschnitt 5: Sie ist gebaut, gemessen, und sie bewegt auf der geprüften
> Achse **nichts**. Codex prüft sie als Infrastruktur, nicht als wirksames Feature.

## 1. Prüfumfang

`git log --oneline 320e19b..HEAD`, in Reihenfolge alt → neu:

| Commit | Strang | Betreff |
|---|---|---|
| `faa7050` | **a** | `weak_result` zieht nach core, damit der Goldset-Lauf es messen kann |
| `77083fe` | **a** | Der Goldset-Lauf protokolliert, worüber ein Treffer verankert ist |
| `4d701ef` | **a** | Die Handkopie der Prädikate ist überflüssig geworden |
| `35f5de2` | **a** | `false_abstention` auf `weak_result` statt auf dem Score-Floor registriert |
| `49ffe1d` | **a** | `relevant_loss` auf 0,24 angehoben — über jeden hinterlegten Lauf |
| `0994df9` | **b** | Deterministischer stratifizierter Split für den Design-A-Holdout |
| `152c61d` | **c** | Cue-Schicht als read-only Sidecar-Projektion (§11.4) |
| `506d31c` | **c** | Achtes BM25-Feld für abgeleitete Cues, aus wenn nichts geladen ist |
| `fd42fd6` | **c** | Batch-Weg der Cue-Erzeugung (§31 Entscheidung 1) |
| `d44e19e` | **c** | Messskript der OB-Vorfrage, damit ihr Artifact reproduzierbar bleibt |

**Angekündigt, beim Schreiben dieser Übergabe noch nicht gelandet:** ein
Umregistrierungs-Commit von opus-262, der die feste Konfiguration von Design A
von `descriptive_entity` auf `associative_bridge` umschreibt
(`registration_version`-Bump). Er gehört inhaltlich zu Strang c und zum Befund in
Abschnitt 5; falls er beim Übergeben im Bereich liegt, ist er mitzuprüfen — die
Invarianten dazu stehen in 4.2.

---

## 2. Strang a — M1-Abschluss auf `weak_result`

### 2.1 Was gebaut wurde

M1 hatte nach der Baseline eine Toleranz und eine Verweigerung: `relevant_loss`
bekam eine Zahl, `false_abstention` ausdrücklich keine, weil Abstention damals ein
Score-Floor war, der auf dem Hybrid-Pfad arithmetisch nicht feuern kann — ein
Rang-1-Treffer erzielt `RRF_SCALE/(RRF_K+1)` = 81,967 gegen einen Floor von 30.
Der registrierte Nachfolger war `weak_result`, das lexikalische Ankerprädikat, und
sein `blocked_by` benannte genau eine Hürde: Es lag in `packages/daemon`, und
`packages/eval` hängt nicht am Daemon.

`faa7050` zieht es nach core — dem einen Workspace, an dem ohnehin jeder Pfad
hängt. Reiner Umzug, Prädikatkörper unverändert, der einzige Import war
`type RecallHit`. `goldset-run` trägt seither pro Fall ein `weak_result`,
berechnet mit **derselben** Implementierung statt einem zweiten Nachbau.

`77083fe` beantwortet die Frage, die der erste Messlauf offenließ: `weak_result`
feuerte auf den 372 answerable-Fällen null Mal, und der Lauf konnte nicht sagen
warum — die Zeilen hielten fest, *dass* nichts verankerte, nie *was*. Jede Zeile
trägt jetzt `anchor` (`recall_when` | `title` | `both` | `none`). Ergebnis: Auf
answerable verankern **87,9 % der Fälle doppelt**, über `recall_when` und Titel am
selben Treffer. Ein `weak_result` verlangt, dass beide Signale auf allen zehn
Treffern gleichzeitig ausfallen.

`4d701ef` entfernt die byte-identische Handkopie von `hitTitleMatches`,
`isWeakResult` und `isNoHome` aus `absence-honesty.ts`. Ihre Begründung — ein
Import zöge den Daemon-Workspace in den Abhängigkeitsgraph von eval — gilt seit
`faa7050` nicht mehr. Der Drift-Wächter `absence-honesty-parity.test.ts` geht mit,
weil er seinen Gegenstand verloren hat.

`35f5de2` registriert `false_abstention <= 0,015`, gesetzt aus der Wilson-Obergrenze
auf einer Nullzählung (1,02 %). `49ffe1d` hebt `relevant_loss` von 0,23 auf 0,24:
0,23 stammte allein aus der Baseline (Wilson-Obergrenze 22,81 %), zwei spätere
Läufe auf leicht gewachsenem Vault (1028 → 1033 Memories) maßen 70/372 statt
69/372, was die Grenze auf 23,10 % schiebt — 0,10 pp über der Toleranz.

### 2.2 Invarianten, die ein Reviewer angreifen sollte

- **Die Toleranz liegt über der CI-Obergrenze *jedes* hinterlegten Laufs, nicht
  nur der Baseline.** Genau diese Lücke machte `49ffe1d` nötig: Ein Re-Run ohne
  jede Regression hätte das Gate reißen können, und ein Gate, das so reißt, wird
  nicht mehr gelesen. Der Test prüft jetzt gegen jeden hinterlegten Lauf. Prüfen:
  Greift das für **beide** Toleranzen, oder nur für `relevant_loss`? Und was
  passiert, wenn ein dritter Lauf nachgetragen wird, der die Grenze erneut schiebt
  — schlägt der Test an, oder wird er still?
- **Prädikat-Identität core = daemon = eval.** Der ganze Sinn von `faa7050` +
  `4d701ef` ist, dass gemessen wird, was ausgeliefert wird. Prüfen: Gibt es
  irgendwo noch eine dritte Implementierung oder eine Teilkopie der Prädikate?
  Und: Der Ersatz für den entfallenen Parity-Test ist der Compiler — trägt das,
  oder gibt es einen Pfad, auf dem eval das Prädikat mit anderen Parametern
  aufruft als der Hook-Pfad?
- **`anchor === "none"` ⟺ `weak_result === true`.** Das gilt laut Commit-Text
  „auf dem Hybrid-Pfad mit nicht-leerem Pool". Prüfen: Was passiert bei leerem
  Pool, auf dem BM25-only-Arm und auf dem Kontrollarm? Wenn die Äquivalenz dort
  bricht, ist `anchor` als Erklärung für `weak_result` nur bedingt gültig — und
  auf dieser Erklärung steht die Toleranz.
- **Gemessen wird auf der servierten Liste.** `weak_result` und `abstained`
  müssen auf derselben Liste bestimmt werden, sonst vergleicht die Toleranz zwei
  verschiedene Dinge. Prüfen: Ist das an allen Aufrufstellen so?
- **Der Lauf ist Messung, kein Gate.** `weak_result` wird aufgezeichnet, nicht
  bewertet. Prüfen: Beeinflusst der aufgezeichnete Wert irgendwo eine Kennzahl?
- **Die verworfene Mechanik bleibt aktenkundig.** Der Score-Floor wurde nicht
  gelöscht, sondern als aufgegeben verzeichnet — er erklärt, warum die *Mechanik*
  getauscht wurde statt die *Zahl* getunt. Prüfen: Lässt sich aus der
  Registrierung noch rekonstruieren, welche Zahl auf welcher Mechanik entstand?

### 2.3 Wie verifiziert wurde

`35f5de2` steht auf einem zweiten Messlauf: 0 von 372 answerable, gegen 3 von 8
Gibberish-Sonden und 1 von 60 No-Answer-Fällen. `49ffe1d` auf zwei
Bestätigungsläufen, die neben der Baseline verzeichnet sind, statt sie zu
ersetzen; beide Punktschätzer (18,55 %, 18,82 %) liegen weit unter beiden Grenzen,
es wurde also nur der Rauschabstand wiederhergestellt, nicht die Aussage
verschoben. `registrations.test.ts` wuchs in beiden Commits mit.

**Offen und im Commit selbst benannt:** Die Sensitivität ist unvollständig — 5 von
8 Unsinn-Sonden finden weiterhin einen lexikalischen Anker, und warum das Prädikat
auf *jedem* answerable-Fall schweigt, untersucht ein eigener Lauf. Die Toleranz
steht auf dem, was gemessen wurde. Das ist eine bewusste Entscheidung und kein
übersehener Punkt; ein Befund dazu ist trotzdem willkommen, wenn er zeigt, dass
die Toleranz dadurch bedingungslos besteht.

---

## 3. Strang b — Split-Tooling

### 3.1 Was gebaut wurde

§18.3 verbietet, die festgehaltene Cue-Konfiguration auf denselben Fällen zu
wählen, auf denen der Vergleich danach läuft. `0994df9` ist der Split, der beides
auseinanderhält — und er **stratifiziert**, statt nur zu seeden: Recall@3 streute
in der M0-Baseline pro Gold-Datei von 31,3 % bis 84,9 %, eine unstratifizierte
Ziehung kann die Vergleichsbasis also weiter verschieben als der zu messende
Effekt. Reproduzierbar, was schlimmer ist als verrauscht. Auf dem descriptive-Pool
ergibt die registrierte 30/70-Teilung 109 Selection- und 256 Holdout-Fälle,
komfortabel über dem registrierten Minimum von 213.

### 3.2 Invarianten, die ein Reviewer angreifen sollte

- **Determinismus.** Gleicher Seed, gleiche Eingabe, byte-gleiche Ausgabe. Der
  Seed (20260828) wurde *vor* dem Lauf fixiert — ein nach Sicht der Ergebnisse
  gewählter Seed wäre die Manipulation, gegen die der ganze Mechanismus steht
  (`goldset-split.ts:39-41`). Prüfen: Gibt es eine Stelle, an der der Seed nach
  dem ersten Blick auf Daten gesetzt werden könnte?
- **Stratum-Isolation.** Ein Generator **pro Stratum**, geseedet aus Run-Seed und
  Stratum-Name (`:110-111`), damit das Hinzufügen eines Stratums die Ziehung in
  den daneben liegenden nicht umwirft. Prüfen: Trägt die Seed-Ableitung wirklich
  Kollisionsfreiheit über Stratum-Namen, oder können zwei Namen denselben
  Generator-Zustand erzeugen?
- **Reihenfolge-Unabhängigkeit.** Strata-Schlüssel sortiert (`:108`), ids
  innerhalb eines Stratums sortiert (`:109`), damit die Reihenfolge, in der die
  Gold-Dateien konkateniert wurden, keinen Fall bewegt. Prüfen: Ist die Sortierung
  wirklich total — was passiert bei gleichen ids oder bei Locale-abhängigem
  `localeCompare`?
- **Kein unstratifizierter Split über die Hintertür.** `:86` wirft, wenn
  `stratifyBy` leer ist („an unstratified split is a lottery with a seed").
  Prüfen: Kann ein Aufrufer die Prüfung mit einem Feld umgehen, das faktisch
  konstant ist?
- **Proportionen halten *innerhalb* jedes Stratums**, nicht nur im Aggregat —
  `round(n × selectionShare)` pro Stratum. Prüfen: Was macht das Runden bei sehr
  kleinen Strata (n = 1, n = 2)? Ein Stratum, das komplett in eine Hälfte fällt,
  ist genau der Fall, den die Stratifizierung verhindern soll.

### 3.3 Wie verifiziert wurde

97 Zeilen Tests in `packages/eval/__tests__/goldset-split.test.ts`. Der Split hat
seinen ersten Ernstfall im OB-Lauf hinter sich (Abschnitt 5): Parameter auf den
109 Selection-Fällen fixiert, einmal auf den 256 Holdout-Fällen gemessen.

---

## 4. Strang c — Cue-Schicht

### 4.1 Was gebaut wurde

Ein Cue beantwortet „wann soll das auftauchen?", die Evidenz „was steht da und
warum stimmt es?". §11.4 lässt abgeleitete Cues neben dem handgeschriebenen
`recall_when` zu, aber unter Auflagen. `152c61d` baut sie als read-only
Sidecar-Projektion unter `.bastra/cues.jsonl` — dort, wo alles Abgeleitete liegt;
in `memories/` wäre sie genau die Vermischung, die die Auflage verhindern soll.
JSONL, weil ein abgebrochener Batchlauf dann einen Cue kostet und nicht die
Projektion.

`506d31c` gibt der Projektion ein **achtes** BM25-Feld (`cues_flat`).
`recall_when` und abgeleiteter Cue haben verschiedene Vertrauensklassen und werden
nach §11.4 nie zu einem Feld verschmolzen; `matched_recall_when` bleibt dem
handgeschriebenen Trigger vorbehalten.

`fd42fd6` ist der Batch-Weg der Erzeugung — eine der beiden Bedingungen von
Anlage A, die §31 Entscheidung 1 gegeneinander stellen will. Gelesen wird der
autorisierte Inhalt (Titel, Summary, Tags, `topic_path`, Body), `recall_when`
**nicht**, auch nicht zum Entdoppeln.

`d44e19e` legt das Wegwerf-Messskript des explorativen OB-Laufs ab, weil die
`command.txt` des Artifacts darauf verweist und ein Lauf ohne existierendes
Kommando nicht reproduzierbar ist.

### 4.2 Invarianten, die ein Reviewer angreifen sollte

**Sidecar (`152c61d`):**

- **Pflicht-Provenienz, kein Default.** Alle Provenienzfelder sind Pflicht; ein
  fehlendes `confidence` wird **nicht** auf 1 defaultet, weil ein ausgedachter
  Wert keine Provenienz ist. `parseCueRecord` (`cue-sidecar.ts:215`) gibt `null`
  zurück statt zu ergänzen. Prüfen: Gibt es ein Feld, das doch stillschweigend
  gefüllt wird?
- **Ungültig, nicht unvollständig.** Ein Cue ohne auflösbare Ziel-ID oder ohne
  Evidenzverbindung ist ungültig. Prüfen: Landet ein solcher Cue wirklich nie in
  `byMemory`?
- **Content-Fingerprint, nicht mtime.** Der Evidenzbezug ist ein Fingerabdruck des
  autorisierten Inhalts (`cueSourceFingerprint`, `:121`; Vergleich `:279-280`) und
  trägt zwei Auflagen zugleich: die Verbindung zur Evidenz und die Veraltungsregel.
  Über den Inhalt und nicht über mtime, sonst entwertete der erste Sync jeden Cue.
  Prüfen: Welche Felder gehen in den Fingerprint, und kann eine bedeutungslose
  Änderung ihn brechen — oder schlimmer, eine bedeutungsvolle ihn *nicht* brechen?
- **Verworfen ≠ veraltet.** Getrennte Typen (`CueRejection` `:143`, `CueStale`
  `:157`), weil der Vertrag sie trennt: Ein veralteter Cue wird gezählt und
  gemeldet, statt stillschweigend weiterzufeuern. Prüfen: Werden beide Klassen
  überall getrennt geführt, oder kollabieren sie in einer Zählung oder einem Report?

**Indexfeld (`506d31c`):**

- **Inert by construction.** Ohne geladene Projektion wird `cues_flat` weder
  angemeldet noch gesetzt (`search.ts:558-559`, `:574`, `:603`) — das ist der
  Produktionszustand und zugleich der §11.4-Rollback. Auch **Boost 0** legt das
  Feld nicht an: Mit angemeldetem Feld käme ein Dokument, das nur über einen Cue
  matcht, mit Score 0 trotzdem in den Kandidatenpool. Prüfen: Trägt die
  `boost > 0`-Bedingung an allen drei Stellen, und gibt es einen Pfad, auf dem das
  Feld doch angemeldet wird?
- **Der Identitätstest muss Zähne haben.** Belegt ist beides: fünf Queries ranken
  mit leerer Projektion identisch in Reihenfolge **und** Scores, und ein Cue auf
  einem bestehenden Term schiebt sein eigenes Dokument nach vorn, lässt die Scores
  der übrigen aber unverändert. Der zweite Teil ist der Zähne-Nachweis — ohne ihn
  wäre der erste auch grün, wenn das Feld gar nicht funktionierte. Prüfen: Würde
  der Test rot, wenn man das Feld versehentlich immer anmeldet?
- **`matched_recall_when` bleibt sauber.** Prüfen: Kann ein Treffer über
  `cues_flat` den `recall_when`-Anker setzen (`search.ts:127`, `:198`)?

**Batch-Erzeuger (`fd42fd6`):**

- **Die `recall_when`-Grenze.** Der Erzeuger liest `recall_when` nicht, auch nicht
  zum Entdoppeln (`cue-generate.ts:18`, `:160`). Begründung: Es ist die
  konkurrierende Vertrauensklasse; ein Erzeuger, der die handgeschriebenen Trigger
  liest, schreibt sie um, statt eine eigene Cue-Familie zu bilden — der spätere
  Vergleich der beiden misst dann sich selbst. Prüfen: Kommt `recall_when` über
  einen Umweg doch in den Prompt (Body-Auszug, Frontmatter-Serialisierung,
  `recall_when_expanded`)? Das ist der Befund mit dem höchsten Schaden in diesem
  Strang, weil er ein späteres Messergebnis unbrauchbar macht, ohne dass etwas
  auffällt.
- **Selbsttest als einzige Konfidenzquelle, und als Pflicht.** Die Konfidenz ist
  der reziproke Rang, auf dem ein Cue sein eigenes Memory zurückholt
  (`confidenceFromRank`, `:193`; Aufruf `:220-223`). Anders als beim
  `TriggerExpander`, wo der Selbsttest nur filtert, ist er hier die Quelle einer
  Zahl, die nach §11.4 zur Provenienz gehört. Prüfen: Gibt es einen Pfad, auf dem
  ein Cue ohne Selbsttest ins Sidecar gelangt?
- **`model` und `prompt_version` sind Pflichtfelder** (`:236-237`). Ein LLM ist
  nicht deterministisch; nachvollziehbar ist nicht die Formulierung, sondern wer
  sie mit welchem Modell und welcher Frage erhoben hat. Ohne das ließe sich ein
  Befund aus Anlage A keinem Erzeugungsweg zuordnen. Als Pflicht möglich, weil
  noch keine Cue-Datei existiert — diese Gelegenheit kommt nicht wieder. Prüfen:
  Ist die Pflicht im Parser durchgesetzt, nicht nur im Erzeuger?
- **Freie Parameter bleiben frei.** Cues pro Memory, Konfidenzschwelle, Modell,
  Pooltiefe des Selbsttests und das Feldgewicht sind nach §18.3 freie Parameter
  und werden auf dem *Auswahlteil* bestimmt. Prüfen: Steht irgendwo ein Default,
  der nicht als Platzhalter benannt ist und sich dadurch als registrierte Zahl
  lesen ließe?

**Der Umregistrierungs-Commit ist inzwischen gelandet (`fdf5a4b`):** Prüfen, ob
`registration_version` gebumpt wurde, ob die alte `descriptive_entity`-Registrierung
aktenkundig bleibt statt ersetzt zu werden (dieselbe Regel wie beim Score-Floor in
2.2), und ob die Fallzahl-Herleitung für die neue Familie neu gerechnet statt
übernommen wurde — 7 associative-Fälle im heutigen Goldset tragen die 255 aus der
alten Rechnung nicht.

### 4.3 Wie verifiziert wurde

240 Zeilen Tests für das Sidecar, 262 für das Indexfeld, 254 für den Erzeuger.
Der Identitätstest des Indexfelds ist gemessen, nicht behauptet (Reihenfolge und
Scores). Der Erzeuger hat einen echten Lauf hinter sich: 1950 Cues über 913
Memories mit `gemma3:4b` — siehe Abschnitt 5, wo auch die unangenehme Zahl steht.

---

## 5. Der OB-Befund als Prüfkontext

Aus dem Statuskommentar zu
[#262](https://github.com/n0mad-ai/bastra-recall/issues/262) vom 28.08.2026.
Explorativer gepaarter Lauf — **nicht** das registrierte Design-A-Experiment, das
Artifact sagt das auch so. Batch-erzeugte `descriptive_entity`-Cues (1950 Cues über
913 Memories, `gemma3:4b`, Selbsttest-Konfidenz) gegen keine Cues; Parameter auf
den 109 Selection-Fällen fixiert, einmal auf den 256 Holdout-Fällen gemessen.

**Ergebnis: null Fälle gewonnen, zwei verloren** (b = 0 / c = 2, McNemar p = 0,50).
Recall@3 71,48 % mit Cues gegen 72,27 % ohne, Differenz-CI **[−2,80 pp; +1,26 pp]**
— vollständig unterhalb des registrierten SESOI von 6 pp. Das ist eine
Äquivalenzaussage, kein bloßes Null-Ergebnis: Ein Effekt, groß genug für eine
Produktentscheidung, existiert auf dieser Konfiguration nicht. Die Hypothese aus
§11.4 („nur die assoziative Achse wird erwartbar beitragen — Titel, Tags,
`topic_path` und Summary decken die deskriptive Achse bereits ab") ist genau so
eingetreten, wie sie geschrieben stand.

Zwei Nebenbefunde, die für die Prüfung zählen:

- **Cues können keine Anker erzeugen.** `isWeakResult` prüft ausschließlich
  `recall_when`- und Titel-Matches. Die Cue-Schicht ist damit der falsche
  Mechanismus, um bessere Abstention zu erhoffen — relevant für Strang a.
- **63 % der Modell-Kandidaten waren unparsbar** (5192 von 8280): `gemma3:4b`
  verfehlt das Format zwei von drei Malen, der Selbsttest verwirft den kleineren
  Anteil. Das zählt für den späteren Agent-gegen-Batch-Vergleich.

**Was das für die Prüfung heißt:** Die Cue-Schicht ist als *Infrastruktur* zu
prüfen — Vertragstreue gegen §11.4, Inertheit, Provenienz, Reproduzierbarkeit —,
nicht als wirksames Feature. Ein Befund der Form „das bringt nichts" ist bereits
gemessen und braucht kein Issue. Ein Befund der Form „die Infrastruktur würde
auch dann nichts messen, wenn eine Familie etwas brächte" ist dagegen wertvoll.
Ausstehend (Daniels Entscheidung): Umregistrierung auf `associative_bridge`,
blockiert auf der Autorenstufe #418; der agentenseitige Erzeugungsweg ist
zurückgestellt, bis eine Cue-Familie nachweislich etwas bewegt. Sidecar,
Indexfeld und Batch-Erzeuger stehen und sind für jede Familie wiederverwendbar.

## 6. Bekannte offene Punkte — nicht neu suchen

| Issue | Kurz |
|---|---|
| [#413](https://github.com/n0mad-ai/bastra-recall/issues/413) | Der hook-komponierte Filter fängt nur die englische Query-Form; 46 von 400 gestagten Telemetrie-Queries betroffen. Detektor liegt im Issue. |
| [#415](https://github.com/n0mad-ai/bastra-recall/issues/415) | Bash-Tripwire feuert auf Prosa in einem Heredoc. |
| [#416](https://github.com/n0mad-ai/bastra-recall/issues/416) | `packages/eval/src/goldset-harvest.ts` enthält rohe NUL-Bytes. **Weiterhin gültig: Diffs dieser Datei nur mit `git diff --text`**, `grep -rn` überspringt sie stillschweigend. |
| [#417](https://github.com/n0mad-ai/bastra-recall/issues/417) | Das Run-Artefakt speichert abgeleitete Ränge, nicht die Top-k-id-Listen — Rangbestimmung jenseits Position 1 ist nicht unabhängig nachprüfbar. |
| [#418](https://github.com/n0mad-ai/bastra-recall/issues/418) | Autorenstufe: 150 associative, 40 C-036, 40 englische Fälle, vault-blind. Blockiert die Umregistrierung aus Abschnitt 5. |
| [#419](https://github.com/n0mad-ai/bastra-recall/issues/419) | `tsconfig` schließt `scripts/` aus — 20+ operative Skripte laufen ohne jeden Typecheck. Betrifft unmittelbar `packages/daemon/scripts/cue-batch.ts` aus `fd42fd6`. |
| [#420](https://github.com/n0mad-ai/bastra-recall/issues/420) | Testläufe schreiben echte Artefakte nach `~/.bastra/eval-runs` — 400+ Verzeichnisse, drei entstanden während eines unbeteiligten Builds. |

Aus Übergabe Nr. 1 weiterhin offen und dort beschrieben: #377 (Meldestellen der
Mutations-Telemetrie) sowie #379–#382 (v0.9.3-Write-Path-Härtung).

## 7. Prüfregeln

1. **P0 wird sofort gefixt.** Alles andere wird ein Issue — kein
   Sammel-Review-Dokument, keine Drive-by-Fixes an Nicht-P0-Befunden.
2. **Jeder Befund mit Referenz.** Commit-SHA und `datei.ts:zeile`.
3. **Der Prüfumfang ist der Diff, nicht das Repository.** Ältere Schwächen, auf die
   der Diff nur zeigt, sind ein Issue mit Hinweis darauf.
4. **Bei `packages/eval/src/goldset-harvest.ts`: `git diff --text`** (siehe #416).
5. **Gemessene Zahlen schlagen Plausibilität.** Wo dieses Dokument eine Messung
   nennt, steht der Weg zum Nachrechnen im verlinkten Issue-Kommentar. Eine Zahl
   anzuzweifeln ist willkommen — dann bitte mit einer Gegenmessung.
6. **Registrierte Zahlen sind ein eigener Prüfgegenstand.** Bei allem in
   `packages/eval/registrations/` gilt: Ist die Zahl aus einem Lauf hergeleitet
   oder gesetzt, hält sie gegen jeden hinterlegten Lauf, und ist die verworfene
   Vorgängerfassung noch aktenkundig?
