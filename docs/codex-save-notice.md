# Codex save notices

After a successful `save_memory`, `edit_memory`, `save_document` or
`save_product_doc`, Recall supplies one short `systemMessage` through Codex's
PostToolUse hook. Reads and refused writes stay silent. The existing formatter,
write acknowledgement parser and local route are shared with Claude Code.

Codex defaults to a plain fixed prefix. Example formatting:

```text
bastra-recall saved: “Synthetic fixture” (lesson)
bastra-recall edited: “Synthetic fixture” (lesson)
```

Run `bastra install codex` again after updating Recall. In a new Codex session,
open `/hooks` and review/trust the write-tool registration. The installer reuses
the post-tool client; it does not add a panel entry. `bastra doctor` checks the
write matcher separately from the shared runner file. If only the save-notice
entry is missing, doctor keeps the installation healthy and recall hooks on,
with a specific `bastra install codex` hint. Missing required recall hooks
still need repair. `BASTRA_SAVE_NOTICE=0` in
the daemon environment disables notices.

## Compatibility check

The [official Hooks documentation](https://learn.chatgpt.com/docs/hooks) supports
`systemMessage` on PostToolUse and describes it as a UI/event-stream warning.
An isolated exec run with Codex CLI **0.160.0** confirmed four successful fixture
calls and their post-tool invocations. It used a stub server, ephemeral sessions
and no real vault writes. Captured MCP names were
`mcp__bastra_recall__save_memory` and `mcp__bastra_recall__edit_memory`; the matcher
also retains Claude's `bastra-recall` spelling and plugin-scoped names.

The observed result shape was an object with content blocks:

```json
{"tool_name":"mcp__bastra_recall__save_memory","tool_response":{"content":[{"type":"text","text":"{\"id\":\"notice-fixture\",\"created\":true}"}]}}
```

`readToolResult` already accepts this envelope. Hook payloads contain only
synthetic fixture data in the regression tests. The native exec renderer showed
hook completion, but did not print the notice body in its text/JSON output.
Interactive UI appearance and ANSI colour were **not visually verified**.
Accordingly, Codex uses the plain variant by default rather than assuming colour
support. This compatibility check does not claim identical rendering in every
Codex client.

## Optional colour check

1. Confirm the plain notice in your own interactive Codex session after a benign
   save or edit, with the hook reviewed in `/hooks`.
2. Start/restart the Recall daemon with `BASTRA_SAVE_NOTICE_COLOR=1`, then repeat
   that benign operation. The optional badge uses the existing Recall colours.
3. If escape characters appear or the badge is not useful, unset the variable or
   set it to `0` and restart the daemon. The fixed prefix remains readable.

Claude Code keeps its existing colour behaviour; the Codex opt-in does not
change it. Colour is optional and does not affect what is saved.

---

## Deutsch

Nach erfolgreichem `save_memory`, `edit_memory`, `save_document` oder
`save_product_doc` liefert Recall eine kurze `systemMessage` über Codex'
PostToolUse-Hook. Leseaufrufe und verweigerte Schreibvorgänge bleiben still.
Formatter, Parser der Schreibbestätigung und lokale Route werden mit Claude Code
geteilt.

Codex nutzt standardmäßig ein farbloses festes Präfix. Formatbeispiele:

```text
bastra-recall saved: “Synthetic fixture” (lesson)
bastra-recall edited: “Synthetic fixture” (lesson)
```

Nach dem Recall-Update `bastra install codex` erneut ausführen. In einer neuen
Codex-Sitzung den Schreib-Tool-Eintrag in `/hooks` prüfen und freigeben. Der
Installer verwendet den bestehenden Post-Tool-Client und fügt keinen Panel-Eintrag
hinzu. `bastra doctor` prüft den Schreib-Matcher getrennt von der gemeinsam
verwendeten Runner-Datei. Fehlt nur der Eintrag für die Speicherzeile, bleiben
Installation und Recall-Hooks gesund und aktiv, mit dem gezielten Hinweis
`bastra install codex`. Fehlende erforderliche Recall-Hooks brauchen weiterhin
Reparatur. `BASTRA_SAVE_NOTICE=0` in der Daemon-Umgebung schaltet die Meldungen ab.

### Kompatibilitätsprüfung

Die [offizielle Hooks-Dokumentation](https://learn.chatgpt.com/docs/hooks)
unterstützt `systemMessage` bei PostToolUse und beschreibt sie als Warnung in
Oberfläche/Ereignisstrom. Ein isolierter exec-Lauf mit Codex CLI **0.160.0**
bestätigte vier erfolgreiche Fixture-Aufrufe und ihre Post-Tool-Hooks. Er
verwendete einen Stub-Server, kurzlebige Sitzungen und keine echten Vault-
Schreibvorgänge. Erfasst wurden `mcp__bastra_recall__save_memory` und
`mcp__bastra_recall__edit_memory`; der Matcher behält außerdem Claudes Schreibweise
`bastra-recall` und Namen mit Plugin-Präfix bei.

Die beobachtete Ergebnisform war ein Objekt mit Inhaltsblöcken:

```json
{"tool_name":"mcp__bastra_recall__save_memory","tool_response":{"content":[{"type":"text","text":"{\"id\":\"notice-fixture\",\"created\":true}"}]}}
```

`readToolResult` akzeptiert diese Hülle bereits. Hook-Payloads enthalten in den
Regressionstests ausschließlich synthetische Fixture-Daten. Der native exec-
Renderer zeigte den Hook-Abschluss, druckte aber den Meldungstext nicht in die
Text-/JSON-Ausgabe. Interaktive Darstellung und ANSI-Farbe wurden **nicht visuell
geprüft**. Deshalb verwendet Codex standardmäßig die farblose Variante, ohne
Farbunterstützung vorauszusetzen. Diese Kompatibilitätsprüfung behauptet keine
identische Darstellung in allen Codex-Clients.

### Optionale Farbprüfung

1. In einer eigenen interaktiven Codex-Sitzung nach harmlosem Speichern oder
   Bearbeiten die farblose Meldung prüfen; der Hook muss in `/hooks` freigegeben sein.
2. Den Recall-Daemon mit `BASTRA_SAVE_NOTICE_COLOR=1` starten/neustarten und den
   harmlosen Vorgang wiederholen. Die optionale Plakette nutzt die Recall-Farben.
3. Erscheinen Escape-Zeichen oder hilft die Plakette nicht, die Variable entfernen
   oder auf `0` setzen und den Daemon neustarten. Das feste Präfix bleibt lesbar.

Claude Code behält sein bisheriges Farbverhalten; Codex' Opt-in verändert es
nicht. Farbe ist optional und hat keinen Einfluss darauf, was gespeichert wird.
