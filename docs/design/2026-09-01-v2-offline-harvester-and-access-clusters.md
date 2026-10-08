# V2 offline harvester & warm access-clusters — local design, holding on #454/#459

**Status: local plan only.** Nothing in this file has been applied to code, and
nothing here is committed or pushed. It exists to have the workstream A/B
design ready before you pick it back up — not to move it forward on its own.

## 1. What is on hold, and why

PR #454 bundled two things: a runtime policy rewrite (recall gated on "can you
name the missing fact") and the reviewed-miss harvester that could justify it.
Daniel (`n0mad-ai`) declined to merge for three reasons — evidence arriving
after the policy it should justify, the SKILL.md description losing its
CAPTURE triggers as collateral damage, and a cross-client split (Cursor rules
+ the plugin skill still say "recall before acting" and don't move with
`packages/skill/SKILL.md`). He proposed a 3-way split:

- **(a)** the uncontroversial prohibitions alone (no recall on logs / repo
  state / generic knowledge, no paraphrase retry) — small, discussable on its
  own, CAPTURE description untouched.
- **(b)** the harvester alone, once the arg-index bug and helper duplication
  are fixed — changes no runtime behavior, could land early.
- **(c)** the gate itself — deferred until #455 (one canonical instruction
  source) lands and the harvester has produced numbers from real sessions.

He filed #455 (canonical source, pure restructuring) and #456 (drift/CI/
packaging gates so a policy change can't land while a client projection is
stale), both v1.0. He also filed #459, which reframes your original intent —
mechanical detection of genuine out-of-pool/unindexed/vault-gap cases plus
repeatedly-observed warm access paths, as **reviewable proposals**, not a
live policy write — as a V2, evaluation-gated issue.

**Holding all of it**, not just (c): (a) stays off because touching
`SKILL.md` at all right now reopens the exact split-brain problem #455/#456
exist to close first. (b) stays off because it's not ready and you'd rather
pick the moment. This document is what makes (b) fast to resume without
redoing the analysis — it does not start it.

**Nothing here proposes editing** `packages/skill/SKILL.md`,
`packages/skill/cursor-rules.mdc`,
`plugins/bastra-recall/skills/bastra-recall/SKILL.md`,
`tool-defs-memory.ts`, `mcp-forwarder.ts`, or `session-assembler.ts`. No
commit, no push, no PR update, no issue/PR comment. Full stop until you say
otherwise.

## 2. Fix list for workstream A (documented, not applied)

Daniel's three code findings, verified against current `HEAD`
(`recall/gate-durable-gaps`, 63b4c7f):

| # | Where | What's actually wrong | Fix |
| --- | --- | --- | --- |
| 1 | `packages/daemon/scripts/harvest-reviewed-misses.ts:26` | `valueAt = new Set([outAt+1, rootAt+1, zoneAt+1])`. When `--out`/`--relative-to`/`--zone` are all absent, `outAt`/`rootAt`/`zoneAt` are all `-1`, so `-1+1 = 0` lands in the set three times over — and `args[0]`, the first positional session file, gets filtered out by `!valueAt.has(index)`. One file, no flags → empty `inputs` → `usage()`, exit 2. | Only add an index to `valueAt` when its flag index is `>= 0`. |
| 2 | `reviewed-miss-harvest.ts:101-117` vs `reviewed-miss-judge.ts:134-144` | Both implement `explicitMiss`, not identically. Harvest: regex-test the raw string first, `JSON.parse` only as a fallback when the regex misses. Judge: `JSON.parse` first, regex only in the `catch`. For a string that is valid JSON *and* whose raw text happens to satisfy the regex before parsing changes what gets inspected, order decides the verdict — structural signal (`weak_result`, empty `hits`) should always win over the free-text regex, since that's the actual evidence contract in `ReviewedMissCandidate.evidence.recall`. | One shared `explicitMiss`, judge's order (structural first, regex fallback only on parse failure), extracted to a shared module. |
| 3 | `reviewed-miss-harvest.ts:190` | `pending = { ..., explicit: explicitMiss(record), ... }` runs on the **assistant** record that just emitted the `tool_use` — that record only ever carries the request, never a result, so `weak_result`/`hits` are never present and this call is always `false`. The real value is set two lines later via `pending.explicit ||= explicitMiss(record)` once the matching `tool_result` arrives in a `user` record. Harmless (the initial `false` never survives the `||=`), but reads as if it does something. | Initialize `explicit: false` directly, drop the dead call, keep the comment explaining why. |
| 4 | both files | ~8 identical helpers beyond `explicitMiss`: `hash`, `humanIntent`/`humanText`, `toolUses`, `isRecall`, `isEvidenceRead`, the tool-result-matching predicate, the content-text extractor. | One `reviewed-miss-shared.ts` (or similar) importing into both `harvest.ts` and `judge.ts`. This is what stops the two from drifting the way #1-3 already show they do. |

