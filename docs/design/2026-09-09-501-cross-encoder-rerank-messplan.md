# Query-Zeit-Rerank — Messplan und Modell-Spike zu #501

Stand 10.09.2026, **gemessen und abgeschlossen**. #501 war eine
Entscheidungsfrage; das Ergebnis steht in **§8**.

> **Empfehlung: #501 schließen.** Der Primärtest ist null (ΔR@3 = +0,2 pp,
> KI95 [−3,1, +3,4]) und bleibt es auf allen geprüften Schnitten. Der externe
> Kontrollsatz zeigt darüber hinaus deutlichen Schaden. Nichts davon ist je in
> den Produktionspfad gelangt.

§1–§7 sind die **Voranmeldung**, geschrieben bevor eine Zahl existierte, und
stehen unverändert — auch dort, wo die Messung sie widerlegt hat. Wer prüfen
will, ob die Empfehlung an die Zahlen angepasst wurde, vergleicht §5 mit §8.

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

---

## 8. Das Ergebnis — gemessen am 09./10.09.2026

**Empfehlung: #501 schließen. Klassifikation: `kein Effekt`.**

Der Primärtest ist null, und er ist es auf drei unabhängigen Schnitten. Der
externe Kontrollsatz zeigt darüber hinaus **klaren Schaden**. Kein Arm, in
keiner Kombination aus N, Passagenlänge und Modell, auf keinem der beiden
Sätze, erreicht die registrierte Schwelle.

### 8.0 Wo die Rohdaten liegen — und warum ein Neulauf sie nicht ersetzt

Die Artefakte aller fünf Läufe liegen dauerhaft unter
**`~/.bastra/rerank-501-runs/2026-09-09/`**, jedes mit sha256 im committeten
Auszug `packages/eval/registrations/rerank-results.json`. Der Auszug trägt
Identitäten, Kennzahlen und Armtabellen, sodass jede Zahl dieses Berichts
nachprüfbar ist, **ohne** die großen Dateien zu haben; ein Test hält Auszug und
Registrierung deckungsgleich und verifiziert die Hashes gegen die echten Bytes.

