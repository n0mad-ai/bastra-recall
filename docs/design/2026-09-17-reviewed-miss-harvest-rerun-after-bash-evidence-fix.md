# Reviewed-miss harvester, re-run after the Bash-evidence fix: did the two unknowns move?

Follow-up to `docs/design/2026-09-17-reviewed-miss-harvest-three-days-measured.md` (the
baseline) and commit `2d282ac` ("reviewed-miss: target-resolve recognizes cat/head/tail/grep
Bash evidence"). The baseline named two transcript chains that landed in `unknown` and
attributed both to `target-resolve` being blind to `Bash`-tool evidence (§4). `2d282ac` added
a Bash recognizer. This doc re-runs the **same 3-day window (2026-09-14..16)** on the tree
that contains the fix (branch `local/pr454-cleanup-2026-09-17`, HEAD `76ddc0b`, fix present as
`2d282ac`) and measures whether those two chains reclassified. It did not invent new design;
it is one measured re-run, written before anything is claimed.

Short answer, up front: **the fix moved neither of the two named unknowns.** Both are still
`unknown`, for two different root causes, and neither root cause is Bash-evidence blindness.
Instrumentation confirms what `2d282ac`'s own commit message already said — the baseline §4
causal claim does not hold up. The Bash recognizer is real capability that no live chain in
this window exercises.

## 1. What was run

Faithful reproduction of the baseline shape, same 36 session files, same window flag:

```
cd ~/bastra-recall/packages/daemon
npx tsx scripts/harvest-reviewed-misses.ts \
  --events ~/.bastra/logs --vault <vault> --hook-lane --since 3 \
  --evidence <scratch>/evidence.json --specimens <scratch>/specimens.jsonl \
  --proposals <scratch>/proposals.json --out <scratch>/queue.json \
  <36 session .jsonl files, mtime 2026-09-14..16>
```

The 36 session files were built exactly as the baseline prescribed — top-level
`<transcripts>/*.jsonl` whose mtime is 09-14, -15 or -16 (14 + 12 + 10 = 36,
identical count to the baseline). The 17th was excluded (no telemetry pool for it). Outputs
carry CLEAR memory ids per the CLI's own contract ("keep it local") and live in a scratch dir
outside the repo — **not committed**. The vault (`<vault> → <vault>`) is
read-only by construction: the harvester's only vault touch is `snapshotVault` for membership
proofs, it has no vault write path, and `vault_ids: 1389` came back read fine.

**`--since 3` is the correct flag, not `--since 4`.** `--since DAYS` filters telemetry by event
timestamp: `Date.now() - DAYS*86.4e6` (harvest script line 90). This re-run's wall clock was
2026-09-17 01:56 +0300, the same "day after the window" relation the baseline had, so `--since
3` reproduces the baseline's own cutoff. Verified it covers exactly 14–16 and drops neither
edge:

| check | value | command |
| --- | --- | --- |
| `--since 3` cutoff (events younger than) | 2026-09-13T22:56Z | `Date.now() - 3d` at 01:56 +0300 |
| events-2026-09-14 first / last event ts | 00:00:29Z / 21:45:28Z | `head -1`/`tail -1` on the file's `.ts` |
| all joined pool ts, this run | 09-14T11:02Z … 09-16T14:02Z | `queue.json` `observation.pool.observedAt` |

The 14th's earliest event (00:00:29Z on the 14th) is younger than the 22:56Z-on-the-13th
cutoff, so the whole 14th file is in-window; every joined pool falls inside 09-14…09-16 with no
13th or 17th bleed. `--since 4` was run only as a diagnostic (§4) — it widens the cutoff to
2026-09-12T22:56Z and pulls the 13th's pools in (min joined pool ts `2026-09-13T04:42Z`), so it
is **not** the faithful three-day window.

## 2. Coverage — measured, deltas vs baseline

| | baseline | this run | delta | command |
| --- | --- | --- | --- | --- |
| sessions scanned | 36 | 36 | 0 | positional args count |
| transcript recalls / with `recall_id` | 10 / 10 | 10 / 10 | 0 | `coverage.transcript_recalls*` |
| transcript chains / joined | 5 / 4 | 5 / **3** | joined −1 | `coverage.transcript_chains*` |
| telemetry pools (`recall` / `hook_recall`) | 11 / 804 | **13 / 845** | +2 / +41 | `coverage.telemetry_pools_by_lane` |
| telemetry loads / linked | 6 / 6 | **5 / 5** | −1 / −1 | `coverage.telemetry_loads*` |
| vault ids at snapshot | 1386 | **1389** | +3 | `coverage.vault_ids` |
| hubs (≥3 sessions) | 111 | **117** | +6 | `observed.hubs` |
| surfaced-never-loaded | 320 | **327** | +7 | `observed.surfaced_never_loaded` |
| heatmap top row | 198 surf / 20 sess / 0 load | **202** surf / 20 sess / 0 load | +4 surf | `observed.heatmap_top[0]` |
| hot paths established | 0 | 0 | 0 | `observed.hot_paths_established` |
| proposals targets / episodes | 0 / 0 | 0 / 0 | 0 | `observed.proposals` |

The growth deltas (`recall` pools 11→13, `hook_recall` 804→845, vault 1386→1389, hubs +6,
surfaced +7) are all in the direction of "more telemetry, bigger vault" and are exactly what a
**live, still-appending** telemetry dir plus a vault that grew between the two runs produces —
the 09-16 events file was still being written during this session. None of it is attributable
to the code change; `2d282ac` touches only `target-resolve`. The one *decrease* — joined chains
4→3 — is the load-bearing coverage delta and is explained in §3/§4: one borderline transcript
chain's telemetry pool fell just outside the shifted window.

## 3. Seven classes — this run vs baseline

| Class | transcript base | transcript now | hook base | hook now |
| --- | --- | --- | --- | --- |
| `served-hit` | 2 | **1** | 5 | **4** |
| `in-pool-not-selected` | 0 | 0 | 0 | 0 |
| `genuine-out-of-pool` | 0 | 0 | 0 | 0 |
| `unindexed-vault-object` | 0 | 0 | 0 | 0 |
| `vault-gap` | 0 | 0 | 0 | 0 |
| `external-source` | 1 | 1 | 0 | 0 |
| `unknown` | 2 | **3** | 0 | 0 |

Gap (den) rows: `load-not-found` 1 (noise, both runs — a `load_memory` for an id the vault no
longer holds); `unresolved-evidence` **2 → 3** (den), the transcript-lane mirror of the
`unknown` count; all other den kinds 0.

Read plainly: `unknown` went the **wrong way** for the fix's hypothesis — up from 2 to 3, not
down to 0 — and `served-hit` dropped 2→1. The five transcript chains are the same five sessions'
recalls both runs; the composition shifted because the joined/not-joined split moved (baseline
4 joined / 1 not; now 3 joined / 2 not). §4 traces every one.

## 4. THE KEY QUESTION: did `2d282ac` reclassify the two baseline unknowns?

**No.** Both remain `unknown`, and tracing each to its raw transcript shows why — neither is a
Bash-evidence case.

The five transcript chains this run, from `queue.json` (session basenames recovered by
`hash(basename)` — the same `sha256`-of-filename the harvester uses):

| session | query (paraphrased) | class | why |
| --- | --- | --- | --- |
| `01958311…` | a "root granted — investigate load, pressure and caches" request | **unknown** | opaque evidence, `sourceRef: null` |
| `14bf9698…` | a single word: the tool's own name | **unknown** | evidence *resolved*; recall_id joined no pool in-window |
| `0ddc2762…` | "find the session where the vbios was flashed", then an scp to a host on the LAN | **unknown** (NEW) | same join-gap shape as `14bf9698` |
| `33687af9…` | "aren't these saved anywhere?" | served-hit | pool joined, target vault-object |
| `33687af9…` | "log into the router and try to tune it" | external-source | pool joined, target external-read |

### 4a. `01958311…` (the "root granted" chain) — opaque, not Bash

This is the baseline §4 chain #1 (its pool `observedAt` is `2026-09-16T13:53:45Z`, the same
timestamp the baseline named). Its target is `{kind: "unresolved", sourceRef: null}` — the pool
*joined*, but the evidence step produced no inspectable source. Reading the raw transcript, the
first tool call after the recall result is:

