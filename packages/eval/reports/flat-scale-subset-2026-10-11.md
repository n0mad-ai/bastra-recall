# Exact Flat scaling subset (#1058)

Five sequential runs on the v1.1.0 production `EmbeddingIndex` exact cosine backend, at clean committed eval harness `fb0fa91e`. All corpora are synthetic; 1,403 only matches the prior real-vault size census. Seeded 768-dimensional fixture vectors are loaded through the production persistence/cache format. No neural model, Ollama call, private corpus or product switch. Backend stays Flat while corpus size changes.

The first 512 entity vectors are anchors; additional entries are close seeded perturbations. Twelve fixed target ids occur in every size, exact/noisy query-vector slices with three repeats each (36 observations per slice). These are numeric backend probes, not semantic retrieval or independent user queries.

| Entries | Exact p50/p95 ms | Noisy p50/p95 ms | Exact/noisy target hit@10 | Highest sampled RSS MiB | Vector file bytes | Update ms | Delete/reconcile ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1403 | 1.361/2.540 | 1.182/1.363 | 36/36, 36/36 | 218.2 | 5,773,403 | 3.161 | 10.964 |
| 1000 | 0.957/1.006 | 0.815/1.010 | 36/36, 36/36 | 185.8 | 4,115,058 | 2.848 | 9.016 |
| 3000 | 2.781/3.568 | 2.703/2.893 | 36/36, 36/36 | 283.7 | 12,345,058 | 3.283 | 17.530 |
| 10000 | 9.885/12.088 | 9.850/10.496 | 36/36, 36/36 | 613.3 | 41,150,058 | 3.910 | 45.009 |
| 50000 | 57.080/64.252 | 58.131/73.615 | 36/36, 36/36 | 2329.5 | 205,750,058 | 7.139 | 247.143 |

All five single-update probes return the updated target at rank 1; all five deletes remove the id from the vault/vector index and query results. Updates use `Vault.reindexFile` and wait for the production embed callback. Deletes use disk unlink and `Vault.reconcile`; therefore delete timing includes filesystem reconciliation. This is one mutation of each kind per scale, not exhaustive recovery/concurrency confirmation.

RSS is sampled after load, queries and mutations, not peak RSS. Each scale runs in a separate process; host activity is shared with other work. Corpus/vector/cache disk bytes, load times, target hit@1/@10, provider calls and hashes are in the aggregate registration. Precomputed fixture vectors are not neural backfill-time measurements.

**Verdict:** supported exact-Flat runtime/resource behavior is measured at all registered sizes. HNSW is **not evaluable**: no HNSW arm or identical-corpus backend comparison was run; its 98%-of-Flat and p95-improvement criteria are not passed. Semantic/gold-set quality, temporal/conflict accuracy, M1, production switching/recovery and isolated/peak resource bounds remain unmeasured. No M5/HNSW gate passed, no production changes.

Validation: source typecheck, complete cache load with zero initial provider backfill calls, 72 complete dense queries per scale, update callback/target check, delete/orphan exclusion, clean engine and input/code/protocol/full-artifact hashes. Only generated temporary files were mutation targets.

```sh
node --import tsx packages/eval/src/flat-scale-subset.ts --size <registered-size> --out <artifact>
```
