# Grundgesamtheit „delivered“ — Befund zur testbasierten Wahrheit

Stand: 19.09.2026. Gehört zu `code-awareness-delivered.draft.json` (Option 2:
Zustellungsnutzen + Kontextkosten). Diese Datei beschreibt, **woher die
Szenarien kommen sollen** und **wie „betroffen“ definiert ist** — nicht das
Messergebnis.

Alle Repos wurden ausschließlich gelesen. Gearbeitet wird auf
`git archive`-Kopien; kein zustandsändernder git-Befehl in irgendeinem Repo.

## 1. CarNexus scheidet aus — mit Beleg

Daniels Entscheidung war, die Grundgesamtheit aus CarNexus zu ziehen.
**Das geht nicht:** CarNexus hat keine Tests, die in einer Archivkopie
existieren.

| Prüfung | Ergebnis |
| --- | --- |
| `git ls-files \| grep -E '\.(test\|spec)\.[jt]sx?$'` | **0** Dateien |
| je in der Historie angelegt | genau **1** (`frontend/src/App.test.js`, längst entfernt) |
| `.gitignore:8` | `tests/` — das gesamte Testverzeichnis ist ungetrackt |
| real vorhanden | 1 Datei, `tests/unit/insights/KfzSteuerCalculator.test.js` (92 Zeilen, eine reine Rechenfunktion) |
| `git archive c4dece9 \| tar -x` → Testdateien im Tree | **0** |

Die Pipeline arbeitet konventionsgemäß auf Archivkopien
(`mine-repo.mjs` benutzt `git archive`, nie `git worktree`, damit das fremde
Repo unberührt bleibt). In so einer Kopie gibt es in CarNexus nichts
auszuführen. Eine testbasierte Wahrheit ist dort also nicht „teuer“, sondern
**nicht definierbar**.

### CarNexus-Profil (trotzdem erhoben)

- JavaScript, CommonJS. 1077 getrackte Dateien, davon 774 `.js`
  (619 `frontend/` — Create-React-App; 235 `backend/` — Express + Mongoose).
- 372 Commits, 21.11.2024 bis 01.09.2026. 190 der letzten 200 Commits ändern
  mindestens eine `.js`-Datei mit Status `M` — Kandidaten gäbe es reichlich.
- Jest 29, nur im Root konfiguriert (`testMatch: **/tests/**/*.test.js`,
  `setupFilesAfterEach: tests/setup.js`, Timeout 15 s).
- `backend/package.json` hat gar kein Testskript
  (`"test": "echo \"Error: no test specified\" && exit 1"`).
- Backend-Tests bräuchten ohnehin MongoDB, Clerk und Supabase; stubbar wäre das
  nur durch Änderungen am Original, was ausgeschlossen ist.

**Offene Entscheidung für Daniel:** welches Repo stattdessen. Kandidaten aus dem
Scan über `/Users/n0mad/Projekte` (getrackte Testdateien):

| Repo | Tests | Dateien | Commits | Zeitraum | Bemerkung |
| --- | --- | --- | --- | --- | --- |
| **bastra-yard** | 124 | 533 (478 `.ts`) | 156 | 04.–17.08.2026 | bestes Profil, aber TypeScript und sehr kurze Historie |
| companion-house | 12 | 316 (127 `.py`) | 38 | — | überwiegend Python |
| bastra-io | 13 | 555 (241 `.ts`) | 196 | — | **verbrannt** (v4-Hauptlauf) |
| quoro, sparfux, bastra-pro, bastra-keys, afd-digital, … | 0 | — | — | — | keine Tests |

## 2. Die Wahrheitsregel — `truth_rule: "tests/v1"`

Vorab festgelegt, im Code als einzige Quelle in
`packages/eval/code-roi/v2/test-truth.mjs` dokumentiert und dort wörtlich
identisch. Der Graph wird bei der Wahrheitsbildung **nirgends** benutzt; die
Population ist tool-blind.

Gegeben ein Commit `C`, sein Parent `P`, und genau eine in `C` geänderte Datei `d`:

1. **Baseline.** `P` extrahieren, die ganze Suite laufen lassen. `B` = Menge der
   Testfälle, die **bestehen**. Ein Lauf, der abbricht oder das Zeitbudget
   reißt, macht den Kandidaten **„nicht bewertbar“** — niemals „bricht nichts“.
