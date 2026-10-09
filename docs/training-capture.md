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
Four rows in it carry a little more than before, and all of it is ids, hashes,
ranks and a flag. `BASTRA_TELEMETRY=off` switches these off together with the
rest of the log.

| Row | What is new | Why |
|---|---|---|
| `recall`, `hook_recall` | Each entry of `candidate_pool` also has `content_hash` (a 16-digit hash over the note's title, summary, `recall_when` and body) and, when keyword and vector search both ran, `rank_bm25` and `rank_vector` (the note's place in each; `null` when that search did not return it). | To tell later which state of a note was ranked. A private note gets no hash. |
| `load_memory` | `from_recall` and `recall_rank`: the id of the `recall` call that actually returned this note, and the note's place in its result. | Until now a load was linked only to whichever recall was newest in a five-minute window (`follows_recall`). That link stays as the fallback. The new link is kept in memory for ten minutes and is lost on a daemon restart. |
| every row of a measurement run | `eval_run: true` | To keep benchmark traffic apart from real use. |
| `rerank_verdict` (new) | Written by `bastra bridges harvest`, one row per judged question: `recall_id`, `candidate_ids`, `chosen_id`, `chosen_rank`, `model`. | The reranker's choice was not recorded anywhere. |

**How a measurement run is marked.** A row gets `eval_run: true` when the call
declared `client: "eval"` (the repository's own probe scripts do), or when the
whole process was started with `BASTRA_EVAL_RUN=1`. Start a benchmark daemon or
script with that variable and every row it writes is marked. The rows stay in
the same log directory: a separate directory would hide them from the tools
that read the log, while a flag lets each reader decide.

### The label store — off by default

With `BASTRA_TRAINING_CAPTURE=1` in the daemon's environment, Recall keeps the
texts that its draft check judges, together with the verdicts.

**Where.** One file: `training-capture.jsonl` in the log directory
(`~/.bastra/logs/` unless `BASTRA_LOG_PATH` points elsewhere). It is created
with permissions 0600 (readable by your user only). It is not inside the vault
and is not synchronised with it. Log retention does not delete it: retention
only removes `events-<date>.jsonl` files.

**This file contains text.** Unlike the event log, it holds what you typed and
excerpts of your notes. Recall never sends it anywhere and no part of Recall
reads it back to an assistant. Treat it like the vault itself: do not attach it
to a bug report.

**What is written**, one JSON object per line:

| `type` | Content |
|---|---|
| `statement` | A draft: the sentence you typed (`quote`), how it was captured (`draft_kind`), a short `context` if there was one, and a timestamp. Written once per sentence, before a draft can expire after 7 or 30 days, so the text outlives the draft. |
| `relation` | Two texts that were compared (`a`, `b`): two drafts, or a draft and a stored note (`b_is: "note"`, with `note_id`; the note's title, summary and the first 1,200 characters of its body). `source` says where the pair came from (`draft_repeat_shadow`, `draft_vault_shadow`, `promotion`), with the similarity values measured for it. |
| `verdict` | What the local model said about one of the above (`key` points to it): `verdict` (`durable`, `request`, `other` for a statement; `same`, `contradiction`, `different` for a relation; `none` when the reply was not a verdict), `model`, `prompt_version` (changes when the wording of the question changes), a timestamp, and `source` (`shadow` or `promotion`). |
| `human` | Reserved for a human label on one of the above (`key`, `label`). Nothing writes it yet. |

**The shadow check.** With the switch on, every new draft is put to the local
model, not only the few that are candidates for becoming a note, and so is
every recorded pair. The answers are written to this file and read by nothing:
which drafts become notes is decided exactly as before, by the separate check
described in [hooks](./hooks.md). At most 20 questions are asked per
five-minute background pass; the rest waits. Without a local model nothing is
asked. With [battery mode](./USAGE.md#battery-mode--keep-background-ollama-work-off-the-battery-macos)
on and the Mac on battery nothing is asked either; the texts are still kept and
are judged once the Mac is on mains power again.

**What is kept out.** A note marked `sensitivity: private` never reaches the
file, neither its text nor its id. Every text passes the same secret redaction
as a draft (see [secret redaction](./secret-redaction.md)), and a text that
looks like an attempt to instruct a model is not stored at all.

**Limits to know.** Drafts only exist while the after-session harvest runs
(`BASTRA_SESSION_HARVEST` not switched off). Pairs that were measured before
the switch was turned on are not captured afterwards. The file has no size
limit and is never trimmed; at a few hundred bytes per line it grows slowly,
but it grows.

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
pass starts a new file from the drafts that exist then.

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
ausschließlich Kennungen, Hashes, Ränge und ein Kennzeichen.
`BASTRA_TELEMETRY=off` schaltet sie zusammen mit dem übrigen Protokoll ab.

| Zeile | Was neu ist | Wozu |
|---|---|---|
| `recall`, `hook_recall` | Jeder Eintrag von `candidate_pool` hat zusätzlich `content_hash` (ein 16-stelliger Hash über Titel, Zusammenfassung, `recall_when` und Text der Notiz) und, wenn Stichwort- und Vektorsuche beide liefen, `rank_bm25` und `rank_vector` (der Platz der Notiz in der jeweiligen Suche; `null`, wenn diese Suche sie nicht geliefert hat). | Damit sich später sagen lässt, welcher Stand einer Notiz bewertet wurde. Eine private Notiz bekommt keinen Hash. |
| `load_memory` | `from_recall` und `recall_rank`: die Kennung des `recall`-Aufrufs, der diese Notiz tatsächlich geliefert hat, und ihr Platz in dessen Ergebnis. | Bisher war ein Ladevorgang nur mit dem jeweils neuesten Recall eines Fünf-Minuten-Fensters verknüpft (`follows_recall`). Diese Verknüpfung bleibt als Rückfall. Die neue wird zehn Minuten im Arbeitsspeicher gehalten und geht bei einem Neustart des Daemons verloren. |
| jede Zeile eines Messlaufs | `eval_run: true` | Damit sich Benchmark-Verkehr von echter Nutzung trennen lässt. |
| `rerank_verdict` (neu) | Geschrieben von `bastra bridges harvest`, eine Zeile je beurteilter Frage: `recall_id`, `candidate_ids`, `chosen_id`, `chosen_rank`, `model`. | Die Wahl der Nachsortierung wurde bisher nirgends festgehalten. |

**Wie ein Messlauf gekennzeichnet wird.** Eine Zeile bekommt `eval_run: true`,
wenn der Aufruf `client: "eval"` angegeben hat (das tun die Messskripte des
Repositorys) oder wenn der ganze Prozess mit `BASTRA_EVAL_RUN=1` gestartet
wurde. Wer einen Benchmark-Daemon oder ein Skript mit dieser Variable startet,
kennzeichnet damit jede Zeile, die es schreibt. Die Zeilen bleiben im selben
Protokollverzeichnis: Ein eigenes Verzeichnis würde sie vor den Werkzeugen
verstecken, die das Protokoll lesen, während ein Kennzeichen jedem Leser die
Entscheidung lässt.

### Die Etikett-Ablage — standardmäßig aus

Mit `BASTRA_TRAINING_CAPTURE=1` in der Umgebung des Daemons bewahrt Recall die
Texte auf, die seine Entwurfs-Prüfung beurteilt, zusammen mit den Urteilen.

**Wo.** Eine Datei: `training-capture.jsonl` im Protokollverzeichnis
(`~/.bastra/logs/`, sofern `BASTRA_LOG_PATH` nicht woandershin zeigt). Sie wird
mit den Rechten 0600 angelegt (nur für dein Benutzerkonto lesbar). Sie liegt
nicht im Vault und wird nicht mit ihm synchronisiert. Die Löschfrist der
Protokolle erfasst sie nicht: Gelöscht werden nur Dateien namens
`events-<Datum>.jsonl`.

**Diese Datei enthält Text.** Anders als das Ereignisprotokoll enthält sie, was
du getippt hast, und Auszüge deiner Notizen. Recall schickt sie nirgendwohin,
und kein Teil von Recall liest sie einem Assistenten wieder vor. Behandle sie
wie den Vault selbst: Hänge sie an keinen Fehlerbericht.

**Was geschrieben wird**, ein JSON-Objekt je Zeile:

| `type` | Inhalt |
|---|---|
| `statement` | Ein Entwurf: der Satz, den du getippt hast (`quote`), wie er erfasst wurde (`draft_kind`), ein kurzer `context`, falls es einen gab, und ein Zeitstempel. Einmal je Satz geschrieben, bevor ein Entwurf nach 7 oder 30 Tagen verfallen kann; der Text überlebt also den Entwurf. |
| `relation` | Zwei Texte, die verglichen wurden (`a`, `b`): zwei Entwürfe oder ein Entwurf und eine gespeicherte Notiz (`b_is: "note"`, mit `note_id`; Titel, Zusammenfassung und die ersten 1.200 Zeichen des Notiztexts). `source` nennt die Herkunft des Paars (`draft_repeat_shadow`, `draft_vault_shadow`, `promotion`), dazu die dafür gemessenen Ähnlichkeitswerte. |
| `verdict` | Was das lokale Modell zu einem der obigen Einträge gesagt hat (`key` verweist darauf): `verdict` (`durable`, `request`, `other` für eine Aussage; `same`, `contradiction`, `different` für ein Paar; `none`, wenn die Antwort kein Urteil war), `model`, `prompt_version` (ändert sich, wenn sich der Wortlaut der Frage ändert), ein Zeitstempel und `source` (`shadow` oder `promotion`). |
| `human` | Vorgesehen für ein Menschenurteil zu einem der obigen Einträge (`key`, `label`). Bisher schreibt das nichts. |

**Die Schattenprüfung.** Bei eingeschaltetem Schalter wird jeder neue Entwurf
dem lokalen Modell vorgelegt, nicht nur die wenigen, die Kandidaten für eine
Notiz sind, und ebenso jedes festgehaltene Paar. Die Antworten werden in diese
Datei geschrieben und von nichts gelesen: Welche Entwürfe zu Notizen werden,
entscheidet wie bisher die eigene Prüfung, die in [Hooks](./hooks.md)
beschrieben ist. Je Hintergrundlauf (alle fünf Minuten) werden höchstens 20
Fragen gestellt; der Rest wartet. Ohne lokales Modell wird nichts gefragt. Ist
der [Akkumodus](./USAGE.md#akkumodus--ollama-hintergrundarbeit-nicht-auf-dem-akku-macos)
an und läuft der Mac auf Akku, wird ebenfalls nichts gefragt; die Texte werden
trotzdem aufbewahrt und beurteilt, sobald der Mac wieder am Netz hängt.

**Was draußen bleibt.** Eine Notiz mit `sensitivity: private` gelangt nie in
die Datei, weder ihr Text noch ihre Kennung. Jeder Text durchläuft dieselbe
Schwärzung von Geheimnissen wie ein Entwurf (siehe
[Schwärzung von Geheimnissen](./secret-redaction.md)), und ein Text, der wie ein
Versuch aussieht, einem Modell Anweisungen zu geben, wird gar nicht
gespeichert.

**Grenzen, die man kennen sollte.** Entwürfe gibt es nur, solange die Ernte
nach der Sitzung läuft (`BASTRA_SESSION_HARVEST` nicht abgeschaltet). Paare,
die vor dem Einschalten gemessen wurden, werden nachträglich nicht erfasst. Die
Datei hat keine Größengrenze und wird nie gekürzt; bei einigen hundert Bytes je
Zeile wächst sie langsam, aber sie wächst.

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
gibt.
