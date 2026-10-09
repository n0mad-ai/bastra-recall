# Agent messages over cmux

When Claude and Codex send each other handovers, use the marked sender from a repository checkout:

```sh
node tools/cmux-agent-send.mjs --from codex --workspace workspace:2 --surface surface:4 < handover.txt
```

Use the receiver's explicit workspace and surface refs (or UUIDs). UUIDs are sent as given. Refs such as `workspace:2` are first resolved with one read-only `cmux --id-format uuids identify --workspace … --surface … --json` call; the sender takes the workspace and surface UUID from the `caller` object of the answer, requires a terminal surface and does not compare the answer with the ref it asked for. That resolution is covered by mocked tests only, so prefer UUIDs when the target matters. `--from claude` works in the other direction. The sender places the entire message inside `<agent-message …>` before sending it, then presses Return on the same target. It never calls a shell. The transport uses raw `surface.send_text`/`surface.send_key` JSON RPC and the documented `enter` key. The entire envelope is one physical line with a JSON-quoted body: multiline content and literal backslashes survive without terminal Enter/Tab escape expansion. That statement rests on one observed send through `surface.send_text` with cmux 0.64.25, not on an automated test; no test in this repository talks to cmux. The installed 0.64.25 CLI lacks the newer paste command; its `send` interprets escape sequences. See the [official socket API](https://cmux.com/docs/api). A failed send does not press Return; a failed Return leaves marked text possibly pending, so inspect the receiver before retrying. stdin must use LF newlines, contain no tabs, terminal control/C1 characters, Unicode line separators or bidi embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069) and fit within 64 KiB. The directional marks LRM, RLM and ALM (U+200E, U+200F, U+061C) are not filtered and pass through.

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

A marker first in the turn excludes the whole turn from prompt recall, owner transcript heuristics, local draft capture and the after-session relay in both Claude and Codex. Native `<teammate-message>`, `<agent-message>` and `<cross-session-message>` paths remain excluded. A line-start marker after genuine human text excludes the remainder; case and leading spaces, tabs and U+200B/U+200D/U+2060 are supported. The line start is the one in the text as written. The marker is an exclusion convention, not cryptographic proof of identity. Human text quoting a tag stays human text in four forms: after other text on the same line, inside a complete backtick quotation (a run of backticks up to the next run of the same length, also across lines), in a code block indented by four spaces or a tab after a blank line, and as a bare tag without attributes that is followed by a space and more words and never closed (`<agent-message> is the marker`). A tag with an attribute at a line start is always read as a marker, quoted or not; put it in backticks. An unclosed backtick before the marker can hide it, and a marker that follows typed text on the same line is not recognized.

Raw `cmux send`, manual paste and external senders without a marker are **unknown provenance**. They remain compatible with ordinary owner prompts; Bastra cannot distinguish identical plaintext from a human and an agent. This helper must be used by both sides of the loop; it does not intercept arbitrary cmux sends or rewrite installed client configuration. Existing drafts and vault notes are not repaired automatically: review and remove affected data explicitly as the owner.

# Agenten-Nachrichten über cmux

Für Übergaben zwischen Claude und Codex den markierten Sender aus dem Repo verwenden:

```sh
node tools/cmux-agent-send.mjs --from claude --workspace workspace:2 --surface surface:4 < handover.txt
```

