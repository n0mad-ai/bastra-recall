/** Read-only service hint. Never asks launchctl whether a job is loaded. */
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isOnValue } from "./env.js";

export const LAUNCH_AGENT_LABEL = "ai.n0mad.bastra-recall";
export const MANAGED_AUTOSTART_MARKER = "BASTRA_AUTOSTART_MANAGED";
export function managedAutostartPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

/** bastra writes XML plists with string env values. Foreign/unreadable files
 * are not an installed bastra service. This hint runs only after failed health.
 * Options make the macOS path testable on other runners without a user flag. */
export async function managedAutostartInstalled(opts: { platform?: NodeJS.Platform; home?: string } = {}): Promise<boolean> {
  if ((opts.platform ?? process.platform) !== "darwin") return false;
  try {
    const file = await open(managedAutostartPlistPath(opts.home), "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 64 * 1024) return false;
      // Mask comments instead of concatenating their neighbours: removing
      // them could construct a marker/key that was not present in the file.
      const xml = (await file.readFile("utf8")).replace(/<!--[\s\S]*?-->/g, " ");
      const env = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)?.[1] ?? "";
      const marker = new RegExp(`<key>\\s*${MANAGED_AUTOSTART_MARKER}\\s*</key>\\s*<string>([^<]*)</string>`).exec(env)?.[1];
      return typeof marker === "string" && isOnValue(marker);
    } finally { await file.close(); }
  } catch { return false; }
}
