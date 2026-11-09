# Local task app API

## English

This contract is the local foundation for a future app or executor. It does not launch an agent, expose remote access, pair devices, send mobile push messages or implement provider actions. Tasks remain an opt-in preview. The generated [OpenAPI contract](openapi.yaml) is the machine-readable reference; all paths below are relative to `http://127.0.0.1:6723/api/v1`.

Use a mapped task credential in `Authorization: Bearer …`. The existing local Host/Origin protections and enrolled ownership domains apply. Tokens in URLs are unsupported. A browser uses a streaming `fetch` with the bearer header; native `EventSource` cannot attach that header. The board's HttpOnly/CSRF session is separate and cannot authenticate these endpoints.

| Operation | Endpoint | Meaning |
| --- | --- | --- |
| Live changes | `GET /tasks/stream` | SSE with an initial authoritative snapshot and later change notifications. |
| Read task details | `GET /tasks/{id}` | Current task and revision token. |
| Read acknowledgement | `POST /tasks/{id}/acknowledge` | Body: `expected_revision`, `occurrence_id`. Records explicit acknowledgement; does not complete a task. |
| Read execution result | `GET /tasks/{id}/result` | Attributed executor report, whether its generation is current, and local execution intent/receipt outcomes. |
| Report executor result | `POST /tasks/{id}/result` | Body: `expected_revision`, `run_id`, `status`, `summary`, optional `occurrence_id`. |

`task_result_get` and `task_result_report` provide the same result operations through MCP and tool-style HTTP. Reporting is a task revision compare-and-swap: fetch the current revision first; stale revisions return 409. The server supplies actor, timestamp and generation, checks an optional occurrence belongs to the current task generation, scrubs report text and appends an audit entry. Status is `succeeded`, `failed` or `unknown`. The bounded `executor_report` is the latest report, not an unbounded run history. It remains readable after task changes, with `executor_report_current: false` when its generation is old.

An executor report is an attributed claim by that executor. It neither creates a signed local action receipt nor executes, acknowledges or completes the task. The result response separates `executor_report` from `intents` and `receipts`. The existing exact signed local file execution path retains its approvals, freshness checks, leases, fencing and reconciliation. The reporting endpoint is not an authorization to send, delete, pay or perform another external action.

### Event stream, version 1

Each SSE frame has `id`, `event` and a JSON `data` value. Event types are `snapshot`, `changed`, `due`, `completed` and `expired`. Non-snapshot events contain `version: 1`, `cursor`, `task_id`, `task_revision`, `state` and, where applicable, `occurrence_id`. They contain no task prose. Fetch task details to display current content. A recurring occurrence can emit `completed` while the series remains active.

Every connection starts with `snapshot`, containing `version: 1`, `cursor`, `resync: true` and the authorized task IDs/revisions/states. Clients replace their local index with that snapshot. `Last-Event-ID` is advisory; it does not request historical replay. Live signals are coalesced under load and may omit intermediate transitions. Reconnect snapshots and heartbeat state checks reconcile current durable state; this is not a durable audit-event feed. Deletion, access-domain changes and recovery cause resynchronization where observed.

Committed changes in the daemon are signalled immediately. A 15-second heartbeat also rereads durable state for changes made by another process and rechecks credential revocation. Revocation closes the stream at the next event or heartbeat. There are at most 32 streams per task store; excess clients receive 503. A slow client with more than 256 KiB buffered output is disconnected and must reconnect/resync. Disconnect removes its listener and heartbeat. Streaming never records notification delivery or acknowledgement.

### Freshness boundary (#475)

The task verifier already distinguishes `verified`, `refuted`, `stale`, `unavailable` and `inconclusive`, binding evidence to source/version, observation time, actual state update time, maximum age and timeout. The stream cursor describes task-store state; it is not a producer heartbeat or proof that an underlying source is alive. Executor reports are also not fresh source verification. General non-task live-state routes, a cross-host producer-heartbeat contract and extra provider verifiers remain outside this task API. No second watcher is introduced.

## Deutsch

Dieser Vertrag ist die lokale Grundlage für eine spätere App oder einen Ausführer. Er startet keinen Agenten, baut keinen Fernzugang, koppelt keine Geräte, verschickt keine Handy-Push-Nachrichten und implementiert keine Anbieteraktionen. Aufgaben bleiben eine Opt-in-Vorschau. Der erzeugte [OpenAPI-Vertrag](openapi.yaml) ist die maschinenlesbare Referenz; alle folgenden Pfade beziehen sich auf `http://127.0.0.1:6723/api/v1`.

Ein zugeordnetes Aufgaben-Zugangstoken gehört in `Authorization: Bearer …`. Die bestehenden lokalen Host-/Origin-Prüfungen und eingeschriebenen Zuständigkeitsbereiche gelten weiter. Token in URLs werden nicht unterstützt. Ein Browser verwendet einen streamenden `fetch` mit Bearer-Header; natives `EventSource` kann diesen Header nicht setzen. Die HttpOnly-/CSRF-Sitzung des Bretts ist getrennt und kann diese Endpunkte nicht authentifizieren.

