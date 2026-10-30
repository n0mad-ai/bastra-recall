# Rulebook / Regelbuch

Tracking: [#1336](https://github.com/n0mad-ai/bastra-recall/issues/1336), under [#1276](https://github.com/n0mad-ai/bastra-recall/issues/1276).

## Contract and implementation status

- A: `rulebook: always` delivers complete bodies within an explicit ~3k-token budget. Overflow names missing rules.
- B: `rulebook: on-demand` delivers a complete description index; overflow uses cursor pagination with catalog hash, total count and end marker. The model loads applicable bodies. Keywords and embeddings never decide membership.
- C: check evidence before mutations on verified hook hosts. Reads remain available. At most two denials per round, then allow and report a violation. Observable outages fail open and are counted. No human input is needed to unblock an autonomous run.

The delivery stage below is implemented. Check evidence and bounded action enforcement remain for the next stage. Semantic compliance can be checked only where an appropriate validator exists. Hookless clients receive one advisory notice. Answer language remains `language.primary`.

User-directed rules bind immediately. Agent proposals and weakening await user confirmation in CLI/UI; proposals are separate from the binding catalog and hash.

## Sequence

0. Track scope, milestone, labels and rationale (complete).
1. Additive schema and projections, runtime defaults without vault migration (implemented and counter-reviewed).
2. Complete A+B delivery and pagination (implemented; counter-review pending).
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

## Complete delivery and catalog

The A+B delivery stage runs on startup, resume, clear, compact and fork in the shared Claude Code/Codex session lane. It also serves the existing tool-call re-delivery cadence. Membership comes from explicit declarations and the authorized structural defaults above; no search rank, keyword, language or embedding threshold removes a rule.

`list_rules()` is a read-only tool on search, write and full surfaces. It returns IDs, titles, delivery tiers, scope, descriptions, revisions, `catalog_hash`, `total`, `next_cursor` and `end`. Follow next_cursor until end=true, then use load_memory(id) for relevant bodies. A cursor retains the hook's project scope. If binding content changes between pages, the next result restarts at offset zero with restarted=true and a fresh hash. Proposal fields do not confer membership and are excluded from the binding hash. There is no 40-entry or top-k catalog cap; completeness is tested with 1, 18, 100 and 500 rules.

Always texts are whole, never clipped. The fixed A budget is 8,000 characters including entry headers (approximately 2,000 tokens for Latin text; tokenization varies by language). The B index uses at most 8,000 characters and shares the complete kernel's 9,400-character ceiling; any remainder is explicitly reachable through list_rules(cursor). The full session additionalContext stays below 10,000 characters, including other session sections. When those other sections would push it over the limit, they are deferred as whole sections with a notice; the complete kernel is preserved. These limits describe supported delivery, not a semantic-compliance guarantee.

An always text that is too large or whose current source cannot be read is named as overflow, with the remaining IDs available in the paged catalog. Doctor lists all affected IDs and suggests shortening or changing the tier to on-demand. The hook never claims that every always body was restored when one did not fit.

Both doctor and the context header report the total of possible legacy rules without user confirmation, across servable vault scopes. These candidates remain unbound; no file is rewritten and no confirmation is requested by the hook. A later user-facing review/confirmation command is not implemented in this stage.

The action/Stop check evidence and enforcement contract (C) remains for the next stage. Clients without hooks can read the catalog, but receive advisory guidance rather than guaranteed lifecycle injection or action enforcement.

## Deutsch: Zustellung

Always-Regeln kommen bei Start, Resume und Kontextwechsel vollständig an, soweit sie ins feste Budget passen. Zu große oder nicht lesbare Regeltexte werden ausdrücklich gemeldet; Doctor nennt alle betroffenen IDs. Der vollständige Katalog bleibt ohne Suchfilter über list_rules(cursor) erreichbar. Seine letzte Seite trägt end=true, Gesamtzahl und Hash. Ändert sich der Katalog, beginnt die nächste Antwort mit neuem Hash von vorn.

Der Hook bleibt unter der Host-Grenze. Vollständige Regeltexte werden nie abgeschnitten. Die Zahl möglicher Legacy-Regeln ohne Bestätigung steht sichtbar in Doctor und Kopfzeile; sie werden nicht automatisch übernommen. Eine spätere Sammelbestätigung in UI/CLI ist noch nicht enthalten. Aktionsprüfung und Stop-Sperre folgen erst in der nächsten Stufe.
