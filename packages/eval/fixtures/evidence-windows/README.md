# Evidence delivery experiment (#563)

Run from the repository root (Node 22/24, after `npm ci`):

```sh
npm run evidence-windows --workspace=@bastra-recall/eval -- \
  --input packages/eval/fixtures/evidence-windows/cases.json \
  --out /tmp/evidence-window-results.json
```

The output must not already exist. Local input and per-case output may contain
private data; the CLI writes with mode 0600 and prints aggregate results only.
No network/model calls, vault writes, candidate generation or runtime integration.
To disable the experiment, do not invoke the CLI. No daemon flag is needed.

## Input contract

Each case has `id`, `query`, ordered `sources: [{id, text}]`, `expected_ids`, and
optionally `no_answer` or `required_spans: [{id, start, end, text}]`.

`text` is the exact canonical evidence being replayed, with any required title,
version and provenance metadata included by the adapter. Offsets are zero-based
UTF-16 indices into that exact string, end exclusive. Source revisions are SHA-256
of the UTF-8 input text. Do not normalize the text after annotating spans.

Expected source IDs may be absent from retrieved sources; these count as source
misses. Span annotations in this initial runner must reference supplied sources,
so span scoring is conditional on their availability. Do not present that subset
as end-to-end recall accuracy. Unlabelled cases produce a null span metric, never
an answer-quality score. Empty span labels and contradictory no-answer labels fail.

## Arms

- `whole-prefix`: pack full sources in rank order, truncating the last source to a
  fitting Unicode prefix. This is the comparison harness baseline, not the current
  production `recall` payload or `load_memory` behavior.
- `fixed-prefix`: take the first 1,200 code points of each source as a simple control.
- `query-window`: select the paragraph sharing the most non-stopword query terms,
  retaining one whole paragraph on either side. Ties/no matches choose the first
  window. Windows too large to fit are skipped atomically.
- `query-expand`: start with query windows, then spend remaining room on whole
  original sources in rank order without evicting another selected source.

Every arm counts the complete serialized JSON envelope using `o200k_base`, including
IDs, revisions, offsets, text and JSON escaping. Metadata for the experiment's own
report is not evidence sent to a model. No generated text is introduced.

## Evidence level and limitations

The ten public cases are **author-created synthetic development fixtures**, nine
answerable plus one no-answer. They cover nearby and remote exceptions, negation,
version changes, German/English mismatch, identifiers, a table and multiple sources.
The follow-up expansion arm was designed after seeing their failures. These cases
cannot certify independent transfer. Neither this tool nor its counters judge an
assistant's answer or infer abstention from whether evidence was returned.

The registration records the follow-up separately. A successful synthetic test
cannot turn `promotion: not_evaluable` into approval. Independent span labels,
adequate held-out volume, task-answer evaluation and separately reviewed integration
remain necessary. The raw lexical arm can omit distant qualifiers and cannot bridge
translation reliably. Expansion repairs these only when there is enough room.
