# Codex save notices

After a successful `save_memory`, `edit_memory`, `save_document` or
`save_product_doc`, Recall supplies one short `systemMessage` through Codex's
PostToolUse hook. Reads and refused writes stay silent. The existing formatter,
write acknowledgement parser and local route are shared with Claude Code.

Codex defaults to a plain fixed prefix:

```text
bastra-recall saved: “Synthetic fixture” (lesson)
bastra-recall edited: “Synthetic fixture” (lesson) · text appended
```

Run `bastra install codex` again after updating Recall. In a new Codex session,
open `/hooks` and review/trust the write-tool registration. The installer reuses
the post-tool client; it does not add a panel entry. `bastra doctor` checks the
write matcher separately from the shared runner file. `BASTRA_SAVE_NOTICE=0` in
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

Codex bekommt nach bestätigtem Speichern oder Ändern dieselbe kurze Zeile,
standardmäßig farblos mit festem `bastra-recall`-Präfix. Nach dem Update
`bastra install codex` erneut ausführen und den neuen Hook in `/hooks` prüfen.
Suchen, Laden und verweigerte Schreibaufrufe bleiben ohne Zeile.

Der isolierte Lauf mit Codex CLI 0.160.0 hat die Aufrufe, normalisierten
Toolnamen und Ergebnisform bestätigt. Die interaktive Sicht- und Farbprüfung
wurde ausgelassen; die exec-Ausgabe zeigte nur den Hook-Abschluss. Farbe kann
mit `BASTRA_SAVE_NOTICE_COLOR=1` in der Daemon-Umgebung selbst geprüft werden:
Daemon neu starten, eine harmlose Notiz speichern oder ändern, bei sichtbaren
Escape-Zeichen wieder auf `0` stellen und den Daemon erneut starten.
