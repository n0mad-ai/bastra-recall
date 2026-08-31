# Bastra Recall for ChatGPT and Codex

## Deutsch

Dieses Plugin verteilt den proaktiven Bastra-Recall-Skill an ChatGPT und Codex. Der lokale MCP-Server und die nativen Hooks werden absichtlich vom transaktionalen CLI-Adapter verwaltet, damit Vault-Pfad, Runtime-Pinning, Backups und Deinstallation zuverlässig bleiben und keine doppelten Hooks entstehen.

```sh
npx bastra-recall install codex --vault ~/BastraVault
```

Beim ersten Codex-Start die sieben Bastra-Hooks prüfen und vertrauen (`/hooks`); danach ChatGPT Desktop, laufende Codex-Sitzungen und die IDE-Erweiterung neu starten. Auf demselben Rechner verwenden sie gemeinsam `~/.codex/config.toml`; der Skill liegt unter `~/.agents/skills/bastra-recall`.

## English

This plugin distributes the proactive Bastra Recall skill to ChatGPT and Codex. The local MCP server and native hooks are deliberately managed by the transactional CLI adapter so vault selection, runtime pinning, backups, and uninstall remain reliable and hooks are not registered twice.

```sh
npx bastra-recall install codex --vault ~/BastraVault
```

On the first Codex start, review and trust the seven Bastra hooks (`/hooks`), then restart ChatGPT desktop, active Codex sessions, and the IDE extension. On the same machine they share `~/.codex/config.toml`; the skill lives at `~/.agents/skills/bastra-recall`.