2. **Mutation.** Nur `d`s Diff von `P` nach `C` anwenden, Suite erneut laufen
   lassen. `F` = Menge der **fehlschlagenden** Testfälle.
3. **Bruch.** `broke = F ∩ B`. Ein Fall, der schon auf `P` rot war, ist kein
   Beleg; ein Fall, den es auf `P` noch nicht gab, auch nicht.
4. **Bestätigung.** Jede Testdatei mit einem gebrochenen Fall wird **allein auf
   dem sauberen `P`-Tree** erneut gefahren. Fälle, die dort ebenfalls rot sind,
   fallen als flaky oder reihenfolgeabhängig raus. Nur deshalb ist
   „bricht nichts“ überhaupt belastbar.
5. **Zuordnung.** Jede überlebende Testdatei `T` wird nach der **ersten
   greifenden** Regel auf Quelldateien abgebildet; welche griff, wird je
   Testdatei protokolliert (`truthRules`):
   - **R1 `sibling-name`** — eine Datei in `T`s Importabschluss, deren
     Basisname `T`s Basisnamen entspricht, nachdem `.test`/`.spec` bzw. das
     Präfix `test_`/`spec_` entfernt wurde. Der Test benennt sein Subjekt.
   - **R2 `direct-import`** — die repo-internen Quelldateien, die `T`
     **direkt** importiert.
   - **R3 `closure`** — `T`s ganzer transitiver interner Importabschluss. Nur,
     wenn direkt nichts auflösbar ist (Barrel, CLI).

   Die Wahrheitsmenge ist die Vereinigung über alle überlebenden `T`, **ohne
   `d` selbst** und ohne jede Testdatei.
6. **Blindstelle.** Liegt `d` **nicht** im statischen Importabschluss von `T`,
   ist der Bruch über etwas gelaufen, das ein Importgraph nicht sehen kann —
   HTTP-Route, Event-Name, Template-String, Config-Schlüssel. Solche Brüche
   sind **echt** und zählen, werden aber markiert (`blindSpots`) und **getrennt
   von Import-/Aufrufkopplung berichtet**. Ein Graph-Werkzeug kann sie nicht
   finden; ein grep über das Literal womöglich schon.

### Bewusste Randentscheidungen

- **Mutierter Tree für die Zuordnung, sauberer Tree für die Bestätigung.** Die
  Änderung kann selbst einen Import hinzufügen oder entfernen; der Abschluss,
  der zählt, ist der am Ort des Bruchs. Die Reihenfolge im Code ist deshalb
  bindend: anwenden → laufen → zuordnen → zurücknehmen → bestätigen.
- **Mehrdeutige Testnamen fallen raus.** Node schreibt im TAP-Report keine
  Datei-Ebene: die Fälle mehrerer Dateien stehen flach nebeneinander, und die
  Datei steht nur bei **Fehlschlägen** in `location:`. Tragen zwei Dateien
  denselben Testnamen, ist „bestand und ist jetzt rot“ womöglich eine Aussage
  über zwei verschiedene Tests — solche Fälle werden als `ambiguous`
  ausgeschlossen statt geraten. (Bei jest/vitest/mocha steht die Datei im
  Report, dort gibt es das Problem nicht.)
- **Zeitbudget** je Suite-Lauf: `CODE_ROI_TEST_TIMEOUT_MS`, Vorgabe 600 000 ms.
  Timeout ⇒ „nicht bewertbar“.
- **Baseline-Cache je Parent-Tree-Hash** (`test-baseline-cache.jsonl`), nicht je
  Commit: zwei Commits mit gleichem Parent-Tree haben per Definition dieselbe
  Baseline, und ein Suite-Lauf ist hier der teure Schritt.

## 3. Freeze der Population

`population.json` wird nach **jedem** Durchgang neu geschrieben, damit auch ein
abgebrochener Schürflauf einen lesbaren Zwischenstand hinterlässt. Inhalt:
Repository und dessen `HEAD`-SHA, `truth`, `truth_rule`, Seed, `stop_at`,
`max_truth`, Pilot-Ausschluss, `population_sha256` über die akzeptierten
`(commit, file)`-Paare in Annahmereihenfolge, sowie die Verteilung
(nach Top-Verzeichnis, Wahrheitsgröße, Zuordnungsregel, Blindstellen-Anteil)
und die Ablehnungsgründe.

