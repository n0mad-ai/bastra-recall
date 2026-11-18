/**
 * Does this process still run the code that is on the disk? (#329)
 *
 * Node loads modules once. A `git pull && npm run build`, a `brew upgrade`
 * without a restart, or a staged update whose idle-restart never fired all
 * leave a daemon serving what it read at boot — and reporting that build's
 * version in /health, in the MCP handshake and to the update check. On 02.08.
 * a daemon ran 16 hours past a rebuild: /health said 0.8.9 while the disk had
 * 0.9.0, and nothing anywhere said the answer was out of date.
 *
 * `version.ts` made the build-time drift (literals vs package.json)
 * structurally impossible. This is the other axis: disk vs process.
 *
 * It does NOT restart anything. A service that pulls itself out from under a
 * user mid-session is worse than a stale one — so this only ever says so.
 *
 * Two states, deliberately not merged (they call for different actions):
 *
 *   rebuilt    the entrypoint on disk is newer than the one running.
 *              A restart picks the new code up.
 *   not-built  package.json says another version, but the build has not moved.
 *              Somebody pulled and did not build; a restart changes nothing.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CodeStaleReason = "rebuilt" | "not-built";

export interface CodeStale {
  /** What this process is serving. */
  running: string;
  /** What package.json on disk says right now. */
  on_disk: string;
  /** mtime of the entrypoint on disk, ISO. */
  built_at: string;
  reason: CodeStaleReason;
}

export interface StalenessIo {
  /** Version in package.json on disk, or null when unreadable. */
  diskVersion: () => string | null;
  /** mtime of the entrypoint on disk in epoch ms, or null when unreadable. */
  buildMtimeMs: () => number | null;
  now: () => number;
  log: (line: string) => void;
}

/**
 * Pure decision, so the states can be tested without a filesystem.
 * `bootMtimeMs` is the entrypoint's mtime as this process found it at boot.
 */
export function decideStale(i: {
  running: string;
  diskVersion: string | null;
  bootMtimeMs: number | null;
  currentMtimeMs: number | null;
}): CodeStale | null {
  const { running, diskVersion, bootMtimeMs, currentMtimeMs } = i;
  // No readable build (running from source via tsx, or a stripped install):
  // there is no on-disk build to be newer than this process.
  if (currentMtimeMs === null) return null;
  const builtAt = new Date(currentMtimeMs).toISOString();

  if (bootMtimeMs !== null && currentMtimeMs !== bootMtimeMs) {
    return { running, on_disk: diskVersion ?? running, built_at: builtAt, reason: "rebuilt" };
  }
  if (diskVersion !== null && diskVersion !== running) {
    return { running, on_disk: diskVersion, built_at: builtAt, reason: "not-built" };
  }
  return null;
}

/** The stale-code sentence by language.primary (#1602): `bastra doctor` shows
 *  it in the user's language; the daemon's own log line stays English. */
export const STALE_WORDS = {
  en: {
    rebuilt: (s: CodeStale) =>
      `code on disk was replaced after this process started (running ${s.running}, on disk ${s.on_disk}, built ${s.built_at}) — restart the daemon to run it`,
    notBuilt: (s: CodeStale) =>
      `package.json says ${s.on_disk}, this process runs ${s.running}, and the build has not moved (built ${s.built_at}) — run 'npm run build', then restart the daemon`,
  },
  de: {
    rebuilt: (s: CodeStale) =>
      `der Code auf der Platte wurde nach dem Start dieses Prozesses ersetzt (läuft ${s.running}, auf der Platte ${s.on_disk}, gebaut ${s.built_at}) — den Daemon neu starten, damit er ihn ausführt`,
    notBuilt: (s: CodeStale) =>
      `package.json nennt ${s.on_disk}, dieser Prozess läuft mit ${s.running}, und der Build ist unverändert (gebaut ${s.built_at}) — 'npm run build' ausführen, dann den Daemon neu starten`,
  },
};
export const staleWordsIn = (language: string | undefined) =>
  STALE_WORDS[(language ?? "en") as keyof typeof STALE_WORDS] ?? STALE_WORDS.en;

export function describeStale(s: CodeStale, language?: string): string {
  const w = staleWordsIn(language);
  return s.reason === "rebuilt" ? w.rebuilt(s) : w.notBuilt(s);
}

export interface StalenessMonitor {
  /** Current verdict; re-probes the disk at most once per throttle window. */
  check: () => CodeStale | null;
}

/**
 * `throttleMs` bounds how often the disk is touched, not how fresh the answer
 * is allowed to be: /health is polled by the statusline about once a second,
 * and two stat calls per second for a state that changes at build frequency
 * would be waste. 30s is well inside "within one check interval" from the
 * issue's acceptance, and far below the 6h update-check tick it suggested.
 */
export function createStalenessMonitor(running: string, io: StalenessIo, throttleMs = 30_000): StalenessMonitor {
  const bootMtimeMs = io.buildMtimeMs();
  let lastProbeAt = 0;
  let verdict: CodeStale | null = null;
  // What has already been said. One line per change of state — a daemon that
  // repeats itself every interval turns a real finding into log noise.
  let reported: string | null = null;

  return {
    check(): CodeStale | null {
      const now = io.now();
      if (now - lastProbeAt < throttleMs) return verdict;
      lastProbeAt = now;
      verdict = decideStale({
        running,
        diskVersion: io.diskVersion(),
        bootMtimeMs,
        currentMtimeMs: io.buildMtimeMs(),
      });
      const signature = verdict === null ? null : `${verdict.reason}:${verdict.on_disk}:${verdict.built_at}`;
      if (signature !== reported) {
        reported = signature;
        if (verdict !== null) io.log(`[bastra-recall] ${describeStale(verdict)}`);
      }
      return verdict;
    },
  };
}

/** Reads the real installation: dist/index.js and ../package.json next to it. */
export function defaultStalenessIo(): StalenessIo {
  const distDir = dirname(fileURLToPath(import.meta.url));
  const entry = join(distDir, "index.js");
  const pkg = join(distDir, "..", "package.json");
  return {
    diskVersion: () => {
      try {
        const v = JSON.parse(readFileSync(pkg, "utf8")).version;
        return typeof v === "string" && v.length > 0 ? v : null;
      } catch {
        return null;
      }
    },
    buildMtimeMs: () => {
      try {
        return statSync(entry).mtimeMs;
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
    log: (line) => console.error(line),
  };
}