None of this is applied. It's the exact list to work from when workstream A
is re-proposed as its own PR per Daniel's option (b).

## 3. Workstream A — deterministic reviewed-miss harvester (per #459)

### 3.1 The six-way classification is new work, not a relabel

`classifyReviewedMiss()` (`reviewed-miss.ts`) is a two-way *disposition*
router: it takes an already-human-labeled `reviewed-recall-miss/v1` record
and routes `vault-memory` → `bridge-reach`, `external-source` →
`note-candidate`. It does not itself decide *which* of those a case is — a
human or the `--judge` path does that upstream, and only after
`harvestReviewedMisses`/`extractReviewTraces` narrowed everything nonempty
down to `needs-relevance-label`.

Issue #459 asks for a classification a full step earlier and finer-grained
than "human labels it eventually": six buckets, only four of which can ever
become a proposal.

| Bucket | Definition | What it takes to detect mechanically |
| --- | --- | --- |
| in-pool / not selected or not loaded | Target was present in the recorded candidate pool for that call. | The Recall result needs to carry the actual candidate id list (or hashed ids), not just `weak_result`/`hits.length`. Today's harvester never captures this — it only records a boolean. |
| genuine out-of-pool | Target exists in the indexed vault at the registered depth, but did not surface in the recorded pool. | Requires (a) the pool from the same call as above, and (b) an index snapshot from ~observation time to check whether the target's embedding/BM25 entry existed and at what rank it would have scored — i.e. a replay-against-frozen-index capability, not just log parsing. |
| unindexed vault object | Target exists on disk in the vault but was absent from the index snapshot, for an explainable reason (new file not yet reindexed, malformed frontmatter, excluded path). | Filesystem enumeration of the vault at observation time *and* the index snapshot, diffed. Explainability is a hard requirement per #459's acceptance list — "a claimed vault gap proves which registered memory/document indexes were checked." |
| vault gap | The later evidence has no canonical memory/document representation anywhere in the registered vault snapshot. | Same diff as above, target absent from both index and filesystem enumeration. |
| external-source resolution | Task was correctly answered from current repo/runtime/upload/web evidence and should not become durable memory. | This is what `classifyReviewedMiss`'s `external-source` branch already handles once labeled — the harvester's job is to *not* misroute this bucket into a vault-gap proposal just because Recall came back empty. |
| unknown / needs-relevance-label | Transcript can't prove the later read answered the earlier intent. | The existing fail-closed default when nonempty/ambiguous. |

Only the first four can ever become a proposal (in-pool/not-loaded feeds a
ranking observation, not a note; external-source explicitly cannot). This is
the load-bearing distinction from #459's "classification must come before
the cue" section — it's also why workstream A is meaningfully bigger than
"fix the three bugs and ship it": it needs a frozen index/vault/profile
identity per observation, which nothing in the current harvester captures.

### 3.2 Identity freezing

`harvestReviewedMisses` currently hashes `sessionIdentity` (the file name)
and, per-candidate, `sourceRef` (a hash of the tool input). To decide
in-pool vs out-of-pool vs unindexed at *observation time*, each candidate
needs an additional frozen triple, hashed the same way (opaque refs only,
matching the existing `sha256:` convention so nothing here regresses the
"no raw private path" guarantee):

- **index identity** — a content hash or version tag of the index snapshot
  live at call time (the daemon already versions its ChromaDB
  collections/SQLite state; reuse whatever it already exposes rather than
  inventing a new versioning scheme).
- **vault identity** — a content hash of the vault directory listing (paths
  hashed, not stored) at call time, for the unindexed/vault-gap diff.
- **profile identity** — whatever ranking profile (hybrid weights, α, model)
  was active, since "out-of-pool" is profile-relative — the same target can
  be in-pool under one profile and out under another, and a proposal that
  doesn't name the profile it was observed under can't be reproduced or
  regression-tested later.

