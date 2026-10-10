# Privacy and network use / Datenschutz und Netzwerkzugriffe

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

Bastra Recall stores memories as files in your chosen vault. Keyword search runs locally. This describes the memory service, not every system connected to it.

| Data path | What happens |
|---|---|
| AI assistant | Retrieved memories, document text and hook context are passed to the connected client. If that client uses a cloud model, its provider may process the content. Your client's settings and data policy apply. |
| Local embeddings | Optional Ollama embeddings process queries and memory text locally with a local endpoint. Deliberately allowing a remote Ollama endpoint changes that boundary. |
| OpenAI embeddings | Requires an explicit provider choice and credentials. Queries and indexed memory text are sent to `api.openai.com`. An unrelated `OPENAI_API_KEY` alone does not select this provider in the v1.0 implementation. |
| Importing chat exports | The import queue is stored locally. When you ask your assistant to extract memories, it reads chunks of that queue; a cloud-based assistant may process those chunks remotely. `bastra import clear` discards the queue. |
| File synchronization | A vault in iCloud, Google Drive, Dropbox or a Git remote uses that service. Choose its access and backup settings yourself. Concurrent file edits can conflict. |
| REST access | The service normally listens on your computer. If you expose it through a tunnel or connect another application, that application can receive the data allowed by the API. Follow the [REST setup](./USAGE.md#rest-api-for-non-mcp-clients). |
| Bastra Commons | Optional downloads of community recipes. Sharing a contribution is a separate, reviewed action; enabling Commons does not publish your private vault. See [Commons](./commons.md). |

### Other network activity

- Installation and model setup download software and models from the selected distribution services.
- Update detection checks GitHub for releases. `BASTRA_UPDATE_CHECK=off` disables the update check.
- The statusline can refresh model pricing information.
- Optional map weather/geocoding sends a coarse location after you choose a place. It does not need memory contents.

These requests are distinct from uploading a vault. Local telemetry records activity and timings; the map's telemetry view reads local logs. Before sharing logs or a bug report, check for personal information, tokens and private paths.

One local file can hold text you typed and excerpts of your notes: `training-capture.jsonl` in the log directory. It is written only when `BASTRA_TRAINING_CAPTURE` is enabled (`1`, `true`, `on` or `yes`), which is off by default; it is a temporary tool for the evaluation in #1128 and is never sent anywhere. See [training signal capture](./training-capture.md).

### Local drafts

While the after-session harvest is enabled and sessions are booked by its hooks,
it captures typed user messages that pass the noise filter, have at least
20 letters and fewer than 2,000 characters. Injected turns, interruptions and
large pastes are excluded. At harvest time, a separate word-based check skips
quotes already covered by stored vault wording. A later save call in the
transcript does not itself suppress capture; the note it actually saved can
still make that separate vault check match. Drafts remain unconfirmed quotes,
separate from vault notes.

Where available in the client transcript, a draft also keeps up to three earlier
and three following assistant shell commands, up to three previously read file
paths, working directory, project and branch. These fields use the same redaction
heuristic as the quote. Session/turn/time evidence and later delivery/use evidence
are recorded too. The optional `context` field is an excerpt of the assistant
question the message answers (its last line, at most 160 characters).

The default local files are:

- `~/.bastra/drafts.json`: quotes, context, situation and evidence; permissions 0600.
- `~/.bastra/drafts.vectors.json`: model-bound local vectors and hash metadata; permissions 0600.
- `~/.bastra/drafts.json.decisions.json`: hash-only decision receipts, no quotes; permissions 0600.
- `~/.bastra/pending-suggestions.json`: the shared suggestion relay, with redacted text; ordinary writes in the prepared 1.1 release use 0600. Legacy rows are redacted before delivery and on their next ordinary write.
- `~/.bastra/harvest-queue.json`: session/transcript paths and harvest progress, not quotes. This is separate from the draft store and is not deleted by draft purge.

`BASTRA_DRAFTS_PATH` relocates the draft store and its vector/decision sidecars;
`BASTRA_PENDING_SUGGESTIONS_PATH` and `BASTRA_HARVEST_QUEUE_PATH` can relocate the
relay and queue. Normal harvest relay entries are consumed at the next session
start; entries older than seven days are dropped on that read. The same relay
also holds trends, which retire by counted sessions and can last longer.
Without another read, old relay rows can remain on disk.

Recognizable credentials are redacted before storage; useful paths and variable
references remain. The filter is a heuristic with [known limits](./secret-redaction.md):
word-only passwords in ordinary prose and unsupported forms can remain visible.
It does not repair the original client transcript, old vault notes or backups.
Quotes are clipped to 600 characters and context to 160; the store holds at most
500 rows and 1 MiB, so its limits can evict rows earlier.

Open drafts with one evidence row and no valid use proof expire after 7 days;
other open drafts after 30 days, closed/rejected/promotion records after 180 days,
measured from their last touch. Active harvest ticks and ordinary store writes
remove expired rows. If that work is disabled, old data can remain on disk.
Draft telemetry contains IDs, counts and metrics, not the captured quote.

Capture, draft embeddings and meaning checks run locally, without uploading
these local files. The meaning check can call a local model even in the default
dry run. Without exactly `BASTRA_DRAFT_PROMOTE=1`, automatic draft promotion
writes no vault note. Text can reach the connected assistant through the
unconfirmed band at prompts, session starts and before tool calls; through
`draft_hits` in the MCP `recall` result; and through the pending relay at the
next session start. A cloud-based assistant may process those texts remotely
under its own policy. After opt-in promotion, the derived note is ordinary vault
content: it can be retrieved by connected clients and processed by the chosen
vault embedding provider, including a non-local provider. That provider path
is separate from the assistant; draft embeddings themselves remain local.

#### Switching off and clearing drafts

Set the switches in the **daemon's environment** and restart it; changing only
a CLI shell does not alter a running daemon. Off values are `0`, `false`, `off`
and `no`, case-insensitive with surrounding whitespace ignored.

- `BASTRA_SESSION_HARVEST=0` stops booking/capture, the harvest tick, shadow comparisons, automatic promotion and new harvest relay writes. Existing draft hints still work unless hints are also disabled.
- `BASTRA_DRAFT_HINTS=0` stops the unconfirmed hint band, `draft_hits` and use tracking. It does not stop capture or relay writes/delivery.
- Neither switch stops SessionStart from delivering existing relay entries. Other relay writers, including the independent Stop evaluation and curator, are not controlled by these two switches.

For draft capture and hints to stay off, set **both** switches.
`bastra drafts list` inspects the store. `bastra drafts purge` removes only the
draft store, vectors and decision receipts; it does **not** clear the relay,
harvest queue, optional training capture or already promoted vault notes.
To remove retained relay text, stop the daemon and delete the actual
`pending-suggestions.json` file in your file manager (the default path is above).
Delete the harvest queue too if its retained session/path metadata is unwanted;
reenabling harvest can otherwise resume queued sessions. Restart with both
switches off. Independent Stop/curator producers must also be disabled if no
new shared relay entries are wanted. On an existing Claude Code installation,
`bastra install claude-code --no-stop-hook` preserves a previously enabled Stop
hook and its SessionEnd companion; it does not remove them. Disable/remove those
entries explicitly in the client's hook configuration when needed.
The [optional training store](./training-capture.md) has its own retained data.

The suggestion relay keeps earlier session excerpts in
`~/.bastra/pending-suggestions.json`, outside the vault, with permissions 0600.
It removes recognizable credentials with the same heuristic as local drafts
before writing or delivering the text to your assistant. Existing rows are
cleaned on their next ordinary write and before delivery, without a migration.
An unreadable or malformed existing relay is left untouched: the new write is
skipped with a warning that contains no excerpts or paths. A missing file is
created normally.
Recency entries are consumed at the next session start; entries older than
seven days are dropped on that read. Trends retire by their configured session
counter; their tombstones remain for that many further counted starts unless
refreshed. Without further reads, rows can remain on disk. The heuristic has [known limits](./secret-redaction.md).

### Your control

Inspect and edit the Markdown files directly, or use the memory tools through your assistant. Use `bastra embeddings off` for keyword-only search and `bastra embeddings on` to set up local embeddings. Removing client registrations with `bastra uninstall all` keeps your vault; uninstalling the package is a separate step.

The `sensitivity` field filters access through specific Bastra interfaces. It is not file encryption or a substitute for operating-system permissions. See the [memory schema](./memory-schema.md#privacy-field). Report suspected vulnerabilities through [SECURITY.md](../SECURITY.md).

This page includes the changes prepared for 1.1.0. Check the [changelog](../CHANGELOG.md) for version-specific changes.

<a id="deutsch"></a>

## Deutsch

Bastra Recall speichert Erinnerungen als Dateien in deinem gewählten Vault. Die Stichwortsuche läuft lokal. Das beschreibt den Gedächtnisdienst, nicht jedes damit verbundene System.

| Datenweg | Was passiert |
|---|---|
| KI-Assistent | Abgerufene Erinnerungen, Dokumenttexte und Hook-Kontext werden dem verbundenen Client übergeben. Nutzt er ein Cloud-Modell, kann dessen Anbieter die Inhalte verarbeiten. Es gelten die Einstellungen und Datenschutzbedingungen deines Clients. |
| Lokale Embeddings | Optionale Ollama-Embeddings verarbeiten Anfragen und Erinnerungstexte mit einem lokalen Endpunkt auf deinem Rechner. Wenn du bewusst einen entfernten Ollama-Endpunkt erlaubst, ändert sich diese Grenze. |
| OpenAI-Embeddings | Erfordern die ausdrückliche Provider-Wahl und Zugangsdaten. Suchanfragen und indizierte Erinnerungstexte gehen an `api.openai.com`. Ein anderweitig gesetzter `OPENAI_API_KEY` allein wählt diesen Provider in der v1.0-Implementierung nicht aus. |
| Chat-Exporte importieren | Die Import-Warteschlange liegt lokal. Wenn du deinen Assistenten Erinnerungen daraus extrahieren lässt, liest er Abschnitte dieser Warteschlange; ein cloudbasierter Assistent kann sie beim Anbieter verarbeiten. `bastra import clear` verwirft die Warteschlange. |
| Datei-Synchronisierung | Ein Vault in iCloud, Google Drive, Dropbox oder einem Git-Remote nutzt diesen Dienst. Zugriff und Backups bestimmst du selbst. Gleichzeitige Dateiänderungen können Konflikte verursachen. |
| REST-Zugriff | Der Dienst lauscht normalerweise auf deinem Rechner. Wenn du ihn durch einen Tunnel erreichbar machst oder eine weitere Anwendung verbindest, kann sie die von der API erlaubten Daten erhalten. Siehe [REST-Einrichtung](./USAGE.md#rest-api-für-nicht-mcp-clients). |
| Bastra Commons | Optionaler Download von Community-Rezepten. Das Teilen eines Beitrags ist eine separate, geprüfte Aktion; die Aktivierung veröffentlicht deinen privaten Vault nicht. Siehe [Commons](./commons.md). |

### Weitere Netzwerkzugriffe

- Installation und Modelleinrichtung laden Software und Modelle von den gewählten Bezugsquellen herunter.
- Die Update-Erkennung fragt GitHub nach Releases. `BASTRA_UPDATE_CHECK=off` deaktiviert diese Prüfung.
- Die Statusline kann Modellpreise aktualisieren.
- Die optionale Wetter-/Geocoding-Funktion der Map sendet nach deiner Ortswahl einen groben Standort. Sie benötigt keine Erinnerungsinhalte.

Diese Anfragen sind vom Hochladen eines Vaults zu unterscheiden. Lokale Telemetrie zeichnet Aktivitäten und Laufzeiten auf; die Telemetrieansicht der Map liest lokale Logs. Prüfe Logs und Fehlerberichte vor dem Teilen auf persönliche Angaben, Tokens und private Pfade.

Eine lokale Datei kann Text enthalten, den du getippt hast, und Auszüge deiner Notizen: `training-capture.jsonl` im Protokollverzeichnis. Sie wird nur geschrieben, wenn `BASTRA_TRAINING_CAPTURE` eingeschaltet ist (`1`, `true`, `on` oder `yes`), und das ist standardmäßig aus; sie ist ein befristetes Werkzeug für die Prüfung in #1128 und wird nirgendwohin gesendet. Siehe [Trainingssignal mitschreiben](./training-capture.md#deutsch).

### Lokale Entwürfe

Solange der nachträgliche Sitzungs-Harvest eingeschaltet ist und seine Hooks
Sitzungen vormerken, erfasst er getippte Nutzernachrichten hinter dem Rauschfilter
mit mindestens 20 Buchstaben und weniger als 2.000 Zeichen. Eingespielte Turns,
Abbrüche und große eingefügte Texte fallen weg. Beim Harvest überspringt ein
separater wortbasierter Abgleich Zitate, deren Formulierung der Vault bereits
abdeckt. Ein späterer Speicheraufruf im Transcript unterdrückt die Erfassung
nicht allein; die dabei tatsächlich gespeicherte Notiz kann aber den separaten
Vault-Abgleich erfüllen. Entwürfe bleiben unbestätigte Zitate, getrennt von
Vault-Notizen.

Soweit im Client-Transcript vorhanden, hält ein Entwurf auch bis zu drei vorherige
und drei folgende Shell-Befehle des Assistenten, bis zu drei zuvor gelesene
Dateipfade, Arbeitsverzeichnis, Projekt und Branch. Für diese Felder gilt dieselbe
Schwärz-Heuristik wie für das Zitat. Hinzu kommen Sitzungs-/Turn-/Zeitbelege und
spätere Anzeige-/Nutzungsbelege. Das optionale Feld `context` enthält einen
Ausschnitt der Assistenten-Frage, auf die die Nachricht antwortet (deren letzte
Zeile, höchstens 160 Zeichen).

Die lokalen Standarddateien sind:

- `~/.bastra/drafts.json`: Zitate, Kontext, Situation und Belege; Rechte 0600.
- `~/.bastra/drafts.vectors.json`: modellgebundene lokale Vektoren und Hash-Metadaten; Rechte 0600.
- `~/.bastra/drafts.json.decisions.json`: Entscheidungsmerker nur als Hashes, keine Zitate; Rechte 0600.
- `~/.bastra/pending-suggestions.json`: der gemeinsame Vorschlags-Relay mit geschwärztem Text; normale Schreibvorgänge des vorbereiteten 1.1-Releases verwenden 0600. Alte Zeilen werden vor der Auslieferung und beim nächsten normalen Schreiben geschwärzt.
- `~/.bastra/harvest-queue.json`: Sitzungs-/Transcript-Pfade und Harvest-Fortschritt, keine Zitate. Diese Datei liegt getrennt von der Entwurfsablage und wird durch draft purge nicht gelöscht.

`BASTRA_DRAFTS_PATH` verlegt die Entwurfsablage samt Vektor-/Entscheidungsdateien;
`BASTRA_PENDING_SUGGESTIONS_PATH` und `BASTRA_HARVEST_QUEUE_PATH` können Relay und
Queue verlegen. Normale Harvest-Relay-Einträge werden beim nächsten Sitzungsstart
konsumiert; Einträge über sieben Tage werden bei dieser Lesung verworfen.
Derselbe Relay hält auch Trends, die nach gezählten Sitzungen stillgelegt werden
und länger bleiben können. Ohne weitere Lesung können alte Relay-Zeilen auf der
Platte bleiben.

Erkennbare Zugangsdaten werden vor dem Speichern geschwärzt; nützliche Pfade und
Variablenreferenzen bleiben erhalten. Der Filter ist eine Heuristik mit
[bekannten Grenzen](./secret-redaction.md#deutsch-fester-maßstab-und-grenzen):
Passwörter nur aus Wörtern in gewöhnlicher Prosa und nicht unterstützte Formen
können lesbar bleiben. Er repariert weder das ursprüngliche Client-Transcript
noch alte Vault-Notizen oder Backups. Zitate werden auf 600 Zeichen und Kontext
auf 160 gekürzt; die Ablage hält höchstens 500 Zeilen und 1 MiB, sodass diese
Grenzen Zeilen früher verdrängen können.

Offene Entwürfe mit einem Beleg ohne gültigen Nutzungsnachweis verfallen nach
7 Tagen, andere offene nach 30 Tagen, geschlossene/abgelehnte/Beförderungs-
Datensätze nach 180 Tagen, gerechnet ab der letzten Berührung. Aktive Harvest-
Ticks und normale Ablage-Schreibvorgänge entfernen verfallene Zeilen. Ist diese
Arbeit abgeschaltet, können alte Daten auf der Platte bleiben. Die Entwurfs-
Telemetrie enthält IDs, Zähler und Messwerte, nicht das erfasste Zitat.

Erfassung, Entwurfs-Embeddings und Bedeutungsprüfungen laufen lokal, ohne diese
lokalen Dateien hochzuladen. Die Bedeutungsprüfung kann auch im standardmäßigen
Probelauf ein lokales Modell aufrufen. Ohne exakt `BASTRA_DRAFT_PROMOTE=1` schreibt
die automatische Übernahme keine Vault-Notiz. Text kann den verbundenen Assistenten
über das unbestätigte Band bei Prompts, Sitzungsstarts und vor Werkzeugaufrufen,
über `draft_hits` im Ergebnis des MCP-Werkzeugs `recall` und über den Pending-Relay
beim nächsten Sitzungsstart erreichen. Ein cloudbasierter Assistent kann diese
Texte nach seinen eigenen Regeln beim Anbieter verarbeiten. Nach eingeschalteter
Übernahme ist die abgeleitete Notiz normaler Vault-Inhalt: Verbundene Clients
können sie abrufen, und der gewählte Vault-Embedding-Anbieter kann sie verarbeiten,
auch ein nicht-lokaler Anbieter. Dieser Anbieterweg läuft getrennt vom Assistenten;
die Embeddings der Entwürfe selbst bleiben lokal.

#### Abschalten und Entwürfe entfernen

Die Schalter in der **Umgebung des Daemons** setzen und ihn neustarten;
eine Änderung nur in einer CLI-Shell verändert den laufenden Daemon nicht.
Aus-Werte sind `0`, `false`, `off` und `no`, ohne Beachtung der Groß-/Kleinschreibung
und mit ignorierten umgebenden Leerzeichen.

- `BASTRA_SESSION_HARVEST=0` stoppt Vormerken/Erfassung, den Harvest-Tick, Shadow-Vergleiche, automatische Übernahme und neue Harvest-Relay-Schreibvorgänge. Bestehende Entwurfs-Hinweise funktionieren weiter, solange die Hinweise nicht ebenfalls abgeschaltet sind.
- `BASTRA_DRAFT_HINTS=0` stoppt das unbestätigte Hinweisband, `draft_hits` und die Nutzungserfassung. Erfassung sowie Relay-Schreiben/-Auslieferung bleiben davon unberührt.
- Keiner der Schalter stoppt die Auslieferung vorhandener Relay-Einträge bei SessionStart. Andere Relay-Schreiber, darunter die unabhängige Stop-Prüfung und der Curator, werden nicht durch diese beiden Schalter gesteuert.

Damit Entwurfs-Erfassung und Hinweise aus bleiben, **beide** Schalter setzen.
`bastra drafts list` zeigt die Ablage. `bastra drafts purge` entfernt nur
Entwurfsablage, Vektoren und Entscheidungsmerker; es leert **nicht** den Relay,
die Harvest-Queue, optionale Trainingsdaten oder bereits beförderte Vault-Notizen.
Um verbliebenen Relay-Text zu entfernen, den Daemon stoppen und die tatsächlich
verwendete `pending-suggestions.json` im Dateimanager löschen (Standardpfad siehe
oben). Die Harvest-Queue ebenso löschen, wenn ihre Sitzungs-/Pfadmetadaten nicht
bleiben sollen; nach erneutem Einschalten kann der Harvest sonst vorgemerkte
Sitzungen fortsetzen. Mit beiden abgeschalteten Schaltern neustarten. Unabhängige
Stop-/Curator-Schreiber müssen ebenfalls deaktiviert sein, wenn keine neuen
gemeinsamen Relay-Einträge entstehen sollen. Bei einer bestehenden Claude-Code-
Installation erhält `bastra install claude-code --no-stop-hook` einen zuvor
aktivierten Stop-Hook und seinen SessionEnd-Begleiter; es entfernt sie nicht.
Diese Einträge bei Bedarf ausdrücklich in der Hook-Konfiguration des Clients
deaktivieren/entfernen. Die [optionale Trainingsablage](./training-capture.md#deutsch)
hat ihren eigenen aufbewahrten Datenbestand.

Der Vorschlags-Relay hält Auszüge früherer Sitzungen außerhalb des Vaults in
`~/.bastra/pending-suggestions.json`, mit Rechten 0600. Vor dem Schreiben und der
Übergabe an deinen Assistenten entfernt er erkennbare Zugangsdaten mit derselben
Heuristik wie lokale Entwürfe. Alte Zeilen werden beim nächsten normalen
Schreiben und vor der Auslieferung geschwärzt, ohne Migration. Eine vorhandene,
aber unlesbare oder beschädigte Relay-Datei bleibt unverändert: Der neue
Schreibvorgang entfällt mit einer Warnung ohne Auszüge oder Pfade. Eine fehlende
Datei wird normal angelegt. Recency-Einträge
werden beim nächsten Session-Start konsumiert; dabei werden Einträge über sieben
Tage verworfen. Trends werden nach dem eingestellten Sitzungszähler stillgelegt;
ihre Tombstones bleiben für ebenso viele weitere gezählte Starts, solange sie
nicht aufgefrischt werden. Ohne weitere Lesungen können Zeilen auf der Platte
bleiben. Die Heuristik hat
[bekannte Grenzen](./secret-redaction.md).

### Deine Kontrolle

Prüfe und bearbeite Markdown-Dateien direkt oder nutze die Memory-Tools über deinen Assistenten. `bastra embeddings off` aktiviert reine Stichwortsuche; `bastra embeddings on` richtet lokale Embeddings ein. `bastra uninstall all` entfernt Client-Registrierungen und behält deinen Vault. Das Paket wird separat deinstalliert.

Das Feld `sensitivity` filtert den Zugriff über bestimmte Bastra-Schnittstellen. Es verschlüsselt keine Dateien und ersetzt keine Betriebssystemrechte. Siehe [Memory-Schema](./memory-schema.md#privacy-field). Vermutete Sicherheitslücken melde über [SECURITY.md](../SECURITY.md).

Diese Seite enthält die für 1.1.0 vorbereiteten Änderungen. Versionsspezifische Änderungen stehen im [Changelog](../CHANGELOG.md).
