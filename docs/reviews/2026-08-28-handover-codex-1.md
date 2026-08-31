# Codex-Übergabe Nr. 1: Gegenreview ad86155..HEAD

**Stand:** 28. August 2026
**Prüfumfang:** `ad86155..HEAD` (Stand beim Übergeben: ______, zuletzt gesehen `9f4f328`)
**Letzter Codex-Stand:** `ad86155`
**Prüfregel:** P0 wird sofort gefixt, alles andere wird Issue

> Zweck dieses Dokuments: Codex hat den Code bis `ad86155` gesehen, die zwei
> Wochen danach nicht. Statt 13+ Commits am Stück zu prüfen, sortiert diese
> Übergabe sie in drei Stränge und benennt pro Strang, welche Invarianten
> tragen sollen und wie sie bisher verifiziert wurden. Alles, was hier unter
> „offene Punkte" steht, ist bereits bekannt und muss nicht neu gefunden werden.

## 1. Prüfumfang

`git log --oneline ad86155..HEAD`, in Reihenfolge alt → neu:

| Commit | Strang | Betreff |
|---|---|---|
| `ec6a9bc` | — | `bastra autostart` — der LaunchAgent bekommt einen Besitzer im Code |
| `068a0fc` | — | Befund 4 prüft jetzt das Dateisystem, statt eines anzunehmen |
| `61d9e5a` | — | ci(publish): ungepinnter npm-Global-Install fällt weg |
| `14a1db2` | — | release: v0.9.2 |
| `afa972c` | — | docs(changelog): Perf-Gewinn von 0.9.2 nachgetragen |
| `5cb4200` | **a** | Mutations-Incident-Telemetrie (#377) |
| `6d4a50b` | **a** | floor-acts: Tiebreak bei gleicher Millisekunde |
| `15c8c99` | **a** | Recovery-Journal (#378) |
| `d3dd732` | **b** | cli-rules kapselt stdout (#383) |
| `7584139` | **b** | Test-Shim in `scripts/test-env.mjs` (#414) |
| `84adf3e` | **b** | boot-observers aus dem Bootpfad gezogen |
| `53b42a3` | **c** | `probe_group` im Goldset |
| `4fab43f` | **c** | `goldset-run.ts` — Runner, der das Goldset liest |
| `1d04171` | **b** | #414-Test prüft den Report, nicht das Layout eines Reporters |
| `9f4f328` | **c** | M2-Cue-Zahlen und M1-Toleranzen aus der M0-Baseline registriert |

Die ersten fünf sind Release- und Infrastrukturarbeit ohne neue Invarianten und
brauchen keinen eigenen Abschnitt; sie sind der Vollständigkeit halber gelistet.
Die drei Stränge unten sind der eigentliche Prüfauftrag.

---

## 2. Strang a — Write-Path-Incidents

### 2.1 Was gebaut wurde

`packages/core/src/mutation-incident.ts` ist ein Meldekanal für besitzverändernde
Operationen, die teilweise scheitern: unvollständiger Rollback, Audit-Append
*nach* dem Commit, Area-Claim-Konflikt, Übernahme eines verwaisten Locks. Core
kennt den Daemon nicht, also meldet core ins Leere, wenn niemand zuhört — dieselbe
Bauform wie `onIdScan`. Der Daemon hört zu und schreibt `mutation_incident` ins
Telemetrie-Log. Fünf Status statt „ok/nicht ok", weil sie verschiedene Reaktionen
verlangen: `conflict` ist wiederholbar, `committed` und `audit_failed` heißen
„steht schon, NICHT wiederholen", `partial` braucht einen Menschen. Eine
`operation_id` hält die Phasen einer Operation zusammen.

`packages/daemon/src/recovery-journal.ts` (#378) schließt die Lücke, die der
Rollback prinzipiell nicht schließen kann: Ein Dokument sind zwei Dateien, und
ein Prozessabsturz mitten in einer zweiteiligen Operation hinterlässt einen
Halbzustand, an den kein Rollback mehr herankommt. Das Journal schreibt vor dem
ersten Move nach `<vault>/.bastra/recovery/`, was gleich passiert, und quittiert
nach dem letzten Schritt. Beim Daemon-Start werden offene Einträge gelesen und
**gemeldet, nicht repariert**.

`6d4a50b` ist ein echter Korrektheitsfix daneben: Der Tiebreak in `liveIntent()`
hing an `recorded` mit Millisekunden-Auflösung (`a.recorded > best.recorded`).
Zwei dicht aufeinander geschriebene Acts tragen denselben Wert, der Vergleich ist
false, die *frühere* Fassung gewinnt.

### 2.2 Invarianten, die ein Reviewer angreifen sollte

- **Quittung nur bei ganzem Zustand.** Quittiert wird nach dem letzten Schritt —
  und auch nach einem *vollständigen* Rollback, weil der Zustand dann wieder ganz
  ist. Blieb der Rollback stecken, muss der Eintrag offen bleiben. Prüfen: Gibt
  es einen Pfad, auf dem quittiert wird, obwohl nur ein Teil zurückgerollt wurde?
- **Keine Pfade, keine Inhalte im Telemetrie-Event.** Das Event verlässt
  potenziell den Rechner, die Journaldatei liegt im Vault. Ins Event gehen id und
  ein kurzer kontrollierter `detail` — ausdrücklich **keine** durchgereichte
  Fehlermeldung, die trägt regelmäßig Pfade. Prüfen: Kommt an irgendeiner
  Meldestelle ein `err.message` in `detail` an?
- **Kein Auto-Repair beim Start.** Ein Repair auf einen Ordner, den jemand
  inzwischen von Hand aufgeräumt hat, wäre die schlimmere Fehlerklasse. Prüfen:
  Schreibt der Start-Pfad irgendwo?
- **Status-Semantik.** `committed`/`audit_failed` dürfen keinen Retry auslösen.
  Prüfen: Behandelt ein Aufrufer die fünf Status als Boolean?
- **Tiebreak-Richtung.** `readActs` liest den append-only-Log in Zeilenreihenfolge,
  `reduce` läuft in Array-Reihenfolge, `>=` wählt die spätere Zeile. Prüfen: Gilt
  die Zeilenreihenfolge-Annahme auch, wenn der Log rotiert oder aus mehreren
  Quellen zusammengesetzt wird?
- **Journal-Abdeckung.** Abgedeckt sind `move_document`, `recategorize_document`
  mit Ordnerwechsel und der Overwrite-Pfad von `save_document`. Bewusst nicht
  journaliert: Pfade, auf denen nur das Sidecar geschrieben wird (tmp+rename ist
  atomar). Prüfen: Gibt es eine vierte zweiteilige Operation, die durchgerutscht ist?

### 2.3 Wie verifiziert wurde

#377: 163 Zeilen neue Tests in `packages/core/__tests__/mutation-incident.test.ts`,
darunter einer, der explizit prüft, dass keine Pfade und keine Frontmatter-Werte
ins Event gelangen. #378: 6 neue Tests in
`packages/daemon/__tests__/documents-recovery-journal.test.ts` — schreiben/
quittieren, Start-Detection (offen → gemeldet, quittiert → still, gemeldet ≠
repariert), keine Pfade im Event, geglückte Operationen hinterlassen nichts, und
ein echt nachgestellter Halbzustand, bei dem der Rollback verweigert und der
Eintrag stehen bleibt. Volle Suite 1842 Tests / 0 fail, Typecheck grün. Details im
Abschlusskommentar von
[#378](https://github.com/n0mad-ai/bastra-recall/issues/378).

`6d4a50b`: Der neue Test erzwingt den Gleichstand, statt ihn zu erhoffen — zwei
Zeilen mit identischem `recorded` direkt in den Log geschrieben. Der alte Test
war grün aus Glück: Unter Node 24 lief der Testlauf langsam genug, dass die
Millisekunde zwischen den beiden Appends wechselte.

---

## 3. Strang b — Test-Runner-Härtung

### 3.1 Was gebaut wurde

Root Cause hinter dem intermittierenden Node-22-Crash (#383): Unter `node --test`
ist das stdout eines Kindes keine Konsole, sondern die Pipe, die die
v8-serialisierten Result-Frames des Runners trägt; stderr läuft über ein eigenes
`readline.Interface` und war nie beteiligt. Node ≤ 22.23.2 / 24.19.0 liest die
Frame-Länge **signed** ([nodejs/node#64061](https://github.com/nodejs/node/issues/64061)),
ein Byte ≥ 0x80 an der Längenposition macht sie negativ, der Warte-auf-mehr-Daten-
Guard greift nicht, v8 deserialisiert Müll. Der Upstream-Fix
([#64706](https://github.com/nodejs/node/pull/64706), `>>> 0`) ist in 24.20.0 und
wird nach 22.x nicht backportet.

`d3dd732` kapselt stdout in `cli-rules.test.ts` — der einzigen der sechs
CLI-Testdateien ohne Kapselung. `7584139` (#414) schließt die Klasse: 26
Daemon-Testdateien importieren aus `src/cli/`, 15 CLI-Module drucken `✓ …`. Der
Deckel sitzt in `scripts/test-env.mjs`, das ohnehin per `--import` in jedem
Test-Child läuft. `84adf3e` ist reine Modularisierung: `index.ts` stand bei 810
Zeilen, die Boot-Observer (onIdScan, onMutationIncident, Recovery-Start-Detection)
ziehen nach `boot-observers.ts`, `index.ts` steht bei 759.

### 3.2 Invarianten, die ein Reviewer angreifen sollte

- **v8-Frames sind nie Strings.** Der Shim kappt ausschließlich String-Writes und
  reicht Buffer durch. Die Begründung: `v8.serialize()` kann keinen String
  zurückgeben. Prüfen: Trägt diese Annahme über alle Node-Versionen der Matrix
  (22, 24)? Gibt es einen Pfad, auf dem der Runner Text auf dieselbe Pipe legt,
  der ankommen muss?
- **Callback-Verhalten.** Ein weggeworfener Write muss aussehen wie ein
  abgeschlossener. Der Callback ist das *zweite* Argument, wenn das Encoding
  weggelassen wird; ein Stream, dessen Callback nie feuert, kann einen Aufrufer
  hängen lassen, der auf drain wartet. Prüfen: Ist die Argument-Erkennung
  vollständig, und stimmt der Rückgabewert (`true`) mit der Backpressure-Semantik
  überein?
- **`NODE_TEST_CONTEXT`-Guard.** Gekappt wird nur im Kind. Im Parent schreibt der
  lesbare Reporter ebenfalls Strings — kappte man dort, wäre die Testausgabe leer.
  Prüfen: Kann `NODE_TEST_CONTEXT` in einem Kontext gesetzt sein, in dem der Shim
  echte Ausgabe frisst (verschachtelte Läufe, Subprozesse aus Tests heraus)?
- **Ein blankes `() => true` reicht nicht.** Gemessen: Der Lauf bleibt rot, aber
  Name und Assertion-Diff des gescheiterten Tests sind weg, und die Zusammenfassung
  zählt Dateien statt Tests. Prüfen: Bleibt bei einem Fehlschlag heute wirklich
  alles Diagnostische erhalten?
- **Testassertions dürfen nicht am Reporter-Layout hängen.** `1d04171` korrigiert
  genau das: Der #414-Test pinnte die Überschrift `failing tests:`, die nur der
  spec-Reporter schreibt — Node 24 defaultet auf spec, Node 22 auf TAP, also war
  CI auf 22 rot, obwohl alle Diagnostik da war. Geprüft wird jetzt, *was* der Lauf
  berichtet (Parent-Ausgabe vorhanden, Test- und Fehlerzahlen, Name des
  gescheiterten Tests), nicht wie es gesetzt ist. Prüfen: Hängt noch eine andere
  Assertion in `tools/__tests__/` an reporterspezifischem Text?
- **`84adf3e` ist ein reiner Umzug.** Dieselben Blöcke, dieselben Kommentare,
  dieselbe Reihenfolge an derselben Stelle im Boot; `VAULT_PATH` kommt jetzt als
  Parameter statt aus dem Modul-Scope. Prüfen: Hat sich die Reihenfolge der
  Observer-Registrierung relativ zu allem anderen im Boot verschoben, und ist die
  Parametrisierung von `VAULT_PATH` an allen Aufrufstellen konsistent?

### 3.3 Wie verifiziert wurde

#383: Volle Suite auf Node 22.18.0 / darwin-arm64, drei Arme — ungekapselt 9/20
Läufe gecrasht, gekapselt 0/20 bei identischer Wallclock (13,5 s),
`--test-concurrency=1` 0/10 bei 71,7 s (5,3×). Fisher-exakt p ≈ 0,0008. Node
24.16.0 ungekapselt 0/15 (nicht beweisbar immun, nur deutlich seltener). Zahlen und
Herleitung im Abschlusskommentar von
[#383](https://github.com/n0mad-ai/bastra-recall/issues/383).

#414: Drei neue Tests in `tools/__tests__/test-env-stdout.test.mjs` fahren einen
echten geschachtelten `node --test`-Lauf und prüfen, dass 201 rohe ✓-Zeilen aus
einem Kind verschwinden, dass die Einzeltest-Frames trotzdem ankommen, dass ein
Fehlschlag Name und Diff behält und dass die Parent-Ausgabe unangetastet bleibt.
Gegenprobe ohne Shim zeigt die rohen Zeilen. Volle Suite 1851 Tests / 0 fail
(Baseline 1848), Typecheck und Build exit 0. Details in
[#414](https://github.com/n0mad-ai/bastra-recall/issues/414).

Preis, bewusst in Kauf genommen: stdout-Debugausgabe ist während eines Testlaufs
weg, stderr bleibt sichtbar. Die sechs bestehenden per-File-Kapselungen wurden
nicht zurückgebaut.

---

## 4. Strang c — Eval-Fundament

### 4.1 Was gebaut wurde

`53b42a3` führt das optionale Feld `probe_group` im Goldset ein. Die Telemetrie
erntet Diagnose- und Rausch-Sonden wie jeden anderen Recall: vier Läufe einer
Body-Loss-Untersuchung gewichteten deren Zielmemory vierfach, und acht
Gibberish-Strings hoben den No-Answer-Anteil des Sets von 13,9 % auf 15,8 %. Die
Sonden bleiben im Set — Abstention ist messenswert — bekommen aber einen eigenen
Nenner. Derselbe Commit benennt die Labelling-Hilfe des Harvesters in
`miss-candidates` um: Alle drei Kandidaten waren Retrieval-Fehler, keine
No-Answers, und aus ihnen zu labeln hätte die eigenen Misses der Engine ins
Goldset geschrieben.

`4fab43f` liefert `goldset-run.ts`. Bis dahin hatte `packages/eval` 23
Ablations-Harnesses und **keinen**, der `gold-*.json` liest — der Stress-Harness
misst weiter `PARAPHRASED_CASES`, also genau die Fixtures, die §19 verwirft. Der
neue Runner liest die fünf Gold-Dateien, misst in-process gegen `SearchIndex` und
schreibt das #261-Run-Artefakt-Layout.

`9f4f328` legt darauf auf, was §18.1 erst nach der Baseline erlaubt: die
M2-Cue-Zahlen und die M1-Toleranzen, hergeleitet aus dem Baseline-Artefakt
`2026-08-28-5653e6987eac`. Der Validator bekam die zwei Regeln, die diese
Registrierung freilegte — das gewählte Design muss sein eigenes N tragen, und ein
benannter Split muss sagen, wonach er stratifiziert.

### 4.2 Invarianten, die ein Reviewer angreifen sollte

- **Kein stiller Arm-Fallback (§18.1).** Der Lauf wirft, wenn die Größe des
  lexikalischen Index von der Vault-Größe abweicht (`goldset-run.ts:311`), wenn
  der Embedding-Provider nicht erreichbar ist (`:152`), wenn nur ein Teil der
  Memories einen Vektor trägt (`:169`) oder wenn `useEmbeddings()` nicht griff
  (`:174`). Jede Ergebniszeile hält fest, welcher Arm ihren Top-Treffer erzeugt
  hat. Prüfen: Gibt es einen Pfad, auf dem ein degradierter Arm trotzdem als
  „hybrid" berichtet wird? Das Gate fing bei seinem ersten Lauf einen echten Bug
  (fehlendes `search.start()` → vector-only als hybrid getarnt, Baseline 12 Punkte
  zu niedrig) — es ist also scharf, aber genau deshalb lohnt der Angriff.
- **Sonden nie im Hauptnenner.** `main.filter(r => r.probe_group)` gegen
  `!r.probe_group` (`:336-337`), Kontrollarm zusätzlich ohne `no_answer`
  (`:340`). Prüfen: Rutscht eine Sonde über Coverage-Zahlen, `by_group` oder das
  Artefakt doch in eine Hauptkennzahl?
- **Rückwärtskompatibilität des Goldsets.** `probe_group` ist optional, damit jede
  vor dem Commit geschriebene Gold-Datei gültig bleibt und ihre Coverage-Zahlen
  unverändert sind. Prüfen: Stimmt das für alle fünf Dateien?
- **Determinismus des Kontrollarms.** mulberry32-PRNG, damit die Zufallsrangfolge
  zwischen Läufen nicht wandert (`:184`). Prüfen: Ist der Seed wirklich fixiert
  und unabhängig von der Fallreihenfolge?
- **Duplikatschutz.** `:300` wirft bei doppelten Case-ids über die Gold-Dateien
  hinweg.
- **Registrierte Zahlen müssen aus der Baseline folgen (`9f4f328`).** §18.1
  verlangt, dass jede numerische Größe *nach* der Baseline festgelegt wird. Die
  Cue-Registrierung steht jetzt auf `numbers_registered`: 255 gepaarte
  Holdout-Fälle pro Bedingung, hergeleitet aus 10,8 % gemessener gepaarter
  Diskordanz bei Recall@3 und einem kleinsten interessierenden Effekt von 6 pp.
  Der Split ist nach `origin_type` und `lang` stratifiziert, und das ist bindend,
  nicht beratend — Recall@3 streut über die Gold-Dateien von 31,3 % bis 84,9 %,
  eine unstratifizierte Ziehung kann die Vergleichsbasis also weiter verschieben
  als der zu messende Effekt. Prüfen: Trägt die Herleitung der Fallzahl, und ist
  die Stratifizierung im Validator wirklich erzwungen statt nur dokumentiert?
- **Eine bewusst *nicht* vergebene Toleranz.** M1 setzt `relevant_loss <= 0,23`
  (knapp über der Obergrenze des gemessenen Wilson-Intervalls, damit ein sauberer
  Re-Run sie nicht reißt), vergibt für `false_abstention` aber **gar keine Zahl**:
  Auf dem hybriden Pfad ist der Score-Floor konstruktionsbedingt unerreichbar,
  die Metrik steht fest auf null, und jede Toleranz würde bedingungslos bestehen.
  Registriert ist stattdessen der `weak_result`-Pfad als Nachfolge. Prüfen: Gibt
  es weitere registrierte Toleranzen, die aus demselben Grund unverdient bestehen?

### 4.3 Wie verifiziert wurde

45 neue Zeilen Tests in `packages/eval/__tests__/goldset.test.ts` für
`probe_group`, 52 in `goldset-run.test.ts` für den Runner, und `9f4f328` erweitert
`registrations.test.ts` um 121 Zeilen für die beiden neuen Validator-Regeln. Der
eigentliche Beleg
ist aber der M0-Baseline-Lauf selbst (Abschnitt 5) — er wurde von einem
unabhängigen Prüfer aus den Rohartefakten nachgerechnet, ohne Sicht auf den
Runner-Code, und alle 20 berichteten Zahlen wurden bestätigt.

---

## 5. M0-Baseline als Kontext

Aus dem Statuskommentar zu
[#262](https://github.com/n0mad-ai/bastra-recall/issues/262) vom 28.08.2026.
Gemessen in-process auf `53b42a3` (core vor dem Lauf neu gebaut), Produktions-k=10,
Ollama `embeddinggemma`, Vault 1028 Memories. **Hauptnenner 432** (372 answerable /
60 no_answer):

| Metrik | hybrid | bm25-only | control |
|---|---:|---:|---:|
| R@1 | **0,4704** | 0,4704 | 0,0000 |
| R@3 | **0,6882** | 0,6559 | 0,0000 |
| R@10 | **0,8145** | 0,7634 | 0,0108 |
| MRR | **0,5873** | 0,5726 | 0,0020 |

Jede Zahl wurde unabhängig aus den Rohartefakten nachgerechnet und bestätigt.
Diese Werte sind der Bezugspunkt: Eine Eval-Änderung, die sie ohne Erklärung
verschiebt, ist ein Befund. Vier bekannte Schwächen aus demselben Lauf, damit sie
nicht als neue Entdeckung berichtet werden: `second_person` R@3 0,313 (n=67) gegen
`session_transcript` 0,777; `associative` 0/7 in den Top 3; `en` R@3 0,400 (n=30)
gegen de 0,544 und neutral 0,747; und die Abstention ist auf dem hybriden Arm
degeneriert — der niedrigstmögliche Einarm-Rang-1-RRF-Score (81,967) übersteigt
den dokumentierten Floor (30) konstruktionsbedingt, also abstinierten 0 von 60
No-Answer-Fällen.

## 6. Bekannte offene Punkte — nicht neu suchen

Diese sind erfasst, mit Analyse im jeweiligen Issue. Ein erneuter Befund dazu
kostet nur Zeit; eine *Korrektur* an der dortigen Analyse ist dagegen wertvoll.

| Issue | Kurz |
|---|---|
| [#413](https://github.com/n0mad-ai/bastra-recall/issues/413) | Der hook-komponierte Filter (`HOOK_TEMPLATES`, `goldset-harvest.ts:58`) verlangt das Wort `involving` und fängt damit nur die englische Hook-Query-Form. Die sprachneutrale Form ist seit #231 die Default. 46 von 400 gestagten Telemetrie-Queries sind betroffen; die exakte Klassifikation liegt im Issue. |
| [#415](https://github.com/n0mad-ai/bastra-recall/issues/415) | Der Bash-Tripwire feuert auf Prosa in einem Heredoc — „TRUNCATES" im Fließtext ist kein destruktives Kommando. |
| [#416](https://github.com/n0mad-ai/bastra-recall/issues/416) | `packages/eval/src/goldset-harvest.ts` enthält drei rohe NUL-Bytes im Hash-Input-Template. **Konsequenz für dieses Review: git behandelt die Datei als binär.** Diffs dieser Datei nur mit `git diff --text` ansehen, `grep -rn` überspringt sie stillschweigend. |
| [#417](https://github.com/n0mad-ai/bastra-recall/issues/417) | Das Run-Artefakt speichert abgeleitete Ränge, nicht die Top-k-id-Listen — Rangbestimmung jenseits Position 1 ist aus dem Artefakt nicht unabhängig nachprüfbar. |
| [#379](https://github.com/n0mad-ai/bastra-recall/issues/379) | `withAreaShared` verschluckt den unlink-Fehler des Reader-Markers; ein steckengebliebener Marker blockiert jede Area-Operation bis zum Prozessende. |
| [#380](https://github.com/n0mad-ai/bastra-recall/issues/380) | `audit_warning` erreicht nur den Bridge-Pfad; MCP- und REST-Aufrufer sehen eine committete Mutation weiterhin als glatten Erfolg. |
| [#381](https://github.com/n0mad-ai/bastra-recall/issues/381) | Der `IdClaim`-Brand wird zur Laufzeit nie validiert — ein JS-Aufrufer kann den exportierten trash-Primitiven einen erfundenen Claim übergeben. |
| [#382](https://github.com/n0mad-ai/bastra-recall/issues/382) | Eine Re-File-Quelle, die nur der autoritative Scan findet, ist vom Area-Lock nicht abgedeckt. |

#379–#382 gehören zusammen als v0.9.3-Write-Path-Härtung und sind bekannt.
[#377](https://github.com/n0mad-ai/bastra-recall/issues/377) ist trotz `5cb4200`
noch offen: Gemeldet wird bisher an drei Stellen (gescheitertes Audit-Append,
Re-File-Rollback, Area-Claim inkl. Reclaim). Weitere Meldestellen zu benennen ist
ein legitimer Befund.

## 7. Prüfregeln

1. **P0 wird sofort gefixt.** Alles andere wird ein Issue — kein Sammel-Review-
   Dokument, keine Drive-by-Fixes an Nicht-P0-Befunden. Vereinbarte Regel.
2. **Jeder Befund mit Referenz.** Commit-SHA und `datei.ts:zeile`, damit er ohne
   Suche nachvollziehbar ist.
3. **Der Prüfumfang ist der Diff, nicht das Repository.** Ältere Schwächen, auf
   die der Diff nur zeigt, sind ein Issue mit Hinweis darauf — kein Anlass, den
   Umfang auszudehnen.
4. **Bei `packages/eval/src/goldset-harvest.ts`: `git diff --text`** (siehe #416).
5. **Gemessene Zahlen schlagen Plausibilität.** Wo dieses Dokument eine Messung
   nennt, ist der Weg zum Nachrechnen im verlinkten Issue-Kommentar beschrieben.
   Eine Zahl anzuzweifeln ist willkommen — dann bitte mit einer Gegenmessung.
