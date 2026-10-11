# Repeated correction sequence retrieval subset (#600)

Sixteen invented entities, separate development/test names, German/English, four families: repeated values with return to the original value; polarity reversal; older-validity facts arriving last; conflicting source peers. No tuning. Latest validity determines the fixture's current source; ingestion order does not. Replacement links follow validity order. Reference type and equal storage dates isolate retrieval from aging.

Production BM25 and shipped hybrid (embeddinggemma, dense weight 1.5, k=5), on the v1.1.0 core and a clean committed eval harness. Each state is loaded from temporary files; terminal component reload is repeated. Old files are then moved into a hidden fixture directory and restored. This is filesystem visibility/reload control, **not the product archive API, audit/permission contract or a daemon restart**.

| Per arm | BM25 | Hybrid |
|---|---:|---:|
| All trials | 176 | 176 |
| Current-source evaluable trials (including one-version baselines) | 160 | 160 |
| Current source hit@1 | 50 | 64 |
| Current source hit@5 | 160 | 160 |
| Obsolete source at rank 1 | 110 | 96 |
| Correction opportunities (stage >=2, excluding conflicting peers) | 128 | 128 |
| Obsolete rank 1 within those opportunities | **110/128** | **96/128** |
| Both conflicting peers present in the k=5 pool | 16/16 | 16/16 |
| Component-reload ranking lists unchanged | 32/32 | 32/32 |

The old/current retrieval gap persists across repeated changes. Hybrid has fewer obsolete top-1 results on these fixtures, but 96/128 correction opportunities still return an obsolete source first. Presence at k=5 and restart stability do not establish that an answer uses the current fact. Returning conflicting peers does not demonstrate calibrated uncertainty. The registration reports phase/dev/test/language/family slices and explicitly separates initial one-version baselines from correction opportunities.

Old files are unreachable while hidden and reachable again after restore. Restoring an old file can resurface it above the current source; phase-specific counts are registered. This tests supported filesystem/index visibility only. The preliminary ingestion-ordered link projection is excluded; results come from the corrected validity-ordered projection.

**Unmeasured/not evaluable:** answer accuracy, evidence fidelity, uncertainty, canonical answer citations, historical as-of semantics, live ingestion/watchers, the actual product archive/restore API and audit contract, longitudinal use and internal M1. No gate passed and no product ranking, promotion or storage change. Synthetic sequences are not weeks of field use.

Validation: source typecheck, complete backfills at every state, source/model identities, terminal reload comparisons, archive invisibility/restore visibility. Aggregate results and hashes are public; the full invented-case artifact is local and archived byte-identically.

```sh
node --import tsx packages/eval/src/correction-sequences.ts --out <artifact>
```
