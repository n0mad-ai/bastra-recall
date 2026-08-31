/**
 * bastra-recall update-check subsystem (#39).
 *
 * Fetches the latest release tag from GitHub once per 24h (cached on disk),
 * compares against the locally-compiled VERSION, and exposes the result so
 * that /health, the CLI hint, the SessionStart-hook and the MCP-init can
 * surface "an update is available".
 *
 * Design notes:
 *   - No extra deps: tiny semver-compare (numeric split, "v" prefix tolerant).
 *   - Cache file: ~/.bastra/update-check.json with last_checked_at ISO + result.
 *   - Opt-out: BASTRA_UPDATE_CHECK=off → returns null without fetching anything.
 *   - Fail-tolerant: network errors and parse errors → return cached result if
 *     present, else null. Never throw.
 *   - GitHub-API call is unauthenticated, 5 s timeout.
 */
import { request as httpsRequest } from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveUpdateMode } from "./settings.js";
import { readBlockedUpdate } from "./update-blocked.js";

export const GITHUB_RELEASES_LATEST_URL =
  "https://api.github.com/repos/n0mad-ai/bastra-recall/releases/latest";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const FETCH_TIMEOUT_MS = 5000;
const USER_AGENT = "bastra-recall update-check";

export interface LatestRelease {
  tag: string;
  html_url: string;
  published_at: string;
  body: string;
}

export interface UpdateState {
  current: string;
  latest: string;
  html_url: string;
  published_at: string;
  hasUpdate: boolean;
}

interface CacheFile {
  last_checked_at: string; // ISO
  current: string;
  latest: string;
  html_url: string;
  published_at: string;
  hasUpdate: boolean;
}

// Singleton state — set by the daemon on startup, read by /health, session-hook, MCP.
let currentState: UpdateState | null = null;

export function getUpdateState(): UpdateState | null {
  return currentState;
}

export function setUpdateState(s: UpdateState | null): void {
  currentState = s;
}

export function isOptedOut(): boolean {
  const v = (process.env.BASTRA_UPDATE_CHECK ?? "").toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no";
}

export function cacheFilePath(): string {
  return join(homedir(), ".bastra", "update-check.json");
}

/**
 * Compares two version strings, returns:
 *   -1 if a < b
 *    0 if a == b
 *    1 if a > b
 *
 * Tolerant to a leading "v". Pre-release suffixes (e.g. -rc.1) are ignored — a
 * tag like 0.6.0-rc.1 compares equal to 0.6.0 for the purpose of "is a newer
 * release available". This is intentional: we only surface stable updates.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

function parseSemver(v: string): [number, number, number] {
  const cleaned = v.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "0.0.0";
  const parts = cleaned.split(".").map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

async function readCache(path: string): Promise<CacheFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw) as CacheFile;
    if (
      typeof data.last_checked_at !== "string" ||
      typeof data.current !== "string" ||
      typeof data.latest !== "string"
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

async function writeCache(path: string, data: CacheFile): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort — a missing cache only means more frequent network calls.
  }
}

function isFresh(iso: string, ttlMs: number, now: number = Date.now()): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return now - t < ttlMs;
}

/**
 * Fetches https://api.github.com/repos/n0mad-ai/bastra-recall/releases/latest.
 * Returns null on any error (network, non-200, parse).
 */
export async function getLatestVersion(): Promise<LatestRelease | null> {
  return new Promise((resolve_) => {
    let url: URL;
    try {
      url = new URL(GITHUB_RELEASES_LATEST_URL);
    } catch {
      resolve_(null);
      return;
    }
    const req = httpsRequest(
      {
        method: "GET",
        hostname: url.hostname,
        path: url.pathname + url.search,
        port: 443,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/vnd.github+json",
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if ((res.statusCode ?? 500) !== 200) {
            resolve_(null);
            return;
          }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              tag_name?: string;
              html_url?: string;
              published_at?: string;
              body?: string;
            };
            if (typeof data.tag_name !== "string") {
              resolve_(null);
              return;
            }
            resolve_({
              tag: data.tag_name,
              html_url: typeof data.html_url === "string" ? data.html_url : "",
              published_at:
                typeof data.published_at === "string" ? data.published_at : "",
              body: typeof data.body === "string" ? data.body : "",
            });
          } catch {
            resolve_(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve_(null);
    });
    req.on("error", () => resolve_(null));
    req.end();
  });
}

export interface CheckOptions {
  currentVersion: string;
  cachePath?: string;
  ttlMs?: number;
  now?: number;
  /** Injected for tests; defaults to the live network call. */
  fetchLatest?: () => Promise<LatestRelease | null>;
  /** If true, skip the cache even if it's fresh. */
  force?: boolean;
}

/**
 * Returns null if:
 *   - the user opted out
 *   - both the cache and the live fetch are unavailable
 *
 * Otherwise returns the current update state (which may have hasUpdate=false).
 *
 * Side effect: writes the cache file when a live fetch succeeds.
 */
