# Local task state adapters

Prepared main for v1.2.0 adds local snapshot sources to the existing task journal. These sources notify or prepare work; they cannot supply final execution authority. They do not launch agents, wake clients, connect to providers or access remote services.

| Source kind | Registration fields | Observed state |
|---|---|---|
| `project` | `root` | Local Git HEAD and porcelain status, including branch and untracked paths |
| `worktree` | `root` | Local Git worktree registry, including detached, locked and prunable state |
| `task-phase` | `task_id` | One task's lifecycle state, such as `pending`, `due`, `paused` or `resolved` |
| `symbol` | `root`, `path`, `symbol_id` | Exact code node metadata in a local Graphify graph; `null` means absent from that graph |
| `entity` | `memory_id`, `field` | One exact, own frontmatter field of a uniquely bound memory |
| `document` | `memory_id` | Complete frontmatter metadata of a uniquely bound `type: doc` memory |

`project` and `worktree` run local Git reads. For `project`, an unborn HEAD is unavailable. Symbol observations require a refreshed graph to reflect code changes; they do not parse live code. Entity observations do not infer facts from prose. Document observations do not watch original PDF/image bytes, OCR or body-only edits. Missing, ambiguous, inaccessible, oversized or invalid inputs produce a source failure rather than a fabricated state. Symbol files must be regular, contained, single-link UTF-8 files. Task and memory sources enforce ownership/sensitivity restrictions.

An Owner registers a source with `task_source_register` (REST: `POST /tasks/sources`). Common fields are a unique `id`, `producer_actor: "task-source-reader"`, `owner_domains`, `sensitivity`, `max_age_ms` and `enabled`. For example:

```json
{
  "id": "document-status", "kind": "entity", "memory_id": "my-document",
  "field": "status", "producer_actor": "task-source-reader",
  "owner_domains": ["personal"], "sensitivity": "private",
  "max_age_ms": 86400000, "enabled": true
}
```

Bind a task's event schedule to that `source_id`, with an exact reviewed `expected` value. `equals` matches the value; `content-version` detects a different value. Structured values use canonical JSON with sorted object keys: an entity string `ready` has the expected value `"ready"` including JSON quotation marks (in a JSON request: `"expected": "\"ready\""`). Task phases are plain strings, such as `resolved`. Project values contain `head` and `status`; worktree values are the JSON-encoded Git porcelain output. Choose and verify the complete baseline locally. An unavailable source is never interpreted as a matching phase or as a deleted symbol.

`task_status` exposes each source's coverage. Disable observation with `task_controls {"source":{"id":"document-status","enabled":false}}`; set `enabled:true` to resume. The daemon's existing poll and per-task byte/time budgets apply. An Owner may run `task_reconcile {}` for an explicit observation/evaluation.

The journal, comparison identities and logical occurrences persist across restart. Unchanged values do not create new events, including when their display text is scrubbed. Clock rollback does not duplicate recorded occurrences; future-dated observations remain subject to the existing freshness checks. After offline time, a disabled source or an outage, observation records the latest available state. Intermediate changes that happened entirely between observations cannot be reconstructed, and returning to the same state can remain unseen. Re-enabling changes the source revision and rechecks its current state; it does not authorize execution or renew an approval. No universal wall-clock delivery guarantee is made.

Structured entity/document metadata is checked before JSON serialization: at most 4,096 visited nodes, nesting depth 64 and 4,096 cumulative string/key bytes. Canonical output remains limited to 4,096 bytes. Oversized or cyclic graphs report `source_budget` without recording a fabricated snapshot.

See [Proactive Tasks](Proactive%20Tasks.md) and [owner approval key limits](Owner%20Approval%20Key%20Isolation.md).

---

## Deutsch

Das vorbereitete main für v1.2.0 ergänzt lokale Zustandsquellen im bestehenden Aufgabenjournal. Diese Quellen melden oder bereiten Arbeit vor; sie liefern keine abschließende Ausführungsautorität. Sie starten keine Agenten, wecken keine Clients und verbinden sich nicht mit Anbietern oder entfernten Diensten.

