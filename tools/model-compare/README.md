# Local model comparison on invented notes

Tools behind [`docs/local-model-comparison.md`](../../docs/local-model-comparison.md).
They need Node ≥ 22, the installed workspace dependencies and Ollama on
`127.0.0.1:11434`. They pull no model, build a throwaway vault and never touch a
real vault or a running daemon. Run one job at a time.

The tools send corpus and probe text only to a model server on this machine.
Every model and embedding URL (`--url`, `--chat-url`, `--embedding-url` and the
fixed addresses of `prefix.mts`) has to be a loopback address: `127.0.0.1`,
`::1` or `localhost`, without credentials or a query. Any other host stops the
tool before the first request, and a redirect is an error instead of being
followed. That matters when you run them on a corpus of your own notes. A result
file is refused inside `~/.bastra` and over an input file, also when a symlink
leads there.

| File | Purpose |
| --- | --- |
| `draft-judge.mts` | draft meaning check through the production prompts (or the decision endpoint) |
| `recall.mts` | recall with expansions written by a chosen model, three search paths |
| `rerank.mts` | bridge reranker: pick the right note of ten, or none |
| `prefix.mts` | vector-only recall with the text production embeds, with and without the embedding task prefixes (`embeddinggemma-2` on `127.0.0.1:11435`, skipped when absent) |
| `collect.py`, `render.py` | build `results/summary.json` from raw results and fill the tables of the docs page |
| `data/corpus.json` | 180 invented notes with three queries each |
| `data/blind-injection-probes.json`, `data/fresh-probes.json` | frozen probe sets; `fresh-probes.manifest.json` holds the hash |

The detailed notes below are in German.

---

## Details (Deutsch)

Benötigt Node ≥22, die installierten Workspace-Abhängigkeiten und Ollama auf
`127.0.0.1:11434`. Kein Pull, kein echter Vault, kein laufender Bastra-Daemon.
Die Skripte laden den normalen Test-Isolations-/Port-Guard selbst, bauen einen
Wegwerf-Vault und löschen ihn auch nach Fehlern. Nur explizite Ergebnisdateien
und Erweiterungs-Caches bleiben erhalten. Alle Inferenzaufrufe innerhalb eines
Laufs sind seriell. **Mehrere Läufe über dieselbe externe Warteschlange starten.**

Die Werkzeuge schicken Korpus- und Probentext nur an einen Modellserver auf
diesem Rechner. Jede Modell- und Embedding-URL (`--url`, `--chat-url`,
`--embedding-url` und die festen Adressen von `prefix.mts`) muss eine
Loopback-Adresse sein: `127.0.0.1`, `::1` oder `localhost`, ohne Zugangsdaten
und ohne Query. Jeder andere Host beendet das Werkzeug vor der ersten Anfrage,
und eine Weiterleitung ist ein Fehler, statt dass ihr gefolgt wird. Das zählt,
wenn die Werkzeuge auf einem Korpus aus eigenen Notizen laufen. Eine
Ergebnisdatei wird in `~/.bastra` und über einer Eingabedatei abgelehnt, auch
wenn ein Symlink dorthin führt.

## Recall: neue Erweiterungen und drei Suchwege

```sh
node --import tsx tools/model-compare/recall.mts \
  --corpus /pfad/corpus.json --expand-model gemma3:4b \
  --embedding-model embeddinggemma --out /tmp/recall-gemma3.json \
  --expansions-out /tmp/expansions-gemma3.json
```

`--limit 5` begrenzt **Notizen**, alle drei zugehörigen Abfragen bleiben dabei.
`--expand-model none` liefert die unveränderte Baseline. `--embedding-model none`
erlaubt einen rein lexikalischen Lauf ohne Modellaufruf; neue Erweiterungen sind
dabei ausgeschlossen, weil ihr Produktions-Selbsttest ein Embedding benötigt.

Erweiterungen laufen durch `TriggerExpander.expand`: Produktions-Prompt und
-Parser, `ollamaChat` mit Temperatur 0, `think:false`, Kontext 4096 und 120-s-Frist,
semantischer Selbsttest `recallHybrid(k=10, allow_private=true)`, normaler
Frontmatter-Writer und Source-Hash. Reihenfolge wie `vault.list()`; nach fünf
aufeinanderfolgenden Generierungsfehlern dieselbe Bremse wie beim Backfill.
Leerer Modellinhalt wird als Befund gespeichert und weder umgangen noch gestempelt.
`--timeout-ms` verändert ausschließlich die Generierungsfrist.

BM25/Hybrid nutzen die echten `SearchIndex.recall`/`recallHybrid`-Methoden mit
Produktionsgewichten, ohne zusätzliche Query-Erweiterung/Commons/Hops/Score-Floor.
Für vollständige Roh-Ränge wird `k=Notizanzahl` angefordert; die Produktions-Arme
des Hybrids bleiben auf jeweils 50 Kandidaten begrenzt. MRR gilt für diesen
zurückgegebenen Pool, nicht gefundene Ziele zählen 0. Vektor-only verwendet den
Produktions-Dense-Arm `EmbeddingIndex.searchDetailed` nach gleicher Query-Normalisierung.
Die JSON-Zeilen enthalten Query-ID, Query, Ziel, Rang, vollständige Trefferliste
und Laufzeit. `near`, `far`, `far_xlang` werden getrennt aggregiert.

