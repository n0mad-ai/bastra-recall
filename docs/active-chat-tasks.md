# Due tasks in the active chat / Fällige Aufgaben im aktiven Chat

## English

Current main prepares Claude Code and Codex CLI chat delivery for v1.2.0; this does not change published v1.1.8. A due task can wake the registered chat in which you last sent a real human message, within `tasks.chatActiveMinutes` (default **30 minutes**). Both clients participate in the same selection: if your latest input was in an attached Codex terminal, the task goes there; if it was in Claude Code, it goes there. Received task messages, agent turns and system events do not extend that window. An unavailable, closed, unsupported or ambiguous latest chat never redirects delivery to an older chat. When no eligible chat is active, the task remains on the board and the optional macOS notification is the immediate channel.

### Codex CLI

Currently available on macOS and Linux.

Start a new attached Codex terminal with:

```bash
bastra codex
# Pass your usual Codex CLI options, for example:
bastra codex -C /path/to/project
```

The launcher starts its own real Codex App Server on a private Unix socket and connects the terminal UI through an authenticated local proxy. It registers the actual open thread and records input from that UI connection, rather than treating every user-shaped transcript entry as human input. Server events and Recall's task messages do not establish activity. A free thread receives `turn/start`; a running turn receives `turn/steer` with its exact current turn ID. A race or uncertain response does not trigger an automatic resend.

