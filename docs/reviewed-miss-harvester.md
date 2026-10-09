# Reviewed-miss harvester — what it does and how to run it / Reviewed-Miss-Harvester — was er tut und wie man ihn startet

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

> **Designed and implemented by [@zzallirog](https://github.com/zzallirog) (PR [#454](https://github.com/n0mad-ai/bastra-recall/pull/454), workstream A of #459).**
> This page describes what the code does. The reasoning behind the classes and engines is in the [design document](./design/2026-09-13-reviewed-miss-observation-engines.md).

### What it is for

Recall answers a question with a list of memories. Sometimes the session then
opens a memory or a file that Recall did not serve. The harvester finds these
moments in data that already exists on the machine and sorts each one into
exactly one class: Recall did answer, the memory was found but not served, the
memory was not found at all, the object could not have been indexed, or the
answer came from outside the vault. From the three classes that the memory
system could fix, it derives a reviewer's list of cue proposals — which words
of the owner's question could lead to which memory.

It is an offline repository tool. It reads files and writes the output files
you name. It does not talk to the daemon, opens no network connection, calls no
model, uploads nothing and never writes to the vault. It changes nothing about
how Recall behaves; nothing it produces is applied anywhere by itself. Its
modules and its script are excluded from the published npm package.

### How to run it

From the repository root:

```sh
npm run harvest:reviewed-misses --workspace=@bastra-recall/daemon -- \
  --events /path/to/telemetry --vault /path/to/vault \
  --out queue.json --proposals proposals.json /path/to/session.jsonl
```

The script runs inside `packages/daemon`, so give absolute paths.

| Flag | Meaning |
| --- | --- |
| `session.jsonl ...` | One or more Claude Code session transcripts. Optional when `--hook-lane` is given. |
| `--events DIR` | The daemon's telemetry directory (`events-*.jsonl`). Supplies the candidate pool of each recall, joined by `recall_id`. |
| `--vault DIR` | The vault root. Enumerated once for membership proofs; opened read-only. |
| `--labels FILE` | Reviewer labels, one JSON object per line: `{"ref": "sha256:…", "durable": true}`. `ref` is a `recallRef` or `sourceRef` from the queue. |
| `--hook-lane` | Also observe `load_memory` events from telemetry alone. Needs `--events` and `--vault`. |
| `--out FILE` | Write the queue here instead of standard output. |
| `--proposals FILE` | Write the cue proposals here. |
| `--evidence FILE` | Write the heatmap and the hot paths here. |
| `--specimens FILE` | Write one specimen per (lane, class) here. |
| `--hub-sessions N` | Distinct sessions from which a memory counts as a hub. Default 3. |
| `--since DAYS` | Read only telemetry events younger than `DAYS`. Default: every event file in the directory. Does not filter transcripts. |

Exit codes: `0` after a run; `1` with a message when `--events` is not a
directory or holds no `events-*.jsonl`, when `--vault` is not a directory or
holds no memory, or when a session file cannot be read; `2` with the usage text
for an unknown flag, a missing value, no input at all, or `--hook-lane` without
`--events` and `--vault`.

### What it reads

- **Session transcripts.** The owner's typed turn is the intent. The recalls
  made for it, their result envelopes, and the first step after those results
  that names something inspectable form one chain. That step is a
  `load_memory` id, a `Read` path (a relative one is resolved against the
  working directory the transcript recorded), or a single-file `cat` / `head` /
  `tail` / `grep PATTERN FILE` with an absolute path. Recalls with no such step
  between them — two in one message, one asked again, the phrasings of a
  batch — are one chain. Turns written by the harness (task notifications,
  agent mail, reminders) neither end a chain nor enter the intent. A slash
  command and the marker the client writes when the owner interrupts
  (`[Request interrupted by user…`) end the chain and are no intent. Secrets in
  the typed text are redacted before it is kept.
- **Telemetry.** `recall` and `hook_recall` events with their `recall_id`,
  served `hits`, `candidate_pool` and score space; `load_memory` events with
  the recall the daemon linked them to. A recall event without a
  `candidate_pool` counts as a known empty pool only when the event shows it:
  an empty `hits` list and its own `score_kind` / `score_arms`. Otherwise the
  pool is missing.
- **The vault.** File paths, memory ids, each file's birth time and its
  declared `created`.
- **Reviewer labels**, if given.

### What it writes

| Output | Content | Identifiers |
| --- | --- | --- |
| Queue (`--out`, else standard output) | One record per observed chain or load: lane, class, the redacted intent, the frozen pool and the proofs. | Hashed (`sha256:…`). The intent text is clear. |
| Proposals (`--proposals`) | Per target memory: the intents that led to it (`cue`, `terms`), class, pool depth, `support` = distinct sessions, a `hub` flag. `confidence` is always `null`. | **Clear memory ids.** Keep the file local. |
| Evidence (`--evidence`) | Heatmap (how often a memory was served, loaded, loaded at which rank) and hot paths (memory A loaded, then B, within 30 minutes; established from 2 sessions). | **Clear memory ids.** Keep the file local. |
| Specimens (`--specimens`) | One observation per (lane, class), without the intent. | Hashed. |
| Report (standard error, one JSON line) | Coverage (what was read), observed (classes per lane, proposals), gaps (what could not be joined, with a reason and a recount), engines. | Hashed. |

A proposal is a suggestion for a human. The harvester writes no `recall_when`.

### The classes

| Class | Meaning | Proposal |
| --- | --- | --- |
| `served-hit` | The object the session used was among the served hits. Not a miss. | no |
| `in-pool-not-selected` | It was in the recorded candidate pool but not served. | yes |
| `genuine-out-of-pool` | It is a memory that existed at the time of the recall and was not in the pool at the recorded depth. | yes |
| `unindexed-vault-object` | It is in the vault but could not have been indexed then: created after the recall, or not a memory. | yes |
| `external-source` | The session read a file outside `--vault`. | no |
| `vault-gap` | An external read that a reviewer labelled `durable: true`. Only `--labels` leads here, and only together with `--vault`. | no |
| `unknown` | A proof is missing or contradicts another. Never a proposal. | no |

A chain with several recalls is judged against the union of their pools. If one
of them has no pool, or two were scored in different score spaces, there is no
pool and the class is `unknown`.

A proposal is only written when the target resolves to a memory id.

### Gaps in the report

Each gap kind is listed with its count, the number of distinct witnesses that
showed it (sessions; for a load the daemon linked to no recall, daemon runs),
and a verdict: `den` when at least 2 witnesses showed it, `noise` for fewer,
`none` for zero.

| Gap | Meaning |
| --- | --- |
| `envelope-without-recall-id` | A recall result carried no `recall_id`. |
| `load-without-recall-link` | Hook lane: the daemon linked the load to no recall. |
| `link-without-pool` | Hook lane: the linked recall has no pool in the telemetry read. |
| `batch-link-without-sibling-pools` | Hook lane: the linked recall is one phrasing of a batch. Not judged, see limits. |
| `load-not-found` | Hook lane: the vault did not hold the loaded id. |
| `unresolved-evidence` | The step after the recall named nothing inspectable (a search, for example). |
| `chain-without-pool` | The step named a vault object, but the chain's recalls joined no pool. |
| `no-vault-snapshot` | No `--vault`: membership cannot be proven. |

### Known limits

- **Without `--events`** no vault object can be classified; such chains are
  `unknown`. **Without `--vault`** every file read counts as
  `external-source`, also a file that lies in the vault.
- **Out of pool means out of the recorded pool.** The harvester does not
  re-run the search; a memory that would have appeared deeper is not seen.
- **Hook lane, one recall per load.** A load is judged against the single
  recall the daemon linked it to — its hook hint, or the most recent recall
  within five minutes. Several recalls for one question are not grouped there.
  A hit that an earlier recall served can therefore come out
  `genuine-out-of-pool` and be proposed. A transcript of the same session
  avoids this: loads the transcript lane observed are left out of the hook
  lane.
- **Hook lane, batch recalls.** Telemetry records the batch width
  (`query_count`) on each phrasing and nothing that names the other phrasings.
  A load linked to a batch phrasing is therefore reported as a gap and not
  classified.
- **A step in the same message as the recall** is not taken as evidence; only
  steps after the recall's result count.
- **After a slash command or an interrupt** recalls are ignored until the
  owner types again.
- **Subagent records** in a transcript are read like the main thread's.
- **Shell reads** are recognised only in the simple shapes named above; pipes,
  globs, variables and relative paths are not.
- **Thresholds** (hub 3 sessions, den 2 witnesses, hot path 30 minutes and 2
  sessions, live class 3 specimens) are set values, not measured on a corpus.

<a id="deutsch"></a>

## Deutsch

> **Entworfen und umgesetzt von [@zzallirog](https://github.com/zzallirog) (PR [#454](https://github.com/n0mad-ai/bastra-recall/pull/454), Arbeitsstrang A von #459).**
> Diese Seite beschreibt, was der Code tut. Die Begründung der Klassen und Bausteine steht im [Design-Dokument](./design/2026-09-13-reviewed-miss-observation-engines.md) (englisch).

### Wozu er dient

Recall beantwortet eine Frage mit einer Liste von Erinnerungen. Manchmal öffnet
die Sitzung danach eine Erinnerung oder eine Datei, die Recall nicht geliefert
hat. Der Harvester findet diese Stellen in Daten, die auf dem Rechner schon
vorhanden sind, und ordnet jede genau einer Klasse zu: Recall hat geantwortet,
die Erinnerung wurde gefunden, aber nicht geliefert, sie wurde gar nicht
gefunden, das Objekt konnte nicht im Index stehen, oder die Antwort kam von
außerhalb des Vaults. Aus den drei Klassen, die das Gedächtnis selbst beheben
könnte, leitet er eine Liste mit Stichwort-Vorschlägen für einen Prüfer ab —
welche Wörter der Frage zu welcher Erinnerung führen könnten.

Er ist ein Offline-Werkzeug des Repos. Er liest Dateien und schreibt die
Ausgabedateien, die man ihm nennt. Er spricht nicht mit dem Daemon, öffnet
keine Netzwerkverbindung, ruft kein Modell auf, lädt nichts hoch und schreibt
nie in den Vault. Am Verhalten von Recall ändert er nichts; nichts von dem, was
er erzeugt, wird von selbst irgendwo angewendet. Seine Module und sein Skript
sind vom veröffentlichten npm-Paket ausgenommen.

### So startet man ihn

Im Wurzelverzeichnis des Repos:

```sh
npm run harvest:reviewed-misses --workspace=@bastra-recall/daemon -- \
  --events /pfad/zur/telemetrie --vault /pfad/zum/vault \
  --out queue.json --proposals proposals.json /pfad/zur/sitzung.jsonl
```

Das Skript läuft in `packages/daemon`, deshalb absolute Pfade angeben.

| Schalter | Bedeutung |
| --- | --- |
| `sitzung.jsonl ...` | Ein oder mehrere Sitzungsprotokolle von Claude Code. Mit `--hook-lane` optional. |
| `--events DIR` | Das Telemetrie-Verzeichnis des Daemons (`events-*.jsonl`). Liefert zu jedem Recall den Kandidaten-Pool, verbunden über die `recall_id`. |
| `--vault DIR` | Das Wurzelverzeichnis des Vaults. Wird einmal aufgelistet, für die Zugehörigkeitsnachweise; nur lesend geöffnet. |
| `--labels FILE` | Prüfer-Markierungen, ein JSON-Objekt je Zeile: `{"ref": "sha256:…", "durable": true}`. `ref` ist ein `recallRef` oder `sourceRef` aus der Queue. |
| `--hook-lane` | Zusätzlich `load_memory`-Ereignisse allein aus der Telemetrie beobachten. Braucht `--events` und `--vault`. |
| `--out FILE` | Die Queue hierhin schreiben statt auf die Standardausgabe. |
| `--proposals FILE` | Die Stichwort-Vorschläge hierhin schreiben. |
| `--evidence FILE` | Heatmap und Hot Paths hierhin schreiben. |
| `--specimens FILE` | Je (Spur, Klasse) ein Belegstück hierhin schreiben. |
| `--hub-sessions N` | Anzahl verschiedener Sitzungen, ab der eine Erinnerung als Knotenpunkt (Hub) gilt. Standard 3. |
| `--since DAYS` | Nur Telemetrie-Ereignisse lesen, die jünger als `DAYS` Tage sind. Standard: alle Ereignisdateien im Verzeichnis. Filtert keine Sitzungsprotokolle. |

Rückgabewerte: `0` nach einem Lauf; `1` mit Meldung, wenn `--events` kein
Verzeichnis ist oder keine `events-*.jsonl` enthält, wenn `--vault` kein
Verzeichnis ist oder keine Erinnerung enthält, oder wenn eine Sitzungsdatei
nicht lesbar ist; `2` mit dem Hilfetext bei unbekanntem Schalter, fehlendem
Wert, ganz ohne Eingabe oder bei `--hook-lane` ohne `--events` und `--vault`.

### Was er liest

- **Sitzungsprotokolle.** Die getippte Nachricht des Besitzers ist die Absicht.
  Die dafür ausgeführten Recalls, ihre Ergebnis-Umschläge und der erste Schritt
  nach diesen Ergebnissen, der etwas Prüfbares benennt, bilden eine Kette.
  Dieser Schritt ist eine `load_memory`-Id, ein `Read`-Pfad (ein relativer wird
  gegen das im Protokoll festgehaltene Arbeitsverzeichnis aufgelöst) oder ein
  `cat` / `head` / `tail` / `grep MUSTER DATEI` auf genau eine Datei mit
  absolutem Pfad. Recalls ohne einen solchen Schritt dazwischen — zwei in einer
  Nachricht, ein wiederholter, die Formulierungen eines Batches — sind eine
  Kette. Vom Harness geschriebene Nachrichten (Aufgaben-Meldungen, Agentenpost,
  Erinnerungsblöcke) beenden keine Kette und gehen nicht in die Absicht ein.
  Ein Slash-Befehl und die Marke, die der Client bei einem Abbruch durch den
  Besitzer schreibt (`[Request interrupted by user…`), beenden die Kette und
  sind keine Absicht. Geheimnisse im getippten Text werden geschwärzt, bevor er
  übernommen wird.
- **Telemetrie.** `recall`- und `hook_recall`-Ereignisse mit `recall_id`,
  gelieferten `hits`, `candidate_pool` und Score-Raum; `load_memory`-Ereignisse
  mit dem Recall, dem der Daemon sie zugeordnet hat. Ein Recall-Ereignis ohne
  `candidate_pool` gilt nur dann als bekannter leerer Pool, wenn das Ereignis
  es selbst zeigt: eine leere `hits`-Liste und eigene `score_kind` /
  `score_arms`. Sonst fehlt der Pool.
- **Den Vault.** Dateipfade, Erinnerungs-Ids, die Entstehungszeit jeder Datei
  und ihr angegebenes `created`.
- **Prüfer-Markierungen**, falls angegeben.

### Was er schreibt

| Ausgabe | Inhalt | Kennungen |
| --- | --- | --- |
| Queue (`--out`, sonst Standardausgabe) | Ein Eintrag je beobachteter Kette oder je Load: Spur, Klasse, die geschwärzte Absicht, der eingefrorene Pool und die Nachweise. | Gehasht (`sha256:…`). Der Text der Absicht steht im Klartext. |
| Vorschläge (`--proposals`) | Je Ziel-Erinnerung: die Absichten, die zu ihr führten (`cue`, `terms`), Klasse, Pool-Tiefe, `support` = Anzahl verschiedener Sitzungen, eine `hub`-Markierung. `confidence` ist immer `null`. | **Erinnerungs-Ids im Klartext.** Datei lokal halten. |
| Belege (`--evidence`) | Heatmap (wie oft eine Erinnerung geliefert, geladen, auf welchem Rang geladen wurde) und Hot Paths (Erinnerung A geladen, dann B, innerhalb von 30 Minuten; ab 2 Sitzungen gefestigt). | **Erinnerungs-Ids im Klartext.** Datei lokal halten. |
| Belegstücke (`--specimens`) | Je (Spur, Klasse) eine Beobachtung, ohne die Absicht. | Gehasht. |
| Bericht (Standardfehlerausgabe, eine JSON-Zeile) | Abdeckung (was gelesen wurde), Beobachtetes (Klassen je Spur, Vorschläge), Lücken (was sich nicht verbinden ließ, mit Grund und Nachzählung), Bausteine. | Gehasht. |

Ein Vorschlag ist eine Anregung für einen Menschen. Der Harvester schreibt kein
`recall_when`.

### Die Klassen

| Klasse | Bedeutung | Vorschlag |
| --- | --- | --- |
| `served-hit` | Das Objekt, das die Sitzung benutzt hat, war unter den gelieferten Treffern. Kein Fehlgriff. | nein |
| `in-pool-not-selected` | Es stand im aufgezeichneten Kandidaten-Pool, wurde aber nicht geliefert. | ja |
| `genuine-out-of-pool` | Es ist eine Erinnerung, die zum Zeitpunkt des Recalls existierte und in der aufgezeichneten Tiefe nicht im Pool stand. | ja |
| `unindexed-vault-object` | Es liegt im Vault, konnte damals aber nicht im Index stehen: nach dem Recall entstanden oder keine Erinnerung. | ja |
| `external-source` | Die Sitzung hat eine Datei außerhalb von `--vault` gelesen. | nein |
| `vault-gap` | Ein Lesen von außen, das ein Prüfer mit `durable: true` markiert hat. Nur `--labels` führt hierhin, und nur zusammen mit `--vault`. | nein |
| `unknown` | Ein Nachweis fehlt oder widerspricht einem anderen. Nie ein Vorschlag. | nein |

Eine Kette mit mehreren Recalls wird gegen die Vereinigung ihrer Pools
beurteilt. Hat einer von ihnen keinen Pool oder wurden zwei in verschiedenen
Score-Räumen bewertet, gibt es keinen Pool und die Klasse ist `unknown`.

Ein Vorschlag wird nur geschrieben, wenn sich das Ziel zu einer Erinnerungs-Id
auflösen lässt.

### Lücken im Bericht

Jede Lückenart steht mit ihrer Anzahl, der Zahl verschiedener Zeugen, die sie
gezeigt haben (Sitzungen; bei einem Load, den der Daemon keinem Recall
zugeordnet hat, Daemon-Läufe), und einem Urteil im Bericht: `den`, wenn
mindestens 2 Zeugen sie gezeigt haben, `noise` bei weniger, `none` bei null.

| Lücke | Bedeutung |
| --- | --- |
| `envelope-without-recall-id` | Ein Recall-Ergebnis trug keine `recall_id`. |
| `load-without-recall-link` | Telemetrie-Spur: Der Daemon hat den Load keinem Recall zugeordnet. |
| `link-without-pool` | Telemetrie-Spur: Der zugeordnete Recall hat in der gelesenen Telemetrie keinen Pool. |
| `batch-link-without-sibling-pools` | Telemetrie-Spur: Der zugeordnete Recall ist eine Formulierung eines Batches. Wird nicht beurteilt, siehe Grenzen. |
| `load-not-found` | Telemetrie-Spur: Der Vault kannte die geladene Id nicht. |
| `unresolved-evidence` | Der Schritt nach dem Recall hat nichts Prüfbares benannt (zum Beispiel eine Suche). |
| `chain-without-pool` | Der Schritt hat ein Vault-Objekt benannt, aber die Recalls der Kette ergaben keinen Pool. |
| `no-vault-snapshot` | Kein `--vault`: Zugehörigkeit lässt sich nicht nachweisen. |

### Bekannte Grenzen

- **Ohne `--events`** lässt sich kein Vault-Objekt einordnen; solche Ketten
  sind `unknown`. **Ohne `--vault`** zählt jedes Lesen einer Datei als
  `external-source`, auch bei einer Datei, die im Vault liegt.
- **Außerhalb des Pools heißt außerhalb des aufgezeichneten Pools.** Der
  Harvester führt die Suche nicht erneut aus; eine Erinnerung, die tiefer
  aufgetaucht wäre, sieht er nicht.
- **Telemetrie-Spur, ein Recall je Load.** Ein Load wird gegen den einen Recall
  beurteilt, dem der Daemon ihn zugeordnet hat — seinen Hook-Hinweis oder den
  jüngsten Recall innerhalb von fünf Minuten. Mehrere Recalls zu einer Frage
  werden dort nicht zusammengefasst. Ein Treffer, den ein früherer Recall
  geliefert hat, kann deshalb als `genuine-out-of-pool` herauskommen und
  vorgeschlagen werden. Ein Protokoll derselben Sitzung vermeidet das: Loads,
  die die Protokoll-Spur beobachtet hat, lässt die Telemetrie-Spur aus.
- **Telemetrie-Spur, Batch-Recalls.** Die Telemetrie hält an jeder
  Formulierung die Batch-Breite fest (`query_count`) und nichts, was die
  anderen Formulierungen benennt. Ein Load, der einer Batch-Formulierung
  zugeordnet ist, wird deshalb als Lücke gemeldet und nicht eingeordnet.
- **Ein Schritt in derselben Nachricht wie der Recall** gilt nicht als Beleg;
  es zählen nur Schritte nach dem Ergebnis des Recalls.
- **Nach einem Slash-Befehl oder einem Abbruch** werden Recalls ignoriert, bis
  der Besitzer wieder tippt.
- **Subagenten-Einträge** in einem Protokoll werden wie die des Hauptstrangs
  gelesen.
- **Shell-Lesezugriffe** werden nur in den oben genannten einfachen Formen
  erkannt; Pipes, Platzhalter, Variablen und relative Pfade nicht.
- **Schwellen** (Hub 3 Sitzungen, `den` 2 Zeugen, Hot Path 30 Minuten und 2
  Sitzungen, „live"-Klasse 3 Belegstücke) sind gesetzte Werte, nicht an einem
  Korpus gemessen.
