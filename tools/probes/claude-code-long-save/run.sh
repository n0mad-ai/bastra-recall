#!/usr/bin/env bash
#
# #62 — repeated long multiline saves through the REAL Claude Code client.
#
# `packages/daemon/scripts/stress-save-62.mjs` already drives 70 long saves
# through our own transport with the generic MCP SDK client. That covers our
# side of the wire; it cannot cover the boundary #62 is actually about, because
# it never launches Claude Code. This does.
#
# Three steps, deliberately kept apart so each one is plain to read:
#   1. prepare.mjs  — throwaway vault + HOME + daemon + MCP config + prompts
#   2. this loop    — `claude -p`, once per session, transcript to a file
#   3. verify.mjs   — compares the bytes the CLIENT SENT with the bytes on disk
#
# What it does NOT touch: your vault, your settings.json, your MCP
# registration. `--strict-mcp-config` means the session sees exactly one
# server — the throwaway forwarder prepared in step 1 — and every BASTRA_*
# variable in the child environment points at the throwaway daemon, so even a
# bastra hook from your own settings cannot reach a real vault.
#
# What it does NOT isolate, on purpose: authentication. A throwaway
# CLAUDE_CONFIG_DIR is not logged in, and the only way to make it so is to copy
# your credentials, which this script will not do. So the run authenticates the
# way `claude` already does on this machine, and shows up in your
# `~/.claude.json` project list like any other run.
#
# Usage:
#   bash tools/probes/claude-code-long-save/run.sh
#   SESSIONS=2 LINES=40,300 bash tools/probes/claude-code-long-save/run.sh
#   PROBE_MODEL=claude-sonnet-4-6 bash tools/probes/claude-code-long-save/run.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSIONS="${SESSIONS:-4}"

command -v claude >/dev/null 2>&1 || {
  echo "✗ claude is not on PATH. Install Claude Code first, then re-run." >&2
  exit 1
}
echo "Claude Code version: $(claude --version 2>&1 | head -1)"

WORK="$(SESSIONS="$SESSIONS" node "${HERE}/prepare.mjs")"
echo "· throwaway world: ${WORK}"
PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+"/state.json","utf8")).port)' "$WORK")"
VAULT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+"/state.json","utf8")).vault)' "$WORK")"

MODEL_ARGS=()
[ -n "${PROBE_MODEL:-}" ] && MODEL_ARGS=(--model "$PROBE_MODEL")

i=0
while [ "$i" -lt "$SESSIONS" ]; do
  echo "── session $((i + 1))/${SESSIONS} ───────────────────────────────────"
  BASTRA_VAULT_PATH="$VAULT" \
  BASTRA_DAEMON_URL="http://127.0.0.1:${PORT}" \
  BASTRA_HTTP_PORT="$PORT" \
  BASTRA_TELEMETRY=off \
  BASTRA_UPDATE_CHECK=off \
  BASTRA_FORWARDER_SPAWN=0 \
  BASTRA_AUTOSTART_MANAGED=0 \
    claude \
      --mcp-config "${WORK}/mcp.json" \
      --strict-mcp-config \
      --allowedTools "mcp__bastra62__save_memory,mcp__bastra62__recall" \
      --output-format stream-json \
      --verbose \
      "${MODEL_ARGS[@]}" \
      -p "$(cat "${WORK}/prompt-${i}.txt")" \
      > "${WORK}/transcripts/session-${i}.jsonl" 2>"${WORK}/transcripts/session-${i}.err" \
    || echo "  (that session exited non-zero — verify.mjs will say what it managed)"
  i=$((i + 1))
done

echo
echo "════════════════════════════════════════════════════════════════════"
node "${HERE}/verify.mjs" "$WORK" ${KEEP:+--keep}
