# Measurement B baseline references (#387)

This campaign index links the separately registered measurements and their immutable engine/data/artifact identities. It does not replace the shared V2 scorecard, duplicate another owner's #402/#598/#410 work or declare any stable-release confirmation passed.

The external baseline is production retrieval from clean v1.1.0 with embeddinggemma, RRF dense weight 1.5, a fresh session index per question and all 500 cleaned LongMemEval-S questions. The full machine-written engine block, corpus/harness/artifact hashes, model digest and host hardware are in the manifest; no raw private data or local paths are published.

| Area | Evidence status | Reference |
|---|---|---|
| Shipped default | Complete external retrieval baseline | #1166 / #1081 |
| Correction durability | Synthetic BM25/hybrid baselines and file-order controls | #1160, #1174 / #644 |
| Chunk scoring | Full lexical and true max-sim results registered; M1/gold set/storage decision pending | #1168 / #1082 |
| Draft CSLS | Unlabelled diagnostic; precision/adoption not evaluable | #1165 / #1109 |
| Test-log contamination | Due read-only recount: zero matches, zero cleanup proposed | #1161 / #686 |
| MCP scope filtering | Due shadow week; enforce utility/safety not evaluable | #1162 / #421 |
| Repeated corrections | Synthetic retrieval/reload/hidden-file subset; answer/as-of/product archive unsupported | #1176 / #600 |
| Scale/interference | Exact Flat synthetic 768d subset through 50k; HNSW/semantic/M5 confirmation not evaluable | #1177 / #1058 |
| Static Model2Vec | Bounded local inventory has no complete candidate; no download/inference | #1178 / #480 |

No internal M1, answer-quality, longitudinal, causal, promotion/enforce or stable-V2 gate was measured by this campaign. Pending evidence remains pending; a numerical baseline is not a passed behavioral gate. Unrelated implementation and beta work can proceed under its own contract.

The continuation ran in the owner-requested order. Hybrid correction inversion is 24/36 versus the original BM25 17/36 strict advantages; repeated-sequence obsolete top-1 is 110/128 BM25 and 96/128 hybrid correction opportunities. These are synthetic retrieval counts, not observed wrong answers or field recurrence. Flat runtime/mutation probes use deterministic numeric vectors, not a neural semantic model. No missing capability is treated as passed.
