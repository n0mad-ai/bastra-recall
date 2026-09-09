# Query-Zeit-Rerank — Messplan und Modell-Spike zu #501

Stand 09.09.2026. **Nichts davon gehört in den Produktionspfad, und gelaufen
ist noch nichts.** Der Mess-Harness steht als Code (§6); die einzigen Zahlen
in diesem Dokument stammen aus dem Modell-Spike (§1), nicht aus einem Lauf.
#501 ist eine Entscheidungsfrage: Das Ergebnis ist eine Tabelle plus eine
Empfehlung an Daniel, kein ausgelieferter Reranker.

Dieses Dokument ist die **Voranmeldung** der Messung im Sinne von §18.3 — der
primäre Endpunkt, die freien Parameter, die Metriken und die
Entscheidungsschwellen stehen hier fest, bevor die erste Zahl existiert. Wer
die Empfehlung nachträglich an die Zahl anpasst, die zufällig herauskommt, hat
#501 nicht beantwortet.

**Registrierungsversion 2** (`registrations/rerank-decision.json`), geändert am
09.09.2026, 19:11 UTC. Version 1 hatte weder einen primären Endpunkt noch eine
Präzedenzregel und beschrieb einen Sprach-Wächter, den kein Code ausführte;
außerdem maß sie Rang ohne den Score-Floor. **Version 1 hat keinen einzigen
Lauf getragen** — zum Zeitpunkt der Änderung existierte keine Qualitäts- und
keine Latenzzahl aus dem Harness. Die Belege dafür stehen in
`$comment_amendment` der Registrierungsdatei und sind ohne Kenntnis der
Beteiligten prüfbar.

Vorbedingung ist #500 (LongMemEval als externer Arm). Der Messteil beginnt erst,
wenn dessen Läufe gelandet und committet sind.

---

## 1. Der Modell-Spike: was auf dieser Maschine wirklich läuft

Die eine echte Unbekannte aus #501 war, ob ein lokaler, kleiner Cross-Encoder
hier überhaupt beschaffbar und lauffähig ist. Antwort: **ja**, und der Weg ist
Node, nicht Python.

### Laufzeit

| Weg | Befund |
|---|---|
| **transformers.js (`@huggingface/transformers`, ONNX Runtime in Node)** | funktioniert, in-process, kein Modellserver, kein Netzaufruf zur Laufzeit nach dem einmaligen Download. **Das ist der Weg.** |
| Ollama | scheidet aus: Ollama hat keinen Rerank-Endpunkt. Ein Cross-Encoder ist ein Sequenz-Klassifikator, kein Generator; man müsste ihn über einen Generator-Hack nachbauen. |
| Python-Sidecar (`sentence-transformers`) | nicht nötig und teuer: ein zweiter Prozess, ein zweites Laufzeit-Ökosystem, IPC im Abfragepfad. Nebenbefund: das systemweite Python ist 3.14, für das es zum Messzeitpunkt keine Torch-Wheels gibt — ein Sidecar bräuchte erst ein eigenes 3.12-venv über `uv`. |

Maschine: Apple M4 Pro, 24 GB. Node v24.16.0. Alle Zahlen unten sind CPU-ONNX,
keine GPU — der dichte Arm (Ollama) belegt sie ohnehin.

### Modelle: gemessen, nicht vermutet

Getestet wurde jeweils die echte Ladung plus mindestens ein echtes
(Query, Kandidat)-Paar. Die Testquery ist deutsch, weil der Vault es ist.

