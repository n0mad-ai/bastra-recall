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

Requires Node 22+ and Git. Building this branch may include changes not yet published in a release.

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

### Manual client configuration

Use the [manual setup guide](./USAGE.md#fully-manual-install--fallback). Codex uses a separate [TOML-based setup](./CODEX.md). Restart the client after changing registrations, then run `bastra doctor` to check them. Its features section also shows what is switched off, for example no memory language set or no onboarding yet, with the command for each.

<a id="deutsch"></a>

## Deutsch

Für das geführte Setup beginne mit der [README](../README.md#installation). Die [Support-Matrix](../README.md#unterstützte-plattformen) nennt Plattformgrenzen.

### macOS-Download

Lade **Install Bastra.command** aus dem [aktuellen Release](https://github.com/n0mad-ai/bastra-recall/releases/latest), dann **Rechtsklick → Öffnen**. macOS kann einen normalen Doppelklick auf ein heruntergeladenes Skript blockieren. Fehlt die Ausführungsberechtigung, führe Folgendes aus:

```bash
chmod +x ~/Downloads/Install*.command
```

Der Installer richtet bei Bedarf Homebrew ein und startet das geführte Setup. Der Download **Uninstall Bastra.command** entfernt Client-Registrierungen und stoppt den Daemon, behält aber die Erinnerungen. Beide Skripte kannst du unter [distribution](../distribution) lesen.

### Aus dem Quellcode bauen

Benötigt Node 22+ und Git. Dieser Branch kann Änderungen enthalten, die noch nicht als Release veröffentlicht sind.

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

### Client manuell konfigurieren

Nutze die [manuelle Anleitung](./USAGE.md#komplett-manuelle-installation--fallback). Codex verwendet eine eigene [TOML-Konfiguration](./CODEX.md). Starte den Client nach geänderten Registrierungen neu und prüfe sie mit `bastra doctor`. Dessen Abschnitt features zeigt auch, was ausgeschaltet ist, etwa keine Memory-Sprache gesetzt oder noch kein Onboarding, jeweils mit dem passenden Befehl.
