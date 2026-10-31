# Rulebook Phase 5 (#1336)

Offline, repeatable production HTTP/lane replay with 125 invented rules in
German, English, Japanese, Russian and Spanish. No native host or model is
started. No installed hooks or user vault are used by the default run.

From the repository root (Node >=22, dependencies and core/daemon built):

```sh
node --import tsx --import ./scripts/test-env.mjs tools/probes/rulebook-phase5/run.ts --report /private/tmp/phase5-report.md
```

For the optional **read-only** real-vault latency run, inspect your
`~/.bastra/vault-roots.json` first and supply the intended existing root:

```sh
node --import tsx --import ./scripts/test-env.mjs tools/probes/rulebook-phase5/run.ts --real-vault '/absolute/vault/root' --report /private/tmp/phase5-report.md
```

All writes (settings, state, logs, root registry) go to the isolated test home.
The latency sample uses four sessions on a disposable production HTTP server,
lexical retrieval with embeddings disabled, and no file watcher. It includes
HTTP roundtrip, excludes vault initialization and two warmups, and reports
median/p95, raw samples and decision counts in the adjacent JSON. No texts,
IDs or user vault paths are exported in that JSON. Native hook startup and
embedding/model latency are outside the measurement.

The normal test suite runs the same replay via `rulebook-phase5.test.ts`.
The report distinguishes unexpected failures from **expected reproduced
gaps**: a green test run is not proof that every rule is obeyed. In particular,
an empty applicability report can bypass correspondence loading; omitting a
task bypasses length repair. Codex same-turn length repair is disabled even
with a task. These are measured, not fixed by this package. Task repair has
its own bounded requests, separate from the single rulebook Stop block.

All assertions have finite loops and HTTP deadlines; the daemon-outage probe
launches only the repository's thin gate client, with isolated environment
and a five-second process deadline. It shuts down/restarts only disposable
servers. The tests cannot certify installed Claude/Codex hook enforcement,
agent semantic judgement, arbitrary language coverage or arbitrary wording.

Tracked gaps: [correspondence load bypass #1340](https://github.com/n0mad-ai/bastra-recall/issues/1340)
and [task omission #1341](https://github.com/n0mad-ai/bastra-recall/issues/1341).
Translated fixtures and the shared replay implementation live in
`packages/daemon/__tests__/fixtures/rulebook-phase5/` and are typechecked with
the daemon tests. These tests deliberately reproduce the gaps; a green suite
does not turn a `GAP` report cell into a passing acceptance case.

The security/fix1/fix2 suites exercise the actual Stop lane and source writes.
Fix2 removes session minima: current indexed user revisions apply on the next Stop (watcher/reindex or
the documented ~60-second reconciliation), while MCP edits/saves/archives of existing validator rules are proposals.
Channel selection is task/context scoped, cleared on new turns without a
matching candidate, and narrows only to a channel with a loaded/active rule.
Compact may drop loaded-only rules while the task continues; active rules
are the retained delivery set. This is a documented supported boundary.
The Codex task-before-load case asserts the loaded ID and selected validator;
omitting the load must fail it even though Codex length repair is unsupported.
