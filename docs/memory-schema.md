# Memory Schema

This schema defines one stored memory or document sidecar. Files are plain markdown with YAML frontmatter so they remain editable in Obsidian and by hand.

The schema supports:

1. autonomous saves when a durable lesson, preference, workflow, decision, or project fact is learned;
2. pre-action recall through `recall_when`;
3. cross-project reuse through scope, tags, topics, wikilinks, and `related_via`;
4. document and bookmark retrieval through the same vault/search layer;
5. local privacy controls through `sensitivity`.

## Storage Layout

The configured vault root comes from `BASTRA_VAULT_PATH` (legacy `NEXUS_VAULT_PATH` is accepted).

The vault scanner walks recursively and loads any `.md` file whose frontmatter has a recognized `type`. Ordinary Obsidian notes can live next to memories and are ignored.

Current write routing:

| Kind | Folder |
|---|---|
| user preferences | `memories/user/` |
| all-project memories | `memories/all-projects/` |
| project-scoped memories | `memories/projects/<scope>/` |
| bookmarks | `bookmarks/` |
| document sidecars | `dokumentationen/<scope>/` |

Legacy flat vaults still load because scanning is recursive and does not require files to be under those folders.

The active text index is in-memory MiniSearch/BM25. Optional embeddings are stored at `<vault>/.bastra/embeddings.json`. Audit logs and trash are stored under `<vault>/.bastra/`.

## Minimal Frontmatter

All normal memories and document sidecars share these required fields:

```yaml
---
id: css-input-focus-ring-stacking
title: "Don't stack focus styles on inputs"
type: lesson
summary: "Stacking ring + outline + custom :focus on nested inputs causes double focus rings. Use a single :focus-visible style."
topic_path: [css, input, focus]
tags: [css, input, focus-ring, ui-bug]
scope: all-projects
recall_when:
  - creating new input component
  - writing input or form css
  - focus or accessibility styling
related: [css-effects-stacking-antipattern]
related_via: []
sensitivity: team
source: "carnexus, recurring lesson"
confidence: 0.95
created: 2026-04-15
updated: 2026-05-01
---
```

The markdown body follows the frontmatter. For lessons, lead with the rule, then explain why it matters and how to apply it.

## Core Fields

