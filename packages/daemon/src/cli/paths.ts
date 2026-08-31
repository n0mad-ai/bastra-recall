/** Shared installer paths, including Codex/ChatGPT desktop (#15). */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// This file lives at dist/cli/paths.js after build.
// DAEMON_DIST is one level up (dist/), PACKAGE_ROOT one more (packages/daemon/).
const DAEMON_DIST = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROOT = dirname(DAEMON_DIST);

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
export const HOOK_STUB_BIN = resolve(PACKAGE_ROOT, "stub", "bastra-hook");
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

/** Claude Desktop's config directory, per Electron's app.getPath("userData").
 *  macOS: ~/Library/Application Support/Claude · Windows: %APPDATA%\Claude ·
 *  Linux: $XDG_CONFIG_HOME/Claude (~/.config/Claude). The path was previously
 *  hardcoded to the macOS location, so every non-mac host resolved into a
 *  directory that never exists. */
function claudeDesktopDir(): string {
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "Claude");
  }
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Claude");
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "Claude");
}

export const CLAUDE_DESKTOP_DIR = claudeDesktopDir();
export const CLAUDE_DESKTOP_CONFIG = resolve(CLAUDE_DESKTOP_DIR, "claude_desktop_config.json");
export const CLAUDE_CODE_CONFIG = resolve(homedir(), ".claude.json");
export const CLAUDE_CODE_SETTINGS = resolve(homedir(), ".claude/settings.json");
export const CURSOR_CONFIG = resolve(homedir(), ".cursor/mcp.json");
/** Codex CLI, IDE and ChatGPT desktop share this host-level configuration. */
export const CODEX_CONFIG = resolve(homedir(), ".codex/config.toml");
export const CODEX_HOOKS = resolve(homedir(), ".codex/hooks.json");
