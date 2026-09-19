# Grundgesamtheit „delivered“ — Befund

Stand: 19.09.2026. Gehört zu `code-awareness-delivered.json`, Registrierung 1
(Option 2: Zustellungsnutzen + Kontextkosten, entschieden von Daniel Nevoigt
am 19.09.2026). Der Entwurf `code-awareness-delivered.draft.json` ist mit der
Registrierung gelöscht — was von ihm zu entscheiden war, steht dort.

Population = **bastra-recall selbst**. Wahrheit = **Typfehler ODER neu
brechende Tests** (`--truth tsc+tests`). Das ist eine neue Wahrheitsdefinition
und damit eine neue Grundgesamtheit, nicht eine Erweiterung der v3/v4-Menge.

Alle Repos werden ausschließlich gelesen; gearbeitet wird auf
`git archive`-Kopien unter `~/.bastra/eval/code-roi-delivered-recall/`. Kein
zustandsändernder git-Befehl.

## 1. Warum nicht CarNexus (erledigte Vorfrage)

CarNexus hat **0 getrackte Testdateien**; `.gitignore:8` = `tests/`. Probe:
`git archive c4dece9 | tar -x` liefert einen Tree mit 0 Tests. Eine
testbasierte Wahrheit ist dort nicht teuer, sondern nicht definierbar. Das
Repo-Profil steht in Abschnitt 7.

## 2. Die Wahrheitsregel

Zwei Wahrheiten, **vereinigt**. Eine Änderung kann einen Typ brechen, ohne
einen Test zu brechen, und einen Test brechen, ohne einen Typ zu brechen.

### 2a. Typfehler — unverändert wie v3

Eine Datei gilt als betroffen, wenn sie nach Anwenden des Diffs genau einer
Datei einen Typfehler trägt, den sie vorher nicht trug, verglichen als
`(Datei, TS-Code, Meldung)`-Multimengen ohne Positionen. Die geänderte Datei
selbst zählt nie zu ihrer eigenen Wahrheit.

### 2b. Neu brechende Tests — `truth_rule: "tests/v1"`

Wörtlich dokumentiert in `packages/eval/code-roi/v2/test-truth.mjs`:

1. **Baseline.** Parent-Tree extrahieren, die ausgewählten Tests laufen lassen.
   `B` = Menge der Testfälle, die **bestehen**. Abbruch oder Timeout ⇒
   **„nicht bewertbar“**, niemals „bricht nichts“.
2. **Mutation.** Nur den Diff dieser einen Datei anwenden, erneut laufen
   lassen. `F` = Menge der **fehlschlagenden** Fälle.
3. **Bruch.** `broke = F ∩ B`. Was vorher rot war, ist kein Beleg; was es
   vorher nicht gab, auch nicht.
4. **Bestätigung.** Jede Testdatei mit einem gebrochenen Fall läuft **allein
   auf dem sauberen Parent-Tree** erneut. Fälle, die dort ebenfalls rot sind,
   fallen als flaky oder reihenfolgeabhängig raus. Nur deshalb ist
   „bricht nichts“ belastbar.
5. **Zuordnung Test → Quelldatei.** Je überlebender Testdatei greift die
   **erste** passende Regel; welche griff, steht je Testdatei im Datensatz
   (`truthRules`):
   - **R1 `sibling-name`** — eine Datei im Importabschluss des Tests, deren
     Basisname dem des Tests entspricht (`.test`/`.spec` bzw. Präfix
     `test_`/`spec_` entfernt). Der Test benennt sein Subjekt.
   - **R2 `direct-import`** — die repo-internen Quelldateien, die der Test
     **direkt** importiert.
   - **R3 `closure`** — der ganze transitive interne Importabschluss. Nur, wenn
     direkt nichts auflösbar ist (Barrel, CLI).

   Wahrheit = Vereinigung über alle überlebenden Testdateien, **ohne die
   geänderte Datei** und ohne jede Testdatei.
6. **Blindstelle.** Liegt die geänderte Datei **nicht** im statischen
   Importabschluss der Testdatei, ist der Bruch über etwas gelaufen, das ein
   Importgraph nicht sieht — HTTP-Route, Event-Name, Template-String,
   Config-Schlüssel. Solche Brüche sind echt und zählen, werden aber markiert
   (`blindSpots`) und **getrennt von Import-/Aufrufkopplung berichtet**.

