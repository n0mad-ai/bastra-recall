# Does Codex emit a plan event? (#506)

**Answered: yes — but the tool is off by default, and that is why the lane was
silent.**

Codex **0.152.0** turned the planning tool off by default:

> The planning tool is disabled by default; enable it with
> `tools.update_plan.enabled = true`. (#41744)
> — [openai/codex, release `rust-v0.152.0`](https://github.com/openai/codex/releases/tag/rust-v0.152.0), "Chores"

The reference host runs Codex CLI **0.153.4** and its `~/.codex/config.toml`
has **no `[tools]` section at all** — verified read-only. So the tool does not
exist for the model there, and the `^update_plan$` matcher in
`~/.codex/hooks.json` cannot fire however correctly it is written. That is the
whole explanation for the seven-day zero on the Codex side of #506.

With the tool enabled, a real Codex session does emit it automatically, to a
real `PreToolUse` hook, in exactly the shape this repo's lane already expects:

```json
{ "hook_event_name": "PreToolUse",
  "tool_name": "update_plan",
  "tool_input": { "plan": [ { "step": "think", "status": "pending" } ] } }
```

The key is documented **only** in those GitHub release notes — it is absent
from the published
[Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and from the public changelog
([openai/codex#42365](https://github.com/openai/codex/issues/42365) asks for it
to be documented and is unanswered).

Two things this does **not** cover, and neither should be assumed:

* **ChatGPT desktop Codex and the IDE extension.** Only the CLI was verified.
  [openai/codex#21639](https://github.com/openai/codex/issues/21639) ("Hooks no
  longer run after Codex Desktop update") suggests desktop behaviour diverges.
* **The hook trust gate.** A hook does not run until its exact definition is
  reviewed via `/hooks`, and trust is keyed to the hook's hash — so *editing a
  hook command silently stops it firing* until re-trusted.

Run the probe below to reproduce any of this yourself.

## Why this exists

`bastra install codex` registers a `PreToolUse` hook on `^update_plan$` so the
vault's topology facts reach Codex before it writes a plan. README and client
docs promise that. #506 found the lane had produced **zero** events in seven
days — and for Claude Code the cause turned out to be a matcher bound to a tool
the client had renamed (`TodoWrite` → `TaskCreate`, verified live, fixed).

For Codex the same question is still open, and the evidence we have is negative
but indirect.

## What is already measured (reference host, 2026-09-05 → 2026-09-12)

Read out of `~/.bastra/logs`, read-only:

| fact | value |
| --- | --- |
| `^update_plan$` registered in `~/.codex/hooks.json` | yes |
| trusted by Codex (`hooks.state` entry in `config.toml`) | yes |
| Codex CLI version on the host | 0.153.4 |
| `[tools]` section in `~/.codex/config.toml` | **absent** → plan tool off |
| Codex hook calls that DID fire, tagged `client: "codex"` | 290 |
| — of those, `UserPromptSubmit` | 93 |
| — of those, `Bash` | 57 |
| — of those, `apply_patch` | 26 |
| — of those, `update_plan` | **0** |

The hook file was live and trusted, Codex was in daily use, four other matchers
in the same file fired hundreds of times, and the plan matcher never fired once
— because the tool it names was disabled the whole time.

## Running it

```bash
# one-time: give the throwaway probe home a login
CODEX_HOME="${TMPDIR:-/tmp}/bastra-codex-plan-probe" codex login

bash tools/probes/codex-plan-event/run.sh
```

or, to reuse the login you already have instead of logging in again:

```bash
bash tools/probes/codex-plan-event/run.sh --copy-auth
```

`--copy-auth` copies `~/.codex/auth.json` into the probe home. It is your
credential on your machine and it never leaves it — but it is a copy of a
credential, which is why the script will not do it unless you ask.

### What it does, and what it does not touch

* runs in a throwaway `$CODEX_HOME` (`$TMPDIR/bastra-codex-plan-probe`), so your
  real `~/.codex` is never used for configuration and never written to
* installs exactly one hook there: a three-line shell script that appends the
  payload to a file and answers `{}`
* asks for a three-step plan and forbids file writes and shell commands
* runs sandboxed read-only
* touches no bastra daemon, no vault, no telemetry
* run 1 enables the plan tool (`-c tools.update_plan.enabled=true`); run 2 is
  the control arm on the default configuration, where the tool should NOT
  appear. Two arms rather than one, so "off by default" is shown rather than
  inferred — and so a future Codex release that changes the default shows up as
  the control arm suddenly firing.

Delete the probe home afterwards; the script prints its path.

## Reading the result

The script prints the tool names it captured in each arm. Each line of a capture
file is one `PreToolUse` payload; the `tool_name` field is the answer.

Expected today: `update_plan` in run 1, absent in the control arm.

* **`update_plan` in run 1, absent in the control** → what is documented above.
  The lane is wired correctly; what stands between a user and the promised
  recall-before-plans is one line in their own `~/.codex/config.toml`.
* **`update_plan` in BOTH arms** → Codex changed the default back. Good news;
  worth recording, and the note in this README goes stale.
* **a different plan/todo tool name appears** → that is the new name. It goes
  into the Codex matcher in `packages/daemon/src/cli/adapters/codex.ts` and into
  `PLAN_TOOLS` in `packages/daemon/src/todo-lane.ts`, the same way `TaskCreate`
  did for Claude Code, with the captured payload as the test fixture.
* **no plan tool in either arm** → the config key stopped working or was
  renamed. Check the Codex release notes for the version you are on.
* **nothing at all is captured** → the probe itself did not run. Read the Codex
  output above the summary before concluding anything. The likeliest cause is
  the hook trust gate.

## Precedent

The Claude Code half of #506 was settled exactly this way: `claude -p` against
an isolated settings file whose only hook recorded its stdin. A three-step plan
produced three `TaskCreate` calls and zero `TodoWrite`. That capture is the
fixture in `packages/daemon/__tests__/todo-lane-live-event.test.ts` — a test
that asserts against the shape the client really sends, rather than the shape
the fix expects.
