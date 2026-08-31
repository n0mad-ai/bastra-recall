# Der konservative Router — Designvorschlag zu #362

Stand 29.08.2026. Grundlage: Telemetrie aus `~/.bastra/logs/events-2026-08-*.jsonl`,
n=649 `hook_recall`-Events mit Schattenentscheidung und Ist-Zeiten, plus der
Code-Stand `bf158dd`. **Nichts davon ist implementiert** — das Dokument ist die
Vorlage für Daniels Entscheidung, nicht für einen Umsetzungsauftrag.

## Warum überhaupt noch etwas offen ist

Der akute Befund von #362 ist erledigt: `846014c` (Gruppierung wiederholter
Query-Terme, in v0.9.2) hat den lexikalischen Arm von 1137 ms p50 auf 16 ms p50
gebracht, ohne ein einziges Ranking zu verändern. Die Timeout-Rate über 4000
Zeichen fiel von 69–100 % auf 8–15 %.

Es bleibt ein Rest, und der ist klein: Die Prompt-Lane liegt bei p50 179 ms unter
dem 200-ms-Ziel aus #305, bei p90 mit 434 ms darüber. Fünf Läufe der Messperiode
gingen über 600 ms — das ist der Punkt, an dem der Hook-Timeout greift und die
Lane stumm bleibt, also der einzige Fall, in dem der Nutzer wirklich etwas
verliert.

Zwei Hebel wurden gemessen und verworfen, beide aus demselben Grund: Sie
verändern Ränge, und die Einblendschwelle sitzt auf einem rangabgeleiteten Score
(`MUST_LOAD_SCORE = 100`).

- Der Query-Cap (`bm25-query-cap.ts`, `3a3feb3`): bei 200 Zeichen verlieren 15
  von 15 Probe-Queries mindestens eine injizierbare Id.
- Die Fuzzy-Steuerung nach Seltenheit (`bm25_fuzzy_rare_df_max`, `0180698`):
  durch die echte Pipeline nur 12–15 % Ersparnis, und wo sie spart, kostet sie
  eine Id.

Der Router ist der dritte Kandidat. Er ist noch nicht gemessen, und er kann es
heute auch nicht sein — siehe Schritt 4.

## Die Ship-Bar, an der alles hängt

Aus #362, unverändert: Eine Variante darf ausgeliefert werden, wenn über alle
Probe-Queries **keine injizierbare Id verloren geht** UND **mindestens 90 % der
injizierbaren Mengen identisch sind**. Injizierbar heißt: Der Hit hätte den
Score-Floor der Prompt-Lane passiert und wäre im `<recall-hints>`-Block gelandet.

Das erste Kriterium ist die härtere Hürde; an ihm sind Cap und Fuzzy-Steuerung
gescheitert, nicht am zweiten.

## Schritt 1 — den Schatten-Defekt beheben

**Ohne diesen Schritt ist jede Zahl in Schritt 2 unbrauchbar.**

`http-hook-routes.ts:526-533` ruft `routeRetrieval` mit dem Budget der Hook-Lane
(200 ms) und der Dense-Reserve **aus dem Request-Body** (`:307`). Der
MCP-Forwarder setzt dort 1500 ms (`mcp-forwarder.ts:525`). Da
`lexicalFitsBudget` `max(lexikalisch, Reserve) + 7 <= Budget` rechnet, ist das
Ergebnis für jeden MCP-Recall zwangsläufig `false` — unabhängig von der Query.

101 von 149 `fits: false`-Entscheidungen sind dieser Defekt. Details, Repro und
die beiden Fix-Varianten stehen im eigenen Issue (`router-bug-issue.md`);
empfohlen ist Variante 1: dem Router das Budget des tatsächlichen Aufrufers
geben.

Seit #445 trägt jedes Recall-Event seine Quelle, die Kontamination lässt sich
nach dem Fix also nachweisen statt schätzen.

## Schritt 2 — die Interventionsschwelle vom Ziel trennen

Heute beantwortet eine Zahl zwei Fragen: „passt es ins Budget" und „wird
eingegriffen". Das 200-ms-Ziel beschreibt, was wir anstreben; der Eingriff
gehört dorthin, wo die Lane sonst stumm bleibt.

Nachgerechnet mit den Parametern der Hook-Lane (Budget 200 ms, Dense-Reserve
150 ms), n=649:

