import { bastraDataDir } from "./platform-paths.js";
/**
 * Per-session statusline feed paths.
 *
 * Claude Code does NOT send a session identifier to MCP servers
 * (anthropics/claude-code#41836), so the forwarder cannot know which CC
 * session it belongs to from the protocol. But the forwarder, the
 * prompt-hook, and the statusline subprocess of ONE session all share the
 * same `claude` ancestor process. We walk the parent chain up to that
 * `claude` process and use its PID to namespace the feed file — so
 * concurrent sessions never clobber each other's counters.
 *
 * Feed layout: ~/.bastra/statusline/<claude-session-pid>.json
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const STATUSLINE_DIR = path.join(bastraDataDir(), "statusline");

/**
 * Shared, session-independent vault size, written by the daemon on every index
 * change and read by every session's statusline segment.
 *
 * Why separate from the per-session feed: the forwarder only refreshes a
 * session's `vault_size` on that session's own tool calls, so an idle session
 * (no recalls) keeps showing a stale count after another session saves a
 * memory. The daemon owns the vault and sees every add/remove, so it publishes
 * the live count here; the segment prefers it over the per-session value.
 *
 * Not matched by reapStaleFeeds (which only deletes `<pid>.json`), so it
 * survives feed reaping.
 */
export const SHARED_VAULT_FILE = path.join(STATUSLINE_DIR, "vault.json");

export function writeSharedVaultSize(size: number): void {
  try {
    mkdirSync(STATUSLINE_DIR, { recursive: true });
    writeFileSync(SHARED_VAULT_FILE, JSON.stringify({ vault_size: size }) + "\n", "utf8");
  } catch {
    // Best-effort — a missing shared file only means the segment falls back
    // to the per-session value.
  }
}

/** Existence check via signal 0. EPERM = alive but not ours; ESRCH = gone. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Delete feed files whose owning CC session PID is no longer alive. Runs at
 * forwarder startup so feeds orphaned by a hard kill (CC dies without sending
 * SIGTERM) don't pile up in ~/.bastra/statusline/. Our own session PID is the
 * live CC parent, so it is never reaped.
 */
export function reapStaleFeeds(): void {
  let entries: string[];
  try {
    entries = readdirSync(STATUSLINE_DIR);
  } catch {
    return; // dir not created yet — nothing to reap
  }
  for (const name of entries) {
    const m = name.match(/^(\d+)\.json$/);
    if (!m) continue;
    if (pidAlive(parseInt(m[1], 10))) continue;
    try {
      unlinkSync(path.join(STATUSLINE_DIR, name));
    } catch {
      /* already gone / racing forwarder — ignore */
    }
  }
}

/**
 * Walk the parent-process chain (starting from our parent) up to the
 * nearest `claude` process and return its PID. One `ps` call, then an
 * in-memory walk. Falls back to `process.ppid` if `claude` isn't found.
 */
export function claudeSessionPid(): number {
  return claudeSessionPidFrom(process.ppid);
}

/**
 * #343: same walk, but starting from an ARBITRARY pid. The daemon-side prompt
 * lane needs this — it is not in the Claude session's process tree, so the
 * thin client ships its own ppid and the walk runs here. Falls back to the
 * start pid if `claude` isn't found (same contract as claudeSessionPid).
 */
export function claudeSessionPidFrom(startPid: number, processTable?: string): number {
  try {
    const out = processTable ?? execFileSync("ps", ["-axo", "pid=,ppid=,comm="], {
      encoding: "utf8",
    });
    const procs = new Map<number, { ppid: number; comm: string }>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) {
        procs.set(parseInt(m[1], 10), {
          ppid: parseInt(m[2], 10),
          comm: m[3] ?? "",
        });
      }
    }
    let pid = startPid;
    for (let i = 0; i < 12 && pid > 1; i++) {
      const e = procs.get(pid);
      if (!e) break;
      // The nearest host owns the feed. Never cross a nested Codex host
      // to borrow the launching Claude session. Environment variables can be inherited.
      if (/^codex(?:$|[-.])/i.test(path.basename(e.comm))) return startPid;
      // comm is typically a basename like "claude"; match defensively.
      if (/(^|\/)claude\b/i.test(e.comm) || e.comm.toLowerCase().includes("claude"))
        return pid;
      if (e.ppid === pid) break;
      pid = e.ppid;
    }
  } catch {
    // ps unavailable / parse error — fall through to the start pid
  }
  return startPid;
}

export function sessionFeedPath(sessionPid: number): string {
  return path.join(STATUSLINE_DIR, `${sessionPid}.json`);
}