Workspace und Surface des Empfängers ausdrücklich angeben; UUIDs funktionieren ebenfalls und werden unverändert gesendet. Refs wie `workspace:2` löst der Sender vorher mit einem lesenden Aufruf `cmux --id-format uuids identify --workspace … --surface … --json` auf: Er übernimmt Workspace- und Surface-UUID aus dem Objekt `caller` der Antwort, verlangt ein Terminal-Surface und gleicht die Antwort nicht mit dem angefragten Ref ab. Diese Auflösung ist nur mit Mocks getestet; wenn das Ziel sicher stimmen muss, UUIDs angeben. Der Sender verwendet die JSON-RPC-Methoden surface.send_text/surface.send_key und die Taste enter. Eine physische Zeile mit JSON-quotiertem Body erhält mehrzeiligen Text und Backslashes, ohne sie als Tasten auszuwerten. Diese Aussage beruht auf einem beobachteten Versand über `surface.send_text` mit cmux 0.64.25, nicht auf einem automatischen Test; kein Test in diesem Repo spricht mit cmux. Der Sender umhüllt die ganze Nachricht mit `<agent-message …>` und drückt erst nach erfolgreichem Senden Return am selben Ziel. Scheitert Return, kann der markierte Text noch im Eingabefeld stehen: vor erneutem Senden prüfen. stdin braucht LF-Zeilenumbrüche, darf keine Tabs, Terminal-/C1-Steuerzeichen, Unicode-Zeilentrenner oder Bidi-Steuerzeichen für Einbettung, Überschreibung und Isolierung (U+202A–U+202E, U+2066–U+2069) enthalten und höchstens 64 KiB groß sein. Die Richtungsmarken LRM, RLM und ALM (U+200E, U+200F, U+061C) werden nicht gefiltert und gehen durch. Mit `--from codex --print` statt der Zieloptionen lässt sich die Hülle ohne Versand prüfen.

Markierte Nachrichten werden in beiden Clients aus Prompt-Recall, Nutzer-Heuristiken, lokaler Draft-Erfassung und nachträglicher Weiterleitung ausgeschlossen. Die vorhandenen nativen Agenten-Hüllen bleiben ausgeschlossen. Ein Marker am Zeilenanfang nach echtem Nutzertext schließt den Rest aus; Groß-/Kleinschreibung sowie Leerzeichen, Tabs und U+200B/U+200D/U+2060 davor werden erkannt. Maßgeblich ist der Zeilenanfang im Text, wie er geschrieben wurde. Der Marker ist eine Ausschlusskonvention, kein kryptografischer Herkunftsnachweis. Ein zitiertes Tag bleibt in vier Formen Nutzertext: nach anderem Text in derselben Zeile, in einem vollständigen Backtick-Zitat (eine Backtick-Folge bis zur nächsten gleich langen, auch über Zeilen hinweg), in einem Codeblock, der nach einer Leerzeile mit vier Leerzeichen oder einem Tab eingerückt ist, und als nacktes Tag ohne Attribute, dem ein Leerzeichen und weitere Wörter folgen und das nie geschlossen wird (`<agent-message> ist der Marker`). Ein Tag mit Attribut am Zeilenanfang gilt immer als Marker, auch wenn es als Zitat gemeint ist; dann in Backticks setzen. Ein nicht geschlossener Backtick vor dem Marker kann ihn verdecken, und ein Marker, der in derselben Zeile auf getippten Text folgt, wird nicht erkannt.

Der Marker muss bis zur Herkunftsprüfung im Transkript und Hook-/Remote-Payload
bleiben. Erst danach darf die Anzeige ihn ausblenden. Vorheriges Entfernen
zerstört die Herkunft und erzeugt ununterstützten Plaintext. Beide Loop-Seiten
müssen alle Reviews, Berichte und Übergaben über diesen Sender schicken. Die
Einbindung in den installierten Loop steht separat aus; erst danach gilt der
tatsächliche Loop als geschützt. Die Fixtures brauchen keinen echten Versand.

Unmarkiertes `cmux send`, manuelles Einfügen und externe Sender haben **unbekannte Herkunft**. Solcher Plaintext bleibt wie bisher mit Nutzertext kompatibel; aus identischen Texten lässt sich der Verfasser nicht zuverlässig bestimmen. Beide Seiten des Loops müssen den Sender verwenden. Er fängt keine beliebigen cmux-Aufrufe ab und verändert keine installierte Client-Konfiguration. Bestehende Drafts und Vault-Notizen werden nicht automatisch repariert; betroffene Daten muss der Eigentümer prüfen und gezielt entfernen.