| Vorgang | Endpunkt | Bedeutung |
| --- | --- | --- |
| Laufende Änderungen | `GET /tasks/stream` | SSE mit anfänglichem maßgeblichem Schnappschuss und anschließenden Änderungssignalen. |
| Aufgabendetails lesen | `GET /tasks/{id}` | Aktuelle Aufgabe und Revisionswert. |
| Lesebestätigung | `POST /tasks/{id}/acknowledge` | Inhalt: `expected_revision`, `occurrence_id`. Speichert ausdrückliche Bestätigung; erledigt keine Aufgabe. |
| Ausführungsergebnis lesen | `GET /tasks/{id}/result` | Zugeordneter Ausführerbericht, Aktualität seiner Generation und lokale Ausführungsabsichten/-quittungen. |
| Ausführergebnis melden | `POST /tasks/{id}/result` | Inhalt: `expected_revision`, `run_id`, `status`, `summary`, optional `occurrence_id`. |

`task_result_get` und `task_result_report` bieten dieselben Ergebnisvorgänge über MCP und HTTP mit Werkzeugnamen. Melden verwendet die Aufgabenrevision als Vergleichsbedingung: zuerst den aktuellen Revisionswert laden; veraltete Werte ergeben 409. Der Server setzt Akteur, Zeitpunkt und Generation, prüft bei angegebener Vorkommnis-ID deren Zugehörigkeit zur aktuellen Aufgabengeneration, bereinigt den Berichtstext und ergänzt einen Audit-Eintrag. Status ist `succeeded`, `failed` oder `unknown`. Das begrenzte Feld `executor_report` enthält den neuesten Bericht, keine unbegrenzte Laufhistorie. Nach Aufgabenänderungen bleibt es lesbar; bei alter Generation steht `executor_report_current: false`.

Ein Ausführerbericht ist eine zugeordnete Behauptung dieses Ausführers. Er erzeugt keine signierte lokale Aktionsquittung und führt die Aufgabe weder aus, noch bestätigt oder erledigt er sie. Die Ergebnisantwort trennt `executor_report` von `intents` und `receipts`. Der vorhandene exakt signierte lokale Dateiausführungspfad behält Freigaben, Frischeprüfungen, Reservierungen, Fencing und Abgleich. Der Meldeendpunkt erteilt keine Erlaubnis zum Senden, Löschen, Zahlen oder zu anderen externen Aktionen.

### Ereignisstrom, Version 1

Jeder SSE-Rahmen enthält `id`, `event` und einen JSON-Wert in `data`. Ereignistypen sind `snapshot`, `changed`, `due`, `completed` und `expired`. Andere Ereignisse als `snapshot` enthalten `version: 1`, `cursor`, `task_id`, `task_revision`, `state` und gegebenenfalls `occurrence_id`. Sie enthalten keinen Aufgabentext. Für den aktuellen Inhalt Aufgabendetails abrufen. Ein wiederkehrender Termin kann `completed` melden, während die Serie aktiv bleibt.

Jede Verbindung beginnt mit `snapshot`: `version: 1`, `cursor`, `resync: true` sowie die erlaubten Aufgaben-IDs/-Revisionen/-Zustände. Clients ersetzen damit ihren lokalen Index. `Last-Event-ID` dient nur als Hinweis und fordert keine historische Wiederholung an. Bei Last werden Live-Signale zusammengefasst; Zwischenübergänge können fehlen. Schnappschüsse beim Neuverbinden und Zustandsprüfungen beim Heartbeat gleichen den aktuellen dauerhaften Zustand ab; dies ist kein dauerhaftes Audit-Ereignisjournal. Löschung, Änderungen der Zugriffsbereiche und Wiederherstellung lösen beim Erkennen eine erneute Synchronisation aus.

Änderungen innerhalb des Daemons werden nach dem Commit sofort signalisiert. Ein 15-Sekunden-Heartbeat liest außerdem den dauerhaften Zustand für Änderungen anderer Prozesse und prüft den Widerruf des Zugangs. Ein Widerruf schließt den Strom beim nächsten Ereignis oder Heartbeat. Je Aufgabenspeicher sind höchstens 32 Ströme erlaubt; weitere Clients erhalten 503. Ein langsamer Client mit mehr als 256 KiB gepuffertem Ausgang wird getrennt und muss sich neu verbinden/synchronisieren. Trennen entfernt Listener und Heartbeat. Streaming vermerkt weder Zustellversuch noch Lesebestätigung.

### Frischegrenze (#475)

Die Aufgabenverifikation unterscheidet bereits `verified`, `refuted`, `stale`, `unavailable` und `inconclusive` und bindet Evidenz an Quelle/Version, Beobachtungszeit, tatsächliche Zustandszeit, Höchstalter und Timeout. Der Stream-Cursor beschreibt den Zustand des Aufgabenspeichers; er ist kein Produzenten-Heartbeat und beweist keinen lebenden Quellprozess. Ausführerberichte sind ebenfalls keine frische Quellenverifikation. Allgemeine Live-State-Routen außerhalb der Aufgaben, ein hostübergreifender Produzenten-Heartbeat-Vertrag und weitere Anbieter-Verifier gehören nicht zu dieser Aufgaben-API. Es entsteht kein zweiter Watcher.
