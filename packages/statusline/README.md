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
selects the alien cockpit; `--design ember` selects the borderless ember field.
All three read the same data and are independently selectable.

Ember is borderless and structured by tinted bands: header, the Recall sieve
with context and limits, a Recall row for the current activity, and a two-line
footer for repository and session. The sieve reads left to right as a sentence in
one visual language, every dot is a memory: the vault as a cloud of small dots,
then exactly one large dot per memory found since the last human prompt, then
one per loaded memory (capped by the available room; the numbers above stay
exact). Next to it Ember lists the titles of the
memories loaded in this turn, newest first. Titles come from the tool results
in the local transcript and are only held in the panel's memory. All three designs show loaded titles, the five-hour limit and API time when the client reports them. The cloud shimmers and sparks fly between the stages only during real Recall activity or its
labelled afterglow. Ember needs truecolor and at least 90 columns; narrower
panes get a seven-line text summary.

```sh
bastra-recall-panel --session <claude-session-id> --watch --design orbital
bastra-recall-panel --session <claude-session-id> --watch --design classic
bastra-recall-panel --session <claude-session-id> --watch --design ember
bastra-recall-panel --client codex --session <codex-session-id> --watch --design orbital
bastra-recall-panel --client codex --cmux
```

All three designs have a compact view: header, one line with the context, five-hour and
seven-day gauges plus the Recall counts, and the activity row. Click the arrow
at the right of the header or press `m` in the panel; `--compact` starts in it.
The half-moon next to it (or `h`, or `--light`) changes to a light skin on warm paper.
While the panel listens for clicks, select text with Shift held.

`bastra-recall-panel --ensure --design ember --compact` is meant for a Claude
Code `SessionStart` hook: inside cmux it opens the panel under the session's
pane unless one is already running there, prints nothing and never fails;
outside cmux it does nothing. A panel opened
with `--cmux` resizes its pane to the rows it draws whenever the view changes.

Codex autostart is installed with `bastra-recall-panel --install-codex-hook --design ember --compact`.
It preserves existing hooks, backs up the hook file, and adds a normal `SessionStart`
hook for startup/resume. Review and enable it in Codex `/hooks`; the installer never
writes trust hashes. `--ensure --client codex` uses the exact hook session's cmux
registration when a shared daemon does not supply a surface environment variable.
If that registration is absent it quietly waits for a later start instead of
opening under an unrelated tab. Existing panels are reused.

The Codex reader uses local JSONL history, whose format is version-dependent;
paginated-only history is still unsupported. Model-reported token and rate-limit
fields are used as supplied. See the official [Codex hooks guide](https://learn.chatgpt.com/docs/hooks)
and [app-server protocol](https://learn.chatgpt.com/docs/app-server).

Opened with `--cmux` and without `--session`, the panel follows the pane it was
opened under instead of one session: once per second it asks cmux which tab is
selected there and shows the Claude or Codex session cmux last recorded for
that tab. A new session in the same tab, or switching tabs, rebinds the panel;
a tab without an agent shows a waiting state. `--session` keeps the old fixed
binding.

Live mode reads the native Claude statusline snapshot published by
`dist/claude-panel-feed.mjs --renderer '<original statusLine.command>'`.
This wrapper receives Claude's JSON on stdin, writes only the small session
metadata snapshot under `~/.bastra/panels/claude/`, and delegates to the original
renderer so the existing footer stays intact. Without `--renderer` it only publishes the snapshot and prints nothing, for
setups where the panel replaces the footer. It is configured as Claude's
`statusLine.command`, with `refreshInterval: 1`; back up settings before changing
that command. Claude reloads it automatically. Replacing that command later
also removes the feed, which the panel reports as stale instead of keeping old values.

Context is Claude's native **used** percentage, not the footer's remaining value.
Weekly usage comes only from `rate_limits.seven_day.used_percentage`. Missing
measurements stay unknown. After ten seconds without a native update, values
are marked unavailable. Recall counts are deduplicated from this session's
main-thread transcript, reset on each new human prompt, and count successful
Recall/document searches, returned candidates, loads/reads and saves/edits. Automatic prompt hints are not completed tool searches; directly loading a hinted memory can therefore show a load with zero searches or hits. Failed calls appear
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
session tokens. Cost and API duration missing from Codex's stream remain unknown. Its reported cached input tokens divided by cumulative input tokens appear as `Cache-Eingabe`; this is distinct from Claude's reported request cache-hit ratio.
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
