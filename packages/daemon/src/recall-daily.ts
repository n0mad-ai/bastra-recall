/**
 * Loads per memory and day over the last 30 days, read from the telemetry
 * event logs (`events-YYYY-MM-DD.jsonl`, `load_memory` rows) — the memory
 * browser's "RECALLS · 30 DAYS" curve and the small bars in its list.
 *
 * No new store: the logs already hold every load with id and time. A past
 * day's file no longer changes, so its counts are cached by name + size +
 * mtime; only files that changed (today's) are read again. Lines are only
 * parsed when they contain the `load_memory` kind, so a 100 MB month costs
 * one pass on the first call and almost nothing after.
 *
 * Counts follow `bastra logs --stats`: eval/synthetic traffic is left out,
 * and only loads that found the memory count.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { isEvalTraffic } from "./telemetry-dimensions.js";

export const RECALL_DAYS = 30;
const FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const KIND = '"kind":"load_memory"';
const DAY = 864e5;

interface FileCounts {
  key: string;
  /** id → loads in this file, per UTC day of the row's timestamp */
  byDay: Map<string, Map<string, number>>;
}
const cache = new Map<string, FileCounts>();

async function countFile(path: string, key: string): Promise<FileCounts> {
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit;
  const byDay = new Map<string, Map<string, number>>();
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    /* unreadable file = no rows */
  }
  for (const line of raw.split("\n")) {
    if (!line.includes(KIND)) continue;
    let e: { kind?: unknown; ts?: unknown; id?: unknown; found?: unknown; [k: string]: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.kind !== "load_memory" || typeof e.ts !== "string" || typeof e.id !== "string" || e.found === false) continue;
    if (e.eval_run === true || isEvalTraffic(e)) continue;
    const day = e.ts.slice(0, 10);
    let m = byDay.get(day);
    if (!m) byDay.set(day, (m = new Map()));
    m.set(e.id, (m.get(e.id) ?? 0) + 1);
  }
  const out = { key, byDay };
  cache.set(path, out);
  return out;
}

/**
 * id → sparse list of `[daysAgo, loads]` (0 = today, UTC) for the last
 * `RECALL_DAYS` days. Memories without a load in the window are absent.
 */
export async function recallDaily(logDir: string, now = Date.now()): Promise<Map<string, Array<[number, number]>>> {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const firstDay = new Date(today - (RECALL_DAYS - 1) * DAY).toISOString().slice(0, 10);
  let names: string[] = [];
  try {
    names = (await readdir(logDir)).filter((f) => (FILE.exec(f)?.[1] ?? "") >= firstDay).sort();
  } catch {
    return new Map();
  }
  const out = new Map<string, Array<[number, number]>>();
  const seen = new Set<string>();
  for (const name of names) {
    const path = join(logDir, name);
    seen.add(path);
    let key: string;
    try {
      const s = await stat(path);
      key = `${s.size}:${s.mtimeMs}`;
    } catch {
      continue;
    }
    const { byDay } = await countFile(path, key);
    for (const [day, ids] of byDay) {
      const ago = Math.round((today - Date.parse(`${day}T00:00:00Z`)) / DAY);
      if (!(ago >= 0 && ago < RECALL_DAYS)) continue;
      for (const [id, n] of ids) {
        let list = out.get(id);
        if (!list) out.set(id, (list = []));
        const slot = list.find((x) => x[0] === ago);
        if (slot) slot[1] += n;
        else list.push([ago, n]);
      }
    }
  }
  // files that left the window: drop their cached counts
  for (const p of cache.keys()) if (p.startsWith(logDir) && !seen.has(p)) cache.delete(p);
  for (const list of out.values()) list.sort((a, b) => a[0] - b[0]);
  return out;
}
