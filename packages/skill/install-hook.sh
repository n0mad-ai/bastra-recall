#!/usr/bin/env bash
# Install / update the bastra-recall reflex layer in ~/.claude/settings.json.
#
# Registers the default hook set:
#   - SessionStart    → preload preferences + active-project facts
#   - UserPromptSubmit → lookup-mode recall on retrieval prompts (#33)
#   - PreToolUse Write/Edit/MultiEdit/NotebookEdit → topic recall (#20 #28 #32)
#   - PreToolUse TodoWrite|TaskCreate|ExitPlanMode → topology recall before plans (#36 #506 #698)
#   - PreToolUse Bash → safety recall before destructive ops (#34)
#   - PostToolUse Bash → lesson recall when a command fails (#37)
#   - Stop            → optional autonomous save-eval (#35), off by default
#   - SessionEnd      → with Stop: books the finished session for the after-session harvest (#675)
#
# Idempotent: re-running strips our previous entries (by __bastraRecall marker
# or the runner the command invokes) and re-adds them with current paths; will
# not duplicate. A foreign script that merely has "bastra-recall" and "hook" in
# its name is kept and named (#683). Cleans
# up legacy `__nexusRecall`-marked entries from the pre-rename setup. Backs up
# settings.json before each write.
#
# Usage:
#   bash packages/skill/install-hook.sh                # install
#   bash packages/skill/install-hook.sh --with-stop-hook  # install incl. Stop hook
#   bash packages/skill/install-hook.sh --uninstall    # remove
#   bash packages/skill/install-hook.sh --print        # dry-run, print resulting JSON

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAEMON_DIST="${REPO_ROOT}/packages/daemon/dist"
HOOK_FILES=(
  session-hook.js prompt-hook.js hook.js todo-hook.js
  bash-pre-hook.js bash-fail-hook.js stop-hook.js
)
SETTINGS_FILE="${HOME}/.claude/settings.json"
ACTION="install"
WITH_STOP="0"
for arg in "$@"; do
  case "$arg" in
    --uninstall) ACTION="uninstall" ;;
    --print) ACTION="print" ;;
    --with-stop|--with-stop-hook) WITH_STOP="1" ;;
    *) echo "unknown flag: $arg" >&2 ; exit 2 ;;
  esac
done

if [[ "$ACTION" == "install" || "$ACTION" == "print" ]]; then
  for f in "${HOOK_FILES[@]}"; do
    bin="${DAEMON_DIST}/${f}"
    if [[ ! -f "${bin}" ]]; then
      echo "✗ hook binary not built: ${bin}" >&2
      echo "  Run: (cd ${REPO_ROOT} && npm install && npm run build)" >&2
      exit 1
    fi
    chmod +x "${bin}" 2>/dev/null || true
  done
fi

mkdir -p "$(dirname "${SETTINGS_FILE}")"
[[ -f "${SETTINGS_FILE}" ]] || echo "{}" > "${SETTINGS_FILE}"

if [[ "$ACTION" != "print" ]]; then
  cp "${SETTINGS_FILE}" "${SETTINGS_FILE}.bak"
fi

# Patch JSON via inline Node — robust against existing hook entries.
DAEMON_DIST="${DAEMON_DIST}" SETTINGS_FILE="${SETTINGS_FILE}" ACTION="${ACTION}" WITH_STOP="${WITH_STOP}" \
  node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { stdout } from "node:process";

const file = process.env.SETTINGS_FILE;
const dist = process.env.DAEMON_DIST;
const action = process.env.ACTION;
const withStop = process.env.WITH_STOP === "1";
const bin = (f) => `${dist}/${f}`;

