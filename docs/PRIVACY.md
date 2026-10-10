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

One local file can hold text you typed and excerpts of your notes: `training-capture.jsonl` in the log directory. It exists only if you set `BASTRA_TRAINING_CAPTURE=1`, which is off by default; it is a temporary tool for the evaluation in #1128 and is never sent anywhere. See [training signal capture](./training-capture.md).

The suggestion relay keeps earlier session excerpts in
`~/.bastra/pending-suggestions.json`, outside the vault, with permissions 0600.
It removes recognizable credentials with the same heuristic as local drafts
before writing or delivering the text to your assistant. Existing rows are
cleaned on their next ordinary write and before delivery, without a migration.
Recency entries are consumed at the next session start; entries older than
seven days are dropped on that read. Trends retire by their configured session
counter; their tombstones remain for that many further counted starts unless
refreshed. Without further reads, rows can remain on disk. The heuristic has [known limits](./secret-redaction.md).

### Your control

Inspect and edit the Markdown files directly, or use the memory tools through your assistant. Use `bastra embeddings off` for keyword-only search and `bastra embeddings on` to set up local embeddings. Removing client registrations with `bastra uninstall all` keeps your vault; uninstalling the package is a separate step.

The `sensitivity` field filters access through specific Bastra interfaces. It is not file encryption or a substitute for operating-system permissions. See the [memory schema](./memory-schema.md#privacy-field). Report suspected vulnerabilities through [SECURITY.md](../SECURITY.md).

This page describes the 1.0 release line. Check the [changelog](../CHANGELOG.md) for version-specific changes.

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

Eine lokale Datei kann Text enthalten, den du getippt hast, und Auszüge deiner Notizen: `training-capture.jsonl` im Protokollverzeichnis. Es gibt sie nur, wenn du `BASTRA_TRAINING_CAPTURE=1` setzt, und das ist standardmäßig aus; sie ist ein befristetes Werkzeug für die Prüfung in #1128 und wird nirgendwohin gesendet. Siehe [Trainingssignal mitschreiben](./training-capture.md#deutsch).

Der Vorschlags-Relay hält Auszüge früherer Sitzungen außerhalb des Vaults in
`~/.bastra/pending-suggestions.json`, mit Rechten 0600. Vor dem Schreiben und der
Übergabe an deinen Assistenten entfernt er erkennbare Zugangsdaten mit derselben
Heuristik wie lokale Entwürfe. Alte Zeilen werden beim nächsten normalen
Schreiben und vor der Auslieferung geschwärzt, ohne Migration. Recency-Einträge
werden beim nächsten Session-Start konsumiert; dabei werden Einträge über sieben
Tage verworfen. Trends werden nach dem eingestellten Sitzungszähler stillgelegt;
ihre Tombstones bleiben für ebenso viele weitere gezählte Starts, solange sie
nicht aufgefrischt werden. Ohne weitere Lesungen können Zeilen auf der Platte
bleiben. Die Heuristik hat
[bekannte Grenzen](./secret-redaction.md).

### Deine Kontrolle

Prüfe und bearbeite Markdown-Dateien direkt oder nutze die Memory-Tools über deinen Assistenten. `bastra embeddings off` aktiviert reine Stichwortsuche; `bastra embeddings on` richtet lokale Embeddings ein. `bastra uninstall all` entfernt Client-Registrierungen und behält deinen Vault. Das Paket wird separat deinstalliert.

Das Feld `sensitivity` filtert den Zugriff über bestimmte Bastra-Schnittstellen. Es verschlüsselt keine Dateien und ersetzt keine Betriebssystemrechte. Siehe [Memory-Schema](./memory-schema.md#privacy-field). Vermutete Sicherheitslücken melde über [SECURITY.md](../SECURITY.md).

Diese Seite beschreibt die Release-Linie 1.0. Versionsspezifische Änderungen stehen im [Changelog](../CHANGELOG.md).
