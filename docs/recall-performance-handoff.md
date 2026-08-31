# Claude-Code-Übergabe: Recall-Performance, Suchmodi und BM25-Beschleunigung

**Stand:** 25. August 2026  
**Status:** Recherche, Gegenmessung und Incident-Analyse; keine Produktionsänderung  
**Relevanter Produktionscode:** [`packages/core/src/search.ts`](../packages/core/src/search.ts)  
**Vorhandenes Messwerkzeug:** `npm run bm25-expansion --workspace @bastra-recall/eval`

> **Aktualisierung nach Gegenprüfung:** Die Termgruppierung ist nur dann
> rangneutral, wenn nach MiniSearchs `processTerm` gruppiert wird. Eine
> Gruppierung direkt nach `tokenizeWithIdentifiers` ist **nicht** rangneutral.
> Beide Varianten wurden am 25.08.2026 auf demselben 989-Memory-/30-Prompt-
> Aufbau gegeneinander gemessen; der exakte Code und die Ergebnisse stehen in
> Abschnitt 4.5. Zusätzlich dokumentiert Abschnitt 4.6 einen bestätigten
> Produktions-Incident mit unfused BM25-Scores bis in den Millionenbereich und
> einen falschen `matched_recall_when`-Anker.

## 1. Auftrag und Randbedingungen

Bastra Recall durchsucht bei Prompts und Tool-Aufrufen einen lokalen Vault aus derzeit rund 989 Markdown-Memories. Die Suche besteht aus einem lexikalischen MiniSearch/BM25-Arm und optional einem dichten Arm über ein lokales Ollama-Embedding-Modell. Beide Ranglisten werden per Reciprocal Rank Fusion (RRF) zusammengeführt.

Das Ziel ist eine belastbare Recall-Latenz von ungefähr 200 ms pro Aufruf. Lange Prompts liegen heute bei rund 1.100 bis 1.300 ms. Timeouts sind besonders gefährlich, weil sie keinen sichtbaren Fehler erzeugen, sondern schlicht keine Erinnerung liefern.

Zwingende Produktanforderungen:

- BM25 darf nicht vollständig entfernt werden. Viele Nutzer können oder wollen kein zusätzliches Embedding-Modell laden.
- Exakte Code-Bezeichner, Dateinamen, Pfade und Funktionsnamen sind ein wichtiger Suchfall.
- Ein optionaler dichter Arm darf schnelle Rechner verbessern, darf aber nicht Voraussetzung für Recall sein.
- Änderungen müssen gegen echte Prompts und den echten Vault geprüft werden. Die derzeit ausgelieferten Treffer sind als Regressionstest nützlich, aber nicht automatisch die Wahrheit über Relevanz.
- Diese Übergabe empfiehlt Änderungen, implementiert sie aber nicht.

## 2. Kurzfazit

Die klare Antwort lautet:

1. **Vor jeder Performancearbeit steht jetzt ein P0-Korrektheitsfix.** Beim Hook-Timeout fällt `recallHybrid()` auf rohe, unbeschränkte BM25-Scores zurück. `/hook/recall` kennzeichnet sie korrekt als `unfused`, aber die Prompt-Lane verwirft dieses Signal, wendet trotzdem die RRF-Grenzen 50/100 an und präsentiert sechsstellige BM25-Werte als REQUIRED. Ein zweiter Fehler lässt Fuzzy-Terme als absichtliche `recall_when`-Anker gelten.
2. **Mit dem heutigen Verhalten „jeden der ungefähr 1.000 Query-Terme exakt, als Präfix und fuzzy über sieben Felder suchen“ sind 200 ms auf einem einzelnen JavaScript-Thread nicht realistisch.** Ein Worker macht den Daemon reaktionsfähig und ermöglicht echte Überlappung mit Ollama, verkürzt aber die BM25-Rechenarbeit selbst nicht.
3. **BM25 muss trotzdem bleiben.** Bei langen Prompts ist der dichte Arm sehr stark. Bei kurzen exakten Identifier-Suchen gibt es dagegen eine nachgemessene Klasse von Treffern, die der dichte Arm verpasst.
4. **Der beste rangneutrale Performancehebel ist präzise definiert:** doppelte, bereits durch `processTerm` normalisierte Query-Terme einmal suchen und ihre Häufigkeit über MiniSearchs `boostTerm` erhalten. Im aktuellen Gegenlauf sank p50 von 1.237 auf 493 ms und p90 von 1.692 auf 719 ms; alle 30 vollständigen Ranglisten blieben identisch. Gruppierung vor `processTerm` ist dagegen nicht neutral.
5. **Der Weg zu 200 ms ist danach ein kostenabhängiger Suchrouter:**
   - kurze oder billige Queries: voller BM25-Arm, optional hybrid;
   - lange Queries mit Ollama: dichter Arm plus sehr billige exakte Identifier-Rettung;
   - lange Queries ohne Ollama: deduplizierter Exact/Prefix-BM25-Pass, Fuzzy nur gezielt oder als billiger Fallback für kurze/OOV-Terme;
   - Provider-Ausfall: immer ein sichtbarer, ehrlicher BM25-Fallback, niemals still „keine Erinnerung“.
6. **Der Score-Schwellwert ist ein eigener Konstruktionsfehler und inzwischen als Incident sichtbar.** RRF ist eine Ordnungsfunktion, keine kalibrierte Relevanzwahrscheinlichkeit. Ein hybrider RRF-Score, ein einarmiger Vector-Rang und ein roher BM25-Score dürfen nicht durch eine nackte `score`-Zahl auf dieselbe scheinbare Skala gezwungen werden. Retrieval und Einblendentscheidung müssen getrennt werden.

Mit dieser Architektur erscheint ein warmer p50-Wert um 200 ms plausibel. Eine harte 200-ms-Garantie oder p99 unter 200 ms ist mit einem dichten Arm, dessen Median allein 175 ms beträgt, nicht plausibel. Das SLO muss deshalb explizit als p50, p90 oder Deadline definiert werden.

## 3. Ist-Zustand im Repository

### 3.1 Lexikalischer Arm

`SearchIndex` baut einen In-Memory-Index mit MiniSearch 7.2.0 auf. Gesucht werden sieben Felder:

| Feld | Gewicht |
|---|---:|
| `recall_when_flat` | 5 |
| `title` | 4 |
| `tags_flat` | 3 |
| `recall_when_expanded_flat` | 2 |
| `topic_path_flat` | 2 |
| `summary` | 2 |
| `body` | 1 |

Globale Suchoptionen:

- `combineWith: "OR"`
- `prefix: true`
- `fuzzy: 0.2`

Der eigene Tokenizer emittiert Identifier sowohl als Ganzes als auch zerlegt. `my-app.config.ts` produziert beispielsweise den vollständigen Identifier und zusätzlich `my`, `app`, `config`, `ts`. Das ist für exakte Codesuche wertvoll, erhöht bei langen Prompts aber die Zahl der Expansionen.

`normalizeQuery()` kappt erst bei 8.000 Zeichen. Der Cap ist als Schutz gegen feindliche Eingaben gedacht und ausdrücklich kein Relevanz-Knopf.

### 3.2 Dichter Arm

Der dichte Arm erzeugt ein Query-Embedding über Ollama/EmbeddingGemma und vergleicht es per Cosinus mit den gespeicherten Vektoren. Der Memory-Embeddingtext enthält Titel, Tags, `recall_when`, Summary und die ersten 4.000 Zeichen des Bodys.

Der Arm hat eine eigene Deadline von 150 ms. Beim Überschreiten wird sein Ergebnis für diesen Aufruf aufgegeben; die eigentliche Anfrage darf im Hintergrund fertiglaufen, damit ein kaltes Modell warm werden kann.