export async function checkForUpdate(opts: CheckOptions): Promise<UpdateState | null> {
  if (isOptedOut()) return null;

  const cachePath = opts.cachePath ?? cacheFilePath();
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  const now = opts.now ?? Date.now();
  const fetchLatest = opts.fetchLatest ?? getLatestVersion;

  // Cache hit: return as-is, no network call.
  if (!opts.force) {
    const cached = await readCache(cachePath);
    if (cached && cached.current === opts.currentVersion && isFresh(cached.last_checked_at, ttlMs, now)) {
      return {
        current: cached.current,
        latest: cached.latest,
        html_url: cached.html_url,
        published_at: cached.published_at,
        hasUpdate: cached.hasUpdate,
      };
    }
  }

  // Live fetch.
  const latest = await fetchLatest();
  if (!latest) {
    // Network/parse failure — fall back to stale cache if available.
    const cached = await readCache(cachePath);
    if (cached && cached.current === opts.currentVersion) {
      return {
        current: cached.current,
        latest: cached.latest,
        html_url: cached.html_url,
        published_at: cached.published_at,
        hasUpdate: cached.hasUpdate,
      };
    }
    return null;
  }

  const cmp = compareVersions(opts.currentVersion, latest.tag);
  const hasUpdate = cmp < 0;
  const state: UpdateState = {
    current: opts.currentVersion,
    latest: latest.tag.replace(/^v/i, ""),
    html_url: latest.html_url,
    published_at: latest.published_at,
    hasUpdate,
  };

  await writeCache(cachePath, {
    last_checked_at: new Date(now).toISOString(),
    current: state.current,
    latest: state.latest,
    html_url: state.html_url,
    published_at: state.published_at,
    hasUpdate: state.hasUpdate,
  });

  return state;
}

/**
 * Fire-and-forget wrapper used at daemon startup. Never throws, updates the
 * module-level singleton when a result is available.
 *
 * Respects the stored update mode: "off" skips detection entirely, so /health,
 * the CLI hint and the SessionStart block all stay silent without any extra
 * checks downstream. "notify" and "auto" both detect normally; "notify" only
 * surfaces the result and stages nothing.
 *
 * "auto" DOES stage here as well (#81, see the body): surfaces without a hook —
 * Claude Desktop, a LaunchAgent daemon — never reach the SessionStart path, so
 * the daemon applies the staged update itself and reports it via `onAutoStaged`.
 * Both paths share the ONE day marker (`stagedToday()` / `markStagedToday()`;
 * SessionStart side: session-hook.ts), so there is no double-stage on the same
 * day, and a recorded refusal (#268) skips staging here too.
 */
export function startBackgroundCheck(
  currentVersion: string,
  opts?: {
    /** Called after an auto-mode staged update was spawned (#81) — the daemon
     *  uses it to schedule an idle self-restart so the new code goes live. */
    onAutoStaged?: () => void;
  },
): void {
  const runOnce = async (): Promise<void> => {
    if (isOptedOut()) return;
    const mode = await effectiveUpdateMode();
    if (mode === "off") return;
    const state = await checkForUpdate({ currentVersion });
    if (state) setUpdateState(state);
    // #81: Daemon-Self-Update — surface-agnostischer Auto-Trigger. Claude
    // Desktop hat keine Hook-Fläche, also wendet der Daemon das staged
    // Update selbst an (gleicher Tages-Throttle wie der SessionStart-Pfad,
    // beide teilen den Marker — kein Doppel-Stage am selben Tag).
    //
    // #268: a recorded refusal stops it here too. The preflight verdict does not
    // change on its own, so re-spawning would only reproduce it — and it would
    // burn the shared throttle the SessionStart path relies on. `bastra update`
    // clears the record; until then this stays a report, not a retry loop.
    if (mode === "auto" && state?.hasUpdate && !(await stagedToday()) && !(await readBlockedUpdate())) {
      await markStagedToday();
      console.error(
        `[bastra-recall] update ${state.latest} available (mode=auto) — staging in background (#81)`,
      );
      spawnStagedUpdate();
      opts?.onAutoStaged?.();
    }
  };
  void runOnce().catch(() => {
    // Swallow — never crash the daemon over an update check.
  });
  // Long-running daemons (LaunchAgent mode never idle-restarts, #78) need a
  // periodic re-check — the boot-time check alone would freeze their world
  // view. The 24h disk cache throttles actual GitHub hits.
  const recheck = setInterval(() => {
    void runOnce().catch(() => {});
  }, 6 * 60 * 60 * 1000);
  recheck.unref();
}

/**
 * Spawns a detached `bastra update --staged` so it outlives the caller (a
 * short-lived hook process or runs alongside the daemon). The CLI lives next
 * to this file in dist/. Detached + unref + stdio:ignore. Best-effort.
 */
export function spawnStagedUpdate(): void {
  try {
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [cliPath, "update", "--staged"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Never let a failed spawn break the caller.
  }
}

function stagedMarkerPath(): string {
  return join(homedir(), ".bastra", "update-staged.txt");
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Shared once-per-day throttle for staged updates (SessionStart hook + daemon). */
export async function stagedToday(): Promise<boolean> {
  try {
    const raw = await readFile(stagedMarkerPath(), "utf8");
    return raw.split("\n").some((line) => line.trim() === todayISO());
  } catch {
    return false;
  }
}

export async function markStagedToday(): Promise<void> {
  try {
    const path = stagedMarkerPath();
    await mkdir(dirname(path), { recursive: true });
    let existing = "";
    try { existing = await readFile(path, "utf8"); } catch { /* may not exist */ }
    const lines = existing.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (!lines.includes(todayISO())) lines.push(todayISO());
    await writeFile(path, lines.slice(-30).join("\n") + "\n", "utf8"); // bounded growth
  } catch {
    // Best-effort throttle — worst case we stage twice.
  }
}
