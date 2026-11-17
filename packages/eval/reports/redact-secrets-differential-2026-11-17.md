# redactSecrets before/after the split (#1528), 2026-11-17

Independent counter-review for #1528: try to find an input whose redaction changed when `redactSecrets` was split into scan passes. Written by an agent that did not do the split.

## Method

`packages/eval/scripts/redact-secrets-differential.mjs` loads two versions side by side and compares the full result (`text` and `redactedChars`) for every input, once without and once with a home directory (`/Users/n0mad`):

- before: `packages/core/src/scrub*.ts` as git holds them at `v1.2.1` (`scrub.ts`, `scrub-network.ts`, `scrub-psk.ts`), written to a temp directory from `git show`, not from a copy in the tree;
- after: the current `packages/core/src/scrub.ts` (HEAD `eba66497`).

Inputs:

1. Corpus: every string literal in `packages/core/__tests__/redact*.test.ts`, `scrub*.test.ts` and `fixtures/network-redaction-corpus.ts`, plus the corpus rows assembled from JSON string arrays (6,271 distinct strings, 12,542 comparisons).
2. Generated, seeded (mulberry32): mutations of corpus strings (delete, insert, replace, separators such as `=`, `: `, quotes, `\` + newline, case flips, invisible characters such as U+200B/U+202E/U+FEFF, splices of other corpus strings), two corpus strings joined by a separator, strings under the home directory, and random strings over the characters the patterns react to.

Sensitivity check: the same script with `--base a6016cc0` (before PSK redaction, #1110) reports 68 differences in a 2,000-case run, the first being `Der PSK lautet SommerHausBlau`, redacted only by the current version. So the harness does see a change in redaction.

```sh
npm ci
node --import tsx packages/eval/scripts/redact-secrets-differential.mjs --cases 1000000 --seed 1528
node --import tsx packages/eval/scripts/redact-secrets-differential.mjs --cases 1000000 --seed 20261117
node --import tsx packages/eval/scripts/redact-secrets-differential.mjs --cases 1000000 --seed 7
```

Node 24.16.0, macOS arm64.

## Result

| Seed | Corpus comparisons | Generated comparisons | Differences |
| --- | ---: | ---: | ---: |
| 1528 | 12,542 | 1,000,000 | 0 |
| 20261117 | 12,542 | 1,000,000 | 0 |
| 7 | 12,542 | 1,000,000 | 0 |

No input was found whose redaction differs between `v1.2.1` and `eba66497`.

## Limits

- A differential run finds differences it happens to generate; 0 is evidence, not proof. Inputs longer than about 300 characters and large multi-line documents are rare in the generated set.
- The comparison spans `v1.2.1` to HEAD, so it also covers the other changes to `scrub.ts` in that range: `d6aadfa8` adds the injected-block tag `report-notes`, and `eba66497` (the commit with the split) also adds markup defusing for injected blocks (`scrub-markup.ts`). Neither is meant to change `redactSecrets`, and the run agrees for the inputs above.
