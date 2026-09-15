# Completed development experiment — 2026-09-15

Decision: **reject the current lexical window/expansion selector for production**.
Keep the frozen selector as an offline replay arm. Implement the measurement fixes
and regression witnesses; #568 tracks a different selection approach and #569
tracks reliable answer evaluation. Production Recall behavior is unchanged.

## What was tested

A frozen 1,207-memory snapshot and recorded Recall top-ten sources: 140 historical
answerable questions, 40 historical negatives, three predefined probes excluded.
Every arm receives identical source order and pays for its complete serialized JSON
envelope, including revisions/offsets, using `o200k_base` at 1,024/4,096 tokens.
No private content was uploaded, published or written back to the vault.

All 140 proposed reference annotations were reviewed before inspecting arm answers:
115 had sufficient reference evidence, 25 were context-only or unsupported.
These are model proposals reviewed by the implementing agent, **not independent
human ground truth**. The 115 cases contain 232 required fact groups. The original
algorithm remains frozen; annotation-only references cannot enter reader evidence.

## Source presence and literal answer-span survival

Historical expected-source presence (140 cases):

| Arm | 1,024 tokens | 4,096 tokens |
| --- | ---: | ---: |
| Whole-source prefix packing | 53 | 79 |
| Fixed prefixes | 62 | 94 |
| Query windows | 64 | 93 |
| Query windows with whole-source expansion | 64 | 93 |

All annotated reference passages survive (115 reviewed sufficient cases):

| Arm | 1,024 tokens | 4,096 tokens |
| --- | ---: | ---: |
| Whole-source prefix packing | 42 | 68 |
| Fixed prefixes | 20 | 24 |
| Query windows | 22 | 27 |
| Query windows with whole-source expansion | 22 | 32 |

At 4,096 tokens expansion gains three and loses 39 complete exact-span cases
relative to prefix packing. All 39 losses still include the expected source;
35 excerpts start at offset zero. At 1,024 tokens there are seven gains and 27
losses. These counters measure **literal annotated passage survival, not semantic
answer accuracy**: an equivalent sentence elsewhere can still answer the question.
The earlier 82/140 source result excluded this experiment's envelope; it is not
a matched-budget comparison with 79/140.

A public unit-test witness isolates a real selection failure: adding only a
`recall_when` cue to a long source makes expansion drop its retention rule and
legal-hold exception at 1,024 tokens. Prefix packing still preserves both facts.
This demonstrates a failure even without trusting a model judge or asserting
that every private exact-span loss is a semantic loss.

## Completed answer run and failed judge audit

A local `bastra-bench-qwen:16k` reader answered all 180 questions for prefix and
expansion at 4,096 tokens (360 answers), seeing only the question and packed text.
A local `gemma4:12b` evaluated the full run. Correctness saw reference facts;
grounding saw only delivered evidence. Both used deterministic settings
(temperature 0, seed 563, 16,384-token context). Explicit abstentions fail on known
positives; 25 insufficient references and 40 historical negatives remain unscored.

**The semantic score is invalidated, not evidence of improvement.** Initial combined
judges leaked reference facts into grounding. Separating requests fixed that
information boundary and passed six synthetic controls, but audit of actual
answers still found false passes: a denial accepted despite an explicit answer in
the reference, and an unrelated explanation accepted despite its own negative
rationale. Two additional English/German denial controls passed too, demonstrating
that passing simple controls alone is insufficient. Preserve the cached run;
do not selectively repair favorable rows or keep rerunning models until one wins.

Citation-format compliance is also separate: on the 115 sufficient cases, only
10 baseline and 21 expansion answers satisfied the reader's exact-quote citation
contract. This does not measure correctness. Historical negative labels do not
certify absence in the full snapshot, so no hallucination rate is inferred.

## Query wording stress test

115 query-only paraphrases were generated without sources or arm outputs. Review
excluded 16 meaning/identifier changes and 36 unchanged token sets, leaving 49
same-language formulations and 14 translations. Frozen retrieval order was reused:
this tests selection sensitivity, not fresh end-to-end retrieval or a human holdout.

| Slice | Budget | Prefix exact spans | Expansion exact spans |
| --- | ---: | ---: | ---: |
| Same language (49) | 1,024 | 9 | 5 |
| Same language (49) | 4,096 | 19 | 8 |
| Translation (14) | 1,024 | 3 | 3 |
| Translation (14) | 4,096 | 8 | 5 |

## Public development fixtures

All required spans out of nine answerable fixtures:

| Arm | 1,024 tokens | 4,096 tokens |
| --- | ---: | ---: |
| Whole-source prefix packing | 8 | 9 |
| Fixed prefixes | 0 | 0 |
| Query windows | 7 | 7 |
| Query windows with whole-source expansion | 9 | 9 |

The expansion arm was developed after inspecting these failures; this is tuning
evidence, not transfer proof. One additional negative fixture returns evidence
in every arm and has no answer/abstention accuracy label. Synthetic success cannot
override the private regressions or the explicit rejection witness.

## Packing latency

A separate warm in-memory replay (180 paired cases, alternating arm order, Node
24.16.0 on Apple M4 Pro, no other benchmark jobs) measured prefix p50/p95
72.66/87.97 ms and expansion 78.63/95.48 ms at 4,096 tokens. This excludes source
loading, tokenizer initialization and model time, so it is not a production
latency certification. Public aggregate provenance is in `follow-up-results.json`;
`results.json` retains the original synthetic run and its original hashes.

## Integration decision

This experiment is concluded with rejection of its current selector. No runtime
feature flag or migration is required. The PR implements an offline harness,
annotation-only missing-source accounting, isolated answer-check request builders,
and regression tests. Positive promotion requirements remain unmet and unchanged.
A future selector needs independently reviewed answer labels, reliable semantic
judging, multilingual/temporal/multi-source guardrails and production latency checks;
those are requirements for a new candidate, not unfinished promotion of this one.
