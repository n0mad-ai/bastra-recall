# Training signal capture — a temporary tool for #1128 / Trainingssignal mitschreiben — ein befristetes Werkzeug für #1128

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

> **Temporary.** This exists for one purpose: step 0 of
> [#1128](https://github.com/n0mad-ai/bastra-recall/issues/1128), which
> evaluates whether the local models can be adapted to Recall's own tasks on
> the maintainer's own machine. It will be removed again once that evaluation
> no longer needs it. The part that stores text is **off by default**, and
> nothing described here leaves the machine.

### What changes without any switch

Nothing about stored text. Recall's local event log
(`~/.bastra/logs/events-<date>.jsonl`) stays free of note text and draft text.
Four rows in it carry a little more than before, and all of it is ids, keyed
hashes, ranks and a flag. One small file is new beside the log: the key for
those hashes (see below). `BASTRA_TELEMETRY=off` switches all of this off
together with the rest of the log.

| Row | What is new | Why |
|---|---|---|
| `recall`, `hook_recall` | Each entry of `candidate_pool` also has `content_hash` (16 hex digits, see "The content hash and its key") and, when keyword and vector search both ran, `rank_bm25` and `rank_vector` (the note's place in each; `null` when that search did not return it). | To recognise later which version of a note was ranked. A private note gets no hash. |
| `load_memory` | `from_recall` and `recall_rank`: the id of the `recall` call that delivered this note to the same caller, and the note's place in its result. `null` when that cannot be said for certain (see "The recall link"). | Until now a load was linked only to whichever recall was newest in a five-minute window (`follows_recall`). That link is unchanged and remains the fallback. |
| rows of a measurement run | `eval_run: true` | To keep benchmark traffic apart from real use. |
| `rerank_verdict` (new) | Written by `bastra bridges harvest`, one row per judged question: `recall_id`, `candidate_ids`, `chosen_id`, `chosen_rank`, `model`. | The reranker's choice was not recorded anywhere. |

**The content hash and its key.** `content_hash` is an HMAC-SHA-256 over the
note's title, summary, `recall_when` and body, shortened to 16 hex digits and
keyed with a secret that exists only on this machine. What it is good for: the
same version of a note gives the same value here, so a later or archived copy
can be recognised as the one a recall ranked. What it does not allow: without
the key, nobody can test guesses about a note's content against the value, not
even for a short note with a known title. The key is 32 random bytes in
`training-signal.key` in the log directory, created on first use with
permissions 0600. It is never written to the vault or into an event row. If you
delete it, a new one is created and earlier hashes can no longer be matched. If
the key file is a link or cannot be read, no hash is written at all.

**The recall link.** `from_recall` is set only when it is certain: the recall
and the load must carry the same caller session, and the note must be one the
recall actually delivered, that is, after a `max_tokens` budget has cut the
answer and, for a batch of phrasings, in the merged answer. Two sessions that
were given the same note are never linked to each other's recall. A caller that
names no session (the stdio server, a plain REST client) gets no `from_recall`;
for those rows `follows_recall` is all there is, and it remains a time-window
guess. The link is held in memory for ten minutes and is gone after a daemon
restart. It covers `recall` rows; a recall that arrives through a hook or the
MCP forwarder is a `hook_recall` and keeps its existing link `from_hook_recall`.

**How a measurement run is marked.** A row gets `eval_run: true` when the call
declared `client: "eval"` (the repository's own probe scripts do; a batch of
phrasings passes it on to each row), or when the whole process was started with
`BASTRA_EVAL_RUN=1`. Start a benchmark daemon or script with that variable and
every row it writes is marked. Nothing marks a run by itself: a measurement
that declares neither is written as real use. The rows stay in the same log
directory: a separate directory would hide them from the tools that read the
log, while a flag lets each reader decide. Existing reports do not filter on
`eval_run` yet. `bastra logs --stats` and the map telemetry view leave out rows with `client: "eval"`
only; the curator, the bridge mint and every other reader count flagged rows
like any other until they are taught to skip them.

### The label store — off by default

With `BASTRA_TRAINING_CAPTURE=1` in the daemon's environment, Recall keeps the
texts that its draft check judges, together with the verdicts.

**Where.** One file: `training-capture.jsonl` in the log directory
(`~/.bastra/logs/` unless `BASTRA_LOG_PATH` points elsewhere). It is created
with permissions 0600 (readable by your user only). It is not inside the vault
and is not synchronised with it. Log retention does not delete it: retention
only removes `events-<date>.jsonl` files. If something else is found under that
name, a symbolic link or a file that has a second name, Recall writes nothing,
leaves it untouched and prints one warning to the daemon's log.

**This file contains text.** Unlike the event log, it holds what you typed and
excerpts of your notes. Recall never sends it anywhere and no part of Recall
reads it back to an assistant. Treat it like the vault itself: do not attach it
to a bug report.

**What is written**, one JSON object per line:

| `type` | Content |
|---|---|
| `statement` | A draft: the sentence you typed (`quote`), how it was captured (`draft_kind`), a short `context` if there was one, and a timestamp. Written once per sentence, in the background pass before drafts are expired, so the text outlives the draft. A draft that is already due when capture is switched on is still kept, as long as it is in the draft file. |
| `relation` | Two texts that were compared (`a`, `b`): two drafts, or a draft and a stored note (`b_is: "note"`, with `note_id`; the note's title, summary and the first 1,200 characters of its body). `a` and `b` are stored in the order in which the model is asked, and a verdict belongs to that order; the same two texts in the opposite order are a separate entry. `source` says where the pair came from (`draft_repeat_shadow`, `draft_vault_shadow`, `promotion`), with the similarity values measured for it. |
| `verdict` | What the local model said about one of the above (`key` points to it): `verdict` (`durable`, `request`, `other` for a statement; `same`, `contradiction`, `different` for a relation; `none` when the reply was not a verdict), `model`, `prompt_version` (changes when the wording of the question changes), a timestamp, and `source` (`shadow` or `promotion`). |
| `human` | Reserved for a human label on one of the above (`key`, `label`). Nothing writes it yet. |

**The shadow check.** With the switch on, every new draft is put to the local
model, not only the few that are candidates for becoming a note, and so is
every recorded pair. The answers are written to this file and read by nothing:
which drafts become notes is decided exactly as before, by the separate check
described in [hooks](./hooks.md). At most 20 questions are asked per
five-minute background pass, one after the other; the rest waits. Without a
local model nothing is asked.

Two costs to know. The questions run inside the background pass, so a slow
model makes that pass longer, and the next pass (session harvest, draft expiry,
promotion) starts only when it is done. And the model is asked on battery too,
unless [battery mode](./USAGE.md#battery-mode--keep-background-ollama-work-off-the-battery-macos)
is switched on: battery mode is off by default, and only with it on does a Mac
on battery ask nothing. In that case the texts are still kept and are judged
once the Mac is on mains power again.

**What is kept out.** A note marked `sensitivity: private` never reaches the
file, neither its text nor its id. Every text, the `context` included, passes
the same secret redaction as a draft (see
[secret redaction](./secret-redaction.md)). An entry in which the quote, the
context or either side of a pair looks like an attempt to instruct a model is
not stored at all. Both filters work by pattern: they lower the risk and do not
guarantee that nothing sensitive is ever written, which is one more reason to
treat the file like the vault.

**Limits to know.** Drafts only exist while the after-session harvest runs
(`BASTRA_SESSION_HARVEST` not switched off). Pairs that were measured before
the switch was turned on are not captured afterwards. A draft that the draft
file's own size limit drops in the very write that added it never reaches the
store. The file has no size limit and is never trimmed; at a few hundred bytes
per line it grows slowly, but it grows.

### Switching it on and off

Set `BASTRA_TRAINING_CAPTURE=1` in the environment the daemon starts with, then
restart the daemon. Accepted values are `1`, `true`, `on` and `yes`. To switch
it off, remove the variable or set it to `0` and restart the daemon. From then
on nothing is added and the model is no longer asked the extra questions. The
file stays where it is.

### Deleting it

Delete the file:

```sh
rm ~/.bastra/logs/training-capture.jsonl
```

That removes everything the label store ever held. `bastra drafts purge`
removes the drafts but not this file, because keeping the text after a draft is
gone is what the file is for. If the switch is still on, the next background
pass starts a new file from the drafts that exist then. The hash key is a
separate file (`~/.bastra/logs/training-signal.key`) and holds no text; delete
it as well if you want earlier content hashes to become unmatchable.

<a id="deutsch"></a>

## Deutsch

> **Befristet.** Das hier dient einem einzigen Zweck: Stufe 0 von
> [#1128](https://github.com/n0mad-ai/bastra-recall/issues/1128), in dem geprüft
> wird, ob sich die lokalen Modelle auf dem eigenen Rechner des Maintainers an
> Recalls eigene Aufgaben anpassen lassen. Es wird wieder entfernt, sobald
> diese Prüfung es nicht mehr braucht. Der Teil, der Text speichert, ist
> **standardmäßig aus**, und nichts von dem, was hier beschrieben ist, verlässt
> den Rechner.

### Was sich ohne Schalter ändert

Nichts an gespeichertem Text. Recalls lokales Ereignisprotokoll
(`~/.bastra/logs/events-<Datum>.jsonl`) bleibt frei von Notiz- und
Entwurfstext. Vier Zeilenarten darin tragen etwas mehr als bisher, und das sind
ausschließlich Kennungen, Hashes mit Schlüssel, Ränge und ein Kennzeichen. Neu
ist außerdem eine kleine Datei neben dem Protokoll: der Schlüssel für diese
Hashes (siehe unten). `BASTRA_TELEMETRY=off` schaltet all das zusammen mit dem
übrigen Protokoll ab.

| Zeile | Was neu ist | Wozu |
|---|---|---|
| `recall`, `hook_recall` | Jeder Eintrag von `candidate_pool` hat zusätzlich `content_hash` (16 Hex-Stellen, siehe „Der Inhalts-Hash und sein Schlüssel“) und, wenn Stichwort- und Vektorsuche beide liefen, `rank_bm25` und `rank_vector` (der Platz der Notiz in der jeweiligen Suche; `null`, wenn diese Suche sie nicht geliefert hat). | Damit sich später wiedererkennen lässt, welche Fassung einer Notiz bewertet wurde. Eine private Notiz bekommt keinen Hash. |
| `load_memory` | `from_recall` und `recall_rank`: die Kennung des `recall`-Aufrufs, der diese Notiz an denselben Aufrufer ausgeliefert hat, und ihr Platz in dessen Ergebnis. `null`, wenn sich das nicht sicher sagen lässt (siehe „Die Recall-Verknüpfung“). | Bisher war ein Ladevorgang nur mit dem jeweils neuesten Recall eines Fünf-Minuten-Fensters verknüpft (`follows_recall`). Diese Verknüpfung ist unverändert und bleibt der Rückfall. |
| Zeilen eines Messlaufs | `eval_run: true` | Damit sich Benchmark-Verkehr von echter Nutzung trennen lässt. |
| `rerank_verdict` (neu) | Geschrieben von `bastra bridges harvest`, eine Zeile je beurteilter Frage: `recall_id`, `candidate_ids`, `chosen_id`, `chosen_rank`, `model`. | Die Wahl der Nachsortierung wurde bisher nirgends festgehalten. |

**Der Inhalts-Hash und sein Schlüssel.** `content_hash` ist ein HMAC-SHA-256
über Titel, Zusammenfassung, `recall_when` und Text der Notiz, gekürzt auf 16
Hex-Stellen und gebildet mit einem Geheimnis, das es nur auf diesem Rechner
gibt. Wofür er taugt: Dieselbe Fassung einer Notiz ergibt hier denselben Wert,
eine spätere oder archivierte Kopie lässt sich also als diejenige
wiedererkennen, die ein Recall bewertet hat. Was er nicht erlaubt: Ohne den
Schlüssel kann niemand Vermutungen über den Inhalt einer Notiz gegen den Wert
prüfen, auch nicht bei einer kurzen Notiz mit bekanntem Titel. Der Schlüssel
sind 32 zufällige Bytes in `training-signal.key` im Protokollverzeichnis, beim
ersten Gebrauch mit den Rechten 0600 angelegt. Er wird nie in den Vault und nie
in eine Ereigniszeile geschrieben. Löschst du ihn, entsteht ein neuer, und
frühere Hashes lassen sich nicht mehr zuordnen. Ist die Schlüsseldatei eine
Verknüpfung oder nicht lesbar, wird gar kein Hash geschrieben.

**Die Recall-Verknüpfung.** `from_recall` wird nur gesetzt, wenn es sicher ist:
Recall und Ladevorgang müssen dieselbe Sitzung des Aufrufers tragen, und die
Notiz muss eine sein, die der Recall tatsächlich ausgeliefert hat, also nachdem
ein `max_tokens`-Budget die Antwort gekürzt hat und, bei mehreren
Formulierungen in einem Aufruf, in der zusammengeführten Antwort. Zwei
Sitzungen, die dieselbe Notiz bekommen haben, werden nie dem Recall der jeweils
anderen zugeordnet. Ein Aufrufer, der keine Sitzung nennt (der stdio-Server,
ein einfacher REST-Client), bekommt kein `from_recall`; für diese Zeilen gibt
es nur `follows_recall`, und das bleibt eine Vermutung aus dem Zeitfenster. Die
Verknüpfung wird zehn Minuten im Arbeitsspeicher gehalten und ist nach einem
Neustart des Daemons weg. Sie betrifft `recall`-Zeilen; ein Recall, der über
einen Hook oder den MCP-Forwarder kommt, ist ein `hook_recall` und behält seine
bisherige Verknüpfung `from_hook_recall`.

**Wie ein Messlauf gekennzeichnet wird.** Eine Zeile bekommt `eval_run: true`,
wenn der Aufruf `client: "eval"` angegeben hat (das tun die Messskripte des
Repositorys; ein Aufruf mit mehreren Formulierungen gibt es an jede Zeile
weiter) oder wenn der ganze Prozess mit `BASTRA_EVAL_RUN=1` gestartet wurde.
Wer einen Benchmark-Daemon oder ein Skript mit dieser Variable startet,
kennzeichnet damit jede Zeile, die es schreibt. Von selbst wird kein Lauf
gekennzeichnet: Eine Messung, die keins von beidem angibt, wird wie echte
Nutzung geschrieben. Die Zeilen bleiben im selben Protokollverzeichnis: Ein
eigenes Verzeichnis würde sie vor den Werkzeugen verstecken, die das Protokoll
lesen, während ein Kennzeichen jedem Leser die Entscheidung lässt. Bestehende
Auswertungen filtern noch nicht nach `eval_run`. `bastra logs --stats` und die Telemetrieansicht der Map lassen
nur Zeilen mit `client: "eval"` weg; der Kurator, die Bridge-Erzeugung und
jeder andere Leser zählen gekennzeichnete Zeilen wie alle anderen, bis man
ihnen beibringt, sie zu überspringen.

### Die Etikett-Ablage — standardmäßig aus

Mit `BASTRA_TRAINING_CAPTURE=1` in der Umgebung des Daemons bewahrt Recall die
Texte auf, die seine Entwurfs-Prüfung beurteilt, zusammen mit den Urteilen.

**Wo.** Eine Datei: `training-capture.jsonl` im Protokollverzeichnis
(`~/.bastra/logs/`, sofern `BASTRA_LOG_PATH` nicht woandershin zeigt). Sie wird
mit den Rechten 0600 angelegt (nur für dein Benutzerkonto lesbar). Sie liegt
nicht im Vault und wird nicht mit ihm synchronisiert. Die Löschfrist der
Protokolle erfasst sie nicht: Gelöscht werden nur Dateien namens
`events-<Datum>.jsonl`. Liegt unter diesem Namen etwas anderes, eine
symbolische Verknüpfung oder eine Datei mit einem zweiten Namen, schreibt
Recall nichts, lässt es unangetastet und gibt eine Warnung ins Protokoll des
Daemons aus.

**Diese Datei enthält Text.** Anders als das Ereignisprotokoll enthält sie, was
du getippt hast, und Auszüge deiner Notizen. Recall schickt sie nirgendwohin,
und kein Teil von Recall liest sie einem Assistenten wieder vor. Behandle sie
wie den Vault selbst: Hänge sie an keinen Fehlerbericht.

**Was geschrieben wird**, ein JSON-Objekt je Zeile:

| `type` | Inhalt |
|---|---|
| `statement` | Ein Entwurf: der Satz, den du getippt hast (`quote`), wie er erfasst wurde (`draft_kind`), ein kurzer `context`, falls es einen gab, und ein Zeitstempel. Einmal je Satz geschrieben, im Hintergrundlauf vor dem Verfall der Entwürfe; der Text überlebt also den Entwurf. Ein Entwurf, der beim Einschalten schon fällig ist, wird noch gesichert, solange er in der Entwurfsdatei steht. |
| `relation` | Zwei Texte, die verglichen wurden (`a`, `b`): zwei Entwürfe oder ein Entwurf und eine gespeicherte Notiz (`b_is: "note"`, mit `note_id`; Titel, Zusammenfassung und die ersten 1.200 Zeichen des Notiztexts). `a` und `b` stehen in der Reihenfolge, in der das Modell gefragt wird, und ein Urteil gilt für diese Reihenfolge; dieselben zwei Texte in umgekehrter Reihenfolge sind ein eigener Eintrag. `source` nennt die Herkunft des Paars (`draft_repeat_shadow`, `draft_vault_shadow`, `promotion`), dazu die dafür gemessenen Ähnlichkeitswerte. |
| `verdict` | Was das lokale Modell zu einem der obigen Einträge gesagt hat (`key` verweist darauf): `verdict` (`durable`, `request`, `other` für eine Aussage; `same`, `contradiction`, `different` für ein Paar; `none`, wenn die Antwort kein Urteil war), `model`, `prompt_version` (ändert sich, wenn sich der Wortlaut der Frage ändert), ein Zeitstempel und `source` (`shadow` oder `promotion`). |
| `human` | Vorgesehen für ein Menschenurteil zu einem der obigen Einträge (`key`, `label`). Bisher schreibt das nichts. |

**Die Schattenprüfung.** Bei eingeschaltetem Schalter wird jeder neue Entwurf
dem lokalen Modell vorgelegt, nicht nur die wenigen, die Kandidaten für eine
Notiz sind, und ebenso jedes festgehaltene Paar. Die Antworten werden in diese
Datei geschrieben und von nichts gelesen: Welche Entwürfe zu Notizen werden,
entscheidet wie bisher die eigene Prüfung, die in [Hooks](./hooks.md)
beschrieben ist. Je Hintergrundlauf (alle fünf Minuten) werden höchstens 20
Fragen gestellt, eine nach der anderen; der Rest wartet. Ohne lokales Modell
wird nichts gefragt.

Zwei Kosten, die man kennen sollte. Die Fragen laufen innerhalb des
Hintergrundlaufs; ein langsames Modell verlängert ihn also, und der nächste
Lauf (Sitzungs-Ernte, Verfall der Entwürfe, Beförderung) beginnt erst, wenn er
fertig ist. Und das Modell wird auch auf Akku gefragt, solange der
[Akkumodus](./USAGE.md#akkumodus--ollama-hintergrundarbeit-nicht-auf-dem-akku-macos)
nicht eingeschaltet ist: Der Akkumodus ist standardmäßig aus, und nur mit ihm
fragt ein Mac auf Akku nichts. In dem Fall werden die Texte trotzdem
aufbewahrt und beurteilt, sobald der Mac wieder am Netz hängt.

**Was draußen bleibt.** Eine Notiz mit `sensitivity: private` gelangt nie in
die Datei, weder ihr Text noch ihre Kennung. Jeder Text, auch der `context`,
durchläuft dieselbe Schwärzung von Geheimnissen wie ein Entwurf (siehe
[Schwärzung von Geheimnissen](./secret-redaction.md)). Ein Eintrag, in dem das
Zitat, der Kontext oder eine der beiden Seiten eines Paars wie ein Versuch
aussieht, einem Modell Anweisungen zu geben, wird gar nicht gespeichert. Beide
Filter arbeiten nach Mustern: Sie senken das Risiko und garantieren nicht, dass
nie etwas Heikles geschrieben wird. Auch deshalb gilt: die Datei wie den Vault
behandeln.

**Grenzen, die man kennen sollte.** Entwürfe gibt es nur, solange die Ernte
nach der Sitzung läuft (`BASTRA_SESSION_HARVEST` nicht abgeschaltet). Paare,
die vor dem Einschalten gemessen wurden, werden nachträglich nicht erfasst. Ein
Entwurf, den die Größengrenze der Entwurfsdatei schon in dem Schreibvorgang
verdrängt, der ihn angelegt hat, erreicht die Ablage nie. Die Datei hat keine
Größengrenze und wird nie gekürzt; bei einigen hundert Bytes je Zeile wächst
sie langsam, aber sie wächst.

### Ein- und ausschalten

Setze `BASTRA_TRAINING_CAPTURE=1` in der Umgebung, mit der der Daemon startet,
und starte den Daemon neu. Gültige Werte sind `1`, `true`, `on` und `yes`. Zum
Ausschalten die Variable entfernen oder auf `0` setzen und den Daemon neu
starten. Ab dann kommt nichts mehr hinzu, und dem Modell werden die
zusätzlichen Fragen nicht mehr gestellt. Die Datei bleibt, wo sie ist.

### Löschen

Lösche die Datei:

```sh
rm ~/.bastra/logs/training-capture.jsonl
```

Damit ist alles weg, was die Etikett-Ablage je enthielt. `bastra drafts purge`
entfernt die Entwürfe, aber nicht diese Datei, denn den Text aufzubewahren,
nachdem ein Entwurf weg ist, ist ihr Zweck. Ist der Schalter noch an, beginnt
der nächste Hintergrundlauf eine neue Datei aus den Entwürfen, die es dann
gibt. Der Hash-Schlüssel ist eine eigene Datei
(`~/.bastra/logs/training-signal.key`) und enthält keinen Text; lösche auch
ihn, wenn sich frühere Inhalts-Hashes nicht mehr zuordnen lassen sollen.