| Field | Required | Meaning |
|---|---:|---|
| `id` | yes | Stable slug. Usually filename without `.md`. |
| `title` | yes | Human-readable title shown in recall hits. |
| `type` | yes | Memory/document kind. See type table below. |
| `summary` | yes | One dense sentence, max 400 characters. |
| `topic_path` | yes | Hierarchical topic path, e.g. `[bastra-recall, search, ranking]`. |
| `tags` | yes | Flat retrieval tags. At least one. |
| `scope` | yes | Applicability boundary, e.g. `all-projects`, `user-preference`, or a project name. |
| `recall_when` | yes | Concrete future contexts where this memory should surface. |
| `recall_when_expanded` | no | Machine-generated doc2query paraphrases of the triggers (#117), indexed at a lower weight. Written by the `TriggerExpander`; absent until expanded. |
| `recall_when_expanded_src` | no | Short hash of the source fields the paraphrases were derived from; the expander regenerates only when it changes. |
| `related` | no | Manual related memory ids. Body wikilinks are mirrored here by the save path. |
| `related_via` | no | Automatic related edges from embedding similarity. Defaults to `[]`. |
| `sensitivity` | no | `private`, `team`, or `public`. Defaults to `team`. |
| `source` | no | Provenance or reason this memory exists. |
| `confidence` | no | Number from `0` to `1`. Defaults to `1.0`. |
| `created` | yes | ISO date. Auto-set by save paths. |
| `updated` | yes | ISO date. Auto-set by save/update paths. |

## Types

Recognized `type` values:

| Type | Meaning |
|---|---|
| `lesson` | Anti-pattern or correction learned from failure |
| `preference` | Stable project-scoped or working preference |
| `project-fact` | Stable fact about a project or feature area |
| `meta-working` | Durable fact about how the assistant should work |
| `decision` | Committed design/product/architecture decision |
| `workflow` | Repeatable process or checklist |
| `reference` | Pointer to an external or internal resource |
| `user-preference` | Cross-project user preference |
| `bookmark` | Saved URL with bookmark metadata |
| `doc` | Document sidecar for file/document retrieval |

## Recall Fields

`recall_when` is the most important retrieval field. It is boosted above title, tags, topic path, summary, and body in the MiniSearch index. If embeddings are enabled, the same authored text also contributes to semantic recall because it is included in the embedding text.

`recall_when_expanded` (doc2query, #117) holds LLM-generated paraphrases of the triggers in *different* words, so a reworded query weeks later still fires on the lexical layer without any query-time model cost. A local Ollama model generates them offline at write time (and backfills existing memories); only paraphrases that retrieve their own memory in a self-test are kept. They are indexed below the hand-written `recall_when` (weight 2 vs 5). The feature is on by default when Ollama is the embedding provider; set `BASTRA_TRIGGER_EXPAND=0` to disable it.

Good values describe future actions:

```yaml
recall_when:
  - creating new input component
  - writing input or form css
  - focus or accessibility styling
```

Weak values are generic:

```yaml
recall_when:
  - css
  - frontend
```

The current matching stack is BM25 with prefix/fuzzy search, optionally fused with vector search through Reciprocal Rank Fusion. It is not SQLite/FTS5.

**Keep phrases short — the reflex lane matches token-AND.** For ordinary recall the phrases are scored, so a long one still contributes. For the reflex lane (`recall_mode: reflex`, see below) they are *matched*: `phraseMatchesContext` (`packages/daemon/src/reflex.ts:71`) requires **every** content token of the phrase — everything ≥ 3 characters that is not a stopword — to be present in the prompt. No prefix, no fuzzy. A sentence-length `recall_when` entry is therefore a dead reflex trigger: the prompt would have to contain all of its words. Three to six content words is the working range.

The stopword list that softens this (`PHRASE_STOPWORDS`, `reflex.ts:40`) covers **German and English only**. In another language the function words are not recognised as function words, which cuts both ways: a phrase of common words has no stopwords removed, so it becomes a scatter trigger that fires whenever those everyday words happen to co-occur. Authoring reflex triggers in a third language means leaning on distinctive terms — names, identifiers, domain nouns — rather than on phrasing.

## Relationships

`related` is a manual list of memory ids. The save path also extracts `[[memory-id]]` wikilinks from the body and mirrors them into `related`, excluding links in the auto-related section.

`related_via` is maintained by the optional `RelatedEnricher`:

```yaml
related_via:
  - id: css-effects-stacking-antipattern
    reason: "cosine 0.812"
    score: 0.812
```

When recall is called with `expand_hops: 1`, one-hop `related_via` neighbors can be added to the result set with a reduced score.

The auto-related body section is managed between marker comments:

```markdown
## Auto-Related <!-- bastra:auto-related:start -->

- [[css-effects-stacking-antipattern]] (cosine 0.81)

<!-- bastra:auto-related:end -->
```

Do not manually edit inside that section.

## Lifecycle And Ranking Fields

These optional fields affect staleness and recall ranking:

| Field | Meaning |
|---|---|
| `valid_until` | Explicit ISO date after which the memory expires |
| `expires_after_days` | Override for type-based expiration defaults |
| `last_reviewed_at` | ISO date of the last manual review |
| `stale_status` | Optional persisted status: `fresh`, `aging`, `stale`, `expired` |
| `obsolete` | If true, the memory is filtered out of normal recall |
| `replaces` | Memory id this one is the new version of — settable via `save_memory` |
| `superseded_by` | Newer memory that supersedes this one — stamped by the daemon, never by a caller |
| `siblings` | Memory ids this one deliberately stands beside — set via `save_memory`'s `sibling_of` |

Staleness is computed lazily during recall. Stale and expired memories are downranked; obsolete memories are removed from normal search results.

### Verification anchor (#235)

`verify_cmd` is an optional command that could prove what a memory claims —
`test -f packages/daemon/src/reflex.ts`, `curl -s localhost:6723/health`. It
exists because `project-fact` memories assert states of the world, and exactly
those age silently into false statements that keep being recalled as true.
Calendar staleness and the curator's usage windows are both blind to content
truth; an anchor is not.

**Nothing executes it.** Not the daemon, not the curator, not a hook. It is
stored, and `load_memory` shows it alongside a hint. Whoever loads the memory
decides, under their own permission rules. That is what keeps this stage free of
new attack surface.

Two properties of the wording are deliberate, because the field carries a
command: the hint states that the command comes out of vault *content* rather
than from bastra, so it is data to be judged and not an instruction to follow;
and it defers explicitly to the session's permission rules. The import path
cannot introduce an anchor — `mapFile` builds memories from a fixed field list,
so a foreign vault's frontmatter never reaches the field. What remains is a file
placed into the vault by hand, which is the same trust boundary as the memory
body itself.

A failed anchor as a *staleness signal*, three-verdict discipline
(confirmed / refuted / unverifiable) and drift-binding to a source block are
stage 2 and need their own security round.

### Supersession (#164)

`replaces` and `superseded_by` are the two halves of one directed edge. Passing
`replaces: <id>` to `save_memory` writes the forward half on the new memory and
stamps the backward half onto the predecessor.

**The predecessor stays in the living vault.** It is not moved to the trash, not
dropped from the index, and not marked `obsolete`. It keeps resolving by its id,
so older citations keep working, and `load_memory` on it reveals that a newer
version exists. This is deliberately *not* what `archive_memory` does — that
retires a memory and removes it from the active index. Per the V1→V2 architecture
contract (C-059), historicity comes from the version status, never from a change
of location: a predecessor that gets moved away is not historical, it is gone.

The edge currently carries **no ranking effect**. A superseded memory ranks
exactly as it did before. The accessibility projection that will read this edge —
and the Historical zone it feeds — begins as a read-only projection in V1.x, and
its weights are an M3 decision (§7.1 of the evolution contract). This stage
produces the data so that the projection has something to read when it arrives;
it does not pre-empt the decision about what to do with it.

Save refuses a `replaces` that points at a nonexistent memory, or at the memory
being saved, before writing anything.

### The claim gate (#360)

Two memories that declare the same situation both answer that cue, and recall
has no way to say which one is meant. Before the gate, that happened silently:
the trigger-collision advisory (#300) warned at save time but decided nothing,
the write went through, and afterwards nobody looked again.

A save is now **held** when one of its `recall_when` phrases is fully contained
in an existing memory's trigger — every content word of the incoming phrase
already appears in theirs. Nothing is written, and the result carries
`claim_gate.claimed` naming the memory that got there first, both triggers, and
the save's `save_quality` advisory.

The threshold is full containment and nothing softer. The 0.80–0.99 similarity
band mixes genuine restatements with templated triggers whose only distinguishing
word is a proper noun, and no number separates the two classes (#325) — so the
boundary is a property of the measure rather than a value someone picked.

Two memories declaring one situation are exactly one of three things, and the
daemon adjudicates none of them:

| Answer | Field | Meaning |
|---|---|---|
| Successor | `replaces: <id>` | One chain — the older wording is out of date |
| Contradiction | `conflict_with: <id>` | Both current, incompatible; diverted into a conflict block (#205) |
| Siblings | `sibling_of: [<id>]` | Several entities, permanently valid at once |

A fourth way out is narrowing the save's own trigger until it no longer claims
the other's situation.

#### Does the text add anything?

Naming the collision is not enough to act on. A second memory on one cue that
says nothing new is a save to **drop**; one carrying a new fact is an **edit to
the first**. Those are opposite actions, so the refusal carries what is needed
to tell them apart, without a second roundtrip:

| Field | What it holds |
|---|---|
| `existing_body` | The colliding memory's authored text (excerpt past 2000 chars) |
| `delta.covered` | 0–1, share of the incoming body's content words already present |
| `delta.new_terms` | The content words that would be added, in order |

The auto-related block and any conflict block are stripped first — they are
machine-appended, and their wikilinked ids would otherwise show up as
vocabulary the author never wrote.

There is **no threshold** on `covered`. Prose never reaches 1.0: one stray
filler word the other memory happens not to use drags a verbatim restatement to
0.83, so any cut would be a number picked to make a fixture pass. An empty
`new_terms` is a fact rather than a threshold, and a list of two filler words
tells the agent as much as a score would.

`covered` is vocabulary only. It cannot see that *"we use Postgres"* and *"we
use MySQL"* are opposites — that is the agent's reading, and the contradiction
path is where it lands. What the measure provides is the cheap half: the words
the text would add, so the agent only reads closely when there is something to
read.

**Cost.** Measured on a 982-memory vault: 0.000 ms when nothing collides (the
comparison never runs), 0.184 ms when something does — against the 3.0 ms
`save_quality` already spent before any of this existed, so 5.7% of the save
path in the rare case and nothing in the common one. The curator sweep is
23 ms, once per pass, in idle.

`sibling_of` lands in the `siblings` frontmatter list, **merged** with whatever
the file already carries — quittances accumulate, and an empty list clears
nothing. It is recorded on one side only; the curator checks both directions, so
a second stamp would buy nothing and cost a write into a file the save never
touched.

Answers are subtracted **per id**: a save that supersedes A and also collides
with B has answered for A only, and is still held for B.

`overwrite=true` is never gated — an overwrite names its target, which is itself
an answer, and re-saving a memory must not be blocked by its own triggers.

Pairs that predate the gate are found by the curator and listed in REPORT.md
under *Claimed twice*; the human decides there and nothing is mutated.

### Valence And Reflex Fields (#217)

Optional fields modelling the human-memory axes *feeling* and *reflex*:

| Field | Meaning |
|---|---|
| `salience` | `0`–`1`: how emotionally charged the capture moment was. High salience slows aging (effective expiration days × `1 + salience`) and may rank higher — the ranking multiplier runs shadow-only by default and goes live only via `BASTRA_SALIENCE_RANK=live` after a measured lift (`salience-lift` eval). |
| `emotion` | Tone of the capture moment: `frustration`, `success`, `risk`, `neutral`. Drives the capture rules and tints the glow core in the vault map. |
| `recall_mode` | `reflex` or `deliberate` (absent = `deliberate`). Reflex memories may self-inject — budgeted, max 2 per turn — when one of their `recall_when` phrases hard-matches a prompt (deterministic token match, no fuzzy scoring). Set `reflex` ONLY after the user explicitly confirmed a promotion; the curator proposes candidates via the pending-suggestions relay, it never wires them itself. |

Capture rules: frustration signals ("schon wieder", emphatic caps) → `emotion: frustration`, `salience: 0.8`; a hard-won fix after >2 iterations → `emotion: success`, `salience: 0.7`; explicit user marking ("merk dir das gut") → `salience: 0.9`. Omit all three fields for routine saves — never invent them. On overwrite without these fields, existing values are preserved (same rule as `write_origin`).

## Privacy Field

`sensitivity` controls which callers can see a memory:

| Value | Meaning |
|---|---|
| `private` | Hidden from external MCP/REST callers unless `allow_private: true` |
| `team` | Default; visible to local AI tools |
| `public` | Safe for broader cross-surface exposure |

Both recall and direct load paths enforce this filter.

## Augmentation Fields

General optional fields:

| Field | Meaning |
|---|---|
| `affects_files` | Repo paths this memory applies to |
| `status` | Free-form state such as `stable`, `in-progress`, `planned`, `open` |
| `issues` | Related issue ids such as `#42` |

Bookmark-only fields:

| Field | Meaning |
|---|---|
| `url` | Saved URL |
| `categories` | Bookmark categories |
| `read_status` | `unread`, `read`, or `archived` |
| `og_image` | Open Graph image URL |
| `saved_at` | ISO timestamp |
| `source_app` | App/source that saved the bookmark |

Document-only fields:

| Field | Meaning |
|---|---|
| `original_path` | Original file path for the document |
| `linked_file` | If true, original remains outside the vault |
| `document_category` | `vertrag`, `rechnung`, `notiz`, `code`, `bild`, or `sonstiges` |
| `folder_path` | Folder path used by document tools |
| `needs_review` | Auto-inbox review flag |
| `ai_suggested_folder` | Suggested target folder for review UI |
| `content_hash` | SHA-256 content hash for duplicate detection |
| `content_size` | Original file size in bytes |
| `location` | Optional geo metadata: `{ lat, lon, place?, source? }` |

## Body

Recommended body for lessons:

```markdown
## Rule
State the rule or fix directly.

## Why
Explain the failure path and root cause.

## How to apply
Name the future situation where this should change behavior.

## See also
[[other-memory-id]]
```

Document sidecars usually store a short pointer to the original file plus extracted text:

```markdown
> Sidecar for `/path/to/original.pdf`.

## Extracted content

...
```

## Examples

### Lesson

```yaml
---
id: css-input-focus-ring-stacking
title: "Don't stack focus styles on inputs"
type: lesson
summary: "Stacking ring + outline + custom :focus on nested inputs causes double focus rings. Use single :focus-visible, no extra ring/outline."
topic_path: [css, input, focus]
tags: [css, input, focus-ring, ui-bug, antipattern]
scope: all-projects
recall_when:
  - creating new input component
  - writing input or form css
  - focus or accessibility styling
related: []
related_via: []
sensitivity: team
source: "recurring UI bug"
confidence: 0.95
created: 2026-04-15
updated: 2026-05-01
---
```

### User Preference

```yaml
---
id: pref-plan-format-recommendation-not-options
title: "Prefer recommendations over option menus"
type: user-preference
summary: "When proposing a plan, give one recommendation, the main tradeoff, and at most one follow-up question."
topic_path: [user, communication, planning]
tags: [communication, plans, decisions]
scope: user-preference
recall_when:
  - proposing a plan
  - presenting options
  - architectural decision request
related: []
related_via: []
sensitivity: team
confidence: 1
created: 2026-05-01
updated: 2026-05-01
---
```

### Bookmark

```yaml
---
id: mcp-spec-bookmark
title: "Model Context Protocol specification"
type: bookmark
summary: "Reference bookmark for the MCP specification."
topic_path: [references, mcp]
tags: [mcp, protocol, reference]
scope: all-projects
recall_when:
  - checking MCP protocol details
related: []
related_via: []
sensitivity: public
url: "https://modelcontextprotocol.io/"
categories: [ai, protocol]
read_status: unread
saved_at: 2026-05-01T12:00:00.000Z
confidence: 1
created: 2026-05-01
updated: 2026-05-01
---
```

### Document Sidecar

```yaml
---
id: doc-contract-2026
title: "Contract 2026"
type: doc
summary: "vertrag: Contract 2026"
topic_path: [documents, contracts]
tags: [contract, 2026]
scope: documents
recall_when:
  - find document Contract 2026
  - contract 2026
related: []
related_via: []
sensitivity: team
original_path: "/Users/example/Documents/Contract 2026.pdf"
linked_file: false
document_category: vertrag
folder_path: contracts
confidence: 1
created: 2026-05-01
updated: 2026-05-01
---
```

## Validation Rules

The current Zod schema rejects files that have a recognized memory `type` but invalid frontmatter. Required validations include:

- non-empty `id`, `title`, `summary`, `scope`;
- `summary` length at most 400 characters;
- recognized `type`;
- non-empty `topic_path`, `tags`, and `recall_when`;
- `confidence` between `0` and `1`;
- valid enum values for `sensitivity`, `read_status`, and location source when present;
- positive integer lifecycle overrides where required.

Files without a recognized `type` are treated as ordinary notes and skipped, not as schema failures.

The save path rejects duplicate ids at the destination path unless `overwrite: true` is passed. It does not require `scope` to come from a registry.

`overwrite: true` permits an update; it does not give a stale writer permission to replace a newer file. `saveMemory` compares the target again under an exclusive per-path commit claim. Concurrent or stale saves fail with `MemoryWriteConflictError` (`code: "BASTRA_WRITE_CONFLICT"`) and must retry from the current file. Callers that inspect provenance or ownership before saving pass the approved raw file as `expectedTarget` (`null` for a confirmed-absent target), extending the same comparison back to that inspection. See [Architecture: Write commit contract](./architecture.md#write-commit-contract).

## Compatibility Promise (1.0)

From 1.0 on, this schema is under a stated compatibility promise. The package version carries the contract.

**Stable across all 1.x releases**

- Markdown with YAML frontmatter stays the source of truth; files remain editable in Obsidian and by hand.
- The ten required fields keep their name, type, and meaning: `id`, `title`, `type`, `summary`, `topic_path`, `tags`, `scope`, `recall_when`, `created`, `updated`.
- The recognized `type` values stay valid and keep their meaning.
- The documented optional fields keep their name and meaning. Their absence stays legal and keeps its documented default.
- `id` stays the stable key; a memory keeps resolving under the id it was written with.
- **No 1.x reader requires a format-version field in frontmatter.** A file that carries none is fully valid, today and in every later 1.x release. Whether such a field is added later is left open; it would be optional and never a load requirement.
- Loader leniency is part of the promise, not an implementation detail: missing required fields are repaired from filename, body, and mtime; a frontmatter block that does not parse as a whole is rescued entry by entry; an invalid *optional* field is dropped rather than costing the node; unknown keys are ignored, not rejected; an over-long `summary` is clamped on load. Repairs are in-memory and are never written back — the file on disk stays as you wrote it. Tightening any of this is a breaking change, not a bug fix.
- A file with no recognized `type` stays an ordinary note and is skipped.
- A vault written by any 1.x release stays readable by every later 1.x release, with no migration step.

**Unknown keys: read, and carried through a re-save**

Unknown frontmatter keys are tolerated on **load** — they never cost a memory its place in the index. Since 29 August 2026 a `save_memory` with `overwrite: true` also carries them through: the save path still rebuilds frontmatter from its known field list, and appends every key it does not manage itself, unchanged. The fields it does manage keep their own rules and win any name collision.

This is behaviour, not a guarantee. The schema promise still covers reading unknown keys, not preserving them across every write — other paths write into a vault, and a later one may not carry them. Hand-added data that must survive under all circumstances still belongs in the body.

**Not covered by the promise**

- Ranking, hit order, scores, staleness curves, and trigger weights. These change in minor and patch releases.
- The shape of `recall` output. It is not part of the *schema* promise; it falls under the API contract, which follows the same SemVer rules — bound, but elsewhere.
- Machine-written projections — `recall_when_expanded`, `recall_when_expanded_src`, `related_via`, `superseded_by`, `stale_status`, `injection_flags`, and the in-memory `damaged` annotation. The field names and their rough meaning are covered; their content, their computation, and when they get written are not.
- Everything under `<vault>/.bastra/` — embeddings, audit log, trash, and any later projection. Internal storage, free to change.
- The write-routing folders under `memories/`. Scanning is recursive, so these are a convention for new writes, not a load requirement. Routes may change; the readability of existing layouts may not.

**Breaking (major bump)**

Removing, renaming, or retyping a required field; removing a `type` or changing what it means; removing or reinterpreting a documented optional field; tightening the loader so that a file which used to load no longer loads; breaking id resolution; or requiring a migration without which an existing vault no longer loads.

**Additive (minor bump)**

New optional fields, always tolerant of absence; new `type` values; more loader leniency; new projections under `.bastra/`; changed ranking and trigger behavior; new write routes alongside the existing ones.

**Security exception, narrowly drawn**

The loader may be tightened without a major bump only when all four hold: it closes a specific, named vulnerability; the change is called out in the changelog as a security-driven tightening; an affected file produces a **visible error** rather than being dropped silently; and the rest of the vault stays as readable as the vulnerability allows. This is not a licence for parser cleanup — it covers the real case and nothing else.

**Migration**

No 1.x release rewrites existing files in bulk to produce its own format. Where a new field is needed, its absence is a defined default — as a missing `write_origin` reads as `agent-session` and a missing `recall_mode` as `deliberate` today.
