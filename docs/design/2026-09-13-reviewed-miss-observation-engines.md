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

## 7. Why offline is legal here

Recall's own rule for miss detection is that only the production retriever
counts: an offline cosine over the vault over-reports misses, because the
served list is BM25 + vector + `recall_when` fused, not a similarity. This
harvester never re-ranks. It reads what recall already wrote: the served
envelope, the daemon's recorded pool for that exact `recall_id`, and the
vault's files. Anything beyond the recorded depth is not claimed; a replay
engine that re-runs the production retriever against a rebuilt snapshot is
named as future work and would depend on the daemon.

The hook lane has its own rules the harvester inherits rather than guesses:
hints are bounded by `k` and the floor; #479 suppresses hints that were
surfaced repeatedly and never loaded; the join store that links a load to its
hook recall is lost on idle respawn. The gap kinds below are those rules seen
from outside: a load without a link is the join store's documented loss, not
a harvester defect, and it is counted, never classified.

## 8. Evidence provision: axes, consumers, forks, thresholds

### Three axes, kept apart

| Axis | What it holds | Why apart |
| --- | --- | --- |
| coverage | recalls seen, envelopes with `recall_id`, pools by lane, loads and how many the daemon linked, vault ids | the ceiling of what could have been joined |
| observed | classes per lane, `live_classes` (n ≥ 3) vs `observed_thin` (1–2), heatmap top, hubs, never-loaded, established hot paths, proposals | what was seen, with n before verdict |
| gaps | one row per unjoinable kind: count, distinct sessions, verdict `den` / `noise` / `none`, named exit, recount command | 0 misses and no telemetry never look alike |

### Consumers (who reads which output)

| Output | Consumer | What it does with it |
| --- | --- | --- |
| queue (hashed) | owner review → labels file | the only path to `vault-gap`; labels never overwrite observed fields |
| proposals (clear ids, local) | curator editing `recall_when` | authored cue stays a different trust class; hub-flagged targets are read with suspicion |
| heatmap: surfaced / distinct sessions / loaded / rank | #479 hint suppression calibration; #391 hub damping | never-loaded is a density; hubs are high-degree nodes |
| hot paths with distinct-session support | #459 Workstream B (access clusters) | one session proposes an edge, two establish it |
| in-pool / out-of-pool records | learned-recall bridge harvest (#120/#129) | far cases recorded from the production pool, not from offline cosine; still gated by #129 |
| index identity basis | #388 event spine | the daemon should stamp `index_snapshot_id`; until then the basis is named |
| specimens (hashed, query-free) | this repo's tests | live fixtures with provenance; classifier drift on real shapes goes red |

### Architectural forks (decided, with the alternative named)

- **Transcript lane and telemetry lane, both.** Transcript gives the human intent and the evidence step; telemetry gives coverage (thousands of pools). One without the other is either precise-and-tiny or wide-and-intent-less.
- **Per load, not per recall.** A recall with no load afterwards is censored, not a miss. Classifying per recall would turn every unanswered hint into a negative label.
- **Recorded pool, not replay.** Depth is what the daemon searched; out-of-pool is claimed only at that depth. Replay against a rebuilt index is a separate engine with a daemon dependency.
- **Telemetry-derived index identity, named as such.** The honest alternative is a persisted snapshot id from the daemon (#388), not a content hash invented offline.
- **Human labels, no model judge.** A judge that both scores and certifies is the self-certification #129 refuses.
- **Hub as a knob, not a finding.** `--hub-sessions` defaults to 3 and says so; a learned threshold needs the evaluation registration #459 asks for.
- **Deleting nothing.** The v1 queue record is unchanged; everything new is additive fields and files.

### Thresholds and their provenance

| Threshold | Value | Provenance |
| --- | --- | --- |
| den: distinct sessions | 2 | ported from the owner's classpulse rule (`DENS_MIN_SIDS = 2`); re-measure on this corpus |
| live class: specimens | 3 | ported from the owner's bench rule (< 3 = not observed); chosen, not measured here |
| hub: distinct sessions surfaced | 3 (knob) | chosen by eye; the heatmap prints the distribution so a reviewer can move it |
| hot path: gap between loads | 30 min | chosen by eye |
| hot path: established | 2 sessions | #459: repeated, independently observed |
| pool depth | as recorded (20–40 seen) | the daemon's, not ours |

### Acceptance criteria (declared before the numbers)

- [x] The same trace lands deterministically in exactly one class; replay of live specimens is idempotent (test).
- [x] Every load is one record or exactly one named gap; the accounting closes (test).
- [x] A renamed join field becomes a den row, never zero misses (test).
- [x] A class with n < 3 is `observed_thin`, never live (test).
- [x] Live-harvested fixtures exist for served-hit, in-pool-not-selected, genuine-out-of-pool, external-source; fixture-only classes are named: unindexed-vault-object, vault-gap, unknown (test names them).
- [x] Every gap row prints a recount command or says why only the harvester can recount.
- [x] Queue and specimens carry no clear id, path or query (test); proposals and evidence carry clear ids only in files the operator names.
- [x] Zero deleted lines; no daemon, MCP, hook, ranking, `recall_when`, bridge or vault write.
- [ ] `index_snapshot_id` stamped by the daemon (#388) — not this change.
- [ ] Replay engine for depth beyond the recorded pool — not this change.

### What bites and what is only structure

Bites (a revert-check names what breaks): envelope-only miss (the reported
regex case), served → served-hit, pool erased → unknown, join field renamed
→ den, live specimens replay + flip, accounting closes, leak scan. Structure
only (lint rung, not a claim): report shape, CLI flags, den verdict table.
The tests are the maintainer's contract runner; the measurement lives in the
report over real data, which the tests do not replace.

## 9. Measured on real sessions

Eight days on two developer machines, `--hook-lane --since 8`. Counts only.

| | machine A | machine B |
| --- | --- | --- |
| sessions scanned | 76 | 125 |
| transcript recalls / with `recall_id` | 16 / 16 | 17 / 10 |
| transcript chains / joined | 11 / 11 | 5 / 4 |
| telemetry pools (recall / hook_recall) | 21 / 1552 | 6 / 491 |
| telemetry loads / linked by the daemon | 24 / 22 | 5 / 5 |
| hook lane `served-hit` | 20 | 5 |
| hook lane `in-pool-not-selected` | 1 | 0 |
| hook lane `genuine-out-of-pool` | 1 | 0 |
| transcript `served-hit` / `external-source` | 10 / 1 | 2 / 3 |
| live classes (n ≥ 3) | served-hit, external-source | served-hit, external-source |
| observed thin (1–2) | in-pool-not-selected, genuine-out-of-pool | — |
| hubs (≥ 3 sessions) / surfaced-never-loaded | 152 / 356 | 70 / 164 |
| top hub: surfaced / sessions / loaded | 498 / 166 / 0 | 194 / 21 / 0 |
| dens | none (load-without-link 2 in 1 session = noise) | envelope-without-recall-id 7 in 7 sessions |

Reading: the hook lane is where recall happens, and it is mostly a hit lane
in this window. Two miss specimens exist and are thin. The heatmap's top rows
are memories surfaced hundreds of times across dozens of sessions and never
loaded: a density for #479's calibration, not a verdict. The one den on
machine B is envelopes without `recall_id` (batch and error results), with
its exit named in the row.
