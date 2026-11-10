/** Import-time feature defaults for thin clients too: node stdlib only.
 * Read-only, no schema setup, no directory creation, no migrations. A new
 * process picks up changes; tasks/telemetry are marked restart-required. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { readRuntimeSettingsRecord } from "@bastra-recall/core/runtime-settings";
export { readRuntimeSettingsRecord } from "@bastra-recall/core/runtime-settings";

/** Only a genuinely absent DB record permits this passive legacy read. Opening
 * nonblocking and checking the descriptor also keeps FIFOs/directories/links
 * from blocking startup or becoming a second authoritative settings store. */
function readLegacySettings(path: string): string | null | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  } finally { if (fd !== undefined) closeSync(fd); }
}

const snapshots = new Map<string, { tasks?: boolean; telemetry?: boolean }>();
export function runtimeFeatureSetting(feature: "tasks" | "telemetry", fallback: boolean): boolean {
  const data = process.platform === "win32" ? join(process.env.LOCALAPPDATA || join(homedir(),"AppData","Local"),"Bastra") : join(homedir(),".bastra");
  const path = resolve(process.env.BASTRA_DB_PATH ?? join(data,"recall.db"));
  const key = resolve(join(data,"cli-settings.json"));
  const cacheKey = `${path}\0${key}`;
  let settings = snapshots.get(cacheKey);
  if (!settings) {
    settings = {};
    const record = readRuntimeSettingsRecord(key);
    const text = record === undefined ? readLegacySettings(key) : record;
    // Missing settings use feature defaults. Deleted, inaccessible or malformed
    // settings must not turn the new tasks default into an implicit opt-in.
    if (text !== undefined) {
      settings.tasks = false;
      if (text !== null) {
        try {
          const stored = JSON.parse(text);
          if (stored && typeof stored === "object" && !Array.isArray(stored)) {
            if (stored.tasks === undefined) delete settings.tasks;
            else if (stored.tasks && typeof stored.tasks === "object" && !Array.isArray(stored.tasks)) {
              if (stored.tasks.enabled === undefined) delete settings.tasks;
              else if (typeof stored.tasks.enabled === "boolean") settings.tasks = stored.tasks.enabled;
            }
            if (typeof stored.telemetry?.enabled === "boolean") settings.telemetry = stored.telemetry.enabled;
          }
        } catch { /* Corrupt settings keep tasks closed. */ }
      }
    }
    snapshots.set(cacheKey,settings);
  }
  return settings[feature] ?? fallback;
}
