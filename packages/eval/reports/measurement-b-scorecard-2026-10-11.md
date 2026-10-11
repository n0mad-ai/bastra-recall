# Measurement B baseline references (#387)

This campaign index links the separately registered measurements and their immutable engine/data/artifact identities. It does not replace the shared V2 scorecard, duplicate another owner's #402/#598/#410 work or declare any stable-release confirmation passed.

The external baseline is production retrieval from clean v1.1.0 with embeddinggemma, RRF dense weight 1.5, a fresh session index per question and all 500 cleaned LongMemEval-S questions. The full machine-written engine block, corpus/harness/artifact hashes, model digest and host hardware are in the manifest; no raw private data or local paths are published.

| Area | Evidence status | Reference |
|---|---|---|
| Shipped default | Complete external retrieval baseline | #1166 / #1081 |
| Correction durability | Measured subset: raw replaces-path BM25/hybrid and file-order controls | #1160, #1174 / #644 |
| Chunk scoring | Full lexical and true max-sim results registered; M1/gold set/storage decision pending | #1168 / #1082 |
| Draft CSLS | Unlabelled diagnostic; precision/adoption not evaluable | #1165 / #1109 |
| Test-log contamination | Due read-only recount: zero matches, zero cleanup proposed | #1161 / #686 |
| MCP scope filtering | Due shadow week; enforce utility/safety not evaluable | #1162 / #421 |
| Repeated corrections | Measured subset: 56 ingest trials per arm/order; score ties and same-value returns separated; answer/as-of/product archive unsupported | #1176 / #600 |
| Scale/interference | Measured subset: exact Flat synthetic 768d through 50k; HNSW/semantic/M5 confirmation not evaluable | #1177 / #1058 |
| Static Model2Vec | Not evaluable: bounded local inventory has no complete candidate; no download/inference | #1178 / #480 |

No internal M1, answer-quality, longitudinal, causal, promotion/enforce or stable-V2 gate was measured by this campaign. Pending evidence remains pending; a numerical baseline is not a passed behavioral gate. Unrelated implementation and beta work can proceed under its own contract.

The continuation ran in the owner-requested order. #1174 has 24/36 strict predecessor advantages per order, with query classes across both controls old-anchor 20/24, paraphrase 16/24 and neutral 12/24. The comparison with BM25's 17 strict advantages plus 18 ties does not establish deterioration. Only raw core ranking of the replaces metadata projection is measured; superseded_by is ignored, while obsolete:true is filtered. Product archival and daemon recall/agent answers remain unmeasured.

#1176 R3 separates **56 ingest correction opportunities per arm/order** from 24-trial reload, hide-old and restore controls. Original/reversed IDs give old top1 BM25 56/56 in both orders, hybrid 49/56 and 44/56. BM25 has any-old/current score ties in 22/56 ingest trials, but no tied old top1; strict old score advantages remain 56/56. Differing-value top1 is BM25 40/56 in both orders, hybrid 38/56 and 35/56; old identity with the same current value is counted separately. The previous “gap persists” interpretation is withdrawn. Hit@5 is trivial with at most four memories and k=5. Paired orders, queries and stages share entities and support no independent-sample inference.

Flat runtime/mutation probes use deterministic numeric vectors, not a neural semantic model. #1178 is not evaluable under the local-only model constraint. All `gates_passed` lists remain empty; no missing capability is treated as passed. Original baselines and immutable artifact identities remain registered; the R3 artifact is separately archived.
