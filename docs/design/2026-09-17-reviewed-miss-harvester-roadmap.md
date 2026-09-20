# Reviewed-miss harvester: first run on a pedestal, roadmap forward

Follow-up to `docs/design/2026-09-17-reviewed-miss-harvest-three-days-measured.md` (the
first real 3-day run, `1660eb4`) and to the Bash-evidence follow-up (`2060053`, `2d282ac`,
this same branch). The owner's framing, verbatim intent: expensive manual harvester runs are
not just bug-hunts — each one is a rung toward a cheap, automated pattern-recognition
mechanism (the same ambition named for `harness what`'s own intent-routing). Put the first
run on a pedestal (what mechanism it proved), then split what's left into two tracks so the
*next* run doesn't re-litigate what this one already settled.

## 1. What the first run proved as a mechanism (pedestal — treat as settled, not re-verify by hand)

- **The CLI shape and cost profile are real and repeatable**: hook-lane (`--events --vault`,
  no sessions, cheap, high volume — 804 pools/3 days) vs transcript-lane (needs session
  files, expensive, carries human intent via literal query text). Both lanes ran clean twice
  now (the original 3-day run and this follow-up's rerun) with identical inputs producing
  identical coverage numbers (36 sessions, 11/804 pools) — the harvester is deterministic and
  idempotent on unchanged inputs, which is a precondition for trusting any future diff.
- **The seven-class taxonomy classifies what it says it classifies**: `served-hit` for both
  lanes, `external-source`, and now (this follow-up) a demonstrated `unknown → external-source`
  flip on a synthetic fixture reproducing the doc's own scenario — proven by a real
  before/after test, not asserted.
- **Bash single-file reads are no longer structurally invisible.** `target-resolve` now
  resolves `cat FILE`, `head`/`tail FILE` (with self-contained flags), `grep PATTERN FILE`
  the same way it resolves a `Read` tool call. This is a **tier-1, proven-offline** capability
  as of `2d282ac` — a future harvester run that reports `unknown` for a chain whose only
  evidence step is one of these four shapes is a *regression*, not a fresh discovery, and
  should be treated as a bug report against the harvester, not written up as a new gap.
- **The hand cross-check method (vault file ↔ auto-memory file, by name/date) works and
  found the one real gap this run has**, `<a-note>`
  (already migrated into the vault tonight, separately). This method is not automatable by
  the harvester itself (stated non-goal: it doesn't scan the vault for absent topics), but as
  a *manual* pedestal technique it is now proven once and reusable verbatim next time.

## 2. What this same follow-up run proved the *original* doc got wrong — keep this honest

Re-running the harvester and reading the raw transcripts for the two `unknown` chains showed
`docs/design/2026-09-17-reviewed-miss-harvest-three-days-measured.md` §4 misattributed both
of them to the Bash blind spot. Neither actually was:

1. Session `01958311…` — the real cause is a **malformed `load_memory({ids: [...]})` call**
   (plural key, JSON-string array, not the documented singular `id`). The schema rejects it,
   but the harvester had already spent the evidence slot on the failed call as `opaque,
   sourceRef: null` before the correct singular retry could be seen. Bash calls in that
   session were all pre-recall, unrelated to the evidence gate.
2. Session `14bf9698…` — evidence resolved correctly (valid `load_memory` id), but the
   chain's `recall_id` never joined a telemetry pool inside the 3-day window — a coverage/join
   gap, not a parsing gap.

Neither was fixed in this pass (correctly out of scope — see track A below). The lesson to
keep, not just the finding: **a stated cause in a "measured" doc still needs re-verification
against raw evidence before the next person builds on top of it as fact** — this doc's own
§1 pedestal claims are only trustworthy because they were re-run, not just read.

## 3. Track A — mechanism hardening (fix what THIS run surfaced, didn't fix)

Backlog, in the order a future session should pick them up, each with its own scope:

1. **`load_memory({ids: [...]})` silently eats the evidence slot on a malformed call before
   a valid retry gets a chance.** This is arguably a real robustness gap in the harvester's
   evidence-gating loop (first attempt wins the slot even on schema failure) — worth checking
   whether the *actual* `mcp__bastra-recall__load_memory` tool itself also silently accepts
   or confusingly rejects `ids` vs `id`, since a live model hitting this same schema mismatch
   mid-session would have the identical retry-blocked experience the harvester now shows us
   in miniature. Two possible fixes at two different layers — scope narrowly, don't conflate.
2. **Telemetry pool-join gap** (`recall_id` with no pool in-window) — session `14bf9698…` is
   a live specimen; investigate whether the join window itself is too narrow (`ts` just
   outside `--since N`) or a genuine dropped-pool bug.
3. **The `link-without-pool` vs "any unjoined chain" reporting gap named in the original
   doc's §2** — the harvester only counts the narrower case; still open.
4. **Specimen scarcity for `unindexed-vault-object` / `vault-gap` / `genuine-out-of-pool`**
   — empty at 3 days on this host and empty-to-thin on the maintainer's own two machines at
   8 days. Not yet known whether this is "these classes are rare" or "3-8 days is below the
   specimen floor" — needs a longer window, not more code, to resolve.

## 4. Track B — new patterns, and the intent-parser tie-in

The owner's own framing: each future harvester run should do double duty — validate that
Track A/tier-1 findings stay fixed (regression check, not rediscovery) **and** hunt for a
new, previously-unseen evidence/miss shape. Over enough runs, the *set of recognized shapes*
(the Bash-evidence patterns added tonight are the first entries) becomes training material
for a cheaper, more general pattern-recognition mechanism — the same ambition named tonight
for `harness what`'s own intent-routing (currently lexeme/structure-triggered, not intent-
matched). This is not a claim that the two mechanisms merge technically; it is a claim that
the *method* — expensive manual runs first, until enough real shapes accumulate to justify a
cheap curated layer — is the same method, and should stay named as one roadmap rather than
rediscovered twice under two different labels.

**Concretely, for the next run:** don't manually re-diagnose `served-hit`, `external-source`,
or single-file Bash reads if they show up correctly classified — that's tier-1 working as
proven. Spend the expensive transcript-reading time only on whatever lands in `unknown` or
`opaque`, which is where every real finding so far (§4 of the original doc, §2 of this one)
has actually come from.

## 5. Status

Code: `local/pr454-cleanup-2026-09-17`, commits `2060053`, `2d282ac` — local only, not
pushed (per standing rule, this branch stays local until an explicit push decision). Tests:
2910 total (2906 baseline + 4 new), 3 pre-existing unrelated failures unchanged, zero
regressions. This doc: no code, no vault write, no telemetry mutation — reference only.
