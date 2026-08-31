# Reviewed-miss harvester: adversarial audit

The harvester records one reviewable chain: human intent, a specific Recall
invocation and result, then a later source read. Teacher-3 remains unwired.
The record does not classify the source as a memory or bridge.

| Adversarial specimen | Previous failure mode | Current refusal / evidence |
| --- | --- | --- |
| Claude `tool_result` after `tool_use` | `weak_result` was read from the wrong record, so an empty Recall became nonempty | Match the result by `tool_use_id`; the seeded JSONL pins it |
| Read before result | causal order could be invented from adjacent lines | source evidence is ignored until the matching result arrives |
| Nonempty Recall then later file read | later digging was treated as proof Recall was wrong | output remains `needs-relevance-label` |
| Different tool's result | an unrelated empty tool output could taint Recall | only the pending Recall tool id may change status |
| Path-bearing evidence | a review queue could leak topology | only a truncated SHA-256 source reference is emitted |

## Teacher-3 wire, deliberately not built here

The future wire consumes only a human-reviewed
`reviewed-recall-miss/v1` record. `vault-memory` may feed the existing bridge
mint path; `external-source` is a note candidate. The harvester is evidence
collection, not the teacher: it writes no vault memory, bridge, telemetry,
prompt context, or policy decision.

Closing-loop acceptance is therefore four separate proofs: seeded replay,
raw-session replay, curator review, and an existing bridge-mint acceptance.
No green parser test upgrades a candidate to a learned behavior.

## Local judge input

`--judge` extracts the recap after the source-read result and the first assistant
reply after the next real human turn. Tool results cannot occupy either slot.
The local Ollama judge receives those two texts, the user intent and Recall
result class; it returns `recall-relevant`, `bridge-review`, `note-draft`, or
`uncertain`. A note draft is output only. Saving it and minting a bridge remain
separate writer actions.

## Hot-file template

`--relative-to <live-root> --zone <stable-name>` emits a local
`recall-hot-files-template/v1`: paths are relative to the supplied zone root,
sorted by observed count, and carry the split between explicit misses and
unreviewed nonempty Recall chains. The root itself is never rendered. Session
scratchpads, tool results, task output and worktree paths are excluded before
ranking; their count remains visible as `excludedEphemeralObservations`.

This is a candidate for a curated Recall memory, not an automatically saved
one. Its `validation` field is part of the contract: resolve each path against
the current zone root and ignore missing entries. A stale relative path must
not become a phantom authority or a retrieval instruction.
