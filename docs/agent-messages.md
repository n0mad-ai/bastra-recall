# Agent messages over cmux

When Claude and Codex send each other handovers, use the marked sender from a repository checkout:

```sh
node tools/cmux-agent-send.mjs --from codex --workspace workspace:2 --surface surface:4 < handover.txt
```

Use the receiver's explicit workspace and surface refs (or UUIDs). `--from claude` works in the other direction. The sender places the entire message inside `<agent-message …>` before sending it, then presses Return on the same target. It never calls a shell. The transport uses raw `surface.send_text`/`surface.send_key` JSON RPC and the documented `enter` key. The entire envelope is one physical line with a JSON-quoted body: multiline content and literal backslashes survive without terminal Enter/Tab escape expansion. The installed 0.64.25 CLI lacks the newer paste command; its `send` interprets escape sequences. See the [official socket API](https://cmux.com/docs/api). A failed send does not press Return; a failed Return leaves marked text possibly pending, so inspect the receiver before retrying. stdin must use LF newlines, contain no tabs, terminal control/C1 characters, Unicode line separators or bidi controls and fit within 64 KiB.

For inspection without sending:

```sh
node tools/cmux-agent-send.mjs --from codex --print < handover.txt
```

Keep the marker in the transcript and hook/remote payload until owner-role
normalization has excluded the turn. A renderer may hide it afterwards, but
removing it before capture destroys provenance and produces unsupported
plaintext. Both Claude and Codex loop instructions must route every review,
report and handover through this helper. This checkout supplies the sender and
tests; adoption in the installed loop remains a separate step before the actual
loop can be considered protected. No live message is needed to run the fixtures.

A marker first in the turn excludes the whole turn from prompt recall, owner transcript heuristics, local draft capture and the after-session relay in both Claude and Codex. Native `<teammate-message>`, `<agent-message>` and `<cross-session-message>` paths remain excluded. A line-start marker after genuine human text excludes the remainder; case and leading U+200B/U+200D/U+2060 are supported. The marker is an exclusion convention, not cryptographic proof of identity. Human text quoting a tag inline or in backticks stays human text.

Raw `cmux send`, manual paste and external senders without a marker are **unknown provenance**. They remain compatible with ordinary owner prompts; Bastra cannot distinguish identical plaintext from a human and an agent. This helper must be used by both sides of the loop; it does not intercept arbitrary cmux sends or rewrite installed client configuration. Existing drafts and vault notes are not repaired automatically: review and remove affected data explicitly as the owner.

# Agenten-Nachrichten über cmux

Für Übergaben zwischen Claude und Codex den markierten Sender aus dem Repo verwenden:

```sh
node tools/cmux-agent-send.mjs --from claude --workspace workspace:2 --surface surface:4 < handover.txt
```

Workspace und Surface des Empfängers ausdrücklich angeben; UUIDs funktionieren ebenfalls. Der Sender verwendet die JSON-RPC-Methoden surface.send_text/surface.send_key und die Taste enter. Eine physische Zeile mit JSON-quotiertem Body erhält mehrzeiligen Text und Backslashes, ohne sie als Tasten auszuwerten. Der Sender umhüllt die ganze Nachricht mit `<agent-message …>` und drückt erst nach erfolgreichem Senden Return am selben Ziel. Scheitert Return, kann der markierte Text noch im Eingabefeld stehen: vor erneutem Senden prüfen. stdin braucht LF-Zeilenumbrüche, darf keine Tabs, Terminal-/C1-Steuerzeichen, Unicode-Zeilentrenner oder Bidi-Steuerzeichen enthalten und höchstens 64 KiB groß sein. Mit `--from codex --print` statt der Zieloptionen lässt sich die Hülle ohne Versand prüfen.

Markierte Nachrichten werden in beiden Clients aus Prompt-Recall, Nutzer-Heuristiken, lokaler Draft-Erfassung und nachträglicher Weiterleitung ausgeschlossen. Die vorhandenen nativen Agenten-Hüllen bleiben ausgeschlossen. Ein Marker am Zeilenanfang nach echtem Nutzertext schließt den Rest aus; Groß-/Kleinschreibung und U+200B/U+200D/U+2060 davor werden erkannt. Der Marker ist eine Ausschlusskonvention, kein kryptografischer Herkunftsnachweis. Inline- oder Backtick-Zitate eines Tags bleiben Nutzertext.

Der Marker muss bis zur Herkunftsprüfung im Transkript und Hook-/Remote-Payload
bleiben. Erst danach darf die Anzeige ihn ausblenden. Vorheriges Entfernen
zerstört die Herkunft und erzeugt ununterstützten Plaintext. Beide Loop-Seiten
müssen alle Reviews, Berichte und Übergaben über diesen Sender schicken. Die
Einbindung in den installierten Loop steht separat aus; erst danach gilt der
tatsächliche Loop als geschützt. Die Fixtures brauchen keinen echten Versand.

Unmarkiertes `cmux send`, manuelles Einfügen und externe Sender haben **unbekannte Herkunft**. Solcher Plaintext bleibt wie bisher mit Nutzertext kompatibel; aus identischen Texten lässt sich der Verfasser nicht zuverlässig bestimmen. Beide Seiten des Loops müssen den Sender verwenden. Er fängt keine beliebigen cmux-Aufrufe ab und verändert keine installierte Client-Konfiguration. Bestehende Drafts und Vault-Notizen werden nicht automatisch repariert; betroffene Daten muss der Eigentümer prüfen und gezielt entfernen.
