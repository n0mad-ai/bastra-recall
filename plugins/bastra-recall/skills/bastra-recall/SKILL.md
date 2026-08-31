---
name: bastra-recall
description: Proactive private local memory for ChatGPT and Codex. Use Bastra Recall before answering questions about the user's past, preferences, documents, decisions, projects, or recurring problems; before editing or planning in an established codebase; and when a durable rule, decision, preference, or hard-won lesson should be retained. Requires the local bastra-recall MCP server installed by `bastra install codex`.
---

# Bastra Recall

Treat the `bastra-recall` MCP server as your long-term memory. The user should not need to remind you to search it.

## Recall before acting

Call `recall` before acting on a task when durable preferences, lessons, decisions, project topology, or past facts may matter. For direct personal or historical lookup requests, use `recall` and `find_document` before conversation or web search. Load only relevant candidates with `load_memory` or `read_document`; do not batch-load every result.

Before editing an established area or creating a multi-step plan, recall the project name, feature area, likely files, architecture, and past decisions. Before publishing a number, date, measurement, or project-history claim, verify it in the vault; if the vault does not answer, say that you do not know rather than guessing.

## Capture durable signals

Use `save_memory` without asking when the user states a lasting rule or preference, confirms a workflow, finalizes an architectural decision, corrects a recurring behavior, marks something important, or a difficult recurring failure is solved. Also capture the file map when a coherent multi-file feature or subsystem has genuinely landed.

Do not save one-off tasks, tentative ideas, secrets without a clear durable need, or facts trivially derivable from current code and git history. Recall the topic before saving; overwrite a near-duplicate or use `replaces` when a fact changed. After saving, acknowledge it in one short line.

The MCP tool descriptions are authoritative for score bands, field quality, admission rules, and overwrite mechanics.
