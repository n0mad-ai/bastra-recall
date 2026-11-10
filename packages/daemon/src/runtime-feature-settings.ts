/** Import-time feature defaults for thin clients too: node stdlib only.
 * Read-only, no schema setup, no directory creation, no migrations. A new
 * process picks up changes; tasks/telemetry are marked restart-required. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readRuntimeSettingsRecord } from "@bastra-recall/core/runtime-settings";
export { readRuntimeSettingsRecord } from "@bastra-recall/core/runtime-settings";

const snapshots = new Map<string, { tasks?: boolean; telemetry?: boolean }>();
export function runtimeFeatureSetting(feature: "tasks" | "telemetry", fallback: boolean): boolean {
  const data = process.platform === "win32" ? join(process.env.LOCALAPPDATA || join(homedir(),"AppData","Local"),"Bastra") : join(homedir(),".bastra");
  const path = resolve(process.env.BASTRA_DB_PATH ?? join(data,"recall.db"));
  const key = resolve(join(data,"cli-settings.json"));
  const cacheKey = `${path}\0${key}`;
  let settings = snapshots.get(cacheKey);
  if (!settings) {
    settings = {};
    const text = readRuntimeSettingsRecord(key);
    if (text) {
      try {
        const stored = JSON.parse(text);
        if (typeof stored.tasks?.enabled === "boolean") settings.tasks = stored.tasks.enabled;
        if (typeof stored.telemetry?.enabled === "boolean") settings.telemetry = stored.telemetry.enabled;
      } catch { /* No opt-in from malformed settings. */ }
    }
    snapshots.set(cacheKey,settings);
  }
  return settings[feature] ?? fallback;
}