| Quellenart | Registrierungsfelder | Beobachteter Zustand |
|---|---|---|
| `project` | `root` | Lokaler Git-HEAD und Porcelain-Status einschließlich Branch und unversionierter Pfade |
| `worktree` | `root` | Lokales Git-Worktree-Verzeichnis einschließlich detached, locked und prunable |
| `task-phase` | `task_id` | Lebenszyklus einer Aufgabe, etwa `pending`, `due`, `paused` oder `resolved` |
| `symbol` | `root`, `path`, `symbol_id` | Exakte Code-Knotenmetadaten in einem lokalen Graphify-Graphen; `null` bedeutet dort nicht vorhanden |
| `entity` | `memory_id`, `field` | Ein exaktes eigenes Frontmatter-Feld einer eindeutig gebundenen Memory |
| `document` | `memory_id` | Vollständige Frontmatter-Metadaten einer eindeutig gebundenen Memory mit `type: doc` |

`project` und `worktree` lesen lokales Git. Bei `project` gilt ein noch nicht existierender HEAD als nicht verfügbar. Symbolbeobachtungen brauchen einen aktualisierten Graphen, um Codeänderungen zu sehen; sie parsen keinen Live-Code. Entity-Beobachtungen leiten keine Fakten aus Prosa ab. Dokumentbeobachtungen verfolgen weder ursprüngliche PDF-/Bildbytes noch OCR oder reine Textkörperänderungen. Fehlende, mehrdeutige, unzugängliche, zu große oder ungültige Eingaben erzeugen einen Quellfehler statt eines erfundenen Zustands. Symboldateien müssen reguläre, enthaltene UTF-8-Dateien mit einem Hardlink sein. Aufgaben- und Memory-Quellen prüfen Eigentumsdomänen und Vertraulichkeit.

Ein Owner registriert eine Quelle mit `task_source_register` (REST: `POST /tasks/sources`). Gemeinsame Felder sind eine eindeutige `id`, `producer_actor: "task-source-reader"`, `owner_domains`, `sensitivity`, `max_age_ms` und `enabled`. Das obige JSON-Beispiel registriert das Feld `status` der Memory `my-document` für die Domäne `personal` als private Quelle.

Der Ereignisplan einer Aufgabe bindet diese `source_id` und einen exakt geprüften Wert `expected`. `equals` trifft bei Gleichheit, `content-version` bei einem anderen Wert. Strukturierte Werte verwenden kanonisches JSON mit sortierten Objektschlüsseln: Für den Entity-String `ready` lautet der Vergleichswert `"ready"` einschließlich JSON-Anführungszeichen (im JSON-Aufruf: `"expected": "\"ready\""`). Aufgabenphasen sind einfache Strings wie `resolved`. Projektwerte enthalten `head` und `status`; Worktree-Werte sind die JSON-kodierte Git-Porcelain-Ausgabe. Die vollständige Baseline lokal wählen und prüfen. Eine nicht verfügbare Quelle gilt weder als passende Phase noch als gelöschtes Symbol.

`task_status` zeigt die Abdeckung je Quelle. Mit `task_controls {"source":{"id":"document-status","enabled":false}}` ausschalten; mit `enabled:true` fortsetzen. Bestehender Daemon-Poll und Byte-/Zeitbudgets je Aufgabe gelten weiter. Ein Owner kann mit `task_reconcile {}` ausdrücklich beobachten und auswerten.

Journal, Vergleichsidentitäten und logische Fälligkeiten bleiben über Neustarts erhalten. Unveränderte Werte erzeugen keine neuen Ereignisse, auch bei bereinigtem Anzeigetext. Ein Uhrenrücksprung dupliziert keine erfassten Fälligkeiten; Beobachtungen aus der Zukunft unterliegen weiter den bestehenden Frischeprüfungen. Nach Offline-Zeit, abgeschalteter Quelle oder Ausfall wird der zuletzt verfügbare Zustand beobachtet. Vollständig zwischen Beobachtungen liegende Änderungen lassen sich nicht rekonstruieren; auch eine Rückkehr zum Ausgangszustand kann unbemerkt bleiben. Erneutes Einschalten ändert die Quellrevision und prüft den aktuellen Zustand neu; es erlaubt keine Ausführung und erneuert keine Freigabe. Eine allgemeine Zustellgarantie nach Wanduhr wird nicht behauptet.

Strukturierte Entity-/Dokumentmetadaten werden vor der JSON-Serialisierung auf höchstens 4.096 besuchte Knoten, Tiefe 64 und insgesamt 4.096 String-/Schlüsselbytes begrenzt. Die kanonische Ausgabe bleibt auf 4.096 Bytes begrenzt. Zu große oder zyklische Graphen melden `source_budget`, ohne einen erfundenen Snapshot zu erfassen.

Siehe [Proaktive Aufgaben](Proaktive%20Aufgaben.md) und [Grenzen der Freigabeschlüssel](Owner%20Approval%20Key%20Isolation.md#deutsch).