## Identische Erweiterungen, anderes Embedding

```sh
node --import tsx tools/model-compare/recall.mts \
  --corpus /pfad/corpus.json --expand-model none \
  --expansions-in /tmp/expansions-gemma3.json \
  --embedding-model embeddinggemma-2:270m --out /tmp/recall-emb2.json
```

Der Replay prüft Source- und Prompt-Hashes und fragt das Chat-Modell nie erneut.
Er behält **dieselben bereits selbstgetesteten Phrasen**: Der Selbsttest wird
nicht mit dem neuen Embedding wiederholt. Sein ursprüngliches Einbettungsmodell
steht im Cache und im Ergebnis. So verändert sich nur die Suche, nicht deren
Erweiterungsbestand. Die unveränderten Produktions-Prompts erhalten keine Gold-Abfragen.

Ein kleiner, separat ausgewiesener Embedding-Aufruf ermittelt die reale Dimension;
anschließend setzt das Werkzeug `BASTRA_EMBEDDING_MODEL`/`BASTRA_EMBEDDING_DIM`
und baut den normalen Ollama-Provider mit `keep_alive=10m`. `--embedding-dim N`
kann die erwartete Dimension festlegen; ein Mismatch bricht ab. Rohtexte ohne
eigene Präfixe entsprechen dem Kern. Modelldigest und lokale Show-Metadaten
(Template/Parameter/Dimension) werden für spätere Vergleiche gespeichert.
Eine andere Dimension als 768 erfordert dieselbe DIM-Einstellung auch im Daemon.
`--embedding-url` und `--chat-url` erlauben bei Bedarf bereits vorhandene andere
Loopback-Server; beide bleiben standardmäßig auf `127.0.0.1:11434`. Keine URL
außerhalb Loopback wird akzeptiert. Das Werkzeug startet/aktualisiert keinen
Server und zieht kein Modell. Bei unterschiedlichen Serverversionen ist der
Vergleich entsprechend kein reiner Modellvergleich; die Versionen stehen im JSON.

## Bridges-Nachsortierung

```sh
node --import tsx tools/model-compare/rerank.mts \
  --corpus /pfad/corpus.json --model gemma3:4b \
  --embedding-model embeddinggemma --pool hybrid --out /tmp/rerank-gemma3.json
```

`--pool bm25` misst stattdessen lexikalisch erzeugte Negativkandidaten. Optional
`--expansions-in` verwendet dieselben Erweiterungen wie beim Recall. Pro Abfrage:
richtige Notiz + neun nächstgerankte falsche, dann zehn falsche ohne die richtige.
Lexikalische Nichttreffer werden hinter allen echten Treffern nach Korpusreihenfolge
ergänzt. Beide Pools werden reproduzierbar per SHA256 gemischt, die Zielposition
steht in den Rohdaten. Kleine Korpora liefern entsprechend kleinere Pools;
mit fünf Notizen sind R@5 und der Expander-Selbsttest entsprechend wenig aussagekräftig.

Prompt/Parser sind `buildRerankPrompt`/`parseRerankAnswer`, Kontext **8192** wie in
`cli/bridges.ts`, Temperatur 0, `think:false`, Frist 30 s (`--timeout-ms` optional).
Vorhanden/fehlend, drei Abfragearten, Trefferquote und Median/p95 sind getrennt.
Leere/ungültige Antworten werden als unbrauchbar gezählt; sie bekommen keinen
Gratis-Treffer für „keine gewählt“. Der Produktions-Parser bleibt unverändert:
zusätzlich steht im Ergebnis, ob die Antwort streng nur eine Zahl war.
Nach fünf aufeinanderfolgenden unbrauchbaren Antworten stoppt die Messung als
`stopped-unusable-model`; nicht gemessene Gruppen haben keine Trefferquote.
Dadurch hält ein defektes/leer antwortendes Modell die serielle Queue nicht mit
1080 Zeitüberschreitungen auf. Es wird kein Thinking-Workaround aktiviert.

Die Mini-Probe bestätigt die Mechanik, kein Modellranking. Laufzeithochrechnungen
aus fünf Notizen trennen Generierung, Embedding/Selbsttest und Nachsortierung;
bei 180 Notizen sind es 540 Retrieval-Abfragen pro Arm und **1080** Reranker-Aufrufe.
Die JSON-Ausgabe enthält eine ausdrücklich als Mini-Hochrechnung markierte
180-Notizen-Schätzung. Cache-Replays weisen null neue Generierungsaufrufe aus;
ursprüngliche Cache-Laufzeiten sind separat markiert.