Je Szenario wird zusätzlich `truthSource` geführt: `tsc`, `tests`, `both` oder
`none`. Damit lässt sich der vom Auftrag verlangte Anteil nur-tsc / nur-Tests /
beides direkt auszählen.

**Der Codegraph wird bei der Wahrheitsbildung nirgends benutzt.** Der
Importabschluss kommt aus einem eigenen Parser in `test-truth.mjs`, der die
Quelle liest. Die Population ist blind für das Werkzeug, das gemessen wird.

## 3. Welche Tests je Kandidat laufen — und was das kostet

Die volle Suite ist ~4 min; je Kandidat wäre das unbezahlbar. Ein Test wird
ausgewählt, wenn **eines** gilt:

- **Erreichbarkeit** — die geänderte Datei liegt im statischen Importabschluss
  des Tests (aus der Quelle, nicht aus dem Codegraphen).
- **Literal** — der Diff fügt einen String hinzu oder entfernt einen, den die
  Testdatei ebenfalls enthält. Das ist die Sonde für die Blindstellen: Route,
  Event-Name oder Config-Schlüssel koppeln zwei Dateien ohne Import, und
  Erreichbarkeit allein kann so einen Bruch nie finden. Gezählt werden nur
  vertragsförmige Literale (mindestens 4 Zeichen und ein `/`, `.`, `-`, `:`
  oder Leerzeichen), nicht jedes Wort.

Greift keines von beiden, läuft die **ganze Suite** (`mode: "full"`), statt zu
schließen, dass nichts brechen kann. Der Modus steht je Szenario in
`testSelection`.

**Bekannte Grenze, offen benannt:** Ein Bruch über einen String, den der Diff
nicht angefasst hat, oder über einen zur Laufzeit berechneten Wert, wird von
keiner der beiden Klauseln erreicht und geht verloren. Diese Verzerrung läuft
**zugunsten der Importkopplung**, also zugunsten dessen, was ein Graphwerkzeug
findet. Der berichtete Blindstellen-Anteil ist damit eine **Untergrenze**.

**Zeitbudget:** `CODE_ROI_TEST_TIMEOUT_MS`, Vorgabe 600 000 ms je Lauf.
Timeout ⇒ nicht bewertbar. Der Typ-Durchgang läuft **vor** den Tests, weil er
nebenbei die `dist/`-Verzeichnisse erzeugt (`buildFirst`: core, daemon,
statusline) — ohne die schlägt jeder paketübergreifende Test schon in der
Baseline fehl, was kein Bruch wäre, sondern ein nie gebauter Tree.

**Baseline-Cache** je `(Parent-Tree, Testauswahl)`, nicht je Tree allein: bei
gezielten Läufen prüfen zwei Kandidaten desselben Commits verschiedene
Dateien, und eine Baseline über die eine Auswahl sagt nichts über die andere.

## 4. Ausschlussliste (tool-blind)

Gebaut in `packages/eval/code-roi/v2/exclusions.mjs`, zur Laufzeit aus den
Archiven gelesen und in `population.json` gehasht.

| Ausschluss | Umfang | Grund |
| --- | --- | --- |
| v3-Szenariodateien | 45 Szenarien | Wahrheitsmengen wurden von Hand adjudiziert und beim Adoption-Tuning gelesen |
| v4-Szenariodateien | 9 Szenarien | dito |
| zusammen **52 eindeutige Dateien** | Datei-Ebene, nicht Commit-Ebene | eine zweite Änderung an derselben Datei ist immer noch eine Änderung an Code, dessen Auswirkung schon angesehen wurde, und die Schwellen wurden gegen genau diesen Beleg bewegt |
| 2 Pilot-Commits aus Registrierung 3 | `197f9b10…`, `c6cf3e21…` | vom Piloten selbst gelesen; die Registrierung nennt sie |
| `packages/daemon/src/code-graph/` | Präfix | **das gemessene Produkt** — ein Szenario dort fragt das Werkzeug nach seiner eigenen Quelle |
| `packages/eval/` | Präfix | **der Messapparat selbst**, an dem gerade gearbeitet wird; die Wahrheitsmenge hinge vom halbfertigen Stand auf der Platte ab |

