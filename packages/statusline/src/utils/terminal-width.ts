import { execSync } from "node:child_process";
import { readTickCache, writeTickCache } from "./tick-cache";

const VALID_TTY_PATTERN = /^[a-zA-Z0-9/]+$/;

/** How long a cached width is trusted (#347). Within the TTL a tick pays
 *  zero forks; after a resize the statusline catches up within this window. */
const WIDTH_TTL_MS = 2000;

function findParentTty(): string | null {
  if (process.platform === "win32") return null;

  let pid = process.pid.toString();

  for (let i = 0; i < 10; i++) {
    try {
      const info = execSync(`ps -o ppid=,tty= -p ${pid}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      const parts = info.split(/\s+/);
      const ppid = parts[0];
      const tty = parts[1];

      if (tty && tty !== "?" && tty !== "??" && VALID_TTY_PATTERN.test(tty)) {
        return tty;
      }

      if (!ppid || ppid === "1" || ppid === "0") break;
      pid = ppid;
    } catch {
      break;
    }
  }

  return null;
}

function getWindowsTerminalWidth(): number | null {
  try {
    const output = execSync("mode con", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const match = output.match(/Columns:\s*(\d+)/i);
    if (match?.[1]) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch {}
  return null;
}

function sttyWidth(tty: string): number | null {
  try {
    const size = execSync(`stty size < /dev/${tty}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      shell: "/bin/sh",
    }).trim();
    const width = size.split(" ")[1];
    if (width) {
      const parsed = parseInt(width, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch {}
  return null;
}

function tputWidth(): number | null {
  try {
    const width = execSync("tput cols 2>/dev/null", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    const parsed = parseInt(width, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  } catch {}
  return null;
}

/** Memo for the lifetime of this tick's process — getTerminalWidth and
 *  getRawTerminalWidth both land here, so measure at most once per tick. */
let unixWidthMemo: number | null | undefined;

/**
 * Cached measurement (#347): a fresh cache entry answers with zero forks;
 * a stale one re-measures via the cached tty (one stty fork instead of the
 * ps parent-walk). The full walk only runs when the tty is unknown or the
 * cached one stopped answering.
 */
function getUnixTerminalWidth(): number | null {
  if (unixWidthMemo !== undefined) return unixWidthMemo;

  const cached = readTickCache();
  if (
    typeof cached.width === "number" &&
    typeof cached.widthAt === "number" &&
    Date.now() - cached.widthAt < WIDTH_TTL_MS
  ) {
    unixWidthMemo = cached.width;
    return cached.width;
  }

  // Re-validate before the shell interpolation in sttyWidth — the cache
  // file is user-owned, but a tty read from disk must pass the same gate
  // as one discovered via ps.
  let tty = typeof cached.tty === "string" && VALID_TTY_PATTERN.test(cached.tty) ? cached.tty : null;
  let width = tty ? sttyWidth(tty) : null;
  if (width === null) {
    tty = findParentTty();
    if (tty) width = sttyWidth(tty);
  }
  if (width === null) width = tputWidth();

  if (width !== null && tty) {
    writeTickCache({ tty, width, widthAt: Date.now() });
  }
  unixWidthMemo = width;
  return width;
}

/**
 * @info Reserves characters for Claude Code's right-side UI messages
 * (e.g., "Current: 2.1.78 · latest: 2.1.78", "Thinking off")
 */
const RESERVED_CHARS = 45;

export function getTerminalWidth(): number | null {
  const applyReserve = (w: number) => Math.max(1, w - RESERVED_CHARS);

  const envColumns = process.env.COLUMNS;
  if (envColumns) {
    const parsed = parseInt(envColumns, 10);
    if (!isNaN(parsed) && parsed > 0) return applyReserve(parsed);
  }

  if (process.stdout.columns && process.stdout.columns > 0) {
    return applyReserve(process.stdout.columns);
  }

  if (process.platform === "win32") {
    const width = getWindowsTerminalWidth();
    if (width) return applyReserve(width);
  }

  const width = getUnixTerminalWidth();
  return width ? applyReserve(width) : null;
}

export function getRawTerminalWidth(): number | null {
  // Skip COLUMNS env and process.stdout.columns — Claude Code sets those
  // to an already-reserved panel width. We need the actual terminal width
  // so the grid engine can apply its own widthReserve.
  if (process.platform === "win32") {
    return getWindowsTerminalWidth();
  }

  return getUnixTerminalWidth();
}