Without this triple, "genuine out-of-pool" and "unindexed" are
unfalsifiable claims — exactly the failure mode #459's acceptance criteria
guard against ("a claimed out-of-pool case names the registered pool depth
and proves the reviewed target existed in that index snapshot").

### 3.3 What stays exactly as designed today

- Join by `tool_use_id`, never adjacency — already correct, already has
  adversarial test coverage (see the 2026-08-31 audit doc's table).
- Nonempty Recall stays `needs-relevance-label`; only an explicit
  weak/empty result can become a `candidate` — already correct, still the
  right default even with the six-way split layered on top (it just means
  more of the buckets above resolve to `unknown` until the index/vault
  identity plumbing exists).
- Hash source identities, exclude scratch/worktree/tool-result paths before
  ranking, never render the zone root — already correct, carries forward
  unchanged.
- The `reviewed-recall-miss/v1` → `classifyReviewedMiss` seam stays the
  final disposition step, now fed by the six-way classifier's output
  instead of a flat human label.

## 4. Workstream B — warm access-path sidecar (per #459)

#459 is explicit that "warm path" must be an **observed, versioned access
transition or co-access relation** — filesystem folder proximity is
explicitly named as *not* a retrieval signal, and if relative-path proximity
is the actual hypothesis it has to be tested as its own thing, separately.
That rules out the simplest version of what a "warm relative path" sounds
like (cluster by directory) — it has to be built from observed traces.

### 4.1 Data model

A read-only sidecar, additive to the vault, never mutating it:

```
edge: {
  intentClass: <hashed/bucketed query signature>,
  candidate: <memory/doc id or hashed source ref>,
  target: <the id the session actually used>,
  support: <count of independent sessions showing this edge>,
  recency: <most recent observation timestamp>,
  sourceSessions: [<hashed session ids>],
  provenance: [<episode id>, ...],
  generatorVersion: <this sidecar's own version>,
}
```

- **One episode proposes an edge, never establishes a cluster** — per
  #459's acceptance list, clusters require repeated, independently observed
  support. `support` starts at 1 and a cluster-forming threshold (to be
  picked during evaluation, not guessed here) gates promotion from "edge"
  to "candidate cluster."
- **Hub control**: high-degree nodes (a "user preference" memory, a project
  root doc, anything that shows up as `target` across unrelated
  `intentClass` buckets) get down-weighted or excluded from cluster
  formation — otherwise generic nodes connect everything and the cluster
  signal collapses to noise. Concretely: cap an edge's contribution to
  cluster confidence by the inverse of the target's overall degree, the
  same idea as TF-IDF down-weighting a common term.
- **Every proposal is fully attributed**: target id, source episode ids,
  generator + version, support, confidence, `derived_at`, a staleness
  basis. No anonymous or unattributed edge is allowed to influence
  anything, per the acceptance list.

### 4.2 Trust boundary against `recall_when`

Authored `recall_when` (what a human or the model writes deliberately into
a memory's frontmatter, see `save_memory`'s own `recall_when` field) and a
derived cluster cue are **different trust classes** and must stay visibly
different:

- The sidecar can *suggest* a `recall_when` phrase to a human curator.
- It never writes one automatically — no code path from sidecar output to
  a memory file's frontmatter without a human in the loop.
- Ignoring the sidecar entirely must leave retrieval byte-for-byte
  identical to baseline — this is an acceptance criterion (#459), and it's
  also the honest description of what "read-only, proposal-only" has to
  mean operationally: no code path reads the sidecar at query time until a
  cluster has passed its own evaluation gate (§5) and someone has
  explicitly wired it in.
- Invalid or stale target ids in the sidecar fail closed — a dangling
  reference is dropped, never treated as a weaker version of a real hit.

## 5. Evaluation contract, operationalized

#459's contract, restated as what would actually need to be measured before
anything here can go live:

- **recall@pool@N before Recall@k/MRR.** A cue can shrink the candidate
  pool a ranker sees while every ranking metric downstream looks fine —
  the failure is upstream of ranking, so the metric has to be too.
- **Two slices, every time a cue is evaluated**: in-vocabulary (queries
  that resemble what produced the cue) and seed-dissimilar/out-of-cue-
  vocabulary (queries that don't). A cue that only helps the first slice is
  memorizing its own seed episode, not generalizing.
- **Lift is relative to a registered null/foreign baseline**, not raw
  before/after — a foreign proposal (one built from unrelated data, same
  shape) has to be run through the identical pipeline so "the cue helped"
  isn't confounded with "any structured hint helps."
- **Held-out kill test uses arrivals dissimilar to the seed episode** — the
  standard held-out-transfer gate #129 already owns; reusing arrivals that
  resemble the seed only proves the layer can rescue itself.
- **No-regression gate on near/previously-successful cases** — a cue must
  not be allowed to win on the cases it was designed for while quietly
  costing accuracy on cases that already worked.
- **Non-use is censored feedback, not a negative label.** A proposal that
  nobody acted on says nothing about whether it was wrong — that's a
  missing-data problem, not evidence against the cue.
- **No live effect until #129's transfer/regression gate and #391's M2
  controller gate both pass on adequate real volume.** This document
  doesn't get to define "adequate" — that's #129/#391's call, and the
  right amount of caution here is to build workstream A/B so that they
  produce exactly the evidence those gates need, not to pre-judge the
  threshold.

## 6. Instead of a system-prompt gate — where "durable gap" detection could actually live

Daniel's core objection to PR #454's (c) is structural, not stylistic: *"You
do not find a stored lesson about CSS specificity by first formulating 'I am
missing a lesson about CSS specificity' — you find it because you reach into
memory blind before the edit."* A memory system that requires the caller to
already know what it's missing has defined away the class of hit it exists
to catch. That objection doesn't go away if the wording is softened — it's
true of *any* instruction that asks the model to self-certify "I know I need
this" before it's allowed to look. So the fix isn't a better sentence in
`SKILL.md`; it's moving the decision to a place that doesn't require the
model to introspect correctly about its own gaps. A few concrete directions,
roughly in order of how directly they answer that objection:

1. **Cost accounting instead of instruction compliance.** #458's governor
   (one cumulative cross-lane context budget per session) is the honest
   place for "don't call recall so often" to live — as a budget the server
   enforces, not a rule the model is trusted to self-apply. A budget check
   doesn't need the model to know in advance whether a call is justified;
   it just needs to know how many tokens are left and what a call costs.
   This also can't drift per-client the way prose in three separately
   maintained files just did — a budget enforced daemon-side applies
   identically to Claude, Cursor, and the plugin without anyone hand-
   copying a sentence three times.

2. **A cheap pre-filter the server runs, not the model.** The auto-inject
   mechanism this project already has (disabled 2026-05-23 per the local
   CLAUDE.md) is closer to the right shape than an instruction: the daemon
   computes a cheap candidate/hint *before* the model has to decide
   anything, and the open question becomes "is this hint worth reading,"
   not "should I have known to ask." That reframing turns a policy problem
   into a presentation problem — which is #424's territory (presentation
   experiments), not a rule to phrase correctly. It also sidesteps the
   introspection objection entirely: the model never has to certify a gap
   it can't see.

3. **Let the harvester set the policy instead of asserting one.**
   Workstream A's whole point is to accumulate real evidence about when a
   recall call was wasted vs. when a skipped one would have caught
   something. That evidence — once it clears #129/#391's gates — is what
   should inform any future gate, precisely because it doesn't require the
   model to have predicted its own gap; it's measured after the fact,
   over many sessions, by a mechanism that isn't trying to reason about its
   own ignorance in the moment. This is the reverse of #454's ordering
   (policy first, evidence maybe) and it's also the reverse of "phrase a
   better instruction" — it replaces an asserted heuristic with a measured
   one.

4. **Treat cross-client parity as a code/generation problem, not a prose
   problem.** #455/#456 already point this way for the existing gate
   language; the same applies to anything workstream A/B eventually
   produces. If a behavior needs to be identical across Claude's SKILL.md,
   Cursor's `.mdc` rules, and the plugin skill, it should be generated from
   one source (or enforced by a shared runtime check) rather than typed
   three times by hand — hand-copied policy prose is exactly what drifted
   three ways inside of one PR cycle here.

None of this is a counter-proposal to merge instead of (c) — it's the answer
to "where would this go if not into a system prompt," for whenever the gate
question comes back up. The short version: move the decision out of "model
must self-report an epistemic state it structurally can't have" and into
either a budget the server enforces, a hint the server computes and offers
cheaply, or a policy derived from measured evidence — never into a longer or
better-worded instruction asking the model to know what it doesn't know.

## 7. Explicit non-actions right now

- No edit to `SKILL.md`, `cursor-rules.mdc`, the plugin skill, or any
  runtime source file.
- No fix applied for the three code findings in §2 — documented only.
- No new code for the six-way classifier or the access-path sidecar —
  designed only.
- No commit, no push, no PR update, no comment on #454 or any of
  #455-#459.
- Resuming any of this is a separate, explicit decision — this document is
  the head start, not the start.
