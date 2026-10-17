import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-tick cache for values that outlive a single statusline process (#347).
 *
 * The statusline is spawned fresh every second (refreshInterval: 1), so
 * anything resolved via fork/exec — the claude session pid, the parent tty,
 * the terminal width — is re-paid on every tick unless it is parked on disk.
 *
 * One JSON file in the feed dir, keyed by this process's ppid: the ancestor
 * every tick of one session shares. If the spawn chain puts a fresh
 * intermediate between claude and us, the key misses and we fall back to the
 * fork path — no worse than before. reapStaleFeeds only deletes `<pid>.json`,
 * so this file survives feed reaping; entries of dead sessions are pruned on
 * write instead. Writes are last-writer-wins across concurrent sessions: a
 * clobbered entry just re-resolves on that session's next tick.
 */

const CACHE_FILE = path.join(
  os.homedir(),
  ".bastra",
  "statusline",
  "tick-cache.json",
);

export interface TickCacheEntry {
  claudePid?: number;
  fallbackPid?: number;
  git?: {
    cwd: string;
    paths: string[];
    signature: string;
    status: {
      branch: string | null;
      status: "clean" | "dirty" | "conflicts" | "unknown";
      workingTree?: { staged: number; unstaged: number; untracked: number; conflicts: number };
    };
    aheadBehind: { ahead: number; behind: number };
  };
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
  const entry = readAll()[String(process.ppid)];
  return typeof entry === "object" && entry !== null ? entry : {};
}

export function writeTickCache(patch: TickCacheEntry): void {
  try {
    const all = readAll();
    const key = String(process.ppid);
    all[key] = { ...all[key], ...patch };
    for (const k of Object.keys(all)) {
      const pid = parseInt(k, 10);
      if (!Number.isFinite(pid) || (k !== key && !pidAlive(pid))) delete all[k];
    }
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(all), "utf8");
  } catch {
    // Best-effort — a failed write only means the next tick re-resolves.
  }
}
