#!/usr/bin/env bash
# Install / update the bastra-recall reflex layer in ~/.claude/settings.json.
#
# Registers the same hook set as `bastra install claude-code`. The definitions
# (events, matchers, timeouts, the Stop lane) are NOT copied here: this script
# imports the built adapter (packages/daemon/dist/cli/adapters/claude-code.js)
# and applies its planHookEntries, so the two installers cannot drift apart.
# Stop (autonomous save-eval, #35/#48) is on by default; --no-stop-hook opts out
# and keeps an already-registered Stop entry, like the CLI.
#
# Idempotent: re-running strips our previous entries (by __bastraRecall marker
# or the runner the command invokes) and re-adds them with current paths; will
# not duplicate. A foreign script that merely has "bastra-recall" and "hook" in
# its name is kept and named (#683). Cleans up legacy `__nexusRecall`-marked entries from the pre-rename setup. Backs up
# settings.json before each write.
#
# Usage:
#   bash packages/skill/install-hook.sh                    # install (Stop included)
#   bash packages/skill/install-hook.sh --no-stop-hook     # install without the Stop hook
#   bash packages/skill/install-hook.sh --uninstall        # remove
#   bash packages/skill/install-hook.sh --print            # dry-run, print resulting JSON
#   (--with-stop-hook is still accepted — it is the default now)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAEMON_DIST="${REPO_ROOT}/packages/daemon/dist"
SETTINGS_FILE="${HOME}/.claude/settings.json"
ACTION="install"
WITH_STOP="1"
for arg in "$@"; do
  case "$arg" in
    --uninstall) ACTION="uninstall" ;;
    --print) ACTION="print" ;;
    --with-stop|--with-stop-hook) WITH_STOP="1" ;;
    --no-stop-hook) WITH_STOP="0" ;;
    *) echo "unknown flag: $arg" >&2 ; exit 2 ;;
  esac
done

mkdir -p "$(dirname "${SETTINGS_FILE}")"
[[ -f "${SETTINGS_FILE}" ]] || echo "{}" > "${SETTINGS_FILE}"

if [[ "$ACTION" != "print" ]]; then
  cp "${SETTINGS_FILE}" "${SETTINGS_FILE}.bak"
fi

# Patch JSON via inline Node — robust against existing hook entries.
DAEMON_DIST="${DAEMON_DIST}" SETTINGS_FILE="${SETTINGS_FILE}" ACTION="${ACTION}" WITH_STOP="${WITH_STOP}" \
  node --input-type=module -e '
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdout } from "node:process";
import { pathToFileURL } from "node:url";

const file = process.env.SETTINGS_FILE;
const dist = process.env.DAEMON_DIST;
const action = process.env.ACTION;
const includeStop = process.env.WITH_STOP === "1";

// Single source of truth: the adapter behind `bastra install claude-code`.
const adapterPath = `${dist}/cli/adapters/claude-code.js`;
if (!existsSync(adapterPath)) {
  console.error(`✗ hook binaries not built: ${adapterPath}`);
  console.error("  Run: npm install && npm run build");
  process.exit(1);
}
const { hookDefinitions, planHookEntries } = await import(pathToFileURL(adapterPath).href);
if (action !== "uninstall") {
  for (const def of hookDefinitions({ includeStop })) {
    if (!existsSync(def.bin)) {
      console.error(`✗ hook binary not built: ${def.bin}`);
      console.error("  Run: npm install && npm run build");
      process.exit(1);
    }
  }
}

const raw = readFileSync(file, "utf8") || "{}";
let cfg;
try { cfg = JSON.parse(raw); }
catch { console.error(`✗ ${file} is not valid JSON. Aborting.`); process.exit(1); }
if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};

cfg.hooks ??= {};

// Always the node runner (this script is for a repo checkout); every entry the
// adapter builds — client marker, timeouts, user wrappers, a kept Stop — is
// built by the adapter itself.
const plan = planHookEntries(action === "uninstall" ? "uninstall" : "install", cfg.hooks, { includeStop, stubPresent: false });
for (const [ev, entries] of Object.entries(plan.after)) {
  if (entries.length) cfg.hooks[ev] = entries; else delete cfg.hooks[ev];
}
for (const cmd of plan.leftAlone) {
  console.error(`  left alone (the name looks like ours, the command does not run a bastra-recall hook): ${cmd}`);
}

const out = JSON.stringify(cfg, null, 2) + "\n";
if (action === "print") {
  stdout.write(out);
} else {
  writeFileSync(file, out, "utf8");
}
'

case "$ACTION" in
  install)
    echo "✓ bastra-recall reflex layer registered in ${SETTINGS_FILE}"
    if [[ "${WITH_STOP}" == "1" ]]; then
      echo "  Hooks: SessionStart · UserPromptSubmit · PreToolUse(Write/Edit, TodoWrite|TaskCreate|ExitPlanMode, Bash) · PostToolUse(Bash) · PostToolUseFailure(Bash) · Stop · SessionEnd"
    else
      echo "  Hooks: SessionStart · UserPromptSubmit · PreToolUse(Write/Edit, TodoWrite|TaskCreate|ExitPlanMode, Bash) · PostToolUse(Bash) · PostToolUseFailure(Bash)"
      echo "  Stop hook skipped (--no-stop-hook); an already-registered one is kept."
    fi
    echo "  Binaries: ${DAEMON_DIST}"
    echo "  Backup:   ${SETTINGS_FILE}.bak"
    echo
    echo "Restart Claude Code (or open a fresh session) to activate."
    ;;
  uninstall)
    echo "✓ bastra-recall hooks removed from ${SETTINGS_FILE}"
    echo "  Backup: ${SETTINGS_FILE}.bak"
    ;;
  print)
    : # JSON already written to stdout
    ;;
esac
