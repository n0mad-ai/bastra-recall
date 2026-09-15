# Diagnostic result — 2026-09-15

Decision: retain `query-expand` as an **offline experimental implementation**.
Do not integrate lexical excerpts into production evidence delivery yet.

## Public development fixtures

All required annotated spans present, out of nine answerable cases:

| Arm | 1,024 tokens | 4,096 tokens |
| --- | ---: | ---: |
| Whole-source prefix packing | 8 | 9 |
| Fixed 1,200-code-point prefixes | 0 | 0 |
| Query windows | 7 | 7 |
| Query windows with whole-source expansion | 9 | 9 |

One additional no-answer fixture returns evidence in every arm; no answer reader
or abstention policy is evaluated. Source presence alone is 9/9 for every arm at
both budgets and would completely hide the passage failures in this table.

The lexical arm loses the cross-language answer and a remote exception. The
expansion follow-up was developed after inspecting these failures. It repairs
these fixtures using remaining room, not semantic understanding of exceptions.
The fixtures are development evidence, not independent labels or a holdout.

## Private development replay (aggregate only)

Frozen 1,207-memory snapshot, the same recorded Recall top-ten sources for every
arm; 140 answerable historical questions and 40 historical no-answer questions.
The three predefined comparison probes remain excluded. No retrieval rerun,
private model upload, extraction pass, or authored-memory mutation was needed.

Expected-source presence within the serialized evidence budget:

| Arm | 1,024 tokens / 140 | 4,096 tokens / 140 |
| --- | ---: | ---: |
| Whole-source prefix packing | 53 | 79 |
| Fixed prefixes | 62 | 94 |
| Query windows | 64 | 93 |
| Query windows with whole-source expansion | 64 | 93 |

Expansion versus baseline rescues 11 and 14 source hits respectively and loses
none on these particular historical cases. This does **not** establish passage
survival or better answers: the private replay has zero independently labelled
answer spans. The fixed-prefix control's higher source count alongside its 0/9
synthetic passage result is another reason not to optimize only for source hits.

The earlier comparison's 82/140 at 4,096 tokens excluded this experiment's JSON
citation/offset/revision envelope. The baseline is now 79/140 because the envelope
is counted too. Compare arms within this run, not those two different budgets.

All serialized outputs stay inside their declared token budget. Runtime measurements
are emitted for reproducibility but this run overlapped repository tests; they do
not satisfy a controlled production latency gate. No-answer rows are counted as
returned evidence only, never hallucination or false-answer rates.

## Remaining evidence before integration

- Independent answer-span labels and fresh question formulations; the runner
  deliberately leaves promotion `not_evaluable`.
- Tests where distant qualifiers cannot fit, and English/German questions require
  semantic rather than shared-word matching.
- A grounded-answer reader, multi-source completeness and no-answer guardrails.
- Isolated latency measurements including actual loading and payload construction.

The experiment is callable now through the eval CLI. Production Recall and
`load_memory` keep their existing behavior. No feature flag or rollback migration
is needed because no runtime code imports this module.
