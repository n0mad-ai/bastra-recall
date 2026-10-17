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
 * One JSON file in the feed dir, keyed by Claude's session id when supplied,
 * otherwise by this process's ppid. The session id survives a fresh wrapper
 * shell on every tick. reapStaleFeeds only deletes `<pid>.json`,
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

let sessionKey: string | undefined;

/** Set after reading Claude's stdin, before any segment/cache lookup. */
export function setTickCacheSession(sessionId: unknown): void {
  sessionKey = typeof sessionId === "string" && sessionId.length > 0
    ? `session:${sessionId}`
    : undefined;
}

function cacheKey(): string {
  return sessionKey ?? String(process.ppid);
}

export interface TickCacheEntry {
  parentPid?: number;
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
