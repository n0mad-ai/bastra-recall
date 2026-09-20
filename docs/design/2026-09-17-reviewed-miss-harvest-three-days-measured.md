# Reviewed-miss harvester on three real days: what actually landed where

Follow-up to `docs/design/2026-09-01-v2-offline-harvester-and-access-clusters.md` and
`docs/design/2026-09-13-reviewed-miss-observation-engines.md`, after the merge of the v2
harvester into `recall/gate-durable-gaps` (`5ebacd5`). This is not new design — it is the
first real run of that merged code, on one machine (arch), over three consecutive days of
its own telemetry, measured and written down before anything is claimed about it.

## 1. What was run

CLI shape on the merged tree matched the pre-merge stub exactly (`--help` confirmed no
flags were renamed by the v2 merge; `--out` was added on top to also capture the ledger):

```
npx tsx packages/daemon/scripts/harvest-reviewed-misses.ts \
  --events ~/.bastra/logs --vault <vault> --hook-lane --since 3 \
  --evidence evidence.json --specimens specimens.jsonl --proposals proposals.json \
  --out queue.json \
  <36 session .jsonl files, 2026-09-14..16>
```

Inputs: `~/.bastra/logs/events-2026-09-1{4,5,6}.jsonl` (real `bastra-local.service`
telemetry, 3 files), `<vault>` (the real vault, 1386 ids at snapshot time), and 36
top-level session transcripts under `<transcripts>/` whose mtime falls on
those three dates (out of ~43 files spanning 14–17 Sep; the 17th was excluded because the
events window is 14–16 and a transcript chain needs a telemetry pool to join against).
Outputs live outside this repo, in the run's own scratch dir (`evidence`/`specimens`/
`proposals`/`queue` carry clear ids per the CLI's own contract — "keep it local" — so they
are not committed).

The harvester wrote nothing to the vault and mutated no telemetry file; both are read-only
inputs per its own contract, confirmed by `git status` on the vault repo staying clean
throughout.

## 2. Coverage — measured, not claimed

| | value | command |
| --- | --- | --- |
| sessions scanned | 36 | positional args count |
| transcript recalls / with `recall_id` | 10 / 10 | evidence report `coverage.transcript_recalls*` |
| transcript chains / joined | 5 / 4 | `coverage.transcript_chains*` |
| telemetry pools (`recall` / `hook_recall`) | 11 / 804 | `coverage.telemetry_pools_by_lane` |
| telemetry loads / linked by daemon | 6 / 6 | `coverage.telemetry_loads*` |
| vault ids at snapshot | 1386 | `coverage.vault_ids` |

One transcript chain out of 5 didn't join (no telemetry pool for its `recall_id` inside the
3-day window — the envelope's `ts` likely sits just outside it). This is exactly the
`link-without-pool` gap kind named in the 09-13 doc; it counted 0 here because the harvester
only counts it when a *load* links to a recall with no pool, not when a bare recall fails to
join — a narrower definition than "any unjoined chain," worth flagging as a reporting gap in
its own right, not fixed in this pass.

## 3. Seven classes, three real days, one machine

| Class | transcript | hook |
| --- | --- | --- |
| `served-hit` | 2 | 5 |
| `in-pool-not-selected` | 0 | 0 |
| `genuine-out-of-pool` | 0 | 0 |
| `unindexed-vault-object` | 0 | 0 |
| `vault-gap` | 0 | 0 |
| `external-source` | 1 | 0 |
| `unknown` | 2 | 0 |

