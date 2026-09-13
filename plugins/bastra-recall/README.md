# Bastra Recall for ChatGPT and Codex

## Deutsch

Dieses Plugin ergänzt ChatGPT und Codex um die Bastra-Recall-Anleitung zum Speichern und Abrufen von Erinnerungen. Es benötigt den lokalen Bastra-Dienst. Richte Dienst und Hooks mit dem folgenden Befehl ein. Den aktuellen Prüfstatus findest du in der [Support-Matrix](../../README.md#unterstützte-oberflächen).

```sh
npx bastra-recall install codex --vault ~/BastraVault
```

Beim ersten Codex-Start die sieben Bastra-Hooks prüfen und vertrauen (`/hooks`); danach ChatGPT Desktop, laufende Codex-Sitzungen und die IDE-Erweiterung neu starten. Auf demselben Rechner verwenden sie gemeinsam `~/.codex/config.toml`; der Skill liegt unter `~/.agents/skills/bastra-recall`.

## English

This plugin adds Bastra Recall guidance for saving and retrieving memories in ChatGPT and Codex. It requires the local Bastra service. Set up the service and hooks with the command below. Check the [support matrix](../../README.md#supported-surfaces) for the current verification status.

```sh
npx bastra-recall install codex --vault ~/BastraVault
```

On the first Codex start, review and trust the seven Bastra hooks (`/hooks`), then restart ChatGPT desktop, active Codex sessions, and the IDE extension. On the same machine they share `~/.codex/config.toml`; the skill lives at `~/.agents/skills/bastra-recall`.

---

`skills/bastra-recall/SKILL.md` and the reference files next to it are **generated** from `packages/skill/SKILL.md` by `npm run skill:build` (#455). Edit the canonical file, not this copy; `skill-projections.test.ts` fails on a hand edit.