Fehlt ein Archiv, **bricht der Schürflauf ab**, statt mit leerer Ausschlussliste
weiterzulaufen: eine Population ohne die verbrannte Liste sähe wie eine gültige
Stichprobe aus und benutzte still Szenarien, auf denen die Schwellen getunt
wurden.

Ausschluss-Hash dieses Laufs: `df87de2c3566…` (voll in `population.json`).

## 5. Verfügbare Grundgesamtheit (unabhängig ausgezählt)

Über die gesamte Historie (887 Commits, `rev-list --no-merges HEAD`), Status
`M`, TS-Quelldateien unter `packages/`, nach allen Ausschlüssen:

- **1000 Kandidatenpaare** `(Commit, Datei)`
- **180 eindeutige Dateien** — und damit bei „ein Szenario pro Datei“ die
  Obergrenze der Stichprobe: `packages/daemon` 149, `packages/core` 22,
  `packages/statusline` 9.

Das Ziel von ≥ 40 Szenarien ist also mit Reserve erreichbar.

## 6. Freeze

`population.json` wird nach **jedem** Durchgang neu geschrieben, damit auch ein
abgebrochener Lauf einen lesbaren Zwischenstand hinterlässt. Inhalt: Repository
und dessen `HEAD`-SHA, `truth`, `truth_rule`, Seed, `stop_at`, `max_truth`,
Pilot-Commits, **Ausschluss-Hash samt Quellarchiven und Präfixgründen**,
`population_sha256` über die akzeptierten `(commit, file)`-Paare in
Annahmereihenfolge, die Verteilung (Paket, Wahrheitsgröße, `truth_source`,
Zuordnungsregel, Auswahlmodus, Blindstellen) und die Ablehnungsgründe.

## 7. CarNexus-Profil (erhoben, dann verworfen)

JavaScript/CommonJS. 1077 getrackte Dateien, davon 774 `.js` (619 `frontend/`
Create-React-App, 235 `backend/` Express + Mongoose). 372 Commits, 21.11.2024
bis 01.09.2026; 190 der letzten 200 Commits ändern mindestens eine `.js`-Datei
mit Status `M`. Jest 29 nur im Root (`testMatch: **/tests/**/*.test.js`,
Timeout 15 s); `backend/package.json` hat gar kein Testskript. Backend-Tests
bräuchten MongoDB, Clerk und Supabase, stubbar nur durch Änderungen am
Original.

## 8. Stand und offene Punkte

Stand der Schürfung: siehe Abschnitt 9 (wird je 50 Kandidaten fortgeschrieben).

Offen:

1. **grep-Headroom** wurde auftragsgemäß **nicht** geprüft. Der Hinweis bleibt:
   Blindstellen-Brüche laufen über Literale, die grep gut findet.
2. **Ausbeute.** Unter der reinen Typwahrheit lieferte bastra-recalls Historie
   laut Übergabe 11 qualifizierende Änderungen aus 694 Kandidaten. Die
   Testwahrheit hebt die Quote; um wie viel, entscheidet erst der Lauf. Die
   Obergrenze bei einem Szenario pro Datei ist 180.

## 8a. Entschiedene Punkte

- **Flakiness:** Der Bestätigungslauf je betroffener Testdatei auf dem sauberen
  Parent-Tree ist der Filter. Ein **zweiter Baseline-Lauf wird bewusst nicht
  gefahren** — er würde die teuerste Stufe verdoppeln und fängt nur, was sich
  ohnehin beim Wiederholen zeigt, also genau das, was der Bestätigungslauf
  bereits prüft. Entschieden am 19.09.2026.
- **Zeitbudget:** 600 s je Suite-Lauf, unverändert. Bei gezielter Auswahl
  großzügig, bei `mode: "full"` knapp bemessen; bewusst hoch, weil ein Timeout
  einen ganzen Kandidaten kostet.
- **Repo:** bastra-recall selbst. Der bastra-yard-Pilot bleibt als Nebenbefund
  stehen (Abschnitt 10) und wird nicht weiterverfolgt.

## 9. Schürfergebnis

Lauf: `CODE_ROI_REPO=… CODE_ROI_OUT=~/.bastra/eval/code-roi-delivered-recall
CODE_ROI_WORKERS=4 node packages/eval/code-roi/v2/mine-repo.mjs
--truth tsc+tests --stop-at 45`, 18:18–20:30 am 19.09.2026, **2 h 12 min**,
regulär beendet (`stop_at` erreicht). 422 Baseline-Läufe.

