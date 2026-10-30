# Rulebook / Regelbuch

Tracking: [#1336](https://github.com/n0mad-ai/bastra-recall/issues/1336), under [#1276](https://github.com/n0mad-ai/bastra-recall/issues/1276).

## Planned contract (not an implemented guarantee)

- A: `rulebook: always` delivers complete bodies within an explicit ~3k-token budget. Overflow names missing rules.
- B: `rulebook: on-demand` delivers a complete description index; overflow uses cursor pagination with catalog hash, total count and end marker. The model loads applicable bodies. Keywords and embeddings never decide membership.
- C: check evidence before mutations on verified hook hosts. Reads remain available. At most two denials per round, then allow and report a violation. Observable outages fail open and are counted. No human input is needed to unblock an autonomous run.

Delivery and check evidence are guaranteed on supported hosts. Semantic compliance only where a validator checks it. Hookless clients receive one advisory notice. Answer language remains `language.primary`.

User-directed rules bind immediately. Agent proposals and weakening await user confirmation in CLI/UI; proposals are separate from the binding catalog and hash.

## Sequence

0. Track scope, milestone, labels and rationale (complete).
1. Additive schema and projections, runtime defaults without vault migration.
2. Complete A+B delivery and pagination.
3. Bounded gate, evidence and measured host coverage.
4. Replace lexical paths after parity.
5. Invented multilingual and unattended-run verification.

Each implementation phase starts with failing tests and ends with green targeted checks, a commit on main and counter-review. No deployment in this task.

## Pattern rationale

Small always-on context plus a description index and model-loaded bodies follows [Claude Code memory](https://code.claude.com/docs/en/memory) and [skills](https://code.claude.com/docs/en/skills), [Cursor rules](https://cursor.com/docs/context/rules), [Kiro steering](https://kiro.dev/docs/steering/) and [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory). [Claude Code hooks](https://code.claude.com/docs/en/hooks) supply an action boundary. Explicit overflow makes delivery limits visible; it does not establish semantic compliance.

## Deutsch

Das Regelbuch wird schrittweise gebaut: vollständige Zustellung oder ehrliche Überlaufhinweise und begrenzte Prüfung vor Änderungen. Lesen bleibt frei, autonome Läufe bleiben ohne menschliche Eingabe arbeitsfähig. Semantische Befolgung ist nur mit passenden Validatoren prüfbar. Noch nicht umgesetzte Phasen sind keine Produktgarantie.
