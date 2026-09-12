#!/usr/bin/env bash
# Install Bastra.command — double-click in Finder to set up bastra-recall.
#
# Idempotent: safe to run multiple times. Installs Homebrew if missing,
# adds the bastra tap, installs bastra-recall, then hands over to the
# guided setup (`bastra install`): selection lists for the memory vault,
# your AI clients, and semantic recall — no flags, no typing paths.
#
# After this script finishes, restart the AI client(s) you use — the
# memory tool will be live.

set -euo pipefail

# Make double-click logs readable even when launched from Finder.
# NOTE: this makes stdout a pipe, not a TTY — the guided setup below
# explicitly redirects to /dev/tty so its selection lists still render.
mkdir -p "$HOME/Library/Logs"
exec > >(tee -a "$HOME/Library/Logs/bastra-install.log") 2>&1
echo
echo "════════════════════════════════════════════════════════════"
echo "  Bastra Recall — One-click install"
echo "  log: ~/Library/Logs/bastra-install.log"
echo "════════════════════════════════════════════════════════════"
echo

# The version of the CLI that is actually installed right now (#535). Empty when
# no bastra is on PATH — the caller decides what that means.
installed_cli_version() {
  bastra --version </dev/null 2>/dev/null | tr -d '[:space:]' || true
}

# The version Homebrew would install, per the tap (#535): `brew outdated
# --verbose` prints `bastra-recall (0.9.2) < 1.0.0` and nothing at all when the
# installed keg is already current. Empty means "could not be determined" —
# best effort, never a reason to fail on its own.
expected_release_version() {
  brew outdated --verbose bastra-recall </dev/null 2>/dev/null \
    | sed -n 's/.*< *//p' | head -1 | tr -d '[:space:]'
}

# 1/4 Homebrew
if ! command -v brew >/dev/null 2>&1; then
  echo "→ [1/4] Installing Homebrew (one-time, may ask for your password)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Make brew available in this script's environment
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
else
  echo "→ [1/4] Homebrew present."
fi

# 2/4 Tap
if ! brew tap | grep -q "^n0mad-ai/tap$"; then
  echo "→ [2/4] Adding bastra tap…"
  brew tap n0mad-ai/tap
else
  echo "→ [2/4] bastra tap present."
fi

# Trust the tap (#182): current Homebrew refuses formulas from untrusted
# third-party taps. </dev/null keeps a hypothetical confirmation prompt from
# hanging the script; || true keeps older brews (no `trust` command) working.
brew trust n0mad-ai/tap </dev/null 2>/dev/null || true

# 3/4 Install / upgrade
upgrade_incomplete=0
version_after=""
if brew list bastra-recall >/dev/null 2>&1; then
  echo "→ [3/4] bastra-recall already installed — checking for updates…"
  version_before="$(installed_cli_version)"
  expected_version="$(expected_release_version)"
  # Non-fatal under `set -e`: a transient upgrade failure (network/tap) must not
  # abort before the friendly error block below — the old install keeps working
  # and stays registered exactly as it was.
  upgrade_rc=0
  brew upgrade bastra-recall || upgrade_rc=$?
  version_after="$(installed_cli_version)"
  # #535: a failed upgrade used to fall through into setup/doctor and then print
  # the normal ✓ Done banner, so a user arriving from the 1.0 page could be told
  # the install succeeded while still running 0.9.x. The old installation is
  # still worth keeping — but this run did not do what it said, so it ends in its
  # own incomplete state below instead of re-registering anything as if the new
  # release had landed.
  if [ "$upgrade_rc" -ne 0 ]; then
    echo "  ⚠ upgrade failed (rc=$upgrade_rc) — keeping the working ${version_before:-installed} version."
    upgrade_incomplete=1
  elif [ -n "$expected_version" ] && [ -n "$version_after" ] && [ "$version_after" != "$expected_version" ]; then
    echo "  ⚠ upgrade reported success but the installed version is ${version_after}, not ${expected_version}."
    upgrade_incomplete=1
  fi
else
  echo "→ [3/4] Installing bastra-recall…"
  brew install n0mad-ai/tap/bastra-recall
fi

# #535: stop before step 4. Re-running the guided setup here would re-point
# registrations and restart services as if the requested version were
# installed — it is not.
if [ "$upgrade_incomplete" -ne 0 ]; then
  echo
  echo "════════════════════════════════════════════════════════════"
  echo "  ✗ Update incomplete — still on ${version_after:-the previously installed version}."
  echo
  echo "  Your working installation was left untouched and setup was"
  echo "  NOT re-run, so nothing points at a version that never landed."
  echo
  echo "  Log: ~/Library/Logs/bastra-install.log"
  echo "  Try again with:"
  echo "    brew update && brew upgrade bastra-recall"
  echo "    bastra install"
  echo "════════════════════════════════════════════════════════════"
  echo
  echo "(This window will stay open. Press any key to close.)"
  read -r -n 1 -s
  exit 1
fi

# 4/4 Guided setup — selection lists need the real terminal: stdout is the
# log pipe here, and the wizard deliberately refuses to run on a non-TTY.
# Its output goes to the terminal only (not the log); the doctor block below
# records the resulting state in the log.
echo
install_rc=0
if [ -t 0 ] && [ -e /dev/tty ]; then
  echo "→ [4/4] Starting guided setup (pick vault, AI clients, semantic recall)…"
  bastra install </dev/tty >/dev/tty 2>&1 || install_rc=$?
  # rc=2 = "missing surface": the installed bastra predates the guided setup
  # (e.g. `brew upgrade` failed above and we continued on the old version).
  # Fall back to the classic full registration so nothing is silently skipped.
  if [ "$install_rc" -eq 2 ]; then
    echo "  installed bastra has no guided setup yet — registering all AI clients directly…"
    install_rc=0
    bastra install all </dev/tty >/dev/tty 2>&1 || install_rc=$?
  fi
  echo "  guided setup finished (rc=${install_rc}; interactive output shown in the terminal, not logged)"
else
  echo "→ [4/4] No terminal available — registering with all AI clients non-interactively…"
  bastra install all || install_rc=$?
fi

# Final status (logged)
echo
echo "→ Final status:"
doctor_rc=0
bastra doctor || doctor_rc=$?

if [ "$install_rc" -ne 0 ] || [ "$doctor_rc" -ne 0 ]; then
  echo
  echo "════════════════════════════════════════════════════════════"
  echo "  Install finished with errors (or the setup was cancelled)."
  echo
  echo "  Log: ~/Library/Logs/bastra-install.log"
  echo "  Run this to try again:"
  echo "    bastra install"
  echo "    bastra doctor"
  echo "════════════════════════════════════════════════════════════"
  echo
  echo "(This window will stay open. Press any key to close.)"
  read -r -n 1 -s
  exit 1
fi

echo
echo "════════════════════════════════════════════════════════════"
echo "  ✓ Done."
echo
echo "  Restart the AI clients you selected (Claude Code /"
echo "  Claude Desktop / Codex / ChatGPT Desktop / Cursor) to pick up the memory tool."
echo "════════════════════════════════════════════════════════════"
echo
echo "(This window will stay open. Press any key to close.)"
read -r -n 1 -s