**45 angenommen aus 432 entschiedenen Kandidaten.**

| | |
| --- | --- |
| Pakete | `packages/daemon` 42, `packages/core` 3 |
| Wahrheitsgröße | 1 → 21×, 2 → 9×, 3 → 9×, 5 → 2×, 8 → 4× (Median 2, Summe 108) |
| `truthSource` | **tests 45, tsc 0, both 0** (siehe unten) |
| Zuordnungsregel | `direct-import` 44, `sibling-name` 18, `closure` 1 |
| Testauswahl | `targeted` 24, `targeted+literals` 13, `full` 8 (Median 62 Testdateien) |
| **Blindstellen** | **13 von 45 Szenarien = 29 %**, 19 betroffene Testdateien |

Ablehnungen: `breaks nothing` 199, `file already used` 182 (ein Szenario pro
Datei), `too many truth files` 3, `diff does not apply alone` 3. Nicht
bewertbar: 3.

**Freeze**
`population_sha256` = `53c4f6bc6262bca8cff1fe9b8e11b679f834ea48a098ee6d2023f391ee6965e9`
`exclusions.sha256` = `df87de2c3566d64b890620a4c4f8eb52fdc2bf1f15077b998b38c1b0d3ad8318`
`repository_head` = `0842d2760a33f6fbd59a8855ac1a328b3149717f`, Seed 20260918,
Regel `tests/v1`, Modus `tsc+tests`.

### Warum `truthSource` nie `tsc` oder `both` ist

Die Typprüfung **läuft** — sie ist gegen ein Szenario mit bekannter Typwahrheit
gegengeprüft: v3-Szenario S01 (`8bb72525`,
`packages/daemon/src/patch-registry.ts`) liefert auf dem extrahierten Tree
0 Baseline-Signaturen, nach der Mutation 5, und als neue Fehlerdateien exakt
`cli/patches-cmd.ts`, `cli/update.ts`, `session-lane.ts` — die adjudizierte
v3-Wahrheit. Auch auf drei angenommenen Szenarien dieser Population wurde
nachgemessen: dort entstehen **keine** neuen Typfehler außerhalb der geänderten
Datei (bei `cli/log-stats-code.ts` entsteht genau einer, und der liegt **in**
der geänderten Datei, die per Regel nie zu ihrer eigenen Wahrheit zählt).

Über alle 441 bewertbaren Kandidaten des Laufs ist `truthFromTypes` leer. Das
ist kein Ausfall, sondern eine Folge der Ausschlussregel: die Änderungen, die
in dieser Historie überhaupt paketübergreifende Typfehler erzeugen, sind genau
die, die v3 und v4 bereits als Szenarien verbraucht haben — und deren 52
Dateien sind hier auf Datei-Ebene ausgeschlossen. Die Übergabe beziffert die
Quote unter reiner Typwahrheit ohnehin mit 11 qualifizierenden Änderungen aus
694 Kandidaten (1,6 %); nach Abzug genau dieser Dateien ist 0 aus 441 das
erwartete Ergebnis.

**Konsequenz für die Messung:** Diese Population ist faktisch eine reine
Test-Wahrheits-Population. Der `tsc`-Zweig bleibt im Code, ändert an ihr aber
nichts. Wer eine Mischung aus Typ- und Testbrüchen braucht, bekommt sie aus
bastra-recall nur, wenn der Datei-Ausschluss gelockert wird — und das wäre
nicht mehr tool-blind.

## 10. Nebenbefund bastra-yard (nicht weiterverfolgt)

Vor der Repo-Entscheidung als Alternative geprüft und mit einem Piloten
angefahren (`~/.bastra/eval/code-roi-delivered-yard-pilot`). 124 Testdateien,
521 Kandidatenpaare, `node --test --experimental-strip-types`. Die volle Suite
läuft auf einer Archivkopie grün — 2456 Tests, 588 Suites, 199 s, ohne Netz
oder Datenbank; nötig ist nur ein Symlink auf `node_modules` (`typescript`,
`@types/node`). Baselines wurden korrekt je Parent-Tree geschrieben (2446 bzw.
2452 grüne Fälle). Nachteil gegenüber bastra-recall: nur zwei Wochen Historie
(04.–17.08.2026). Der Pilot ist gestoppt; die Strecke funktioniert dort
nachweislich, falls je ein zweites Repo gebraucht wird.

