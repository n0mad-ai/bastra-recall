/** Import-time feature defaults for thin clients too: node stdlib only.
 * Read-only, no schema setup, no directory creation, no migrations. A new
 * process picks up changes; tasks/telemetry are marked restart-required. */
import { join, resolve } from "node:path";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { readRuntimeSettingsRecord } from "@bastra-recall/core/runtime-settings";
import { bastraDataDir } from "@bastra-recall/core/platform-paths";
export { readRuntimeSettingsRecord } from "@bastra-recall/core/runtime-settings";

/** Only a genuinely absent DB record permits this passive legacy read. Opening
 * nonblocking and checking the descriptor also keeps FIFOs/directories/links
 * from blocking startup or becoming a second authoritative settings store. */
export function readLegacySettings(path: string): string | null | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type FeatureSnapshot = { tasks?: boolean; telemetry?: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The stored tasks switch: undefined = not stored (feature default), false for anything malformed. */
function storedTasks(tasks: unknown): boolean | undefined {
  if (tasks === undefined) return undefined;
  if (!isRecord(tasks)) return false;
  if (tasks.enabled === undefined) return undefined;
  return typeof tasks.enabled === "boolean" ? tasks.enabled : false;
}

/** Missing settings (undefined) use feature defaults. Deleted, inaccessible (null) or malformed
 * settings must not turn the new tasks default into an implicit opt-in. */
function featureSnapshot(text: string | null | undefined): FeatureSnapshot {
  if (text === undefined) return {};
  let stored: unknown;
  try {
    stored = text === null ? null : JSON.parse(text);
  } catch {
    stored = null; // Corrupt settings keep tasks closed.
  }
  if (!isRecord(stored)) return { tasks: false };
  const snapshot: FeatureSnapshot = {};
  const tasks = storedTasks(stored.tasks);
  if (tasks !== undefined) snapshot.tasks = tasks;
  const telemetry = (stored.telemetry as { enabled?: unknown } | null | undefined)?.enabled;
  if (typeof telemetry === "boolean") snapshot.telemetry = telemetry;
  return snapshot;
}

const snapshots = new Map<string, FeatureSnapshot>();
export function runtimeFeatureSetting(feature: "tasks" | "telemetry", fallback: boolean): boolean {
  const data = bastraDataDir();
  const path = resolve(process.env.BASTRA_DB_PATH ?? join(data, "recall.db"));
  const key = resolve(join(data, "cli-settings.json"));
  const cacheKey = `${path}\0${key}`;
  let settings = snapshots.get(cacheKey);
  if (!settings) {
    const record = readRuntimeSettingsRecord(key);
    settings = featureSnapshot(record === undefined ? readLegacySettings(key) : record);
    snapshots.set(cacheKey, settings);
  }
  return settings[feature] ?? fallback;
}