| Schwelle | greift ab | betroffene Läufe | fängt Läufe über 600 ms | davon unnötig (unter 200 ms) |
|---|---|---|---|---|
| 200 ms (heute) | 247 Terme | 48 (7,4 %) | 5 von 5 | 0 |
| 300 ms | 381 Terme | 39 (6,0 %) | 5 von 5 | 0 |
| **400 ms** | **514 Terme** | **19 (2,9 %)** | **5 von 5** | **0** |
| 500 ms | 647 Terme | 9 (1,4 %) | 4 von 5 | 0 |
| 600 ms | 781 Terme | 0 | 0 von 5 | 0 |

Zwei Dinge stehen darin.

Erstens: Die Trennschärfe des Routers ist gut, nicht schlecht. Sauber gerechnet
fasst er ausschließlich Läufe an, die tatsächlich über 200 ms lagen. Die frühere
Lesart „70 % Fehlalarme" war der Defekt aus Schritt 1.

Zweitens: **600 ms wäre wirkungslos.** Das war mein erster Vorschlag, und er ist
falsch. Die fünf schädlichen Läufe liegen bei 578–768 eindeutigen Termen, die
600-ms-Schwelle läge bei 781 — sie fiele auf keinen einzigen. Ursache ist die
Unterschätzung aus Schritt 3.

**400 ms ist der Punkt:** ein Siebtel der Eingriffe von heute, alle fünf
Schadensfälle weiterhin erfasst, kein einziger harmloser Lauf dabei.

Umsetzung: ein eigener Wert (Arbeitsname `BM25_INTERVENE_ABOVE_MS`, 400) **neben**
dem Ziel-Budget, als zusätzliches Feld an `RouteInput`. Ausdrücklich keine
geänderte Konstante in `query-cost.ts` — `BM25_COST_BASE_MS` und
`BM25_COST_PER_UNIQUE_TERM_MS` beschreiben die Kosten und sollen genau das
weiter tun.

## Schritt 3 — das Kostenmodell über 500 Termen nachziehen

Das Modell stimmt in dem Bereich, für den es kalibriert wurde: Schätzfehler p50
+3 ms, p90 +7 ms, in 66 % der Fälle konservativ. Ab etwa 500 eindeutigen Termen
unterschätzt es:

| eindeutige Terme | geschätzt | gemessen (bm25) |
|---|---|---|
| 578 | 442 ms | 906 ms |
| 656 | 500 ms | 598 ms |
| 694 | 529 ms | 614 ms |
| 722 | 550 ms | 622 ms |
| 768 | 584 ms | 644 ms |

Genau in dieser Zone säße eine Schwelle bei 514 Termen. Zwei Wege: ein zweites
Segment über 500 Termen mit höheren Grenzkosten, oder — ehrlicher — die Schwelle
konservativ setzen und in Kauf nehmen, dass sie ein paar Läufe zu spät greift.
Die Datengrundlage für beides ist `recall_stages.terms_unique` gegen
`recall_stages.bm25_search_ms` derselben Events, wie der Kommentarkopf in
`query-cost.ts` es bereits vorsieht.

Der Ausreißer bei 578 Termen (442 geschätzt, 906 gemessen) ist der einzige
Wert, der weit außerhalb der Linie liegt. Er sollte vor einer Kalibrierung
einzeln angesehen werden, statt die Konstanten an ihm auszurichten.

## Schritt 4 — welcher Modus überhaupt zu implementieren wäre

**Heute existiert nur der Entscheid.** `routeRetrieval`
(`packages/core/src/retrieval-mode.ts:59`) berechnet einen Modus und gibt ihn
zurück; in `search.ts` gibt es keinen Pfad, der `dense-primary`, `lexical-full`
oder `hybrid` unterschiedlich behandelt. Eine Grep über core und daemon findet
`dense-primary` außerhalb von `retrieval-mode.ts` nur in einem Kommentar.

Daraus folgt: Der Router lässt sich **nicht** gegen die Ship-Bar messen. Die Bar
vergleicht die injizierbaren Mengen zweier Läufe, und der zweite Lauf ist nicht
baubar.

