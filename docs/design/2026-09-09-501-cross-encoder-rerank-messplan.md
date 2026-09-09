# Query-Zeit-Rerank — Messplan und Modell-Spike zu #501

Stand 09.09.2026. **Nichts davon ist implementiert und nichts davon gehört in
den Produktionspfad.** #501 ist eine Entscheidungsfrage: Das Ergebnis ist eine
Tabelle plus eine Empfehlung an Daniel, kein ausgelieferter Reranker.

Dieses Dokument ist die **Voranmeldung** der Messung im Sinne von §18.3 — die
freien Parameter, die Metriken und die Entscheidungsschwellen stehen hier fest,
bevor die erste Zahl existiert. Wer die Empfehlung nachträglich an die Zahl
anpasst, die zufällig herauskommt, hat #501 nicht beantwortet.

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

| Parameter | Wert(e) | Begründung |
|---|---|---|
| Modell (Hauptarm) | `cross-encoder/msmarco-MiniLM-L6-en-de-v1`, fp32 | einziges gespiketes Modell mit abgestuftem Deutsch-Signal bei MiniLM-L6-Kosten |
| Modell (Qualitätsreferenz, nur offline) | `Xenova/bge-reranker-base`, q8 | beantwortet „ist das Modell zu schwach oder die Hypothese falsch?" |
| N | 10, 20, 30 | aus #501 |
| Rerank-Text | **A: `title` + `summary`** (≈80 Token), **B: `title` + `summary` + `body[0..400]`** (≈191 Token) | beide, weil der Faktor 3,4 zwischen ihnen die Entscheidung dominiert. Nicht mehr als zwei — sonst ist es eine Suche nach der besten Zahl. |
| Fusion Rerank ↔ RRF | **reines Rerank-Ranking** (Cross-Encoder-Logit ordnet allein) | die einfachste Variante zuerst. Eine Score-Mischung ist ein zweiter freier Parameter und wird erst voranzumelden sein, wenn die einfache Variante trägt. |
| Sätze | LongMemEval (#500, `--arms hybrid`) **und** die Gold-Fälle unter `~/.bastra/eval-goldset/` (699 Fälle in 12 Dateien, davon 20 Probe-Fälle, die wie üblich aus dem Hauptnenner fallen) | intern + extern, wie #501 verlangt |
| Metriken | R@1 / R@3 / R@5, `recall_any@N` als Deckel, dazu Δ gegen den unrerankten Lauf | |
| Signifikanz | gepaart pro Query, Bootstrap-KI und Vorzeichen-Permutationstest — wie `rrf-k-beir.ts` es für RRF_K gemacht hat | ein Lift ohne KI ist kein Befund |
| Staleness | wirkt **vor** dem Rerank (der Pool ist der gedämpfte) | so säße die Stufe auch in Produktion |

Nicht Teil der Messung: Score-Mischung, gelernte Schwellen, Rerank auf dem
Body in voller Länge, Quantisierung des Favoriten (es existiert kein
quantisiertes File; eine Eigenkonvertierung wäre ein eigenes Vorhaben).

---

## 4. Die Latenzmessung — und wie sie nicht Ollama misst

Schritt 2 von #501 verlangt p50/p95 **zusätzliche** Latenz, kalt und warm. Die
Falle ist offensichtlich und wird hier ausdrücklich umgangen: Auf dieser
Maschine teilen sich Ollama (dichter Arm) und der Rerank dieselbe Hardware. Ein
naiv gemessener Ende-zu-Ende-Zeitunterschied misst zu einem beliebigen Anteil
Ollama-Last, Modell-Kaltstart und Circuit-Breaker — und würde diese als
Rerank-Kosten ausweisen.

Deshalb:

1. **Die Zusatzlatenz ist eine gepaarte Differenz pro Query**, nicht die
   Differenz zweier Läufe. Ein Lauf, ein `recallHybrid`-Aufruf, und um die
   Rerank-Stufe herum eine eigene `hrtime`-Spanne. Was Ollama in diesem Aufruf
   getan hat, steht in beiden Hälften der Differenz und kürzt sich weg.
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
5. **Ollama-Kontention wird gemessen statt weggeredet.** Jeder Lauf
   protokolliert `vector.search.wait_ms`, `timed_out` und `provider_outcome`
   aus den bereits existierenden Stage-Events. Ein Lauf, in dem der dichte Arm
   auffällig oft in die Frist läuft, ist kein gültiger Latenzlauf und wird
   verworfen, nicht interpretiert.
6. **Keine parallele Modellarbeit auf der Maschine während des Latenzlaufs.**
   Der Qualitätslauf (§3) darf parallel laufen, der Latenzlauf nicht.

Berichtet wird gegen die Fristen, die es wirklich gibt: das ~500-ms-Hook-Budget
(#118), die drei festen Dense-Arm-Fristen 150 / 350 / 1500 ms aus #492 und das
kumulative Kontextbudget aus #458 — letzteres ist kein Zeitbudget, taucht aber
in der Empfehlung auf, weil ein Rerank die Zusammensetzung dessen ändert, was
das Budget füllt.

---

## 5. Die Entscheidungsform — vor der Zahl festgelegt

Die Lieferung ist eine Tabelle (N, R@3-Lift, R@5-Lift, zusätzliche p50,
zusätzliche p95) plus eine Empfehlung. Damit die Empfehlung nicht hinterher an
die Zahl angepasst wird, steht hier, welcher Befund welche Form rechtfertigt.

**Empfehlung „immer an"** — nur wenn *alle* gelten:
- R@3-Lift auf **beiden** Sätzen positiv, mit Bootstrap-KI vollständig über 0,
- der Lift ist bei N=10 im Wesentlichen schon da (der billige Fall trägt),
- zusätzliche p95 bei diesem N ≤ 50 ms, sodass Recall p50+Rerank unter der
  Hook-Frist bleibt,
- kein Gold verliert Rang gegenüber dem RRF-Ranking (Regressionsanteil pro
  Query berichtet, nicht nur der Mittelwert).

**Empfehlung „erst ab einer Poolgröße"** — wenn:
- der Lift real ist, aber sich auf Queries mit großem Kandidatenpool
  konzentriert (kleine Pools sind bereits richtig sortiert), und
- die Kosten nur dort anfallen, wo sie sich lohnen.
- Der Nachweis ist eine Aufschlüsselung des Lifts **nach Poolgröße**, nicht
  nach Score — eine Schwelle auf dem RRF-Score wäre eine verkappte
  `weak_result`-Variante und gehört in den nächsten Fall.

**Empfehlung „nur wenn `weak_result` sonst feuern würde"** — wenn:
- der Lift auf der Teilmenge, auf der `weak_result` greift, deutlich über dem
  Gesamt-Lift liegt, und
- der Gesamt-Lift für „immer an" zu klein oder zu teuer ist.
- Das ist der Fall, in dem der Rerank kein Ranker, sondern eine Rettung ist.
  Er kostet nichts im Normalfall, und der Nutzer wartet ohnehin schon auf eine
  schlechte Antwort. `packages/core/src/weak-result.ts` liefert das Prädikat;
  es wird **nicht** nachgebaut.

**Empfehlung „#501 schließen"** — wenn:
- der R@3-Lift auf beiden Sätzen bei N=30 unter etwa 2 Prozentpunkten liegt
  oder seine KI die 0 einschließt, **und** die `bge-reranker-base`-Referenz
  denselben Befund zeigt.
- Dann ist die Fehlsortierung nicht das, was ein Cross-Encoder repariert, und
  das ist ein vollwertiges, billig erkauftes Ergebnis. Kein Nachschieben
  weiterer Modelle, um doch noch einen Lift zu finden.

Ein Sonderfall, der vorher benannt gehört: **großer Lift, unbezahlbare
Latenz.** Dann ist die Empfehlung weder „an" noch „schließen", sondern die
Frage nach der Schreibbahn — der Befund würde bedeuten, dass Query-Kandidat-
Interaktion trägt, und das ist ein Argument für #119 (Cross-Encoder offline
über doc2query-Expansionen), nicht für den Abfragepfad.

---

## 6. Was diese Arbeit nicht tut

- Kein Cross-Encoder im Produktionspfad. Kein Import in `packages/core` oder
  `packages/daemon`. Null Produktionslatenz.
- Keine neue Abhängigkeit in einem ausgelieferten Paket.
  `@huggingface/transformers` wäre, wenn überhaupt, eine `devDependency` von
  `@bastra-recall/eval` — und auch das erst, wenn Daniel die Messung will.
- Keine Änderung an `search.ts`. Der Kanal, den der Replay braucht,
  existiert seit #121.
