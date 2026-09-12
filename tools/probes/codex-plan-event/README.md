# Does Codex emit a plan event? (#506)

**Status: unproven.** Everything measured so far says the lane does not fire on
Codex. Nothing measured so far says it *cannot*. This directory is the run that
would settle it — it takes about two minutes and only you can start it, because
it needs a login.

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
| Codex hook calls that DID fire, tagged `client: "codex"` | 290 |
| — of those, `UserPromptSubmit` | 93 |
| — of those, `Bash` | 57 |
| — of those, `apply_patch` | 26 |
| — of those, `update_plan` | **0** |

So the hook file was live and trusted, Codex was in daily use, four other
matchers in the same file fired hundreds of times, and the plan matcher never
fired once. That is as far as passive observation gets. It does not distinguish
between:

* Codex no longer offers a plan tool under that name, or
* the tool exists but is off by default in this version, or
* the model simply never chose to use it in those sessions.

The probe distinguishes them by asking for a plan explicitly.

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
* first run enables the plan tool explicitly (`-c tools.update_plan.enabled=true`);
  if nothing is captured it repeats on the default configuration, so the output
  distinguishes "off by default" from "gone"

> **Caveat on that config key.** `tools.update_plan.enabled` is the key reported
> for recent Codex versions, but it is **not verified against a primary source**
> — Codex's public documentation does not document the plan tool's config
> surface (checked 2026-09-12). The probe passes it without `--strict-config`,
> so an unknown key is ignored rather than fatal, and the second run covers the
> default configuration regardless. If you know the real key, edit `run.sh`.

Delete the probe home afterwards; the script prints its path.

## Reading the result

The script prints the tool names it captured. Hand the full capture file to
Claude, or read it yourself — each line is one `PreToolUse` payload, and the
`tool_name` field is the answer.

* **`update_plan` appears** → the promise holds; the open question becomes
  whether the tool is on by default, which the two runs above separate.
* **a different plan/todo tool name appears** → that is the new name. It goes
  into the Codex matcher in `packages/daemon/src/cli/adapters/codex.ts` and into
  `PLAN_TOOLS` in `packages/daemon/src/todo-lane.ts`, the same way `TaskCreate`
  did for Claude Code, with the captured payload as the test fixture.
* **only `shell` / `apply_patch` / other tools appear, no plan tool** → Codex
  offered the model no plan tool in this configuration. Then the product claim
  for Codex is not backed by anything and has to be narrowed — a decision, not
  a code change.
* **nothing at all is captured** → the probe itself did not run. Read the Codex
  output above the summary before concluding anything.

## Precedent

The Claude Code half of #506 was settled exactly this way: `claude -p` against
an isolated settings file whose only hook recorded its stdin. A three-step plan
produced three `TaskCreate` calls and zero `TodoWrite`. That capture is the
fixture in `packages/daemon/__tests__/todo-lane-live-event.test.ts` — a test
that asserts against the shape the client really sends, rather than the shape
the fix expects.