// Single source of truth — mirrors packages/daemon/src/cli/adapters/claude-code.ts.
const DEFS = [
  { event: "SessionStart", matcher: "startup|resume|clear|compact", file: "session-hook.js", timeout: 3, note: "bastra-recall SessionStart hook" },
  { event: "UserPromptSubmit", file: "prompt-hook.js", timeout: 2, note: "bastra-recall UserPromptSubmit hook (lookup-mode, #33)" },
  { event: "PreToolUse", matcher: "Write|Edit|MultiEdit|NotebookEdit", file: "hook.js", timeout: 2, note: "bastra-recall PreToolUse hook" },
  { event: "PreToolUse", matcher: "TodoWrite|TaskCreate|ExitPlanMode", file: "todo-hook.js", timeout: 2, note: "bastra-recall plan hook (topology-recall, #36/#506/#698)" },
  { event: "PreToolUse", matcher: "Bash", file: "bash-pre-hook.js", timeout: 2, note: "bastra-recall Bash-pre hook (safety, #34)" },
  { event: "PostToolUse", matcher: "Bash", file: "bash-fail-hook.js", timeout: 2, note: "bastra-recall Bash-fail hook (lesson recall on fail, #37)" },
];
if (withStop) {
  DEFS.push({ event: "Stop", file: "stop-hook.js", timeout: 3, note: "bastra-recall Stop hook (optional autonomous save-eval, #35)" });
  DEFS.push({ event: "SessionEnd", file: "stop-hook.js", timeout: 2, note: "bastra-recall SessionEnd hook (after-session harvest, #675)" });
}
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
const OUR_FILES = ["hook.js", "session-hook.js", "prompt-hook.js", "todo-hook.js", "bash-pre-hook.js", "bash-fail-hook.js", "stop-hook.js"];

const raw = readFileSync(file, "utf8") || "{}";
let cfg;
try { cfg = JSON.parse(raw); }
catch { console.error(`✗ ${file} is not valid JSON. Aborting.`); process.exit(1); }
if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};

cfg.hooks ??= {};

function isOurs(matcher) {
  if (!matcher || typeof matcher !== "object") return false;
  const hooks = Array.isArray(matcher.hooks) ? matcher.hooks : [];
  return hooks.some((h) => {
    if (!h || typeof h !== "object") return false;
    if (h.__bastraRecall === true || h.__nexusRecall === true) return true;
    return typeof h.command === "string" && runsOurRunner(h.command);
  });
}

// #683 (mirrors runsOurHookRunner in cli/adapters/command-paths.ts): ours by
// the program the command runs — the stub, a package bin, or a hook script
// under daemon/dist or next to the client marker — not by substrings, which
// claimed and deleted a user script named like my-bastra-recall-audit-hook.sh.
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
    return OUR_FILES.includes(script.split("/").pop()) && (marked || script.includes("/daemon/dist/"));
  }
  if (/^bastra-hook(\.exe)?$/.test(program)) {
    return new Set(["session", "prompt", "write", "todo", "bash-pre", "bash-fail", "stop"]).has(words[at + 1] ?? "");
  }
  const bin = /^(?:bastra|nexus)-recall-(.+?)(?:\.cmd)?$/.exec(program);
  if (bin && OUR_FILES.includes(`${bin[1]}.js`)) return true;
  return OUR_FILES.includes(program) && (marked || pathAt(at).includes("/daemon/dist/"));
}

function buildEntry(def) {
  const entry = {};
  if (def.matcher) entry.matcher = def.matcher;
  entry.hooks = [{
    type: "command",
    command: `node ${bin(def.file)}`,
    timeout: def.timeout,
    __bastraRecall: true,
    __note: def.note,
  }];
  return entry;
}

// Strip our previous entries from every event (idempotent + cleanup).
for (const ev of EVENTS) {
  const arr = Array.isArray(cfg.hooks[ev]) ? cfg.hooks[ev] : [];
  const kept = arr.filter((m) => !isOurs(m));
  for (const m of kept) {
    for (const h of Array.isArray(m?.hooks) ? m.hooks : []) {
      const cmd = typeof h?.command === "string" ? h.command : "";
      if ((cmd.includes("bastra-recall") || cmd.includes("nexus-recall")) && cmd.includes("hook")) {
        console.error(`  left alone (the name looks like ours, the command does not run a bastra-recall hook): ${cmd}`);
      }
    }
  }
  if (kept.length) cfg.hooks[ev] = kept; else delete cfg.hooks[ev];
}

if (action !== "uninstall") {
  for (const def of DEFS) {
    (cfg.hooks[def.event] ??= []).push(buildEntry(def));
  }
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
      echo "  8 hooks: SessionStart · UserPromptSubmit · PreToolUse(Write/Edit, TodoWrite|TaskCreate|ExitPlanMode, Bash) · PostToolUse(Bash) · Stop · SessionEnd"
    else
      echo "  6 hooks: SessionStart · UserPromptSubmit · PreToolUse(Write/Edit, TodoWrite|TaskCreate|ExitPlanMode, Bash) · PostToolUse(Bash)"
      echo "  Stop hook is optional/off. Re-run with --with-stop-hook to enable save-eval."
    fi
    echo "  Binaries: ${DAEMON_DIST}/{${HOOK_FILES[*]}}"
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
