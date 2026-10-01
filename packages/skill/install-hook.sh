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
# its name is kept and named (#683). Cleans up legacy `__nexusRecall`-marked
# entries from the pre-rename setup. Backs up settings.json before each write.
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

# Patch JSON via inline Node — robust against existing hook entries.
DAEMON_DIST="${DAEMON_DIST}" SETTINGS_FILE="${SETTINGS_FILE}" ACTION="${ACTION}" WITH_STOP="${WITH_STOP}" \
  node --input-type=module -e '
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stdout } from "node:process";
import { pathToFileURL } from "node:url";

const file = process.env.SETTINGS_FILE;
const dist = process.env.DAEMON_DIST;
const action = process.env.ACTION;
const includeStop = process.env.WITH_STOP === "1";

// Install/print use the adapter behind `bastra install claude-code`.
const adapterPath = `${dist}/cli/adapters/claude-code.js`;
const buildNeeded = (reason) => {
  console.error(`✗ ${reason}; run npm run build and retry`);
  process.exit(1);
};
let adapter;
if (action !== "uninstall") {
  if (!existsSync(adapterPath)) buildNeeded("hook adapter not built");
  try { adapter = await import(pathToFileURL(adapterPath).href); }
  catch { buildNeeded("hook adapter cannot be loaded"); }
  if (typeof adapter.hookDefinitions !== "function" || typeof adapter.planHookEntries !== "function") {
    buildNeeded("hook adapter is outdated");
  }
  let defs;
  try { defs = adapter.hookDefinitions({ includeStop }); }
  catch { buildNeeded("hook adapter is outdated"); }
  if (!Array.isArray(defs)) buildNeeded("hook adapter is outdated");
  for (const def of defs) {
    if (typeof def.bin !== "string" || !existsSync(def.bin)) buildNeeded(`hook binary not built: ${def.bin}`);
  }
}

const OWN_FILES = ["hook.js", "session-hook.js", "prompt-hook.js", "todo-hook.js", "bash-pre-hook.js", "bash-fail-hook.js", "stop-hook.js"];
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"];
function runsOurRunner(cmd) {
  const words = cmd.match(/"[^"]*"|\x27[^\x27]*\x27|\S+/g) ?? [];
  const pathAt = (at) => (words[at] ?? "").replace(/^["\x27]|["\x27]$/g, "").replace(/\\/g, "/");
  const baseAt = (at) => pathAt(at).split("/").pop();
  let at = 0;
  let marked = false;
  const skipAssignments = () => {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? "")) {
      if (words[at] === "BASTRA_HOOK_CLIENT=claude-code") marked = true;
      at++;
    }
  };
  skipAssignments();
  if (baseAt(at) === "env") { at++; skipAssignments(); }
  if (baseAt(at) === "hook-timer") {
    at++;
    if (words[at] === "--tag") at += 2;
    skipAssignments();
  }
  const program = baseAt(at);
  if (/^node(\.exe)?$/.test(program)) {
    const script = pathAt(at + 1);
    return OWN_FILES.includes(script.split("/").pop()) && (marked || script.includes("/daemon/dist/"));
  }
  if (/^bastra-hook(\.exe)?$/.test(program)) {
    return new Set(["session", "prompt", "write", "todo", "bash-pre", "bash-fail", "stop"]).has(words[at + 1] ?? "");
  }
  const bin = /^(?:bastra|nexus)-recall-(.+?)(?:\.cmd)?$/.exec(program);
  if (bin && OWN_FILES.includes(`${bin[1]}.js`)) return true;
  return OWN_FILES.includes(program) && (marked || pathAt(at).includes("/daemon/dist/"));
}
function isOurHandler(handler) {
  if (!handler || typeof handler !== "object") return false;
  return handler.__bastraRecall === true || handler.__nexusRecall === true ||
    (typeof handler.command === "string" && runsOurRunner(handler.command));
}
function uninstallWithoutBuild(hooks) {
  const after = {};
  const leftAlone = [];
  for (const event of EVENTS) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    after[event] = entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [entry];
      const handlers = Array.isArray(entry.hooks) ? entry.hooks : [];
      const rest = handlers.filter((handler) => !isOurHandler(handler));
      if (rest.length === handlers.length) {
        for (const handler of handlers) {
          const cmd = typeof handler?.command === "string" ? handler.command : "";
          if (/(?:bastra|nexus)-recall/.test(cmd) && cmd.includes("hook")) leftAlone.push(cmd);
        }
        return [entry];
      }
      return rest.length ? [{ ...entry, hooks: rest }] : [];
    });
  }
  return { after, leftAlone };
}

const raw = existsSync(file) ? readFileSync(file, "utf8") : "{}";
let cfg;
try { cfg = JSON.parse(raw); }
catch { console.error(`✗ ${file} is not valid JSON. Aborting.`); process.exit(1); }
if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};

cfg.hooks ??= {};

// Install uses the adapter; uninstall remains possible from a checkout with
// no dist. The fallback only recognizes our markers and executed hook runners.
let plan;
try {
  plan = action === "uninstall"
    ? uninstallWithoutBuild(cfg.hooks)
    : adapter.planHookEntries("install", cfg.hooks, { includeStop, stubPresent: false });
} catch { buildNeeded("hook adapter is outdated"); }
if (!plan || typeof plan.after !== "object" || plan.after === null || !Array.isArray(plan.leftAlone)) {
  buildNeeded("hook adapter is outdated");
}
for (const [ev, entries] of Object.entries(plan.after)) {
  if (!Array.isArray(entries)) buildNeeded("hook adapter is outdated");
  if (entries.length) cfg.hooks[ev] = entries; else delete cfg.hooks[ev];
}
for (const cmd of plan.leftAlone) {
  console.error(`  left alone (the name looks like ours, the command does not run a bastra-recall hook): ${cmd}`);
}

const out = JSON.stringify(cfg, null, 2) + "\n";
if (action === "print") {
  stdout.write(out);
} else if (action === "install" || existsSync(file)) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
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
