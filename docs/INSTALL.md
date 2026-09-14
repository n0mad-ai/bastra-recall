# More installation options / Weitere Installationswege

For the guided setup, start with the [README](../README.md#install). The [support matrix](../README.md#supported-platforms) lists platform limitations. / Für das geführte Setup beginne mit der [README](../README.md#installation). Die [Support-Matrix](../README.md#unterstützte-plattformen) nennt Plattformgrenzen.

## English

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

### Manual client configuration

Use the [manual setup guide](./USAGE.md#fully-manual-install--fallback). Codex uses a separate [TOML-based setup](./CODEX.md). Restart the client after changing registrations, then run `bastra doctor` to check them.

## Deutsch

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

### Client manuell konfigurieren

Nutze die [manuelle Anleitung](./USAGE.md#komplett-manuelle-installation--fallback). Codex verwendet eine eigene [TOML-Konfiguration](./CODEX.md). Starte den Client nach geänderten Registrierungen neu und prüfe sie mit `bastra doctor`.