Live classes (n ≥ 3, the maintainer's own bench threshold): **none** in either lane at this
sample size. `served-hit` (7 total) is the closest to live and would cross the line with one
more day. Everything else is `observed_thin` or zero.

`unindexed-vault-object`, `vault-gap` and `unknown`-with-full-proof were empty in the
maintainer's own 8-day, two-machine measurement (§9 of the 09-13 doc) too — that pattern
repeats here, on a third machine, at 3 days instead of 8. `genuine-out-of-pool` and
`in-pool-not-selected` were thin-but-present there (1 each on machine A); here they are
zero. Read plainly: on this host, in this window, recall either hit or the chain's evidence
step couldn't be inspected at all — there was no case of "it was searched, it existed, it
just didn't rank."

Hook lane: 804 `hook_recall` pools produced exactly 6 linked loads and 5 classified
`served-hit` (the 6th load resolved to `load-not-found`, verdict `noise` — an id the vault
no longer holds, nothing to classify; this matches the harvester's own accounting-closes
invariant: every load is one record or exactly one named gap, and here it is). The other 798
pools are hint-surfaced-but-never-loaded, which the design correctly does **not** score as
misses (§8 architectural fork: "a recall with no load afterwards is censored, not a miss").

## 4. The two `unknown` transcript chains — what they actually were

Both landed in the gap row `unresolved-evidence` (count 2, 2 sessions, verdict `den`), not
in any of the six proof-bearing classes. This is a different den shape than either machine
in the 09-13 measurement reported (theirs were `envelope-without-recall-id` and
`load-without-link`). Read from the raw transcripts:

- Query: a "root granted — investigate load, pressure and caches" request (2026-09-16, session
  `01958311…`) — recall fired (hook lane, `ts` 13:53:45Z matches `uptime` output printed
  seconds later), but every step afterward was `Bash` (`cat`, `find`, `uptime`, `cat
  /proc/pressure/*`, `tail` a log file). `target-resolve` only knows how to read
  `load_memory`, `Grep`/`Glob`/`find_document`, or a file read inside `--vault`; a `Bash cat`
  of an out-of-vault log is invisible to it, so the chain classifies `unknown` with
  `target.kind: "unresolved", sourceRef: null` rather than `external-source`.
- Query: a single word, the tool's own name, testing the tool itself — same shape, `sourceRef` non-null but
  still unresolved; not investigated further, same den.

This is a real, load-bearing finding about the *harvester's own coverage*, not about recall:
`target-resolve`'s blind spot to `Bash`-tool evidence means any chain whose follow-up
investigation happens through shell commands (which is most of how work actually happens on
this machine) is structurally invisible to five of the six classes. It can only ever land in
`unknown`. Whether recall missed something real in either of these two chains is genuinely
unknown — not "probably fine," unknown by construction.

## 5. Cross-check against `<auto-memory>/*.md`

The owner's hypothesis going in: if the harvester shows `vault-gap` or `genuine-out-of-pool`
for a lesson that's already sitting in this session's own auto-memory (the host-tuning
lessons written before or during these three days), that is the "lost thing" — a lesson that existed but live recall never found it.

Measured answer: **the harvester produced zero specimens in those two classes this window**,
so there is nothing the classifier itself points at. But the cross-check doesn't have to run
through the classifier — it can run directly, file against file:

| auto-memory file (this session's own memory) | written | bastra-recall vault counterpart |
| --- | --- | --- |
| `<note-1>` — a background model server must be a managed unit | — | present, different filename |
| `<note-2>` — a scheduled job trimmed after a cost review | 2026-09-03 | present, same date, different filename |
| `<note-3>` — IRQ and CPU-affinity reservation | 2026-09-03 | present, different filename |
| `<note-4>` — one tool silently restoring another's power limits | 2026-09-05 | present, different filename |
| `<note-5>` — never toggle that service mid-session | 2026-09-05 | present, different filename |
| `<note-6>` — an alert that is expected during this session type | 2026-09-05 | no exact match; the closest vault note is a *different* incident in the same topic area (watcher state, not the expected alert) |
| **`<note-7>`** — a predicate blind to one of two service managers | **2026-09-12** | **no match** — the only topically overlapping vault note predates the incident (`mtime` 2026-09-05, 23:47), so it cannot name a bug fixed a week later |

Five of seven are dual-recorded (same lesson, two stores, different filenames — not a gap).
One is a near-miss (different incident, same topic area). **One is a genuine, confirmed
gap**: the 2026-09-12 predicate-blindness lesson (a predicate that checked only the per-user
service manager and never saw the system-level unit) exists only in this session's own auto-memory. It
was never written into the bastra-recall vault at all.

Important honesty check on method: this gap was found by direct file comparison, not by the
harvester. The harvester's per-chain classes can only fire when a *query happened* and
*evidence followed* in the 3-day window; a vault object that was simply never queried during
that window — because nobody asked about it — produces no chain, no specimen, no class. It is
invisible to this method by construction, the same way the two `unresolved` chains above are
invisible for a different reason. The harvester measures recall-and-then-evidence pairs; it
does not, and by its stated non-goals should not, scan the vault for absent topics on its
own. Finding this gap required knowing what to look for and grepping for it by hand.

## 6. Practical part: what gives signal here, and when to run this

**Hook-lane vs transcript-lane, on this machine, with this data:**
- Hook-lane is the cheap lens — `--events` + `--vault` alone, no sessions needed — and it is
  where the volume is (804 pools vs 11 in three days). But because it only classifies
  *linked loads*, not every surfaced hint, its classified count stays tiny (6) no matter how
  much telemetry exists. It is good for the heatmap (§7 below) and for catching
  `load-not-found`/`load-without-link` dens cheaply. It cannot classify anything for chains
  whose evidence never became a `load_memory` call.
- Transcript-lane is expensive (needs the actual session files, and `target-resolve` only
  understands a handful of tool shapes) but is the only lens that carries human intent — the
  literal query text is what let §4 and §5 above be investigated at all. Without it, the two
  `unknown` chains and the predicate-blind gap would not have been traceable to anything.

**Which of the seven classes are alive on this host:** only `served-hit` is anywhere near
live (n=7, threshold 3). `external-source` (1) and `unknown` (2) are `observed_thin`.
`in-pool-not-selected`, `genuine-out-of-pool`, `unindexed-vault-object`, `vault-gap` are all
empty here — same as on the maintainer's two machines for the latter three, but notably
*emptier* than machine A's 8-day measurement for the first two (which had 1 specimen each).
Reading that plainly: at 3 days this host either doesn't generate those cases yet, or 3 days
is below the specimen floor for them — the 09-13 doc's own acceptance criterion (`n < 3` is
`observed_thin`, never asserted live) applies to the *measurement itself*, not just its
findings.

**When to run this:** the evidence report takes seconds once inputs exist, but assembling
the right session-file list and reading transcripts by hand (§4, §5) is the expensive part —
it is not something to automate into a background timer. This matches the 09-13 doc's own
framing: "the measurement lives in the report over real data, which the tests do not
replace." Run it after a dense multi-day stretch of real work (like these three days), not on
a fixed schedule, and budget human reading time for whatever lands in `unknown` — that is
where this run's one actionable finding (§4) came from.

## 7. Heatmap, same shape as the maintainer's own finding

111 hubs (≥3 sessions surfaced), 320 surfaced-never-loaded, top row surfaced 198 times across
20 sessions and loaded 0 times. Same reading as §9 of the 09-13 doc: this is a density for
#479's hint-suppression calibration, not a verdict — a memory surfaced constantly and never
loaded might be doing its job passively (informing ranking) rather than needing a click.
`proposals` came back empty (`targets: 0, episodes: 0`) — no hot paths reached the 2-session
"established" threshold in this window; consistent with 3 days being short for that signal.

## 8. What this run does not claim

Same non-goals as the source design: no daemon/MCP/hook/ranking write, no model call, no
replay beyond the recorded pool depth. Additionally, specific to this run: it does not claim
recall missed anything in the two `unknown` chains (§4 — genuinely undetermined, not "clean").
It does not claim the vault is missing lessons in general — five of seven cross-checked files
were fine. It claims exactly one measured gap (§5) and names the method limits that would let
a second one hide.