This path uses the [Codex App Server contract](https://learn.chatgpt.com/docs/app-server), with the isolated CLI probe on 0.167.0 as its runtime baseline. It needs a Codex CLI with the corresponding App Server and remote terminal options. The launcher changes no Codex settings and asks for no additional approval. Your existing Codex authentication remains with Codex; the local bridge creates a separate private transport credential. The terminal must stay connected. Closing it disables that generation; reopening or resuming registers a new generation, while a fork does not inherit the source chat's activity.

Run future task-receiving terminals through `bastra codex`. An ordinary `codex` process, an already open terminal, the desktop app and IDE chats are not automatically attached. Recall does not send test messages to or take over existing windows. An observed input in an unattached Codex client blocks fallback to an older Claude chat. Programs without an activity hook or bridge are not observable and fall outside this selection guarantee.

### Claude Code

Run the interactive `bastra install` wizard and select Claude Code, or use interactive `bastra tasks setup-hooks` when the task hooks are already configured. Recall asks once whether it may enable `crossSessionInbound: accept` in Claude Code's user settings. **This permits incoming session messages from all programs under your Mac account, not just Recall.** Only an explicit Yes enables it; `--yes`, an existing `accept`, scripted installation or an unanswered prompt does not count. A No is saved and the setup does not ask again. Existing `hold`/`refuse`, unknown inbound settings and managed settings are preserved; Claude chat delivery remains off. New Claude sessions pick up the configured hooks and receiving setting.

### Settings and delivery evidence

Adjust the shared activity window in the Tasks section of Settings or with `bastra config set tasks.chatActiveMinutes 30` (integer 1–1440). The saved Claude consent, `tasks.chatConsent`, is read-only in generic Settings and does not govern the explicitly launched Codex bridge. Changing Claude's receiving setting away from `accept` closes Claude delivery immediately; an eligible Codex terminal can still receive its own tasks. No automatic change is made to an existing user's client settings during an update.

Recall sends an identified task-data message with an event ID. It never executes text from the task or grants new permission. The endpoint, credential and provenance journal stay private and local, outside the vault and synced storage. Generation, socket identity, connected UI and thread liveness are checked before Codex delivery. Each occurrence has one durable chat delivery claim shared across Claude and Codex, retained across daemon restarts. The macOS notification remains independently limited to one notification for that occurrence; the board remains available.

A socket write or successful RPC alone is not a processing receipt. Recall requires the exact sent message and a correlated visible assistant response carrying its event ID. This proves processing, not that a human read it, and does not acknowledge or resolve the task. Unknown outcomes are not blindly repeated, including after a restart or a change of client.

A registration initially lasts 24 hours. Proven human activity renews the same current socket generation; peer messages and replaced endpoints do not renew it. Historical records retire conservatively while recent ended/unknown activity and unread evidence remain barriers. More than 256 retained current records or an incomplete bounded history scan closes selection conservatively. Restart or resume an expired client to register again; notification and board remain available.

## Deutsch

Das aktuelle main bereitet die Chat-Zustellung für Claude Code und Codex CLI in v1.2.0 vor; die veröffentlichte v1.1.8 ändert sich dadurch nicht. Eine fällige Aufgabe kann den registrierten Chat wecken, in dem du zuletzt selbst geschrieben hast, innerhalb von `tasks.chatActiveMinutes` (Standard **30 Minuten**). Beide Programme nehmen an derselben Auswahl teil: War deine letzte Eingabe im angebundenen Codex-Terminal, kommt die Aufgabe dort an; war sie in Claude Code, kommt sie dort an. Empfangene Aufgabenmeldungen, Agentenrunden und Systemereignisse verlängern diese Zeit nicht. Ein nicht erreichbarer, geschlossener, nicht unterstützter oder nicht eindeutig bestimmbarer letzter Chat führt nie zum Ausweichen auf einen älteren Chat. Ist kein geeigneter Chat aktiv, bleibt die Aufgabe auf dem Brett; die optionale Mac-Mitteilung ist der unmittelbare Kanal.

### Codex CLI

Derzeit auf macOS und Linux verfügbar.

Starte ein neues angebundenes Codex-Terminal mit:

```bash
bastra codex
# Gewohnte Codex-CLI-Optionen weitergeben, zum Beispiel:
bastra codex -C /pfad/zum/projekt
```

Der Starter öffnet einen eigenen echten Codex App Server an einem privaten Unix-Socket und verbindet die Terminaloberfläche über einen authentifizierten lokalen Proxy. Er registriert den tatsächlich offenen Thread und hält Eingaben dieser Oberflächenverbindung fest, statt jeden als Nutzerbeitrag gespeicherten Transcript-Eintrag als menschlich zu werten. Serverereignisse und Recall-Aufgabenmeldungen zählen nicht als Aktivität. Ein freier Thread erhält `turn/start`; eine laufende Runde erhält `turn/steer` mit ihrer exakten aktuellen Turn-ID. Bei einem gleichzeitigen Zustandswechsel oder einer unklaren Antwort wird nicht automatisch erneut gesendet.

Dieser Weg verwendet den [Codex-App-Server-Vertrag](https://learn.chatgpt.com/docs/app-server); die isolierte CLI-Probe auf 0.167.0 ist die Laufzeitgrundlage. Er benötigt eine Codex CLI mit den entsprechenden App-Server- und Remote-Terminal-Optionen. Der Starter ändert keine Codex-Einstellungen und verlangt keine weitere Freigabe. Die vorhandene Codex-Anmeldung bleibt bei Codex; die lokale Verbindung erzeugt einen eigenen privaten Transportzugang. Das Terminal muss verbunden bleiben. Schließen deaktiviert diese Generation; erneutes Öffnen oder Resume registriert eine neue Generation. Ein Fork übernimmt die Aktivität des Quellchats nicht.

Starte künftige Terminals für Aufgabenmeldungen über `bastra codex`. Ein gewöhnlicher `codex`-Prozess, ein bereits offenes Terminal, die Desktop-App und IDE-Chats werden nicht automatisch angebunden. Recall sendet keine Testmeldungen an bestehende Fenster und übernimmt sie nicht. Eine beobachtete Eingabe in einem nicht angebundenen Codex-Client blockiert das Ausweichen auf einen älteren Claude-Chat. Programme ohne Aktivitätshook oder Verbindung sind nicht beobachtbar und von dieser Auswahlzusicherung nicht erfasst.

### Claude Code

Starte die interaktive Einrichtung mit `bastra install` und wähle Claude Code, oder verwende bei bereits eingerichteten Aufgaben-Hooks interaktiv `bastra tasks setup-hooks`. Recall fragt einmal, ob es `crossSessionInbound: accept` in Claude Codes Benutzereinstellung aktivieren darf. **Damit werden eingehende Sitzungsnachrichten von allen Programmen unter deinem Mac-Konto zugelassen, nicht nur von Recall.** Erst ein ausdrückliches Ja schaltet es ein; `--yes`, ein vorhandenes `accept`, eine Skriptinstallation oder eine unbeantwortete Frage zählt nicht. Ein Nein wird gespeichert; die Einrichtung fragt nicht erneut. Vorhandenes `hold`/`refuse`, unbekannte Empfangswerte und verwaltete Einstellungen bleiben erhalten; die Claude-Chat-Zustellung bleibt aus. Neue Claude-Sitzungen übernehmen die eingerichteten Hooks und die Empfangseinstellung.

### Einstellungen und Zustellbelege

Die gemeinsame Aktivitätsgrenze lässt sich im Aufgabenbereich der Einstellungen oder mit `bastra config set tasks.chatActiveMinutes 30` ändern (ganze Zahl 1–1440). Die gespeicherte Claude-Einrichtungsantwort `tasks.chatConsent` ist in den allgemeinen Einstellungen nur lesbar und steuert nicht die ausdrücklich gestartete Codex-Verbindung. Wird Claude Codes Empfangseinstellung von `accept` weg geändert, schließt das die Claude-Zustellung sofort; ein geeigneter Codex-Chat kann weiterhin seine Aufgaben erhalten. Ein Update ändert bestehende Client-Einstellungen nicht automatisch.

Recall sendet eine gekennzeichnete Aufgabendaten-Meldung mit Ereignis-ID. Es führt keinen Text aus der Aufgabe aus und erteilt keine neue Freigabe. Endpunkt, Zugangsdaten und Herkunftsjournal bleiben privat und lokal, außerhalb von Vault und synchronisierten Verzeichnissen. Vor der Codex-Zustellung werden Generation, Socket-Identität, verbundene Oberfläche und offener Thread geprüft. Jedes Vorkommen erhält einen dauerhaften Chat-Zustellversuch, gemeinsam für Claude und Codex und über Daemon-Neustarts hinweg. Die Mac-Mitteilung bleibt unabhängig davon auf eine Mitteilung je Vorkommen begrenzt; das Brett bleibt verfügbar.

Ein Socket-Schreibvorgang oder erfolgreicher RPC-Aufruf allein ist kein Verarbeitungsbeleg. Recall verlangt die exakt gesendete Meldung und eine zugehörige sichtbare Assistentenantwort mit ihrer Ereignis-ID. Das belegt Verarbeitung, nicht menschliches Lesen, und bestätigt oder erledigt die Aufgabe nicht. Unklare Ergebnisse werden nicht blind wiederholt, auch nicht nach Neustart oder Client-Wechsel.

Eine Registrierung gilt anfangs 24 Stunden. Geprüfte menschliche Aktivität verlängert dieselbe aktuelle Socketgeneration; empfangene Nachrichten und ersetzte Endpunkte verlängern sie nicht. Historische Einträge werden konservativ entfernt, während aktuelle beendete oder unbekannte Aktivität und ungelesene Belege die Auswahl weiter sperren können. Bei mehr als 256 verbleibenden aktuellen Einträgen oder einer unvollständigen begrenzten Historienprüfung schließt die Auswahl konservativ. Einen abgelaufenen Client neu starten oder fortsetzen, um ihn erneut zu registrieren; Mitteilung und Brett bleiben verfügbar.