Der Pilot-Ausschluss kommt aus `CODE_ROI_PILOT_COMMITS` (kommasepariert) und
**nicht** aus einer Registrierung: die Registrierung dieser Messung ist nicht
die, die `select.mjs` liest, und ein Ausschluss, der auf das falsche Dokument
zeigt, schließt die falschen Commits aus.

## 4. Kostenbild (gemessen, nicht geschätzt)

Auf bastra-yard, der einzigen realistischen Alternative:

- Die volle Suite läuft auf einer Archivkopie **grün und ohne Netz oder DB**:
  2456 Tests, 588 Suites, 1 übersprungen, 0 rot. Nötig ist nur ein Symlink auf
  `node_modules` (nur `typescript` und `@types/node`).
- **Laufzeit einer Suite: 199 s allein.** Node fährt die Suite mit
  `--test-isolation=process`, also ein Kindprozess je Testdatei; zwei parallele
  Worker teilen sich die Kerne und brauchen entsprechend länger. Parallelität
  kauft hier also weniger, als die Workerzahl verspricht.
- Je Kandidat fallen Baseline (einmal je Parent-Tree, gecacht) + Mutationslauf
  + Bestätigungslauf an. Der Bestätigungslauf ist billig (nur die gebrochenen
  Dateien); der Mutationslauf ist der volle Preis.
- 521 Kandidatenpaare `(Commit, Datei)` stehen in bastra-yard zur Verfügung
  (521 `M`-Änderungen an Nicht-Test-Quelldateien über 156 Commits). Für ≥ 40
  qualifizierte Szenarien ist mit einer **Schürfzeit in der Größenordnung von
  Stunden** zu rechnen, nicht Minuten.

Das ist kostenlos, aber es ist Rechenzeit, die auf ein Repo gehen würde, das
Daniel noch nicht gewählt hat. Deshalb läuft bislang nur ein Pilot
(`~/.bastra/eval/code-roi-delivered-yard-pilot`, `--stop-at 2`), der die
`--truth tests`-Strecke an einem echten Repo nachweist.

## 5. Stand der Schürfung

**Noch keine Grundgesamtheit gezogen.** Blockiert an der Repo-Entscheidung
(Abschnitt 1).

Was der Pilot in `~/.bastra/eval/code-roi-delivered-yard-pilot` bereits zeigt:
die `--truth tests`-Strecke läuft an einem echten Repo durch. Das Profil wird
korrekt abgeleitet (Runner `node-test`, 124 Testdateien explizit übergeben),
die Archivkopie wird extrahiert, `node_modules` verlinkt, und die Baselines
werden je Parent-Tree geschrieben und gecacht — **2446 bzw. 2452 grüne
Testfälle**, Status `ok`. Der Freeze (`population.json`) wird nach jedem
Durchgang neu geschrieben.

Sobald ein Repo feststeht:

```
CODE_ROI_REPO=<repo> CODE_ROI_OUT=~/.bastra/eval/code-roi-delivered-<repo> \
CODE_ROI_WORKERS=4 \
node packages/eval/code-roi/v2/mine-repo.mjs --truth tests --stop-at 45
```

## 6. Offene Entscheidungen

1. **Welches Repo stellt die Grundgesamtheit?** CarNexus ist raus. bastra-yard
   ist das einzige mit tragfähiger Suite — dann ist die Messung aber auf
   TypeScript und auf zwei Wochen Historie gestellt.
2. **Zeitbudget je Testlauf** — Vorgabe 600 s. Bei bastra-yard (199 s pro Lauf)
   reicht das; ein langsameres Repo braucht mehr, und je höher das Budget,
   desto teurer wird jeder nicht bewertbare Kandidat.
3. **Flakiness.** Der Bestätigungslauf fängt nur, was sich beim Wiederholen
   zeigt. Ob zusätzlich ein zweiter Baseline-Lauf gefahren wird (verdoppelt die
   teuerste Stufe), ist offen.
4. **grep-Headroom.** Nicht geprüft, wie vom Auftrag verlangt. Der Hinweis
   bleibt: Blindstellen-Brüche laufen über Literale, die grep gerade gut
   findet — Option 2 braucht keinen Headroom, aber der Blindstellen-Anteil
   gehört in den Bericht, sonst sieht grep besser aus, als die Frage hergibt.
