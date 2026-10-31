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
The replay now checks explicit per-round correspondence decisions (#1340) and
validator enforcement without a task report (#1341). Every effective validator
or correspondence-category rule needs its own applicable/load/not_applicable
decision. A single category declaration can cover all unprotected correspondence IDs; active task and session-loaded IDs remain binding. Explicit attempts to dismiss them are ignored and counted as violations. An empty check cannot silently discharge it. One rulebook Stop block
is allowed, then unchecked passage is reported. Claude Code gets at most two
copy repairs; Codex records violations without same-turn length repair (#1311).
The model can still lie in its explicit decision; there is no semantic checker.

Cost controls measure 50 harmless scripted rounds (question, calculation, ack,
code, translation): one check each and no additional Stop blocks/repairs. The
40 deliberately unchecked harmless rounds each get the bounded first block.
Both SessionStart and UserPromptSubmit output are measured against 10,000 characters, including the round notice. Payload bytes are measured, not LLM tokens or real-model frequency. Both former
GAP cases are now PASS for all five languages and both host identifiers.

All assertions have finite loops and HTTP deadlines; the daemon-outage probe
launches only the repository's thin gate client, with isolated environment
and a five-second process deadline. It shuts down/restarts only disposable
servers. The tests cannot certify installed Claude/Codex hook enforcement,
agent semantic judgement, arbitrary language coverage or arbitrary wording.

Tracking: [#1340](https://github.com/n0mad-ai/bastra-recall/issues/1340) and
[#1341](https://github.com/n0mad-ai/bastra-recall/issues/1341). Issue closure waits
for counter-review. Translated data and shared replay live in
`packages/daemon/__tests__/fixtures/rulebook-phase5/` and are typechecked.

Source updates use the in-memory index only, following watcher/reindex or the
background reconciliation. Existing rules may be edited directly by agents;
new agent validators/declarations remain proposals. Validator-only and session
activation/floor status cannot authorize promotion of an ordinary note. Channel
selection needs an authored trigger in the user's own text and a matching
current validator. Compact can drop loaded-only delivery evidence; each new
round still requires current correspondence decisions. The Codex task-before-
load control checks the actual loaded ID even though native length repair is off.
