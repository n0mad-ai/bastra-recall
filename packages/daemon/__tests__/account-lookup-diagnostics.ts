/**
 * #1435 — what a failing gateway fixture prints about itself. Both fixtures go
 * through the macOS account check (one `lsof` scan per accepted socket) before
 * their own behavior, and the one recorded failure left neither the response
 * nor the outcome of a single scan behind. These helpers only watch: every scan
 * still runs the real `lsof` with the production timeout and the production
 * callback; nothing here changes a deadline or a verdict.
 */
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type test from "node:test";

export interface LookupRecord {
  ms: number;
  /** `null` for a scan that answered; otherwise the error code or signal. */
  error: string | null;
}

const LSOF = "/usr/sbin/lsof";

/** Watch every `lsof` scan this process starts until the test ends. */
export function observeLookupsInProcess(t: test.TestContext): LookupRecord[] {
  const records: LookupRecord[] = [];
  const original = childProcess.execFile;
  t.mock.method(childProcess, "execFile", (...args: any[]) => {
    const callback = args.at(-1);
    if (args[0] !== LSOF || typeof callback !== "function") return (original as any)(...args);
    const started = performance.now();
    return (original as any)(...args.slice(0, -1), (error: any, stdout: unknown, stderr: unknown) => {
      records.push({ ms: performance.now() - started, error: error ? String(error.code ?? error.signal) : null });
      callback(error, stdout, stderr);
    });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return records;
}

/**
 * The same watch for a gateway that runs in its own process from a transpiled
 * copy of `local-account-access`: its `execFile` import is swapped for a
 * wrapper that appends one JSON line per scan to `logPath`. Throws when the
 * import is no longer where the swap expects it, so the watch cannot go quiet.
 */
export function observeLookupsInCopy(transpiled: string, logPath: string): string {
  const original = 'import { execFile } from "node:child_process";';
  if (!transpiled.includes(original)) throw new Error("#1435: execFile import moved; update the lookup watch");
  const wrapper = [
    'import { execFile as realExecFile } from "node:child_process";',
    'import { appendFileSync as appendLookup } from "node:fs";',
    "const execFile = (...args) => {",
    "  const callback = args.pop();",
    "  const started = performance.now();",
    "  return realExecFile(...args, (error, stdout, stderr) => {",
    "    try {",
    `      appendLookup(${JSON.stringify(logPath)}, JSON.stringify({ ms: performance.now() - started, error: error ? String(error.code ?? error.signal) : null }) + "\\n");`,
    "    } catch {}",
    "    callback(error, stdout, stderr);",
    "  });",
    "};",
  ].join("\n");
  return transpiled.replace(original, wrapper);
}

export function readLookupLog(logPath: string): LookupRecord[] {
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LookupRecord);
}

/** e.g. `3 lsof scan(s), 1 failed (ETIMEDOUT×1), max 2001.4 ms`. */
export function summarizeLookups(records: readonly LookupRecord[]): string {
  if (records.length === 0) return "0 lsof scans";
  const failed = records.filter((r) => r.error !== null);
  const max = Math.max(...records.map((r) => r.ms));
  return (
    `${records.length} lsof scan(s), ${failed.length} failed` +
    (failed.length > 0 ? ` (${histogram(failed.map((r) => r.error!))})` : "") +
    `, max ${max.toFixed(1)} ms`
  );
}

/** e.g. `200×3, 503×2`; `none` for an empty list. */
export function histogram(values: ReadonlyArray<string | number>): string {
  if (values.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const v of values) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  return [...counts.entries()].map(([v, n]) => `${v}×${n}`).join(", ");
}
