# Correction durability: BM25 baseline (#644)

Measured against the v1.1.0 core (source hash in the registration), with a committed, clean eval harness at bb196509d5c535f40e717b9bdc36c3681617e317. Twelve invented pairs, English/German, value changes/polarity flips; three frozen current-state queries each. Fresh isolated three-memory index per pair. Both replacement links are present. No model, answer generation, private corpus, aging or ranking change.

| Metric | Old-first filenames (primary, n=36) | Reversed filenames (control, n=36) |
|---|---:|---:|
| Predecessor ranks before successor | 35 | 17 |
| Strict predecessor score advantage | 17 | 17 |
| Equal scores | 18 | 18 |
| Successor hit@1 | 1 | 19 |
| Successor hit@3 | 36 | 36 |
| Predecessor reachable by id | 36 | 36 |
| Both versions missing | 0 | 0 |

The 18 ties change order when filenames are reversed. They are not 18 strict score failures. The remaining 17/36 strict inversions are independent of that order control. The baseline demonstrates a current-state ordering gap on these lexical fixtures; it is not a population estimate. Two runs produced the same verdict-only SHA-256 (see results). Identity fields, metrics and every invented-case verdict are committed.

Run after building core:

```sh
node --import tsx packages/eval/src/supersession-durability.ts --out <artifact>
```

Validation: eval source typecheck; two deterministic runs; order control. Hybrid, historical/as-of selection, answer correctness, repeated correction sequences and the internal gold-set regression gate remain **unmeasured**. No gate is declared passed. The registration proposes a future gate for owner review; it does not install one or change production ranking.
