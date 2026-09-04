# Establishing a convention — and the people spec

*Read this when a recurring cluster has no home yet, when re-filing existing memories, or before saving a memory about a person.*

Applying an active convention needs nothing from this file — the `<vault-taxonomy>` block lists them, and following a listed convention's `folder`/`topic_path`/`tags` exactly is the whole rule. This file is for the two cases that go beyond that: creating a convention, and the one cluster that already has a fixed spec.

## Establish (when a cluster recurs without a home)

Establish the moment a recurring cluster becomes clear — the same ad-hoc cluster for the third time, a `<taxonomy-drift>` suggestion from the stop hook, **or the conversation itself signalling a recurring domain** (the user scans a stack of invoices → an `accounting`/`buchhaltung` home; introduces several people → `people`; collects recipes, places, contracts → their own homes).

Don't wait for look-alike memories to pile up unfiled. When the context signals a recurring kind, create the home **proactively** and file new items into it from the start.

1. `save_memory` with `scope: "taxonomy"`, `type: "workflow"`, tags `["convention", "<cluster-key>"]`, body = the rule (folder, topic_path shape, tags, body shape, one worked example).
2. Apply it immediately to the memory you were about to save — pass `folder` so members get a real home, e.g. `memories/people`.
3. Re-file existing members: `save_memory` with `overwrite: true` + the convention's `folder` **moves** a memory (the old file goes to the vault trash, recoverable). Split collection memos into one-memory-per-entity while you're at it, and link them with `[[wikilinks]]` instead of restating their story.

Conventions are living rules: refresh with `overwrite=true`, never fork a `-v2`. For bulk re-filing (more than 5 memories at once), tell the user what you're about to move first.

## People — one canonical memo per person

A person has exactly **one** canonical memo: `save_memory` with `folder: memories/people`, `topic_path: [people, <handle>]`, `type: project-fact`, tag `person`.

Set `id: <handle>` explicitly — body wikilinks resolve against the memory **id**, so the id must be the handle, not the slugified title. Pass `folder` explicitly so it routes there regardless of the active scope.

That memo holds **identity only**: handle, real name, role/relationship, contacts, first-seen, trust signals, a high-level interaction overview.

Content lives elsewhere. Technical conversations, decisions and measurements go under the project's scope and link back with `[[<handle>]]` (which mirrors into `related[]`) — they never restate who the person is.

A **second** person memo is justified only when someone holds a distinct standing role across projects (architecture peer in one, partnership candidate in another): the project memo links **up** to the canonical `memories/people` memo via `[[<handle>]]` and carries only the project-specific relationship. Identity stays in the one canonical memo.
