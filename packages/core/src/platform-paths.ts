/** Host paths shared by the daemon, hooks and installers. Vault-local .bastra
 * directories are intentionally separate from this host-level data directory. */
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface HostPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export function hostPaths(opts: HostPathOptions = {}) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const path = platform === "win32" ? win32 : posix;
  const roaming = env.APPDATA || path.join(home, "AppData", "Roaming");
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const claudeDesktopDir = platform === "win32" ? path.join(roaming, "Claude")
    : platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude")
    : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude");
  // These clients use home-directory dotfiles on Windows too, not AppData.
  const codexDir = env.CODEX_HOME || path.join(home, ".codex");
  return {
    dataDir: platform === "win32" ? path.join(local, "Bastra") : path.join(home, ".bastra"),
    claudeDesktopDir,
    claudeDesktopConfig: path.join(claudeDesktopDir, "claude_desktop_config.json"),
    claudeCodeConfig: path.join(home, ".claude.json"),
    claudeCodeSettings: path.join(home, ".claude", "settings.json"),
    cursorDir: path.join(home, ".cursor"),
    cursorConfig: path.join(home, ".cursor", "mcp.json"),
    codexDir,
    codexConfig: path.join(codexDir, "config.toml"),
    codexHooks: path.join(codexDir, "hooks.json"),
  };
}

/** Keep the optional home argument for callers that already isolate state. */
export function bastraDataDir(home: string = homedir(), opts: Omit<HostPathOptions, "home"> = {}): string {
  return hostPaths({ ...opts, home }).dataDir;
}
