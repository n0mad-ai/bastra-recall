# Self-learning taxonomy (#64)

bastra-recall's category system has two kinds of axes:

- **Hard axis — `type`**: a closed enum (`lesson`, `decision`, …). Stable
  behavioural vocabulary, manually curated, never mutated at runtime.
- **Free axes — `scope`, `topic_path`, `tags`, `recall_when`, `folder`**: open
  strings. This is where the vault can *learn* new categories.

The learning loop closes in three steps: **notice** (drift detector) →
**record** (convention memory) → **apply** (hook injection + `folder` routing).
Everything lives per-vault: one user's vault can grow a `people/` taxonomy
while another never does. The shared `type` schema is untouched.

## 1. Convention memories — the contract (#65)

A *convention* is a regular memory that fixes how a recurring cluster is
stored. Reserved home:

| field | value |
|---|---|
| `scope` | `taxonomy` (reserved — routes to `memories/taxonomy/`) |
| `type` | `workflow` |
| `tags` | must include `convention`, plus the cluster key (e.g. `person`) |
| `recall_when` | concrete save-moments, e.g. "about to save a memory about a person" |

The **body** states the rule, machine-followable:

```markdown
## Cluster
What belongs to this cluster (and what does not).

## Rule
- folder: memories/people
- topic_path: [people, <handle>]
- tags: [person, <role…>]
- id/title shape: <handle> — <real name>
- body shape: handle, name, role/relationship, first-seen, signals,
  interaction log as [[wikilinks]], sensitivity.

## Example
One worked example entry (frontmatter + body sketch).
```

A convention is updated with `overwrite=true` (refresh, don't fork
`convention-v2`). Retire one by setting it `obsolete` — covered clusters go
silent in the drift detector either way.

## 2. Applying conventions (#66)

- The **session hook** fetches `GET /hook/taxonomy` (all non-obsolete
  memories in scope `taxonomy`, newest first, cap 12) and injects a
  `<vault-taxonomy>` block at session start. Conventions are **binding**: a
  save into a covered cluster follows the convention's folder/topic_path/tags
  instead of inventing variants.
- `save_memory` accepts a **`folder`** argument (relative to the vault root,
  path-safe, containment-checked) so conventions can place members in real
  structure — e.g. `memories/people/`. The vault scans recursively; any folder
  indexes.
- **Re-filing**: `overwrite=true` with a changed folder *moves* the memory —
  the new file is written, the old file goes to the vault trash
  (`.bastra/trash/`, recoverable), and the index is updated immediately. This
  is how existing memories migrate under a new convention.

## 3. Noticing drift (#67)

The daemon's drift detector (`GET /hook/drift`, implemented in
`packages/daemon/src/taxonomy.ts`) looks at memories updated in the last
`BASTRA_DRIFT_WINDOW_DAYS` (default 14) and flags clusters of at least
`BASTRA_DRIFT_MIN_CLUSTER` (default 8) distinct memories sharing a tag or a
sub-project `topic_path` segment — **unless** a convention already covers that
key (mentioned in a convention's tags, topic_path or title). Scope names and
memory types never count (structural, not drift).

The **stop hook** surfaces at most two clusters as a `<taxonomy-drift>`
suggestion. Suggestion only: the agent weighs it next turn, asks the user if
unsure, and never bulk-moves silently.

## Worked example — `person` (#68)

The pilot convention that established `memories/people/`:

```yaml
id: konvention-person
scope: taxonomy
type: workflow
tags: [convention, person, people]
recall_when:
  - "about to save a memory about a person"
  - "contributor, peer or contact shows up in conversation"
```

Rule: people live in `folder: memories/people`, `topic_path: [people,
<handle>]`, tag `person`, one memory per person (no collection memos), body
shape: handle, name, role/relationship, first-seen, signals/trust, interaction
log as `[[wikilinks]]`, sensitivity. Project memories link people by
`[[<handle>]]` instead of restating their story.
