# @bastra-recall/statusline

Statusline for Claude Code, shipped with [bastra-recall](https://github.com/n0mad-ai/bastra-recall).

Built on [owloops/claude-powerline](https://github.com/owloops/claude-powerline) (MIT, vendored)
with a `bastra-status` segment that surfaces live recall/save activity from the bastra-recall daemon.

## Install

It is wired up automatically by `bastra install claude-code`. To add it by hand, point your
Claude Code `statusLine` setting at the binary:

```jsonc
// ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "node <path>/@bastra-recall/statusline/dist/index.mjs --style=powerline",
    "refreshInterval": 1
  }
}
```

## Codex Powerline panel

`bastra-codex-statusline --cmux` opens a compact live Powerline panel below the
Codex terminal in cmux. Run it from the Codex terminal's shell (or pass its
`CMUX_SURFACE_ID` as `--surface UUID` from another terminal). It binds to that
surface's registered Codex session, never whichever session happens to be newest.

The first row shows project/branch, model/reasoning, reported usage windows,
context usage, and the live vault size. The second shows successful searches,
returned candidates, memory/document loads, saves/edits, elapsed tool time, and
failures. Calls include other Bastra tools as well. Counters reset each user turn.
The live search stage comes from the existing Bastra feed; finished calls come
from Codex's transcript, so they are not counted twice.

```sh
bastra-codex-statusline --cmux
bastra-codex-statusline --session <id> --watch
bastra-codex-statusline --transcript /path/to/rollout.jsonl --json
bastra-codex-statusline --demo
```

For a source checkout, use `node packages/statusline/bin/bastra-codex-statusline`
after `npm run build --workspace=@bastra-recall/statusline`.

Usage percentages mean **used**, and quota windows are labeled by their actual
duration. Missing windows are omitted; missing context is `—`. Context is the
latest reported request token total divided by the reported context window;
it is a snapshot, not a tokenizer for messages still being composed. The token
counter is cumulative session usage, including repeated input. It is not the
context size or a cost estimate.

The panel reads local metadata only, never evaluates tool arguments and never
sends messages to Codex. It refreshes at 200 ms, reads JSONL incrementally and
supports resize, `--ascii`, `--no-color` and `NO_COLOR`. Close its tab or press
Ctrl-C to stop it. Start it again for a new session; it stays pinned to its original
session. cmux may enforce a minimum pane height larger than the two display rows.

This is a separate panel, not a custom item in Codex's native footer. It requires
legacy JSONL history; paginated-only histories are not supported. Codex's rollout
format is version-dependent: unrecognized rows are ignored, unavailable sources
are shown as unavailable, and no missing measurement is replaced with a fake zero.

## Experimental Neural Console

`--design classic` preserves the first Neural Console; `--design orbital`
selects the alien cockpit. Both read the same data and are independently selectable.

```sh
bastra-recall-panel --session <claude-session-id> --watch --design orbital
bastra-recall-panel --session <claude-session-id> --watch --design classic
bastra-recall-panel --client codex --session <codex-session-id> --watch --design orbital
bastra-recall-panel --client codex --cmux
```

Live mode reads the native Claude statusline snapshot published by
`dist/claude-panel-feed.mjs --renderer '<original statusLine.command>'`.
This wrapper receives Claude's JSON on stdin, writes only the small session
metadata snapshot under `~/.bastra/panels/claude/`, and delegates to the original
renderer so the existing footer stays intact. It is configured as Claude's
`statusLine.command`, with `refreshInterval: 1`; back up settings before changing
that command. Claude reloads it automatically. Replacing that command later
also removes the feed, which the panel reports as stale instead of keeping old values.

Context is Claude's native **used** percentage, not the footer's remaining value.
Weekly usage comes only from `rate_limits.seven_day.used_percentage`. Missing
measurements stay unknown. After ten seconds without a native update, values
are marked unavailable. Recall counts are deduplicated from this session's
main-thread transcript, reset on each new human prompt, and count successful
searches, returned candidates, loads/reads and saves/edits. Failed calls appear
in the activity text. `Recall` uses the exact same forwarder duration as the old
Bastra footer when the session, turn and completed-call count match. `Client`
measures invocation-to-result time including the client's transport/dispatch
overhead. These are distinct boundaries, so the Client number can be higher.
If the forwarder feed cannot be matched safely, only Client time is shown.

The metadata row shows Git branch and short SHA, staged/modified/new files,
conflicts and ahead/behind relative to local upstream refs. Git is read without
network or index locks, at most once per five seconds. It does not fetch remote
changes; unavailable Git data is unknown, not a clean tree. When supplied by the
client, session duration, reasoning effort, estimated list-price cost, cache-hit
ratio and changed-line counts are displayed. Codex also reports cumulative
session tokens. Costs/cache values not present in Codex's stream are not guessed.
The Codex context readout uses its own reported effective context window and
latest request token usage; it does not borrow Claude's window size or quota.
The shared vault count remains current across sessions. A matching fresh feed
supplies in-flight stages. The activity signal moves during general Claude work;
the orbital core reacts to Recall tools and keeps a labelled five-second
completion afterglow, so a fast call is visible even between refreshes. An idle
panel emits no redraw. Changed rows are painted with synchronized terminal
updates instead of clearing the screen. No prompts or memory bodies are retained
in the feed.

`bastra-recall-panel --demo --watch` previews an alternative instrument-panel
design: large context/usage digits, three search lanes, a Recall result path and
an animated demo waveform on a midnight-blue canvas. It is intentionally marked
**DESIGN / DEMO**. Live data is selected separately with `--session`.

Use `--cmux --surface UUID --workspace UUID --demo` to place the preview below a
specific terminal. `--snapshot FILE` displays an explicit `NeuralData` JSON
snapshot instead; it is marked SNAPSHOT and never animates a fake search.
Close the preview tab or press Ctrl-C there to stop it.

## License

MIT. Bundles `owloops/claude-powerline` under the MIT License.
