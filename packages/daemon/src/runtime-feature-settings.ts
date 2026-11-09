/** Import-time feature defaults for thin clients too: node stdlib only.
 * Read-only, no schema setup, no directory creation, no migrations. A new
 * process picks up changes; tasks/telemetry are marked restart-required. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

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

/** Read-only bridge for the size hook's existing mini-reader. Undefined means
 * no DB record yet, null means a tombstone; never imports a legacy file. */
export function readRuntimeSettingsRecord(legacyPath: string): string | null | undefined {
  const path = resolve(process.env.BASTRA_DB_PATH ?? join(legacyPath, "..", "recall.db"));
  if (!existsSync(path)) return undefined;
  let db: DatabaseSync | undefined;
  const emitWarning = process.emitWarning;
  try {
    if (process.versions.node.startsWith("22.")) process.emitWarning = ((warning: string | Error,...args: unknown[]) => {
      if (typeof warning === "string" && warning.startsWith("SQLite is an experimental feature")) return;
      Reflect.apply(emitWarning,process,[warning,...args]);
    }) as typeof emitWarning;
    const SQLite = createRequire(import.meta.url)("node:sqlite").DatabaseSync as typeof DatabaseSync;
    db = new SQLite(path,{readOnly:true,allowExtension:false});
    db.exec("PRAGMA busy_timeout=0");
    const row=db.prepare("SELECT value FROM app_records WHERE namespace='settings' AND key=?").get(resolve(legacyPath));
    if (!row) return undefined;
    const envelope=JSON.parse(String(row.value));
    return typeof envelope?.text === "string" ? envelope.text : null;
  } catch { return undefined; }
  finally { db?.close();process.emitWarning=emitWarning; }
}
