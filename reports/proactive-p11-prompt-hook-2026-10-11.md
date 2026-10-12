# P11 prompt-hook process timing (synthetic, 2026-10-11)

Owner-requested comparison against the 200 ms ceiling in #305. The compiled Node
prompt hook was measured from process spawn through close against real isolated
local daemons. Empty synthetic vaults, BM25, five warmups and 30 measurements per
arm, interleaved. The due arm uses distinct mapped Agent identities so its 60 s
quiet window cannot turn a supposed card sample into a silent sample. Every due
process actually received a card; the other arms received none.

| Arm | n | Median ms | p95 ms | Maximum ms |
|---|---:|---:|---:|---:|
| v1.1.0, no tasks | 30 | 91.41 | 98.07 | 98.69 |
| P11b P2, no tasks | 30 | 92.07 | 97.18 | 97.77 |
| P11b P2, due card | 30 | 92.44 | 97.01 | 141.09 |

All measured samples were below 200 ms. This small empty-vault process fixture
is not a large-vault latency claim or long-term pass. Raw timings, runtime/host,
response byte counts and compiled-hook hashes are in the adjacent JSON.

Reproduce with an isolated built v1.1.0 worktree at b1e39ec5 and the built current
worktree. The harness refuses to run without the existing test isolation preload:

```sh
node --import ./scripts/test-env.mjs tools/proactive-p11-hook-benchmark.mjs /ABSOLUTE/V1.1.0/WORKTREE
```

It creates only synthetic temporary vaults/credentials/ports, never port 6723,
and stops only its own daemon processes. No actual user vault or service was used.
