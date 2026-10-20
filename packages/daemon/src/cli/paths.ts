import { hostPaths } from "../platform-paths.js";
/** Shared installer paths, including Codex/ChatGPT desktop (#15). */
import { dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// This file lives at dist/cli/paths.js after build.
// DAEMON_DIST is one level up (dist/), PACKAGE_ROOT one more (packages/daemon/).
const DAEMON_DIST = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROOT = dirname(DAEMON_DIST);
/** The daemon package root. Exported for #546: the stub freshness check has to
 *  ask whether `stub/*.ts` and `scripts/stub-source-digest.mjs` are present at
 *  all — an npm or Homebrew install ships neither, and there "stale" is not a
 *  question that can be answered. Resolves identically from `src/cli/` under
 *  tsx and from `dist/cli/` after a build. */
export const DAEMON_PACKAGE_ROOT = PACKAGE_ROOT;

function firstExisting(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export const FORWARDER_SCRIPT_PATH = resolve(DAEMON_DIST, "mcp-forwarder.js");
/** The daemon entry point. Whatever launches it — LaunchAgent, the forwarder's
 *  auto-spawn, `bastra map`, or a hand-run — execs this file; that is also what
 *  listDaemonProcesses matches on. */
export const DAEMON_SCRIPT_PATH = resolve(DAEMON_DIST, "index.js");
export const PRE_TOOL_HOOK_BIN = resolve(DAEMON_DIST, "hook.js");
/** #344: the compiled thin-client stub. Built locally via `npm run build:stub`
 *  (deno compile) — present on hosts that ran that task, absent on plain npm
 *  installs, so every consumer must fall back to the node client when this
 *  path does not exist. */
export function hookStubBin(packageRoot: string, platform: string = process.platform): string {
  return platform === "win32"
    ? win32.resolve(packageRoot, "stub", "bastra-hook.exe")
    : resolve(packageRoot, "stub", "bastra-hook");
}
export const HOOK_STUB_BIN = hookStubBin(PACKAGE_ROOT);
export const SESSION_HOOK_BIN = resolve(DAEMON_DIST, "session-hook.js");
export const PROMPT_HOOK_BIN = resolve(DAEMON_DIST, "prompt-hook.js");
export const TODO_HOOK_BIN = resolve(DAEMON_DIST, "todo-hook.js");
export const BASH_PRE_HOOK_BIN = resolve(DAEMON_DIST, "bash-pre-hook.js");
export const BASH_FAIL_HOOK_BIN = resolve(DAEMON_DIST, "bash-fail-hook.js");
export const STOP_HOOK_BIN = resolve(DAEMON_DIST, "stop-hook.js");

// Statusline lives in the sibling workspace in source/Homebrew installs.
// In npm installs it can also arrive as a dependency under node_modules.
// Invoked as `node <this> --style=powerline`.
export const STATUSLINE_BIN = firstExisting([
  resolve(PACKAGE_ROOT, "..", "statusline", "dist", "index.mjs"),
  resolve(PACKAGE_ROOT, "node_modules", "@bastra-recall", "statusline", "dist", "index.mjs"),
]);

export const SKILL_SOURCE_PATH = firstExisting([
  resolve(PACKAGE_ROOT, "skill", "SKILL.md"),
  resolve(PACKAGE_ROOT, "..", "skill", "SKILL.md"),
]);
/** The skill ships as a directory, not a single file (#232): SKILL.md plus the
 *  reference files it points at. Anchored on the resolved SKILL.md so source
 *  and npm-package layouts stay in step. */
export const SKILL_SOURCE_DIR = dirname(SKILL_SOURCE_PATH);
export const SKILL_TARGET_DIR = resolve(homedir(), ".claude/skills/bastra-recall");
export const SKILL_TARGET_FILE = resolve(SKILL_TARGET_DIR, "SKILL.md");
export const CODEX_SKILL_TARGET_DIR = resolve(homedir(), ".agents/skills/bastra-recall");
export const CODEX_SKILL_TARGET_FILE = resolve(CODEX_SKILL_TARGET_DIR, "SKILL.md");

/** Cursor's convention layer. Unlike the Claude skill this has no global home:
 *  Cursor's User Rules live in its settings UI, not on disk, so project rules
 *  (`<project>/.cursor/rules/*.mdc`) are the only file-based option. */
export const CURSOR_RULES_SOURCE_PATH = firstExisting([
  resolve(PACKAGE_ROOT, "skill", "cursor-rules.mdc"),
  resolve(PACKAGE_ROOT, "..", "skill", "cursor-rules.mdc"),
]);
export const CURSOR_RULES_RELATIVE = ".cursor/rules/bastra-recall.mdc";

/** Platform-aware host configuration; dotfile clients keep their documented
 * home-directory paths on Windows (only Claude Desktop uses roaming AppData). */
const clients = hostPaths();
export const CLAUDE_DESKTOP_DIR = clients.claudeDesktopDir;
export const CLAUDE_DESKTOP_CONFIG = clients.claudeDesktopConfig;
export const CLAUDE_CODE_CONFIG = clients.claudeCodeConfig;
export const CLAUDE_CODE_SETTINGS = clients.claudeCodeSettings;
export const CURSOR_CONFIG = clients.cursorConfig;
/** Codex CLI, IDE and the existing ChatGPT integration share this config. */
export const CODEX_CONFIG = clients.codexConfig;
export const CODEX_HOOKS = clients.codexHooks;
