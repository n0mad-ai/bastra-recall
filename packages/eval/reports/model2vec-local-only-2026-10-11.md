# Model2Vec local-only availability (#480)

Owner-authorized constraint: run the static arm only if a model already exists locally; do not download large models without asking. The bounded, committed read-only inventory inspected configured HF caches, standard HF/Model2Vec-related cache locations, local uv tool-cache directories (excluding site-packages) and repository cache/model directories.

- Seven candidate root locations, two existing roots, zero unreadable directories.
- Zero Potion/Model2Vec-named weight candidate directories; zero complete candidates with weights, config and tokenizer.
- The Python interpreter used for this inventory has no importable `model2vec` package.
- Zero network calls, downloads or model inference calls.

**Verdict: not evaluable under the local-model-only constraint.** This bounded inventory is not a global claim that no artifact exists in any other directory or Python environment. No quality, rank agreement, weak-result, in-process latency, multilingual performance or fallback/adoption gate was measured. A known existing local path/runtime could enable a later run; no download or production model switch was attempted, and no request was sent to others.

The aggregate result pins the clean reader commit and script hash. No private cache paths or contents are published. Validation: Python compilation and the local read-only run. The entire output is aggregate-only.

```sh
python3 packages/eval/scripts/model2vec-local-check.py --out <aggregate-artifact>
```
