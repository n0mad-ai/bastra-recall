# Codex + ChatGPT Desktop

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

On the same machine, Bastra Recall uses `~/.codex/config.toml`, which is shared by Codex and the ChatGPT desktop app. Authentication remains entirely OpenAI-owned: Codex manages the ChatGPT sign-in or OpenAI API key, and Bastra Recall needs no separate OpenAI credential for this integration. Storage and keyword search run locally. Retrieved memories are handed to the connected AI client as context; see [privacy](./PRIVACY.md).

**Verification status:** Codex CLI is verified for the v1.0 integration. Desktop and IDE are implemented but not yet field-tested.

### Installation

```bash
npx bastra-recall install codex --vault ~/BastraVault
# after a global installation, alternatively:
bastra install codex --vault ~/BastraVault
```

The adapter:

1. registers `bastra-recall` through the official `codex mcp add` command;
2. installs the skill at `~/.agents/skills/bastra-recall`, including `agents/openai.yaml`;
3. merges Bastra-owned entries into `~/.codex/hooks.json` while preserving foreign entries — an entry is Bastra's by the hook client its command runs, not by its name, and a look-alike is reported as `hooks left alone` (#683);
4. backs up existing configuration before changes and pins ephemeral `npx` runtimes;
5. activates the same integration for Codex CLI, Codex IDE, and ChatGPT desktop on this host.

On the first Codex start, review and trust the displayed Bastra hooks (nine on verified Codex 0.162.1, eight without Stop; other versions keep eight/seven legacy entries); the same dialog remains available through `/hooks`. Codex binds trust to the exact hook hash and asks for review again after substantive changes. Restart ChatGPT desktop, existing Codex sessions, and the IDE extension afterward.

### Reflex layer

