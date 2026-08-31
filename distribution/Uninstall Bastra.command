#!/usr/bin/env bash
# Uninstall Bastra.command — double-click in Finder to remove bastra-recall.
#
# Removes the MCP registration from every AI client, stops the daemon, and
# drops the runtime scaffolding. It NEVER touches your memories: the vault,
# ~/.bastra/logs/ and your settings stay exactly where they are.
#
# Leaving has to be as easy as arriving — that is part of what "local-first"
# means here. Whatever this script removes is printed as it goes, so you can
# audit it afterwards in the log.

set -euo pipefail

mkdir -p "$HOME/Library/Logs"
exec > >(tee -a "$HOME/Library/Logs/bastra-uninstall.log") 2>&1
echo
echo "════════════════════════════════════════════════════════════"
echo "  Bastra Recall — Uninstall"
echo "  log: ~/Library/Logs/bastra-uninstall.log"
echo "════════════════════════════════════════════════════════════"
echo

# Resolve the CLI. Homebrew's bin is not on a Finder-launched script's PATH,
# so look there explicitly before giving up (macOS .app/.command PATH quirk).
BASTRA=""
if command -v bastra >/dev/null 2>&1; then
  BASTRA="$(command -v bastra)"
elif [ -x /opt/homebrew/bin/bastra ]; then
  BASTRA=/opt/homebrew/bin/bastra
elif [ -x /usr/local/bin/bastra ]; then
  BASTRA=/usr/local/bin/bastra
fi

echo "This will remove Bastra from Claude Code, Claude Desktop and Cursor,"
echo "and stop the daemon."
echo
echo "Your memories are NOT touched — this script removes no file from your"
echo "vault, wherever you pointed it, and leaves ~/.bastra/logs/ in place."
echo
printf "Continue? [y/N] "
if [ -t 0 ] && [ -e /dev/tty ]; then
  read -r reply </dev/tty
else
  read -r reply || reply=""
fi
case "$reply" in
  [yY] | [yY][eE][sS]) ;;
  *)
    echo
    echo "Cancelled — nothing was changed."
    echo
    echo "(This window will stay open. Press any key to close.)"
    read -r -n 1 -s
    exit 0
    ;;
esac

# 1/4 Unregister every surface. This also drops ~/.bastra/runtime/ (the
# pinned forwarder copy) when run against all surfaces.
echo
echo "→ [1/4] Removing MCP registration from all AI clients…"
uninstall_rc=0
if [ -n "$BASTRA" ]; then
  "$BASTRA" uninstall all || uninstall_rc=$?
else
  echo "  ⚠ 'bastra' not found on PATH."
  echo "    If you installed via Homebrew, run: brew --prefix, then re-run this script."
  echo "    If you installed via npm, run: npx bastra-recall uninstall all"
  uninstall_rc=1
fi

# 2/4 A LaunchAgent is optional (only present if autostart-at-login was set
# up). Boot it out and remove the plist if it exists; harmless otherwise.
echo
echo "→ [2/4] Removing autostart (if configured)…"
PLIST="$HOME/Library/LaunchAgents/ai.n0mad.bastra-recall.plist"
if launchctl print "gui/$(id -u)/ai.n0mad.bastra-recall" >/dev/null 2>&1; then
  echo "  removing LaunchAgent ai.n0mad.bastra-recall"
  launchctl bootout "gui/$(id -u)/ai.n0mad.bastra-recall" 2>/dev/null || true
else
  echo "  no LaunchAgent registered."
fi
if [ -f "$PLIST" ]; then
  echo "  removing $PLIST"
  rm -f "$PLIST"
fi

# 3/4 Stop a still-running daemon. Identify it by the port it owns, not by a
# name pattern: the install path differs between Homebrew, npm and a git
# checkout, and a loose pattern would happily kill an unrelated node process.
echo
echo "→ [3/4] Stopping the daemon…"
DAEMON_PIDS="$(lsof -ti tcp:6723 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$DAEMON_PIDS" ]; then
  for pid in $DAEMON_PIDS; do
    echo "  stopping pid $pid (listening on 6723)"
    kill "$pid" 2>/dev/null || true
  done
else
  echo "  no running daemon found."
fi

# 4/4 What stays, and how to remove it by hand if that is what you want.
echo
echo "→ [4/4] Deliberately kept:"
echo "  · your vault (wherever you pointed it) — every memory file"
echo "  · ~/.bastra/logs/           (telemetry JSONL)"
echo "  · ~/.bastra/cli-settings.json (vault path, API token, preferences)"
echo
echo "  To remove those too, delete them by hand — that is user data, so this"
echo "  script will not do it for you."

echo
if [ "$uninstall_rc" -ne 0 ]; then
  echo "════════════════════════════════════════════════════════════"
  echo "  Uninstall finished with errors."
  echo
  echo "  Log: ~/Library/Logs/bastra-uninstall.log"
  echo "  Check what is still registered with:  bastra doctor"
  echo "════════════════════════════════════════════════════════════"
else
  echo "════════════════════════════════════════════════════════════"
  echo "  ✓ Bastra removed."
  echo
  echo "  Restart Claude Code / Claude Desktop / Codex / ChatGPT Desktop / Cursor to drop the"
  echo "  memory tool from their sessions."
  echo
  echo "  Installed via Homebrew? Remove the package itself with:"
  echo "    brew uninstall bastra-recall"
  echo "════════════════════════════════════════════════════════════"
fi
echo
echo "(This window will stay open. Press any key to close.)"
read -r -n 1 -s
[ "$uninstall_rc" -eq 0 ] || exit 1
