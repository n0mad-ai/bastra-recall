# True chunk max-sim and chunk BM25 (#1082)

Two complete 500-question cleaned LongMemEval-S runs, from clean eval commit `d2abf04671c78513f7762dfb5a863568fd82f5a2`, using the v1.1.0 core. The primary comparator is the separately registered shipped-default hybrid in #1081. Corpus/core identities, question order, gold ids and both lexical ranking lists match exactly between runs; model digest was checked again after completion. No production index, ranking, promotion or storage change.

Source chunks contain at most 400 cl100k_base tokens / 4000 UTF-16 characters, with at most 80 tokens overlap and source/Unicode boundaries preserved. Literal tokenizer-special spellings remain ordinary source text. Original title/summary/tags repeat in each chunk. Dense score is the **maximum cosine over all chunks per session**, collapsed before the top-50 document cap; no averaging. Production RRF uses K=5, dense weight=1.5 and final depth 20.

| Arm | R@1 | R@3 | R@5 | R@10 | R@20 | MRR@20 |
|---|---:|---:|---:|---:|---:|---:|
| Shipped single-vector hybrid (#1081) | 83.2% | 96.4% | 98.2% | 98.4% | 99.6% | 0.896505 |
| Whole-session BM25 | 61.4% | 77.6% | 84.6% | 92.0% | 97.2% | 0.716440 |
| Chunk BM25, max per session | 54.2% | 73.4% | 78.4% | 88.4% | 95.2% | 0.654847 |
| Max-sim dense only | 88.8% | 96.4% | 98.2% | 99.2% | 100.0% | 0.930680 |
| Whole BM25 + max-sim (primary) | 86.0% | 97.6% | 98.8% | 99.4% | 99.8% | 0.916869 |
| Chunk BM25 + max-sim | 85.6% | 96.8% | 98.8% | 99.2% | 99.8% | 0.913818 |

**Primary result:** unchanged whole-session BM25 plus max-sim was measured 2.8 percentage points higher at R@1 (83.2% → 86.0%). Paired rank-1: 23 gains, 9 losses, 407 both correct, 61 neither; descriptive exact two-sided sign-test p=0.02006, unadjusted. Three max-sim arms were examined, so this is not a confirmatory improvement claim. R@5 has 5 gains and 2 losses (p=0.4531); its higher point estimate has no supporting paired-test evidence. These tests describe this benchmark; shared sessions/questions are not an independently sampled population or causal utility study. No shipping threshold was selected after seeing results.

Chunk BM25 alone regresses: R@1 61.4% → 54.2%, R@5 84.6% → 78.4% (22 gains/58 losses at rank 1; 12/43 at rank 5). The chunk lexical representation repeats metadata and changes document frequency; this rejects this arm, not every possible chunking scheme. The pure dense row is descriptive: a fresh single-vector dense-only control was not run, so it is not an isolated dense-only comparison.

| Question type | N | Shipped hybrid R@1 | Whole BM25 + max-sim R@1 | Shipped hybrid R@5 | Whole BM25 + max-sim R@5 |
|---|---:|---:|---:|---:|---:|
| single-session-user | 70 | 62.9% | 78.6% | 94.3% | 100.0% |
| multi-session | 133 | 90.2% | 91.0% | 100.0% | 99.2% |
| single-session-preference | 30 | 70.0% | 66.7% | 96.7% | 96.7% |
| temporal-reasoning | 133 | 86.5% | 88.7% | 97.0% | 97.0% |
| knowledge-update | 78 | 88.5% | 88.5% | 100.0% | 100.0% |
| single-session-assistant | 56 | 83.9% | 83.9% | 100.0% | 100.0% |

Baseline R@1-by-type is reproducible from the archived full #1081 artifact: `scripts/extract-longmemeval-types.py` counts questions whose first `ranked.hybrid` hit belongs to `gold`, grouped by `question_type`. The #1166 shipped-default registration/excerpt records each type's integer hit count, denominator, value, source-artifact SHA-256 and derivation-script SHA-256. The six rank-1 counts sum to 416/500 (83.2%); displayed percentages are rounded to one decimal.

## Cost and scope

- 23,854 session references across 500 fresh indexes; **168,484 chunk vectors**, 7.063 per session reference. 22,741 references exceed one chunk. Totals include repeated sessions across questions; they are not a deduplicated global-index size.
- Raw float32 payload: 517,582,848 bytes; actual persisted vector files summed across the run: 693,677,628 bytes.
- Backfill: 5198.788 s; total invocation: 5831.902 s. Query p50/p95: 36/74 ms. Query timing includes both lexical queries and the max-sim query; it is not production-request latency. The host was shared with other work.
- Read-only size census: 1,403 real-vault memories, 1,078 multi-chunk, 3,849 total chunks; zero duplicate ids, unreadable files or skipped symlinks. Nine plain/non-parseable Markdown files were excluded. Non-doc includes imports; authored status was not independently labelled. Under this frozen 400-token chunk profile, 1,078/1,403 (76.8%) have more than one chunk. This directly contradicts the issue's assumption that most bodies fit one chunk for this vault/profile. Authored/imported status remains unlabelled; size coverage does not establish real-vault retrieval lift.

**Verdict:** true max-sim is now measured; the registered primary external retrieval endpoint was measured higher in this run. The p=0.02006 result is unadjusted across three examined arms, and R@5 has no supporting paired-test evidence. This chunk-BM25 arm regresses. Main gold set, frozen M1 gates, answer quality, real-vault retrieval effects and a production multi-vector format remain **unmeasured/undecided**. No gate is declared passed; no adoption or configuration change.

Full artifacts are durably archived at `~/.codex/measurement-runs/2026-10-11-messung-b/` outside the worktrees, byte-verified by SHA-256; committed excerpts contain aggregate metrics, per-type results, input/engine/model/code identities and full-artifact hashes. Raw private logs and vault texts are not published. The interrupted 351-question lexical attempt is retained separately and excluded from results.

Validation: eval source typecheck; Unicode/tail, collapse-before-cap and literal-special-token controls; lexical/dense fixture smokes; full 500-question lexical/dense runs; identical controls and model digest. No backfill or persistence errors.

```sh
node --import tsx packages/eval/src/chunk-maxsim-run.ts --corpus <cleaned-S> --mode lexical --out <artifact>
BASTRA_EMBEDDING_MODEL=embeddinggemma node --import tsx packages/eval/src/chunk-maxsim-run.ts --corpus <cleaned-S> --mode dense --out <artifact>
```