| Codex event | Bastra behavior |
|---|---|
| `SessionStart` | project-aware startup context, conventions, and pending guidance; includes `fork` |
| `PreToolUse: *` (verified 0.162.1 only) | one-time must-load/reflex gate after confirmed state persistence; Recall tools remain exempt |
| `UserPromptSubmit` | recall for lookup, claim, and reflex signals |
| `PreToolUse: apply_patch` | normalize patch targets and content into the existing Write/Edit lane |
| `PreToolUse: update_plan` | normalize plan steps into the existing topology/Todo lane — needs `tools.update_plan.enabled = true` in `~/.codex/config.toml`; Codex has shipped the planning tool off by default since 0.152.0, so `bastra install codex` sets the key itself (a commented block that `bastra uninstall codex` removes again; a value you set to `false` is left alone) (#506) |
| `PreToolUse: Bash` | check risky or destructive commands before execution |
| `PostToolUse: Bash` | capture failures and act signals; accept any Codex JSON response value |
| `PostToolUse: Recall write tools` | report confirmed saves/edits; re-run `bastra install codex` and trust the new entry in `/hooks`. `BASTRA_SAVE_NOTICE=0` disables it; a missing notice alone keeps healthy recall hooks active. [Compatibility and rendering limits](./codex-save-notice.md) |
| `Stop` | quiet save evaluation; disabled by `--no-stop-hook` |

Every hook path is fail-open: an unreachable daemon must not block a Codex turn. Injected blocks carry `surface="codex"`, and telemetry uses the distinct `codex` client value. The current Codex JSONL transcript shape is supported additively; because OpenAI marks it unstable, older shapes and empty fallbacks remain available.

### Gate evidence and compatibility (#1304)

The installer probes the selected Codex executable with `--version`; re-run installation after changing the Codex runtime so the recorded version stays current. Only **codex-cli 0.162.1** receives the catch-all gate: [the local runtime probe](https://github.com/n0mad-ai/bastra-recall/issues/1300#issuecomment-6497445090) confirmed deny for `exec_command` (hook name `Bash`) and `view_image`, and the `fork` SessionStart source. Older, newer, prerelease, and unknown versions remain **preparation only** until separately verified. They keep the legacy `additionalContext` hint lanes, without booking pending must-load ids or promising a tool interruption. This is a strict evidence gate, not a claim that other versions cannot deny.

On 0.162.1, an installed version marker travels with the client marker through both Node and compiled-stub hooks. Prompt/session hints use must-load wording only with this registration evidence. The gate interrupts once after a confirmed state write; retries pass even without a load. A failed state write, daemon error, or timeout fails open. Registration alone cannot verify Codex trust: re-run `bastra install codex`, then review and **re-trust changed/new definitions in `/hooks`**, including the changed SessionStart matcher and hint producers. Codex hashes the exact definition; untrusted hooks remain skipped. `bastra doctor codex` checks the gate registration/version markers and reports this limitation.

Coverage is bounded: `write_stdin` input/polls of an existing process do not create a fresh PreToolUse boundary. Hosted WebSearch is [documented outside tool hooks](https://learn.chatgpt.com/docs/hooks#tool-coverage). `apply_patch`, MCP, and other local tools are covered by current official documentation but were not separately runtime-certified in #1300. The catch-all matches every **supported** event occurrence; it does not expand host coverage. Desktop/IDE gate behavior was not runtime-tested. See the [official hook contract](https://learn.chatgpt.com/docs/hooks#pretooluse) and [trust rules](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

### Status display

While a hook is running, the adapter uses Codex's native blinking status line through `statusMessage`, for example `Bastra Recall · loading context`, `Bastra Recall · recalling for patch`, or `Bastra Recall · evaluating memory save`. The message is deliberately brief and disappears when the hook finishes.

For a persistent terminal display, `bastra-codex-statusline --cmux` opens a compact Powerline panel below the Codex surface. It shows model, reported quota windows, context usage, vault size, and per-turn Recall activity (searches, candidates, loads, saves/edits, tool time and errors). Use `--session <id> --watch` in a separate terminal without cmux. The panel binds to an explicit session and reads its JSONL transcript plus the existing Bastra feed; it does not send messages or resume the session. Paginated-only histories are not supported. See [statusline details](../packages/statusline/README.md#codex-powerline-panel).

This panel is separate from Codex's native footer. `tui.status_line` supports built-in segment IDs, so the installer still leaves that personal preference unchanged. The ChatGPT desktop app has no documented persistent second-row extension surface. Persistent health and diagnostics remain available through `bastra status` and `bastra doctor codex`.

### Verification and removal

```bash
bastra doctor codex
bastra doctor codex --fix
bastra uninstall codex
```

`doctor` verifies Codex/ChatGPT detection, MCP registration, forwarder, vault, skill, required hooks, and daemon. `/hooks` shows the Codex-owned trust state; the adapter does not bypass that safety review. `uninstall` removes Bastra-owned MCP, hook, and skill entries only; the vault and foreign hooks remain untouched.

The optional package at `plugins/bastra-recall/` distributes the same proactive skill through OpenAI's plugin format. MCP, hooks, and vault selection deliberately remain with the CLI adapter so plugin and installer cannot register duplicate hooks.

Official foundations: [MCP in ChatGPT and Codex](https://learn.chatgpt.com/docs/extend/mcp), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex skills](https://learn.chatgpt.com/docs/build-skills), [plugin architecture](https://developers.openai.com/plugins/concepts/plugins).

<a id="deutsch"></a>

## Deutsch

Bastra Recall verwendet auf demselben Rechner die von Codex und der ChatGPT-Desktop-App gemeinsam gelesene Datei `~/.codex/config.toml`. Die Anmeldung bleibt vollständig bei OpenAI: ChatGPT-Login oder OpenAI-API-Key werden von Codex verwaltet; Bastra Recall benötigt dafür keinen eigenen OpenAI-Schlüssel. Speicherung und Stichwortsuche laufen lokal. Abgerufene Erinnerungen werden dem verbundenen KI-Client als Kontext übergeben; siehe [Datenschutz](./PRIVACY.md#deutsch).

**Prüfstand:** Codex CLI ist für die v1.0-Integration verifiziert. Desktop und IDE sind implementiert, aber noch nicht im Feld getestet.

### Installation

```bash
npx bastra-recall install codex --vault ~/BastraVault
# nach einer globalen Installation alternativ:
bastra install codex --vault ~/BastraVault
```

Der Adapter:

1. registriert `bastra-recall` über den offiziellen Befehl `codex mcp add`;
2. installiert den Skill nach `~/.agents/skills/bastra-recall` einschließlich `agents/openai.yaml`;
3. führt Bastra-eigene Einträge in `~/.codex/hooks.json` zusammen und bewahrt fremde Einträge — Bastra-eigen ist ein Eintrag nach dem Hook-Client, den sein Befehl ausführt, nicht nach dem Namen; ein nur ähnlich benannter wird als `hooks left alone` gemeldet (#683);
4. sichert vorhandene Konfigurationen vor Änderungen und pinnt flüchtige `npx`-Runtimes;
5. aktiviert dieselbe Integration für Codex CLI, Codex IDE und ChatGPT Desktop auf diesem Host.

Beim ersten Codex-Start die angezeigten Bastra-Hooks prüfen und vertrauen (neun auf verifiziertem Codex 0.162.1, acht ohne Stop; andere Versionen behalten acht/sieben bisherige Einträge); später ist derselbe Dialog über `/hooks` erreichbar. Codex bindet Vertrauen an den exakten Hook-Hash und fordert nach inhaltlichen Änderungen erneut zur Prüfung auf. Danach ChatGPT Desktop, bestehende Codex-Sitzungen und die IDE-Erweiterung neu starten.

### Reflex-Layer

| Codex-Ereignis | Bastra-Verhalten |
|---|---|
| `SessionStart` | projektbewusster Startkontext, Konventionen und offene Hinweise; einschließlich `fork` |
| `PreToolUse: *` (nur verifiziertes 0.162.1) | einmaliges Must-load-/Reflex-Gate nach bestätigtem Schreiben des Zustands; Recall-Werkzeuge bleiben ausgenommen |
| `UserPromptSubmit` | Recall bei Lookup-, Claim- und Reflex-Signalen |
| `PreToolUse: apply_patch` | Patch-Ziele und Inhalt in die vorhandene Write/Edit-Lane normalisieren |
| `PreToolUse: update_plan` | Plan-Schritte in die vorhandene Topologie-/Todo-Lane normalisieren — braucht `tools.update_plan.enabled = true` in `~/.codex/config.toml`; seit Codex 0.152.0 ist das Planungs-Tool per Default aus, deshalb setzt `bastra install codex` den Schlüssel selbst (kommentierter Block, `bastra uninstall codex` nimmt ihn zurück; ein von dir auf `false` gesetzter Wert bleibt unangetastet) (#506) |
| `PreToolUse: Bash` | riskante oder destruktive Befehle vor Ausführung prüfen |
| `PostToolUse: Bash` | Fehlschläge und Act-Signale erfassen; beliebige Codex-JSON-Antwortwerte unterstützen |
| `PostToolUse: Recall-Schreibwerkzeuge` | bestätigte Speicherungen/Änderungen melden; `bastra install codex` erneut ausführen und den neuen Eintrag in `/hooks` bestätigen. `BASTRA_SAVE_NOTICE=0` deaktiviert ihn; ein allein fehlender Hinweis lässt gesunde Recall-Hooks aktiv. [Kompatibilität und Darstellungsgrenzen](./codex-save-notice.md#deutsch) |
| `Stop` | stille Save-Evaluation; bei `--no-stop-hook` deaktiviert |

Alle Hook-Pfade sind fail-open: Ein nicht erreichbarer Daemon darf keinen Codex-Turn blockieren. Injizierte Blöcke tragen `surface="codex"`, Telemetrie verwendet den getrennten Client-Wert `codex`. Das aktuelle Codex-JSONL-Transkriptformat wird additiv unterstützt; weil OpenAI es als instabil kennzeichnet, bleiben ältere Formate und leere Fallbacks erhalten.

### Gate-Belege und Kompatibilität (#1304)

Der Installer fragt die gewählte Codex-Datei mit `--version` ab; nach einem Codex-Versionswechsel die Installation erneut ausführen, damit der vermerkte Stand aktuell bleibt. Nur **codex-cli 0.162.1** erhält das Catch-all-Gate: [Der lokale Laufzeitversuch](https://github.com/n0mad-ai/bastra-recall/issues/1300#issuecomment-6497445090) bestätigte Deny für `exec_command` (Hook-Name `Bash`) und `view_image` sowie den SessionStart-Ursprung `fork`. Ältere, neuere, Vorab- und unbekannte Versionen bleiben bis zu einem eigenen Nachweis **nur vorbereitet**. Ihre bisherigen `additionalContext`-Hinweise bleiben aktiv; sie buchen keine offenen Must-load-IDs und versprechen keine Tool-Unterbrechung. Das ist eine strikte Beleggrenze, keine Aussage gegen die Deny-Fähigkeit anderer Versionen.

Auf 0.162.1 transportieren Node- und kompilierte Stub-Hooks neben dem Client-Marker einen installierten Versionsmarker. Nur damit verwenden Prompt-/Session-Hinweise das Must-load-Wording. Das Gate unterbricht nach bestätigtem Schreiben des Zustands einmal; der nächste Versuch geht auch ohne Laden durch. Schreibfehler, Daemon-Fehler und Zeitüberschreitungen bleiben fail-open. Eine Registrierung belegt Codex' Vertrauen nicht: `bastra install codex` erneut ausführen und **neue/geänderte Definitionen in `/hooks` erneut prüfen und bestätigen**, einschließlich SessionStart-Matcher und Hinweis-Hooks. Codex bindet Vertrauen an den exakten Definitions-Hash und überspringt unbestätigte Hooks. `bastra doctor codex` prüft Gate-Registrierung und Versionsmarker und erklärt diese Grenze.

Die Abdeckung bleibt begrenzt: `write_stdin`-Eingaben und Abfragen eines bestehenden Prozesses erzeugen keine neue PreToolUse-Grenze. Hosted WebSearch liegt [laut Dokumentation außerhalb der Tool-Hooks](https://learn.chatgpt.com/docs/hooks#tool-coverage). `apply_patch`, MCP und andere lokale Werkzeuge sind aktuell offiziell dokumentiert, wurden in #1300 aber nicht einzeln zur Laufzeit geprüft. Catch-all erfasst jedes **unterstützte** Ereignis; es erweitert die Host-Abdeckung nicht. Desktop-/IDE-Gates wurden nicht zur Laufzeit geprüft. Siehe [offiziellen Hook-Vertrag](https://learn.chatgpt.com/docs/hooks#pretooluse) und [Vertrauensregeln](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

### Statusanzeige

Während ein Hook läuft, verwendet der Adapter Codex' native, blinkende Statuszeile über `statusMessage`, zum Beispiel `Bastra Recall · loading context`, `Bastra Recall · recalling for patch` oder `Bastra Recall · evaluating memory save`. Die Meldung ist bewusst kurz und verschwindet nach dem Hook.

`bastra-codex-statusline --cmux` öffnet ein kompaktes Powerline-Panel unter der Codex-Surface: Modell, gemeldete Nutzungsfenster, Kontextbelegung, Vault-Größe und Recall-Aktivität pro Turn (Suchen, Treffer, Laden, Speichern/Bearbeiten, Laufzeit und Fehler). Ohne cmux läuft `--session <id> --watch` in einem separaten Terminal. Das Panel liest das JSONL-Transcript der ausdrücklich gewählten Sitzung und den vorhandenen Bastra-Feed. Es sendet keine Nachrichten und nimmt die Sitzung nicht selbst wieder auf. Rein paginierte Historien werden noch nicht unterstützt. [Details zur Statusline](../packages/statusline/README.md#codex-powerline-panel).

Das Panel läuft getrennt von Codex' eingebauter Fußzeile. `tui.status_line` unterstützt vorgegebene Segment-IDs; der Installer lässt diese persönliche Einstellung weiterhin unverändert. Für die ChatGPT-Desktop-App gibt es keine dokumentierte dauerhafte zweite Zeile. Diagnose bleibt über `bastra status` und `bastra doctor codex` verfügbar.

### Prüfung und Entfernung

```bash
bastra doctor codex
bastra doctor codex --fix
bastra uninstall codex
```

`doctor` prüft Codex-/ChatGPT-Erkennung, MCP-Registrierung, Forwarder, Vault, Skill, Pflicht-Hooks und Daemon. Den von Codex verwalteten Vertrauensstatus zeigt `/hooks`; der Adapter umgeht diese Sicherheitsprüfung nicht. `uninstall` entfernt nur Bastra-eigene MCP-, Hook- und Skill-Einträge; der Vault und fremde Hooks bleiben unangetastet.

Das optionale Paket unter `plugins/bastra-recall/` verteilt denselben proaktiven Skill über OpenAIs Plugin-Format. MCP, Hooks und Vault-Pfad bleiben bewusst beim CLI-Adapter, damit Plugin und Installer keine doppelten Hooks registrieren.

Offizielle Grundlagen: [MCP in ChatGPT und Codex](https://learn.chatgpt.com/docs/extend/mcp), [Codex Hooks](https://learn.chatgpt.com/docs/hooks), [Codex Skills](https://learn.chatgpt.com/docs/build-skills), [Plugin-Architektur](https://developers.openai.com/plugins/concepts/plugins).

For agent-to-agent cmux handovers, use the [marked sender](agent-messages.md) so the recipient does not capture agent prose as owner evidence.

Für Agenten-Übergaben über cmux den [markierten Sender](agent-messages.md) verwenden, damit der Empfänger Agententext nicht als Nutzeräußerung erfasst.