Bewusst **nicht** in `~/.bastra/eval-runs` — dort stehen die registrierten
M0/M1-Baselines, die `m1-tolerances.json` per Pfad zitiert (#446).

**Ein Neulauf ersetzt diese Dateien nicht.** Der Gold-Lauf hat einen *lebenden*
Vault gemessen: Zwei Läufe über denselben Satz unterschieden sich bereits um
einen Fall in Tiefe 30, weil zwischen ihnen zwei Memories geschrieben wurden
(1171 → 1173 Vektoren, §8.7c). Erschwerend liegt dieser Lauf **vor** der
Einführung des Vault-Fingerabdrucks — die genaue Vault-Identität, die er sah,
ist damit nicht rekonstruierbar. Läufe ab `d383f22` tragen sie; dieser nicht,
und der Auszug sagt das ausdrücklich statt die Lücke zu verschweigen.

Dass die Dateien überhaupt beinahe verloren gegangen wären — sie lagen nur in
einem sitzungsgebundenen Scratchpad mit Modus `0600`, während der Bericht sie
als Quelle zitierte — ist die siebte Zeile zu §8.10: **Ein Beleg, den nur der
Autor lesen kann, ist kein Beleg.**

### 8.1 Der Primärtest

> **ΔR@3 = +0,2 pp · KI95 [−3,1, +3,4] · p = 1,0000**
> Gold-Satz, `en-de`, `short`, N=10, n=584, Basislinie 43,3 %
> 47 besser · 46 schlechter · 491 unverändert

Das ist die eine Zahl, die entscheidet. Sie wurde **zweimal unabhängig
gerechnet und war bitgleich** (`0.0017123287671232876`).

### 8.2 Die Entscheidungsregel, Bedingung für Bedingung

`close_501` verlangt drei Dinge, alle drei sind erfüllt:

| Bedingung | Befund |
|---|---|
| primär: Δ < 2,0 pp **oder** KI enthält 0 | **beides** — +0,2 pp, KI [−3,1, +3,4] |
| keine bedingte Form erfüllt ihre Schwelle | `weak_result` n=0 · `prose_only` scheitert (`de` −1,8 pp) · `ab Poolgröße` nicht auswertbar |
| `bge` bei N=30/`body` zeigt dasselbe | −0,5 pp, KI [−4,1, +3,1] |

**Klassifikation `kein Effekt`, nicht `kein bezahlbarer Effekt`:** Der beste
explorative Wert überhaupt ist `bge/short` N=10 mit **+2,2 pp, KI [−1,0, +5,5]**.
Er liegt damit **über** der 2,0-pp-Punktschwelle und scheitert **allein am
Intervall**, das die 0 einschließt — die registrierte Bedingung verlangt beides
(Δ ≥ 2,0 pp **und** KI-Untergrenze > 0). Die Klassifikation steht also, aber der
Abstand zur Schwelle ist kleiner, als eine frühere Fassung dieses Absatzes
behauptet hat: Sie nannte +1,9 pp aus einem verworfenen Vorlauf und schrieb, der
Wert liege unter der Punktschwelle. Das war falsch und in unsere eigene
Richtung falsch.

Was gleich bleibt: Es existiert kein Lift, der die 0 ausschließt — also keiner,
für den Latenz zu teuer hätte sein können.

Damit entfällt Schritt 2 von #501 („only if the lift is real"): **Der Latenzlauf
wurde nicht gefahren.** Die Modellkosten aus §1 bleiben die einzigen Zeitzahlen.

### 8.3 Die vollständige Tabelle, Gold-Satz

n=584, Basislinie R@3 43,3 %, serviertes k=10, Floor 30.

| Modell/Passage | N | R@3 nach Rerank | ΔR@3 | KI95 | ΔR@5 | any@N | Rang-Regression |
|---|---:|---:|---:|---:|---:|---:|---:|
| **en-de/short** ← primär | 10 | 43,5 % | **+0,2** | [−3,1, +3,4] | −0,2 | 58,6 % | 17,3 % |
| en-de/short | 20 | 41,8 % | −1,5 | [−5,3, +2,1] | −3,1 | 64,9 % | 22,3 % |
| en-de/short | 30 | 41,8 % | −1,5 | [−5,3, +2,1] | −3,1 | 68,2 % | 22,9 % |
| en-de/body | 10 | 43,0 % | −0,3 | [−3,6, +2,9] | +0,2 | 58,6 % | 17,0 % |
| en-de/body | 20 | 40,8 % | −2,6 | [−6,0, +0,9] | −2,4 | 64,9 % | 21,6 % |
| en-de/body | 30 | 40,4 % | −2,9 | [−6,5, +0,5] | −2,9 | 68,2 % | 22,1 % |
| bge/short | 10 | 45,5 % | **+2,2** | [−1,0, +5,5] | −0,7 | 58,6 % | 18,2 % |
| bge/short | 20 | 43,0 % | −0,3 | [−3,9, +3,3] | −1,4 | 64,9 % | 21,6 % |
| bge/short | 30 | 42,1 % | −1,2 | [−4,8, +2,4] | −2,7 | 68,2 % | 22,3 % |
| bge/body | 10 | 45,2 % | +1,9 | [−1,4, +5,1] | −0,3 | 58,6 % | 16,3 % |
| bge/body | 20 | 43,3 % | +0,0 | [−3,6, +3,6] | −1,4 | 64,9 % | 21,4 % |
| bge/body | 30 | 42,8 % | −0,5 | [−4,1, +3,1] | −1,7 | 68,2 % | 22,4 % |

Quelle: `rerank-501-gold-v2.json`, der Lauf mit getrennten N-Pässen für `bge`.
Eine frühere Fassung dieser Tabelle stand versehentlich auf dem verworfenen
Vorlauf; unentdeckt blieb das, weil die Primärzeile in beiden Läufen bitgleich
ist — also ausgerechnet die Zeile, die zweimal geprüft wurde.

**288 Konfidenzintervalle in diesem Lauf.** Bei α=0.05 sind mehrere davon auch
unter reinem Rauschen „signifikant". Diese Tabelle beschreibt; sie entscheidet
nicht. Entschieden hat allein die markierte Zeile.

Nebenbei: Die Rang-Regression liegt bei **17,3 %** und damit über dem
registrierten 15-%-Balken. Selbst wenn der Lift gereicht hätte, wäre „immer an"
auch daran gescheitert.

### 8.4 Drei unabhängige Schnitte — der Nullbefund ist keine Verdünnung

Die naheliegendste Ausrede für einen Nullbefund wäre, dass der Nenner ihn
verwässert: 172 der 584 Fälle haben ihr Gold nirgends im Pool und können per
Konstruktion nichts beitragen. Sie ist geprüft und trägt nicht.

| Schnitt | n | ΔR@3 | KI95 |
|---|---:|---:|---:|
| voller Nenner (**Primärtest**) | 584 | +0,2 | [−3,1, +3,4] |
| nur Fälle mit Gold im Fenster (exploratorisch) | 342 | +0,3 | [−5,3, +5,8] |
| deskriptive Achse (exploratorisch) | 447 | +0,0 | [−4,3, +4,3] |
| assoziative Achse | 137 | **NICHT AUSWERTBAR** (§18.1, Minimum 150) | — |

Das ist der Unterschied zwischen „hat nicht gewirkt" und **„hat auch dort nicht
gewirkt, wo es hätte wirken können"**. Auf genau der Teilmenge, in der ein
Reranker überhaupt etwas ausrichten kann, tut er nichts.

Die beiden Achsenschnitte sind **nicht vorangemeldet** (siehe §8.9) und tragen
deshalb keine Empfehlung. Sie ordnen ein, mehr nicht.

### 8.5 Die Obergrenze, gegen die alles zu lesen ist

Ein Cross-Encoder sortiert um; er ruft nicht ab. Was nicht im Pool liegt, kann
er nicht holen. Gemessen über dieselben 584 Fälle, ohne Modell:

| Achse | n | @1 | @3 | @10 | @30 | @40 | ohne Gold im Pool |
|---|---:|---:|---:|---:|---:|---:|---:|
| assoziativ | 137 | 2,2 % | 4,4 % | 8,0 % | 13,1 % | **15,3 %** | 116 (84,7 %) |
| deskriptiv | 447 | 36,2 % | 55,3 % | 74,0 % | 84,8 % | **87,5 %** | 56 (12,5 %) |
| gesamt | 584 | 28,3 % | 43,3 % | 58,6 % | 68,0 % | 70,5 % | 172 (29,5 %) |

**Auf der deskriptiven Achse — der, die den Betrieb beschreibt — lagen 29,5
Prozentpunkte Spielraum offen** (55,3 % Basislinie gegen 84,8 % Deckel). Die
Fehlsortierung aus #103/#118 ist also real und hat Masse. Sie wurde nicht
gehoben, obwohl sie da war. Das ist der eigentliche Inhalt des Nullbefunds.

Die gemischten 68,0 % sind im Wesentlichen ein Mischungsverhältnis der beiden
Achsen und beschreiben keine von beiden. `m1-tolerances.json` hat das am
29.08.2026 knapper gesagt, als wir es hier hergeleitet haben:

> „**An axis is a label, not a population.**"

**Zur assoziativen Achse gibt es keine Wirkungsaussage**, weder positiv noch
negativ: §18.1 setzt ein Minimum von 150 Fällen, der Satz hält 137. Die
Abdeckungszahlen oben sind Anteilsschätzer über eine definierte Menge, keine
Effektschätzung — daraus folgt **keine** Aussage über die Achse. Und die
niedrigen Werte sind kein Qualitätsproblem: `gold-authored-2/3` sind
absichtlich so verfasst, dass kein Term des Vorfallsberichts in der Query
überlebt (lexikalische Überlappung 4 % gegen 65 % bei den
Telemetrie-Sätzen). Sie existieren, um diese Lücke messbar zu machen.

### 8.6 Der Kontrollpass — und er ist nicht null, sondern negativ

500 LongMemEval-Fragen, drei Modelle, k=20. **Trägt nach der Registrierung
keine Empfehlung.**

Die Protokoll-Basislinie reproduziert #500 exakt: `recall_any@20 = 99,6 %`.
Damit ist die Zahl gegen die veröffentlichte Größe prüfbar — genau dafür läuft
die zweite Basislinie mit.

**Alle 18 Zeilen negativ. Alle 18 Konfidenzintervalle vollständig unter null.**

| Modell/Passage | ΔR@3 bei N=10 | N=20 | N=30 |
|---|---:|---:|---:|
| en-de/short | **−9,4** [−12,6, −6,4] | −15,2 | −18,0 |
| en-de/body | −5,8 | −8,6 | −9,4 |
| bge/short | −7,4 | −9,8 | −10,2 |
| bge/body | −6,0 | −7,2 | −7,2 |
| ms-marco/short | −10,0 | −12,6 | −13,8 |
| ms-marco/body | −5,8 | −6,8 | −7,6 |

Basislinie dort: R@3 = 95,2 %.

**Hypothese, nicht Befund:** Bei einer Basislinie von 95,2 % R@3 und 99,6 %
`recall_any@20` ist das RRF-Ranking dort bereits nahezu optimal sortiert — ein
Reranker, der umsortiert, kann fast nur verlieren. Das deckt sich mit #500s
Feststellung, dass auf jenem Satz fast alles schon in den Top 20 steckt. **Es
ist nicht gemessen**, also steht es hier als Lesart und nicht als Ursache.

**Die registrierte Nebenfrage ist damit beantwortet:** `ms-marco` (englisch-only)
bringt auf dem englischen Satz **keinen Vorteil** gegenüber dem zweisprachigen
`en-de` — bei `body`/N=10 exakt gleich (−5,8), bei `short` sogar schlechter
(−10,0 gegen −9,4). **Der Zweisprachigkeits-Aufschlag kostet auf Englisch keine
Qualität.** Zwei Minuten Rechenzeit für eine Frage, die sonst offen geblieben
wäre.

**Was der Kontrollpass darf und was nicht:** Er **stützt** die Empfehlung, er
**erzeugt** sie nicht. Die Empfehlung steht auf dem Gold-Satz und wäre ohne
LongMemEval dieselbe. Was sich durch ihn ändert, ist die Belastbarkeit der
Begründung: nicht „bei uns kein Effekt gemessen", sondern **auf zwei
unabhängigen Korpora — eigener und öffentlicher, verschiedene Sprache,
verschiedene Poolstruktur — keine Verbesserung, und auf dem externen mit klarem
Schaden.**

### 8.7 Vier Nebenbefunde, die unabhängig von #501 gelten

**(a) Der Score-Floor beißt — ab N=20, und in beide Richtungen.**

Eine frühere Fassung dieses Absatzes behauptete, `at` und
`at_no_floor_upper_bound` seien für **jeden** Arm identisch und die Sorge um die
verkürzte Trefferliste sei „gemessen widerlegt". **Das ist falsch.**
Nachgerechnet über beide Artefakte: **17 von 36 Zellen weichen ab, in 7 von 12
Armen** — aber verteilt sich das so:

| N | abweichende Zellen (von 12) |
|---:|---:|
| 10 | **0** |
| 20 | 6 |
| 30 | 11 |

Wahr ist die ursprüngliche Aussage also **nur für die N=10-Arme**, zu denen die
Primärzelle gehört. Für den Primärtest ändert der Floor nichts; für tiefere
Fenster sehr wohl.

**Und die Richtung ist die überraschende Hälfte:** In 15 der 17 Fälle **hebt**
der Floor die servierte Trefferquote. Das ist kein Widerspruch, sondern die
Mechanik: `served` schneidet erst auf k und filtert dann: Fällt ein
Sub-Floor-Eintrag aus den ersten Positionen, rücken die dahinterliegenden im
Index nach, und ein Gold auf Position 4 landet auf Position 3. In 2 Fällen
kostet der Floor entsprechend — dann war das Gold selbst unter der Schwelle.

**Für die offene Designfrage aus §3 zerfällt das in zwei Aussagen, und nur eine
davon ist belegt.**

**Belegt ist die Voraussetzung.** Ein Reranker holt bei N ≥ 20 tatsächlich
Sub-Floor-Kandidaten in die servierten Ränge — sonst könnte das Filtern das
Ergebnis nicht verändern, und bei N=10 tut es das ja auch in keiner einzigen
Zelle. Ohne diese Voraussetzung wäre die Designfrage gegenstandslos; mit ihr
ist sie real.

**Nicht belegt ist der befürchtete Schaden.** Gemessen an der *Trefferquote*
wirkt der Floor überwiegend **positiv** (15 von 17). Die Liste wird kürzer — die
gefilterten Einträge sind weg —, aber was übrig bleibt, ist nicht schlechter,
sondern im Mittel besser sortiert.

Damit ist der Befund: **weniger Einträge, nicht schlechtere.** Das ist etwas
anderes als „der Nutzer bekommt weniger Nützliches", und eine frühere Fassung
dieses Absatzes hat genau diesen stärkeren Satz behauptet — erst in die eine
Richtung („widerlegt"), dann in die andere („belegt"). Beide waren zu grob.

**Was ausdrücklich NICHT gemessen ist: um wie viel die Liste kürzer wird.** Die
Artefakte tragen Trefferquoten, keine Listenlängen — `ArmReport` kennt
`baseline`/`reranked`/`paired` je Schnitt und sonst nichts. Wer die Frage
beantworten will, muss die servierte Listenlänge pro Fall mitschreiben; das ist
eine Zeile im Harness und wurde hier versäumt.

Ob eine kürzere Liste für sich genommen ein Produktnachteil ist, ist ohnehin
eine **Produktfrage und keine Messfrage**. Sie gehört Daniel und bleibt offen —
folgenlos für diese Entscheidung, weil nichts ausgeliefert wird, aber relevant
für jeden künftigen Rerank-Versuch.

**(b) `weak_result` feuert 0 von 584 Mal — und 0 von 500 auf LongMemEval.**
Das ausgelieferte Prädikat (`packages/core/src/weak-result.ts`) löste auf
keinem einzigen Fall aus, auf keinem der beiden Sätze. Empfehlungsform 3 war
damit nicht bloß zufällig leer, sondern **prinzipiell nicht messbar**.

Das ist ein Befund über eine ausgelieferte Funktion, nicht über #501: Entweder
ist sie richtig kalibriert — die Queries beider Sätze tragen durchweg genug
Signal — oder sie ist faktisch tot. **Beides wäre wissenswert, und ich
entscheide es hier nicht.** Es gehört eigenständig untersucht.

**(c) Unsere Gold-Läufe messen gegen einen lebenden Vault.** Zwei Läufe über
„denselben" Satz ergaben `recall_any@30` = 397/584 und 398/584 — ein Fall,
allein in Tiefe 21–30. Es war **kein** Determinismus-Defekt: 100 Fälle zweimal
im selben Prozess abgerufen ergaben 100/100 identische Pools inklusive Scores.
Der Vault hatte sich geändert — zwei Memories, geschrieben um 22:00 und 01:46
**von der Session, die die Messung fuhr, über die Messung**. Der Vektorspeicher
ging von 1171 auf 1173.

Zwei zusätzliche Dokumente verschieben die BM25-Dokumentfrequenzen für *alle*
Terme, nicht nur für die eigenen — deshalb kann ein Gold von Rang 31 auf 30
rutschen, und deshalb ist „neue Nicht-Gold-Dokumente können Golds nur nach
unten drücken" die falsche Intuition.

#500s Determinismus hält bis zur 16. Dezimale, weil LongMemEvals Korpus eine
**eingefrorene Datei** ist. Unserer ist ein lebender Vault mit einem Daemon
darauf. Eine Determinismusprüfung über den Gold-Satz kann deshalb „gleicher
Vault → gleiches Ergebnis" belegen und niemals „gleiche Zahl morgen". Die
Artefakte tragen jetzt einen Vault-Fingerabdruck (Anzahl plus Hash über Ids und
`updated`, damit auch Änderungen an bestehenden Memories sichtbar werden).

**(d) `bge` und `ms-marco/short` sind nicht batch-invariant.** Für `en-de` ist
die Abweichung exakt 0 und die Reihenfolge stabil; für `bge` liegt sie bei
0,13–0,58 Logit mit **instabiler Reihenfolge**. Der Harness scored diese Modelle
deshalb pro N getrennt, mit der jeweils echten Batchgröße. Ohne das hätten die
bge-Zeilen bei N=10 und N=20 eine Prozedur beschrieben, die niemand ausliefern
würde: „ranke die Top 10 mit Scores aus einem 30er-Batch".

**Wichtig für die Lesart des Nullbefunds:** Die einzige bge-Zahl, die in einer
Entscheidungsschwelle steht — N=30/`body` — war davon **nie betroffen**, weil
dort der 30er-Batch der echte ist. Der Nullbefund ist kein Messfehler.

### 8.8 „Ab Poolgröße" ist auf dem Gold-Satz nicht entscheidbar

Der Kandidatenpool ist dort per Konstruktion konstant 40 tief
(`HOP_SEED_POOL = max(k*4, 20)` bei `PRODUCTION_K = 10`), auf einem Vault von
über 1100 Memories also für praktisch jede Query ausgeschöpft. Der Median-Split
legt damit **alle** 584 Fälle in einen Bucket. Das ist ein gemessenes Ergebnis,
keine Lücke: Die Form ist auf diesem Satz nicht prüfbar.

Auf LongMemEval war sie prüfbar (Haystacks von ~48 Sessions, Split 248/252) und
zeigt in beiden Hälften Schaden: −8,9 pp und −9,9 pp, beide KI vollständig
unter null. Auch dort trägt die Form also nicht.

### 8.9 Was wir nachträglich NICHT getan haben

Zwei Entscheidungen, die den Befund hätten freundlicher aussehen lassen und
bewusst unterblieben sind:

**Der `kind`-Slice wurde nicht nachregistriert.** Als die Abdeckungszahlen
zeigten, dass die deskriptive Achse günstiger schneidet, war das formale Fenster
noch offen — es existierte keine Rerank-Zahl. Das formale Kriterium ist aber
nicht das richtige. Das richtige lautet: *Weiß ich schon, in welche Richtung der
Slice schneidet?* Und das war bekannt. **Das erkenntnistheoretische Fenster
schließt vor dem formalen.** Die Achsenzahlen stehen deshalb als
nicht-vorangemeldete, exploratorische Einordnung im Bericht und tragen keine
Empfehlung.

**Der Primärtest wurde nicht auf die erreichbare Teilmenge verschoben**, obwohl
die Verdünnung mit 19,9 % strukturellem Nullbeitrag beziffert und bekannt war.
Er lief auf dem Nenner, auf dem er angemeldet war. (Es hätte ohnehin nichts
geändert: +0,3 statt +0,2 pp.)

### 8.10 Die Lehre, die über #501 hinausgeht

Viermal in einer Nacht dasselbe Muster, jedes Mal an anderer Stelle:

| Regel | stand geschrieben in | ausgeführt hat sie |
|---|---|---|
| „`ms-marco` darf nicht auf dem deutschen Satz laufen" | Messplan §6 + Registrierung | niemand — `--models ms-marco` lief anstandslos über 272 deutsche Fälle |
| „ein Pool-Split, der nicht splittet, ist kein Ergebnis" | nirgends | niemand — `by_pool: { large: { n: 584 } }` hätte wie ein Befund ausgesehen |
| „unter 150 assoziativen Fällen: NICHT AUSWERTBAR" (§18.1) | `cue-experiment.json`, seit 28.08. | niemand — und 137 liegt **über** der allgemeinen Schwelle von 30, es hätte also nichts gegriffen |
| „der Kontrollsatz trägt keine Empfehlung" | Registrierung | niemand — es stand nur im Text |

Alle vier führen jetzt aus: als Wächterfunktion, als Entartungsprüfung, als
eigene Mindestfallzahl, als Feld im Artefakt selbst. **Eine Regel, die dasteht,
während nichts sie ausführt, ist keine Regel** — sie ist eine Absichtserklärung,
die bei der nächsten Messung genau dann nicht greift, wenn es darauf ankommt.

Dazu eine sechste Zeile, die nicht das System betrifft, sondern das Ablesen —
zweimal derselbe Fehler, und beide Male hat erst die Prüfung ihn gefunden:

| Fehlschluss | geprüfter Ausschnitt | ungeprüfter Rest |
|---|---|---|
| „der Lockfile hat `@hono/node-server` gehoben" | eine `+`-Zeile mit `2.1.1` | der Vorher-Wert, der ebenfalls `2.1.1` war |
| „der Floor beißt für **jeden** Arm null Mal" | die Deltas der drei N=10-Arme | die übrigen 24 Zellen, von denen 17 abweichen |

Der gemeinsame Nenner ist nicht „zu wenig nachgerechnet", sondern schärfer:
**Aus einem geprüften Ausschnitt wurde auf das Ungeprüfte geschlossen.** In
beiden Fällen war der Ausschnitt korrekt, sorgfältig geprüft und trug die
Verallgemeinerung trotzdem nicht.

Die Tabelle in §8.3 ist der dritte Fall derselben Familie: Ihre Primärzeile war
zweimal verifiziert und in beiden Läufen bitgleich — und **genau deshalb** fiel
nicht auf, dass die elf Zeilen darunter aus dem verworfenen Vorlauf stammten.
Eine zweimal geprüfte Zeile erzeugt Vertrauen in ihre Nachbarn, das sie nicht
deckt.

Dazu eine fünfte, spezifischere: **§18.1 verlangt, deskriptive und assoziative
Fälle getrennt auszuweisen.** Diese Voranmeldung hat den Sprachschnitt sorgfältig
geregelt und die Cue-Achse übersehen, obwohl sie im selben Satz registriert ist.
Ein künftiger Primärtest über diesen Gold-Satz gehört **von vornherein** nach
Achse geschnitten — oder muss begründen, warum eine Mischung gewollt ist.

### 8.11 Offene Punkte für Daniel

1. **`weak_result` feuert nie** (0 von 1084 Fällen über beide Sätze). Richtig
   kalibriert oder tot? Eigenständige Untersuchung, unabhängig von #501.
2. **Der Deckel auf der deskriptiven Achse liegt bei 87,5 %**, und 12,5 % der
   deskriptiven Fälle haben ihr Gold nirgends im 40er-Pool. Das ist ein
   Abruf-Thema, kein Ranking-Thema — also die Richtung, in die #103/#118 **nicht**
   zeigten. Ob es sich lohnt, ist eine Produktfrage.
3. **`gold-blind` liegt auf der deskriptiven Achse unter deren Durchschnitt.**
   Beobachtung, keine Diagnose; die Ursache ist nicht untersucht.
4. **#119 bleibt unberührt.** Dieser Befund spricht **nicht** gegen einen
   Cross-Encoder in der Schreibbahn: Dort filtert er Expansionen gegen ihr
   eigenes Memory, statt Kandidaten gegen eine Query zu ordnen — eine andere
   Aufgabe, und die hier gemessene sagt nichts über jene.
5. **`@huggingface/transformers` kann entfernt werden**, sobald dieser Befund
   akzeptiert ist — so registriert („removed again if #501 ends in 'close it'").
   Ich habe es **nicht** getan: Der Harness soll reproduzierbar bleiben, bis die
   Entscheidung steht. Umkehrbare Annahme, ein Commit.
