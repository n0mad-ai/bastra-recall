# Rulebook / Regelbuch

Tracking: [#1336](https://github.com/n0mad-ai/bastra-recall/issues/1336), under [#1276](https://github.com/n0mad-ai/bastra-recall/issues/1276).

## Contract and implementation status

- A: `rulebook: always` delivers complete bodies within an explicit ~3k-token budget. Overflow names missing rules.
- B: `rulebook: on-demand` delivers a complete description index; overflow uses cursor pagination with catalog hash, total count and end marker. The model loads applicable bodies. Keywords and embeddings never decide membership.
- C: check evidence before mutations on verified hook hosts. Reads remain available. At most two denials per round, then allow and report a violation. Observable outages fail open and are counted. No human input is needed to unblock an autonomous run.

A+B delivery and bounded C checking are implemented; Phase 3 awaits counter-review. Semantic compliance can be checked only where an appropriate validator exists. Hookless clients receive one advisory notice. Answer language remains `language.primary`.

User-directed rules bind immediately. Agent proposals and weakening await user confirmation in CLI/UI; proposals are separate from the binding catalog and hash.

## Sequence

0. Track scope, milestone, labels and rationale (complete).
1. Additive schema and projections, runtime defaults without vault migration (implemented and counter-reviewed).
2. Complete A+B delivery and pagination (implemented and counter-reviewed).
3. Bounded gate, evidence and measured host coverage (implemented; counter-review pending).
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

The action/Stop check evidence and bounded enforcement contract (C) is implemented with the host limits below. Clients without hooks can read the catalog, but receive advisory guidance rather than guaranteed lifecycle injection or action enforcement.

## Deutsch: Zustellung

Always-Regeln kommen bei Start, Resume und Kontextwechsel vollständig an, soweit sie ins feste Budget passen. Zu große oder nicht lesbare Regeltexte werden ausdrücklich gemeldet; Doctor nennt alle betroffenen IDs. Der vollständige Katalog bleibt ohne Suchfilter über list_rules(cursor) erreichbar. Seine letzte Seite trägt end=true, Gesamtzahl und Hash. Ändert sich der Katalog, beginnt die nächste Antwort mit neuem Hash von vorn.

Der Hook bleibt unter der Host-Grenze. Vollständige Regeltexte werden nie abgeschnitten. Die Zahl möglicher Legacy-Regeln ohne Bestätigung steht sichtbar in Doctor und Kopfzeile; sie werden nicht automatisch übernommen. Eine spätere Sammelbestätigung in UI/CLI ist noch nicht enthalten. Die begrenzte Aktionsprüfung und Stop-Kontrolle sind mit den unten genannten Host-Grenzen umgesetzt.


## Round check and bounded action/Stop control

`rulebook_check({applicable: ["rule-id"]})` records the agent's honest self-report for the current session, context generation and prompt round. `applicable: []` means no rule applies. It is available on every MCP surface, including search. This is not a complete-catalog protocol or an action-bound proof. Bastra does not classify prompt meaning or validate the applicability judgment. A successful full `load_memory` of a binding rule in this round also supplies evidence for a known caller session; a missing actor ID defaults to main; an explicit lean dismissal, an old load, a stale cached body, a different session or a hint does not. A check without a transport session may supply the exact hook `session_id`; a known transport session takes precedence. A subagent must supply its own `agent_id` to keep its receipt separate. A Claude Code subagent omitting that ID cannot be distinguished from main; these self-reports are not authenticated worker isolation. Codex hook events without agent_id use the main actor of their own session; separate Codex threads have separate sessions. Unmarked, unattributed hook calls cannot inherit a main-thread receipt and retain the bounded fail-open fallback. Explicit worker loads are not main-thread receipts.

The catch-all PreToolUse lane applies C when the scoped rulebook is nonempty. C does not deny known read tools, Bastra's read/check tools or simple syntactically read-only shell commands. Until Phase 4, existing legacy must-load/reflex rules can still interrupt readers under their original finite claim rules. Bastra writing tools now participate, including plugin/canonical server spellings. Unknown MCP schemas, dynamic shell commands and opaque programs cannot be certified read-only; they are treated as potentially mutating, without guessing which rule applies. The effect classifier is a technical allowlist, not a language/intent classifier. It cannot prove the effects of arbitrary executables or shell startup configuration. Existing pending-must-load and action-reflex lanes remain active until Phase 4, including after a successful rulebook check. They remain independent of C's two-attempt round allowance: pending hints interrupt once per booked claim, reflex rules once per rule/session. Exhausting C cannot spend or suppress those claims. A timed-out undelivered denial leaves the legacy claim available. Known reads bypass C catalog work except when periodic context delivery is due. Both old and new reasons are collected in the same call, consuming one C attempt when C also denies.

Before the first potentially mutating action, missing evidence causes at most **two C denials per actor/round**. After that, actions pass and each unchecked observation is audited. A new prompt expires the receipt and resets denial counts; compact/clear/fork creates a fresh context generation. No question, approval or endless retry is introduced. Bastra failure is fail-open. The hook client and daemon spool observable failures locally; the next prompt reports the pending unchecked observations. Counters describe observations and can overlap when a timeout is seen by both client and daemon. Storage failure itself is observable only as far as local storage remains usable.

For every nonempty rulebook, including always-only catalogs, the prompt hook adds a short factual reminder before the answer, including a ready-to-use `rulebook_check` example with its exact `session_id` (and `agent_id` when supplied). Claude Code and version-verified Codex Stop lanes check evidence even for a response with no tools, without interpreting the pasted message. Missing evidence returns `decision: block` **once per actor/round**, asking the model to load applicable rules/revise or call `rulebook_check` with no applicable IDs. Further Stops log a violation and continue. The existing independent artifact-validation repair remains in place. Stop continuation does not guarantee that the initial answer was hidden before display. Codex CLI 0.162.1 Stop block/continuation and continue:false precedence are runtime-verified by the local scripted-provider probe. Stop checking is enabled only for that exact Codex version and requires the Stop hook to be installed; Desktop, IDE and other versions remain uncertified. Deferred harvest and save evaluation run exactly once on the continuation. [Runtime observations](rulebook-host-probes.md) distinguish observed boundaries from verified denial; the [host matrix](../packages/daemon/src/host-capabilities.ts) retains per-tool limits.

The checked/deny/unchecked audit rows contain IDs and counters, not prompt or artifact text. The first hookless forwarder context includes an explicit advisory notice. Hooks do not change user authority or implement the still-outstanding rule confirmation/body-edit/archive lifecycle; this stage guarantees checking at covered boundaries, not immutable rule content or semantic compliance.

## Deutsch: Prüfung

Der Agent prüft den Index selbst und lädt passende Regeln oder meldet mit `rulebook_check({applicable: []})`, dass keine passt. Der Beleg gilt nur für diese Runde und diesen Kontext. Vor Änderungen wird ohne Beleg höchstens zweimal abgelehnt, danach läuft die Aktion mit Verstoßmeldung weiter. C sperrt bekannte Lesewerkzeuge nicht; bis Phase 4 bleiben die bisherigen Legacy-Unterbrechungen mit ihren bisherigen einmaligen Claims unabhängig von der C-Begrenzung erhalten; unbekannte Werkzeug-Schemas und opake Programme gelten vorsorglich als möglicherweise verändernd. Eine vollkommene Seiteneffektanalyse wird nicht behauptet.

Claude Code und die belegte Codex CLI 0.162.1 halten auch eine reine Textantwort ohne Beleg einmal am Stop an. Der Agent kann die Prüfung selbst erledigen, ohne den Nutzer zu fragen. Codex-Stop ist nur für die exakt geprüfte CLI-Version und einen eingerichteten Stop-Hook belegt. Ungeprüfte MCP-Schreibsperren und fortgesetzte Prozesse bleiben ausdrücklich außerhalb der Garantie. Ausfälle und Durchläufe ohne Beleg werden beim nächsten Prompt sichtbar gemeldet, soweit die lokale Speicherung funktioniert. Antworten und Hinweise richten sich nach `language.primary`; das Regelbuch entscheidet nicht über die Antwortsprache.


## Catalog cache and actor attribution

The shared catalog is cached per vault index generation, project scope, active membership and floor configuration. Vault change events invalidate cached pages and in-flight reuse; cursor hashes still restart changed catalogs. Third-party indexes without change notifications use the uncached source check. A 2-second TTL also triggers a source reread and staleness recomputation when cloud watchers miss changes to indexed files. Newly created files still require index discovery. A cache hit does not reparse every source; it is not a fresh filesystem privacy audit on every hook invocation.

The forwarder uses the Claude Code statusline session and ignores inherited `CODEX_THREAD_ID`, which can belong to a launching foreign host. No Codex MCP load-to-session attribution is certified by this adapter: Codex uses `rulebook_check` with the session from the prompt/hook. No Codex `env_vars` forwarding support is assumed. REST transports may carry `x-bastra-agent-id` (main or an explicit worker ID); missing actors default to main for normal loads and checks. Explicit workers stay separate. A missing statusline alone does not establish missing hook support. Other Codex versions remain uncertified. See [probe details and attribution limits](rulebook-host-probes.md).


The action C stage has its own short deadline (150 ms under the default 500 ms gate budget), so catalog errors or slowness do not suppress legacy gates. Undelivered C action reservations are released after timeouts or later gate-write failures, guarded by actor/context/round; recovery still depends on usable state storage. The forwarder's process walk stops at a nearer Codex host instead of borrowing a launching Claude host's feed. See the [primary-source review of Gate versus MCP subagent identity](rulebook-host-probes.md#claude-subagent-identity-gate-versus-mcp-load): hook agent IDs are available, while automatic per-call worker attribution on the shared MCP load connection is not established.

Deutsch: Fehler oder langsame Dateizugriffe bei der neuen Prüfung dürfen die alten Unterbrechungen nicht verhindern. Nicht ausgegebene C-Ablehnungen geben ihr Kontingent wieder frei, soweit die Zustandsablage funktioniert. Bei Unteragenten bleibt die Grenze zwischen Hook und Laden wichtig: Der Hook kennt die Agentenkennung; die gemeinsam genutzte MCP-Verbindung liefert sie nicht nachweislich automatisch je Ladevorgang.


The shared catalog wait is now bounded on Prompt, Stop, session-context and periodic delivery as well as action C. Expired/cold reads must finish within 150 ms or the lane treats that rulebook stage as unavailable and preserves older work. Pending builds coalesce; expired metadata is not served as a stale fallback. Unavailable periodic rule context retries on the next tool call. The real gate HTTP route confirms denial and context delivery separately; aborts restore legacy/C claims and keep context due. C rollback runs outside response latency and logs failed persistence. These are local transport/state observations, not model-reading proof.

Deutsch: Ein langsames Regelbuch verhindert weder die bisherigen Prompt-Hinweise noch Stop-Reparatur und Harvest. Ausgefallene regelmäßige Regelzustellung bleibt für den nächsten Aufruf vorgemerkt. Der Gate-Endpunkt bestätigt Sperren und Kontext getrennt; bei einem beobachteten Abbruch vor Ausgabe bleibt der Versuch verfügbar. Das Zurückrollen wartet nicht im Antwortweg auf die Zustandsablage. Deren Ausfall und ein Abbruch nach bereits beendetem Serverversand bleiben Beobachtungsgrenzen.
