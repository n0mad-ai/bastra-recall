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

# The version of the CLI that is actually installed right now (#535). Empty when
# no bastra is on PATH — the caller decides what that means.
installed_cli_version() {
  bastra --version </dev/null 2>/dev/null | tr -d '[:space:]' || true
}

# The version this installer is supposed to leave the machine on (#535).
#
# `brew outdated --verbose` was the first answer and is the wrong one: it prints
# nothing at all for a stale tap and nothing for an up-to-date keg, and an empty
# expectation meant the version check was simply skipped — `brew upgrade` could
# exit 0 with the CLI still on the old version and the run ended in the normal
# success banner. The authority is the release this installer comes from:
# /releases/latest, the same source the Homebrew tap updater and the CLI's own
# update check read, and (since #524) one that only moves once a release's whole
# set is published. $BASTRA_VERSION overrides it for testing and for pinning.
#
# Empty means the requested version could not be established — which is a reason
# to stop, not to continue unchecked.
requested_cli_version() {
  if [ -n "${BASTRA_VERSION:-}" ]; then
    printf '%s' "$BASTRA_VERSION"
    return 0
  fi
  # An unreachable API must return empty, not abort the script under `set -e`.
  local json=""
  json="$(curl -fsSL https://api.github.com/repos/n0mad-ai/bastra-recall/releases/latest </dev/null 2>/dev/null)" \
    || return 0
  printf '%s' "$json" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' \
    | tr -d '[:space:]'
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
    echo "  On Linux install via npm:  npm install -g bastra-recall" >&2
    echo "  Windows is not supported yet." >&2
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
  step_incomplete=0
  step_label="Install"
  version_after=""
  requested_version="$(requested_cli_version)"
  if brew list bastra-recall >/dev/null 2>&1 </dev/null; then
    step_label="Update"
    echo "→ [3/4] bastra-recall already installed — checking for updates…"
    version_before="$(installed_cli_version)"
    # Non-fatal under `set -e`: a transient upgrade failure (network/tap) must not
    # abort before the friendly error block below — the old install keeps working
    # and stays registered exactly as it was.
    upgrade_rc=0
    brew upgrade bastra-recall </dev/null || upgrade_rc=$?
    version_after="$(installed_cli_version)"
    # #535: a failed upgrade used to fall through into setup/doctor and then
    # print the normal ✓ Done banner, so a user arriving from the 1.0 page could
    # be told the install succeeded while still running 0.9.x. The old
    # installation is still worth keeping — but this run did not do what it said,
    # so it ends in its own incomplete state below instead of re-registering
    # anything as if the new release had landed.
    if [ "$upgrade_rc" -ne 0 ]; then
      echo "  ⚠ upgrade failed (rc=$upgrade_rc) — keeping the working ${version_before:-installed} version."
      step_incomplete=1
    fi
  else
    echo "→ [3/4] Installing bastra-recall…"
    brew install n0mad-ai/tap/bastra-recall </dev/null
    version_after="$(installed_cli_version)"
  fi

  # #535: the same check after BOTH paths. A successful `brew upgrade` proves
  # nothing on its own — a stale tap or a no-op upgrade exits 0 while the CLI
  # stays where it was — and a fresh `brew install` from a stale tap lands on an
  # old version just as quietly. The requested version is the release this
  # installer came from, and it is not optional: not knowing it means this run
  # cannot say it did what it promised.
  if [ "$step_incomplete" -eq 0 ]; then
    if [ -z "$requested_version" ]; then
      echo "  ⚠ could not determine which version this installer should install."
      step_incomplete=1
    elif [ "$version_after" != "$requested_version" ]; then
      echo "  ⚠ expected bastra-recall ${requested_version}, but the installed CLI reports ${version_after:-none}."
      step_incomplete=1
    fi
  fi

  # #535: stop before step 4. Re-running the guided setup here would re-point
  # registrations and restart services as if the requested version were
  # installed — it is not.
  if [ "$step_incomplete" -ne 0 ]; then
    echo
    echo "════════════════════════════════════════════════════════════"
    echo "  ✗ ${step_label} incomplete — still on ${version_after:-the previously installed version}."
    if [ -n "$requested_version" ]; then
      echo "    This installer is for ${requested_version}."
    fi
    echo
    echo "  Your working installation was left untouched and setup was"
    echo "  NOT re-run, so nothing points at a version that never landed."
    echo
    echo "  Try again with:"
    echo "    brew update && brew upgrade bastra-recall"
    echo "    bastra install"
    echo "════════════════════════════════════════════════════════════"
    exit 1
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
