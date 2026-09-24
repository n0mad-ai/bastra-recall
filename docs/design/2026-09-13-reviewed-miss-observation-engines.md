# Reviewed-miss observation: six classes from offline engines

Workstream A of #459. What the offline harvester
(`packages/daemon/scripts/harvest-reviewed-misses.ts`) needs to land a trace
in exactly one class, where each proof comes from, and what it deliberately
does not claim. Measurements and the history behind this design live on #459.

## 1. Where the frozen evidence already exists

| Artifact | Carries | Join key |
| --- | --- | --- |
| Raw session JSONL (client transcript) | human intent, the `recall` tool_use, its tool_result envelope, the evidence step after it, the recorded `cwd` | `tool_use_id`; `recall_id` inside the envelope |
| Daemon telemetry `events-*.jsonl` | `recall` / `hook_recall` events with `recall_id`, `candidate_pool` (ordered, below-floor included), score kind/arms/version, `vault_size`, `k`; `load_memory` events with `from_hook_recall` / `follows_recall` | `recall_id` |

`recall_id` is written into the served envelope and into the telemetry event
by the same call, so the join is exact, never adjacency.

The daemon does not stamp an index snapshot identity. The engine derives one
from the telemetry fields it has and labels its basis `telemetry-derived`; a
daemon-side `index_snapshot_id` belongs to the #388 event spine.

## 2. Classes

| Class | Proof required |
| --- | --- |
| `served-hit` (not a miss) | the target is among the served hits of the same call |
| `in-pool-not-selected` | the target is in the recorded `candidate_pool`, not served |
| `genuine-out-of-pool` | the target is a memory that existed before the call (birth time, or its own `created` when a tmp+rename rewrite reset the birth time) and is absent from the pool at its recorded depth |
| `unindexed-vault-object` | the target is in the vault but could not have been indexed at the call: born after it, or not a memory |
| `external-source` | the evidence step read a path outside `--vault` |
| `vault-gap` | an external read a reviewer labelled durable, against a named vault snapshot |
| `unknown` | any missing or contradictory proof: no telemetry join, no vault snapshot, index-present but vault-absent, in-pool but index-absent, an evidence step with no inspectable identity |

`classifyReviewedMissObservation` is a pure function over an assembled
observation; engines only assemble proofs. A partial observation cannot
produce anything but `unknown`.

## 3. Engines (`reviewed-miss-engines.ts`)

- **pool-join** — `--events DIR`: telemetry indexed by `recall_id`; attaches
  the pool, served ids, score space and `vault_size`. Without it, `unknown`.
- **vault-snapshot** — `--vault DIR`, enumerated once: hashed relative paths,
  parsed ids (`occupantOfRaw` from core), per-file birth time read from the
  same descriptor as the text, declared `created`. The snapshot id is the hash
  of the sorted hashed listing. Paths are dereferenced, so a symlinked vault
  is the same vault through either spelling.
- **target-resolve** — the first evidence step with an inspectable identity:
  a `load_memory` id; a `Read` path (a relative one resolved against the
  transcript's recorded `cwd`, opaque without one); a single-file Bash read
  (`cat` / `head` / `tail` / `grep PATTERN FILE`, absolute path only, no
  pipes, globs or expansion). An evidence step with no identity does not take
  the slot from a later one that has one.
- **identity** — `profileSnapshotId` and the telemetry-derived
  `indexSnapshotId`; two observations compare only when both match.

The served envelope alone decides `explicitMiss`: `weak_result`, `no_home`, or
an empty top-level `hits`. Text inside a hit, a nested `hits`, or text that is
not an envelope is never a miss.

## 4. Two lanes, one session identity (`reviewed-miss-evidence.ts`)

- **Transcript lane** — intent → recall → envelope → evidence step, from the
  session JSONL.
- **Hook lane** (`--hook-lane`) — every daemon-joined `load_memory` against the
  pool of the recall it followed; no transcript needed. A load the transcript
  lane already observed (same `recall_id` and memory) is left to it.

Both lanes feed one proposal list (`reviewed-miss-cues.ts`), so they must
spell a session the same way. Telemetry never holds the raw client session
for a load: `load_memory` and MCP `recall` stamp `session_id` with the daemon
run. The one spelling both lanes can produce is the daemon's pseudonym,
`dimensions.experiment_session` (`pseudonymousSession`). The transcript lane
derives it from the records' `sessionId` (else the file name); a load takes it
from the recall it followed. `sessionRef()` hashes that pseudonym and is the
only session ref the harvester writes. Support, hub and hot-path counts are
distinct client sessions, never daemon runs.

A load joined to no recall has no client session. For gap accounting only,
its daemon run witnesses the repeat (`GapEvent.witness`).

## 5. Report

One JSON line on stderr, three axes kept apart so that zero misses and no
telemetry never look alike:

- **coverage** — recalls seen, envelopes with `recall_id`, pools by lane,
  loads and how many the daemon linked, vault ids;
- **observed** — classes per lane; `live_classes` (n ≥ 3) vs `observed_thin`
  (1–2); heatmap top; hubs; surfaced-never-loaded; established hot paths;
  proposals;
- **gaps** — one row per unjoinable kind: count, distinct witnesses, verdict
  (`den` = repeated across ≥ 2 witnesses, else `noise`, or `none`), the named
  exit, and a recount command or why only the harvester can recount.

Non-use is censored: a memory surfaced and never loaded is a density, not a
negative label. A hot-path edge from one session is proposed; two establish
it.

| Threshold | Value | Provenance |
| --- | --- | --- |
| den: distinct witnesses | 2 | ported rule, not measured on this corpus |
| live class: specimens | 3 | ported rule, not measured here |
| hub: distinct sessions surfaced | 3 (`--hub-sessions`) | chosen by eye |
| hot path: gap between loads | 30 min | chosen by eye |
| hot path: established | 2 sessions | #459 |

## 6. Outputs

| Output | Carries | Consumer |
| --- | --- | --- |
| queue (`--out` or stdout) | hashed ids and refs, verbatim query | owner review → `--labels` (the only path to `vault-gap`) |
| `--proposals` | clear memory ids, local | curator editing `recall_when`; hub targets flagged |
| `--evidence` | clear memory ids, local | heatmap and hot paths |
| `--specimens` | one hashed, query-free observation per (lane, class) | this repo's tests (`__fixtures__/reviewed-miss-harvest/live-specimens.jsonl`) |

## 7. Non-goals

No daemon, MCP, hook, ranking, `recall_when`, bridge or vault write. No model
call. No re-ranking: out-of-pool is claimed only at the depth the daemon
recorded. A replay engine that re-runs the production retriever against a
rebuilt snapshot would measure beyond that depth; it depends on the daemon
and is not here. Access clusters (Workstream B) are not here.