| Modell | ONNX auf HF | Deutsch | Befund |
|---|---|---|---|
| `Xenova/ms-marco-MiniLM-L-6-v2` | ja (q8 23 MB, fp32 97 MB) | **nein** | Englisch tadellos (Berlin-Klassiker: +8.85 gold vs −11.25 Distraktor, fp32; q8 +8.71 — Quantisierung kostet hier nichts). Auf Deutsch bricht es zusammen: Gold −11.16, Distraktor −11.30. **Kein Signal. Für unseren Vault unbrauchbar.** Gleiches gilt für die L-4/L-12-Geschwister — dieselben Trainingsdaten, dasselbe Sprachproblem. |
| **`cross-encoder/msmarco-MiniLM-L6-en-de-v1`** | ja (nur fp32, 416 MB — kein quantisiertes File im Repo) | **ja, EN+DE** | Deutsch sauber und **abgestuft**: Gold +1.75, thematisch verwandter Distraktor („Kfz-Werkstatt-Termin") −7.41, unverwandte −10.97 / −11.10. 6 Layer, hidden 384 → billigstes Kandidatenmodell. **Der Favorit.** |
| `Xenova/bge-reranker-base` | ja (q8 273 MB, fp32 1,0 GB) | ja (XLM-R) | Deutsch funktioniert: Gold −3.01 (q8) / −4.32 (fp32), Distraktoren ≈ −10.18. Aber der Negativ-Schwanz ist **flach**: der verwandte Distraktor bekommt denselben Wert wie die völlig unverwandten. 12 Layer, hidden 768 → 3,3× teurer als der Favorit. |
| `onnx-community/bge-reranker-v2-m3-ONNX` | ja | ja | nicht gespiked. 568M Parameter, XLM-R-large-Klasse — nach den Zahlen unten mit Sicherheit über Budget. Nur relevant, falls die Messung zeigt, dass Rerank-Qualität überhaupt trägt und wir dann nach der Obergrenze fragen. |
| `onnx-community/Qwen3-Reranker-0.6B-ONNX` | ja (nur q4 / quantized) | ja | nicht gespiked. 0,6B Parameter als kausales LM mit Yes/No-Logit — Architektur und Prompt-Format werden von transformers.js nicht out of the box als `SequenceClassification` bedient. Hoher Integrationsaufwand, nach den Zahlen unten sicher über Budget. **Nicht weiterverfolgen, außer als Qualitäts-Obergrenze in einer reinen Offline-Messung.** |
| `jinaai/jina-reranker-v2-base-multilingual` | ja | ja | nicht gespiked. XLM-R-base-Klasse, also Kostenprofil ≈ `bge-reranker-base`. Fällt mit diesem zusammen. |
| `mixedbread-ai/mxbai-rerank-base-v2` | **nein** | — | kein ONNX im Repo. Ohne Konvertierung nicht nutzbar. Raus. |

**Kein Blocker.** Es gibt mindestens ein lokales, kleines, deutsch-fähiges
Modell, das hier nachweislich läuft.

### Kosten, gemessen

`cross-encoder/msmarco-MiniLM-L6-en-de-v1`, fp32, CPU, ein Batch pro Aufruf,
15 Wiederholungen warm, M4 Pro. Die Zeile „Ladung" ist der Kaltstart des
Modells im Prozess (Datei bereits im Cache, kein Netz).

| Passagenlänge | N | erster Aufruf | warm p50 | warm p95 |
|---|---:|---:|---:|---:|
| **191 Token/Paar** (Titel + Summary + Body-Anfang) | 10 | 73 ms | **77 ms** | 92 ms |
| | 20 | 162 ms | **178 ms** | 195 ms |
| | 30 | 265 ms | **286 ms** | 301 ms |
| **80 Token/Paar** (nur Titel + Summary) | 10 | 29 ms | **26 ms** | 32 ms |
| | 20 | 48 ms | **52 ms** | 55 ms |
| | 30 | 92 ms | **83 ms** | 108 ms |

Ladung: 446–507 ms bei kaltem Prozess mit warmem Dateicache.

Zum Vergleich `Xenova/bge-reranker-base` (q8, 191 Token/Paar): N=10 → 263 ms
p50, N=20 → 580 ms, N=30 → 956 ms. **Das ist bereits allein über dem
500-ms-Hook-Budget und damit erledigt**, solange die Passagen lang sind.

### Was diese Zahlen sofort bedeuten

1. **Die Passagenlänge ist der teuerste Hebel, nicht N.** Zwischen 80 und 191
   Token liegt Faktor 3,4. Sie ist deshalb ein voranzumeldender freier
   Parameter (siehe §3), keine Implementierungslaune.
2. **Der Rerank-Text muss kurz sein, sonst ist die Frage schon beantwortet.**
   Bei 191 Token frisst N=30 mit 286 ms mehr als die halbe Hook-Frist, während
   der Recall selbst in der Prompt-Lane laut der #466-Telemetrie im Code-Kommentar (`search.ts:1040`ff., 06.–08.09.) bei bm25 p50 329 ms / vector p50 336 ms überlappt liegt.
3. **`bge-reranker-base` ist als Query-Zeit-Modell tot**, kann aber als
   Offline-Qualitätsreferenz mitlaufen: Wenn selbst es keinen R@3-Lift bringt,
   ist die Rerank-Hypothese als Ganzes widerlegt und nicht nur das billige
   Modell zu schwach. Das ist das billigste Gegen-Experiment, das wir haben.
4. Diese Zahlen sind **Modellkosten in Isolation**, keine Ende-zu-Ende-Latenz.
   Die echte Zahl aus Schritt 2 von #501 wird auf dem echten Pfad gemessen
   (§4), nicht hieraus hochgerechnet.

---

## 2. Wo eine Rerank-Stufe säße — und warum die Messung nichts nachbaut

`SearchIndex.recallHybrid` (`packages/core/src/search.ts:870`) läuft:

```
query.parse → [vector.search ‖ bm25.search] → rrf.fuse → staleness.rank → (hops) → slice(k)
```

- `rrf.fuse` (`search.ts:1166`) fusioniert `bm25Top` (50) und `vectorTop` (50)
  über `fuseRRF` und materialisiert die besten `HOP_SEED_POOL = max(k*4, 20)`
  Kandidaten in `outFull`.
- `staleness.rank` (`search.ts:1218`) dämpft diesen Pool und sortiert neu →
  `rankedFull`.
- **`opts.onCandidatePool?.(rankedFull)` (`search.ts:1226`)** reicht genau
  diesen gedämpften, noch nicht auf k geschnittenen Pool nach außen — der
  #121-Kanal, mit Null-Overhead wenn nicht gesetzt.
- Erst danach `slice(0, k)`.

**Die Rerank-Stufe säße zwischen `staleness.rank` und `slice(0, k)`.** Sie
würde `rankedFull[0..N)` neu ordnen und dann erst schneiden.

Und genau deshalb muss die Messung **keine einzige Produktionszeile anfassen**:
`onCandidatePool` liefert exakt die Liste, die eine echte Rerank-Stufe sehen
würde, in derselben Reihenfolge und auf derselben Score-Skala wie die
servierten Hits (#365/16). Der Offline-Replay ruft also den echten
`recallHybrid` — echter BM25, echter `EmbeddingIndex` über den echten
Ollama-Provider, echtes `fuseRRF`, echte Staleness — hängt sich an den Pool und
sortiert ihn im Harness um. Dieselbe Regel wie #103 und #500: Eine Zahl, die
anders entsteht, beschreibt einen Retriever, den wir nicht ausliefern.

### Die Tiefenfalle, benannt

`HOP_SEED_POOL = max(k*4, 20)`. `goldset-run.ts` misst mit `PRODUCTION_K = 10`
→ Pooltiefe **40**. `longmemeval-run.ts` (#500) läuft mit `k = 20` → Tiefe 80.
Beide decken N ∈ {10, 20, 30} ab, **ohne dass eine Produktionskonstante
angefasst wird**. Wer stattdessen naiv die servierten Hits rerankte, hätte bei
`k = 10` gar keine 30 Kandidaten und würde eine Deckelung als Rerank-Ergebnis
messen.

### Grenze der Messung, ehrlich benannt

Der Pool ist auf `bm25Top` (50) ∪ `vectorTop` (50) beschränkt. Ein Gold, das in
keinem der beiden Arme in den Top 50 steht, kann kein Rerank retten. Nach #103
(99/115 Far-Golds im Pool) und #118 (tiefer Pool holt 12 weitere, **keines**
erreicht die Top 3) ist das genau der Zustand, den #501 adressiert — die
Obergrenze des Hebels ist also `recall_any@N`, und die wird pro Lauf
mitberichtet. Ohne diese Zahl ist ein kleiner Lift nicht von einem
ausgeschöpften Hebel zu unterscheiden.

---

## 3. Voranmeldung: freie Parameter

Festgelegt, bevor eine Zahl existiert.

### Der primäre Endpunkt — genau eine Zahl entscheidet

> **ΔR@3, Gold-Satz, Modell `en-de`, Passage `short`, N=10**, gepaart über die
> 584 beantwortbaren Nicht-Probe-Fälle, Bootstrap-KI95 aus 10 000 Resamples,
> Seed 20260909.

Alles Übrige — jedes andere N, jede andere Passagenlänge, `bge`, `ms-marco`,
R@1/R@5, alle Sprach-, Pool- und `weak_result`-Slices — ist **exploratorisch**
und trägt **keine** Empfehlung, auch keine abgeschwächte.

Warum das nötig ist: Ein voller Lauf produziert mehrere hundert
Konfidenzintervalle (der Lauf zählt sie und druckt die Zahl; die Prüfung von
Version 1 kam für die damalige Armform auf 180). Bei α=0.05 sind mehrere davon
auch unter reinem Rauschen „signifikant". Ohne einen designierten Haupttest
wäre der Befund schlicht die Zelle, die zufällig gut aussieht.

Warum **diese** Zelle: N=10 mit kurzer Passage ist die einzige Kombination, die
die Latenzschwelle überhaupt bestehen kann — 26 ms p50 im Spike, während
`short`/N=20 mit 52 ms bereits an der 50-ms-Schwelle scheitert. Ein Lift, der
erst bei N=30 oder auf der langen Passage erscheint, ist unabhängig von seiner
Größe unbezahlbar. Der Haupttest gehört dorthin, wo die Entscheidung fällt.

Er steht als Konstante `PRIMARY` im Runner, damit der Lauf ihn markiert und
kein Leser ihn aus einer Zeilenposition erschließen muss.

### Gemessen wird in der Produktionsreihenfolge — mit Score-Floor

Produktion serviert `slice(0, k)` und der Konsument verwirft alles unter
`BASTRA_RECALL_FLOOR` (30). Rang wird deshalb **nach beidem** gemessen:

```
Rerank des N-Fensters → slice(0, PRODUCTION_K=10) → Floor 30 → R@k
```

Ohne den Floor bekäme der Reranker gutgeschrieben, einen Kandidaten unter die
Top 3 gehoben zu haben, den Produktion nie zeigt — die Verzerrung zeigt also
ausgerechnet Richtung „einbauen". Die floor-freie Zahl läuft als ausdrücklich
benannte **Obergrenze** daneben mit, nie als Schlagzeile.

**Drei offene Designfolgen, die daraus fallen und in Daniels Entscheidung
gehören.** Keine davon ist hier gemessen, und keine ist eine Latenzfrage:

1. **Band-Semantik.** Eine Stufe, die nur *umsortiert*, lässt den
   veröffentlichten `score` auf dem RRF-Wert stehen — damit ist der Score nicht
   mehr monoton im Rang, und genau darauf sitzen die Bänder (30/50/100,
   `MUST_LOAD` bei 100). Ein ausgelieferter Reranker müsste also auch
   entscheiden, *was er als `score` veröffentlicht*.
2. **Die Trefferliste wird kürzer.** `slice(k)` läuft vor dem Floor. Ein
   Rerank, der Kandidaten unter Floor 30 nach vorn holt, belegt damit
   Top-10-Plätze, die der Floor anschließend leert — während die hoch
   bewerteten Treffer, die diese Plätze gefüllt hätten, auf Rang 11+ gerutscht
   sind. **Der Nutzer sieht dann weniger Treffer als vorher.** Der Harness
   bildet das korrekt ab, der gemessene Lift enthält es also; als
   Produktwirkung ist es aber eine eigene Aussage und für die Entscheidung
   mindestens so wichtig wie die Millisekunden.
3. **`isNoHome` (#230)** in `weak-result.ts:88-95` liest `hits[0]` und dessen
   `rrf`-Block. Eine reine Umsortierung wechselt den Spitzentreffer und damit
   dieses Signal — ganz ohne Score-Frage. Genau deshalb wird `weakResult` auf
   dem **Baseline**-Ranking berechnet, nie auf dem gererankten.

### Grenze des Sprach-Wächters

Er prüft die **Query**-Sprache, nicht die Passagensprache. Die Passagen kommen
aus dem Vault und sind deutsch, egal in welcher Sprache die Query steht — der
Wächter trägt also nur, solange Vault- und Query-Sprache zusammenfallen. Auf
beiden registrierten Sätzen ist das der Fall (auf Gold sind nur zweisprachige
Modelle registriert, auf LongMemEval sind Korpus und Fragen beide englisch),
aber das ist eine Eigenschaft der Daten, nicht des Wächters. Festgehalten,
damit ein künftiger Satz mit auseinanderfallenden Sprachen nicht stillschweigend
durchkommt.

### Das Degradations-Gate aus #428 gilt hier genauso

`recallHybrid` feuert `onCandidatePool` **auch aus dem BM25-Rückfall**
(`search.ts:840`) — mit rohen BM25-Scores in BM25-Reihenfolge. Ein ungegatetes
Replay hätte solche Zeilen unerkannt in einen Nenner gezählt, der „hybrid"
heißt. Der Lauf geht deshalb durch `gatedHybridRecaller`, dasselbe Gate wie im
Gold-Runner: Ein degradierter Fall beendet den Lauf, statt in die Messung zu
gehen.


| Parameter | Wert(e) | Begründung |
|---|---|---|
| Modell (Hauptarm) | `cross-encoder/msmarco-MiniLM-L6-en-de-v1`, fp32 | einziges gespiketes Modell mit abgestuftem Deutsch-Signal bei MiniLM-L6-Kosten |
| Modell (Qualitätsreferenz, nur offline) | `Xenova/bge-reranker-base`, q8 | beantwortet „ist das Modell zu schwach oder die Hypothese falsch?" |
| N | 10, 20, 30 | aus #501 |
| Rerank-Text | **A: `title` + `summary`** (≈80 Token), **B: `title` + `summary` + `body[0..400]`** (≈191 Token) | beide, weil der Faktor 3,4 zwischen ihnen die Entscheidung dominiert. Nicht mehr als zwei — sonst ist es eine Suche nach der besten Zahl. |
| Fusion Rerank ↔ RRF | **reines Rerank-Ranking** (Cross-Encoder-Logit ordnet allein) | die einfachste Variante zuerst. Eine Score-Mischung ist ein zweiter freier Parameter und wird erst voranzumelden sein, wenn die einfache Variante trägt. |
| Sätze | **Gold-Satz** (`~/.bastra/eval-goldset/`) **trägt die Empfehlung**; **LongMemEval** (#500) liefert die extern vergleichbare Kontrollzahl | siehe „Der Sprachschnitt" unten |
| Metriken | R@1 / R@3 / R@5, `recall_any@N` als Deckel, dazu Δ gegen den unrerankten Lauf | |
| Signifikanz | gepaart pro Query, Bootstrap-KI und Vorzeichen-Permutationstest — wie `rrf-k-beir.ts` es für RRF_K gemacht hat | ein Lift ohne KI ist kein Befund |
| Staleness | wirkt **vor** dem Rerank (der Pool ist der gedämpfte) | so säße die Stufe auch in Produktion |

Nicht Teil der Messung: Score-Mischung, gelernte Schwellen, Rerank auf dem
Body in voller Länge, Quantisierung des Favoriten (es existiert kein
quantisiertes File; eine Eigenkonvertierung wäre ein eigenes Vorhaben und
kommt erst in Frage, wenn der Lift trägt).

### Der Sprachschnitt — sonst vergleicht die Messung Sprachen statt Modelle

Die beiden Sätze sind sprachlich nicht dasselbe, und der Hauptarm ist ein
zweisprachiges Modell. Ohne feste Zuordnung wäre ein Modellvergleich über die
Sätze hinweg wertlos: Auf dem englischen LongMemEval könnte das reine
`ms-marco-MiniLM` besser abschneiden als der EN+DE-Favorit, und das sagte über
unseren Produktionsfall genau nichts.

Deshalb, festgelegt vor der ersten Zahl:

| Satz | Sprache | Modelle | Rolle |
|---|---|---|---|
| **Gold-Satz** | überwiegend deutsch (Zusammensetzung unten) | Favorit + `bge-reranker-base` | **entscheidet die Produktionsempfehlung** |
| **LongMemEval** | englisch | Favorit + `bge-reranker-base` + `ms-marco-MiniLM-L-6-v2` | extern vergleichbare Kontrollzahl, plus die Probe, ob der Zweisprachigkeits-Aufschlag auf Englisch Qualität kostet |

`ms-marco-MiniLM-L-6-v2` läuft **nur** auf LongMemEval. Auf dem deutschen Satz
ist es gemessen signallos (§1) — es dort mitlaufen zu lassen produzierte eine
Zahl, die niemand als Modellaussage lesen dürfte.

Ein Lift, der auf LongMemEval erscheint und auf dem Gold-Satz nicht, ist damit
kein Widerspruch, sondern ein Sprachbefund — und die Empfehlung folgt dem
Gold-Satz.

### Die Nenner des Gold-Satzes, ausgezählt

699 Fälle in 12 Dateien. Davon 36 Probe-Fälle (`probe_group`), die wie überall
aus dem Hauptnenner fallen, und 79 `no_answer`-Fälle, die ihren eigenen Zweck
haben (siehe unten). Bleiben **584 beantwortbare Nicht-Probe-Fälle**:

| `lang` | n |
|---|---:|
| `de` | 272 |
| `neutral` | 205 |
| `en` | 103 |
| `mixed` | 4 |

Zwei Slices werden deshalb **getrennt berichtet**, und beide sind vorher
angemeldet, nicht nachträglich gefunden:

- **`de` vs. `en` innerhalb des Gold-Satzes.** Der Favorit ist zweisprachig; ob
  er auf beiden Seiten trägt, ist eine Zahl und keine Annahme.
- **`neutral` (205 Fälle) getrennt von Prosa.** Das sind Keyword-Ketten aus
  Hooks („memory format schema json yaml markdown frontmatter"), keine Fragen.
  Ein Cross-Encoder ist auf natürlichsprachige Query-Passage-Paare trainiert;
  dass er auf Stichwortketten trägt, ist eine offene Frage und kein Detail —
  35 % des Nenners hängen daran. Wenn der Lift nur auf Prosa auftritt, ist die
  richtige Empfehlung womöglich „nur für Prosa-Queries", und diese Form muss
  messbar sein, bevor jemand sie erfinden kann.

### Die Gegenprobe: die 79 `no_answer`-Fälle

Ein Reranker kann R@3 heben und trotzdem schaden, indem er auf Fragen ohne
Antwort selbstbewusst etwas nach oben sortiert. Die `no_answer`-Fälle sind
dieser Test und laufen als **Guard** mit, nicht als Lift-Metrik: berichtet
wird, ob der Rerank auf ihnen die Spitzenposition verändert. Die Schwelle steht
in §5.2 (≤ 20 %), und eine Verschlechterung kippt „immer an" unabhängig davon,
wie gut R@3 aussieht.

**Grenze der Aussagekraft, und sie ist hart:** Ein Top-1-Wechsel auf einer
unbeantwortbaren Frage ist **per se kein Schaden** — dort gibt es keine
richtige Antwort, und beide Kandidaten sind gleich falsch. Die Metrik misst
allein, ob der Rerank diese Teilmenge *systematisch* umsortiert. Die 20 % sind
ein Veto-Auslöser und **keine Qualitätsaussage**; sie dürfen später nicht als
eine gelesen werden. „Gegenprobe" ist damit schon zu viel gesagt: Der Guard
kann ein Veto begründen, aber nichts belegen.

### Abhängigkeit — und was sie wirklich kostet

`@huggingface/transformers` (`^4.2.0`, die Version, auf der die Zahlen in §1
gemessen wurden) kommt als **`devDependency` von `@bastra-recall/eval`** hinzu
— reine Eval-Abhängigkeit, in keinem ausgelieferten Paket. Bedingungen, unter
denen das entschieden wurde: sie taucht **nirgends** in den
Runtime-Abhängigkeiten von `core` oder `daemon` auf, und **sie wird wieder
entfernt, falls #501 mit „schließen" endet.** Ohne sie wäre die Messung nicht
reproduzierbar committet, und das wäre der schlechtere Zustand.

Der Fußabdruck gehört dazu, weil er kein kleiner Anhang ist. Ausgezählt gegen
den Lockfile-Stand davor:

| | |
|---|---|
| neue Lockfile-Einträge | **69**, alle `dev: true` |
| davon optional / plattformspezifisch | 26 |
| bewegte bestehende Versionen | **0** |
| entfernte Einträge | **0** |
| Platz in `node_modules` | ~226 MB (`onnxruntime-node` 210 MB, `@huggingface` 14 MB) |

Die 69 zerfallen in vier Gruppen: ONNX-Runtime (8), `sharp` und seine 25
Plattform-Binaries (29), protobufjs (10) und der Binary-Downloader-Unterbau
von `onnxruntime-node` (`global-agent`, `adm-zip`, `roarr`, `serialize-error`
und Umfeld, 19). **`sharp` ist eine Bildbibliothek**, die transformers.js für
Bildmodelle mitbringt, die wir nie anfassen — sie ist mitgeschleppt, nicht
gebraucht. Falls #501 mit „immer an" endete und daraus je eine
Produktionsabhängigkeit würde, wäre genau das der Punkt, an dem man eine
schlankere ONNX-Anbindung suchen müsste. Für einen Eval-Pfad ist es vertretbar.

**Korrektur zu einem früheren Nebenbefund:** In der Commit-Message von
`f095a94` steht, der Lockfile-Refresh habe `@hono/node-server` von 2.0.5 auf
2.1.1 gezogen. **Das stimmt nicht.** 2.1.1 stand schon vorher im Lockfile,
identisch bei `3476718` und danach; die Tabelle oben zeigt null bewegte
Versionen. Der Fehlbefund entstand beim Lesen des Diffs — ein 1055-Zeilen-
Einschub verschiebt den Block, sodass unveränderte Zeilen einmal als `-` und
einmal als `+` erscheinen. Die Commit-Message bleibt stehen (kein
History-Rewrite); maßgeblich ist diese Korrektur. Ein „Zurückdrehen" auf 2.0.5
hätte keine Drift behoben, sondern eine erzeugt.

---

## 4. Die Latenzmessung — und wie sie nicht Ollama misst

Schritt 2 von #501 verlangt p50/p95 **zusätzliche** Latenz, kalt und warm. Die
Falle ist offensichtlich und wird hier ausdrücklich umgangen: Auf dieser
Maschine teilen sich Ollama (dichter Arm) und der Rerank dieselbe Hardware. Ein
naiv gemessener Ende-zu-Ende-Zeitunterschied misst zu einem beliebigen Anteil
Ollama-Last, Modell-Kaltstart und Circuit-Breaker — und würde diese als
Rerank-Kosten ausweisen.

Deshalb:

1. **Die Zusatzlatenz ist eine direkte `hrtime`-Spanne um die Rerank-Stufe,
   keine Differenz — und sie kürzt deshalb nichts.** Last auf der Maschine
   während der Spanne geht voll in die Zahl ein.

   Eine frühere Fassung dieses Abschnitts nannte sie eine „gepaarte Differenz,
   in der sich Ollamas Verhalten wegkürzt". Das war falsch und in sich
   widersprüchlich: Das Kürzungsargument gilt für die **Qualitäts**-Deltas —
   dort steht Ollamas Zustand tatsächlich in beiden Hälften derselben gepaarten
   Differenz — und wurde fälschlich auf die Latenz ausgedehnt. Die reale
   Absicherung der Latenzzahlen ist **prozedural**: exklusiver Lauf (Punkt 6)
   und Verwerfen kontaminierter Läufe (Punkt 5). Das ist Disziplin, keine
   Statistik, und wird hier nicht als Statistik ausgegeben.

   Entlastend, aber kein Ersatz: `embeddinggemma` liegt zu 100 % auf der GPU,
   der Cross-Encoder rechnet auf der CPU. Die Konkurrenz ist geringer als bei
   einer gemeinsamen Recheneinheit, aber nicht null — ONNX Runtime nimmt
   mehrere CPU-Threads, Ollamas HTTP und Tokenisierung kosten ebenfalls CPU.
2. **Basislinie ist derselbe Aufruf ohne Rerank**, gemessen an derselben
   Stelle (`staleness.rank` fertig → `slice(0, k)`), nicht ein anderer Lauf und
   nicht die Telemetrie eines anderen Tages.
3. **Der Rerank läuft in-process, synchron, nach dem `await` auf den dichten
   Arm.** Er kann sich mit ihm nicht überlappen und braucht deshalb auch keine
   Überlappungskorrektur wie `vector.search` (#370/#466).
4. **Kalt heißt: erster Aufruf in einem frischen Prozess**, Modelldatei im
   Cache, Netz aus. Zwei Zahlen getrennt berichtet: Modell-Ladung (einmalig pro
   Prozess, ≈450–510 ms gemessen) und erster Score-Aufruf. Sie werden **nicht**
   addiert in eine „kalte p95" — die Ladung ist ein Prozessstart-Kostenpunkt
   und gehörte in Produktion in die Prewarm-Lane (#361), nicht in den Recall.
5. **Ollama-Kontention wird gemessen statt weggeredet.** Der Lauf hängt einen
   `onStage`-Listener ein und protokolliert `vector.search.wait_ms`,
   `timed_out` und `provider_outcome`; die Summe steht als `dense_arm_health`
   in Tabelle und Artefakt. Ein Lauf, in dem der dichte Arm auffällig oft in
   die Frist läuft, ist kein gültiger Latenzlauf und wird verworfen, nicht
   interpretiert. **Das war bis Version 1 der Registrierung eine Regel ohne
   Instrument:** Es gab keinen `onStage`-Listener im Harness, die drei Felder
   wurden nirgends erfasst, und das Verwerfungskriterium war nicht ausführbar.
6. **Der Latenzlauf ist eine Stichprobe (`--latency-sample`, Default 40), kein
   Vollauf.** Über alle 584 Fälle × 6 Kombinationen wären es ~25 Minuten reine
   Inferenz je Modell — ein Lauf, den man nicht wiederholen kann, ist gegen
   Kontention nicht abzusichern, und Wiederholbarkeit ist hier die einzige
   echte Verteidigung.
7. **Keine parallele Modellarbeit auf der Maschine während des Latenzlaufs.**
   Der Qualitätslauf (§3) darf parallel laufen, der Latenzlauf nicht.

### Jede Latenzzahl ist eine untere Schranke, und sie wird so etikettiert

Gemessen wird auf **einem M4 Pro — der schnellen Seite der Hardware-Stufen.**
Eine Hardware-Matrix wird nicht aufgebaut; die Maschinen dafür gibt es nicht
und vor 1.0 lohnt sie nicht. Stattdessen trägt **jede** Latenzzahl im Bericht
das Etikett „M4 Pro, schnelle Seite", und die Empfehlung sagt ausdrücklich,
dass „immer an" auf langsamerer Hardware ein Vielfaches kostet.

Das ist die nützliche Richtung der Schranke: **Was hier schon grenzwertig ist,
ist überall entschieden.** Umgekehrt gilt es nicht — eine hier bequeme Zahl
sagt über einen M1 mit 8 GB nichts, und genau dafür existiert #492.

Berichtet wird gegen die Fristen, die es wirklich gibt: das ~500-ms-Hook-Budget
(#118), die drei festen Dense-Arm-Fristen 150 / 350 / 1500 ms aus #492 und das
kumulative Kontextbudget aus #458 — letzteres ist kein Zeitbudget, taucht aber
in der Empfehlung auf, weil ein Rerank die Zusammensetzung dessen ändert, was
das Budget füllt.

---

## 5. Die Entscheidungsform — vor der Zahl festgelegt

Die Lieferung ist eine Tabelle (N, R@3-Lift, R@5-Lift, zusätzliche p50,
zusätzliche p95) plus eine Empfehlung. Damit die Empfehlung nicht hinterher an
die Zahl angepasst wird, steht hier, welcher Befund welche Form rechtfertigt —
durchgehend mit Zahlen. „Im Wesentlichen", „deutlich" und „etwa" kommen in
diesem Abschnitt nicht mehr vor; sie standen in Version 1 und waren vier
Stellen, an denen sich hinterher argumentieren ließe.

Schätzer überall: **Bootstrap-KI95 über die gepaarten Deltas**, Werte in
Prozentpunkten (pp), Satz jeweils benannt.

### Präzedenz

Geprüft in dieser Reihenfolge, **erste zutreffende Form gewinnt**,
Voreinstellung „nicht ausliefern":

1. `schließen` · 2. `immer an` · 3. `nur weak_result` · 4. `nur Prosa` ·
5. `ab Poolgröße` · 6. `Auffangregel`

Die Bedingung von Form 1 enthält **bewusst** die Negation der Formen 3–5. Ohne
das würde „schließen zuerst" die bedingten Formen strukturell unerreichbar
machen — ein null-Primärtest bei großem `weak_result`-Lift ist genau der Fall,
für den Form 3 existiert — und die Reihenfolge wäre bedeutungslos.

### 1. `schließen` — alle drei
- **primär:** Δ < 2.0 pp **oder** KI95 schließt 0 ein;
- **keine** der Formen 3–5 erfüllt ihre eigene Schwelle;
- `bge` bei N=30/`body` auf dem Gold-Satz zeigt dasselbe.

Dazu **verpflichtend** die Klassifikation aus §5.7. Kein Nachschieben weiterer
Modelle, um doch noch einen Lift zu finden.

### 2. `immer an` — alle sechs
- **primär:** KI95-Untergrenze > 0 **und** Δ ≥ 2.0 pp;
- **Sprach-Veto:** weder auf `de` (n=272) noch auf `en` (n=103) liegt die
  KI95-**Obergrenze** unter 0. Als Obergrenze formuliert, nicht als
  Punktschätzer: `en` kann bei n=103 einen negativen Punktschätzer aus Rauschen
  erzeugen, und verboten sein soll nur „dieser Slice ist nachweislich
  geschädigt";
- **Latenz:** zusätzliche p95 ≤ 50 ms bei N=10/`short` **auf dem M4 Pro** —
  bewusst streng, weil es eine untere Schranke ist (§4);
- **Rang-Regression ≤ 15 %.** Ersetzt „kein Gold verliert Rang": das gilt über
  hunderte Fälle nie, hätte „immer an" also unabhängig von den Daten
  ausgeschlossen — ein totes Kriterium, kein strenges;
- **`no_answer`-Guard:** Top-1 wechselt auf ≤ 20 % der Fälle;
- **`recall_any@10` < 100 %** — sonst ist der Hebel per Konstruktion
  ausgeschöpft und der Lift kann nicht vom Rerank kommen.

### 3. `nur wenn weak_result` sonst feuern würde
Teilmenge: Fälle, für die `isWeakResult(served, true)` auf dem **Baseline**-
Ranking wahr ist — das ausgelieferte Prädikat aus
`packages/core/src/weak-result.ts`, im Harness angeschlossen, **nicht**
nachgebaut.
- **mindestens 50 Fälle**, sonst „nicht auswertbar" statt Ergebnis;
- Δ ≥ 5.0 pp **und** KI95-Untergrenze > 0 **und** ≥ 2 × der primäre Δ.

Das ist der Fall, in dem der Rerank kein Ranker ist, sondern eine Rettung: Er
kostet im Normalfall nichts, und der Nutzer wartet ohnehin auf eine schlechte
Antwort.

### 4. `nur für Prosa-Queries`
Prosa = `de` + `en` + `mixed` (379 Fälle), Keyword = `neutral` (205).
- Prosa: Δ ≥ 2.0 pp **und** KI95-Untergrenze > 0;
- `neutral`: Δ ≤ 0 **oder** KI95 schließt 0 ein.

Dann ist der Cross-Encoder das, wofür er trainiert wurde — ein Bewerter
natürlichsprachiger Paare — und die Hook-Lanes, die Stichwortketten absetzen,
hätten nichts davon außer den Kosten.

### 5. `ab einer Poolgröße`
Split am **Median von `poolSize`**, im Lauf berechnet und als `pool_split`
berichtet — durch Konstruktion festgelegt, nicht nach Sicht der Zahlen gewählt
(dieselbe Disziplin wie der Median-Split in #500).
- große Hälfte: Δ ≥ 2.0 pp und KI95-Untergrenze > 0;
- kleine Hälfte: KI95 schließt 0 ein.

Ausdrücklich **nicht** auf dem RRF-Score geschnitten — das wäre eine verkappte
`weak_result`-Variante und gehört in Form 3.

**Dieser Split entartet auf unseren Daten wahrscheinlich, und das wird
geprüft.** Der Pool ist per Konstruktion nahezu konstant: `bm25Top` (50) ∪
`vectorTop` (bis 50), fusioniert und auf `HOP_SEED_POOL = max(k*4, 20)` = 40
geschnitten. Bei einem Vault deutlich über 50 Memories ist die fusionierte
Menge fast immer größer als 40 — also `poolSize == 40` für praktisch jeden
Fall, Median 40, **alle** Fälle in `large`, `small` leer. Ein schlichtes
Gruppieren legte für den leeren Bucket gar keinen Schlüssel an, und im Artefakt
stünde `by_pool: { large: { n: 584 } }`, was wie ein fertiger Split aussieht.
Diese Form wäre damit wieder tot — diesmal hinter einem plausibel wirkenden
Mechanismus.

Deshalb: Beide Buckets werden **immer** ausgegeben, und ein Split, der nicht
gesplittet hat, markiert `by_pool` als `not_evaluable` — im Artefakt, nicht nur
auf stderr. Das ist eine **aus dem Code abgeleitete Vorhersage, keine
Beobachtung**; sie ist widerlegt, wenn der Vektorarm regelmäßig unter ~40
Treffer nach Filter liefert. Die Warnung ist in beide Richtungen richtig: Trifft
die Vorhersage nicht zu, schweigt sie.

### 6. Auffangregel — wenn *keine* Form zutrifft

Das ist **kein** Präzedenzproblem: Präzedenz ordnet *überlappende* Regeln, hier
trifft gar keine zu. Der Fall ist konstruierbar und **wahrscheinlich**, nicht
exotisch: +3,0 pp bei N=30 mit KI [+1,2, +4,8], bei N=10 nur +0,6 pp,
gleichmäßig über die Sprachen, keine Pool-Konzentration, p95 286 ms. `immer an`
fällt an der Latenz, `schließen` fällt an „Δ ≥ 2 pp mit KI über 0", die
bedingten Formen greifen nicht. Die 50-ms-Schwelle reißt bereits `short`/N=20
mit 52 ms — ein „erst in der Tiefe bezahlbar"-Ergebnis ist ein realistischer
Ausgang.

**Regel:** Trifft keine Form zu, lautet die Empfehlung **„nicht ausliefern"**,
zusammen mit der Klassifikation aus §5.7 und der ausdrücklichen Angabe, an
welcher Bedingung welche Form gescheitert ist. Die Voreinstellung ist niemals
„den bestaussehenden Arm ausliefern".

**Sonderfall „großer Lift, unbezahlbare Latenz" — jetzt mit Zahl.** „Groß"
heißt: irgendein Arm erreicht **Δ ≥ 5.0 pp** bei R@3 mit KI95-Untergrenze > 0,
während seine zusätzliche p95 die 50-ms-Schwelle reißt. Dann ist die Empfehlung
weder „an" noch bloß „schließen": Der Befund bedeutet, dass
Query-Kandidat-Interaktion trägt und nur der Abfragepfad sie nicht bezahlen
kann — ein Argument für **#119** (Cross-Encoder offline über
doc2query-Expansionen in der Schreibbahn), und es muss so in der Empfehlung
stehen.

### 7. „kein Effekt" ist nicht „kein bezahlbarer Effekt"

Fällt der Primärtest null aus, **muss** der Bericht klassifizieren. Die beiden
Aussagen sind völlig verschieden, und die Verwechslung wäre der teuerste
Fehler, den dieser Bericht machen könnte:

- **`kein Effekt`** — kein Arm bei irgendeinem (N, Passage, Modell) auf dem
  Gold-Satz erreicht Δ ≥ 2.0 pp bei R@3 mit KI95-Untergrenze > 0.
  → #501 schließen, die Hypothese ist widerlegt.
- **`kein bezahlbarer Effekt`** — mindestens ein teurerer Arm erreicht diese
  Schwelle, der Primärarm nicht.
  → #501 für den **Abfragepfad** schließen, **und** das ist positive Evidenz
  für #119. Muss ausdrücklich so in der Empfehlung stehen.

Die exploratorischen Arme tragen damit weiterhin **keine Empfehlung**, aber
diese eine **Klassifikation** — konsistent, weil die Klassifikation nichts zum
Ausliefern empfiehlt.

### Zwei Faktoren, die in die Empfehlung gehören und keine Messfragen sind

- **Der Favorit ist EN+DE, das Produkt ist es nicht.** Für Daniels Vault passt
  `msmarco-MiniLM-L6-en-de-v1`. Für einen Nutzer mit russischem oder
  spanischem Vault wäre er genau das, was `ms-marco-MiniLM` für uns ist — ein
  Modell ohne Signal. #480 nennt diese Nutzer ausdrücklich. Eine Empfehlung
  „immer an" wäre damit eine deutsche Insellösung, solange kein wirklich
  mehrsprachiges Modell ins Budget passt (`bge-reranker-base` täte es
  sprachlich und nicht zeitlich). Das ist ein Produktargument und gehört
  Daniel vorgelegt, nicht in eine Zahl gerechnet.
- **Die Latenzzahlen sind untere Schranken vom M4 Pro** (§4). Auf der 8-GB-
  Baseline kostet dieselbe Stufe ein Vielfaches, und niemand hat sie dort
  gemessen.

---

## 6. Der Harness — gebaut, nicht gelaufen

Der Replay steht als Code, damit Phase 2 nur noch messen muss. Bisher ist
**kein einziger Lauf** erfolgt: keine Ollama-Anfrage, keine Latenzzahl, kein
Qualitätswert.

| Datei | Rolle |
|---|---|
| `packages/eval/src/rerank-metrics.ts` | die Arithmetik — Rerank-Fenster, R@k, gepaarter Bootstrap, Vorzeichen-Permutation. Rein, ohne Vault, Modell oder Uhr. |
| `packages/eval/src/rerank-report.ts` | Slices, Floor-Reihenfolge, Rang-Regression, `no_answer`-Guard, Median-Split, Intervall-Zähler. Ebenfalls rein. |
| `packages/eval/src/rerank-model.ts` | der Cross-Encoder über transformers.js, die Modell-Registry und `assertLanguagesAllowed` — der Sprach-Wächter, der **läuft**. |
| `packages/eval/src/rerank-replay.ts` | der Lauf: `gatedHybridRecaller`, Pool über `onCandidatePool`, `PRIMARY`, Stage-Telemetrie, Batch-Invarianz-Prüfung. |
| `packages/eval/src/rerank-latency.ts` | die Kostenhälfte — echte N-große Batches auf einer Stichprobe, Ladezeit daneben statt darin. |
| `packages/eval/__tests__/rerank-replay.test.ts` | 41 Tests, keiner braucht Ollama oder einen Modell-Download. |
| `packages/eval/registrations/rerank-decision.json` | diese Voranmeldung in Maschinenform, `registration_version` 2. |

Drei Konstanten sind aus `goldset-run.ts` exportiert statt kopiert:
`PRODUCTION_K`, `SCORE_FLOOR` und `attachHybrid`/`gatedHybridRecaller`. Genau
deren Eigenschaften — Probe, kopierter Store, Backfill-Wartelogik, die
Weigerung, einen unvollständigen Arm als Messung auszugeben, und der Floor —
sind die Gründe, warum die Zahl belastbar ist. Eine zweite Implementierung
davon würde driften.

### Die Tests sind auf Rot geprüft, nicht nur auf Grün

Ein Test, der nur grün sein kann, ist keiner. Drei Mutationen wurden
eingespielt und alle drei fangen:

| Mutation | Ergebnis |
|---|---|
| Sprach-Wächter entschärft (`if (false && …)`) | 1 Test rot |
| Score-Floor aus `served()` entfernt | 3 Tests rot |
| Off-by-one im Score-Index von `rankArm` (`scores[j+1]`) | 3 Tests rot |

Das war nötig, weil die Vorgängerfassung drei Tests enthielt, die nichts
prüften: einer verglich ein 3-elementiges mit einem 1-elementigen Array (der
Assert konnte nicht fehlschlagen), einer prüfte nur, dass ein Metadatenfeld
seinen eigenen Inhalt hat, und der „stub drives the same rerank path"-Test
fuhr eine im Test nachgebaute Kopie der Schleife statt `rankArm` selbst.

Ein Ausbau ist **absichtlich offen**: Die Registrierung ist noch nicht in
`packages/eval/src/registrations.ts` verdrahtet, weil diese Datei zu #500
gehört. Was dort fehlt, steht in `pending_wiring` der Registrierungsdatei.

Der LongMemEval-Arm kommt nach #500 als eigener kleiner Adapter dazu — die
Naht dafür ist `CaseRow`.

## 7. Was diese Arbeit nicht tut

- Kein Cross-Encoder im Produktionspfad. Kein Import in `packages/core` oder
  `packages/daemon`. Null Produktionslatenz.
- `@huggingface/transformers` ist ausschließlich `devDependency` von
  `@bastra-recall/eval` und **wird wieder entfernt, falls #501 mit „schließen"
  endet**.
- Keine Änderung an `search.ts`. Der Kanal, den der Replay braucht,
  existiert seit #121.
- Kein Lauf. Die Zahlen in §1 stammen aus dem Modell-Spike in Isolation, nicht
  aus dem Harness.
