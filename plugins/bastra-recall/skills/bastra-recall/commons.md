# Commons — sharing beyond your vault (opt-in, default OFF)

*Read this when a recall hit carries `scope: commons`, or when the user asks about sharing, contributing or bridges.*

Bastra Commons is a separate, **opt-in, default-OFF**, PR-gated public Git repo of community-proven engineering recipes — **not** your private vault.

`bastra commons enable` clones it read-only to `~/.bastra/commons`. The daemon then fuses its hits into `recall` under `scope: commons`, ranked just **below** your personal memories; on an id collision the personal hit wins. The daemon **never writes** the clone — all sharing goes through reviewed PRs, never auto-egress.

Your memories never leave the machine. The only things ever shared are deliberately-authored recipes, your `works`/`fails` verification records, and — when enabled via `bastra bridges enable` — **scrubbed bridges**: language-tagged `trigger_terms → expansion_terms` lists carrying **no memory id, no body, no vault content**. The scrub drops digits, paths, emails, snake_case and hashes; the PR review gate is the real privacy guarantee.

Two rules that don't bend:

- Never `save_memory` into the commons.
- Never treat a `scope: commons` recipe as your own state — it is someone else's verified experience, not a fact about this machine or this project.

Full mechanics, including how bridges are minted: `docs/commons.md` in the repo.