```
mcp__bastra-recall__load_memory  input: {"ids": "[\"<note-id>\"]"}
mcp__bastra-recall__load_memory  input: {"id":  "<note-id>"}
```

The **first** call uses a malformed `ids` key (plural, value a stringified array) instead of the
documented singular `id`. `target-resolve` can't parse it, so it consumes the evidence slot as
opaque → `sourceRef: null` → `unknown`, *before* the model's very next, correct `load_memory({id:
…})` ever gets a turn. The Bash follow-ups the baseline pointed at (`cat`/`find`/`uptime`/`tail`)
are downstream of an already-opaque slot and are never reached. The Bash recognizer in `2d282ac`
is structurally irrelevant to this chain. Fixing it would require parsing the malformed `ids`
shape (or the model not emitting it) — which `2d282ac` explicitly does not do.

### 4b. `14bf9698…` (the one-word chain) — join/coverage gap, evidence already resolves

Baseline §4 chain #2. Its target is `{kind: "unresolved", sourceRef:
"sha256:d768e19e…"}` — `sourceRef` is **non-null**: the evidence step *did* resolve. The raw
transcript's first post-recall step is a valid `load_memory({id:
"windows-profile-migration-toolkit-compat-decisions"})`, and `hash("id:" + that id)` =
`sha256:d768e19e2f4c26538add8ca7c4bd63f8`, matching the target exactly. That step resolves fine
under the *old* code too — it is a `load_memory`, not a Bash call. The chain is `unknown` only
because its recall_id joined **no `candidate_pool`** inside the 3-day window (`observation.pool:
null`) — a join/coverage gap on the telemetry side, unrelated to evidence shape.

### 4c. `0ddc2762…` (vbios/scp) — NEW unknown, same join-gap shape

A third `unknown` not present in the baseline: `sourceRef` non-null (resolved evidence),
`pool: null` (no in-window pool). Same structural cause as 4b. It appears now because the
live-shifted window left its telemetry pool just outside the boundary; in the baseline it was
almost certainly one of the two `served-hit`s (that is the served-hit 2→1 + unknown +1 net move
in one chain).

### 4d. The `--since 4` diagnostic isolates it cleanly

Re-running with `--since 4` (window widened to include the 13th — **not** the faithful window):

```
transcript: served-hit 3, external-source 1, unknown 1   (hook: served-hit 8)
chains 5 / joined 5;  pools recall 18 / hook 929
```

With the wider window, **all five transcript chains join**, and `unknown` collapses to **1** —
and that surviving one is `01958311…`, the opaque `sourceRef: null` chain from 4a. This is the
clean proof: `14bf9698` (the one-word chain) and `0ddc2762` (the vbios chain) are `unknown` under `--since 3` purely
because their pools sit at the window boundary; widen the window and they reclassify to
`served-hit`. The only *structurally* unknown transcript chain in either window is the opaque
malformed-`load_memory` one — which the Bash fix does not touch.

**Conclusion for the key question:** `2d282ac` reclassified neither baseline unknown. The
baseline §4 attribution (both unknowns caused by Bash-evidence blindness) is falsified by direct
instrumentation. `01958311…` is opaque for a malformed-`load_memory` reason; `14bf9698…` was
never a Bash case at all (it resolves a real `load_memory`) and is a pool-join gap. This
independently reproduces the finding `2d282ac`'s own commit message reported.

## 5. What the Bash fix actually is, and why nothing lit up

`2d282ac` adds a closed recognizer for `cat FILE`, `head|tail [-n40|-60|-f] FILE`, `grep PATTERN
FILE` — single-file reads with no pipe, redirect, subshell, glob or second file — and, crucially,
makes an *unrecognized* Bash call not consume the evidence slot (so a stray `find`/`uptime`
before a real read no longer locks a chain into `opaque`). It is covered by six synthetic-fixture
commands plus an observation test proving a `cat`/`tail` of a real file classifies identically to
the equivalent `Read` (external-read → `external-source`, vault file → `genuine-out-of-pool`).
The capability is sound. It simply is not what produced either baseline specimen, and **no live
chain in this 3-day window exercises it** — the committed `live-specimens.jsonl` gained the
opaque `01958311…` specimen (target `unresolved`/`sourceRef: null`), not a Bash one. Tests green:
`npx tsx --test __tests__/reviewed-miss-harvest.test.ts __tests__/reviewed-miss-observation.test.ts`
→ 32 pass / 0 fail.

## 6. New findings this run surfaces

- **A third `unknown`** (`0ddc2762…`, the vbios/scp chain) — pool-join gap, §4c. Not a defect
  in recall or the fix; an artifact of the live window boundary.
- **The baseline §5 gap appears CLOSED.** The baseline's one confirmed vault gap —
  `<a-note>` present in auto-memory but absent
  from the vault — is no longer absent: `memories/projects/<project>/<a-note>.md`
  now exists in the vault (`find <vault> -iname '*<a-note>*'`). This is part of
  the +3 vault-id growth since the baseline (1386→1389). Noted as presence only — content
  equivalence not verified, and this is *not* what this run measures (§7).
- **Heatmap shape is the baseline's shape, slightly larger:** top hub surfaced 202× across 20
  sessions, loaded 0×; 117 hubs; 327 surfaced-never-loaded. Same reading as the baseline and the
  09-13 doc §9 — a density for hint-suppression calibration, not a verdict.
- **`proposals` empty, `hot_paths_established` 0** — unchanged from baseline; 3 days remains
  below the "established" threshold for hot-path/cue signal.

## 7. Honesty — what this run does NOT claim

- It does **not** claim the Bash fix improved anything measurable on live data. It did not: no
  live chain in this window exercises the recognizer, and `unknown` went up, not down. The fix's
  value is a correct capability plus a falsification of the baseline's causal story — not a
  reclassification.
- It does **not** claim recall missed anything real in the three `unknown` chains. `01958311…`
  is undetermined by construction (opaque evidence). `14bf9698…` and `0ddc2762…` actually
  *resolved* their evidence (the one-word chain loaded a vault note)
  and both join and reclassify to `served-hit` under `--since 4` — they are pool-window
  artifacts, not misses.
- This is **not a byte-identical reproduction** of the baseline. Live telemetry appended between
  the two runs, the vault grew (+3 ids), and the `--since` cutoff rides the wall clock, so the
  small coverage deltas (§2) and the joined-count drop (§3/§4) are expected measurement drift on
  a live pool — not code effects. `2d282ac` changes only `target-resolve`.
- The harvester **still cannot scan the vault for absent topics**: its per-chain classes fire
  only when a query happened and evidence followed in-window. A lesson never queried in these
  three days produces no chain, no class — invisible by construction, exactly as the baseline §5
  stated. The §5 gap being closed (§6) was found by direct file comparison, not by the harvester,
  and closing it is a separate track from what this run measures.
- Non-goals inherited from the source design hold: no daemon/MCP/hook/ranking write, no model
  call, no replay beyond recorded pool depth; the vault and telemetry were read-only inputs
  throughout.
