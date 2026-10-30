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
1. Additive schema and projections, runtime defaults without vault migration (implemented; counter-review pending).
2. Complete A+B delivery and pagination.
3. Bounded gate, evidence and measured host coverage.
4. Replace lexical paths after parity.
5. Invented multilingual and unattended-run verification.

Each implementation phase starts with failing tests and ends with green targeted checks, a commit on main and counter-review. No deployment in this task.

## Pattern rationale

Small always-on context plus a description index and model-loaded bodies follows [Claude Code memory](https://code.claude.com/docs/en/memory) and [skills](https://code.claude.com/docs/en/skills), [Cursor rules](https://cursor.com/docs/context/rules), [Kiro steering](https://kiro.dev/docs/steering/) and [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory). [Claude Code hooks](https://code.claude.com/docs/en/hooks) supply an action boundary. Explicit overflow makes delivery limits visible; it does not establish semantic compliance.

## Deutsch

Das Regelbuch wird schrittweise gebaut: vollständige Zustellung oder ehrliche Überlaufhinweise und begrenzte Prüfung vor Änderungen. Lesen bleibt frei, autonome Läufe bleiben ohne menschliche Eingabe arbeitsfähig. Semantische Befolgung ist nur mit passenden Validatoren prüfbar. Noch nicht umgesetzte Phasen sind keine Produktgarantie.

## Schema stage

Optional fields are `rulebook: always|on-demand`, `applies_when` (a nonblank description in any language) and `rulebook_proposed: {rulebook, applies_when}`. A new declaration sent to save_memory requires the description; loading an older note without it falls back to its summary. Ordinary refreshes preserve these fields.

Runtime defaults require `write_origin: user-directed`, without modifying notes. Within that set, active conventions and floors default to always; user-preference, meta-working and reflex default to on-demand. No other legacy membership is inferred. Explicit declarations take priority. Obsolete and superseded notes are excluded. Session/floor membership is supplied by the caller, never guessed from words. Recall, hook and load share the same current-source reader and context snapshot. A summary fallback is marked `applies_when_derived: true` in responses; this marker is not persisted. Mixed direct metadata and `rulebook_proposed` edits are rejected.

New user-directed declarations bind as metadata immediately. Other new declarations and edits to existing binding metadata become a separate proposal, preserving the effective declaration. This schema stage does not implement the full authority lifecycle for body edits, archive/supersession or user confirmation surfaces; those must be completed before enforcement is advertised. It does not change the existing rule kernel, gates or host guarantees.

Known limitation before the confirmation UI exists: even an explicitly user-directed save changing an existing binding declaration is staged as a proposal. MCP currently cannot confirm that proposal; see #1336.
