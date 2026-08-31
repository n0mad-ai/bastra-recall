# Reviewed Recall miss recovery

The existing learned-recall bridge path is real: it learns from telemetry's
`query → acted_on memory` reaches and widens future queries through a
language-partitioned pool. It cannot ingest a session transcript's later file
read: a nonempty hit is not proof of relevance, and a file is not a vault
memory.

`classifyReviewedMiss()` is the seam between those surfaces. A human labels the
raw session chain `intent → Recall result → evidence read` as a miss. The input
then has exactly two outcomes:

- `vault-memory` returns a `bridge-reach`, eligible for the existing local mint
  flow and its normal evidence/promotion gates.
- `external-source` returns a `note-candidate`; it stays with the curator until
  someone decides whether to make a durable memory.

The function is pure and fail-closed. It receives no absolute source path, only
an opaque source digest for the external branch. It writes no bridge, memory,
queue, contribution, or prompt context. A future CLI/sidecar may supply reviewed
records, but must preserve this ownership split and cannot upgrade a
`needs-relevance-label` record automatically.

The local offline collector is `npm run harvest:reviewed-misses --workspace
@bastra-recall/daemon -- --out queue.json session.jsonl`. It creates only a
review queue from the raw session chain; it hashes session and source identities,
and makes nonempty Recall results `needs-relevance-label` rather than guessing
that a later read proves a Recall miss.