EmbeddingGemma hat offiziell ein Kontextfenster von 2.048 Tokens. Ollamas Embed-Endpunkt schneidet zu lange Eingaben standardmäßig auf das Kontextfenster zu. Bei langen, codehaltigen Prompts ist deshalb zu prüfen, wie viele Tokens tatsächlich verarbeitet werden und ob wichtige Identifier am Ende abgeschnitten werden. [Google EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma), [Ollama Embed API](https://docs.ollama.com/api/embed)

### 3.3 Nebenläufigkeit

Der dichte Promise wird vor MiniSearch gestartet. MiniSearch läuft danach synchron im Node-Hauptthread. Dadurch kann der Event Loop während BM25 weder Netzwerkfortschritt noch Timer und Promise-Fortsetzungen normal abarbeiten. Die beiden Arme sind logisch nebenläufig, aber der CPU-Arm verhindert echte Nebenläufigkeit im Daemon.

### 3.4 RRF und Schwellen

Aktuell gilt:

```text
RRF_K = 5
RRF_SCALE = 5000 × (RRF_K + 1) / 61 = 491,803...
Beitrag eines Arms auf Rang r = RRF_SCALE / (RRF_K + r)
```

Folgen:

- einarmig Rang 1: maximal 81,967 Punkte;
- beide Arme Rang 1: maximal 163,934 Punkte;
- die `required`-Schwelle 100 ist mit nur einem RRF-Arm unerreichbar;
- bei zwei Armen bestehen ungefähr noch folgende Grenzpaare: `(1,22)`, `(2,11)`, `(3,7)`, `(4,5)`; selbst `(5,5)` liegt bereits unter 100.

Die Prompt-Lane verwendet für generische Prompts 100 und für erkannte Retrieval-Prompts 50. Andere Lanes verwenden ebenfalls absolute Grenzen aus dem Bereich 30/50/100. Der rohe BM25-Fallback liegt wiederum auf einer anderen Skala. Der Zahlenwert `score` bedeutet damit je nach Betriebsart nicht dasselbe.

## 4. Vorliegende Messungen

### 4.1 Produktionsmessung langer Prompts

30 echte Prompts, 2.000 bis 8.000 Zeichen, Median 7.407, echter Vault und vollständiger Produktionspfad:

| Messgröße | Ergebnis |
|---|---:|
| Lexikalischer Arm p50 | 1.137 ms |
| Lexikalischer Arm p90 | 1.621 ms |
| Gesamtaufruf p50 | 1.327 ms |
| Dichter Arm | 124–153 ms, an der Deadline |
| Rauschgrenze | ca. 3 % |
| Kontrolllauf | 30/30 identische Ergebnisse |

Historische Skalierung des lexikalischen Arms:

| Terme, Median | 4 | 41 | 147 | 1.001 | 2.403 |
|---|---:|---:|---:|---:|---:|
| BM25 in ms | 9 | 84 | 178 | 454 | 741 |

Das Kostenwachstum folgt primär der Zahl der emittierten Terme und ihrer Prefix/Fuzzy-Expansion, nicht der kleinen Dokumentzahl von knapp 1.000.

### 4.2 Bereits verworfene Varianten

**Query-Cap auf seltene Terme:** Bei 200 Zeichen gingen auf 15 von 15 Testqueries injizierbare Treffer verloren, im Mittel 2,27. Selbst bei 2.000 Zeichen verloren 12 von 15 Queries Treffer.

**Fuzzy nur für seltene Terme:** isoliert schnell, im Produktionspfad deutlich schwächer. Sobald die Schwelle genug Arbeit sparte, kippte mindestens ein injizierbarer Treffer.

Diese Varianten scheiterten nicht zwingend daran, dass relevante Dokumente komplett aus der Kandidatenmenge verschwanden. Schon eine BM25-Rangpermutation verändert den diskreten RRF-Score und lässt Kandidaten an der absoluten Schwelle 100 umkippen.

### 4.3 Dense-only-Nachmessung für lange Prompts

20 echte Prompts, 2.000 bis 8.000 Zeichen, Median 7.581, 989 Memories:

| Modus | Median |
|---|---:|
| heutiger Hybridpfad | 1.297 ms |
| nur dichter Arm | 175 ms |

Von den 42 Treffern, die die Produktion mit `score >= 100` tatsächlich einblendete:

- 39 lagen im reinen Vektor-Ranking auf Rang 1–5;
- alle 42 lagen auf Rang 1–20;
- Median-Rang war 2;
- keiner fehlte in den Top 100.

Das ist ein starkes Signal dafür, dass bei langen Prompts der dichte Arm die heute ausgelieferten Treffer trägt. Es ist aber **kein vollständiger Recall-Beweis**: Ein Treffer mit `score >= 100` muss konstruktionsbedingt Beiträge aus beiden Armen haben und damit ohnehin im Vektor-Pool liegen. BM25-only-Kandidaten können die 100 nie erreichen und kommen deshalb gar nicht in die 42 positiven Beispiele. Die Auswertung ist als Produktionsregression nützlich, aber zirkulär als Goldstandard.

### 4.4 Kurze Identifier-Suchen: der Grund, BM25 zu behalten

Zwei ergänzende, nur lesende Auswertungen wurden durchgeführt.

**50 reale kurze Prompts mit Identifiern, Median 106 Zeichen:**

- Bei der hohen hybriden Schwelle 100 gab es 36 Treffer über 21 Queries.
- 31 lagen vectorseitig auf Rang 1–5, vier auf Rang 6–20 und einer auf Rang 21–100.
- Auch dieses Ergebnis ist durch die hybride Auswahl teilweise zirkulär.

**Nicht-zirkulärer Stress-Test mit bekanntem Ziel-Memory:**

90 eindeutige Bezeichner wurden aus echten Memories gewählt, deren Ziel im BM25-Ranking auf Rang 1–5 lag: 30 Dateinamen, 30 Funktionsnamen, 30 zusammengesetzte Identifier.

| Queryklasse | Vector Top 5 | Vector Top 20 | Vector Top 100 | fehlt Top 100 |
|---|---:|---:|---:|---:|
| insgesamt, n=90 | 38 | 55 | 68 | 22 |
| Dateinamen, n=30 | 16 | 22 | 25 | 5 |
| Funktionsnamen, n=30 | 11 | 17 | 20 | 10 |
| zusammengesetzte Identifier, n=30 | 11 | 16 | 23 | 7 |

89 der 90 Bezeichner waren im gebauten Memory-Embeddingtext sichtbar. 21 der 22 Vector-Fehlschläge waren ebenfalls sichtbar. Die Ausfälle lassen sich also nicht einfach mit dem 4.000-Zeichen-Body-Cap erklären.

Der Stress-Test ist absichtlich auf lexikalisch starke Fälle angereichert und schätzt nicht deren Häufigkeit im echten Verkehr. Er beweist aber, dass diese wichtige Fehlerklasse existiert. **BM25 ganz zu entfernen wäre sachlich falsch.**

### 4.5 Kostenzerlegung auf dem aktuellen Vault

30 echte lange Prompts, aktueller Vault mit 989 Memories. Eine Gegenmessung
hat einen wichtigen Unterschied zwischen zwei scheinbar gleichen
Gruppierungsvarianten offengelegt:

| Variante | p50 | p90 | Menge | Rang 1 | Top-5-Menge | Top-5-Reihenfolge | volle Reihenfolge | größte Score-Differenz |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| MiniSearch unverändert | 1.237 ms | 1.692 ms | Referenz | Referenz | Referenz | Referenz | Referenz | 0 |
| nach **Roh-Tokenizer** gruppiert | 531 ms | 713 ms | 30/30 | 29/30 | 11/30 | 4/30 | 0/30 | 2,553 × 10⁶ |
| nach **`processTerm`** gruppiert | 493 ms | 719 ms | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 1,49 × 10⁻⁸ |

Die ursprüngliche Messung der korrekt verarbeiteten Variante lag bei p50
467 ms und p90 698 ms. Der Gegenlauf bestätigt Größenordnung, Faktor und
Rangneutralität. Die abweichende Rückmeldung mit p50 500 ms und 0/30
identischen Vollrankings wurde ebenfalls exakt reproduziert: Sie gruppierte
vor MiniSearchs `processTerm`.

Warum das passiert:

1. `tokenizeWithIdentifiers()` erhält Groß-/Kleinschreibung. `AND` und `and`
   sind dort verschiedene Rohterme.
2. MiniSearchs Default-`processTerm` lowercaset anschließend beide zu `and`.
3. Werden vorher Rohhäufigkeiten gebildet, können mehrere vermeintlich
   eindeutige Terme nachträglich kollabieren. `boostTerm` wird dann mit einer
   Häufigkeit aus dem falschen Key-Raum aufgerufen. Das über- oder untergewichtet
   einzelne Terme massiv.
4. MiniSearch addiert den BM25-Beitrag jeder Query-Term-Instanz, multipliziert
   am Ende aber mit der Zahl der **unterschiedlichen verarbeiteten gematchten
   Query-Terme**. Nach `processTerm` gruppiert ist `ein Term n-mal` daher unter
   den heutigen Optionen algebraisch gleich `ein Term einmal mit boostTerm n`.

Der rangneutrale Kern muss sinngemäß so aussehen:

```ts
const processedTerms = tokenizeWithIdentifiers(query)
  // Exakt dieselbe processTerm-Funktion verwenden wie der Index.
  // Heute ist das MiniSearchs Default: term.toLowerCase().
  .map((term) => term.toLowerCase());

const frequency = new Map<string, number>();
for (const term of processedTerms) {
  frequency.set(term, (frequency.get(term) ?? 0) + 1);
}
const uniqueTerms = [...frequency.keys()];

const hits = mini.search(uniqueTerms.join(" "), {
  // Die Terme sind bereits tokenisiert und verarbeitet: kein zweiter
  // Identifier-Split und kein zweites processTerm.
  tokenize: (text) => text.split(" "),
  processTerm: (term) => term,
  boostTerm: (term) => frequency.get(term) ?? 1,
});
```

Robuster als das fest codierte Lowercasing wäre, die exakt konfigurierte
`processTerm`-Funktion gemeinsam für Index und Query-Gruppierung zu besitzen.
Wenn `processTerm` Arrays zurückgeben kann, müssen diese vor dem Zählen genauso
geflattet und leere Ergebnisse genauso verworfen werden wie MiniSearch es tut.
Auch zukünftige `fuzzy`-/`prefix`-Funktionen dürfen für Rangneutralität nicht
vom Termindex oder von der ungruppierten `terms[]`-Länge abhängen.

Weitere isolierte Kostenmessungen aus dem vorherigen Lauf:

| Variante | p50 | p90 | Rangverhalten |
|---|---:|---:|---|
| nur exact, ungruppiert | 106 ms | 139 ms | verändert |
| exact + prefix, ungruppiert | 600 ms | 1.194 ms | verändert |
| nur exact, korrekt gruppiert | 38 ms | 49 ms | verändert gegenüber Full-Fuzzy |
| exact + prefix, korrekt gruppiert | 140 ms | 194 ms | verändert gegenüber Full-Fuzzy |
| korrekt gruppiert plus Expansion-Cache | 419 ms | 631 ms | damals rangidentisch, aber hoher Cache-Wuchs |

Zusätzliche Beobachtungen:

- Median emittierte Terme: 1.186.
- Median eindeutige **Rohterme**: 649; nach `processTerm`: 613. Für die
  rangneutrale Gruppierung zählt ausschließlich die zweite Zahl.
- Der Index enthält ungefähr 65.475 Vokabularterme.
- Vault-Laden dauerte in der Messung ungefähr 132 ms, MiniSearch-Indexaufbau ungefähr 539 ms.
- Grobe RSS-Zunahme: Vault ca. 49 MiB, MiniSearch-Index zusätzlich ca. 152 MiB. Der exakte Wert hängt vom Node-Prozess und GC ab.
- Der Expansion-Cache brachte nach der Gruppierung nur rund weitere 10 %. Lange echte Prompts teilen zu wenige seltene Terme, während der Cache auf ungefähr 9.000 Prefix- und 9.000 Fuzzy-Einträge anwuchs.

Die zentrale Diagnose ist damit messbar: **Nach dem korrekt normalisierten
Entfernen doppelter Arbeit sind Fuzzy-Expansionen der größte Restposten; Prefix
ist ebenfalls teuer. Das eigentliche BM25-Scoring über knapp 1.000 Dokumente
ist nicht das Hauptproblem.**

### 4.6 Bestätigter Produktions-Incident: Score-Space-Leak im Prompt-Hook

Die Telemetrie vom 25.08.2026 belegt für dieselbe Session und denselben
Top-Treffer zwei verschiedene Score-Räume:

| Pfad | Top-Score | BM25-Stage | Vector-Stage | Zustand |
|---|---:|---:|---:|---|
| `UserPromptSubmit` | 405.584,777 | 395 ms | 396 ms | `vector-arm-timeout` |
| MCP-Forwarder, gleiche Query | 81,967 | 275 ms | 359 ms | RRF lief, nicht degraded |

Die Hook-Deadline für den Vector-Arm beträgt 150 ms, die MCP-Deadline 1.500
ms. Der synchrone BM25-Pass blockiert den Event Loop so lange, dass der Hook
den Vector-Arm verliert. `recallHybrid()` fällt dann absichtlich auf den rohen
BM25-Pfad zurück. Der Wert 405.584 ist deshalb kein doppelt skalierter RRF-Wert,
sondern ein gültiger, aber unbeschränkter MiniSearch-Score aus einem **anderen
Score-Raum**. Der scheinbare Faktor von ungefähr 4.900 ist nicht konstant; auch
die vollständige Rangfolge unterscheidet sich. Nicht teilen, nicht bei 164
abschneiden.

Der Recall-Endpunkt erkennt das bereits und liefert `unfused: true` sowie
`degraded: "vector-arm-timeout"`. Die Prompt-Lane besitzt diese Felder aber
nicht in ihrem Response-Typ und ignoriert sie. Danach passieren vier sachlich
falsche Schritte:

1. rohe BM25-Werte werden mit den hybriden Floors 50/100 gefiltert;
2. `score >= 100` wird als REQUIRED gelesen;
3. REQUIRED umgeht den Backoff;
4. der Text behauptet, beide Suchpfade hätten zugestimmt.

Das ist nicht nur schlechte Formulierung, sondern verändert Auslieferung und
Unterdrückung. In derselben Tagesdatei stehen weitere Hook-Fallbacks mit
Top-Scores bis 2,77 Millionen. Ein kurzer Hook kann ebenfalls degraden; lange
oder expansionsreiche Queries erhöhen aber Wahrscheinlichkeit und Magnitude.
Die Incident-Query hatte 1.532 Zeichen und zeigt damit erneut, warum ein Router
nicht nur Zeichen zählen darf.

Relevante Stellen:

- Hook-Deadline: [`packages/daemon/src/http-hook-routes.ts`](../packages/daemon/src/http-hook-routes.ts)
- MCP-Deadline: [`packages/daemon/src/mcp-forwarder.ts`](../packages/daemon/src/mcp-forwarder.ts)
- roher BM25-Fallback: [`packages/core/src/search.ts`](../packages/core/src/search.ts)
- verlorene Response-Felder/Floors: [`packages/daemon/src/prompt-lane.ts`](../packages/daemon/src/prompt-lane.ts)

### 4.7 Bestätigter Qualitätsfehler: `matched_recall_when` ist fuzzy

`matched_recall_when` bedeutet heute nicht, dass eine authored Triggerphrase
exakt gepasst hat. Die Funktion prüft lediglich, ob irgendein von MiniSearch
gemeldeter Dokumentterm im Feld `recall_when_flat` lag. MiniSearchs `match`-Map
enthält jedoch auch Prefix- und Fuzzy-Treffer und ist nach dem abgeleiteten
**Dokumentterm**, nicht zwingend nach dem ursprünglichen Queryterm indiziert.

Der konkrete Incident enthält ein fast beweisendes Minimalmuster:

- Die fremde Query enthielt das eigenständige Wort `and`, aber nicht `sand`.
- Das themenfremde Memory enthält `Sand` in `recall_when`.
- `and` → `sand` hat Levenshtein-Distanz 1.
- MiniSearch erlaubt bei drei Zeichen und `fuzzy: 0.2` genau einen Edit.
- Der resultierende Match im `recall_when`-Feld setzt den Flag auf `true`.

Damit kann ein gewöhnliches englisches `and` als absichtlicher Sand-Theme-
Trigger erscheinen. Das ist aus zwei Gründen sicherheitsrelevant:

1. `weak_result` wird für die **gesamte Trefferliste** unterdrückt, sobald ein
   Hit `matched_recall_when` oder einen toleranten Titelanker meldet.
2. Der Cross-Scope-Filter lässt einen fremden REQUIRED-Hit durch, wenn genau
   dieser Flag wahr ist. Zusammen mit einem sechsstelligen unfused BM25-Score
   greifen beide Fehler ineinander.

Ein „deliberate anchor“ muss getrennte Provenienz tragen. Mindestens darf ein
Fuzzy-/Prefix-Match ihn nicht allein setzen. Für einen Cross-Scope-Bypass ist
eine stärkere Regel ratsam: exakter seltener Identifier oder mindestens zwei
signifikante exakte Tokens aus derselben authored `recall_when`-Phrase.
`weak_result` sollte zudem pro Treffer belegbare Anchor-Arten sehen, statt von
einem booleschen Flag eines beliebigen Listenmitglieds abzuhängen.

### 4.8 Verdacht gegen Commit `0180698` widerlegt

Der zeitlich nahe Commit `0180698` ist für beide Incidents nicht ursächlich:

- `matchedRecallWhen()` stammt aus Commit `201c857` vom 30.06.2026.
- Der rohe BM25-Fallback und die unbeschränkte Skala existierten vorher.
- Die Hook-Vector-Deadline stammt vom 17.08.2026.
- `0180698` ergänzt nur `bm25_fuzzy_rare_df_max`; der Knopf ist default-off.
- Hook und MCP übergeben diese Option nicht. `bm25SearchOptions()` liefert
  deshalb `undefined`, also das Verhalten vor dem Commit.

Ein Revert von `0180698` würde die beobachteten Fehler nicht beheben.

## 5. Was die Primärquellen dazu sagen

### 5.1 MiniSearch

MiniSearch hält den Index in einer `SearchableMap`, einer Radix-Tree-Struktur. Prefix-Suche läuft über `atPrefix`, Fuzzy-Suche über `fuzzyGet`; dabei wird eine Levenshtein-Matrix während eines Tiefenscans durch den Radix Tree fortgeschrieben. Das passt exakt zum gemessenen Kostenbild: Jeder Query-Term stößt eigene Wörterbucharbeit an. [MiniSearch Design Document](https://github.com/lucaong/minisearch/blob/master/DESIGN_DOCUMENT.md)

MiniSearch erlaubt `prefix`, `fuzzy` und `boostTerm` als Funktionen pro Query-Term. Der Default für `maxFuzzy` ist 6; die Dokumentation warnt ausdrücklich, dass hohe Distanzen die Performance stark belasten können. Bei `fuzzy: 0.2` wächst die erlaubte Edit-Distanz mit der Termlänge bis zu diesem Cap. [MiniSearch-Quellcode](https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts)

Das stützt zwei Empfehlungen und eine harte Vorbedingung:

1. Identische **verarbeitete** Query-Terme algebraisch zusammenzufassen ist
   ein rangneutraler Hebel. Rohterme vor `processTerm` zu gruppieren ist es
   nachweislich nicht.
2. Die Äquivalenz beruht auf MiniSearchs heutiger Formel: linearer
   Termbeitrag plus Qualitätsfaktor aus unterschiedlichen gematchten
   verarbeiteten Query-Termen. Jede Änderung an `processTerm`, `combineWith`
   oder index-/listenabhängigen Prefix-/Fuzzy-Funktionen muss den Paritätstest
   erneut bestehen.
3. Fuzzy über jeden Term eines langen Prompts ist strukturell teuer. Ein kleineres `maxFuzzy`, eine nicht-fuzzy Prefix-Länge oder termabhängiges Fuzzy kann viel sparen, verändert aber Kandidaten und Ränge und muss deshalb als Retrievaländerung evaluiert werden.

MiniSearch hat Fuzzy-Performance in früheren Versionen bereits wesentlich verbessert. Da das Projekt schon Version 7.2.0 verwendet, ist ein reines Bibliotheksupdate nicht als siebenfacher Gewinn zu erwarten. [MiniSearch Changelog](https://github.com/lucaong/minisearch/blob/master/CHANGELOG.md)

### 5.2 Worker Threads

Node empfiehlt Worker Threads ausdrücklich für CPU-intensive JavaScript-Arbeit. `ArrayBuffer` kann übertragen und `SharedArrayBuffer` geteilt werden. Ein MiniSearch-Index aus Maps und Objektgraphen wird dadurch jedoch nicht automatisch geteilter Speicher. [Node.js `worker_threads`](https://nodejs.org/api/worker_threads.html)

Praktische Folge:

- Ein Worker beseitigt Event-Loop-Blockaden und lässt den Ollama-I/O tatsächlich überlappen.
- Ein Worker macht aus 1.100 ms CPU-Arbeit nicht 200 ms; die Wanduhr nähert sich nur `max(BM25, Dense)` statt der Summe.
- Mehrere Worker können Query-Terme sharden, benötigen mit dem heutigen Index aber wahrscheinlich je eine Indexkopie. Vier Kopien lägen in der groben Messung bei rund 600 MiB nur für MiniSearch, zuzüglich Worker-Heaps, Vault und Ollama. Das ist gerade für schwache Rechner unattraktiv.
- Ein synchron laufender Workerauftrag lässt sich nicht sauber mitten in MiniSearch abbrechen. Das System braucht eine begrenzte Queue und muss verspätete Ergebnisse verwerfen; Worker-Terminierung als Timeout würde den Index verlieren und einen teuren Neuaufbau erzwingen.

### 5.3 Native Volltextindizes

**SQLite FTS5** bietet nativen BM25, Feldgewichte und optionale Prefix-Indizes. Prefix-Indizes tauschen zusätzlichen Speicher und Indexierungsarbeit gegen schnellere Prefix-Abfragen. Sein BM25 ist aber fest mit `k1=1.2`, `b=0.75` definiert, und FTS5 besitzt keine drop-in-äquivalente allgemeine Levenshtein-Fuzzy-Suche wie MiniSearch. Die Rangfolge wäre deshalb eine Produktänderung. [SQLite FTS5](https://www.sqlite.org/fts5.html)

**Tantivy** bietet nativen BM25, Boolean Queries, Feld-Boosts sowie Fuzzy- und Fuzzy-Prefix-Termqueries. Es ist auf Top-K-Suche, segmentierte Indizes und parallele Ausführung ausgelegt. Das macht Tantivy zum stärksten Kandidaten für einen lokalen Bake-off, aber nicht zum rangidentischen Austausch: Tokenisierung, Fuzzy-Semantik, BM25-Details und Query-Kombination müssen nachgebaut beziehungsweise neu kalibriert werden. Dazu kommen Rust-/N-API- oder Sidecar-Packaging für alle Plattformen. [Tantivy Queries](https://docs.rs/tantivy/latest/tantivy/query/index.html), [Tantivy FuzzyTermQuery](https://docs.rs/tantivy/latest/tantivy/query/struct.FuzzyTermQuery.html), [Tantivy QueryParser](https://docs.rs/tantivy/latest/tantivy/query/struct.QueryParser.html), [Tantivy Architecture](https://github.com/quickwit-oss/tantivy/blob/main/ARCHITECTURE.md)

Lucenes ausgereifte `FuzzyQuery` begrenzt Edit-Distanzen auf höchstens zwei und warnt, dass höhere Distanzen einen großen Teil des Termwörterbuchs matchen. Außerdem kann sie eine exakte gemeinsame Prefix-Länge und eine maximale Zahl von Expansionen verlangen. Das ist kein Beweis, dass Bastra dieselben Werte verwenden soll, aber ein starkes Indiz, dass bis zu sechs Edits für alle langen Terme eine aggressive Einstellung ist. [Apache Lucene FuzzyQuery](https://lucene.apache.org/core/7_7_3/core/org/apache/lucene/search/FuzzyQuery.html)

### 5.4 Andere Beschleuniger

**SymSpell** berechnet Delete-Varianten im Voraus und reduziert damit die Zahl teurer Wörterbuchvergleiche. Der Preis ist zusätzlicher Speicher, Indexaufbau und eine andere Kandidaten-/Distanzsemantik. Es ist ein möglicher Fuzzy-Kandidatengenerator, aber nur dann rangneutral, wenn die resultierende Termmenge und ihre Distanzen gegen MiniSearch vollständig äquivalent nachgewiesen werden. [SymSpell](https://github.com/wolfgarbe/SymSpell)

**Block-Max WAND** kann Top-K-Auswertung mit beweisbar sicherem Pruning beschleunigen. Das ist für große Postinglisten wertvoll. Bei Bastra zeigen die Messungen jedoch, dass Exact-Scoring nur 38–49 ms kostet und die hunderten Millisekunden vorher in Prefix/Fuzzy-Termexpansion entstehen. WAND wäre deshalb nicht der erste Hebel. [Block-Max WAND, SIGIR 2017](https://doi.org/10.1145/3077136.3080780)

## 6. Empfohlene Zielarchitektur

### 6.1 Nicht nach Zeichenlänge allein umschalten

Zeichenlänge korreliert mit Kosten, ist aber nur ein grober Proxy. Ein 2.000-Zeichen-Stacktrace mit vielen eindeutigen Pfaden kann teurer sein als 4.000 Zeichen Fließtext mit vielen Wiederholungen. Der Router sollte mindestens folgende billige Merkmale verwenden:

- emittierte und eindeutige Termzahl;
- Anteil von Identifiern, Pfaden, Dateiendungen, Hashes und quoted literals;
- Anteil OOV-Terme beziehungsweise sehr seltener Terme;
- mittlere/maximale Termlänge, weil sie die Fuzzy-Distanz beeinflusst;
- Verfügbarkeit und Warm-/Fehlerzustand des Embedding-Providers.

Aus der Telemetrie kann zunächst ein konservatives Kostenmodell gelernt werden, beispielsweise eine kleine lineare Schätzung für BM25-p90. Der volle lexikalische Arm wird nur gestartet, wenn seine vorhergesagte Laufzeit ins Budget passt.

### 6.2 Vier Betriebsarten

```text
Query einmal normalisieren und tokenisieren
│
├─ Dense verfügbar?
│  ├─ ja, voller BM25 voraussichtlich billig
│  │    → Hybrid: Dense + voller gruppierter BM25 im Worker
│  └─ ja, voller BM25 voraussichtlich teuer
│       → Dense primär + exakte lexikalische Identifier-Rettung
│
└─ Dense nicht verfügbar/fehlerhaft
   ├─ voller BM25 voraussichtlich billig
   │    → voller gruppierter BM25 im Worker
   └─ voller BM25 voraussichtlich teuer
        → gruppierter Exact/Prefix-Pass über den ganzen Prompt
          + gezieltes Fuzzy nur für wertvolle/OOV-Terme
```

#### Modus A: voller lexikalischer Arm

Für kurze, präzise Queries bleibt das heutige Verhalten inklusive Fuzzy und Prefix erhalten. Genau hier ist die Termzahl niedrig und BM25s Stärke bei exakten Bezeichnern am wertvollsten.

#### Modus B: voller Hybridarm

Auf einem embeddingsfähigen Rechner laufen Dense und der gruppierte BM25-Arm in getrennten Ausführungskontexten. Hybrid bleibt sinnvoll, solange der lexikalische Arm sein Budget voraussichtlich einhält.

#### Modus C: Dense-dominant plus Identifier-Rettung

Für teure lange Prompts wird der dichte Arm primär. Parallel läuft kein vollständiges Fuzzy über den Prompt, sondern eine kleine lexikalische Rettung für:

- vollständige Dateinamen und Pfadsegmente;
- Funktions-, Klassen-, Paket- und Config-Namen;
- Flags, Issue-IDs, Hashes, Versionen und quoted literals;
- exakte seltene Terme in stark gewichteten Feldern.

Die Rettung sollte zunächst exact arbeiten, optional mit begrenztem Prefix. Eine eigene Identifier-Postingmap kann deutlich billiger sein als ein allgemeiner MiniSearch-Aufruf. Ihr Zweck ist nicht, Prosa semantisch zu verstehen, sondern die 22/90 nachgewiesenen Vector-Fehlfälle der exakten Suchklasse abzufangen.

#### Modus D: schneller langer Lexikpfad ohne Dense

Auf schwächeren Rechnern kann die lange Query nicht an Dense delegiert werden. Hier ist die gemessene Kombination „gruppiert + exact/prefix“ der realistische Ausgangspunkt: p50 140 ms, p90 194 ms im isolierten lexikalischen Arm.

Fuzzy wird dann nur aktiviert, wenn es preislich und inhaltlich sinnvoll ist, zum Beispiel:

- bei kurzen Queries generell;
- für wenige OOV-Terme, die wie ein Identifier aussehen;
- für seltene, ausreichend lange Terme mit kleiner maximaler Edit-Distanz;
- als zweiter Pass nur dann, wenn der schnelle Pass keine hinreichende Evidenz erzeugt und noch Deadline-Budget übrig ist.

Das verändert das heutige Ranking. Es ist aber der einzige realistische Weg, auf einer BM25-only-Maschine lange Prompts in ungefähr 200 ms zu behandeln, solange kein nativer kompatibler Fuzzy-Executor existiert.

### 6.3 Retrieval und Einblendentscheidung trennen

RRF sollte weiterhin Ranglisten kombinieren dürfen, aber nicht mehr allein entscheiden, ob ein Memory `required` ist.

Die erste, nicht aufschiebbare Trennung ist typseitig: Eine nackte Zahl darf
nicht mehr wahlweise RRF oder rohes BM25 bedeuten. Mindestens nötig sind
`score_kind: "rrf" | "bm25"`, `retrieval_mode` und ein expliziter
`degraded_reason`. `unfused` darf auf keinem Transport oder in keiner Lane
verloren gehen. Auf `score_kind: "bm25"` dürfen RRF-Floors, RRF-Headlines und
der RRF-basierte REQUIRED-Backoff niemals angewendet werden.

Empfohlenes internes Evidenzmodell:

```text
retrieval_mode
score_kind, score_version
rank_bm25, raw_bm25
rank_vector, cosine, cosine_gap
exact_identifier_match
anchor_kind               # exact_identifier | exact_phrase | prefix | fuzzy | none
matched_field
document_frequency
provider_state, degraded_reason
rrf_score                 # nur wenn beide Arme vorhanden
```

Darauf folgt eine separate Admission-Entscheidung:

```text
required | optional | drop
```

Zunächst dürfen die Regeln pro Modus verschieden sein:

- Hybrid: bisheriger RRF-Wert als Übergangsregel.
- Dense-long: Vector-Rang plus Cosinus und Abstand zum nächsten Kandidaten.
- BM25-only: roher BM25-Wert, Rang und Matchfeld.
- Identifier-Rettung: exakter Match, Feldgewicht und Seltenheit.

Wenn später unbedingt eine gemeinsame Zahl benötigt wird, sollte sie eine auf gelabelten Daten kalibrierte Wahrscheinlichkeit wie `P(required)` sein, mit `score_version` und `retrieval_mode`. Einarmige RRF-Werte einfach zu verdoppeln ist keine Kalibrierung: Es würde einen Treffer aus einer Quelle künstlich mit der Übereinstimmung zweier unabhängiger Quellen gleichsetzen.

## 7. Vorschläge mit Preis und Vorabprüfung

| Vorschlag | Erwarteter Nutzen | Qualitätspreis | Speicher/Startzeit | Komplexität | Vor dem Ausliefern prüfen |
|---|---|---|---|---|---|
| Scoretyp und Degradation bis in jede Lane erhalten | verhindert falsches REQUIRED, falschen Backoff und irreführende Millionenscores | keiner; korrigiert bereits falsches Verhalten | keiner | niedrig–mittel | Hook/MCP mit erzwungenem Timeout/Providerfehler; kein RRF-Floor auf BM25; Response-Vertrag auf allen Transporten |
| `matched_recall_when` durch exakte Anchor-Provenienz ersetzen | verhindert Fuzzy-Falschpositive und Cross-Scope-Leaks | strengere Regel kann bisherige fuzzy Trigger verlieren; bewusst neu labeln | gering | mittel | `and`→`sand`, Prefix, Tippfehler, exakte Phrase, exakter Identifier, Cross-Scope und weak-result pro Treffer |
| Doppelte **verarbeitete** Query-Terme gruppieren, Häufigkeit über `boostTerm` | gemessen ca. 2,5×; p50 1.237 → 493 ms | keiner unter heutigen Optionen und korrektem `processTerm`; Rohgruppierung ist nicht neutral | praktisch keiner | mittel | alle vollständigen IDs/Ränge/Matchfelder identisch; Score-Toleranz ≤1e-7; Case-/Unicode-/Identifier-Property-Tests; Rohgruppierung als negativer Test |
| MiniSearch in einen Worker verschieben | Event Loop frei, echte Dense-Überlappung, kontrollierbare Queue | keiner bei gleichem Ergebnis | ein Index im Worker etwa heutiger Index; Start/IPC | mittel | p50/p90/p99 Gesamt, Event-Loop-Delay, Zeitpunkt des Ollama-Dispatch, Update- und Crash-Tests |
| Mehrere Term-Worker | theoretisch gruppierte p50/p90 durch 4 nahe 123/180 ms vor Overhead | keiner nur bei exakt gleicher Merge-Logik | bis ca. 600 MiB für vier Indexkopien plus Heaps | hoch | 1/2/4-Worker-Bake-off auf schwacher und starker Hardware; RSS, CPU-Konkurrenz zu Ollama, exakte Parität |
| Prefix/Fuzzy termabhängig machen | größter verbleibender JS-Hebel | Kandidaten und Ränge ändern; Typo-Recall kann sinken | gering | mittel | gelabelte Queryklassen, besonders Tippfehler und Identifier; Expansionen pro Term; false negatives |
| `maxFuzzy` auf 1–2 und/oder exakte Prefix-Länge | kann lange-Term-Explosion stark begrenzen | andere Fuzzy-Semantik | keiner | niedrig | Sweep nicht nur gegen aktuelle Ausgaben, sondern gegen Relevanzlabels; Edit-Distanz-Histogramm der echten Gewinne |
| Exact-Identifier-Rettungsindex | erhält lexikalische Stärke im Dense-long-Modus sehr billig | generische Identifier können false positives erzeugen | zusätzliche kleine Postingmap, etwas Startzeit | mittel | die 90 Identifier-Fälle plus echte Verkehrsstichprobe; Feld-/DF-Regeln; Präzision der Einblendungen |
| Getrennter kompakter Fuzzy-Index für `title`, `tags`, `recall_when`, `topic` und exact-only Body | viel kleineres Fuzzy-Wörterbuch | Body-Tippfehler verlieren Gewicht; Scores ändern sich | zweiter Index oder neue Indexaufteilung | mittel | Feld-Ablation: welche injizierbaren/gelabelten Treffer kommen ausschließlich fuzzy aus Body/Summary? |
| SQLite-FTS5-Prototyp | nativer Exact/Prefix-BM25, persistenter kleiner Index | Ranking und Fuzzy nicht kompatibel | Disk-Index; Binding/Runtime abhängig | mittel–hoch | gleicher Tokenizer und sieben Felder; Latenz, RSS, Start, Kandidaten-Recall; Fuzzy-Lücke explizit messen |
| Tantivy-Prototyp | stärkster Kandidat für schnellen nativen BM25/Fuzzy-Top-K-Pfad | Ranking nicht automatisch identisch | persistenter Index; native Binaries | hoch | lokaler Bake-off gegen MiniSearch auf langen Prompts, Identifiern und Tippfehlern; Plattformmatrix |
| SymSpell als Fuzzy-Kandidatengenerator | mögliche massive Beschleunigung der Termsuche | Distanz-/Kandidatenabweichungen möglich | mehr Indexspeicher und Bauzeit | hoch | für jedes Query-Term exakte Gleichheit der MiniSearch-Expansionen und Distanzen beweisen, erst dann Rankingtest |
| Block-Max WAND/sicheres Top-K-Pruning | später nützlich bei viel größerem Vault | bei korrekter Implementierung keiner | Zusatzstatistiken | sehr hoch | erst profilieren, ob Postings-Scoring nach Expansion relevant wird; derzeit nicht der Engpass |
| Ollama `keep_alive` erhöhen | vermeidet kalte Modellstarts | keine Retrievaländerung | Modell bleibt länger in RAM/VRAM | niedrig | getrennte warm/cold Latenzen und RAM-Budget; Provider-Ausfall |
| Embedding-Dimension 768 → 256/128 | weniger Vektorspeicher und schnellerer Cosinus-Pass | möglicher Recall-Verlust; vollständiges Re-Embedding | Vektorspeicher sinkt, Modell-RAM kaum | mittel | Dense-Rank-Recall und Cosinuslatenz messen; nicht erwarten, dass Modellinferenz proportional schneller wird |
| Query-/Expansion-Cache ausbauen | schnell bei echten Wiederholungen | keiner bei korrekter Invalidierung | unbeschränkt riskant | mittel | reale Hit-Rate und Speicherwachstum messen; aktueller Expansionstest zeigte nur ca. 10 % Zusatzgewinn |

## 8. Konkrete Reihenfolge für Claude Code

### P0: Score-Space und Anchor-Ehrlichkeit reparieren

Diese Phase steht vor jeder Optimierung. Performanceänderungen können die
Timeout-Rate senken, aber Ollama kann weiterhin fehlen, ausfallen oder langsam
sein; der Fallback muss für sich korrekt sein.

1. `unfused` und `degraded` in `prompt-lane.ts` in den Response-Typ aufnehmen
   und bis Filter, Backoff, Formatter und Telemetrie durchreichen.
2. Einen expliziten `score_kind`/Retrievalmodus in den gemeinsamen Hit- oder
   Response-Vertrag aufnehmen. Kein Caller darf den Modus aus der Höhe der Zahl
   erraten.
3. Für unfused BM25 eine eigene Admission und Wortwahl verwenden. Bis diese
   kalibriert ist, darf rohes BM25 nicht automatisch REQUIRED werden und keinen
   RRF-basierten Backoff-Bypass erhalten.
4. Alle Recall-Oberflächen auditieren. `write-lane.ts` kennt `unfused` bereits;
   die Prompt-Lane tut es nicht. Auch `recall-handler.ts` muss eine während des
   Calls eintretende Degradation erkennen statt nur den Providerzustand vor dem
   Call zu betrachten.
5. `matched_recall_when` nicht mehr aus der unspezifischen MiniSearch-`match`-
   Map ableiten. Exakte/Fuzzy/Prefix-Provenienz getrennt erfassen.
6. Cross-Scope-Bypass nur für einen exakten starken Anchor erlauben. Eine
   plausible Startregel ist: exakter seltener Identifier oder zwei
   signifikante exakte Tokens derselben authored Phrase.
7. `weak_result`/`no_home` pro Trefferprovenienz prüfen; ein einzelnes
   fragwürdiges Listenmitglied darf nicht die gesamte Liste gesund erklären.

Pflicht-Regressionen:

- erzwungener Vector-Timeout: Response `score_kind=bm25`, `unfused=true`, kein
  RRF-REQUIRED und keine „beide Pfade“-Aussage;
- gleiche Query mit 150-ms-Hook- und 1.500-ms-MCP-Deadline;
- Query `and` gegen `recall_when: sand theme`: BM25 darf fuzzy treffen, aber
  `deliberate anchor` muss false bleiben;
- exakte Phrase und exakter Identifier müssen den vorgesehenen Anchor setzen;
- Provider nicht installiert, Providerfehler und leerer Vector-Index.

Akzeptanzkriterium: keine Score-Space-Verwechslung auf irgendeiner Oberfläche,
keine Fuzzy-/Prefix-Evidenz als absichtlicher Cross-Scope-Anker.

### Phase 0: Mess- und Qualitätsgrundlage

Noch keine Retrievaländerung ausliefern.

1. Das bestehende Harness `npm run bm25-expansion --workspace @bastra-recall/eval` um Querykosten-Merkmale ergänzen:
   - emittierte/eindeutige Terme;
   - Identifier-, OOV- und Termlängenanteile;
   - Zahl der Prefix- und Fuzzy-Expansionen pro Term;
   - tatsächliche erlaubte Edit-Distanz;
   - Zeit getrennt nach Tokenisierung, Expansion, Posting/Scoring, Sortierung und Damping.
2. `monitorEventLoopDelay()` oder gleichwertige Telemetrie um den Recall-Aufruf ergänzen.
3. Beim dichten Arm Ollama-Dispatch, Modell-Ladezeit, `prompt_eval_count`, gesamte Dauer, Timeout und Providerfehler getrennt erfassen.
4. Nach dem P0-Fix sicherstellen, dass Timeout/Degradation nicht nur in der
   Recall-Telemetrie, sondern auch in der konsumierenden Lane sichtbar bleibt.
   Ein stiller leerer Recall darf nicht dasselbe Ereignis sein wie „ehrlich
   keine relevanten Treffer“.
5. Qualitätsset aus der **Vereinigung** folgender Kandidaten bauen:
   - Vector Top 20 oder Top 50;
   - BM25 Top 20 oder Top 50;
   - aktuell injizierte Treffer;
   - Identifier-Rettungskandidaten;
   - einige Kandidaten direkt unter den heutigen Floors.
6. Kandidaten mit `required`, `optional`, `irrelevant` labeln. Nach Queryklassen und ganzen Sessions/Projekten in Train/Validation trennen, nicht zufällig einzelne Treffer derselben Session verteilen.

Akzeptanzkriterium: Messungen unterscheiden Retrieval-Latenz, Event-Loop-Blockade, Provider-Timeout und echte Abwesenheit; Qualitätsbewertung ist nicht mehr nur „gleich wie Produktion“.

### Phase 1: rangneutrale Arbeit

1. Query genau einmal mit dem produktiven Identifier-Tokenizer tokenisieren.
2. **Danach exakt dieselbe `processTerm`-Funktion wie der Index anwenden**, ihre
   Array-Rückgaben gegebenenfalls flatten und leere Ergebnisse verwerfen.
3. Erst in diesem verarbeiteten Termraum Häufigkeiten bilden. Niemals
   Groß-/Kleinschreibung erhaltende Rohterme gruppieren.
4. Jeden eindeutigen verarbeiteten Term einmal suchen, zweites Tokenisieren/
   Verarbeiten unterbinden und die Wiederholungswirkung über `boostTerm`
   erhalten. Der Code aus Abschnitt 4.5 ist die Referenz.
5. Vollständige Parität von Kandidatenmenge, IDs, Reihenfolge, Scores,
   `terms`, `queryTerms`, Matchfeldern, Anchor-Provenienz und RRF-Rangpaaren
   testen. Score-Toleranz höchstens in der beobachteten Float-Größenordnung;
   2,553 Millionen Differenz ist der negative Kontrollfall.
6. Regressionen mit Case-Kollisionen (`AND`, `and`), Unicode-Lowercasing,
   wiederholten Identifierteilen und Termen, die nach `processTerm` auf
   denselben Key fallen, hinzufügen.
7. Danach MiniSearch vollständig in einen langlebigen Worker verschieben. Der Worker besitzt den Index und erhält Vault-Add/Change/Remove-Ereignisse.
8. Queue begrenzen, Request-IDs verwenden und verspätete Resultate verwerfen. Crash und Index-Rebuild testen.

Erwartung aus dem bestätigten Gegenlauf: ungefähr 493/719 ms lexikalisch auf
den gemessenen langen Prompts, aber ein reaktionsfähiger Daemon und echte
Dense-Überlappung. **Diese Phase allein erreicht 200 ms nicht.**

### Phase 2: Suchrouter und mode-spezifische Admission im Shadow-Modus

1. Billiges Query-Kostenmodell auf Telemetriedaten bauen.
2. Die vier Modi aus Abschnitt 6 zunächst nur als Shadow-Entscheidung berechnen. Produktion liefert weiterhin den bisherigen Pfad aus.
3. Für Dense-long Vector Top 20/50 plus exakte Identifier-Rettung aufzeichnen.
4. Für Lexical-long gruppiertes Exact+Prefix plus kontrollierte Fuzzy-Varianten aufzeichnen.
5. Pro Modus Admission-Regeln gegen menschliche Labels kalibrieren.
6. Besonders prüfen:
   - lange Prosa;
   - lange Code-/Log-Prompts mit wichtigem Identifier am Anfang, in der Mitte und am Ende;
   - kurze exakte Datei-/Funktionsnamen;
   - ein Tippfehler in einem Identifier;
   - mehrere ähnlich benannte Memories;
   - Ollama kalt, nicht installiert, fehlerhaft und zu langsam.

Ship-Gate: kein statistisch oder praktisch relevanter Verlust bei `required`-Recall auf dem Holdout; Einblendpräzision mindestens Status quo; keine stillen Ausfälle.

### Phase 3: schneller BM25-only-Pfad

1. Gruppiert Exact+Prefix als Basis für lange teure Queries messen.
2. Fuzzy-Policy als Matrix testen:
   - nur kurze Query;
   - nur OOV;
   - nur Identifier;
   - Distanz maximal 1 oder 2;
   - Fuzzy nur in hoch gewichteten Feldern;
   - zweiter Pass nur bei niedriger Evidenz und Restbudget.
3. Eine kleine exakte Identifier-Postingmap gegen MiniSearch-Exact vergleichen.
4. Admission nicht aus dem veränderten BM25-Rang in einen alten RRF-Floor pressen, sondern lexical-mode-spezifisch entscheiden.

Zielkorridor aus der heutigen Messung: lexikalischer p50 ≤150 ms und p90 ≤200 ms warm; End-to-End p90 inklusive IPC und Lane-Logik separat ausweisen.

### Phase 4: nativer Bake-off nur wenn Phase 3 nicht genügt

Tantivy, SQLite FTS5 und gruppiertes MiniSearch gegeneinander testen. Kein großer Umbau vor dem Bake-off.

Minimaler Prototyp muss abbilden:

- produktiven Dual-Identifier-Tokenizer;
- alle sieben Felder und Gewichte;
- OR-Semantik;
- Exact, Prefix, Fuzzy;
- Top 50;
- inkrementelle Adds/Changes/Removes;
- persistenter Neustart;
- alle Filter und nachgelagerte Dämpfung unverändert.

Auswahlkriterien in dieser Reihenfolge:

1. `required`-Recall und Präzision auf gelabeltem Holdout;
2. p50/p90/p99 auf langen und kurzen Queryklassen;
3. RSS auf schwacher Hardware;
4. Start-/Reindexzeit;
5. macOS/Linux/Windows-Packaging und Update-Sicherheit;
6. Wartungskomplexität.

## 9. Messplan und SLO

„200 ms pro Aufruf“ muss operationalisiert werden. Empfohlen:

| SLO | Aussage |
|---|---|
| warm p50 ≤ 200 ms | unmittelbares UX-Ziel auf typischer Hardware |
| warm p90 ≤ 250 ms, später ≤ 200 ms | verhindert, dass nur der Median schön ist |
| p99/deadline explizit | kalte Modelle und Ausreißer dürfen nicht still verschwinden |
| Event-Loop-Delay p99 < 25 ms während Recall | Daemon bleibt reaktionsfähig, auch wenn Worker noch rechnet |
| 0 stille Abwesenheiten | Timeout, Providerfehler und „keine Treffer“ sind unterscheidbar |

Jede Benchmark-Zeile sollte zusätzlich ausweisen:

- Hardware, Node-, MiniSearch-, Ollama- und Modellversion;
- Vaultgröße, Vokabulargröße, Vektordimension;
- Promptzeichen, Modelltoken, emittierte/eindeutige Terme;
- warm/kalt, Cache hit/miss;
- Retrievalmodus und Providerzustand;
- p50, p90, p99 statt nur Median;
- RSS, CPU-Zeit, Event-Loop-Delay und Startzeit;
- Qualitätsmetriken je Queryklasse.

## 10. Was nicht empfohlen wird

- **Performance vor Score-Space-Ehrlichkeit ausliefern.** Weniger Timeouts
  verstecken den Fehler nur; BM25-only und Provider-Ausfall bleiben.
- **Unfused BM25 mit RRF 50/100 banding.** Der rohe Score ist offen und kann
  Millionen erreichen.
- **Unfused Scores durch ungefähr 4.900 teilen oder bei 164 deckeln.** Der
  beobachtete Faktor ist nicht konstant und die Ranglisten sind verschieden.
- **Termhäufigkeiten direkt nach `tokenizeWithIdentifiers` bilden.** Das wurde
  mit 0/30 identischen Vollrankings widerlegt; erst `processTerm`, dann zählen.
- **Jeden Match im Feld `recall_when` als absichtliche Phrase behandeln.**
  Prefix/Fuzzy kann `and` auf `sand` abbilden.
- **BM25 vollständig abschalten.** Der Identifier-Stress-Test widerlegt das.
- **Nur nach Zeichenlänge umschalten.** Termzahl und Queryform erklären die Kosten besser.
- **Die 42 heutigen Hybridtreffer als vollständiges Goldset verwenden.** Die Auswahl setzt Vector-Beteiligung mathematisch voraus.
- **Einarmigen RRF-Score verdoppeln.** Das erfindet eine Übereinstimmung zweier Arme.
- **Erneut blind Queryterme abschneiden.** Das wurde bereits mit echten Verlusten widerlegt.
- **Von einem Worker siebenfachen Speedup erwarten.** Er löst Event-Loop und Überlappung, nicht den Algorithmus.
- **Vier vollständige MiniSearch-Worker als Standard für schwache Rechner bauen.** Speicher- und CPU-Kosten widersprechen dem Produktziel.
- **Sofort auf einen nativen Index migrieren.** Erst einen kleinen lokalen Bake-off; Rang- und Packagingkosten sind real.
- **Fuzzy-Caches unbegrenzt wachsen lassen.** Die gemessene Wiederverwendung war zu klein.
- **Nur Median messen.** Dense-only liegt schon bei 175 ms Median; ein scheinbar erreichtes 200-ms-Ziel kann trotzdem viele Timeouts haben.

## 11. Endempfehlung

Claude Code sollte nicht mit einem großen Indexwechsel beginnen. Die sinnvollste Abfolge ist:

1. **P0: Score-Space-Leak und falsche Anchor-Provenienz beheben.**
2. **Termgruppierung nach `processTerm` als nachweislich rangneutrale Beschleunigung; Rohterm-Gruppierung ausdrücklich nicht verwenden.**
3. **Ein Worker als Stabilitäts- und Nebenläufigkeitsmaßnahme.**
4. **Ehrliche Telemetrie und ein gelabeltes Kandidaten-Union-Set.**
5. **Kostenbasierter Router mit vollem BM25 für kurze/exakte Queries, Dense plus Exact-Rescue für lange Queries auf starken Rechnern und Exact/Prefix plus gezieltem Fuzzy für lange Queries auf BM25-only-Rechnern.**
6. **RRF dauerhaft von der Admission-Entscheidung entkoppeln.**
7. **Nur wenn der BM25-only-Pfad danach das p90-Ziel verfehlt: Tantivy als ersten nativen Bake-off, SQLite FTS5 als einfacheren Exact/Prefix-Vergleich.**

Die unbequeme, aber wichtige Grenze lautet: **Exakt das heutige Full-Fuzzy-Ranking für ungefähr 1.000 Query-Terme auf einem einzelnen MiniSearch-Thread in 200 ms zu reproduzieren ist mit den vorliegenden Messungen nicht realistisch.** Die korrekt normalisierte Termgruppierung bewahrt dieses Ranking und halbiert bis drittelt die Kosten, kommt allein aber nur auf ungefähr 493/719 ms. 200 ms werden realistisch, wenn Bastra die teure Fuzzy-Arbeit nach Queryklasse bezahlt und die Einblendentscheidung nicht länger an eine je nach Modus anders bedeutende nackte Score-Zahl bindet.

## 12. Quellen

Primärquellen und offizielle Dokumentation:

- [MiniSearch Repository und Dokumentation](https://github.com/lucaong/minisearch)
- [MiniSearch Quellcode (`MiniSearch.ts`)](https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts)
- [MiniSearch Design Document](https://github.com/lucaong/minisearch/blob/master/DESIGN_DOCUMENT.md)
- [MiniSearch Changelog](https://github.com/lucaong/minisearch/blob/master/CHANGELOG.md)
- [Node.js Worker Threads](https://nodejs.org/api/worker_threads.html)
- [Ollama Embed API](https://docs.ollama.com/api/embed)
- [Ollama OpenAPI-Spezifikation](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml)
- [Google EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [Tantivy Query-Modul](https://docs.rs/tantivy/latest/tantivy/query/index.html)
- [Tantivy FuzzyTermQuery](https://docs.rs/tantivy/latest/tantivy/query/struct.FuzzyTermQuery.html)
- [Tantivy QueryParser](https://docs.rs/tantivy/latest/tantivy/query/struct.QueryParser.html)
- [Tantivy Architecture](https://github.com/quickwit-oss/tantivy/blob/main/ARCHITECTURE.md)
- [Apache Lucene FuzzyQuery](https://lucene.apache.org/core/7_7_3/core/org/apache/lucene/search/FuzzyQuery.html)
- [SymSpell](https://github.com/wolfgarbe/SymSpell)
- [Block-Max WAND, SIGIR 2017](https://doi.org/10.1145/3077136.3080780)

---

## 13. Nachtrag: Gegenprüfung durch Claude Code (25.08.2026)

Alle drei Kernbefunde wurden am Code und am echten Vault nachgeprüft, bevor
gebaut wurde. Ergebnis: zwei bestätigt, einer mit korrigierter Begründung.

**Termgruppierung — bestätigt.** Ein erster Nachbau ohne `processTerm` ergab
0/30 identische Ranglisten; mit dem Fix aus dieser Übergabe (erst falten, dann
zählen) sind es 30/30 bei maximal 1,77 × 10⁻⁸ Abweichung, gemessen 1100 → 441 ms
p50 über 30 echte Prompts. Die Reihenfolge `processTerm` vor Gruppierung ist
damit nicht Stilfrage, sondern die Bedingung, unter der die Aussage überhaupt
gilt.

**Score-Space-Leak — bestätigt, mit einem Zusatz.** `write-lane.ts:91` führt
`unfused` bereits im Response-Typ und reicht es an den Formatter durch; die
Prompt-Lane kannte das Feld nicht. Die Lücke war also an einer Oberfläche
längst geschlossen und an der anderen offen — was den Fund von einer Theorie zu
einer nachweisbaren Inkonsistenz macht.

**`matched_recall_when` — Mechanismus bestätigt, Beispiel widerlegt.** Die Query
`and` trifft `sand` NICHT: Bei drei Zeichen expandiert MiniSearch mit
`fuzzy: 0.2` nicht, die Query liefert gegen den echten Vault null Treffer. Der
Fehler existiert trotzdem, nur eine Wortlänge höher — gemessen setzten
`obsidan` (ein Edit) und `tripwir` (ein Präfix) das Flag auf Memories, deren
`recall_when` diese Wörter nie enthielt. Die Pflicht-Regression in §8/P0 sollte
entsprechend auf ein Wort ab ~5 Zeichen umgestellt werden.

### Was daraufhin gebaut wurde (P0, Punkte 1–5 und 7)

- `matchedRecallWhen()` vergleicht gegen die tokenisierten, gefalteten
  Query-Terme. Prefix- und Fuzzy-Evidenz setzt den Anker nicht mehr; damit
  greifen Cross-Scope-Bypass (`hook-skip.ts`) und `weak_result`-Unterdrückung
  (`weak-result.ts`) nur noch auf exakter Autorenabsicht.
- `unfused` und `degraded` sind im Response-Typ der Prompt-Lane, werden an
  Backoff, Formatter und Telemetrie durchgereicht.
- Ohne Fusion: kein REQUIRED-Band, kein Backoff-Bypass, keine „beide
  Suchpfade"-Aussage, und die Punktzahl wird nicht mehr gezeigt — auf einer
  offenen Skala lädt sie zu einem Vergleich ein, den sie nicht trägt.

Punkte 2, 4 und 6 sind inzwischen ebenfalls gebaut: `score_kind` (`"rrf"` |
`"bm25"`) steht neben `unfused`/`degraded` im Antwortvertrag; der Handler liest
die Degradation aus derselben `done`-Stage, die die Hook-Route schon auswertete,
statt aus dem Breaker-Zustand vor dem Call; und `anchor_strength` gradiert den
Anker nach der Regel, die `reflex.ts` seit dem 20.08.-Vorfall verwendet — zwei
exakte Trigger-Terme oder einer, dessen Document-Frequency ihn für sich sprechen
lässt. Der Cross-Scope-Bypass verlangt `"strong"`; fehlt das Feld, bleibt es beim
alten Verhalten, damit ein älterer Daemon nicht still strenger wird.

Damit ist P0 abgeschlossen. Offen bleiben Phase 0 (Messgrundlage und gelabeltes
Qualitätsset) und Phase 1 (Termgruppierung, Worker) — beide unverändert wie
oben beschrieben.

---

## 14. Umsetzung des Plans (25.08.2026, Claude Code)

### Gebaut und gemessen

**Phase 1 — Termgruppierung.** Gebaut wie beschrieben, mit `processTerm` VOR
dem Zählen und einem Identitäts-Tokenizer für die gruppierte Query.
Rangneutralität ist als Test festgenagelt, nicht nur gemessen: gruppiert und
ungruppiert müssen über einen echten Index dieselbe Rangliste liefern,
inklusive Reihenfolge.

Produktionspfad, 30 echte Prompts, 991 Memories:

| | vorher | nachher |
|---|---:|---:|
| lexikalischer Arm p50 | 1137 ms | **461 ms** |
| Gesamtaufruf p50 | 1327 ms | **689 ms** |

Live gegen den laufenden Daemon, echter 7962-Zeichen-Prompt (1296 emittierte,
768 eindeutige Terme): **651 ms** gesamt.

**Phase 0 — Messgrundlage.** `terms_emitted` / `terms_unique` auf beiden
Recall-Oberflächen (Hook und MCP, über einen gemeinsamen Typ, damit die Listen
nicht auseinanderlaufen) und `event_loop_block_ms` um den Recall-Aufruf.
`score_kind`, `unfused` und `degraded` sind bereits in P0 gelandet. Das
Kandidaten-Union-Werkzeug für das gelabelte Set steht als
`npm run candidate-union --workspace @bastra-recall/eval`.

**Phase 2 — Router im Schatten.** `routeRetrieval()` entscheidet an den
geschätzten Kosten (`terms_unique`, nicht Zeichen) und an der Verfügbarkeit des
dichten Arms. Die Entscheidung wird als `shadow_route` in die Telemetrie
geschrieben und ändert nichts. Live auf dem 7962-Zeichen-Prompt: `dense-primary`,
geschätzt 584 ms gegen tatsächlich gemessene 644 ms — die Schätzung liegt 10 %
daneben und ist damit für eine Budget-Entscheidung brauchbar.

**Phase 3 — schneller Lexikpfad.** `bm25_no_fuzzy` liefert exact + prefix ohne
Expansion, default aus, mit einem Test, der den Preis explizit macht: Der
Tippfehler findet sein Memory nicht mehr.

### Nicht gebaut: der Worker — und warum

Der Plan begründet ihn mit der Event-Loop-Blockade. Die ist real und jetzt
gemessen: auf dem 7962-Zeichen-Prompt 638 ms, bei einem dichten Arm, der
646 ms meldet — er verbringt also praktisch seine gesamte Zeit damit, auf den
synchronen lexikalischen Arm zu warten, statt neben ihm zu laufen.

Nur folgt daraus nicht der erwartete Gewinn. Die Wanduhr liegt bereits bei
`max(BM25, Dense)`, weil der dichte Arm nur ~150 ms echte Arbeit hat und BM25
ihn dominiert. Über 22 aufgezeichnete Aufrufe:

| bm25 | vector | total | `max(bm25, 150)` | Gewinn eines Workers |
|---:|---:|---:|---:|---:|
| 644 | 646 | 651 | 644 | **7 ms** |
| 43 | 154 | 161 | 150 | 11 ms |
| 13 | 84 | 87 | 150 | negativ |
| 5 | 76 | 79 | 150 | negativ |

Dem stehen ein async-Umbau durch sieben Produktionsdateien gegenüber —
`schema.ts`, `search.ts`, `bridge.ts`, `documents-handler.ts`,
`http-hook-routes.ts`, `recall-handler.ts`, `save-quality.ts`, letztere im
Save-Pfad hinter dem Claim-Gate — plus Queue, Request-IDs, Crash- und
Rebuild-Pfad.

Der Worker löst also nicht die Latenz DIESES Aufrufs, sondern die
Reaktionsfähigkeit des Daemons für PARALLELE Anfragen. Das ist ein echter, aber
anderer Nutzen als der, mit dem er im Plan steht. Vorgelegt statt gebaut — die
Entscheidung gehört zu den Zahlen, und die gab es vorher nicht.

### Weiterhin offen

Das **Labeln** des Kandidaten-Sets. Das Werkzeug baut die Vereinigung
(dichter Arm, lexikalischer Arm, heute eingeblendet, knapp unter dem Floor,
exakte Identifier) und schreibt ein Arbeitsblatt mit `label: null` — die Labels
selbst kann niemand erzeugen, der die Antwort nicht kennt. Solange sie fehlen,
bleibt der Router im Schatten und Phase 3 eine Option, kein Standard: Beide
verschieben Ränge, und die Einblendschwelle sitzt auf einem rangabgeleiteten
Score.

---

## 15. Gegenprüfung durch Codex und die vier Korrekturen (25.08.2026)

Vier Befunde, alle nachvollzogen, alle umgesetzt. Zwei davon waren echte Fehler
im gebauten Code.

**1. Die Budgetrechnung addierte, obwohl die Arme überlappen.** `56c7358` sendet
den dichten Arm vor BM25 ab; die Wanduhr ist damit `max(BM25, Dense)` plus 3–7 ms
Overhead, nicht die Summe. `lexicalFitsBudget()` zog trotzdem die Dense-Reserve
vom Budget ab und ließ BM25 nur 50 der 200 ms — der Router wäre im interessanten
Mittelfeld unnötig früh auf `dense-primary` gegangen und hätte dort lexikalische
Qualität für eine Zeit verschenkt, die gar nicht anfällt. Korrigiert auf `max()`.

**2. Die Event-Loop-Sonde verpasste ausgerechnet den schlimmsten Fall.** Ohne
Embeddings läuft `search.recall()` durchgehend synchron; der Timer bekam bis zum
`clearInterval` nie eine Gelegenheit zu feuern und meldete 0 — vollständige
Blockade sah aus wie gar keine. Jetzt fällt die Messung in diesem Fall auf
`bm25_search_ms` zurück und sagt über `event_loop_block_source`, woher die Zahl
stammt.

**3. Die Ankerschwelle war zu großzügig, und die Begründung stimmte nicht.**
Nachgemessen am Vault (992 Memories): 8946 distinkte authored Trigger-Terme,
davon **7580 unter `df <= 40`** — 85 % der distinkten Terme, 36 % der Vorkommen,
DF-Median 6. Die Schwelle beschrieb die Regel, nicht die Ausnahme. Zudem zählt
`docFreq()` Feld-Dokument-Paare über sieben Felder, nicht distinkte Memories;
die alte Kommentarbegründung „~4 % der Memories" war schlicht falsch.

Neu, und näher an dem, was `reflex.ts` seit dem 20.08.-Vorfall tut:

- zwei exakte Terme aus **derselben** authored Phrase (vorher genügte das flach
  zusammengefügte Feld, also zwei zufällige Wörter aus zwei unabhängigen
  Situationen — Statistik, keine Absicht), **oder**
- ein exakter Term, der wie ein Bezeichner aussieht **und** `df <= 5`.

Die Identifier-Prüfung musste dabei umgeschrieben werden: Terme kommen bereits
durch `processTerm` gefaltet an, `NSHostingController` ist zu dem Zeitpunkt
`nshostingcontroller` — camelCase ist als Kriterium strukturell blind. Was den
Tokenizer überlebt, sind Trenner, Ziffern und die Länge.

Die `5` ist eine konservative Setzung, keine kalibrierte Zahl, und steht so auch
im Code. Der Preis ist bewusst gewählt: Eine legitime Cross-Project-Erinnerung an
einem einzelnen natürlichen Wort kommt nicht mehr durch. Bei einem Bypass ist
diese Richtung die billigere.

**4. Dem Kandidaten-Set fehlten Quellen — und dann waren es zu viele.** Ergänzt
sind der schnelle Lexikpfad als eigener Modus, die Randzone unter dem Floor von
30 aus dem tiefen Pool, und eine deterministische Kontrollstichprobe aus dem
Vault, die kein Retriever vorgeschlagen hat. `injected-today` heißt jetzt
`above-inject-floor`, weil danach noch Scope-Filter, `weak_result`, Backoff und
Session-Dedup kommen.

Der erste Lauf mit allen Quellen ergab 1305 Kandidaten — 109 je Query, ein
Arbeitsblatt, das niemand labelt. Die Randzone ist deshalb auf die fünf
Kandidaten direkt unter dem Floor begrenzt. Ebenso war die Exklusiv-Statistik
falsch gerechnet: gegen ALLE Provenienzen fiel sie auf 2 und 0 zusammen, weil
`below-floor` fast jeden Kandidaten mit einsammelt. Gerechnet wird jetzt gegen
die Arm-Quellen.

Stand des Sets: **788 Kandidaten über 12 Queries (66 je Query)** — 164 nur vom
dichten Arm, 442 nur von einem lexikalischen Modus, 106 von keinem Retriever
(Randzone plus Kontrolle). Die letzte Zahl ist der gemeinsame blinde Fleck, den
ohne die Kontrollstichprobe niemand sehen könnte.

### Was aus der Gegenprüfung offen bleibt

- `estimateBm25Ms()` ist an zwei Punkten kalibriert und trifft sie nur grob
  (25 Terme: 27 geschätzt / 43 gemessen; 768: 584 / 644). Für den Schatten
  reicht das; vor einer Aktivierung gehören einige hundert Aufrufe über
  Termzahl-Bänder gesammelt, p90 statt Mittelwert vorhergesagt und eine
  Unsicherheitszone eingeführt, in der nicht umgeschaltet wird.
- Die Queryklassen im Set sind nach Länge gestreut, nicht nach Art. Kurze
  Identifier, Dateinamen, Tippfehler und BM25-only sollten explizit vertreten
  sein, bevor jemand daraus ein Ship-Gate ableitet.
- Der Worker bleibt zurückgestellt. Nächster sinnvoller Test dafür ist nicht die
  Einzellatenz, sondern „langer Recall, 10 ms später ein kurzer" — dort zeigt
  sich, ob die Blockade Queue- oder Timeout-Schäden verursacht.

---

## 16. Zweite Gegenprüfung: Zählfehler und Statistikaussagen (25.08.2026)

**Der Anker zählte Emissionen statt Terme.** Die Zweierregel lief über die
flache Tokenliste einer Phrase — also über die Dual-Emission des Tokenizers.
`recall_when: "foo bei foo"` zählte `foo` zweimal, und ein einzelnes `my-app`
erfüllte über seine Teile `my-app`/`my`/`app` die Zweierregel im Alleingang und
umging damit die df-Bedingung vollständig. Gezählt werden jetzt distinkte
Wörter der Rohphrase, jedes höchstens einmal.

**„Signifikant" war nie umgesetzt** — zwei Füllwörter derselben Phrase ergaben
`strong`. Es gilt jetzt dieselbe Stoppwort- und Mindestlängenregel wie im
Reflex-Pfad; die Liste wurde dafür nach `packages/core/src/stopwords.ts`
gezogen, statt sie zu kopieren.

**Rarität und Identifier-Form maßen das Falsche.** `docFreq()` summiert über
sieben Felder — ein Term, der in fünf Triggern und zehn Bodies steht, riss die
Schwelle, obwohl er als Trigger selten ist (607 solcher Fälle gemessen). Es gibt
jetzt `recallWhenDocFreq()`: eine beim Indizieren gepflegte Zählung distinkter
Memories mit dem Term in `recall_when`. Und die Identifier-Prüfung läuft auf der
ROHEN Phrase statt auf dem gefalteten Term — `NSHostingController` ist damit
wieder als Bezeichner erkennbar. Die Längenregel `>= 12` ist ersatzlos raus: Im
Deutschen sind lange natürliche Wörter normal, 646 Terme hingen allein an ihr.
An ihre Stelle tritt die Groß-/Kleinschreibungsform.

Die gepflegte Zählung ist die Stelle, an der so etwas später still driftet, und
sie ist entsprechend festgenagelt: ein Test über add → change → change zurück →
remove → doppeltes remove. Ein vergessenes Aufräumen ließe Terme dauerhaft als
häufiger gelten, ein doppeltes Abziehen als seltener — beides ändert lautlos,
welches fremde Memory sich einmischen darf.

**Zwei Statistikaussagen waren zu stark.** Die „von keinem Retriever gefunden"
enthielten Near-Miss-Kandidaten aus dem Hybrid-Pool — die wurden sehr wohl
gefunden, nur nicht in den ausgewerteten Top 20. Getrennt in „außerhalb der
ausgewerteten Arm-Tiefe" und „von keinem Retriever vorgeschlagen".

**Die Kontrollstichprobe war weder zufällig noch scope-kompatibel** — sie zog
für jede Query fast dieselben Memories nach Vault-Reihenfolge. Jetzt
query-gehasht und gegen den Projekt-Scope gefiltert, mit einem markierten
Fallback (`random-control-unscoped`), falls die Projekterkennung scheitert:
Er verwässert die Stichprobe nicht mehr still, sondern ist beim Auswerten
sichtbar. Gemessen greift er bei 0 von 4 Queries.

**Das Arbeitsblatt ist jetzt blind.** Score, Rang unter dem Floor und Abstand
zur 30 wandern in eine separate `*.meta.json`; das Labelblatt trägt nur id,
Titel, Provenienz und das leere Label, je Query deterministisch gemischt. Wer
beim Labeln die Zahl sieht, labelt die Zahl. Die Randbreite ist auf 10
angehoben und über `--below-floor-margin` steuerbar — die Ränge 6–10 liegen
damit im Set, ohne im Blatt unterscheidbar zu sein, und die Frage „reichen
fünf?" ist nachträglich beantwortbar.

### Korrektur einer eigenen Formulierung

„Sobald BM25 den dichten Arm überholt, kippt der Router" war ungenau. Bei einem
Budget von 200 ms und 7 ms Overhead darf der lexikalische Arm bis ~193 ms
kosten; zwischen 150 und 193 ms bleibt Hybrid richtig. Die Formel war korrekt,
der Satz nicht.

### Weiterhin offen

`ANCHOR_RARE_DF_MAX = 5` ist auch nach der Korrektur eine Setzung ohne Labels —
jetzt immerhin gegen die richtige Größe gemessen. Ob 5 zu streng oder zu locker
ist, entscheidet erst ein Sweep gegen die gelabelten einwortigen
Cross-Scope-Fälle. Dasselbe gilt für die Signifikanzregel, die bewusst vom
Reflex-Pfad übernommen und nicht neu kalibriert wurde.

---

## 17. Dritte Gegenprüfung: Schreibweisen, Erkennung, Blindheit (25.08.2026)

**Der Anker zählte Schreibweisen statt Wörter.** Die Zweierregel deduplizierte
vor der Normalisierung, also über den rohen Wort-Text. `recall_when: "foo, foo"`
lieferte damit zwei Ursprünge — `foo,` und `foo` —, obwohl beide auf denselben
Suchterm abbilden; ein einzelner Begriff erfüllte so weiterhin die Zweierregel.
Derselbe Fehlertyp wie in Abschnitt 16, eine Ebene tiefer. Dedupliziert wird
jetzt über die normalisierte Emissionssignatur des Wortes; die Identifier-Form
wird davon unberührt weiter an der rohen Schreibweise geprüft.

**Die „0 von 4"-Aussage bewies nichts.** Der Fallback hing daran, ob der
scope-gefilterte Pool leer ist — im Vault liegen aber 191 globale Memories, die
immer kompatibel sind. Der Pool ist damit praktisch nie leer, selbst bei völlig
falsch erkanntem Projekt: Eine Fehl-Erkennung erschien als normale Kontrolle.

Die Erkennung stützt sich jetzt nicht mehr auf den #-codierten Ordnernamen,
sondern auf das `cwd`-Feld, das die Transkripte auf jedem User-Turn tatsächlich
tragen — geprüft über drei Projekte. Sie gibt aus, ob sie SICHER ist, und die
Kontrolle ist dreistufig: `random-control` (Scope erkannt und getroffen),
`random-control-global-only` (erkannt, aber nur globale Memories im Pool — eine
eigene Lage, die vorher unsichtbar mitlief) und `random-control-unscoped`
(Erkennung unsicher).

Der Effekt bestätigt die Kritik: **2 von 4 Queries sind unsicher**, wo vorher
„0 von 4" stand. Beide Fälle sind plausibel — eine Subagent-Session ohne
eigenen Vault-Scope und eine Direktnachricht aus einem Projekt, das keinen hat.
Kein Bug, sondern zwei ehrliche „kein Projekt-Scope"-Fälle, die die alte Logik
als sauber erkannt ausgab.

Zusätzlich dedupliziert `collectPrompts()` jetzt über `sessionDir + Text` statt
nur über den Text: Derselbe Prompt aus zwei Projekten wurde vorher willkürlich
dem zuerst gelesenen Verzeichnis zugeschlagen. Verzeichnisse und Dateien werden
sortiert gelesen, damit ein zweiter Lauf dieselbe Zuordnung trifft.

**Das Blatt war score-blind, aber nicht retrieval-blind.** Die Provenienz stand
weiter drin — `above-inject-floor`, `random-control`, `dense-top`. Wer liest,
dass ein Kandidat heute schon eingeblendet wird, labelt anders. Sie ist jetzt
ebenfalls nur noch in der Meta-Datei; das Labelblatt trägt `id`, `title` und das
leere Label, sonst nichts.

Das ist die Voraussetzung dafür, dass die Labels überhaupt etwas wert sind: Sie
sollen entscheiden, ob Router und schneller Pfad ausgeliefert werden dürfen —
ein Blatt, das die Antwort mitliefert, kann diese Frage nicht beantworten.

---

## 18. Vierte Gegenprüfung — und ein Produktionsfehler, der nichts mit alldem zu tun hatte

**Die Zweierregel konnte weiterhin an einem einzigen Query-Term auslösen.**
Gezählt wurden distinkte Wort-URSPRÜNGE, nicht distinkte getroffene TERME:
`recall_when: "my-app your-app"` mit der Query `app` liefert zwei Ursprünge,
die beide nur denselben einen Term treffen. Jetzt ist ein Matching der Größe
zwei gefordert — zwei Ursprünge, die zwei verschiedene signifikante Terme
abdecken (`|A ∪ B| >= 2`, über alle Paare geprüft). Der naheliegende Test
„die Termmengen sind ungleich" wäre falsch: A = B = {app, konfig} erlaubt ein
Matching und muss `strong` ergeben.

**Zwei der drei Kontrollzustände gab es nur auf dem Papier.**
`random-control-global-only` war unerreichbar, weil `recognized` die Existenz
des Scopes bereits voraussetzte — die Bedingung war zirkulär. Und
`random-control-unscoped` war entgegen der eigenen Konsolenzeile nicht
ungefiltert: Auch dort wurde zuerst mit dem unbekannten Projektnamen gefiltert,
und weil 191 global gescopte Memories den Pool nie leer laufen lassen, griff
der Fallback auf `allMemories` nie. Belegt daran, dass alle 16 dieser
Kandidaten aus `all-projects`, `taxonomy` und `user-preference` kamen, kein
einziger aus einem Projekt-Scope.

Erkennung und Scope-Existenz sind jetzt zwei unabhängige Fakten, und jeder
Zustand baut seinen Pool ausdrücklich: unsicher erkannt → wirklich alle
Memories; erkannt ohne passenden Scope → ausdrücklich nur globale; erkannt mit
Scope → gefiltert wie bisher.

### Der eigentliche Fund

Beim Verifizieren dieser Zustände fiel ein Fehler auf, der nichts mit dem
Messwerkzeug zu tun hat und weit über #362 hinausgeht:

`detectProject()` gibt das Verzeichnissegment in seiner echten Schreibweise
zurück — `CarNexus` für `~/Projekte/CarNexus`. Vault-Scopes sind konventionell
klein geschrieben. `isScopeCompatible()` verglich case-sensitiv. In einer
CarNexus-Session war das Projekt damit **mit seinem eigenen Scope nie
kompatibel**: Die eigenen Projekt-Memories fielen aus dem Scope-Filter, in jedem
Score-Band, während globale weiter durchkamen. Betroffen sind alle vier Lanes,
die `detectProject()` verwenden.

Der Fehler ist still und in genau der falschen Richtung: Wer in einem solchen
Projekt arbeitet, bekommt sein eigenes Gedächtnis am schlechtesten. Nichts hat
ihn gemeldet — kein Test, keine Telemetrie, keine Fehlermeldung. Gefunden hat
ihn ein Agent, der eigentlich nur die Kontrollstichprobe eines Eval-Werkzeugs
gegenprüfen sollte.

Beide Seiten werden jetzt gefaltet verglichen. Die Scope-Familie über das
Präfix und die Trennung zwischen Geschwistern bleiben unverändert und sind
durch Tests festgehalten.

### Hygiene

In `search.ts` und `candidate-union.ts` stand je ein literales NUL-Byte als
Trennzeichen im Quelltext — dadurch galten die Dateien für `rg` und manche
Editoren als binär. Ersetzt durch das Escape `\0`, gleiche Laufzeitwirkung.

---

## 19. Die Fehlerklasse schließen — und eine Korrektur an Abschnitt 18

Der punktuelle Fix aus Abschnitt 18 hat den Einzelfall geschlossen, nicht die
Klasse. Die Gegenprüfung fand zwei weitere Produktionsausfälle derselben
Ursache:

**SessionStart.** Die Lane fragt beim Sitzungsstart gezielt nach den Memories
des Projekts und schickt dafür das rohe `detectProject()`-Ergebnis als `scope`.
Der Core verglich `opts.scope` case-sensitiv — im BM25-Pfad, im Vector-Pfad UND
in der Hop-Expansion. `scope: "carnexus"` liefert Treffer, `scope: "CarNexus"`
liefert nichts. Weil `user-preference` und `all-projects` weiter antworteten,
las sich der Ausfall als „für dieses Projekt gibt es eben nichts".

**Floors.** `listFloors()` hatte denselben Vergleich. Das wiegt schwerer als der
Recall-Fall: Floors sind laut Vertrag garantiert präsent — hier fehlten sie
vollständig und lautlos.

**Die Lösung ist eine Entscheidung, keine Streuung.** Statt weitere
`.toLowerCase()` zu verteilen, liegt die Scope-Identität jetzt in
`packages/core/src/scope.ts`: `normalizeScopeKey`, `scopeEquals`,
`isScopeCompatible`, `GLOBAL_SCOPES`. Alle Vergleichsstellen benutzen sie — die
drei Core-Recallpfade, die Floor-Registry, `list_memorys`, der
Save-Quality-Pool, der Hook-Scopefilter und das Eval-Werkzeug, dessen eigene
Kopie damit verschwindet. Bestandsdaten bleiben unangetastet: Jede Schreibweise
im Frontmatter bleibt ladbar und wird nur beim Vergleich normalisiert.

`detectProjectDetailed()` liefert jetzt `{raw, key, confidence}`. Der alte
Fallback gab für jeden nichtleeren Pfad irgendeinen Namen zurück —
`/tmp/worktree/packages/core` wurde zu `core` —, und kein Aufrufer konnte
Erkennung von Raten unterscheiden. Filter nutzen `key`, Anzeige und Telemetrie
dürfen `raw` behalten.

Eine Randnotiz, die kein Zufall ist: Der Hook-Scopefilter wurde nach
`daemon/scope-filter.ts` ausgelagert, statt `hook-skip.ts` auf core zeigen zu
lassen. `hook.ts` startet bei JEDEM Tool-Call neu und lädt bewusst nur stdlib —
ein Re-Export hätte core in jeden dieser Starts gezogen, für eine Funktion, die
dort nie aufgerufen wird. Das ist genau der Posten, den #305 als 87–102 ms pro
Aufruf misst.

### Korrektur an Abschnitt 18

Dort stand „alle vier Lanes betroffen". Das war falsch, und es stand so auch im
Commit und im Vault. Richtig ist:

- **Write-Lane** — betroffen (Scope-Hard-Filter).
- **SessionStart** — betroffen, über den Core-Filter.
- **Floor-Registry** — betroffen.
- **Prompt-Lane und Todo-Lane** — NICHT betroffen, aber aus einem Grund, der
  selbst ein Befund ist: Sie filtern überhaupt nicht nach Projekt-Scope, nur
  nach Score beziehungsweise Modus. Wenn #110 für alle automatischen Hook-Hints
  gelten soll, fehlt dort eine Policy. Dieser Befund zeigt in die andere
  Richtung als der Case-Fehler: Er erklärt „fremde Treffer kommen durch", nicht
  „eigene Treffer fehlen".

## 20. Fünfte Gegenprüfung: die Identität selbst, nicht nur ihr Vergleich (26.08.2026)

Abschnitt 19 zentralisierte den **Vergleich** zweier Schreibweisen. Die
Gegenprüfung durch Codex fand drei Stellen, an denen zwei Schreibweisen
überhaupt erst entstehen — plus einen vierten Fund, der mit Groß- und
Kleinschreibung nichts zu tun hat. Alle vier bestätigt, alle vier behoben.

### 20.1 Der Rename schrieb Scopes nicht um

`rewriteScopes()` in `daemon/webui-areas.ts` verglich `scope !== oldScope`
exakt. Ein Ordner `carnexus` mit Frontmatter `scope: CarNexus` wurde beim
Umbenennen verschoben, aber kein einziger Scope umgeschrieben —
`scopesRewritten: 0`, und die Memories waren danach im eigenen Projekt fremd.
Gefaltet über `scopeEquals`.

### 20.2 Produktdokumente zogen mit, ihr Scope nicht

Derselbe Rename verschiebt `dokumentationen/<scope>` als Regal derselben Area
mit, rief `rewriteScopes()` aber nur für den Memory-Ordner auf. Die Dokumente
lagen danach im neuen Regal und trugen den alten Scope — beim Recall fürs neue
Projekt also fremd. Das betraf **jeden** Rename, unabhängig von der
Schreibweise. Der Doku-Ordner wird jetzt nach dem Verschieben genauso
umgeschrieben; beide Zahlen fließen in dieselbe `scopesRewritten`-Summe, denn
es sind Scope-Rewrites derselben Area.

### 20.3 Die Identität selbst: id und Scope sind jetzt kanonisch

`save_product_doc` baute id, Pfad, Scope, `topic_path` und Tags aus dem rohen
`project`. Zwei Aufrufe mit `CarNexus` und `carnexus` erzeugten zwei logische
Dokumente — auf einem case-insensitiven Dateisystem aber auf EINER Datei, also
ein Überschreiben, das wie ein Update aussieht.

Der Fix sitzt nicht im Handler, sondern eine Ebene tiefer, weil das Loch
allgemeiner war: Auto-generierte ids sind über `slugify()` immer klein, eine
vom Caller **explizit gesetzte** id passierte dagegen nur
`isPathSafeComponent`. Zwei Folgen, beide still — das beschriebene
Überschreiben, und: das Wikilink-Muster akzeptiert nur
`[a-z0-9][a-z0-9_-]*`, eine großgeschriebene id ist per `[[id]]` gar nicht
verlinkbar und fällt aus dem Multi-Hop-Recall heraus.

Deshalb jetzt eine Ableitung für alle:

- `canonicalMemoryId(explicitId, title)` in `core/save-text.ts` — gefaltet,
  nicht abgelehnt: ein Caller mit CamelCase-id soll schreiben können, nur eben
  auf die kanonische id.
- `resolveMemoryTarget()` faltet zusätzlich den Scope, bevor er zum
  Ordnernamen wird; `save.ts` schreibt denselben Key ins Frontmatter, damit
  Ordner und `scope:` nie auseinanderlaufen.
- `audit-save.ts` benutzt dieselbe Ableitung statt einer eigenen Kopie — dass
  beide sie einst getrennt kopierten, war die Wurzel von #240/C6.

Damit erledigt sich Codex' Punkt zu den exakten Reserved-Scope-Prüfungen in
`save-target.ts` von selbst: Der einzige produktive Aufrufer von
`subfolderFor()` ist `resolveMemoryTarget`, und der übergibt den kanonischen
Key. In `daemon/taxonomy.ts` wurde die Prüfung dennoch gefaltet — dort liest
sie **Bestands**-Frontmatter, das von Hand geschrieben sein kann, und die
Drift-Erkennung negiert dieselbe Prüfung: ein `scope: Taxonomy` wäre still aus
der Session-Injektion gefallen und zugleich als Drift-Kandidat behandelt
worden.

**Vault-Bestand geprüft, keine Migration nötig.** Über alle 997 Dateien: 0 ids,
0 Scopes, 0 Ordner mit Großbuchstaben. Die 21 großgeschriebenen Dateinamen in
`documents/Inbox/` sind Dokument-Sidecars, deren Name den Original-Scan
spiegelt (`IMG_4022.JPG.md`) — eine andere Identität, bewusst unangetastet.

### 20.4 Die Todo-Lane las `unfused` nicht

Der Fund mit der größten Reichweite, und der einzige ohne Bezug zur
Schreibweise. Fällt der dichte Arm aus, liefert `recallHybrid` rohe
BM25-Werte auf offener Skala — #302 maß Spitzentreffer sechsstellig. Prompt-
und Write-Lane behandeln das seit P0; die Todo-Lane las das Feld gar nicht und
maß die rohen Werte an 50/100, als wären es RRF-Scores. Für jede Maschine
**ohne Embedding-Modell** hieß das: praktisch jeder Treffer im REQUIRED-Band,
Backoff-Bypass inklusive.

Jetzt wortgleich zur Prompt-Lane: kein REQUIRED und kein Bypass ohne Fusion,
`unfusedHeadline("these todos")` statt einer Bandaussage, und die Zahl wird
weggelassen — sie lädt zum Vergleichen ein, den sie nicht trägt. Die Telemetrie
führt `unfused` mit, damit der Anteil messbar ist.

Das ist zugleich die Vorbedingung für den nächsten Schritt: Ein
score-gegateter Scope-Bypass in der Todo-Lane wäre auf der unfused Skala
sinnlos gewesen.

### 20.5 Der Scope-Filter für Prompt- und Todo-Lane — gebaut, im Shadow-Modus

Der Befund aus Abschnitt 19: Write-Lane und SessionStart filtern seit #110 hart
nach Projekt-Scope, Prompt- und Todo-Lane filterten **nie**. Fremde Treffer
kamen dort durch.

Der Filter ist jetzt da, in `daemon/scope-filter.ts` als
`applyLaneScopeFilter()`, und läuft zuerst im **Shadow-Modus**: Er rechnet aus,
was er verwerfen würde, schreibt das in die Telemetrie und verwirft nichts.
Umgelegt wird er mit `BASTRA_SCOPE_FILTER_LANES=enforce`.

Warum nicht sofort scharf: Wie viele Treffer betroffen sind, weiß niemand — die
Zahl existiert nirgends, weil der Filter dort nie lief. Ein Filter, der ohne
gemessene Grundlinie scharfgeschaltet wird, entfernt möglicherweise eigene
Treffer lautlos, und genau diese Fehlerklasse wurde in Abschnitt 19 und 20
gerade geschlossen. Die Telemetrie beider Lanes trägt jetzt
`scope_filter_mode`, `dropped_scope_count`, `dropped_scopes` und
`project_confidence`; `detected_mode` und `unfused` standen schon da. Die
Scope-NAMEN kommen mit, weil eine nackte Zahl nicht auswertbar ist: „12
verworfen" kann ein einziges Nachbarprojekt sein oder breite Streuung, und das
sind zwei verschiedene Entscheidungen.

Die Politik unterscheidet sich pro Lane, und das ist der Punkt:

- **Prompt-Lane** behält die Anker-Ausnahme aus #148 — ein hand-geschriebener
  Trigger aus einem anderen Projekt ist eine Absichtserklärung, kein Rauschen.
- **Todo-Lane** bekommt sie nicht. Sie fragt ausdrücklich nach
  `type: project-fact` für den aktuellen Arbeitsplan; ein fremder Projekt-Fakt
  ist dort fast immer Kontamination.
- **Reflex-Treffer passieren immer**, in beiden Lanes, auch die semantischen
  mit `recall_mode: "reflex"`. Sie sind vom Benutzer verdrahtet und hart
  getriggert — eigene Produktsemantik (#217), kein Ranking-Ergebnis, das ein
  Scope-Filter zweitbewerten dürfte.
- **Ohne Fusion ist die Cross-Scope-Ausnahme zu.** Auf der rohen BM25-Skala
  gibt es kein „beide Arme stimmen überein"-Signal, an dem sich ein Bypass
  festmachen ließe. Für fremde Scopes gilt dann fail-closed — weil das Signal
  fehlt, nicht weil der Treffer schlecht wäre. Das war zugleich der Grund,
  20.4 vorher zu erledigen: Ein score-gegateter Bypass wäre auf einer Skala
  ohne Bänder sinnlos gewesen.

### 20.6 `detectProjectDetailed()` produktiv — ein geratener Name darf nicht filtern

`detectProject()` gibt für jeden nichtleeren Pfad einen Namen zurück.
`/tmp/worktree/packages/core` wird zu "core", und der Aufrufer konnte das nicht
von einer echten Erkennung unterscheiden. In der Write-Lane hieß das: Der
Hard-Filter warf dort jeden Treffer weg, dessen Scope nicht "core" hieß — das
ganze eigene Projektgedächtnis, lautlos, ohne dass irgendwo ein Fehler entstand.
Dieselbe Wirkung wie der case-sensitive Vergleich aus #360, nur mit anderer
Ursache.

`projectForFilter(cwd)` in `daemon/scope-filter.ts` beantwortet jetzt die Frage
„darf dieser Name etwas wegwerfen": nur bei `confidence: "root-match"`, sonst
`null` — und `isScopeCompatible(scope, null)` ist true, der Filter ist also
offen statt falsch streng. Zurückgegeben wird `key`, nie `raw`: Filter
vergleichen kanonisch. Der geratene Name bleibt für Query, Anzeige und
Telemetrie in Gebrauch; nur zum Wegwerfen taugt er nicht. Umgestellt sind
Write-, Prompt- und Todo-Lane.

**Die SessionStart-Lane bleibt bewusst bei `detectProject()`.** Dort ist
`project` keine Filterdimension, sondern eine Suchdimension — sie stellt eine
zusätzliche Query mit `scope: <projekt>`. Ein Confidence-Gate wäre hier
fail-CLOSED: Wer seine Repos außerhalb der bekannten Wurzelsegmente liegen hat
(`PROJECT_ROOTS` kennt projekte/projects/code/workspace/src/repos), verlöre
seinen Projekt-Kontext beim Sitzungsstart komplett. Der Grundsatz ist deshalb
eng gefasst: Das Gate greift dort, wo ein geratener Name etwas WEGNIMMT, nicht
dort, wo er etwas hinzufügt.

## 21. Sechste Gegenprüfung: was die Kanonisierung selbst kaputt gemacht hat (26.08.2026)

Codex prüfte den Stand aus Abschnitt 20 und fand drei Restprobleme — eines
davon hatte ich in Abschnitt 20 selbst eingeführt. Alle drei bestätigt, alle
drei behoben. Bei einem stimmt der Mechanismus, aber nicht die Zahl; das steht
unten.

### 21.1 Die Kanonisierung machte Bestandsdaten unerreichbar

`canonicalMemoryId()` faltet jede explizite id. Der Bestandsfall war nicht
mitgedacht, und er hatte zwei Ausgänge, beide falsch:

- **case-sensitives Dateisystem:** `upper-id.md` entsteht NEBEN dem
  vorhandenen `Upper-ID.md`. `overwrite: true` legt still ein Duplikat an.
- **case-insensitives Dateisystem** (auf APFS nachgestellt): Der Write trifft
  die alte Datei, ihr Name bleibt `Upper-ID.md`, das Frontmatter trägt jetzt
  `id: upper-id`. Datei und id fallen auseinander.

Codex' Empfehlung war, die globale Kanonisierung zurückzunehmen. Der Auftrag
war das Gegenteil — Kleinschreibung durchziehen —, also ist sie geblieben und
hat einen **Bestandsschutz** bekommen (`resolveAgainstExisting` in
`core/save-target.ts`): Existiert das kanonische Ziel EXAKT nicht, das rohe
aber schon, wird das rohe bedient und die alte Schreibweise beibehalten. Kein
Rename, keine Migration. Alles Neue ist kanonisch, alles Alte bleibt genau so
bedienbar wie vorher.

Der Vergleich läuft segmentweise über `readdirSync`, nicht über `existsSync`:
Ein case-insensitives Dateisystem meldet für `upper-id.md` true, wenn
`Upper-ID.md` daliegt, und öffnet für `…/proj` klaglos `Proj/`. Genau diese
Verwechslung ist hier auseinanderzuhalten. Der Zweig läuft nur, wenn roh und
kanonisch überhaupt auseinandergehen — bei jedem normalen Save kostet er nichts.

`MemoryTarget` trägt jetzt zusätzlich den `scope`, den das Frontmatter tragen
MUSS: kanonisch im Normalfall, im Bestandsfall die alte Schreibweise. Sonst
zeigte das Frontmatter auf ein Regal, in dem die Datei gar nicht liegt.

Zweiter Teil desselben Fundes: `tool-handlers.ts` leitete die id für das
Quality-Scoring mit einer EIGENEN Kopie ab (`parsed.data.id ?? slugify(title)`)
und wich seit der Faltung vom tatsächlich geschriebenen Ziel ab — der
Selbstausschluss (#239) hätte das Memory als sein eigenes Duplikat gewertet.
Es fragt jetzt `resolveMemoryTarget`, also dieselbe Stelle, die auch schreibt.
Dieselbe Duplikation war schon einmal die Wurzel von #240/C6.

### 21.2 `root-match` ist keine Projekterkennung

Das Confidence-Gate aus 20.6 vertraute jedem `root-match`. Das heißt aber nur
„ein Pfadsegment hieß workspace/src/code", nicht „der Name danach ist ein
Vault-Scope". Nachgestellt:

```
/workspace/packages/core     → root-match, Filterprojekt "packages"
/Users/me/src/packages/core  → root-match, Filterprojekt "packages"
```

Das trifft die **Write-Lane**, deren Filter scharf ist: In so einem Verzeichnis
verschwindet das ganze eigene Projektgedächtnis. Mein Bericht zu 20.6 hat
behauptet, der Fix schließe das — er tat es nicht.

Der belastbare Beleg ist, ob der VAULT den Namen als Scope oder
Familienmitglied kennt. Die Frage ist nur im Daemon beantwortbar, wo der Vault
liegt; die Lanes sprechen ihn über HTTP an. Also beantwortet ihn der
Recall-Handler und schickt das Ergebnis als `project_known` mit
(`vaultKnowsProject`, früher Abbruch beim ersten Treffer — der Normalfall
kostet nichts, nur der seltene Fehlerfall läuft einmal durch).

Fehlt das Feld — älterer Daemon, fremder Aufrufer —, fällt der Filter auf einen
schwächeren Beleg zurück: Trägt kein Treffer der Ergebnisliste einen passenden
Scope, wird nicht gefiltert. Globale Scopes zählen dabei nicht als Beleg; sie
passen per Definition zu jedem Namen und würden auch einen erfundenen
bestätigen. An einem unbekannten Feld darf ein Filter nie strenger werden.

In der Telemetrie steht jetzt `filter_project` (der Name, gegen den tatsächlich
verglichen wurde) und `scope_filter_skipped` (`no-project` /
`no-scope-evidence`). `project_confidence: root-match` allein hätte nicht
gezeigt, dass gegen „packages" verglichen wurde.

Die **Write-Lane** läuft dabei auf denselben gemeinsamen Pfad
(`applyLaneScopeFilter`, fest im enforce-Modus). Sie gewinnt damit den
Beleg-Schutz und die Reflex-Ausnahme, die sie vorher nicht hatte; die
Anker-Ausnahme aus #148 bleibt unverändert.

### 21.3 BM25-only: der Mechanismus stimmt, die Zahl nicht

Codex' Befund: Die RRF-Schwellen 50 und 100 werden weiterhin auf rohe
BM25-Scores angewendet, und er misst an 991 Memories einen eindeutigen exakten
`recall_when`-Treffer auf Rang 1 bei **48,707** — unter dem Floor 50, also
verworfen.

**Nachgemessen an Daniels Vault (997 Memories), und das reproduziert sich so
nicht.** Über 400 echte `recall_when`-Trigger als Query, jeweils Rang 1:

| | Anzahl |
|---|---:|
| Rang-1-Score < 50 (Floor) | **0** von 400 |
| Rang-1-Score < 100 (REQUIRED) | **19** von 400 |

Die Skala ist stark query-längenabhängig: Lange Prompts liefern Rang-1-Werte
von 2000–3800, Einwort-Queries 57–200. Ein Rang-1-Treffer unter dem Floor 50
ist mir in dieser Messung nicht untergekommen. Was zutrifft: 4,75 % der
Rang-1-Treffer liegen unter 100 und werden als OPTIONAL behandelt statt als
REQUIRED — und Treffer auf Rang 2 und tiefer fallen sehr wohl unter 50
(gemessen: 8,5 bei einer Einwort-Query).

Behoben wurde deshalb der Teil, der keine Kalibrierung braucht, sondern nur
Konsistenz: Die **Write-Lane** teilte rohe BM25-Werte weiter bei 100 in
REQUIRED/OPTIONAL und ließ REQUIRED den Backoff umgehen — die dritte Stelle
derselben P0-Sache. Ohne Fusion stehen dort jetzt alle Treffer in EINER Liste
unter der ehrlichen Überschrift, ohne Score, und es gibt keinen Bypass. Ihre
Cross-Scope-Ausnahme nutzt im unfused-Fall ebenfalls keinen 100er-Wert mehr —
das kam mit der Umstellung auf den gemeinsamen Filterpfad (21.2).

**Nicht behoben und ausdrücklich offen:** die Floors selbst. `SCORE_FLOOR = 50`
stammt aus dem RRF-Raum (`RRF_SCALE/(RRF_K + rank) ≥ 50` ⇔ Rang ≤ 4) und
bedeutet auf der BM25-Skala nichts. Das braucht eine eigene BM25-only-Kalibrierung
mit Labels, kein weiteres Argument. Der Bericht behauptet nicht, dass das
Problem vollständig gelöst ist.

### 21.4 Zwei Folgepunkte

**Produktdokumente überlebten den Rename nur halb.** Abschnitt 20.2 schrieb den
Scope um, aber die Identität nicht: `save_product_doc` baut den Projektnamen in
die id (`doku-<projekt>-<area>`, zugleich der Dateiname), in `topic_path[1]` und
in die Tags. Ein Dokument blieb also `doku-carnexus-area`, während der nächste
Aufruf für `new-project` nach `doku-new-project-area` sucht — und ein zweites
Dokument anlegte, statt das vorhandene zu aktualisieren. Genau das, was die
Update-in-place-Semantik dieses Tools ausschließen soll. `rewriteDocIdentity()`
zieht id, Dateiname, `topic_path` und Tag jetzt mit; ist der Zielname schon
belegt, bleibt das Dokument liegen (lieber eine alte id als ein überschriebenes
Dokument). Der von Codex vermisste Regressionstest existiert und geht den
ganzen Weg: Doc anlegen → Projekt umbenennen → dieselbe Area erneut speichern →
weiterhin genau ein Dokument.

**Die Prompt-Lane meldete `status: "ok"` bei null Treffern**, wenn der Filter im
enforce-Modus alles abtrug: `no-hits` wurde vor dem neuen Scope-Filter bestimmt.
Die Telemetrie hätte den Filter nicht von einem stillen Recall unterscheiden
können — also genau das nicht gezeigt, wofür der Shadow-Modus da ist. Todo- und
Write-Lane setzen ihren Status schon nach dem Filter und waren nicht betroffen.

### 21.5 Was offen blieb

**Die Shadow-Daten.** Sobald der Daemon eine Weile mit diesem Stand lief, sagen
`dropped_scope_count`, `dropped_scopes`, `filter_project` und
`scope_filter_skipped` in den Prompt- und Todo-Serien, ob `enforce` trägt.
Umlegen ist dann ein Env-Wert.

**Die BM25-only-Floors** (21.3). Braucht Labels, kein weiteres Argument — und
hängt damit am selben Blocker wie Router und schneller Lexikpfad.

### 21.6 Verifikation

1643 Tests, 1641 grün, 0 rot (1 skipped, 1 todo). Typechecks für core, daemon,
statusline und eval grün. Neue Tests, jeder reproduziert seinen Defekt vor dem
Fix: `core/__tests__/canonical-id.test.ts` (6), `lane-scope-filter.test.ts`
(19), `write-lane-project-confidence.test.ts` (2), `webui-areas.test.ts` (+2),
`product-docs.test.ts` (+2), `todo-hook.test.ts` (+5), `taxonomy.test.ts` (+1).

## 22. Siebte Gegenprüfung: der Bestandsschutz war zu schmal, das Rename zu grob (26.08.2026)

Der Hook- und Scope-Teil aus Abschnitt 21 hat die Gegenprüfung überstanden.
Zwei Save-/Rename-Lücken blieben, beide bestätigt und behoben.

### 22.1 Bestandsschutz suchte an zwei Orten statt im Vault

`resolveAgainstExisting()` prüfte genau zwei Kombinationen — kanonisches Regal
plus kanonische id gegen rohes Regal plus rohe id. Jede Mischform fiel durch,
und ebenso jede Ablage, die der Vault ausdrücklich unterstützt. Nachgestellt:

```
memories/projects/proj/Upper-ID.md  → id upper-id, Datei bleibt Upper-ID.md
memorys/Upper-ID.md                 → zweites kanonisches Memory daneben
memories/people/Upper-ID.md         → zweites kanonisches Memory daneben
```

Der Vault scannt rekursiv; der Resolver tut es jetzt auch. Findet er das
kanonische Ziel nicht EXAKT, sucht er die rohe id vaultweit und übernimmt
deren Verzeichnis. Der Scan läuft nur, wenn roh und kanonisch überhaupt
auseinandergehen — auf einer der beiden Achsen genügt, denn eine kanonische id
in einem rohen Regal ist derselbe Fall wie umgekehrt.

`auditedSave()` hatte dieselbe Lücke an anderer Stelle: Sein Vorab-Lookup
suchte unter der kanonischen id und fand eine Bestands-Groß-id nicht, also
wurde jeder Overwrite darauf als `create` mit `diff_before: null` auditiert —
das Vorbild eines destruktiven Overwrites wäre wieder weg gewesen, genau die
Wurzel von #240/C6. Es fragt jetzt `resolveMemoryTarget`, also dieselbe
Stelle, die auch schreibt.

### 22.2 Das Rename benannte Produktdoku-ids um und brach ihre Beziehungen

`rewriteDocIdentity()` aus 21.4 zog id und Dateiname mit. Das löst zwar den
Doppel-Dokument-Fall, bricht aber jedes `related: [doku-carnexus-area]` und
jeden `[[doku-carnexus-area]]` im Vault: Der Graph löst keine Aliase auf, es
bliebe ein Geisterknoten. Es widersprach außerdem der Grundregel dieses
Moduls, dass ids einen Rename überleben — die im selben File als Kommentar
steht.

Der Fix folgt Codex' Vorschlag und macht den Rename-Code kleiner statt größer:

- Das Rename zieht nur noch `scope`, `topic_path` und Tags mit
  (`rewriteDocMetadata`, gefaltet über `scopeEquals` — ein Bestandsdokument
  kann `topic_path: [doku, CarNexus, …]` tragen; das case-sensitive
  `startsWith()` der alten Fassung hätte es nicht erkannt).
- `save_product_doc` sucht das Dokument über seine IDENTITÄT — type `doc` plus
  Scope plus Area-Segment — und leitet erst dann eine id ab, wenn es keines
  gibt.

Die id ist damit ein historischer Name, kein Schlüssel: genau der Status, den
sie bei jedem anderen Memory auch hat. Der Regressionstest geht weiter den
ganzen Weg (anlegen → umbenennen → dieselbe Area speichern → ein Dokument),
prüft jetzt aber, dass die id dabei stehen bleibt.

### 22.3 Verifikation

1648 Tests, 1646 grün, 0 rot (1 skipped, 1 todo). Typechecks für core, daemon,
statusline und eval grün. Neu: vier Bestandslagen in
`core/__tests__/canonical-id.test.ts`, ein Bestandsdokument mit roher
Scope-Schreibweise in `product-docs.test.ts`.

Unverändert offen bleiben die beiden Punkte aus 21.5.

## 23. Achte Gegenprüfung: zwei Wege, fremde Dateien zu überschreiben (26.08.2026)

Beide Funde sind Save-Sicherheit, beide entstanden in den Reparaturen der
letzten zwei Runden, und beide sind Datenverlust — nicht bloß Duplikate.

### 23.1 Der Vault-Scan verwechselte Dateinamen mit Identität

`findExactFile()` aus 22.1 suchte eine Datei namens `<rawId>.md` und prüfte
ihr Frontmatter nicht. Zwei Ausgänge, nachgestellt:

```
notes/Upper-ID.md  (gewöhnliche Obsidian-Notiz, kein Frontmatter)
  → vollständig durch das neue Memory ersetzt

notes/legacy-name.md  (Frontmatter id: Upper-ID, ein echtes Memory)
  → nicht gefunden, kanonisches Duplikat daneben angelegt
```

Der erste Fall ist der schwerste Fund dieser ganzen Kette: Ein Save konnte eine
fremde Notiz zerstören, nur weil sie zufällig so hieß wie eine id.

Beide Fälle haben dieselbe Wurzel — der Dateiname wurde als Identität
behandelt. `findByFrontmatterId()` sucht jetzt über die geparste
Frontmatter-`id`. Eine Datei ohne parsebares Frontmatter und ohne `id` ist kein
Memory und kommt nie als Ziel in Frage; das ist der Teil, der fremde Notizen
schützt. Und ein Memory, dessen Datei anders heißt als seine id, wird gefunden
und behält seinen Dateinamen — `MemoryTarget` trägt deshalb den vollen
relativen Pfad statt `<id>.md` anzunehmen.

Verglichen wird exakt, nicht gefaltet: Gäbe es die kanonische id, hätte der
Zweig davor schon gegriffen.

Kosten, gemessen an einem Vault mit 997 Memories: Normalfall 0,015 ms je
Aufruf (kein Scan), Sonderfall mit vollem Durchlauf 180 ms — einmalig, gegen
einen Datei-Write, und nur für Aufrufer, die eine nicht-kanonische id
mitschicken.

### 23.2 Der Produktdoku-Lookup war zu breit

`findDocFor()` aus 22.2 prüfte type, Scope und `topic_path[2]`. Ein
handgeschriebenes Dokument im selben Scope mit
`topic_path: [manual, unrelated, area]` erfüllte das — und wurde von
`save_product_doc(project=carnexus, area=area)` vollständig überschrieben.

Verlangt wird jetzt die vollständige Signatur: `type: doc`, passender Scope,
`topic_path` der Länge 3 mit `["doku", <projekt>, <area>]`. Projektsegment und
Scope gefaltet, weil ein Bestandsdokument `[doku, CarNexus, …]` tragen kann.

Der Ansatz aus 22.2 — stabile historische id, Lookup über die Identität —
bleibt damit unverändert richtig; er war nur zu großzügig formuliert.

### 23.3 Verifikation

1651 Tests, 1649 grün, 0 rot (1 skipped, 1 todo). Typechecks für core, daemon,
statusline und eval grün. Drei neue Negativtests, die genau das prüfen, was die
Suite bisher nicht sah: die fremde Notiz bleibt unangetastet, das Memory unter
abweichendem Dateinamen wird gefunden, das fremde Dokument im selben Scope
bleibt unangetastet.

Unverändert offen bleiben die beiden Punkte aus 21.5 — beides Recall-Themen,
beides labelpflichtig.

## 24. Neunte Runde: der Audit, nach dem einzelne Flicken nicht mehr reichten (26.08.2026)

Der breite Audit fand elf Punkte, davon mehrere Datenverlust-Risiken. Seine
wichtigste Aussage war keiner der elf, sondern die Diagnose darüber: Es fehlten
zentrale Invarianten, und die Reparaturkette der vorherigen Runden hatte das
nur überdeckt. Diese Runde baut die Invarianten, statt die Stellen einzeln zu
flicken.

### 24.1 Warum die Suite grün war, während die Defekte reproduzierbar blieben

Der Befund, der alles erklärt: Der Daemon importiert `@bastra-recall/core`
über dessen package.json-exports, also `packages/core/dist` — nicht `src`.
Jeder daemon-Test, der core-Verhalten prüft, misst den zuletzt GEBAUTEN Core.

In den Runden 20–23 lief die daemon-Suite mehrfach vollständig grün gegen eine
dist von vor den core-Änderungen. Ein Fix in core konnte "grün" melden, ohne
von einem einzigen daemon-Test berührt worden zu sein — und ein Defekt, den der
Prüfer gegen den Quellstand reproduzierte, blieb hier unsichtbar. Aufgefallen
ist es erst, als ein neuer core-Export den Typecheck brach.

`pretest` baut core jetzt vor jedem Lauf, und ein Test vergleicht die mtime von
`dist/index.js` gegen die neueste `.ts` unter `src`. Wer die Suite ohne das
startet, bekommt gesagt, was gerade nicht geprüft wurde.

### 24.2 Die Identität: eine Auskunft statt drei zu schwacher Regeln

Der Save-Pfad entschied an drei Stellen getrennt, was zu einer id gehört, und
jede Regel ließ sich in einen Datenverlust übersetzen. Alle sechs
nachgestellt, alle sechs vorher grün in der Suite:

| | Lage | vorher |
|---|---|---|
| A | plain note am kanonischen Zielpfad | vollständig überschrieben |
| B | fremdes Memory (`id: other-id`) am Ziel | überschrieben, id umgeschrieben |
| C | Notiz mit zufälligem YAML-Feld `id` | als Memory behandelt, ersetzt |
| D | echtes Memory unter abweichendem Pfad | nicht gefunden, Duplikat |
| E | Memory ohne id (aus Dateiname repariert) | nicht gefunden, Duplikat |
| F | dieselbe id in zwei `folder`-Regalen | beide Saves erfolgreich |

`memory-locator.ts` beantwortet die Frage jetzt an einer Stelle, mit derselben
Parser-Semantik, mit der auch der Vault seinen Index baut (`parseMemoryWith`,
inklusive id-Reparatur aus dem Dateinamen). Was der Index nicht als Memory
führt, kann kein Save-Ziel sein — das schützt die gewöhnlichen Obsidian-Notizen,
die im selben Vault liegen.

Daraus folgen drei Invarianten in `saveMemory`: Ein belegtes Ziel wird nur
überschrieben, wenn die dort geparste effektive id die erwartete ist — sonst
harter Konflikt, auch bei `overwrite: true`. Dieselbe id an einem anderen Ort
ist eine Kollision, kein freier Platz; mit `overwrite` bleibt es das bewusste
Re-Filing aus #64. Und ein `ambiguous` — zwei Dateien, eine id — wird nicht
geraten, sondern gemeldet.

Der Daemon reicht seinen geladenen Index als Locator durch, der Folder-Import
einen Snapshot des Ausgangsstands. Damit entfällt der synchrone Vault-Scan im
Save-Pfad, der sonst je Save anfiele.

Die Matrix aus negativen Identitäts- und Kollisionsfällen liegt als
`memory-identity-matrix.test.ts` bei — genau die Testklasse, deren Fehlen die
ganze Kette möglich gemacht hat.

### 24.3 Dieselbe Verwechslung, zwei Etagen weiter

Der Document Hub schrieb sein Sidecar nach `<original>.md` und akzeptierte bei
`overwrite` alles, was dort lag; das Area-Rename ging über jede Datei mit einem
YAML-Feld `scope`. Beide Male dieselbe Wurzel: Ein Pfad oder ein Feldname wurde
für eine Identität gehalten. Beide lesen jetzt `readOccupant`.

Dazu die Unterscheidung, die es vorher nicht gab: Produktdokumente und
Document-Hub-Sidecars heißen beide `type: doc`, werden aber verschieden
behandelt — `recategorizeDocument` verwandelte eine Produktdoku in ein Sidecar.
`isProductDoc` und `isDocumentSidecar` trennen sie jetzt an jedem Eingang,
abgeleitet aus vorhandenen Feldern, ohne Migration.

### 24.4 Die Mutation: atomar, geprüft, nachgiebig

Drei Writer neben dem Save-Pfad ändern Memory-Dateien — Conflict-Marking,
`superseded_by`, der Archiv-Stempel. Jeder schrieb direkt auf die Zieldatei
(kurzzeitig leer oder halb geschrieben) und keiner verglich zwischen Read und
Commit (wer zwischendurch schrieb, verlor).

`mutateMemoryFile(filePath, expectedId, mutation)` macht beides plus die
Identitätsprüfung. Ein `raced` lässt den anderen gewinnen. Dieselbe
Nachgiebigkeit gilt jetzt für die Hintergrundläufe `expandTriggers` und
`enrichRelated`: Eine Anreicherung darf jederzeit ausfallen, ein Save nicht.

**Was NICHT gebaut wurde:** ein prozessübergreifendes ID-Lock. Der Vergleich
schließt das Fenster nicht, er erkennt nur, dass es zugeschlagen hat. Das steht
so im Modulkopf, und für die beiden modulprivaten Hintergrund-Writer gibt es
keinen Regressionstest — der Moment zwischen Read und Rename ist von außen
nicht deterministisch zu treffen, und einen Injektionspunkt dafür in den
Produktivcode zu legen wäre teurer als die Invariante wert ist.

### 24.5 Absicht, die keine war

Learned Bridges erweitern die Query vor der Suche, und diese hinzuerfundenen
Terme gingen ungetrennt in den Anker: Ein Bridge-Term konnte
`matched_recall_when` setzen, `weak_result` unterdrücken und einen
Cross-Scope-Bypass erzeugen, obwohl der Benutzer das Wort nie geschrieben hat.
Genau das sollte der Anker seit P0 ausschließen — er misst AUTORENABSICHT auf
beiden Seiten. `authored_query` trägt die Regel nach: Ranking bleibt auf der
erweiterten Query, Anker und Berechtigungen ziehen sich auf das zurück, was der
Mensch geschrieben hat.

### 24.6 Das Projekt kommt jetzt aus dem Git-Root

`root-match` hieß nur "ein Pfadsegment hieß workspace/src/code" und nahm das
ERSTE davon: `/Users/me/Projects/company/repos/real-repo/packages/core` ergab
"company", mit voller Zuversicht. Die Write-Lane filtert scharf gegen diesen
Namen und entfernt dann die Memories von `real-repo`.

Der nächstgelegene `.git`-Ordner ist die einzige Auskunft, die wirklich "hier
fängt ein Repo an" bedeutet; die Container-Heuristik bleibt der Rückfall. Kein
Prozess-Spawn — `existsSync` je Ebene, Ergebnis nach cwd gecacht, weil ein Hook
bei jedem Tool-Call mit demselben cwd feuert.

### 24.7 Portabilität derselben Identitätsklasse

`normalizeScopeKey` faltet jetzt Unicode: macOS legt Dateinamen in NFD ab,
Editoren liefern NFC — ungefaltet sind das zwei Scopes, und der Unterschied ist
unsichtbar. `extractWikilinks` erkennt ids aus nicht-lateinischer Schrift, die
`slugify()` seit dem Cyrillic/CJK-Fix erzeugen kann. `rel.startsWith("..")`
behandelte einen legitimen Vault-Unterordner namens `..sync` wie einen
Ausbruch. Und `isMarkdownFile()` ist die eine Extension-Regel: Der Initialscan
akzeptierte nur `.md`, der Watcher auch `.MD` — eine so benannte Datei war nach
jedem Neustart verschwunden.

## 25. Zehnte Runde: die Übergangsfälle (26.08.2026)

Der Audit nach Abschnitt 24 fand die Fälle, die zwischen den frisch gebauten
Invarianten hindurchgingen. Sein Satz dazu trifft es: Das Grün der Suite
widersprach den Befunden nicht — die Übergangsfälle fehlten schlicht.

### 25.1 Zwei Dateien mit einer id sind eine Antwort, kein Ratespiel

Der Vault erkennt seit #240/A2.3, dass zwei Dateien dieselbe id tragen, und
quarantäniert die zweite. Abfragbar war das nie: `get(id)` gab den Gewinner
zurück, als wäre er der einzige. Daran hing das Loch — der produktive
`vaultLocator` fragte nur `get()` und konnte `ambiguous` deshalb nie melden.
Ein Save lief durch und ließ das Duplikat bestehen, obwohl jede
Schreibentscheidung dort geraten wäre: Welche der beiden Dateien ist gemeint?

`Vault.pathsFor(id)` nennt jetzt alle Pfade. Eine gelöschte Datei fällt aus der
Quarantäne — sonst blockierte ein Zustand jeden Save, den es nicht mehr gibt.

Zwei Löcher derselben Wurzel im Bridge- und Import-Pfad: `auditedSave` kannte
das Re-Filing aus #64 nicht (ein `overwrite` mit geändertem `folder` schrieb die
neue Datei und ließ die alte liegen) und gab seinem `saveMemory` keinen Locator
mit, scannte also das Dateisystem, obwohl der Index in der Hand lag — und sah
dabei genau das `ambiguous` nicht, das nur der Vault kennt. Der Restore prüfte
nur seinen Zielpfad: Lebte dieselbe id inzwischen in einem anderen Regal,
landete die alte Version daneben.

Verglichen wird seither über Gerät und Inode, nicht über Pfadstrings. Auf einem
case-insensitiven Dateisystem sind `memories/People/x.md` und
`memories/people/x.md` DIESELBE Datei, und wer sie für verschieden hält,
verschiebt beim Aufräumen das einzige Exemplar in den Trash.

### 25.2 Der Lock lag auf dem Zielpfad, nicht auf der Identität

`saveMemory` nahm seinen Commit-Claim auf `<zielpfad>.bastra-write.lock`. Zwei
gleichzeitige Saves DERSELBEN id in verschiedene `folder`-Regale nahmen damit
zwei verschiedene Locks und gelangen beide. Der Kommentar über dem Lock sprach
schon von der id; die Umsetzung tat es nicht.

`commitLockPathFor(vaultRoot, id)` legt ihn unter `.bastra/locks/` — nicht neben
das Memory, wo er beim Re-Filing im falschen Regal zurückbliebe — und hasht den
id-Anteil, weil eine id Zeichen tragen darf, die auf manchen Dateisystemen
unbrauchbar sind.

### 25.3 Der Cache machte rohe Scores wieder zu fusionierten

Der Query-Cache speicherte das BM25-Ergebnis eines Vaults ohne Vektor-Arm, aber
nicht den Score-Modus. Derselbe Wert hieß beim zweiten Aufruf `rrf`: erster
Aufruf `bm25` bei 1997,338, zweiter `rrf` bei 1997,338 — und damit griffen 50
und 100 wieder auf eine rohe Zahl.

Gecacht wird weiter, aber mit Modus. Gegen die naheliegende Sofortlösung „gar
nicht cachen" spricht, dass `vector-arm-empty` eine Eigenschaft des VAULTS ist
und nicht des einzelnen Aufrufs: Ein Vault ohne Vektoren zahlte sonst dauerhaft
bei jedem Recall den vollen BM25-Pass plus Embed-Roundtrip. Timeout und
Provider-Fehler cachen unverändert gar nicht.

### 25.4 Drei Lanes kannten `unfused` nicht

Prompt, Todo und Write waren in Runde 21 umgestellt worden. SessionStart und
beide Bash-Lanes hatten eigene, ältere Response-Typen: SessionStart behauptete
bei einem rohen Score von 405585 "Both search paths agreed … score ≥100" und
sortierte bis zu drei unabhängig degradierende Antworten in einer Zahlenreihe.
In Bash-Fail umging `hasRequired` den Backoff — auf der offenen Skala riss
praktisch jeder Score die 100, der Backoff war dort faktisch abgeschaltet.

Ein gemeinsamer `HookRecallResponse` löst die lokalen Kopien ab, mit einem
fail-closed `isUnfused()`: Was nicht ausdrücklich `score_kind: "rrf"` sagt, gilt
als unfused. Die Bänder kommen aus einer zentralen `bandHits()`.

Bewusste Verhaltensänderungen, alle nur im unfused-Fall: Der Score-Floor
entfällt in allen drei Lanes; SessionStart mischt reihum pro Query statt nach
Score; Bash-Fail umgeht den Backoff nicht mehr; die Score-Zahl verschwindet aus
den Hint-Zeilen. Der fusionierte Pfad bleibt bit-identisch, gepinnt.

### 25.5 Unlesbar ist nicht abwesend

`readOccupant` behandelte JEDEN Lesefehler wie "Datei fehlt". Eine gewöhnliche
Obsidian-Notiz mit Dateimodus 000 am Sidecar-Pfad sah damit `absent` aus, und
der Schutz, der genau solche Notizen bewahren sollte, ließ das `rename` durch.
Nur ENOENT heißt jetzt `absent`; alles andere ist `unreadable` und blockiert
den Write. Auch ein unlesbarer ORDNER macht den Identitätsscan `incomplete`:
Ein Scan, der einen Teil des Vaults nicht sehen konnte, darf keine Aussage über
Eindeutigkeit treffen.

### 25.6 Pfadgleichheit ist keine Dateigleichheit

`memories/People/case-id.md` und `memories/people/case-id.md` sind auf APFS
DIESELBE Datei. Ein Stringvergleich hielt sie für zwei: Der Save schrieb sie,
meldete den anders geschriebenen Pfad zurück, und das Re-Filing verschob den
"alten" Pfad in den Trash — das einzige Exemplar. Der Aufruf meldete "Save
complete", während beide gemeldeten Pfade nicht mehr existierten.

`sameFile` vergleicht Gerät und Inode und antwortet im Zweifel "nicht
nachweisbar dieselbe", damit niemand aufräumt, was er nicht sehen kann.

### 25.7 Ein Symlink führte aus dem Vault heraus

`memories/linked -> /outside` plus `folder: memories/linked` erzeugte
`/outside/escaped.md`. Die lexikalische Prüfung sah nur den Textpfad.
`assertInsideVault` löst den tiefsten bereits existierenden Vorfahren per
realpath auf — dieselbe Prüfung, die der Restore schon hatte, jetzt zentral in
`file-identity.ts`.

### 25.8 Commons ist ein dritter Arm, kein zweiter Score-Raum

Die RRF-Umstellung aus Runde 24 kollabierte die persönliche Liste ERNEUT auf
Listenränge: Ein beidarmiger Rang 1 fiel von 163,934 auf 81,967, ein separater
Commons-Rang 1 erreichte bei Gewicht 0,8 nur 65,574. Bei einer Schwelle von 100
überlebte damit kein einziger getrennter Treffer, und `no_home` kippte, weil der
Kollaps den rrf-Beleg strippte, den `isNoHome` verlangt.

Der persönliche Score IST bereits `RRF_SCALE · Σ 1/(k+rang)` über seine Arme.
Commons wird deshalb ein DRITTER ARM: Der Rangbeitrag wird addiert. Ein
persönlicher Treffer bekommt mit aktiven Commons bitgleich denselben Score wie
ohne, und keine der Schwellen 30/50/100 musste angefasst werden — sie hängen an
neun Stellen, und ein zweiter Score-Raum hätte jeder davon eine zweite
Schwellentabelle beibringen müssen. Der Preis ist die Obergrenze: 241,803 statt
163,934, wenn Commons aktiv ist und beide persönlichen Arme Rang 1 liefern.

Der degradierte Pfad behält den Rang-Kollaps — rohe Werte sind nicht addierbar.

### 25.9 Kleinere Fälle derselben Klassen

Der Sidecar-Overwrite baute das Frontmatter neu, statt zu patchen, und verlor
`created`, `related`, `related_via`, `sensitivity`, `source`, `confidence` und
manuelle Aliase — für Recategorize und Move war das Muster in Runde 24 gebaut
worden, der Save-Pfad hatte es nicht bekommen.

Das Area-Rename war nicht transaktional: Scheiterte nach dem Memory-Regal das
Doku-Regal, blieb die Area geteilt und der Aufruf meldete Erfolg. Jetzt wird
zurückgerollt.

Die Reserved-Prüfung war case-sensitiv — auf APFS ließ sich `memories/projects`
über den Namen `Projects` als editierbarer Top-Bereich ansprechen und
vollständig umbenennen. Dasselbe im Document Hub (`scope !== "documents"`) und
im Recall-Handler (`scope === "commons"`, das ein `Commons` stillschweigend
abschaltete).

Im gemischten Batch nennt jeder Hit jetzt seinen eigenen Raum. Und die
Telemetrie trägt `score_kind` sowie separat `candidate_pool_score_kind`: Bei
aktiven Commons kamen `top_score` und `candidate_pool` aus verschiedenen
Skalen. Der Konsument zieht die Konsequenz — `harvestFarBridges` überspringt
`bm25`-markierte Einträge, weil sein `topScore >= 100`-Schnitt auf offener
Skala von jedem Treffer gerissen wird und dort dauerhaft falsche Bridges
gemintet hätte.
