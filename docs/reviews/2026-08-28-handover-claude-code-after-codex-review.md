# Rückübergabe an Claude Code — nach dem Codex-Gesamtreview

**Stand:** 28. August 2026  
**Geprüfter Stand:** `ad86155..13b469c`  
**Reviewregel:** Nur P0 sofort beheben; alle anderen Befunde als eigene Issues  
**Ergebnis:** Kein P0. Codex hat keinen Produktcode verändert.

## Stopp-Punkt und Betriebszustand

- Die Nachprüfung der 71 bisherigen `no_answer`-Fälle gegen den vollen Index ist
  abgeschlossen: 1 Fall gekippt und verworfen, 69 bestätigt, drei davon mit
  stärkerem Beleg. Der aktuelle Hauptnenner ist **447**. Das Addendum steht an
  [#262](https://github.com/n0mad-ai/bastra-recall/issues/262).
- Die historische Baseline mit Nenner **432** bleibt als historisches Artefakt
  unverändert. Noch keine Zwischenbaseline auf 447 starten; siehe
  „Nenner- und Baseline-Entscheidung“ unten.
- Die Shadow-Acceptance-Uhr läuft. Evidence-Gate und Cue-Schicht sind aus; der
  Context Governor hat Budget null.
- Nach dem Review waren Build, Typecheck und Tests grün: 2.000 Tests, 1.998
  bestanden, 0 fehlgeschlagen, 1 übersprungen, 1 Todo.
- Nächste Authoring-Arbeit bleibt [#418](https://github.com/n0mad-ai/bastra-recall/issues/418),
  Chargen 2–3: ungefähr 350 projekt-abgeleitete Queries für die 150
  assoziativen Fälle; freie situative Rätsel bleiben gestrichen.

## Review-Ausgang

Alle 20 Nicht-P0-Befunde liegen einzeln, Englisch zuerst und Deutsch danach, im
neuen Milestone
[Special-case issues / Sonderfallissues](https://github.com/n0mad-ai/bastra-recall/milestone/26):
[#425–#444](https://github.com/n0mad-ai/bastra-recall/milestone/26).

Der Milestone ist bewusst **keine Aufforderung, jetzt alle 20 Issues zu
beheben**. Vor der nächsten Umsetzung bitte mit dem Nutzer entscheiden, welches
der folgenden Pakete jetzt gezogen und welches bis zu seinem Aktivierungstor
zurückgestellt wird.

## Entscheidung 1 — Messintegrität vor der nächsten neuen Baseline

**Codex-Empfehlung: jetzt als zusammenhängendes Paket beheben**, spätestens
bevor aus dem finalen Goldset eine neue zitierfähige Baseline oder ein
Selection/Holdout-Split erzeugt wird.

| Issue | Sonderfall | Warum vor der Messung |
|---|---|---|
| [#426](https://github.com/n0mad-ai/bastra-recall/issues/426) | The random control arm depends on case order / Der Zufallskontrollarm hängt von der Fallreihenfolge ab | Sonst verschiebt reine Eingabereihenfolge die Nullbaseline. |
| [#428](https://github.com/n0mad-ai/bastra-recall/issues/428) | Hybrid gold runs can silently fall back per query / Hybrid-Goldläufe können pro Query still zurückfallen | Ein als hybrid bezeichnetes Artefakt kann unbemerkt BM25-Zeilen enthalten. |
| [#430](https://github.com/n0mad-ai/bastra-recall/issues/430) | The dataset hash ignores queries and labels / Der Dataset-Hash ignoriert Queries und Labels | Materiell verschiedene Goldsets können dieselbe Zitieridentität erhalten. |
| [#432](https://github.com/n0mad-ai/bastra-recall/issues/432) | Unknown gold IDs are scored as retrieval misses / Unbekannte Gold-IDs werden als Retrieval-Misses gewertet | Ein ungültiger Gold-Verweis drückt heute die Metrik statt den Lauf zu sperren. |
| [#434](https://github.com/n0mad-ai/bastra-recall/issues/434) | The goldset runner trusts unvalidated case objects / Der Goldset-Runner vertraut ungeprüften Case-Objekten | Der Mess-Einstieg akzeptiert fehlerhafte oder denominatorverändernde Cases. |
| [#444](https://github.com/n0mad-ai/bastra-recall/issues/444) | Tiny or ineffective strata can defeat the selection/holdout split / Winzige oder wirkungslose Strata können den Selection/Holdout-Split aushebeln | Der spätere Split kann seine zugesagte Balance nur scheinbar erfüllen. |

Das bereits bestehende [#417](https://github.com/n0mad-ai/bastra-recall/issues/417)
gehört für eine vollständig nachprüfbare neue Baseline ebenfalls in dieses
Messpaket; es ist kein neuer Codex-Befund und deshalb nicht im
Sonderfall-Milestone.

## Entscheidung 2 — laufende Shadow-Uhr und heutige Telemetrie

Diese beiden Fälle brauchen eine bewusste Entscheidung **jetzt**, weil der
betroffene Pfad bereits Daten schreibt. Sie waren im Review trotzdem kein P0.

| Issue | Sonderfall | Jetzt beheben, wenn … | Später vertretbar, wenn … |
|---|---|---|---|
| [#429](https://github.com/n0mad-ai/bastra-recall/issues/429) | Session-context hook recalls lose their telemetry dimensions / Session-Context-Hook-Recalls verlieren ihre Telemetrie-Dimensionen | die laufende Shadow-Auswertung nach Client oder Hook-Quelle getrennt wird; dann festlegen, ob das Messfenster nach dem Fix neu beginnen muss. | für die Gate-Entscheidung nur nicht betroffene Aggregate zählen und `unknown/unknown` ausdrücklich ausgeschlossen wird. |
| [#436](https://github.com/n0mad-ai/bastra-recall/issues/436) | Raw external session IDs remain in dimensioned telemetry / Rohe externe Session-IDs bleiben in dimensionierter Telemetrie | rohe fremde Session-IDs auch im lokalen Telemetrielog nicht akzeptabel sind oder Logs geteilt/exportiert werden. | die Logs strikt lokal bleiben und die Bereinigung verbindlich vor jedem Export erfolgt. |

## Entscheidung 3 — bis zum jeweiligen Aktivierungstor zurückstellbar

Diese Fälle sind heute durch ausgeschaltete bzw. wirkungslose Hebel maskiert.
Sie können später bearbeitet werden, dürfen ihr genanntes Tor aber nicht
passieren.

### Vor Cue-Erzeugung oder Cue-Auswertung

| Issue | Sonderfall |
|---|---|
| [#427](https://github.com/n0mad-ai/bastra-recall/issues/427) | Cue “overwrite” appends to the existing sidecar / Cue-„Overwrite“ hängt an das bestehende Sidecar an |
| [#433](https://github.com/n0mad-ai/bastra-recall/issues/433) | Cue self-tests can run on an empty or degraded vector arm / Cue-Selbsttests können mit leerem oder degradiertem Vektorarm laufen |

### Vor Aktivierung des Evidence-Gates

| Issue | Sonderfall |
|---|---|
| [#425](https://github.com/n0mad-ai/bastra-recall/issues/425) | Persisted evidence-gate and experiment settings are discarded / Persistierte Evidence-Gate- und Experiment-Settings werden verworfen |
| [#440](https://github.com/n0mad-ai/bastra-recall/issues/440) | Recall-when coverage uses substring matches / Recall-when-Coverage verwendet Teilstring-Treffer |
| [#443](https://github.com/n0mad-ai/bastra-recall/issues/443) | Invalid evidence-gate environment values enable the gate / Ungültige Evidence-Gate-Env-Werte aktivieren das Gate |

[#443](https://github.com/n0mad-ai/bastra-recall/issues/443) vorziehen,
falls in der laufenden Arbeit irgendein Gate-Env-Wert gesetzt oder verändert
wird: Ein Tippfehler aktiviert heute die Live-Unterdrückung.

### Vor Start oder Auswertung des Präsentationsexperiments

| Issue | Sonderfall |
|---|---|
| [#425](https://github.com/n0mad-ai/bastra-recall/issues/425) | Persisted evidence-gate and experiment settings are discarded / Persistierte Evidence-Gate- und Experiment-Settings werden verworfen |
| [#437](https://github.com/n0mad-ai/bastra-recall/issues/437) | Arm statistics report rates without enforcing minimum N / Arm-Statistik berichtet Quoten ohne Mindest-N-Prüfung |
| [#439](https://github.com/n0mad-ai/bastra-recall/issues/439) | Experiment telemetry drops its registration identity / Experiment-Telemetrie verwirft ihre Registrierungsidentität |
| [#442](https://github.com/n0mad-ai/bastra-recall/issues/442) | Presentation registration accepts an empty reporting rule / Präsentationsregistrierung akzeptiert eine leere Berichtsregel |

[#429](https://github.com/n0mad-ai/bastra-recall/issues/429) und
[#436](https://github.com/n0mad-ai/bastra-recall/issues/436) müssen ebenfalls
vor einem belastbaren Experiment geklärt sein. #425 steht absichtlich in zwei
Toren: Derselbe Settings-Deserialisierungsfehler betrifft Gate **und**
Experimentzuweisung.

### Vor Aktivierung eines Governor-Budgets

| Issue | Sonderfall |
|---|---|
| [#438](https://github.com/n0mad-ai/bastra-recall/issues/438) | Duplicate governor IDs can bypass item and token budgets / Doppelte Governor-IDs können Item- und Tokenbudgets umgehen |

## Entscheidung 4 — unabhängige Betriebsrobustheit

Diese drei Fälle verändern nicht die Goldset-Metrik. Sie können separat geplant
werden; vor dem jeweils betroffenen produktiven Vorgang sollten sie geschlossen
sein.

| Issue | Sonderfall | Betroffenes Tor |
|---|---|---|
| [#431](https://github.com/n0mad-ai/bastra-recall/issues/431) | Recovery-journal I/O failures are reported as success or absence / I/O-Fehler im Recovery-Journal erscheinen als Erfolg oder Abwesenheit | Vor Verlass auf Recovery-/Incident-Quittierung unter realen I/O-Fehlern. |
| [#435](https://github.com/n0mad-ai/bastra-recall/issues/435) | Homebrew update can repoint autostart to the old keg / Homebrew-Update kann Autostart auf das alte Keg zurückbiegen | Vor dem nächsten produktiven Homebrew-Upgrade mit verwaltetem Autostart. |
| [#441](https://github.com/n0mad-ai/bastra-recall/issues/441) | Staged updates never refresh a managed LaunchAgent / Staged Updates aktualisieren einen verwalteten LaunchAgent nie | Vor dem nächsten unbeaufsichtigten `--staged`-Update mit verwaltetem LaunchAgent. |

## Nenner- und Baseline-Entscheidung

Codex empfiehlt:

1. **447** als den aktuell korrekten Hauptnenner behandeln.
2. Die historische 432er-Baseline unverändert und klar als historischen Lauf
   erhalten; sie nicht nachträglich umdeuten.
3. Jetzt keine kurzlebige Zwischenbaseline auf 447 erzeugen, weil #418 Chargen
   2–3 den Nenner erneut verändern und die Messintegritätsfälle oben noch offen
   sind.
4. Nach #418, dem finalen Nenner und dem beschlossenen Messpaket eine neue,
   versionierte Baseline erzeugen und neben der 432er-Baseline aufbewahren.

## Empfohlene Reihenfolge für die nächste Session

1. Mit dem Nutzer die vier Entscheidungen oben treffen; insbesondere
   Messpaket, #429 und #436 ausdrücklich bestätigen oder zurückstellen.
2. Nur die als „jetzt“ beschlossenen Issues beheben, je Issue oder kohärentem
   Paket mit Tests und nachvollziehbaren Commits.
3. [#418](https://github.com/n0mad-ai/bastra-recall/issues/418) Chargen 2–3
   durchführen; keine freien situativen Rätsel wieder einführen.
4. Finalen Hauptnenner feststellen.
5. Messintegritäts-Gates schließen und eine neue versionierte Baseline laufen
   lassen; die historische 432er-Baseline behalten.

**Wichtig:** Nicht automatisch mit der Reparatur aller Sonderfälle beginnen.
Diese Rückübergabe soll zuerst die gemeinsame Entscheidung „gleich beheben oder
bis zum benannten Tor zurückstellen“ ermöglichen.
