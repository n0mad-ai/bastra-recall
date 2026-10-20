/**
 * Telemetry log retention — bounded disk, without cutting off the readers.
 *
 * `~/.bastra/logs/events-<YYYY-MM-DD>.jsonl` is already partitioned by day, so
 * the classic "rename to .1, .2, .3 at a size cap" rotation (#23 as filed) is
 * the wrong shape here: it would interleave two naming schemes over the same
 * data and make the day a file encodes unreadable. What the files actually
 * lack is an end — nothing ever deletes them, so a long-lived install grows by
 * 1-3 MB a day forever.
 *
 * So: delete by age, not by size.
 *
 * The one hard constraint is that these logs are not just logs — they are
 * input. `curator-run.ts` mines the last 30 days to decide reflex promotions,
 * and `bastra bridges` mines them for trigger candidates. A retention that
 * dips under the curator's window would silently degrade recall quality while
 * looking like nothing more than tidy housekeeping. Hence RETENTION_FLOOR_DAYS:
 * the configured value can go up, never below what the readers need.
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { defaultLogDir } from "./learned-recall/harvest.js";

/** The curator's mining window (curator-run.ts). Retention may never go below it. */
export const RETENTION_FLOOR_DAYS = 30;

/** Kept days by default — 3x the curator window, so a slow vault keeps a margin. */
export const RETENTION_DEFAULT_DAYS = 90;

// #702: `bastra doctor --replay` writes its rows to `replay-<day>.jsonl` next
// to the live logs. Same shape, same window — no reader mines them, so the
// floor is not what keeps them, but a second clock would be one more setting.
const EVENT_FILE = /^(?:events|replay)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface RetentionResult {
  /** Files deleted in this pass. */
  removed: string[];
  /** Bytes reclaimed. */
  freedBytes: number;
  /** The window actually applied, after the floor was enforced. */
  keptDays: number;
}

/**
 * Resolve the retention window: `BASTRA_LOG_RETENTION_DAYS`, clamped up to the
 * floor. A non-numeric or non-positive value falls back to the default rather
 * than disabling retention — "0" must not silently mean "keep forever", which
 * is the failure mode this whole module exists to end.
 */
export function resolveRetentionDays(env: string | undefined = process.env.BASTRA_LOG_RETENTION_DAYS): number {
  const parsed = Number(env);
  if (!Number.isFinite(parsed) || parsed <= 0) return RETENTION_DEFAULT_DAYS;
  return Math.max(RETENTION_FLOOR_DAYS, Math.floor(parsed));
}

/**
 * Delete event logs older than the retention window.
 *
 * Dates come from the filename, not from mtime: a file synced or restored from
 * a backup carries a fresh mtime but stale content, and the name is the thing
 * that actually says which day the events belong to.
 *
 * Never throws — a housekeeping pass must not be able to take the daemon down.
 */
export async function pruneEventLogs(opts: {
  logDir?: string;
  days?: number;
  now?: number;
  dryRun?: boolean;
} = {}): Promise<RetentionResult> {
  const logDir = opts.logDir ?? defaultLogDir();
  const keptDays = opts.days ?? resolveRetentionDays();
  const now = opts.now ?? Date.now();
  const cutoff = now - keptDays * 24 * 60 * 60 * 1000;

  const result: RetentionResult = { removed: [], freedBytes: 0, keptDays };

  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return result; // no log dir yet — nothing to prune
  }

  for (const name of entries) {
    const m = EVENT_FILE.exec(name);
    if (!m) continue; // never touch anything that is not a dated event log
    const day = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(day)) continue;
    // A file is only expired once its whole day is behind the cutoff.
    if (day + 24 * 60 * 60 * 1000 > cutoff) continue;

    const full = join(logDir, name);
    try {
      const size = (await stat(full)).size;
      if (!opts.dryRun) await unlink(full);
      result.removed.push(name);
      result.freedBytes += size;
    } catch {
      /* file vanished or is not ours to remove — skip it */
    }
  }

  return result;
}