## 10a. Im Lauf gefundener Fehler an der gepoolten Kandidatendatei

`mergeCandidates()` sammelte alle Dateien mit Präfix `candidates.` und Endung
`.jsonl` — **einschließlich der Ausgabedatei `candidates.jsonl` selbst**. Bei
jedem Durchgang wurde sie damit in sich selbst hineinkopiert: aus 432 echten
Entscheidungen wurden 5094 Zeilen, und die 45 angenommenen Szenarien tauchten
682-mal auf. Genau diese Datei liest `select.mjs`, um die Stichprobe zu ziehen.

Behoben (die Ausgabedatei ist keine ihrer eigenen Eingaben), und die abgeleitete
Datei wurde aus der maßgeblichen `candidates.bastra-recall-hook.jsonl` neu
erzeugt: jetzt 432 Zeilen, 45 angenommen, 432 eindeutige `(commit, file)`.
**Nicht neu geschürft.** Der Freeze war nie betroffen: `populationFreeze()`
rechnet auf den Entscheidungen des Durchgangs, nicht auf der gepoolten Datei —
`population_sha256` ist unverändert.

## 11. Verworfener Lauf (nicht Teil der Population)

`~/.bastra/eval/code-roi-delivered-recall-stale-resolver-1818` stammt aus dem
ersten Anlauf, bevor der Importresolver TypeScript-ESM-Spezifizierern folgte
(`./x.js` liegt als `./x.ts` auf der Platte; bastra-recall schreibt 524 von 530
relativen Importen so). Dort fand die Auswahl für `code-awareness-stats.ts`
**null** erreichende Tests, obwohl es eine passende Testdatei gibt — die
Wahrheitsmengen wären systematisch zu klein geworden, und zwar zugunsten der
Importkopplung. Der Lauf liegt nur als Beleg herum und geht in keine Auswertung
ein.

## 12. Adjudikation der 45 Wahrheitsmengen (vor dem ersten Arm)

Stand 19.09.2026, vor dem ersten Arm, gegen die geschriebene
`scenarios.json` (45 Szenarien, Registrierung `code-awareness-delivered`).

**Regel wie v3, unverändert:** Ein Wahrheitseintrag fällt nur mit
schriftlichem Grund im Feld `adjudication` des Szenarios, ein ganzes Szenario
nur mit `excluded: "<Grund>"`. Beides bleibt im Archiv sichtbar.

**Streichungen: keine.** Kein Eintrag entfernt, kein Szenario ausgeschlossen.
`adjudication` ist in allen 45 Szenarien leer.

### 12a. Stichprobe Test → Datei (10 von 45)

Zusätzlich zur v3-Regel, weil die Wahrheit hier aus gebrochenen **Tests**
abgeleitet ist statt vom Compiler gelesen. Geprüft wurde, ob die Zuordnung
reproduzierbar ist und ob die benannte Quelldatei plausibel diejenige ist, die
mit angepasst werden müsste. Vorgehen: Parent-Tree je Szenario mit
`git archive` auspacken, `attribute()` aus `test-truth.mjs` mit dem
Repo-Profil erneut laufen lassen, Ergebnis gegen die gespeicherte
Wahrheitsmenge halten.

**Ergebnis: 10 von 10 reproduzieren die gespeicherte Menge exakt.**

