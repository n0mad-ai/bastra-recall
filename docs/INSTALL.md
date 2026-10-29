# More installation options / Weitere Installationswege

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

For the guided setup, start with the [README](../README.md#install). The [support matrix](../README.md#supported-platforms) lists platform limitations.

### macOS download

Download **Install Bastra.command** from the [latest release](https://github.com/n0mad-ai/bastra-recall/releases/latest), then **right-click → Open**. macOS may block a normal double-click on a downloaded script. If the file has lost its executable permission, run:

```bash
chmod +x ~/Downloads/Install*.command
```

The installer sets up Homebrew if needed and runs guided setup. The **Uninstall Bastra.command** download unregisters clients and stops the daemon while keeping memories. You can inspect both scripts in [distribution](../distribution).

### Build from source

Supported Node versions are 22–26; source builds require Node 22.18+ and Git (the build tool needs 22.18). Building this branch may include changes not yet published in a release.

```bash
git clone https://github.com/n0mad-ai/bastra-recall.git
cd bastra-recall
npm install
npm run build
node packages/daemon/dist/cli.js install all --vault /absolute/path/to/your/vault
```

### Optional: code awareness (experimental, third-party tool)

Code awareness is experimental. It can help an agent find its way into an
unfamiliar or large repository. For “what breaks if I change this” it measurably
did not beat plain search on repositories like ours, and it costs context (the
dependents block before edits) and background CPU (graph refreshes).

`bastra install` asks once whether to enable code awareness. Saying yes installs
[Graphify](https://github.com/Graphify-Labs/graphify) (PyPI package `graphifyy`,
**pinned to 0.9.63**, Apache-2.0) into a Bastra-owned tool directory under
`~/.bastra/tools`, using [uv](https://docs.astral.sh/uv/). Without `uv` the
install continues and simply reports the feature as unavailable.

Graphify is a separate open-source project, not a Recall component. It runs
locally and sends nothing anywhere. Recall calls only its `extract` command in
code-only mode and reads the `graph.json` it writes — never its own installers,
which would edit your global `CLAUDE.md` and register competing hooks.

If you already have Graphify installed yourself, Recall reports it and leaves
it completely alone: it is never upgraded, downgraded or removed, and Recall
uses its own pinned copy. See [USAGE.md](./USAGE.md) for turning the feature on
and off.

### Local models and post-update checks (1.1.0)

New installs offer `tev1:4b` from 16 GB RAM (4.5 GB download), `gemma4:12b` as an alternative from 24 GB (8.1 GB) and as the suggestion from 32 GB. Existing installs without a saved choice retain the `gemma3:4b` fallback until you choose to switch. Text models and embedding models are separate. See [model recommendations](./USAGE.md#model-recommendations--when-a-release-suggests-a-different-local-text-model) for consent, overrides and measured limits.

After an update, re-run `bastra install claude-code` / `bastra install codex` if doctor reports the new save-notice matcher missing. Codex requires reviewing/trusting it in `/hooks`. A missing notice alone does not disable healthy recall hooks. `BASTRA_SAVE_NOTICE=0` disables the notice. [Codex notice compatibility](./codex-save-notice.md) explains the unverified interactive appearance.

### Manual client configuration

Use the [manual setup guide](./USAGE.md#fully-manual-install--fallback). Codex uses a separate [TOML-based setup](./CODEX.md). Restart the client after changing registrations, then run `bastra doctor` to check them. Its features section also shows what is switched off, for example no memory language set or no onboarding yet, with the command for each.

<a id="deutsch"></a>

### Optional startup instructions (#1314)

`bastra install codex --with-bootstrap` adds the generated Recall startup block to
`$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`).
`bastra install claude-code --with-bootstrap` optionally uses the active Claude
user `CLAUDE.md` (`CLAUDE_CONFIG_DIR`, otherwise `~/.claude`). If Claude already
has an unmanaged `bastra-recall` line, the installer leaves it alone and reports
a doctor notice. Without this flag, an interactive installer shows the exact
target and block and asks for a separate yes; non-interactive installation skips
it. `--yes` does not grant this consent; `--no-bootstrap` suppresses the offer.

The block comes from the canonical skill, includes its revision hash and stays
within 600 characters including markers. Reinstall replaces only one well-formed
managed region. Uninstall removes only that region; surrounding user bytes are
preserved. Duplicate or malformed markers require manual repair. `bastra doctor`
reports missing, stale or modified content separately from host loading limits.
A non-empty Codex `AGENTS.override.md` can hide the block; doctor also reports
its active root, configured instruction byte budget and project fallback names.
No override or other profile is edited. Restart the host after accepting a
change. File parity proves neither runtime delivery nor rule compliance; nearby
project guidance and host restrictions still apply. Claude `/context` can help
verify what loaded.


## Deutsch

Für das geführte Setup beginne mit der [README](../README.md#installation). Die [Support-Matrix](../README.md#unterstützte-plattformen) nennt Plattformgrenzen.

### macOS-Download

Lade **Install Bastra.command** aus dem [aktuellen Release](https://github.com/n0mad-ai/bastra-recall/releases/latest), dann **Rechtsklick → Öffnen**. macOS kann einen normalen Doppelklick auf ein heruntergeladenes Skript blockieren. Fehlt die Ausführungsberechtigung, führe Folgendes aus:

```bash
chmod +x ~/Downloads/Install*.command
```

Der Installer richtet bei Bedarf Homebrew ein und startet das geführte Setup. Der Download **Uninstall Bastra.command** entfernt Client-Registrierungen und stoppt den Daemon, behält aber die Erinnerungen. Beide Skripte kannst du unter [distribution](../distribution) lesen.

### Aus dem Quellcode bauen

Unterstützt werden Node 22–26; Quellcode-Builds benötigen Node 22.18+ und Git (das Build-Werkzeug braucht 22.18). Dieser Branch kann Änderungen enthalten, die noch nicht als Release veröffentlicht sind.

```bash
git clone https://github.com/n0mad-ai/bastra-recall.git
cd bastra-recall
npm install
npm run build
node packages/daemon/dist/cli.js install all --vault /absoluter/pfad/zu/deinem/vault
```

### Optional: Code-Awareness (experimentell, Drittanbieter-Werkzeug)

Code-Awareness ist experimentell. Sie kann einem Agenten helfen, sich in einem
unbekannten oder großen Repository zurechtzufinden. Bei „was geht kaputt, wenn
ich das ändere?“ war sie auf Repositories wie unserem messbar nicht besser als
eine einfache Suche, und sie kostet Kontext (der Block mit abhängigen Dateien
vor Änderungen) und Rechenzeit im Hintergrund (Aktualisieren der Karte).

`bastra install` fragt einmal, ob Code-Awareness eingeschaltet werden soll. Bei
Ja wird [Graphify](https://github.com/Graphify-Labs/graphify) (PyPI-Paket
`graphifyy`, **fest auf 0.9.63**, Apache-2.0) mit
[uv](https://docs.astral.sh/uv/) in ein Bastra-eigenes Werkzeugverzeichnis
unter `~/.bastra/tools` installiert. Ohne `uv` läuft die Installation weiter und
meldet die Funktion schlicht als nicht verfügbar.

Graphify ist ein eigenständiges Open-Source-Projekt, kein Bestandteil von
Recall. Es läuft lokal und schickt nichts irgendwohin. Recall ruft davon nur
`extract` im Code-only-Modus auf und liest die erzeugte `graph.json` — nie
dessen eigene Installer, die deine globale `CLAUDE.md` verändern und
konkurrierende Hooks eintragen würden.

Hast du Graphify bereits selbst installiert, meldet Recall das und lässt es
vollständig in Ruhe: Es wird nie aktualisiert, herabgestuft oder entfernt, und
Recall benutzt seine eigene festgelegte Kopie. Wie man die Funktion ein- und
ausschaltet, steht in [USAGE.md](./USAGE.md).

### Lokale Modelle und Prüfung nach Updates (1.1.0)

Neue Installationen bieten `tev1:4b` ab 16 GB RAM (4,5 GB Download), `gemma4:12b` als Alternative ab 24 GB (8,1 GB) und als Vorschlag ab 32 GB. Bestehende Installationen ohne gespeicherte Wahl behalten den Fallback `gemma3:4b`, bis du die Umstellung wählst. Text- und Embedding-Modelle sind getrennt. [Modell-Empfehlungen](./USAGE.md#modell-empfehlungen--wenn-ein-release-ein-anderes-lokales-textmodell-vorschlägt) erklären Zustimmung, Overrides und gemessene Grenzen.

Führe nach einem Update `bastra install claude-code` / `bastra install codex` erneut aus, wenn Doctor den neuen Speicherhinweis-Matcher vermisst. In Codex muss er in `/hooks` geprüft und bestätigt werden. Ein allein fehlender Hinweis deaktiviert gesunde Recall-Hooks nicht. `BASTRA_SAVE_NOTICE=0` schaltet den Hinweis aus. [Codex-Hinweis-Kompatibilität](./codex-save-notice.md#deutsch) erklärt die ungeprüfte interaktive Darstellung.

### Client manuell konfigurieren

Nutze die [manuelle Anleitung](./USAGE.md#komplett-manuelle-installation--fallback). Codex verwendet eine eigene [TOML-Konfiguration](./CODEX.md). Starte den Client nach geänderten Registrierungen neu und prüfe sie mit `bastra doctor`. Dessen Abschnitt features zeigt auch, was ausgeschaltet ist, etwa keine Memory-Sprache gesetzt oder noch kein Onboarding, jeweils mit dem passenden Befehl.

### Optionale Startanweisungen (#1314)

`bastra install codex --with-bootstrap` schreibt den generierten Recall-Startblock
nach `$CODEX_HOME/AGENTS.md` (Standard `~/.codex/AGENTS.md`).
`bastra install claude-code --with-bootstrap` nutzt optional die aktive
Nutzerdatei `CLAUDE.md` (`CLAUDE_CONFIG_DIR`, sonst `~/.claude`). Eine vorhandene
unverwaltete `bastra-recall`-Zeile bleibt unverändert; dafür erscheint nur ein
Doctor-Hinweis. Ohne Flag zeigt der interaktive Installer Ziel und Inhalt und
fragt separat nach einem Ja. Nichtinteraktiv bleibt der Block aus. `--yes`
gilt hierfür nicht; `--no-bootstrap` unterdrückt das Angebot.

Der Block stammt aus dem kanonischen Skill, trägt dessen Revisionshash und bleibt
mit Markern unter 600 Zeichen. Neuinstallation ersetzt nur einen korrekt
markierten Bereich. Deinstallation entfernt nur diesen Bereich; Nutzertext bleibt
bytegenau erhalten. Doppelte oder beschädigte Marker müssen manuell repariert
werden. `bastra doctor` unterscheidet fehlenden, veralteten und veränderten Inhalt
von Ladegrenzen des Hosts. Eine nichtleere Codex-Datei `AGENTS.override.md` kann
den Block verdecken. Doctor nennt außerdem aktives Profilverzeichnis,
Byte-Budget und Projekt-Ersatznamen; Overrides und andere Profile bleiben
unangetastet. Nach Änderungen den Host neu starten. Dateigleichheit belegt weder
das tatsächliche Laden noch Regelbefolgung; nähere Projektanweisungen und
Host-Einschränkungen gelten weiter. In Claude hilft `/context` beim Prüfen.
