# @bastra-recall/statusline

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

Statusline for Claude Code, shipped with [bastra-recall](https://github.com/n0mad-ai/bastra-recall).

Built on [owloops/claude-powerline](https://github.com/owloops/claude-powerline) (MIT, vendored)
with a `bastra-status` segment that surfaces live recall/save activity from the bastra-recall daemon.

### Install

It is wired up automatically by `bastra install claude-code`. To add it by hand,
set your Claude Code `statusLine` command to run the Node.js script:

```jsonc
// ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "node <path>/@bastra-recall/statusline/dist/index.mjs --style=powerline",
    "refreshInterval": 1
  }
}
```

### Codex Powerline panel

`bastra-codex-statusline --cmux` opens a compact live Powerline panel below the
Codex terminal in cmux. Run it from the Codex terminal's shell (or pass its
`CMUX_SURFACE_ID` as `--surface UUID` from another terminal). It binds to that
surface's registered Codex session, never whichever session happens to be newest.

The first row shows project/branch, model/reasoning, reported usage windows,
context usage, and the live vault size. The second shows successful searches,
returned candidates, memory/document loads, saves/edits, elapsed tool time, and
failures. Calls include other Bastra tools as well. Counters reset when Codex
reports `task_started` or `turn_started` with a changed or missing turn ID.
The live search stage comes from the existing Bastra feed; finished calls come
from Codex's transcript, so they are not counted twice.

```sh
bastra-codex-statusline --cmux
bastra-codex-statusline --session <id> --watch
bastra-codex-statusline --transcript /path/to/rollout.jsonl --json
bastra-codex-statusline --demo
```

For a source checkout, use `node packages/statusline/bin/bastra-codex-statusline`
after `npm run build --workspace=@bastra-recall/statusline`.

Usage percentages mean **used**, and quota windows are labeled by their actual
duration. Missing windows are omitted; missing context is `—`. Context is the
latest reported request token total divided by the reported context window;
it is a snapshot, not a tokenizer for messages still being composed. The token
counter is cumulative session usage, including repeated input. It is not the
context size or a cost estimate.

The panel reads local metadata only, never evaluates tool arguments and never
sends messages to Codex. It refreshes at 200 ms, reads JSONL incrementally and
supports resize, `--ascii`, `--no-color` and `NO_COLOR`. Close its tab or press
Ctrl-C to stop it. Start it again for a new session; it stays pinned to its original
session. cmux may enforce a minimum height for a pane (a split terminal area)
larger than the two display rows.

This is a separate panel, not a custom item in Codex's native footer. It requires
legacy JSONL history; paginated-only histories are not supported. Codex's rollout
format is version-dependent: unrecognized rows are ignored, unavailable sources
are shown as unavailable, and no missing measurement is replaced with a fake zero.

### Experimental Neural Console

`--design classic` preserves the first Neural Console; `--design orbital`
selects the alien cockpit; `--design ember` selects the borderless ember field.
All three read the same data and are independently selectable.

Ember is borderless and structured by tinted bands: header, the Recall sieve
with context and limits, a Recall row for the current activity, and a two-line
footer for repository and session. The sieve reads left to right: a cloud of
small dots represents the vault, then one large dot per returned candidate
since the last human prompt, then one per load (capped by the available room; the numbers above stay
exact). Next to it Ember lists the titles of the
memories loaded in this turn, newest first. Titles come from the tool results
in the local transcript and are only held in the panel's memory. All three designs
show loaded titles. The five-hour limit and API time appear when the client
reports them. In live mode, the cloud shimmers and sparks fly between the stages
only during real Recall activity or its labelled afterglow. Ember's full color
appearance needs truecolor and at least 90 columns; narrower
panes get a seven-line text summary.

```sh
bastra-recall-panel --session <claude-session-id> --watch --design orbital
bastra-recall-panel --session <claude-session-id> --watch --design classic
bastra-recall-panel --session <claude-session-id> --watch --design ember
bastra-recall-panel --client codex --session <codex-session-id> --watch --design orbital
bastra-recall-panel --client codex --cmux
```

Ember colors the context readout by how full the window is: green, yellow from
40 %, orange from 60 %, red from 70 %, and from 40 % a line of text below the
free tokens says what to do. The bar is its own scale, so the color of the
part still ahead is visible. These stops are a working convention against
context rot, not measured thresholds: published measurements describe a gradual
decline that depends on token count and task, not a share of the window. They
live in `src/panel/context-level.ts`; currently only Ember imports them.

All three designs have a compact view: header, one line with the context, five-hour and
seven-day gauges plus the Recall counts, and the activity row. Click the arrow
at the right of the header or press `m` in the panel; `--compact` starts in it.
The half-moon next to it (or `h`, or `--light`) changes to a light skin on warm paper.
While the panel listens for clicks, select text with Shift held.

`bastra-recall-panel --ensure --design ember --compact` is meant for a Claude
Code `SessionStart` hook: inside cmux it opens the panel under the session's
pane unless one is already running there, prints nothing and never fails;
outside cmux it does nothing. A panel opened
with `--cmux` resizes its pane to the rows it draws whenever the view changes.

Codex autostart is installed with `bastra-recall-panel --install-codex-hook --design ember --compact`.
It preserves existing hooks, backs up the hook file, and adds a normal `SessionStart`
hook for startup/resume. Review and enable it in Codex `/hooks`; the installer never
writes trust hashes. `--ensure --client codex` uses the exact hook session's cmux
registration when a shared daemon does not supply a surface environment variable.
If that registration is absent it quietly waits for a later start instead of
opening under an unrelated tab. Existing panels are reused.

The Codex reader uses local JSONL history, whose format is version-dependent;
paginated-only history is still unsupported. Model-reported token and rate-limit
fields are used as supplied. See the official [Codex hooks guide](https://learn.chatgpt.com/docs/hooks)
and [app-server protocol](https://learn.chatgpt.com/docs/app-server).

Opened with `--cmux` and without `--session`, the panel follows the pane it was
opened under instead of one session: once per second it asks cmux which tab is
selected there and shows the Claude or Codex session cmux last recorded for
that tab. A new session in the same tab, or switching tabs, rebinds the panel;
a tab without an agent shows a waiting state. `--session` keeps the old fixed
binding.

Live mode reads the native Claude statusline snapshot published by
`dist/claude-panel-feed.mjs --renderer '<original statusLine.command>'`.
This wrapper receives Claude's JSON on stdin, writes only the small session
metadata snapshot under `~/.bastra/panels/claude/`, and delegates to the original
renderer so the existing footer stays intact. Without `--renderer` it only publishes the snapshot and prints nothing, for
setups where the panel replaces the footer. It is configured as Claude's
`statusLine.command`, with `refreshInterval: 1`; back up settings before changing
that command. Claude reloads it automatically. Replacing that command later
also removes the feed, which the panel reports as stale instead of keeping old values.

Context is Claude's native **used** percentage, not the footer's remaining value.
Weekly usage comes only from `rate_limits.seven_day.used_percentage`. Missing
measurements stay unknown. After ten seconds without a native update, values
are marked unavailable. Recall counts are deduplicated from this session's
main-thread transcript and count successful Recall/document searches, returned
candidates, loads/reads and saves/edits. Claude resets them on a new human prompt;
Codex resets them on `task_started` or `turn_started` with a changed or missing
turn ID. Automatic prompt hints are not completed tool searches; directly loading a hinted memory can therefore show a load with zero searches or hits. Failed calls appear
in the activity text. `Recall` uses the exact same forwarder duration as the old
Bastra footer when the session, turn and completed-call count match. `Client`
measures invocation-to-result time including the client's transport/dispatch
overhead. These are distinct boundaries, so the Client number can be higher.
If the forwarder feed cannot be matched safely, only Client time is shown.

The metadata row shows Git branch and short SHA, staged/modified/new files,
conflicts and ahead/behind relative to local upstream refs. Git is read without
network or index locks, at most once per five seconds. It does not fetch remote
changes; failed Git reads are shown as unavailable. Only positive ahead/behind counts are shown: `↑N` means local commits ahead of
the local upstream copy, and `↓M` is a known minimum from that copy. Zero and
unknown counts are omitted; if both are zero the whole arrow part disappears.
A missing `↓` means the remote state is not known, not that the repository is
current. The panel never fetches: new remote commits can be reflected only
after you manually run `git fetch` in this repository. Check Git separately
when that distinction matters. When supplied by the
client, session duration, reasoning effort, estimated list-price cost, cache-hit
ratio and changed-line counts are displayed. Codex also reports cumulative
session tokens. Cost and API duration missing from Codex's stream remain unknown. Its reported cached input tokens divided by cumulative input tokens appear as `Cache-Eingabe`; this is distinct from Claude's reported request cache-hit ratio.
The Codex context readout uses its own reported effective context window and
latest request token usage; it does not borrow Claude's window size or quota.
The shared vault count remains current across sessions. A matching fresh feed
supplies in-flight stages. In all three themes, the activity signal follows the
current Claude or Codex turn. A Codex final answer or completion event, or a Claude
Stop hook, ends the signal immediately; fresh stage data, pending transcript tools
and a tool completion afterglow cannot keep a finished turn moving. During a turn,
the orbital core reacts to Recall tools and keeps a labelled five-second
completion afterglow, so a fast call is visible even between refreshes. Unchanged
rows are not redrawn; clocks and other changing values can still update while idle.
Changed rows are painted with synchronized terminal
updates instead of clearing the screen. No prompts or memory bodies are retained
in the feed.

`bastra-recall-panel --demo --watch` previews the selected design (`orbital` by
default) with example context/usage values, Recall results and animated activity.
It is intentionally marked **DESIGN / DEMO**. Live data is selected separately
with `--session`.

Use `--cmux --surface UUID --workspace UUID --demo` to place the preview below a
specific terminal. `--snapshot FILE` displays an explicit `NeuralData` JSON
snapshot instead; it is marked SNAPSHOT and never animates a fake search.
Close the preview tab or press Ctrl-C there to stop it.

### License

MIT. Bundles `owloops/claude-powerline` under the MIT License.

<a id="deutsch"></a>

## Deutsch

Statusline für Claude Code, mitgeliefert mit [bastra-recall](https://github.com/n0mad-ai/bastra-recall).

Sie baut auf [owloops/claude-powerline](https://github.com/owloops/claude-powerline)
auf (MIT, im Paket enthalten). Das Segment `bastra-status` zeigt die aktuelle
Abruf- und Speicheraktivität des bastra-recall-Daemons.

### Installation

`bastra install claude-code` richtet sie automatisch ein. Für die manuelle
Einrichtung setzt du Claudes `statusLine`-Befehl auf den Aufruf des Node.js-Skripts:

```jsonc
// ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "node <path>/@bastra-recall/statusline/dist/index.mjs --style=powerline",
    "refreshInterval": 1
  }
}
```

### Codex-Powerline-Panel

`bastra-codex-statusline --cmux` öffnet ein kompaktes Powerline-Panel unter dem
Codex-Terminal in cmux. Starte den Befehl in dessen Shell oder übergib von einem
anderen Terminal aus dessen `CMUX_SURFACE_ID` als `--surface UUID`. Das Panel
bindet sich an die für diese Surface registrierte Codex-Sitzung, nicht an die
zufällig neueste Sitzung.

Die erste Zeile zeigt Projekt/Branch, Modell/Reasoning, gemeldete Nutzungsfenster,
Kontextbelegung und die aktuelle Vault-Größe. Die zweite zeigt erfolgreiche
Suchen, zurückgegebene Kandidaten, geladene Erinnerungen/Dokumente,
Speicher-/Änderungsaufrufe, Werkzeuglaufzeit und Fehler. Die Aufrufzahl umfasst
auch andere Bastra-Werkzeuge. Die Zähler beginnen neu, wenn Codex `task_started`
oder `turn_started` mit einer geänderten oder fehlenden Turn-ID meldet.
Die laufende Suchphase stammt aus dem bestehenden Bastra-Feed, abgeschlossene
Aufrufe aus dem Codex-Transcript; so werden sie nicht doppelt gezählt.

```sh
bastra-codex-statusline --cmux
bastra-codex-statusline --session <id> --watch
bastra-codex-statusline --transcript /path/to/rollout.jsonl --json
bastra-codex-statusline --demo
```

Nach `npm run build --workspace=@bastra-recall/statusline` startest du aus einem
Quellcode-Checkout `node packages/statusline/bin/bastra-codex-statusline`.

Nutzungsprozente bedeuten **verbraucht**; Kontingentfenster tragen ihre tatsächliche
Dauer als Beschriftung. Fehlende Fenster werden ausgelassen, fehlender Kontext
erscheint als `—`. Die Kontextbelegung ist die zuletzt gemeldete Tokenzahl einer
Anfrage geteilt durch das gemeldete Kontextfenster. Sie ist eine Momentaufnahme,
keine Tokenzählung für Nachrichten, die du noch schreibst. Der Tokenzähler summiert
die Sitzungsnutzung einschließlich wiederholter Eingaben. Er bezeichnet weder
die Kontextgröße noch geschätzte Kosten.

Das Panel liest nur lokale Metadaten, wertet keine Werkzeugargumente aus und
sendet keine Nachrichten an Codex. Es aktualisiert alle 200 ms, liest JSONL
fortlaufend und unterstützt Größenänderungen, `--ascii`, `--no-color` und
`NO_COLOR`. Schließe seinen Tab oder drücke Ctrl-C, um es zu beenden. Für eine neue
Sitzung startest du es erneut; es bleibt an seine ursprüngliche Sitzung gebunden.
cmux kann für einen Pane (einen aufgeteilten Terminalbereich) eine Mindesthöhe
vorgeben, die über den zwei Anzeigezeilen liegt.

Es ist ein separates Panel, kein eigener Eintrag in Codex' nativer Fußzeile.
Es braucht die bisherige JSONL-Historie; ausschließlich paginierte Historien
werden nicht unterstützt. Codex' Rollout-Format hängt von der Version ab:
Unbekannte Zeilen werden ignoriert, nicht verfügbare Quellen als nicht verfügbar
angezeigt. Fehlende Messwerte werden nicht durch erfundene Nullen ersetzt.

### Experimentelle Neural Console

`--design classic` wählt die erste Neural Console, `--design orbital` das
Alien-Cockpit und `--design ember` das randlose Glutfeld. Alle drei lesen dieselben
Daten und lassen sich unabhängig voneinander wählen.

Ember hat keine Rahmen; farbig hinterlegte Bänder gliedern Kopfzeile,
Recall-Sieb mit Kontext und Limits, Recall-Zeile für die aktuelle Aktivität und
zweizeiligen Fußbereich für Repo und Sitzung. Das Sieb liest sich von links nach
rechts: Eine Wolke kleiner Punkte stellt den Vault dar, danach folgt ein großer
Punkt je zurückgegebenem Kandidaten seit dem letzten menschlichen Prompt, dann
einer je Ladevorgang (begrenzt durch den Platz; die Zahlen darüber bleiben exakt).
Daneben zeigt Ember die Titel der in diesem Turn geladenen Erinnerungen, neueste
zuerst. Die Titel stammen aus den Werkzeugergebnissen im lokalen Transcript und
bleiben nur im Arbeitsspeicher des Panels. Alle drei Designs zeigen geladene
Titel. Das Fünf-Stunden-Limit und die API-Zeit erscheinen, soweit der Client sie meldet.
Im Live-Modus schimmert die Wolke und Funken fliegen zwischen den Stufen nur während echter
Recall-Aktivität oder ihres gekennzeichneten Nachklangs. Für die vollständige
Farbdarstellung braucht Ember Truecolor und mindestens 90 Spalten; schmalere
Panes zeigen eine siebenzeilige Textansicht.

```sh
bastra-recall-panel --session <claude-session-id> --watch --design orbital
bastra-recall-panel --session <claude-session-id> --watch --design classic
bastra-recall-panel --session <claude-session-id> --watch --design ember
bastra-recall-panel --client codex --session <codex-session-id> --watch --design orbital
bastra-recall-panel --client codex --cmux
```

Ember färbt die Kontextanzeige nach der Belegung des Fensters: grün, ab 40 % gelb,
ab 60 % orange und ab 70 % rot. Ab 40 % steht unter den freien Tokens auch eine
Handlungsempfehlung. Der Balken hat eine eigene Skala, damit die Farbe des noch
vor dir liegenden Bereichs sichtbar ist. Diese Stufen sind eine Arbeitskonvention
gegen Kontextverfall, keine gemessenen Schwellen: Veröffentlichte Messungen
beschreiben einen allmählichen Rückgang, abhängig von Tokenzahl und Aufgabe,
nicht vom Anteil des Fensters. Die Stufen stehen in `src/panel/context-level.ts`;
derzeit importiert nur Ember sie.

Alle drei Designs haben eine kompakte Ansicht: Kopfzeile, eine Zeile mit Kontext,
Fünf-Stunden- und Sieben-Tage-Anzeige samt Recall-Zählern sowie die Aktivitätszeile.
Klicke auf den Pfeil rechts in der Kopfzeile oder drücke `m` im Panel;
`--compact` startet in dieser Ansicht. Der Halbmond daneben (oder `h` oder
`--light`) wechselt zu einer hellen Darstellung auf warmem Papier. Solange das
Panel Klicks entgegennimmt, hältst du zum Markieren von Text die Shift-Taste gedrückt.

`bastra-recall-panel --ensure --design ember --compact` ist für einen
Claude-Code-Hook bei `SessionStart` gedacht: In cmux öffnet es das Panel unter
dem Pane der Sitzung, falls dort noch keines läuft. Es gibt nichts aus und
meldet keinen Fehler; außerhalb von cmux tut es nichts. Ein mit `--cmux`
geöffnetes Panel passt die Pane-Höhe bei jedem Ansichtswechsel an seine Zeilen an.

Den Codex-Autostart richtest du mit
`bastra-recall-panel --install-codex-hook --design ember --compact` ein.
Der Installer erhält bestehende Hooks, sichert die Hook-Datei und ergänzt einen
normalen `SessionStart`-Hook für startup/resume. Prüfe und aktiviere ihn in Codex
unter `/hooks`; der Installer schreibt keine Trust-Hashes.
`--ensure --client codex` verwendet die cmux-Registrierung genau dieser
Hook-Sitzung, wenn ein gemeinsam verwendeter Daemon keine Surface-Umgebungsvariable
liefert. Fehlt die Registrierung, wartet es still auf einen späteren Start,
statt unter einem fremden Tab zu öffnen. Vorhandene Panels werden wiederverwendet.

Der Codex-Leser verwendet die lokale JSONL-Historie, deren Format von der Version
abhängt; ausschließlich paginierte Historien werden weiterhin nicht unterstützt.
Token- und Limit-Felder des Modells werden so verwendet, wie sie gemeldet werden.
Siehe die offizielle [Codex-Hook-Anleitung](https://learn.chatgpt.com/docs/hooks)
und das [App-Server-Protokoll](https://learn.chatgpt.com/docs/app-server).

Mit `--cmux` und ohne `--session` folgt das Panel dem Pane, unter dem es geöffnet
wurde, statt einer festen Sitzung: Einmal pro Sekunde fragt es cmux nach dem dort
ausgewählten Tab und zeigt die Claude- oder Codex-Sitzung, die cmux zuletzt dafür
vermerkt hat. Eine neue Sitzung im selben Tab oder ein Tab-Wechsel bindet das
Panel neu; ein Tab ohne Agent zeigt einen Wartezustand. `--session` erhält die
feste Bindung.

Der Live-Modus liest den nativen Claude-Statusline-Snapshot, den
`dist/claude-panel-feed.mjs --renderer '<original statusLine.command>'` schreibt.
Dieser Wrapper erhält Claudes JSON über stdin, schreibt nur den kleinen
Snapshot der Sitzungsmetadaten unter `~/.bastra/panels/claude/` und ruft den
ursprünglichen Renderer auf, damit die bestehende Fußzeile erhalten bleibt.
Ohne `--renderer` schreibt er nur den Snapshot und gibt nichts aus, für Setups,
in denen das Panel die Fußzeile ersetzt. Trage ihn als Claudes
`statusLine.command` mit `refreshInterval: 1` ein; sichere die Einstellungen,
bevor du diesen Befehl änderst. Claude lädt ihn automatisch neu. Ersetzt du den
Befehl später, entfällt auch der Feed; das Panel meldet ihn als veraltet, statt
alte Werte weiterzuzeigen.

Kontext bezeichnet Claudes nativen Prozentsatz **belegt**, nicht den Restwert
der Fußzeile. Die Wochennutzung stammt ausschließlich aus
`rate_limits.seven_day.used_percentage`. Fehlende Messwerte bleiben unbekannt.
Nach zehn Sekunden ohne native Aktualisierung werden Werte als nicht verfügbar
markiert. Die Recall-Zähler werden aus dem Haupt-Transcript dieser Sitzung
dedupliziert und zählen erfolgreiche Recall-/Dokumentsuchen, zurückgegebene
Kandidaten, Lade-/Leseaufrufe und Speicher-/Änderungsaufrufe. Claude setzt sie mit
einem neuen menschlichen Prompt zurück; Codex bei `task_started` oder
`turn_started` mit einer geänderten oder fehlenden Turn-ID. Automatische Prompt-Hinweise sind keine
abgeschlossenen Werkzeugsuchen; lädst du eine direkt vorgeschlagene Erinnerung,
kann daher ein Ladevorgang bei null Suchen und Treffern erscheinen. Fehlgeschlagene
Aufrufe stehen im Aktivitätstext. `Recall` verwendet dieselbe Forwarder-Laufzeit
wie die alte Bastra-Fußzeile, wenn Sitzung, Turn und Zahl der abgeschlossenen
Aufrufe übereinstimmen. `Client` misst die Zeit vom Aufruf bis zum Ergebnis,
einschließlich Transport und Zustellung durch den Client. Das sind verschiedene
Messgrenzen; der Client-Wert kann deshalb höher liegen. Lässt sich der
Forwarder-Feed nicht sicher zuordnen, wird nur die Client-Zeit angezeigt.

Die Metadatenzeile zeigt Git-Branch und kurze SHA, gestagte/geänderte/neue Dateien,
Konflikte sowie voraus/zurück relativ zu lokalen Upstream-Refs. Git wird ohne
Netzwerk- oder Indexsperren höchstens einmal alle fünf Sekunden gelesen.
Entfernte Änderungen werden nicht abgerufen; fehlgeschlagene Git-Lesungen
erscheinen als nicht verfügbar. Nur positive voraus/zurück-Zähler werden gezeigt: `↑N` nennt lokale Commits
relativ zur lokalen Upstream-Kopie, `↓M` einen belegten Mindestwert aus dieser
Kopie. Null und unbekannte Werte entfallen; sind beide null, entfällt der ganze
Pfeilteil. Ein fehlendes `↓` heißt „Remote-Stand nicht bekannt“, nicht „aktuell“.
Das Panel holt nie selbst: Neue Remote-Commits werden erst nach einem manuellen
`git fetch` in diesem Ordner berücksichtigt. Prüfe Git separat, wenn diese
Unterscheidung wichtig ist. Soweit der Client sie liefert, erscheinen
Sitzungsdauer, Reasoning-Aufwand, geschätzte Kosten nach Listenpreis,
Cache-Trefferquote und geänderte Zeilen. Codex meldet außerdem kumulierte
Sitzungstokens. Kosten und API-Zeit, die im Codex-Datenstrom fehlen, bleiben
unbekannt. Die gemeldeten gecachten Eingabetokens geteilt durch die kumulierten
Eingabetokens erscheinen als `Cache-Eingabe`; das ist eine andere Größe als
Claudes gemeldete Cache-Trefferquote der Anfrage.
Die Codex-Kontextanzeige verwendet dessen eigenes gemeldetes effektives
Kontextfenster und die Tokenzahl der letzten Anfrage; sie übernimmt weder
Claudes Fenstergröße noch dessen Kontingent.
Die gemeinsame Vault-Zahl bleibt über Sitzungen hinweg aktuell. Ein passender
frischer Feed liefert laufende Phasen. In allen drei Designs folgt das
Aktivitätssignal dem aktuellen Claude- oder Codex-Turn. Eine finale Codex-Antwort
oder ein Abschlussereignis beziehungsweise ein Claude-Stop-Hook beendet das
Signal sofort; frische Phasendaten, ausstehende Transcript-Werkzeuge und der
Nachklang eines Werkzeugabschlusses halten einen beendeten Turn nicht in Bewegung.
Während eines Turns reagiert der Orbital-Kern auf Recall-Werkzeuge und zeigt
einen gekennzeichneten fünfsekündigen Nachklang, damit schnelle Aufrufe auch
zwischen Aktualisierungen sichtbar sind. Unveränderte Zeilen werden nicht neu
gezeichnet; Uhren und andere veränderliche Werte können sich auch im Leerlauf
weiter aktualisieren. Geänderte Zeilen werden mit synchronisierten
Terminal-Aktualisierungen gezeichnet, statt den Bildschirm zu leeren. Der Feed
bewahrt keine Prompts oder Erinnerungsinhalte auf.

`bastra-recall-panel --demo --watch` zeigt das gewählte Design (standardmäßig
`orbital`) mit Beispielwerten für Kontext/Nutzung, Recall-Ergebnissen und
animierter Aktivität. Es ist ausdrücklich als **DESIGN / DEMO** markiert.
Live-Daten wählst du getrennt mit `--session` aus.

Mit `--cmux --surface UUID --workspace UUID --demo` öffnest du die Vorschau
unter einem bestimmten Terminal. `--snapshot FILE` zeigt stattdessen einen
ausdrücklich gewählten `NeuralData`-JSON-Snapshot; er ist als SNAPSHOT markiert
und animiert keine erfundene Suche. Schließe den Vorschau-Tab oder drücke dort
Ctrl-C, um die Vorschau zu beenden.

### Lizenz

MIT. Enthält `owloops/claude-powerline` unter der MIT-Lizenz.
