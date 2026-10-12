# Repeated correction sequence retrieval subset (#600)

Sixteen invented DE/EN entities, separate dev/test names, four families: value changes with return; polarity reversal; old-validity facts arriving last; conflicting source peers. Latest validity defines current, not arrival order. Reference type, equal storage dates and validity-ordered replacement links; no tuning. Production v1.1.0 BM25 and shipped hybrid (local embeddinggemma, weight 1.5, k=5).

The R3 control reverses the version-ID/filename mapping and file-writing order while preserving chronological ingest states, bodies, queries and truth. Vault loads sorted filenames, so index insertion order is reversed by semantic version role. Full artifacts record index order, hit scores and current IDs. The original-order ranked lists reproduce the previous artifact exactly. Controls are paired, not new independent cases.

Only **56 non-conflict ingest trials at stage >=2 per arm/order** are correction opportunities. The 24 terminal reload trials and 24 restored-state trials repeat ingest end states; 24 hidden-old-file trials change the pool. These controls are reported separately, not added to a denominator of 128 independent observations. Query pairs and successive states also share entities; no independent-sample significance claim is made.

| Ingest metric (n=56 each) | BM25 original | BM25 reversed | Hybrid original | Hybrid reversed |
|---|---:|---:|---:|---:|
| Old version ID at rank 1 | 56 | 56 | 49 | 44 |
| Strict old score advantage over current | 56 | 56 | 49 | 44 |
| Old top1 tied with current | 0 | 0 | 0 | 0 |
| Any old/current score tie, possibly below another old hit | 22 | 22 | 0 | 0 |
| Old top1 but same current value | 16 | 16 | 11 | 9 |
| Top1 value differs from current value | 40 | 40 | 38 | 35 |
| Current version hit@1 | 0 | 0 | 7 | 12 |

Score ties use the served core scores (rounded), not only rank order. Across all 176 trials per arm/order, BM25 has 22 top-score ties and 64 any-old/current ties in either order; old top1 ties current in 6 original / 8 reversed trials, all in the hidden-old-file phase. Hybrid has zero served-score ties. The observed association with smallest IDs in the original run alone was not enough to infer a tie-break mechanism: reversing IDs leaves BM25 ingest old-top1 at 56/56, with strict served-score advantages, while hybrid changes 49→44. The control does not identify the cause of those score advantages. **The previous “gap persists” claim is withdrawn**; these are fixture-specific ranking and order-sensitivity observations, not established correction durability or wrong-answer rates.

| Old version top1 by control phase (n=24 each) | BM25 original | BM25 reversed | Hybrid original | Hybrid reversed |
|---|---:|---:|---:|---:|
| Component reload | 24 | 24 | 18 | 17 |
| Filesystem hide oldest | 6 | 8 | 11 | 11 |
| Filesystem restore oldest | 24 | 24 | 18 | 17 |

Reload rankings match their terminal ingest lists in 32/32 trials per arm/order (including conflicts). Current-source hit@5 is 160/160 per arm/order, including one-version baselines: **trivial pool coverage**, because at most four memories exist and k=5; it is not retrieval-quality evidence. Both conflicting peers are present, but that does not demonstrate calibrated uncertainty.

Value-change returns **14→30→60→14**: v1 and v4 have the same fact value, although their validity/source text differs. Polarity reversal similarly returns to the initial value. An old version ID therefore need not contain an incorrect value. The table separates old top1 with the same value from differing-value top1; neither establishes an agent's answer.

This measures the `replaces` metadata projection as **raw core ranking**: `replaces` stamps `superseded_by`, which recall does not evaluate; recall filters only `obsolete: true`, absent here. The product `archive_memory(superseded_by)` path removes predecessors from the live vault and is unmeasured, as is daemon recall (stages, router and anchors). Hidden fixture files and fresh component reloads test filesystem visibility only, not product archival, daemon restart or live watcher correctness.

**Unmeasured/not evaluable:** agent answer accuracy, evidence fidelity, uncertainty/citations, historical as-of semantics, live ingestion, product archive/restore API and audits, field longevity and M1. No gate passed or production behavior changed.

Validation: source typecheck, complete state backfills, unchanged corpus/core/model identities, original-rank reproduction, sorted index-order checks, 56-ingest/24-control denominator checks and value-count conservation. The original artifact is preserved; the R3 full artifact is archived byte-identically at the registered durable locator. Public results contain aggregates and hashes.

```sh
BASTRA_VAULT_ROOTS_PATH=<isolated-roots> BASTRA_LOG_PATH=<isolated-log> node --import tsx packages/eval/src/correction-sequences.ts --out <artifact>
```
