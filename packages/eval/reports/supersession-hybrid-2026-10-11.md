# Shipped hybrid correction baseline (#644)

Frozen corpus identical to #1160: 12 invented German/English value-change and polarity-flip pairs, three current-state queries each. Fresh isolated index per pair; repeat with reversed filenames. Production `recallHybrid`, local embeddinggemma, RRF weight 1.5, k=3, equal fixed dates, reference type, no authored triggers. Clean committed eval harness and the v1.1.0 core; model digest and hashes are registered.

| Metric (n=36 per order) | BM25 old-first (#1160) | BM25 reversed | Hybrid old-first | Hybrid reversed |
|---|---:|---:|---:|---:|
| Strict predecessor score advantage | 17 | 17 | **24** | **24** |
| Predecessor ranks before successor | 35 | 17 | 24 | 24 |
| Score ties | 18 | 18 | 0 | 0 |
| Successor hit@1 | 1 | 19 | 12 | 12 |
| Successor hit@3 | 36 | 36 | 36 | 36 |
| Predecessor reachable by id | 36 | 36 | 36 | 36 |
| Both missing | 0 | 0 | 0 | 0 |

The shipped hybrid has more strict score inversions on this fixed corpus (24/36 versus 17/36), without BM25's filename-sensitive ties. This is a synthetic retrieval baseline, not a population durability or answer-accuracy estimate. Current-version ordering is not confirmed. Historical/as-of answers, repeated sequences, internal gold set and M1 remain unmeasured here; no gate passed, no ranking change.

Validation: source typecheck; complete three-vector backfill for every index; both filename orders; unchanged fixture hash and post-run model digest. Full invented-case artifact is archived; public results are aggregate-only. No production vault, protocols, daemon or service file was modified.

```sh
node --import tsx packages/eval/src/supersession-hybrid.ts --out <artifact>
```
