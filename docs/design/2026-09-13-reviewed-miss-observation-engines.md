# Reviewed-miss observation: six classes from four offline engines

Follow-up to PR #454 and the Workstream A requirements in #459. This document
records what the offline harvester needs in order to land a trace in exactly
one of the six classes, where each proof comes from, and what it deliberately
does not claim.

## 1. Where the frozen evidence already exists

The daemon already records, per Recall call, the material #459 asks for. It is
split across two local artifacts that were never joined offline:

| Artifact | Carries | Join key |
| --- | --- | --- |
| Raw session JSONL (client transcript) | human intent, the `recall` tool_use, its tool_result envelope, later reads and `load_memory` calls | `tool_use_id` (already used by #454), and `recall_id` inside the envelope |
| Daemon telemetry `events-*.jsonl` | `recall` / `hook_recall` events with `recall_id`, `candidate_pool` (ordered ids + scores, below-floor included), `candidate_pool_score_kind/arms/version`, `vault_size`, `k`, `ts` | `recall_id` |

`recall_id` is written into the served envelope by the recall handler and into
the telemetry event by the same call, so the join is exact, never adjacency.
A probe over eight days of local sessions on two developer machines joined
every MCP recall in the transcripts to its telemetry event and every joined
event carried a candidate pool (9/9 and 16/16). This is the "frozen pool" of
#459: it is the pool the daemon actually searched, at the depth it actually
used, in the score space it names.

What does not exist yet: a persisted index snapshot identity. The daemon
versions its score formula and arm set, and reports `vault_size`, but it does
not stamp a content hash of the indexed id set into the event. The engine
therefore derives an index identity from the telemetry fields it has
(`vault_size`, `score_kind`, `score_arms`, `score_version`, `k`) and labels its
basis as `telemetry-derived`. A daemon-side `index_snapshot_id` belongs to the
#388 event spine and is proposed there, not added here.

## 2. Six classes, and which engine proves each

| Class | Proof required | Engine |
| --- | --- | --- |
| `served-hit` (not a miss) | target id is among the served hits of the same call; kept apart from `unknown` so a success never reads as a missing proof | pool-join |
| `in-pool-not-selected` | target id is in the recorded `candidate_pool`, not among served hits | pool-join |
| `genuine-out-of-pool` | target existed on disk before the recall `ts` and parses as a memory, but is absent from the pool at its recorded depth | pool-join + vault-snapshot |
| `unindexed-vault-object` | target exists on disk now but could not have been indexed at `ts`: created after `ts`, or does not parse as a memory | vault-snapshot |
| `vault-gap` | later evidence resolved to no memory id: the read was outside the registered vault, or the vault snapshot has no object for it; the snapshot names how many ids it checked and its listing hash | target-resolve + vault-snapshot |
| `external-source` | later evidence was a read of a path outside the vault (repository, runtime, scratch) and no vault object was loaded afterwards | target-resolve |
| `unknown` | any missing or contradictory proof: no telemetry join, no vault given, index-present but vault-absent, in-pool but index-absent, later read with no inspectable identity | classifier (fail-closed) |

The classifier is a pure function over an assembled observation. Engines
only assemble proofs; none of them decides a class. A partial observation
cannot produce anything but `unknown`.

`external-source` and `vault-gap` differ only by whether the later evidence
had a vault-side identity to check. Both are non-proposals: the first is
answered from current state, the second is at most a note candidate for a
human, never a bridge.

## 3. Engines

Each engine is a separate module with one input and one output, so that a
reviewer can replace or disable it without touching the others.

- **pool-join** — reads telemetry events from a directory the operator names
  (`--events DIR`), indexes them by `recall_id`, and attaches the pool, the
  served ids, the score space and `vault_size` to the harvested chain. Without
  the flag, no pool is attached and the chain classifies `unknown`.
- **target-resolve** — walks the chain after the recall result and resolves the
  first evidence step to one of: `load_memory` id (vault object, exact),
  a file read whose path lies inside `--vault` (vault object via the memory
  parser's own id, using `readOccupant` from core), a file read elsewhere
  (external), or no inspectable identity (unresolved).
- **vault-snapshot** — enumerates `--vault` once per run: hashed relative
  paths, parsed ids, per-file birth time and parse outcome. Produces a
  snapshot id (hash of the sorted hashed listing) and, per target id, a
  membership proof with a stated reason (`present`, `absent`,
  `created-after-observation`, `not-a-memory`).
- **identity** — derives `profileSnapshotId` and the telemetry-derived
  `indexSnapshotId` from the event, so two observations are comparable only
  when both ids match.

Every id, path and session reference in the output is a `sha256:` prefix
hash. The `query` remains verbatim, as in #454; the design doc of that PR now
says so explicitly.

## 4. explicitMiss stays on the envelope

The finding on #454: `explicitMiss()` recursed into hit payloads, so a
non-empty recall whose hit summary contained "no relevant memory was found"
was classified as a miss. The fix reads only the top-level envelope of the
matching tool_result: `weak_result === true`, `no_home === true`, or
`hits.length === 0`. Text that does not parse as an envelope is never a miss.
The regex is gone; a test reproduces the reported case.

## 5. Kill tests

- A non-empty recall whose hit text says "no relevant memory was found" is
  not a candidate.
- A target served in the same pool classifies `served-hit`, never a miss.
- A pool from a different `recall_id` cannot attach to a chain.
- A target created after the recall `ts` classifies `unindexed-vault-object`
  with reason `created-after-observation`, never `genuine-out-of-pool`.
- Without `--events`, every chain is `unknown`; without `--vault`, no chain
  can claim `vault-gap` or `genuine-out-of-pool`.
- Queue output contains no raw path, no vault content, no hit payload.

## 6. Non-goals

No daemon, MCP, hook, ranking, `recall_when`, bridge or vault write. No model
call. No replay of queries against a rebuilt index (a replay engine that
re-runs the production retriever against a rebuilt snapshot is the right way
to measure rank beyond the recorded depth; it depends on the daemon and is
left as a named future engine). Workstream B (access clusters) is not in
this change.

## 7. Measured on real sessions (2026-09-13)

Eight days of raw sessions on two developer machines, the daemon's telemetry
directory and the live vault, one run each. Counts only; the queue and the
proposals stay local.

| | machine A | machine B |
| --- | --- | --- |
| sessions scanned | 76 | 125 |
| recall calls with a result | 16 | 17 |
| envelopes carrying `recall_id` | 16 | 10 |
| chains (result followed by an evidence step) | 11 | 5 |
| chains joined to a telemetry pool | 11 | 4 |
| `served-hit` | 10 | 2 |
| `external-source` | 1 | 3 |
| `unknown` | 0 | 0 |
| miss classes (`in-pool`, `out-of-pool`, `unindexed`, `vault-gap`) | 0 | 0 |
| telemetry pools available | 2727 | 1211 |
| recorded pool depth seen | 20, 32 | 24, 32, 40 |

Reading: on these machines the MCP recall lane is a hit lane in this window.
Every chain that loaded a vault object loaded one the same call had served.
The four proposal classes therefore have no live specimen yet; they are
exercised by the adversarial fixtures only, and this document does not claim
a miss rate. The seven envelopes on machine B without a `recall_id` were
error results and batch calls whose envelope shape differs; they are counted
so that the join ceiling is visible.

Two observations for the next engine, not built here:

- Most recall traffic is the hook lane (thousands of `hook_recall` pools
  against tens of MCP calls). The daemon's own `load_memory` events already
  carry `from_hook_recall` and `hook_hint_rank`, so a telemetry-only join
  (no transcript) can classify hook-lane loads against their pool. That is a
  second pool-join engine with the same classifier.
- A `served-hit` followed by a correction in the same turn is the case #388's
  outcome vocabulary is for; this harvester does not read outcomes.
