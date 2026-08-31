# Codex + ChatGPT Desktop / Codex + ChatGPT Desktop

## Deutsch

Bastra Recall verwendet auf demselben Rechner die von Codex und der ChatGPT-Desktop-App gemeinsam gelesene Datei `~/.codex/config.toml`. Die Anmeldung bleibt vollständig bei OpenAI: ChatGPT-Login oder OpenAI-API-Key werden von Codex verwaltet; Bastra Recall benötigt dafür keinen eigenen OpenAI-Schlüssel. Der Vault, der MCP-Forwarder und alle Recall-Daten bleiben lokal.

### Installation

```bash
npx bastra-recall install codex --vault ~/BastraVault
# nach einer globalen Installation alternativ:
bastra install codex --vault ~/BastraVault
```

Der Adapter:

1. registriert `bastra-recall` über den offiziellen Befehl `codex mcp add`;
2. installiert den Skill nach `~/.agents/skills/bastra-recall` einschließlich `agents/openai.yaml`;
3. führt Bastra-eigene Einträge in `~/.codex/hooks.json` zusammen und bewahrt fremde Einträge;
4. sichert vorhandene Konfigurationen vor Änderungen und pinnt flüchtige `npx`-Runtimes;
5. aktiviert dieselbe Integration für Codex CLI, Codex IDE und ChatGPT Desktop auf diesem Host.

Beim ersten Codex-Start die sieben angezeigten Bastra-Hooks prüfen und vertrauen; später ist derselbe Dialog über `/hooks` erreichbar. Codex bindet Vertrauen an den exakten Hook-Hash und fordert nach inhaltlichen Änderungen erneut zur Prüfung auf. Danach ChatGPT Desktop, bestehende Codex-Sitzungen und die IDE-Erweiterung neu starten.

### Reflex-Layer

| Codex-Ereignis | Bastra-Verhalten |
|---|---|
| `SessionStart` | projektbewusster Startkontext, Konventionen und offene Hinweise |
| `UserPromptSubmit` | Recall bei Lookup-, Claim- und Reflex-Signalen |
| `PreToolUse: apply_patch` | Patch-Ziele und Inhalt in die vorhandene Write/Edit-Lane normalisieren |
| `PreToolUse: update_plan` | Plan-Schritte in die vorhandene Topologie-/Todo-Lane normalisieren |
| `PreToolUse: Bash` | riskante oder destruktive Befehle vor Ausführung prüfen |
| `PostToolUse: Bash` | Fehlschläge und Act-Signale erfassen; beliebige Codex-JSON-Antwortwerte unterstützen |
| `Stop` | stille Save-Evaluation; bei `--no-stop-hook` deaktiviert |

Alle Hook-Pfade sind fail-open: Ein nicht erreichbarer Daemon darf keinen Codex-Turn blockieren. Injizierte Blöcke tragen `surface="codex"`, Telemetrie verwendet den getrennten Client-Wert `codex`. Das aktuelle Codex-JSONL-Transkriptformat wird additiv unterstützt; weil OpenAI es als instabil kennzeichnet, bleiben ältere Formate und leere Fallbacks erhalten.

### Statusanzeige

Während ein Hook läuft, verwendet der Adapter Codex' native, blinkende Statuszeile über `statusMessage`, zum Beispiel `Bastra Recall · loading context`, `Bastra Recall · recalling for patch` oder `Bastra Recall · evaluating memory save`. Die Meldung ist bewusst kurz und verschwindet nach dem Hook.

Eine dauerhafte zweite Zeile in der ChatGPT-Desktop-App ist derzeit keine dokumentierte Erweiterungsfläche. `tui.status_line` gehört ausschließlich zur Codex-Terminaloberfläche und unterstützt eingebaute Segment-IDs, aber keinen externen Bastra-Renderer. Der Installer verändert diese persönliche TUI-Einstellung deshalb nicht. Dauerzustand und Diagnose bleiben über `bastra status` und `bastra doctor codex` abrufbar; eine spätere offizielle Plugin-/Command-Schnittstelle kann an den vorhandenen Bastra-Statusline-Renderer angebunden werden.

### Prüfung und Entfernung

```bash
bastra doctor codex
bastra doctor codex --fix
bastra uninstall codex
```

`doctor` prüft Codex-/ChatGPT-Erkennung, MCP-Registrierung, Forwarder, Vault, Skill, Pflicht-Hooks und Daemon. Den von Codex verwalteten Vertrauensstatus zeigt `/hooks`; der Adapter umgeht diese Sicherheitsprüfung nicht. `uninstall` entfernt nur Bastra-eigene MCP-, Hook- und Skill-Einträge; der Vault und fremde Hooks bleiben unangetastet.

