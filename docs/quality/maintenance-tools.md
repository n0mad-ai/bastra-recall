# Maintenance tools and environment settings

These scripts are retained as manual entry points for maintainers. Use a dedicated vault copy for measurements and for previews of vault changes.

| Script | Purpose |
| --- | --- |
| [test-expand-prompt.ts](../../packages/daemon/scripts/test-expand-prompt.ts) | Read-only comparison of stored query expansions against fresh expansions from the local model. |
| [verify-impact-wiring.mjs](../../packages/daemon/scripts/verify-impact-wiring.mjs) | Compare rendered frames from the classic graph renderer with and without an impact flash. |
| [prune-slug-expansions.ts](../../packages/daemon/scripts/prune-slug-expansions.ts) | Preview removing slug chains from saved query expansions. Writes only with `--apply`. |
| [strip-trigger-expand.ts](../../packages/daemon/scripts/strip-trigger-expand.ts) | Preview removing generated expansion fields. Writes only with `--apply`. |
| [reject-injected-drafts.ts](../../packages/daemon/scripts/reject-injected-drafts.ts) | Reject affected drafts at deployment in an explicitly selected draft store. This modifies that store. |
| [paraphrase-band.ts](../../packages/eval/src/paraphrase-band.ts) | Enumerate near-matching trigger pairs for human labelling in evaluation. |
| [path-lock-kill.mts](../../tools/probes/path-lock-kill.mts) | Measure lock recovery when a disposable worker is terminated on POSIX. |
| [path-lock-marker-deadline.mts](../../tools/probes/path-lock-marker-deadline.mts) | Check recovery deadlines for abandoned lock markers. |
| [path-lock-recovery-load.mts](../../tools/probes/path-lock-recovery-load.mts) | Check lock recovery when multiple test workers try to write at the same time. |

### Advanced environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `BASTRA_ACTED_ON_WINDOW_MS` | 600,000 | Window for matching later use to a surfaced or loaded note in telemetry. |
| `BASTRA_REANNOUNCE_MS` | 180,000 | Minimum time between repeated live notices for the same note. |
| `BASTRA_MCP_VECTOR_DEADLINE_MS` | 1,500 | Wait for the semantic search arm in the MCP forwarder, in milliseconds. |
| `BASTRA_STOP_HOOK_TIMEOUT_MS` | 1,000 | Stop-hook time budget in milliseconds. |
| `BASTRA_EMBED_MAX_CONCURRENT` | 2 | Maximum number of concurrent embedding batches. |
| `BASTRA_RELATED_TOP_N` | 5 | Number of candidates for automatic related-note links. |
| `BASTRA_RELATED_THRESHOLD` | 0.7 | Minimum similarity for automatic related-note links. |
| `BASTRA_AUTO_RELATED` | enabled | Controls automatic related-note linking. |
| `BASTRA_CLAIMED_TWICE_LIMIT` | 50 | Maximum number of double-claim rows per vault report. |
| `BASTRA_BANTER_LANG` | `en` | Language of MCP banter. Set `de` for German. |
| `BASTRA_CHAT_SESSIONS_PATH` | `chat-sessions` in the Bastra data directory | Overrides where local chat registrations are stored. |

Use the `BASTRA_` name for new configurations. The old aliases `NEXUS_DAEMON_URL`, `NEXUS_DOCUMENT_WRITE`, `NEXUS_HOOK_TIMEOUT_MS`, `NEXUS_HTTP`, `NEXUS_HTTP_PORT`, `NEXUS_HTTP_URL`, `NEXUS_LOG_PATH`, `NEXUS_TELEMETRY` and `NEXUS_VAULT_PATH` remain supported in 1.3.0. Their phase-out is planned from 1.4.0 onwards. Update shell profiles and service environments to the matching `BASTRA_` variable.

## Deutsch

Diese Skripte bleiben als manuell aufrufbare Wartungswerkzeuge erhalten. Verwende eine eigene Vault-Kopie für Messungen und für die Vorschau von Änderungen am Vault.

| Skript | Zweck |
| --- | --- |
| `test-expand-prompt.ts` | Gespeicherte Suchumschreibungen mit neuen Umschreibungen des lokalen Modells vergleichen. |
| `verify-impact-wiring.mjs` | Bilder des klassischen Graphen mit und ohne Aufblitzen vergleichen. |
| `prune-slug-expansions.ts` | Vorschau zum Entfernen künstlicher Bindestrichketten aus Suchumschreibungen. Schreibt nur mit `--apply`. |
| `strip-trigger-expand.ts` | Vorschau zum Entfernen erzeugter Umschreibungsfelder. Schreibt nur mit `--apply`. |
| `reject-injected-drafts.ts` | Betroffene Entwürfe beim Bereitstellen in einer ausdrücklich ausgewählten Ablage verwerfen. Verändert diese Ablage. |
| `paraphrase-band.ts` | Ähnliche Auslöser für die manuelle Bewertung in Suchtests paarweise auflisten. |
| `path-lock-kill.mts` | Wiederherstellung von Sperren nach Beenden eines Testprozesses unter POSIX messen. |
| `path-lock-marker-deadline.mts` | Zeitgrenzen beim Auflösen verwaister Sperren prüfen. |
| `path-lock-recovery-load.mts` | Wiederherstellung von Sperren bei gleichzeitigen Schreibversuchen mehrerer Testprozesse prüfen. |

### Erweiterte Umgebungsvariablen

Für die Standardwerte gilt die Tabelle oben. `BASTRA_ACTED_ON_WINDOW_MS` setzt das Messfenster zwischen einem Hinweis und seiner späteren Nutzung. `BASTRA_REANNOUNCE_MS` begrenzt, wie schnell derselbe Hinweis erneut erscheint. `BASTRA_MCP_VECTOR_DEADLINE_MS` und `BASTRA_STOP_HOOK_TIMEOUT_MS` legen die Wartezeit für semantische Treffer im MCP-Forwarder und für den Stop-Hook in Millisekunden fest. `BASTRA_EMBED_MAX_CONCURRENT` begrenzt gleichzeitig laufende Embedding-Pakete.

`BASTRA_RELATED_TOP_N`, `BASTRA_RELATED_THRESHOLD` und `BASTRA_AUTO_RELATED` steuern Anzahl, Mindestähnlichkeit und Aktivierung automatischer Querverweise. `BASTRA_CLAIMED_TWICE_LIMIT` begrenzt die Zahl der im Vault-Bericht angezeigten doppelten Ansprüche. `BASTRA_BANTER_LANG` stellt Hinweistexte mit `de` auf Deutsch. `BASTRA_CHAT_SESSIONS_PATH` setzt das Verzeichnis für lokale Chat-Registrierungen.

Verwende für neue Einstellungen die Namen mit `BASTRA_`. Die oben aufgeführten `NEXUS_`-Namen funktionieren in 1.3.0 weiterhin. Sie sollen ab 1.4.0 auslaufen. Stelle Shell-Profile und Dienstumgebungen auf die jeweils passende `BASTRA_`-Variable um.
