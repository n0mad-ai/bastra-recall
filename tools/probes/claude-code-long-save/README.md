# Do long multiline saves survive the REAL Claude Code client? (#62)

**Answered: yes, on Claude Code 2.1.270 — 12 of 12 long saves arrived
byte-identical, and the progress channel #62 blames was open the whole time.**

## Why this exists, and why the existing stress test was not enough

`packages/daemon/scripts/stress-save-62.mjs` drives 70 long saves (600 to
200,000 chars) through a real daemon and a real stdio transport, and they all
land byte-identical. That is good coverage of **our** side of the wire.

It is not coverage of the boundary #62 is about. It instantiates the generic
MCP SDK `Client`; it never launches Claude Code. The defect #62 records lived
in Claude Code's own handling of tool arguments and `notifications/progress`,
and the generic SDK path was already known to succeed. So the stress test
could not have reproduced the failure even if it were still present.

This probe launches the real client.

## What it measures

Each session runs with `--output-format stream-json`, so every `tool_use`
block is on the wire in full — **including the exact `body` string Claude Code
sent**. The verdict is a byte comparison of that string against the file the
daemon wrote.

That distinction is the load-bearing part:

* a model that writes fewer lines than it was asked for is **not** data loss,
  and is reported separately (`modelWroteSomethingElse`) with no effect on the
  verdict;
* a save the client emitted and reported as **successful** whose bytes are not
  on disk **is** data loss (`savesAcceptedButAbsentOnDisk`), and no cheerful
  summary from the model can hide it.

It also turns on the forwarder's own `BASTRA_PROGRESS_DEBUG` diagnostic, which
logs per tool call whether the client attached a `_meta.progressToken`. Without
a token no `notifications/progress` is ever sent — so if the count came back
zero, the run would have proved nothing about progress handling, and would say
so instead of claiming a pass.

## Measured, 2026-09-13, Claude Code 2.1.270

4 sessions × 3 body sizes, throwaway vault, throwaway daemon:

| fact | value |
| --- | --- |
| `save_memory` calls the client actually emitted | 12 |
| body sizes sent (chars) | 2,990 / 9,131 / 22,991, four times each |
| bodies byte-identical on disk | **12** |
| bodies differing on disk | 0 |
| accepted by the client but absent on disk | 0 |
| duplicate titles written | 0 |
| transport errors seen by the client | 0 |
| tool calls carrying a `progressToken` | **24 of 24** (12 `recall`, 12 `save_memory`) |
| deviations | **0** |

The last row is the one that makes the rest mean something: the progress
channel was open on every single call, so the client-side path #62 blames was
exercised, not bypassed. It also corrects a stale note in
`packages/daemon/src/mcp-forwarder.ts`, which claimed Claude Code often omits
the token. On this version it never did.

## What this does NOT cover

* **Sizes above ~23,000 characters through the real client.** Larger bodies
  would have to be *written* by the model, token by token, which gets
  expensive fast. The 64 KiB pipe boundary and 200,000-char bodies are covered
  on our side of the wire by `stress-save-62.mjs`, not here.
* **Older Claude Code versions.** The original report is from a version that no
  longer exists on this machine. This says the boundary is sound on 2.1.270; it
  cannot say when it stopped failing.
* **The interactive client.** Headless `claude -p` is the same binary and the
  same MCP transport, but it is not a person typing in a terminal.

## Running it

```bash
bash tools/probes/claude-code-long-save/run.sh
SESSIONS=2 LINES=40,300 bash tools/probes/claude-code-long-save/run.sh
KEEP=1 bash tools/probes/claude-code-long-save/run.sh     # keep the temp world
```

It costs real tokens — the model writes every line of every body itself —
which is why it is a probe you run deliberately and not part of `npm test`.

The three steps can also be run by hand, which is what the script does:

```bash
WORK=$(SESSIONS=4 node tools/probes/claude-code-long-save/prepare.mjs)
# … one `claude -p` per prompt-N.txt, transcript into $WORK/transcripts/ …
node tools/probes/claude-code-long-save/verify.mjs "$WORK"
```

### What it touches, and what it does not

* a throwaway vault, a throwaway `HOME`, a throwaway working directory and a
  throwaway daemon on a random loopback port — all removed at the end
* `--strict-mcp-config` with a generated `mcp.json`, so the session sees
  **exactly one** MCP server: the forwarder prepared in step 1. Your own MCP
  registration is neither read nor written.
* every `BASTRA_*` variable in the child environment points at the throwaway
  daemon, so even a bastra hook from your own settings cannot reach a real
  vault
* it writes no settings file of yours and starts no daemon of yours

**One thing is deliberately not isolated: authentication.** A throwaway
`CLAUDE_CONFIG_DIR` is not logged in, and the only way to make it so is to copy
your credentials — which this probe will not do. So it authenticates the way
`claude` already does on your machine, and the run appears in your
`~/.claude.json` project list like any other `claude` run.

## Reading the result

`deviations: 0` with a non-zero `saveCallsEmittedByClient` is a pass.

* **`savesAcceptedButAbsentOnDisk` > 0** → the #62 shape, live. The client was
  told the save succeeded and the bytes are not there. Start at the forwarder
  and the HTTP body cap.
* **`bodiesDifferingOnDisk` > 0** → bytes changed in flight. The anomaly line
  names the index of the first difference, which is usually enough to tell
  truncation from encoding.
* **`progressTokensAttachedByClient.absent` > 0** → that call sent no progress
  token, so it says nothing about progress handling. If *all* of them are
  absent, this run did not test the boundary at all, whatever else it says.
* **`modelWroteSomethingElse` > 0 with 0 deviations** → the model got lazy.
  Annoying, not a defect; the bodies that were sent still arrived intact.
* **`saveCallsEmittedByClient: 0`** → the session never called the tool. Read
  `$WORK/transcripts/session-*.err` before concluding anything; the usual cause
  is the tool allowlist or a server that failed to start.