| # | Szenario | geänderte Datei | gebrochener Test | Regel | zugeordnet | Urteil |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S01 | `cli/log-stats-code.ts` | `code-awareness-stats.test.ts` | R1 | `code-awareness-stats.ts` | plausibel — der Test trägt den Namen seines Subjekts, die geänderte CLI rendert genau dessen Zahlen |
| 2 | S05 | `telemetry-report.ts` | `code-graph-find.test.ts` (R2), `session-assembler.test.ts` (R1) | R2+R1 | 7 + 1 Dateien | reproduzierbar, aber **weit** — siehe 12b |
| 3 | S09 | `session-lane.ts` | `session-assembler.test.ts` | R1 | `session-assembler.ts` | plausibel, mit Vorbehalt 12c |
| 4 | S13 | `stub/bastra-hook.ts` | 3 Hook-Client-Tests | R2 | `cli/log-stats.ts`, `hook-client-telemetry.ts` | **Blindstelle**, korrekt markiert: geänderte Datei liegt in keinem der drei Importabschlüsse (Größe 10) — die Kopplung läuft über das gebaute Stub-Binary, nicht über einen Import |
| 5 | S17 | `cli/update-hint.ts` | `cli-flag-validation.test.ts`, `cli-help.test.ts` | R2 | `cli/flag-spec.ts`, `cli/help-text.ts` | **Blindstelle**, korrekt markiert (Abschlüsse 1 bzw. 58, geänderte Datei nicht darin); die benannten Dateien sind die Flag- und Hilfetext-Register, also genau das, was mit angepasst werden müsste |
| 6 | S21 | `bash-pre-lane.ts` | `session-assembler.test.ts` | R1 | `session-assembler.ts` | plausibel, mit Vorbehalt 12c |
| 7 | S26 | `cli/config-cmd.ts` | `dense-arm-wait-telemetry.test.ts` | R2 | `core/src/index.ts`, `http.ts`, `telemetry.ts` | **Blindstelle**, korrekt markiert; reproduzierbar, aber weit — siehe 12b |
| 8 | S31 | `stop-lane.ts` | `session-assembler.test.ts` | R1 | `session-assembler.ts` | plausibel, mit Vorbehalt 12c |
| 9 | S37 | `http-ui-routes.ts` | `session-assembler.test.ts` | R1 | `session-assembler.ts` | plausibel, mit Vorbehalt 12c |
| 10 | S43 | `core/src/cue-sidecar.ts` | `core/__tests__/cue-sidecar.test.ts` | R2 | `core/src/schema.ts` | plausibel — der Test importiert genau zwei interne Dateien, das Schema ist die Gegenseite der geänderten Serialisierung |

### 12b. Befund: R2 ist eine Obergrenze, keine Ursachenzuweisung

`direct-import` benennt **alle** repo-internen Dateien, die der gebrochene Test
direkt importiert — bei einem Integrationstest sind das 6 bis 7 Dateien
(S05), von denen nur eine oder zwei wirklich angepasst werden müssten. Die
Wahrheitsmenge ist dort also eine **Obergrenze** dessen, was Aufmerksamkeit
braucht.

Das senkt die erreichbare **Präzision beider Arme** gleichermaßen und ist
werkzeugblind: R2 läuft in die Richtung Test → Importe, während ein
Graphwerkzeug in die Richtung geänderte Datei → Abhängige antwortet. Es
begünstigt also weder grep noch den Block. Nicht korrigiert, weil jede
Korrektur eine Ursachenzuweisung von Hand wäre — und damit eine Wahrheit, die
davon abhinge, wer sie trifft.

### 12c. Vorbehalt: R1 schlägt R2, auch bei Integrationstests

`session-assembler.test.ts` ist in 4 der 10 Stichproben der gebrochene Test
(S09, S21, S31, S37) und greift jedes Mal über R1: die Wahrheit ist
`session-assembler.ts`, nicht die geänderte Lane-Datei und nicht deren
direkte Importe. Das ist die registrierte Regel — R1 benennt das **Subjekt**
des Tests — und es ist bei einem Zusammenbau-Test auch die Datei, an der sich
ein geänderter Lane-Vertrag niederschlägt.

Es bedeutet aber: auf diesen Szenarien ist die Wahrheit **eine einzige Datei**,
und beide Arme gewinnen oder verlieren den ganzen Recall an ihr. Das ist der
Grund, warum die Wahrheitsgrößen-Verteilung (Median 2, 21 Szenarien mit genau
einer Datei) im Bericht mitläuft: ein Recall-Unterschied auf dieser Population
ist grobkörniger als die 53 Wahrheitsdateien von v6.

### 12d. Blindstellen

13 von 45 Szenarien tragen mindestens einen Blindstellen-Test. Nachgeprüft:
in **allen 13** sind **sämtliche** gebrochenen Tests Blindstellen, d. h. die
ganze Wahrheitsmenge des Szenarios ist Blindstellen-Wahrheit. Der Bericht
teilt deshalb **je Szenario** und nicht je Wahrheitsdatei; der Fall „teils,
teils" wird als `partialBlindSpotScenarios` ausgewiesen und ist hier leer.

Betroffen: S07, S08, S10, S13, S15, S17, S23, S26, S28, S29, S33, S38, S40.
