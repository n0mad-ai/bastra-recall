/** Managed-service credential cleanup and read-only reporting of old snapshots. */
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const LEGACY_AUTOSTART_CREDENTIALS = ["BASTRA_API_TOKEN", "BASTRA_EMBEDDING_KEY", "BASTRA_TASK_TOKEN"] as const;

export function cleanManagedEnv(env: Record<string, string>, write?: (s: string) => void): Record<string, string> {
  const clean = { ...env };
  const removed = LEGACY_AUTOSTART_CREDENTIALS.filter(key => Object.hasOwn(clean, key));
  for (const key of removed) delete clean[key];
  if (removed.length) write?.(`  ⚠ omitting legacy credential keys from managed environment: ${removed.join(", ")}\n`);
  return clean;
}

/** Preserve exact backups normally; redact only known legacy env keys when present. */
export async function safeLaunchAgentSnapshot(path: string, env: Record<string, string>, plutil: string): Promise<Buffer> {
  const raw = await readFile(path);
  const removed = LEGACY_AUTOSTART_CREDENTIALS.filter(key => Object.hasOwn(env, key));
  if (!removed.length) return raw;
  let xml = raw.toString("utf8");
  if (!xml.includes("<plist")) {
    const converted = spawnSync(plutil, ["-convert", "xml1", "-o", "-", path], { encoding: "utf8", timeout: 15_000 });
    if (converted.status !== 0) throw new Error("could not sanitize legacy credential snapshot");
    xml = converted.stdout;
  }
  const block = /(<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>)([\s\S]*?)(<\/dict>)/u;
  if (!block.test(xml)) throw new Error("could not locate snapshot environment for credential cleanup");
  const sanitized = xml.replace(block, (_all, open: string, body: string, close: string) => {
    for (const key of removed) {
      body = body.replace(new RegExp(`\\s*<key>\\s*${key}\\s*</key>\\s*<string>[\\s\\S]*?</string>`, "gu"), "");
      if (new RegExp(`<key>\\s*${key}\\s*</key>`, "u").test(body)) throw new Error("could not sanitize legacy credential snapshot");
    }
    return open + body + close;
  });
  return Buffer.from(sanitized);
}

/** Never chmod, rewrite or inspect contents of historical backups. */
export async function legacySnapshotWarning(backupDir: string): Promise<string | null> {
  const files = await readdir(backupDir).catch(() => []);
  let readable = 0;
  for (const name of files) {
    if (!name.startsWith("launchagent-") || !name.endsWith(".plist")) continue;
    const info = await lstat(join(backupDir, name)).catch(() => null);
    if (info?.isFile() && (info.mode & 0o077) !== 0) readable++;
  }
  return readable
    ? `${readable} legacy LaunchAgent snapshot(s) are readable beyond the owner; old snapshots were left unchanged. Review their permissions and any legacy credentials separately.`
    : null;
}
