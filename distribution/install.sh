#!/usr/bin/env bash
# install.sh — the curl installer for bastra-recall.
#
#   curl -fsSL https://bastra.io/install | bash
#
# Same steps as `Install Bastra.command` (Homebrew → tap → bastra-recall →
# guided setup), but shaped for a pipe instead of a Finder double-click (#320):
# a browser download arrives mode 644 and under com.apple.quarantine, so the
# double-click path needs right-click → Open. A piped script has neither
# problem, which is why this is the recommended route.
#
# Idempotent: safe to run multiple times.
#
# Everything lives inside main(), called on the very last line — the standard
# shape for a piped installer, and load-bearing here (#323). Under
# `curl … | bash` the script itself arrives on stdin, so bash reads it in as it
# goes: a child process that also reads stdin swallows the not-yet-parsed rest,
# bash then hits EOF and exits 0 having silently skipped the remaining steps.
# A function body must be parsed as one unit, so the whole script is in memory
# before the first command runs, and a pipe cut mid-transfer dies with
# "syntax error: unexpected end of file" instead of looking like success.
# Children still get </dev/null wherever they could read stdin — the two
# defences are independent, and the redirect also stops a child from blocking
# on input that will never come.
#
# After this finishes, restart the AI client(s) you use — the memory tool
# will be live.

set -euo pipefail

# How many AI clients ended up registered. `bastra status --json` reports every
# surface as ok / broken / missing; only missing means "not registered" —
# broken is registered and repairable. Prints 0 when the count cannot be taken
# at all (no CLI, no --json), which is itself a failed install.
registered_surfaces() {
  local json
  json="$(bastra status --json </dev/null 2>/dev/null)" || { echo 0; return 0; }
  printf '%s\n' "$json" \
    | sed -n '/"surfaces"/,$p' \
    | grep -Ec '"status"[[:space:]]*:[[:space:]]*"(ok|broken)"' \
    || true
}

main() {
  echo
  echo "════════════════════════════════════════════════════════════"
  echo "  Bastra Recall — install"
  echo "════════════════════════════════════════════════════════════"
  echo

  # Homebrew's tap and formula are macOS-only; fail loudly rather than half-way.
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "✗ This installer is macOS-only." >&2
    echo "  On Linux/Windows install via npm:  npm install -g bastra-recall" >&2
    exit 1
  fi

  # `curl … | bash` feeds this script to bash on *stdin*, so stdin is not the
  # user's terminal — anything that needs a human (Homebrew's confirmation, the
  # guided setup's selection lists) has to talk to /dev/tty directly.
  if [ -e /dev/tty ] && (: >/dev/tty) 2>/dev/null; then
    has_tty=1
  else
    has_tty=0
  fi

  # 1/4 Homebrew
  if ! command -v brew >/dev/null 2>&1; then
    echo "→ [1/4] Installing Homebrew (one-time, may ask for your password)…"
    brew_installer="$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh </dev/null)"
    if [ "$has_tty" -eq 1 ]; then
      # The installer asks for RETURN on stdin; give it the real terminal.
      /bin/bash -c "$brew_installer" </dev/tty
    else
      NONINTERACTIVE=1 /bin/bash -c "$brew_installer" </dev/null
    fi
    # Make brew available in this script's environment
    if [ -x /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv </dev/null)"
    elif [ -x /usr/local/bin/brew ]; then
      eval "$(/usr/local/bin/brew shellenv </dev/null)"
    fi
  else
    echo "→ [1/4] Homebrew present."
  fi

  # 2/4 Tap
  if ! brew tap </dev/null | grep -q "^n0mad-ai/tap$"; then
    echo "→ [2/4] Adding bastra tap…"
    brew tap n0mad-ai/tap </dev/null
  else
    echo "→ [2/4] bastra tap present."
  fi

  # Trust the tap (#182): current Homebrew refuses formulas from untrusted
  # third-party taps. </dev/null keeps a hypothetical confirmation prompt from
  # hanging the script; || true keeps older brews (no `trust` command) working.
  brew trust n0mad-ai/tap </dev/null 2>/dev/null || true

  # 3/4 Install / upgrade
  if brew list bastra-recall >/dev/null 2>&1 </dev/null; then
    echo "→ [3/4] bastra-recall already installed — checking for updates…"
    # Non-fatal under `set -e`: a transient upgrade failure (network/tap) must not
    # abort before the friendly error block below — registration can still proceed
    # on the already-installed version.
    upgrade_rc=0
    brew upgrade bastra-recall </dev/null || upgrade_rc=$?
    if [ "$upgrade_rc" -ne 0 ]; then
      echo "  ⚠ upgrade failed (rc=$upgrade_rc) — continuing with the installed version."
    fi
  else
    echo "→ [3/4] Installing bastra-recall…"
    brew install n0mad-ai/tap/bastra-recall </dev/null
  fi

  # 4/4 Guided setup — the wizard refuses to run on a non-TTY, and under
  # `curl | bash` stdin is the script pipe, so both ends go to /dev/tty.
  echo
  install_rc=0
  if [ "$has_tty" -eq 1 ]; then
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
  else
    echo "→ [4/4] No terminal available — registering with all AI clients non-interactively…"
    bastra install all </dev/null || install_rc=$?
  fi

  # Final status
  echo
  echo "→ Final status:"
  doctor_rc=0
  bastra doctor </dev/null || doctor_rc=$?

  if [ "$install_rc" -ne 0 ] || [ "$doctor_rc" -ne 0 ]; then
    echo
    echo "════════════════════════════════════════════════════════════"
    echo "  Install finished with errors (or the setup was cancelled)."
    echo
    echo "  Run this to try again:"
    echo "    bastra install"
    echo "    bastra doctor"
    echo "════════════════════════════════════════════════════════════"
    exit 1
  fi

  # An unregistered surface is "missing" to `bastra doctor`, and missing is not
  # an error to it — so doctor exits 0 on a machine where nothing was set up.
  # That is how #323 reported success with 0/7 hooks and all three surfaces
  # missing. The installer's own bar is higher: if not one surface came out
  # registered, this was not an install, whatever the exit codes above say.
  if [ "$(registered_surfaces)" -eq 0 ]; then
    echo
    echo "════════════════════════════════════════════════════════════"
    echo "  ✗ Install incomplete — no AI client was registered."
    echo
    echo "  Finish it with:"
    echo "    bastra install"
    echo "    bastra doctor"
    echo "════════════════════════════════════════════════════════════"
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
}

main "$@"
