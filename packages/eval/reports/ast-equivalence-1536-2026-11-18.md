# AST equivalence of the Prettier commit 0f9f0604 (#1536), 2026-11-18

`registrations/fingerprint-map-1536.json` calls the one-time reformatting behaviour-neutral and maps the source fingerprints it changed. This report is the attributable evidence for that word: the syntax trees of the files before and after the commit.

## Method

`packages/eval/scripts/ast-equivalence.mjs` reads each file with `git show` at the formatter commit `0f9f06045626232114100592fca7dd533a5eb6cb` and at its parent `82abb7bd5bb54054adf9d63d7cf6fb5c721e8c64`, parses both with the TypeScript parser (6.0.3) and compares the trees:

- comments and whitespace are not part of the tree;
- string and template literals are compared by value (templates by raw text, which `String.raw` sees), numbers by numeric value, regex flags in sorted order;
- parentheses are unwrapped, because the tree already encodes the grouping; `||`, `&&` and `??` chains are compared flat, because these operators are associative in value and evaluation order;
- `let`/`const`/`using`, namespace form and the extent of `?.` chains are kept (node flags);
- directive prologues (the leading bare strings of the file and of each function body, such as `"use strict"`) are compared by their raw text before parentheses are unwrapped or strings are read by value: a parenthesised or escaped `"use strict"` is no directive and leaves the code non-strict, so it must not compare equal. Added after review: the first version of the script unwrapped and decoded these as well and would have called `"use strict"` and `("use strict")` equal.

`__tests__/ast-equivalence.test.ts` shows both directions: quote style, semicolons, comments, trailing commas, number spelling, re-nested `||`/`&&` chains, regex flag order and redundant parentheses compare equal; `let`→`const`, changed grouping, a changed `?.` extent, another string, number, regex flag or raw template, and a parenthesised or escaped `"use strict"` directive (in a function and at file level) compare unequal; the quote style of a directive compares equal. It also reproduces the registered artefact from git.

## Commands

```sh
npm ci
node packages/eval/scripts/ast-equivalence.mjs --out packages/eval/registrations/ast-equivalence-0f9f0604.json
node packages/eval/scripts/ast-equivalence.mjs --all > /tmp/ast-all.json
```

Exit code 0 means every compared tree is equal, 1 means a file differs or does not parse. The output carries no timestamp; a rerun gave a byte-identical file. Node 24.16.0, macOS arm64.

## Result

| Scope | Files | Equal | Differing |
|---|---|---|---|
| Files of the 8 formatter cases in `fingerprint-map-1536.json` (registered: `registrations/ast-equivalence-0f9f0604.json`) | 10 | 10 | 0 |
| `--all`: every modified `.ts/.mts/.js/.mjs` file of the commit | 1,494 | 1,494 | 0 |

The ten files: `chunk-maxsim-run.ts`, `chunk-maxsim.ts`, `longmemeval-run.ts`, `longmemeval-dataset.ts`, `chunk-vault-coverage.ts`, `correction-sequences.ts`, `flat-scale-subset.ts`, `supersession-durability.ts`, `supersession-hybrid.ts` (under `packages/eval/src/`) and `packages/eval/scripts/draft-csls.mjs`. All ten changed bytes (their sha256 before and after are in the artefact) and none changed its tree.

Rerun after the directive rule (script sha256 in the artefact): unchanged, 10/10 and 1,494/1,494. None of the 1,494 files has a directive prologue at the formatter commit (nor, as the trees are equal, at its parent), so the gap had no effect on this result.

The first `--all` pass, before the chain and regex rules existed, reported three files. Each was a layout change Prettier makes, now covered by a rule with a test:

- `packages/core/src/scrub.ts`: regex flags `gmi` written as `gim`;
- `packages/daemon/src/cli/adapters/claude-code.ts` and `codex.ts`: `a || … || (x || y)` written without the inner parentheses.

## Limits

- Not compared: 26 non-code files of the commit (20 CSS, 5 JSON, 1 YAML) and the two added files `.prettierignore`, `.prettierrc.json`. Python sources were not part of the commit.
- The comparison is syntactic and only as strong as its normalisation rules. It shows that the trees before and after are equal under exactly the rules listed under Method, which the test backs with equal and unequal controls; it is not a general proof of semantic equivalence and does not execute anything. A rule that equates two differently behaving spellings (as the directive case did before review) would hide such a change.
- `fingerprint-map-1536.json` is unchanged (frozen); its `$comment` still points at #1506 for the proof, which is this artefact.
