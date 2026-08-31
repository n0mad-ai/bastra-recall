/**
 * Shared exec hardening for CLI spawns (#91/#15, lifted out of ollama.ts / #79).
 *
 * Every external command the CLI runs should (a) resolve to an absolute,
 * non-world-writable path via findExecutable() — never a bare name — and
 * (b) carry a hard timeout so unattended runs (e.g. `bastra update --staged`
 * spawned from the SessionStart hook) can never hang unbounded.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter as PATH_DELIMITER, isAbsolute, join } from "node:path";

export interface RunResult {
  ok: boolean;
  signal: boolean;
  detail: string;
}

export interface CapturedRunResult extends RunResult {
  stdout: string;
  stderr: string;
}

/** Captured sibling of run(), used for machine-readable CLI integrations. */
export function runCaptured(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; env?: Record<string, string> },
): CapturedRunResult {
  const r = spawnSync(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: opts.timeoutMs,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
  });
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      signal: false,
      detail: code === "ETIMEDOUT" ? `timed out after ${opts.timeoutMs}ms` : r.error.message,
      stdout,
      stderr,
    };
  }
  if (r.signal) {
    return { ok: false, signal: true, detail: `killed by ${r.signal}`, stdout, stderr };
  }
  if (r.status !== 0) {
    const message = stderr.trim() || stdout.trim();
    return { ok: false, signal: false, detail: message || `exit ${r.status}`, stdout, stderr };
  }
  return { ok: true, signal: false, detail: "ok", stdout, stderr };
}

/**
 * spawnSync with a hard timeout and a closed stdin. stdin:"ignore" means a
 * brew sudo prompt fails fast instead of hanging a non-interactive run.
 */
export function run(bin: string, args: string[], opts: { timeoutMs: number; showProgress?: boolean; env?: Record<string, string> }): RunResult {
  const r = spawnSync(bin, args, {
    stdio: opts.showProgress ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs,
    // Merge onto process.env (never replace it — git needs PATH/HOME). Callers
    // pass e.g. GIT_TERMINAL_PROMPT=0 so a non-anonymous clone fails fast instead
    // of blocking on a /dev/tty username prompt (stdin:"ignore" alone doesn't stop that).
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return { ok: false, signal: false, detail: code === "ETIMEDOUT" ? `timed out after ${opts.timeoutMs}ms` : r.error.message };
  }
  if (r.signal) return { ok: false, signal: true, detail: `killed by ${r.signal}` };
  if (r.status !== 0) return { ok: false, signal: false, detail: `exit ${r.status}` };
  return { ok: true, signal: false, detail: "ok" };
}

/**
 * Resolve a command to an absolute, executable, non-world-writable path.
 * Augments PATH with the Homebrew bin dirs because GUI/hook-spawned processes
 * inherit a stripped PATH (the #79 root cause). Spawning the resolved absolute
 * path — never the bare name — keeps detection and execution in agreement and
 * closes the PATH-hijack vector.
 */
export function findExecutable(name: string): string | null {
  const me = process.getuid?.() ?? -1;
  const isWin = process.platform === "win32";
  // PATH is ';'-separated on Windows, ':' elsewhere. Splitting on a fixed ':'
  // left the whole Windows PATH as one unsplit entry, so nothing resolved and
  // detection reported every tool "not installed" even when it was on PATH.
  const pathDirs = (process.env.PATH ?? "").split(PATH_DELIMITER).filter(Boolean);
  // The Homebrew fallbacks matter only where a GUI/hook-spawned process inherits
  // a stripped PATH (#79) — a POSIX concern; skip them on Windows.
  const dirs = isWin ? pathDirs : [...pathDirs, "/opt/homebrew/bin", "/usr/local/bin"];
  // On Windows an executable is found by extension (PATHEXT), not an X_OK bit;
  // try each configured extension unless the caller already gave one.
  const winExts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const nameHasExt = /\.[^\\/.]+$/.test(name);
  const candidates =
    isWin && !nameHasExt ? winExts.map((ext) => name + ext) : [name];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    // Never resolve against CWD: a relative PATH entry (".", "x/bin") would make
    // join() return a relative path and spawn an attacker's ./ollama. Absolute only.
    if (!isAbsolute(dir)) continue;
    try {
      // A world-writable dir — or a group-writable one not owned by root/us —
      // lets an attacker swap the binary; skip it (mirrors the repo's temp-file
      // hardening, commit 3af0cc8). POSIX-mode bits are meaningless on Windows
      // (statSync reports a synthetic mode), so the ownership gate is Unix-only.
      const dirSt = statSync(dir);
      if (!isWin) {
        if (dirSt.mode & 0o002) continue;
        if (dirSt.mode & 0o020 && dirSt.uid !== 0 && dirSt.uid !== me) continue;
      }
      for (const candidate of candidates) {
        const full = join(dir, candidate);
        try {
          // F_OK (existence) on Windows — the OS decides executability by
          // extension; X_OK for the real permission bit on POSIX.
          accessSync(full, isWin ? constants.F_OK : constants.X_OK);
          if (!isWin && statSync(full).mode & 0o002) continue; // reject world-writable binary
          return full;
        } catch {
          /* not this extension — try next */
        }
      }
    } catch {
      /* dir not here — try next */
    }
  }
  return null;
}
