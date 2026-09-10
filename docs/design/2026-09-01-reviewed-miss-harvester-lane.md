# Reviewed-miss harvester: delivery lane B

This is PR #454's proposed **(b)** split: an offline collector, not a Recall
policy change. Given local raw session JSONL, it emits a pathless review queue
for an exact chain: human intent, the matching Recall result, then a later
source read.

## Contract

- Results join Recall by tool_use_id, never by adjacency.
- Only an explicit weak or empty Recall becomes candidate.
- A nonempty or unclassified Recall remains needs-relevance-label; a later
  source read does not retroactively prove it irrelevant.
- Session and source identities are hashes. The queue contains no paths, source
  payloads, prompt context, or vault content.
- --out writes only the queue path the operator names. Without it, output is
  stdout.

## What this cannot do

Nothing runs in the daemon, MCP instructions, hooks, session context, or
retrieval path. The collector does not call a model, decide relevance, mint a
bridge, save a memory, emit telemetry, rank anything, or infer a vault gap.

A human may review a queue record later, using a separate workflow. That future
workflow is not represented by a special tag, adapter, or protocol in this
repository.

## Kill tests

- An unrelated empty result cannot taint a nonempty Recall.
- An evidence read before the matching Recall result makes no record.
- Control envelopes and image placeholders cannot become human intent.
- The first positional JSONL is retained when no flag appears before it.
- The output queue contains only hashed source identity.
