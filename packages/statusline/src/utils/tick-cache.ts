import { bastraDataDir } from "@bastra-recall/core/platform-paths";
import fs from "node:fs";
import path from "node:path";

/**
 * Cross-tick cache for values that outlive a single statusline process (#347).
 *
 * The statusline is spawned fresh every second (refreshInterval: 1), so
 * anything resolved via fork/exec — the claude session pid, the parent tty,
 * the terminal width — is re-paid on every tick unless it is parked on disk.
 *
 * One JSON file in the feed dir, keyed by the parent process. Width and tty
 * belong to that terminal; the feed PID belongs to its process ancestry. A
 * resumed session in a second terminal must resolve all three independently.
 * reapStaleFeeds only deletes `<pid>.json`, so this file survives feed reaping.
 * Concurrent writes are best-effort: a lost entry re-resolves on the next tick.
 */

const CACHE_FILE = path.join(bastraDataDir(),
  "statusline",
  "tick-cache.json",
);

/** Reserved for session-only data. All current fields depend on the parent. */
export function setTickCacheSession(_sessionId: unknown): void {}

function cacheKey(): string {
  return String(process.ppid);
}

export interface TickCacheEntry {
  parentPid?: number;
  claudePid?: number;
  fallbackPid?: number;
  tty?: string;
  width?: number;
  widthAt?: number;
}

/** Existence check via signal 0. EPERM = alive but not ours; ESRCH = gone. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readAll(): Record<string, TickCacheEntry> {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, TickCacheEntry>;
  } catch {
    // missing / corrupt — start fresh
  }
  return {};
}

export function readTickCache(): TickCacheEntry {
  const entry = readAll()[cacheKey()];
  return typeof entry === "object" && entry !== null ? entry : {};
}

export function writeTickCache(patch: TickCacheEntry): void {
  try {
    const all = readAll();
    const key = cacheKey();
    all[key] = { ...all[key], ...patch, parentPid: process.ppid };
    for (const k of Object.keys(all)) {
      if (k === key) continue;
      const entry = all[k];
      const pid = k.startsWith("session:")
        ? entry?.claudePid ?? entry?.fallbackPid ?? entry?.parentPid
        : parseInt(k, 10);
      if (typeof pid !== "number" || !Number.isFinite(pid) || !pidAlive(pid)) delete all[k];
    }
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(all), "utf8");
  } catch {
    // Best-effort — a failed write only means the next tick re-resolves.
  }
}
