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
it captures each typed user message that passes the noise filter, has at least
20 letters and fewer than 2,000 characters. Injected turns, interruptions, large
pastes and quotes already held by the vault are excluded. A later save does not
suppress draft capture. Drafts are unconfirmed quotes, separate from vault notes.

The local store is `~/.bastra/drafts.json` (`BASTRA_DRAFTS_PATH` overrides it),
with its model-bound `.vectors.json` sidecar. Both use permissions 0600.
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
`bastra drafts list` inspects the store; `bastra drafts purge` clears it and its
sidecars. Draft telemetry contains IDs, counts and metrics, not the captured quote.

Capture, draft embeddings and meaning checks run locally, without uploading
these files. The meaning check can call a local model even in the default dry
run. Without exactly `BASTRA_DRAFT_PROMOTE=1`, automatic draft promotion writes
no vault note. Unconfirmed hints and relay excerpts are passed to the connected
assistant; a cloud-based assistant may process that content remotely under its
own policy, just like the other hook context described above.

`BASTRA_DRAFT_HINTS=0` disables the unconfirmed hint band and its use tracking;
it does not disable capture or the pending relay. `BASTRA_SESSION_HARVEST=0`
disables capture, harvest-tick cleanup, shadow comparisons and promotion.
Neither switch deletes existing files; purge them explicitly if wanted.

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
Sitzungen vormerken, erfasst er jede getippte Nutzernachricht hinter dem
Rauschfilter mit mindestens 20 Buchstaben und weniger als 2.000 Zeichen.
Eingespielte Turns, Abbrüche, große eingefügte Texte und Zitate, die der Vault
bereits hält, fallen weg. Ein späterer Speicheraufruf unterdrückt die Erfassung
nicht. Entwürfe sind unbestätigte Zitate, getrennt von Vault-Notizen.

Die lokale Ablage liegt in `~/.bastra/drafts.json` (`BASTRA_DRAFTS_PATH`
überschreibt den Ort), daneben die modellgebundene `.vectors.json`-Datei.
Beide verwenden Rechte 0600. Erkennbare Zugangsdaten werden vor dem Speichern
geschwärzt; nützliche Pfade und Variablenreferenzen bleiben erhalten. Der Filter
ist eine Heuristik mit [bekannten Grenzen](./secret-redaction.md#deutsch-fester-maßstab-und-grenzen):
Passwörter nur aus Wörtern in gewöhnlicher Prosa und nicht unterstützte Formen
können lesbar bleiben. Er repariert weder das ursprüngliche Client-Transcript
noch alte Vault-Notizen oder Backups. Zitate werden auf 600 Zeichen und Kontext
auf 160 gekürzt; die Ablage hält höchstens 500 Zeilen und 1 MiB, sodass diese
Grenzen Zeilen früher verdrängen können.

Offene Entwürfe mit einem Beleg ohne gültigen Nutzungsnachweis verfallen nach
7 Tagen, andere offene nach 30 Tagen, geschlossene/abgelehnte/Beförderungs-
Datensätze nach 180 Tagen, gerechnet ab der letzten Berührung. Aktive Harvest-
Ticks und normale Ablage-Schreibvorgänge entfernen verfallene Zeilen. Ist diese
Arbeit abgeschaltet, können alte Daten auf der Platte bleiben. `bastra drafts list`
zeigt die Ablage; `bastra drafts purge` leert sie und ihre Begleitdateien.
Die Entwurfs-Telemetrie enthält IDs, Zähler und Messwerte, nicht das erfasste Zitat.

Erfassung, Entwurfs-Embeddings und Bedeutungsprüfungen laufen lokal, ohne diese
Dateien hochzuladen. Die Bedeutungsprüfung kann auch im standardmäßigen Probelauf
ein lokales Modell aufrufen. Ohne exakt `BASTRA_DRAFT_PROMOTE=1` schreibt die
automatische Übernahme keine Vault-Notiz. Unbestätigte Hinweise und Relay-Auszüge
werden dem verbundenen Assistenten übergeben; ein cloudbasierter Assistent kann
diese Inhalte nach seinen eigenen Regeln beim Anbieter verarbeiten, ebenso wie
den oben beschriebenen übrigen Hook-Kontext.

`BASTRA_DRAFT_HINTS=0` schaltet das unbestätigte Hinweisband und dessen
Nutzungserfassung ab, nicht die Erfassung oder den Pending-Relay.
`BASTRA_SESSION_HARVEST=0` schaltet Erfassung, Aufräumen im Harvest-Tick,
Shadow-Vergleiche und Übernahme ab. Beide Schalter löschen keine vorhandenen
Dateien; diese bei Bedarf ausdrücklich mit purge leeren.

### Deine Kontrolle

Prüfe und bearbeite Markdown-Dateien direkt oder nutze die Memory-Tools über deinen Assistenten. `bastra embeddings off` aktiviert reine Stichwortsuche; `bastra embeddings on` richtet lokale Embeddings ein. `bastra uninstall all` entfernt Client-Registrierungen und behält deinen Vault. Das Paket wird separat deinstalliert.

Das Feld `sensitivity` filtert den Zugriff über bestimmte Bastra-Schnittstellen. Es verschlüsselt keine Dateien und ersetzt keine Betriebssystemrechte. Siehe [Memory-Schema](./memory-schema.md#privacy-field). Vermutete Sicherheitslücken melde über [SECURITY.md](../SECURITY.md).

Diese Seite enthält die für 1.1.0 vorbereiteten Änderungen. Versionsspezifische Änderungen stehen im [Changelog](../CHANGELOG.md).
