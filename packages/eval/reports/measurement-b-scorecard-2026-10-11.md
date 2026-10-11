# Measurement B baseline references (#387)

This campaign index links the separately registered measurements and their immutable engine/data/artifact identities. It does not replace the shared V2 scorecard, duplicate another owner's #402/#598/#410 work or declare any stable-release confirmation passed.

The external baseline is production retrieval from clean v1.1.0 with embeddinggemma, RRF dense weight 1.5, a fresh session index per question and all 500 cleaned LongMemEval-S questions. The full machine-written engine block, corpus/harness/artifact hashes, model digest and host hardware are in the manifest; no raw private data or local paths are published.

| Area | Evidence status | Reference |
|---|---|---|
| Shipped default | Complete external retrieval baseline | #1166 / #1081 |
| Correction durability | Synthetic BM25 baseline and file-order control | #1160 / #644 |
| Chunk scoring | Full lexical result registered; dense run in progress | #1168 / #1082 |
| Draft CSLS | Unlabelled diagnostic; precision/adoption not evaluable | #1165 / #1109 |
| Test-log contamination | Due read-only recount: zero matches, zero cleanup proposed | #1161 / #686 |
| MCP scope filtering | Due shadow week; enforce utility/safety not evaluable | #1162 / #421 |

No internal M1, answer-quality, longitudinal, causal, promotion/enforce or stable-V2 gate was measured by this campaign. Pending evidence remains pending; a numerical baseline is not a passed behavioral gate. Unrelated implementation and beta work can proceed under its own contract.
