# @bastra-recall/eval — `recall_when` marginal-lift ablation

Offline counterpart to the online USE-rate (#69). Where the M0 baseline
(`scripts/eval.ts`) queries each memory with its **own** `recall_when` phrase —
an upper bound that's circular by construction — this harness measures how
**load-bearing** the trigger field actually is, under paraphrased queries.

## What it measures

Two BM25 indexes over the **same** vault, differing on exactly one dimension:

| arm | `recall_when` |
|---|---|
| **control** | stripped from the searchable fields |
| **treatment** | indexed at its production weight (core: `×5`) |

Every other field weight + search option is pinned to
[`core/src/search.ts`](../core/src/search.ts) (a drift-guard test fails if they
diverge). Queries are **paraphrases** of each memory's trigger — held out,
sharing as few literal tokens as is realistic — so we test whether a memory
still surfaces when a future session phrases the situation in its own words.

```
marginal-lift@k = Recall@k(treatment) − Recall@k(control)
```

A no-trigger **anti** slice records the median top-1 score on off-vault queries,
bounding false-positive surfacing — adding the trigger field must not inflate it.

## Run it

```bash
# bundled synthetic vault + cases (self-contained, CI-runnable)
npm run lift --workspace=@bastra-recall/eval
# or, from repo root:
npm run eval:lift

# tune
npm run lift -- --boost 5 --k 3

# against a real vault with your own paraphrases:
BASTRA_VAULT_PATH=/path/to/vault \
  npm run lift -- --cases my-cases.json --out lift.json
```

## ⚠️ The bundled number is a mechanism demo, not the headline

`fixtures/eval-vault` is a **tiny synthetic vault** (10 memories) whose only job
is to make the harness self-contained and reproducible. The lift it reports
shows the harness *computes correctly* — it is **not** evidence about the real
lift on a production vault. A citable number comes from running the ablation on
a real vault (e.g. the 59-memory vault behind the M0 baseline) with hand-written
paraphrases. Treat the synthetic figure as a smoke test, not a result.

## Simulated-user survival (`npm run personas`)

`marginal-lift` answers *"does the trigger field help?"* with one paraphrase
set. The companion harness asks the sharper, production-shaped question on the
**same** control/treatment indexes:

> `recall_when` is written at **save** time — a prediction of how a future
> session will phrase the situation. The query is formed at **recall** time, in
> that session's own words. **How much of the lift survives when the recall-time
> query drifts off the save-time prediction?**

We model the recall-time query distribution with **N simulated user personas**
(junior / senior / terse / verbose / non-native / concept-namer / …), each
phrasing every memory in its own voice. Each query gets a continuous overlap
score against the gold memory's `recall_when` tokens, then:

```
near  = query shares trigger vocabulary (overlap ≥ cut)   → prediction hit
far   = query uses different words      (overlap < cut)   → prediction missed
survival = marginal-lift@k(far) / marginal-lift@k(near)
```

`survival ≈ 1` → the trigger generalizes past its own wording (load-bearing).
`survival ≈ 0` → it only helps when you already used its words — i.e. the lift
sits closer to the circular M0 regime than to real recall. The report also
prints the **Recall@k envelope across personas** (the robustness spread) and a
**persona-diversity** number.

```bash
npm run personas --workspace=@bastra-recall/eval
npm run personas -- --k 3 --near 0.30
BASTRA_VAULT_PATH=/path/to/vault \
  npm run personas -- --personas my-personas.json --out survival.json
```

### Why simulated, not hand-written?

The issue thread asks for *hand-written* paraphrases, and that's the right
instinct for an **independent** probe. But for this product it is ecologically
backwards: **nobody hand-writes the memories** (the AI saves them) **or
hand-phrases the recall query** (the AI forms it). Production is model-mediated
on *both* ends, so simulated queries are the faithful test; hand-written ones
test a path that never happens. The default retriever arm is lexical BM25 (no
embedding space), so the only contamination risk from LLM-authored queries is
**trigger-vocabulary leakage** — and the overlap score measures that directly,
per query. Since #103 the harness also runs a **hybrid arm** (production
`recallHybrid` with per-arm dense embeddings) and an **expanded arm** (BM25 +
write-time `recall_when_expanded`, #117) via `--arms lexical,hybrid,expanded`. Two guards keep it honest (see `__tests__/persona-diversity.test.ts`):
the personas must be **distinct voices** (no mode collapse) and must **span the
near↔far axis** (the gradient is emergent, not hand-binned).

> Same caveat as above: the bundled `fixtures/personas.json` runs against the
> synthetic vault — a mechanism demo, not a headline. A citable survival number
> comes from real personas against a real vault.

## Cases format (`fixtures/cases.json`)

```jsonc
{
  "paraphrased": [
    { "id": "<memory id in the vault>", "label": "short handle",
      "paraphrases": ["query phrased in different words", "..."] }
  ],
  "anti": [
    { "query": "off-vault topic with no relevant memory", "note": "why" }
  ]
}
```

Unknown ids (a renamed/deleted memory) are reported and skipped, not counted as
misses.

---

## Absence honesty (`src/absence-honesty.ts`)

Every MCP client is told to *"call recall before any other lookup tool"*. Against
`grep` that claim has two halves, and this harness measures the half that had no
number: **when the vault does not hold a fact, does recall say so?** `grep`
answers with exit code 1. A ranked list always has a first element, so recall has
to signal absence explicitly or the caller cannot tell a hit from a
rank-1-of-nothing.

Leave-one-out over a real vault, three arms on the same corpus:

| arm | query | gold | what it measures |
|---|---|---|---|
| **present** | the memory's own `recall_when` | in the vault | plumbing control — circular by construction, an upper bound |
| **absent** | the same trigger | **held out** | do `weak_result` / `no_home` fire? |
| **paraphrase** | `--cases` — the fact asked in words the memory does not contain | in the vault | retrieval vs a lexical baseline, and the false-positive cost of any anchor rule |

The paraphrase arm needs hand-written held-out queries. Without `--cases` it falls
back to a sentence lifted from the body — that is a **quotation**, which a literal
search wins by construction; treat the fallback as a plumbing check, never as a
result.

Two baselines stand in for "grep": **AND** (every content word in one file — the
`grep -q` signal) and **ranked** (top-k by distinct-term coverage — what an agent
does when the AND comes back empty).

```bash
BASTRA_VAULT_PATH=/path/to/vault \
  npx tsx src/absence-honesty.ts --n 40 --k 5 \
    --cases goldset/held-out-paraphrases.example.json --out honesty.json
```

Only memories that already carry a persisted vector are staged, so the dense leg
is identical across arms and no backfill runs mid-measurement. `--out` keeps the
per-hit `matched_terms` / RRF ranks, so a candidate anchor rule can be swept
offline without paying for the index rebuilds again.

## Pool depth (`src/pool-depth.ts`)

`absence-honesty` reports hit@5. That number cannot tell a **retrieval** failure
(the memory is nowhere near the top of either arm — nothing downstream can
rescue it) from a **ranking** failure (it is in the pool at depth 8 and only the
cut hides it). Different fixes, and only one of them is cheap.

One index, one pass, the gold's rank in the BM25 arm, the dense arm and the
fused list, measured to depth 50:

```bash
BASTRA_VAULT_PATH=/path/to/vault \
  npx tsx src/pool-depth.ts --cases goldset/held-out-paraphrases.example.json --depth 50 --out pool.json
```

The split it makes is the useful part: **the gold is in one arm's top-5 or the
other's** far more often than the fused list returns it. That gap is combination
loss — it is the cheap kind, and `--out` dumps both ranked lists so alternative
fusions can be swept without re-running the arms. That sweep is what pointed at
`RRF_K`; the number that justifies the change is on a public corpus, below.

## The fusion constant on a public corpus (`src/rrf-k-beir.ts`)

A measurement on your own vault can start an investigation but cannot end one:
nobody else can rerun it, and the vault it describes is the thing you are not
publishing. So the claim about `RRF_K` is settled on BEIR/NFCorpus instead —
3 633 documents, 323 judged test queries, graded relevance, real users' queries,
and a hard task by design.

```bash
# BEIR, CC BY-SA 4.0
curl -sLO https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip && unzip -q nfcorpus.zip
npx tsx src/rrf-k-beir.ts --data ./nfcorpus --split test --paired 5,60
```

Production arms (real `SearchIndex`, real `EmbeddingIndex`), both arm lists
computed once per query and reused for every k, so only the combination moves:

| k | nDCG@10 | recall@10 | hit@5 |
|---:|---:|---:|---:|
| 1 | 0.3570 | 0.1796 | 66.9% |
| 3 | 0.3586 | 0.1794 | 66.6% |
| **5** | **0.3572** | **0.1789** | **66.9%** |
| 10 | 0.3570 | 0.1804 | 67.2% |
| 30 | 0.3497 | 0.1743 | 65.3% |
| 60 | 0.3494 | 0.1739 | 64.7% |
| 100 | 0.3490 | 0.1738 | 65.0% |

Paired per query, k=5 against k=60: **+0.0079 nDCG@10, 95% CI [0.0018, 0.0142],
bootstrap p=0.0108, sign-flip permutation p=0.0111** — better on 88 queries,
worse on 57, unchanged on 178. The dev split is positive but does **not** clear
the same bar: **+0.0061, CI [-0.0001, 0.0124], p=0.0526**. One split
significant, one not. 1–10 is a plateau, not a spike, so the exact value inside
that band is not load-bearing.

> Those p-values are the second set. The first run shipped a bootstrap whose
> RNG was `(s * 1103515245 + 12345) & 0x7fffffff` — in JS that multiply reaches
> 2.4e18, past `Number.MAX_SAFE_INTEGER`, so the low bits round away before the
> mask: period 10 466, 15 824 distinct values, 10 k resamples cycling one
> sequence ~309 times. It reported p=0.0012 / p=0.0128 and "significant on two
> independent splits". Corrected to mulberry32, the dev split stops clearing
> 0.05. Same measurements, weaker evidence.

Two numbers the harness prints that belong next to the table: the **dense arm
alone** scores 0.3577 — above this fusion at k=5 (0.3572), below it at k=3
(0.3586) — and the bm25 arm alone 0.2909. On this corpus the fusion does not
clear its own best arm at any k. What the constant buys is a fusion that beats
the fusion that shipped, at every cut; it does not make the fusion worth having
here. That line is printed on purpose, and quoting the k table without it would
be a selective read of the same output.

Small effect, honestly. What makes it worth the constant is that it is free and
that the arithmetic behind it says the shipped value was doing something nobody
intended — see `core/__tests__/rrf-damping.test.ts`.

## LongMemEval, the external arm (`src/longmemeval-run.ts`)

`rrf-k-beir.ts` settles a constant on a public corpus, but BEIR is generic IR —
passages and topical relevance. It says nothing about long-horizon *memory*
retrieval, which is what this product is. Every other number here is measured
against our own vault: the gold sets are harvested from it and the persona
queries are generated out of our own `title` + `summary`. Those answer "did this
change help?"; none of them can answer "are we good?".

LongMemEval (ICLR 2025, arXiv:2410.10813, MIT) is the yardstick the field
settled on. Two recent systems publish headline retrieval numbers on it, and
this arm exists to be placed next to them — see
`registrations/foreign-figures.json` for the citations and
`registrations/longmemeval-run.json` for the registered protocol and the
measured results.

```bash
packages/eval/scripts/fetch-longmemeval.sh          # MIT, ~265 MB, no auth
npm run longmemeval --workspace=@bastra-recall/eval -- \
  --corpus ~/.cache/longmemeval/longmemeval_s_cleaned.json \
  --arms bm25,hybrid --k 20 --out /tmp/longmemeval.json
```

### The comparison

The two reference harnesses do not share a protocol with each other, so one
configuration cannot be comparable to both. Rather than publish one number and a
caveat, the arm runs a configuration per comparator. Every row below is
LongMemEval-**S (cleaned)**, 500 questions, a fresh index per question over that
question's own ~48 sessions, **session** granularity, `recall_any@k`, all 500
questions scored with the abstention items kept, no reranker and no LLM at
either end. What differs is only what differs between the reference harnesses:

| configuration | turns | `top_k` | **hybrid R@5** | R@1 | R@3 | bm25 R@5 | stands next to |
|---|---|---:|---:|---:|---:|---:|---|
| **mempalace-matched** | user | 50 | **97.2%** | 83.2% | 94.4% | 82.8% | **MemPalace 96.6%** |
| **default** | all | 20 | **98.2%** | 79.6% | 95.2% | 84.6% | **agentmemory 95.2%** (bm25-only 86.2%) |
| robustness: uncleaned S | all | 20 | 97.8% | 79.8% | 94.6% | 85.4% | — |

The MemPalace comparison is the **97.2%** row, not the 98.2% one: it is the
configuration built to match their conventions, and a configuration is chosen to
match a comparator, never to win against one. `longMemEvalComparability()`
confirms both pairings with the same `rankingBlocker` rule every other pair in
the registry is held to — `blocker: null` for both. Point the default
configuration at MemPalace instead and it is correctly blocked on `top_k`.

**The line to read first is the bm25 control.** At 84.6% it lands **1.6 pp below**
agentmemory's BM25-only 86.2%. A smaller or less confusable haystack would
inflate the lexical arm too; it does not. So the lift sits entirely in the dense
leg, where there is a plain capability difference rather than a task difference:
agentmemory embeds the **first 512 characters** of a session with
all-MiniLM-L6-v2 (384d, 256-token window), against a median session of ~10 400
characters, while the production `buildEmbedText` takes 4 000 with embeddinggemma
(768d, 2048-token window). That, not a better fusion, is the most likely reading
of the gap.

Two checks that the pool is the intended one. The official README defines
LongMemEval_S as "roughly 115k tokens (~40 history sessions)" per question; ours
measures 38-62 sessions (median 48) and ~122k tokens — the ~500-sessions-per-
question variant is LongMemEval_**M**, which neither we nor either reference ran.
And "cleaned" is the **upstream release**, not a filter of ours: against the
original file it drops 0 of 500 questions and changes 0 gold sets, removing 1 243
distractor sessions. The robustness row puts those distractors back and the
number moves by 0.4 pp.

The abstention items are reported separately rather than hidden — 30 question ids
end in `_abs`, and on the default configuration they score bm25 66.7% / hybrid
96.7% R@5. Neither reference harness drops them either.

The default configuration was run twice, before and after a cosmetic edit to the
harness — two code hashes, one dataset hash, every figure identical to four
decimals. The numbers are not one sample of a spread.

### survival is not the #103 survival here

The corpus has no authored `recall_when` — nobody writes a trigger for a chat
log — so the lever that metric ablates does not exist and that number is **not
computable** on this data. The harness keeps the formula and states the
substituted lever: control is the lexical arm, treatment is the hybrid arm.

| configuration | arm | near R@5 | far R@5 | far_retention | survival(dense) |
|---|---|---:|---:|---:|---:|
| default | bm25 | 91.0% | 76.7% | 0.84 | — |
| default | hybrid | 98.9% | 97.3% | 0.98 | **2.60** |
| mempalace-matched | hybrid | — | — | 0.95 | **3.73** |

Dense lift on the default configuration is **+7.9 pp near, +20.6 pp far**, so the
dense arm helps *more* where the question shares little vocabulary with its gold
session — what a dense arm is for, and the opposite of the `recall_when` result
in #103. near/far is a median split of the question's token coverage of its gold
session, because persona-lift's 0.30 cut was calibrated against short trigger
phrases and puts nearly every question on the near side of a whole transcript.

### What this number is not

It is retrieval recall, not LongMemEval QA accuracy — the official metric
retrieves, generates and judges, and the systems on that leaderboard score 60-95%
depending on the reader. Both reference reports say the same about their own
figures. Nothing here was tuned: the arms are the unmodified production calls,
the protocol was registered before the run, and the run does **not** enter
`~/.bastra/eval-runs` (#446) — its only artifact is the `--out` file.

## Band occupancy (`src/band-occupancy.ts`)

`rrf-k-beir.ts` asks whether the fusion constant is right. This asks what the
constants layered on top of it — the hook's `SCORE_FLOOR = 30` and
`MUST_LOAD_SCORE = 100` — actually select once the fusion has run. #302 measured
that once, at `RRF_K = 60`, and #335 changed the scale under it. The harness
exists so the question can be re-asked rather than re-argued.

Both cuts are env-tunable in the hook (`BASTRA_RECALL_FLOOR`,
`BASTRA_MUST_LOAD_SCORE` — `hook.ts:66,70`), so the harness reads the same two
variables rather than hardcoding the defaults, and prints the cuts it used. On a
machine that raised its floor, a run against the shipped 30 would be measuring
somebody else's hook. The bash-fail floor of 50 is a literal in
`bash-fail-hook.ts:44` and is a literal here too.

Three things it fixes about how that question was asked the first time.

### The call shape is part of the measurement

`recallHybrid(query, {k})` is not what the hook does. `/hook/recall` defaults
`expand_hops` to 1 (`daemon/src/http.ts`), so the caller receives up to **2k**
hits: k seeds, plus up to k one-hop neighbours scored `seed.score * 0.5 *
link.score` (`core/src/search.ts`) — half a seed at best. Those neighbours are
the only hits that can land under a floor of 30 on this path, because
`http.ts` clamps the endpoint to `k <= 10` and the k-th fused score is bounded
below by `RRF_SCALE / (RRF_K + k)` = 32.79 there. Measure with hops off and the
floor reports as inert; measure the shape the hook uses and it fires, on
neighbours only. `--hops` (default 1, the hook's own default) is the switch, and
every row carries `hop` and `pos` so seeds and neighbours are never pooled.

### Two corpora, every time — and which one is the finding

Run both, always:

```bash
# the phenomenon — a real vault, the distribution the product actually serves
BASTRA_VAULT_PATH=/path/to/vault npx tsx src/band-occupancy.ts --n 400 --k 3

# the credential — a corpus the reader can download and rerun
npx tsx src/band-occupancy.ts --corpus ./nfcorpus --n 200 --k 3,10
```

They answer different questions and neither substitutes for the other. The
public corpus establishes that a result is **reproducible by someone who does
not have your vault** — without it a number cannot end an argument, which is
why `rrf-k-beir.ts` settles the constant on NFCorpus. The private vault
establishes what the system does on the distribution it is actually serving:
hand-written triggers, one author's language, a linked graph. NFCorpus has no
`related_via` edges at all, so the hop half of this measurement cannot be asked
there.

When the two agree within noise, **report the private number as the finding and
the public one as the replication.** The public corpus is a proxy for the
phenomenon; the vault is the phenomenon. When they disagree, the disagreement is
the result — it says the effect was a property of one corpus, and the harness
has just told you which.

Observed so far, `--hops 0`, k=3: REQUIRED 67.6% answerable / 29.2% absent on a
649-memory vault, 58.5% / 6.7% on NFCorpus. Same direction, wider separation on
the public corpus — a personal vault is about the things its owner queries, so
its "absent" queries are less absent than a foreign corpus's.

### An absent set is mandatory, and it is two populations

`--queries <file>` takes one query per line, chosen to be outside the corpus.
A band that only ever sees answerable queries cannot be judged: a noise floor
exists for the empty case, so the empty case is where it has to be measured.
The set has to be written per corpus — `offvault-queries.txt` (cooking,
sailing, veterinary) is absent from a developer's vault and *present* in
NFCorpus, which is nutrition and medicine; `offvault-queries-nfcorpus.txt` is
the mirror.

Keep topical queries and bare operational strings (`ls -la`, `chmod 755`)
separate when reporting. They are not one population — at `--hops 0` they gave
23.3% and 46.7% REQUIRED on the same run, and pooling them reports 29.2% for
neither.

### Two medians, because one label can invent a finding

The harness prints the median over **all served hits** and the median of **each
query's top hit** side by side. They are 70.3 and 163.9 on the same run. Print
the first under the second's name and a reader concludes the top-hit median
moved when it did not — it is still the structural ceiling, exactly where #302's
own table put it.
