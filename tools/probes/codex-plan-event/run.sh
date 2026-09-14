#!/usr/bin/env bash
#
# Codex plan-event probe (#506).
#
# Question this answers: does a real Codex session emit a plan/todo tool call
# that a PreToolUse hook can bind to — and under what name?
#
# For Claude Code the same question was settled by running the real client
# headless against an isolated settings file: a three-step plan produced three
# `TaskCreate` calls and zero `TodoWrite`. This is that run, for Codex.
#
# It is deliberately self-contained and harmless:
#   · runs in a THROWAWAY $CODEX_HOME, so your real ~/.codex is never read for
#     configuration and never written to
#   · the only hook it installs appends the payload to a file and answers `{}`
#   · no bastra daemon, no vault, no telemetry
#
# Usage:
#   bash tools/probes/codex-plan-event/run.sh              # needs auth in the probe home
#   bash tools/probes/codex-plan-event/run.sh --copy-auth  # reuse your existing login
#
# Afterwards: hand the printed capture file to Claude, or read it yourself —
# the tool names in it are the answer.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${CODEX_PROBE_HOME:-${TMPDIR:-/tmp}/bastra-codex-plan-probe}"
WORK_DIR="${HOME_DIR}/work"
CAPTURE="${HOME_DIR}/capture.jsonl"
COPY_AUTH=0
for arg in "$@"; do
  case "$arg" in
    --copy-auth) COPY_AUTH=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

command -v codex >/dev/null 2>&1 || {
  echo "✗ codex is not on PATH. Install it first, then re-run." >&2
  exit 1
}

echo "Codex version: $(codex --version 2>&1 | head -1)"
mkdir -p "$WORK_DIR"
: > "$CAPTURE"

# Every plan/todo tool name worth catching, plus the ones Codex is known to
# emit, so the capture also shows that the probe itself was live. Codex matchers
# are anchored regexes; `.` here is a catch-all on purpose — we are asking what
# the client sends, not asserting what it should send.
cat > "${HOME_DIR}/hooks.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".",
        "hooks": [
          {
            "type": "command",
            "command": "PROBE_LOG='${CAPTURE}' sh '${HERE}/probe.sh'",
            "timeout": 5,
            "statusMessage": "bastra plan probe"
          }
        ]
      }
    ]
  }
}
JSON

# An empty config, plus the plan tool switched on. If the key is not one this
# Codex version knows, --strict-config would reject the run — so the probe
# tries the strict form first and falls back, reporting which one it used.
cat > "${HOME_DIR}/config.toml" <<'TOML'
# Probe home — intentionally minimal.
TOML

if [ "$COPY_AUTH" = "1" ]; then
  if [ -f "${HOME}/.codex/auth.json" ]; then
    cp "${HOME}/.codex/auth.json" "${HOME_DIR}/auth.json"
    echo "· copied your existing login into the probe home"
  else
    echo "✗ no ~/.codex/auth.json to copy — run: CODEX_HOME='${HOME_DIR}' codex login" >&2
    exit 1
  fi
elif [ ! -f "${HOME_DIR}/auth.json" ]; then
  cat >&2 <<MSG
✗ the probe home has no login yet. Either:
    CODEX_HOME='${HOME_DIR}' codex login
  or re-run this script with --copy-auth to reuse the one you already have.
MSG
  exit 1
fi

PROMPT='Make a written plan with exactly three steps for adding a health endpoint to a small web service, using your plan/todo tool. Do not write any files and do not run any commands. Just record the plan, then stop.'

run_probe() {
  CODEX_HOME="$HOME_DIR" codex exec \
    --cd "$WORK_DIR" \
    --skip-git-repo-check \
    --sandbox read-only \
    --dangerously-bypass-hook-trust \
    "$@" \
    "$PROMPT" 2>&1 | tail -20
}

echo
echo "── run 1: plan tool explicitly enabled ─────────────────────────────"
# REQUIRED, not optional. Codex 0.152.0 turned the planning tool off by default:
#   "The planning tool is disabled by default; enable it with
#    `tools.update_plan.enabled = true`. (#41744)"
#   — openai/codex, release rust-v0.152.0, "Chores"
# Without this override the tool does not exist for the model at all, and the
# matcher has nothing to match. The key is not in the published config
# reference; the release notes are the only documentation of it.
if ! run_probe -c tools.update_plan.enabled=true; then
  echo "(that run failed — see the output above)"
fi

# The control arm: same prompt, default configuration. Expected to produce NO
# plan tool call — that is what makes "off by default" visible rather than
# inferred, and it is the explanation for the seven-day zero in #506.
echo
echo "── run 2 (control): default configuration, plan tool off ───────────"
CONTROL="${HOME_DIR}/capture-control.jsonl"
: > "$CONTROL"
CAPTURE_BEFORE="$CAPTURE"
CAPTURE="$CONTROL"
cat > "${HOME_DIR}/hooks.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".",
        "hooks": [
          {
            "type": "command",
            "command": "PROBE_LOG='${CONTROL}' sh '${HERE}/probe.sh'",
            "timeout": 5,
            "statusMessage": "bastra plan probe (control)"
          }
        ]
      }
    ]
  }
}
JSON
run_probe || true
CAPTURE="$CAPTURE_BEFORE"
echo
echo "control arm captured:"
grep -o '"tool_name":"[^"]*"' "$CONTROL" 2>/dev/null | sed 's/.*://' | sort | uniq -c | sed 's/^/  /' || true
grep -q '"update_plan"' "$CONTROL" 2>/dev/null \
  && echo "  ⚠ update_plan fired WITHOUT the override — the default may have changed." \
  || echo "  (no update_plan — as expected when the tool is off by default)"

echo
echo "════════════════════════════════════════════════════════════════════"
if [ -s "$CAPTURE" ]; then
  echo "Captured tool calls:"
  # No jq dependency: the tool name is a plain JSON string field.
  grep -o '"tool_name":"[^"]*"' "$CAPTURE" | sed 's/.*://' | sort | uniq -c | sed 's/^/  /'
  echo
  echo "Full capture (hand this file to Claude):"
  echo "  $CAPTURE"
else
  echo "NOTHING WAS CAPTURED."
  echo "That is a result too — it means no PreToolUse hook fired at all in this"
  echo "run, so the probe cannot say anything about the plan tool. Check the"
  echo "Codex output above for an error before concluding anything."
fi
echo "Probe home (delete when done): $HOME_DIR"
