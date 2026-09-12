#!/usr/bin/env bash
# Uninstall Bastra.command — double-click in Finder to unregister bastra-recall.
#
# Removes the MCP registration from every AI client, stops the daemon, and
# drops the runtime scaffolding. It does NOT remove the installed package
# itself (Homebrew keg / npm package) — that command is printed at the end.
# And it NEVER touches your memories: the vault, ~/.bastra/logs/ and your
# settings stay exactly where they are.
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

echo "This will unregister Bastra from Claude Code, Claude Desktop and Cursor,"
echo "and stop the daemon."
echo
echo "The installed package (Homebrew / npm) stays — removing it is a separate"
echo "command, printed at the end."
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

# 3/4 Stop a still-running daemon. The port finds the candidate — it never
# proves identity (#527): when Bastra is stopped, misconfigured or unable to
# start, another local service legitimately owns that port, and a double-clicked
# uninstaller that kills it is a destructive side effect nobody asked for.
#
# So the port only narrows the search, and the command line decides. The entry
# point `daemon/dist/index.js` is what every install route execs (Homebrew, npm,
# source checkout) — the same criterion the CLI uses to find daemons
# (packages/daemon/src/cli/daemon-processes.ts). Anything else keeps running and
# is reported with the manual command, rather than being stopped on a guess.
#
# The port itself comes from the same place the daemon reads it from, so a
# configured non-default port is respected instead of assuming 6723.
echo
echo "→ [3/4] Stopping the daemon…"
PORT="${BASTRA_HTTP_PORT:-${NEXUS_HTTP_PORT:-6723}}"
daemon_stopped=0
foreign_listener=0
DAEMON_PIDS="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$DAEMON_PIDS" ]; then
  for pid in $DAEMON_PIDS; do
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$cmd" in
      *daemon/dist/index.js*)
        echo "  stopping the Bastra daemon: pid $pid (port $PORT)"
        kill "$pid" 2>/dev/null || true
        daemon_stopped=1
        ;;
      *)
        foreign_listener=1
        echo "  ⚠ pid $pid owns port $PORT, but it is NOT the Bastra daemon — left running."
        echo "    process: ${cmd:-<command line unreadable>}"
        echo "    Nothing was stopped here. If you are certain this is Bastra, stop it yourself:"
        echo "      kill $pid"
        ;;
    esac
  done
else
  echo "  nothing is listening on port $PORT — no running daemon found."
fi

# 4/4 What stays, and how to remove it by hand if that is what you want.
# Three different things, kept apart on purpose (#527): the integrations were
# UNREGISTERED, the installed package is still INSTALLED, and your data is
# PRESERVED. "Uninstalled" would be true of exactly one of the three.
echo
echo "→ [4/4] Deliberately kept:"
echo "  · the installed package itself — Homebrew keg or npm package, still there"
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
  echo "  ✓ Bastra unregistered from every AI client."
  echo
  if [ "$daemon_stopped" -eq 1 ]; then
    echo "  The daemon was stopped."
  elif [ "$foreign_listener" -eq 1 ]; then
    echo "  The daemon was NOT stopped — the process on port $PORT could not be"
    echo "  identified as Bastra (see [3/4] above for the manual command)."
  else
    echo "  No daemon was running."
  fi
  echo
  echo "  Restart Claude Code / Claude Desktop / Codex / ChatGPT Desktop / Cursor to drop the"
  echo "  memory tool from their sessions."
  echo
  echo "  The package itself is still installed. To remove it too:"
  echo "    brew uninstall bastra-recall     # if you installed via Homebrew"
  echo "    npm uninstall -g bastra-recall   # if you installed via npm"
  echo "════════════════════════════════════════════════════════════"
fi
echo
echo "(This window will stay open. Press any key to close.)"
read -r -n 1 -s
[ "$uninstall_rc" -eq 0 ] || exit 1