Das optionale Paket unter `plugins/bastra-recall/` verteilt denselben proaktiven Skill über OpenAIs Plugin-Format. MCP, Hooks und Vault-Pfad bleiben bewusst beim CLI-Adapter, damit Plugin und Installer keine doppelten Hooks registrieren.

Offizielle Grundlagen: [MCP in ChatGPT und Codex](https://learn.chatgpt.com/docs/extend/mcp), [Codex Hooks](https://learn.chatgpt.com/docs/hooks), [Codex Skills](https://learn.chatgpt.com/docs/build-skills), [Plugin-Architektur](https://developers.openai.com/plugins/concepts/plugins).

## English

On the same machine, Bastra Recall uses `~/.codex/config.toml`, which is shared by Codex and the ChatGPT desktop app. Authentication remains entirely OpenAI-owned: Codex manages the ChatGPT sign-in or OpenAI API key, and Bastra Recall needs no separate OpenAI credential for this integration. The vault, MCP forwarder, and recall data stay local.

### Installation

```bash
npx bastra-recall install codex --vault ~/BastraVault
# after a global installation, alternatively:
bastra install codex --vault ~/BastraVault
```

The adapter:

1. registers `bastra-recall` through the official `codex mcp add` command;
2. installs the skill at `~/.agents/skills/bastra-recall`, including `agents/openai.yaml`;
3. merges Bastra-owned entries into `~/.codex/hooks.json` while preserving foreign entries;
4. backs up existing configuration before changes and pins ephemeral `npx` runtimes;
5. activates the same integration for Codex CLI, Codex IDE, and ChatGPT desktop on this host.

On the first Codex start, review and trust the seven displayed Bastra hooks; the same dialog remains available through `/hooks`. Codex binds trust to the exact hook hash and asks for review again after substantive changes. Restart ChatGPT desktop, existing Codex sessions, and the IDE extension afterward.

### Reflex layer

| Codex event | Bastra behavior |
|---|---|
| `SessionStart` | project-aware startup context, conventions, and pending guidance |
| `UserPromptSubmit` | recall for lookup, claim, and reflex signals |
| `PreToolUse: apply_patch` | normalize patch targets and content into the existing Write/Edit lane |
| `PreToolUse: update_plan` | normalize plan steps into the existing topology/Todo lane |
| `PreToolUse: Bash` | check risky or destructive commands before execution |
| `PostToolUse: Bash` | capture failures and act signals; accept any Codex JSON response value |
| `Stop` | quiet save evaluation; disabled by `--no-stop-hook` |

Every hook path is fail-open: an unreachable daemon must not block a Codex turn. Injected blocks carry `surface="codex"`, and telemetry uses the distinct `codex` client value. The current Codex JSONL transcript shape is supported additively; because OpenAI marks it unstable, older shapes and empty fallbacks remain available.

### Status display

While a hook is running, the adapter uses Codex's native blinking status line through `statusMessage`, for example `Bastra Recall · loading context`, `Bastra Recall · recalling for patch`, or `Bastra Recall · evaluating memory save`. The message is deliberately brief and disappears when the hook finishes.

A persistent second row in the ChatGPT desktop app is not currently a documented extension surface. `tui.status_line` belongs to the Codex terminal UI only and supports built-in segment IDs, not an external Bastra renderer. The installer therefore leaves this personal TUI preference unchanged. Persistent health and diagnostics remain available through `bastra status` and `bastra doctor codex`; a future official plugin/command provider can connect to the existing Bastra status-line renderer.

### Verification and removal

```bash
bastra doctor codex
bastra doctor codex --fix
bastra uninstall codex
```

`doctor` verifies Codex/ChatGPT detection, MCP registration, forwarder, vault, skill, required hooks, and daemon. `/hooks` shows the Codex-owned trust state; the adapter does not bypass that safety review. `uninstall` removes Bastra-owned MCP, hook, and skill entries only; the vault and foreign hooks remain untouched.

The optional package at `plugins/bastra-recall/` distributes the same proactive skill through OpenAI's plugin format. MCP, hooks, and vault selection deliberately remain with the CLI adapter so plugin and installer cannot register duplicate hooks.

Official foundations: [MCP in ChatGPT and Codex](https://learn.chatgpt.com/docs/extend/mcp), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex skills](https://learn.chatgpt.com/docs/build-skills), [plugin architecture](https://developers.openai.com/plugins/concepts/plugins).