`dense-primary` heißt laut Doku „voller Dense-Arm plus exakte
Identifier-Rettung". Der Dense-Arm ist da; die Rettung fehlt. `bm25_no_fuzzy`
(`search.ts:400`) schaltet nur Fuzzy ab und lässt Präfix an — das ist Variante C
aus der Messung vom 25.08. Gebraucht würde ein Exact-only-Lauf, Variante D: 78 ms,
aber 94 % auf Tiefe 50, also allein zu wenig und als Beigabe zum vollen
Dense-Arm genau richtig. Das wäre eine neue Recall-Option, etwa
`bm25_exact_only`, und der Modus wäre deren Kombination mit dem unveränderten
Dense-Arm.

Aufwand: die Option in `RecallOptions`, ein Zweig in `bm25Plan()`, die
Modus-Verzweigung in `recallHybrid`. Überschaubar — aber es ist eine
Produktänderung und keine Messvorbereitung, und sie sollte erst nach den
Schritten 1–3 begonnen werden.

## Schritt 5 — der isolierte Harness

Der bestehende Harness (`packages/eval/src/bm25-expansion.ts`,
`npm run bm25-expansion --workspace @bastra-recall/eval`) misst die
Fuzzy-Variante und ist die richtige Vorlage. Für den Router bräuchte er einen
Modus-Arm. Drei Dinge sind dabei nicht verhandelbar:

**Niemals gegen den Live-Store.** `emb.start()` backfillt fehlende Vektoren und
schreibt sie in dieselbe `embeddings.json`, die der laufende Daemon hält. Ein
Messlauf, der den Messgegenstand verändert, ist keiner. Also vor dem Lauf eine
Kopie anlegen — Memories plus `.bastra/embeddings.json` und `embed-cache.json` —
und `BASTRA_VAULT_PATH` darauf zeigen. Zusätzlich `persistPath` explizit in die
Kopie legen, damit der Schutz nicht davon abhängt, dass zufällig keine Vektoren
fehlen. Dass die Kopie nichts verfälscht, ist gemessen: der Vergleich
Google-Drive-Mount gegen lokales APFS vom 17.08. fand keinen Unterschied
(`Vault.init()` 42,4 ms gegen 45,1 ms).

**Der Kontrollarm bleibt Pflicht.** Derselbe Arm zweimal, bevor irgendeine
Variante gelesen wird. In der 25.08.-Messung hat genau diese Zeile den
Rauschboden auf ~3 % festgenagelt und die Variantenzeilen überhaupt erst lesbar
gemacht.

**Die Modusentscheidung gehört ins Protokoll.** Pro Probe mitschreiben, welchen
Modus der Router gewählt hat. Ein Arm, der auf 30 Probes nie `dense-primary`
wählt, misst nichts — das muss als solches sichtbar sein und darf nicht als
grüne PASS-Zeile durchgehen. Die Probe-Menge bleibt wie gehabt deterministisch
sortiert im Band 2000–8000 Zeichen, für alle Arme dieselbe.

Zur Berechtigung: Der Harness-Lauf braucht Lesezugriff auf den Vault unter
`~/Library/CloudStorage/GoogleDrive-…/OBSIDIAN/Daniel Nevoigt`. In der Session
vom 29.08. hat der Auto-Mode-Klassifikator jeden Zugriff darauf blockiert,
einschließlich des Kopierens. Vor der Umsetzung also entweder eine
Bash-Permission-Regel setzen oder den Lauf von Daniel selbst fahren lassen.

## Reihenfolge und Abbruchkriterium

1. Defekt beheben (eigenes Issue) — sonst misst alles Weitere den Defekt mit.
2. Schwelle trennen und auf 400 ms setzen.
3. Kostenmodell über 500 Termen prüfen; entweder nachkalibrieren oder die
   Schwelle bewusst konservativ lassen.
4. `bm25_exact_only` implementieren, damit `dense-primary` überhaupt läuft.
5. Harness auf der Kopie, mit Kontrollarm und Modus-Protokoll, gegen die
   Ship-Bar.

**Abbruchkriterium:** Verliert `dense-primary` bei 400 ms auch nur eine
injizierbare Id, ist der Router als Hebel erledigt — wie Cap und
Fuzzy-Steuerung, und aus demselben Grund. Dann bleibt die Frage, ob die fünf
stummen Läufe der Messperiode diesen Aufwand überhaupt rechtfertigen, oder ob
#362 mit den Zahlen aus Phase 1 geschlossen wird und der Rest als bekannte
Grenze dokumentiert bleibt.
