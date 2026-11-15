/**
 * GET /ui/telemetry?days=N — der Telemetrie-Report für den Telemetry-Tab der
 * Vault-Map (#463).
 *
 * Loopback-only wie alles unter /ui (Host-Gate in http.ts), zusätzlich auf
 * `ui.enabled` gegated. Liest die eigenen Logdateien des Nutzers und rechnet
 * `telemetry-report.ts` darüber — nichts verlässt die Maschine. #1438:
 * abgeschlossene Tage kommen aus der lokalen App-Datenbank
 * (telemetry-day-store.ts), nur der laufende Tag aus dem Log; ist die
 * Datenbank nicht nutzbar, wird wie früher alles aus dem Log gelesen. Das Fenster ist auf die Retention begrenzt: Ein längeres
 * Fenster anzubieten hieße, eine Serie zu versprechen, deren Anfang die
 * Retention längst gelöscht hat.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getUiEnabled } from "./settings.js";
import { sendJsonPlain } from "./webui.js";
import { logDirFor } from "./telemetry.js";
import { resolveRetentionDays } from "./log-retention.js";
import {
  buildTelemetryReport,
  readEventWindow,
  type ReportThresholds,
  type TelemetryReport,
} from "./telemetry-report.js";
import { telemetryDayStore, type TelemetryDayStore } from "./telemetry-day-store.js";

export const TELEMETRY_DEFAULT_DAYS = 7;

/** Dieselben Cut-Points wie stats.ts und telemetry-join-state.ts (bandForScore). */
export function reportThresholds(env: NodeJS.ProcessEnv = process.env): ReportThresholds {
  const n = (v: string | undefined, fallback: number): number => {
    const x = Number(v);
    return Number.isFinite(x) && v !== undefined && v !== "" ? x : fallback;
  };
  return { mustLoadScore: n(env.BASTRA_MUST_LOAD_SCORE, 100), scoreFloor: n(env.BASTRA_RECALL_FLOOR, 30) };
}

/** `days` aus der Query, geklemmt auf 1..Retention. */
export function parseDays(url: string, retentionDays: number): number {
  const raw = new URL(url, "http://127.0.0.1").searchParams.get("days");
  const n = raw === null ? TELEMETRY_DEFAULT_DAYS : Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return TELEMETRY_DEFAULT_DAYS;
  return Math.min(n, retentionDays);
}

export async function handleUiTelemetry(
  _req: IncomingMessage,
  res: ServerResponse,
  url: string,
  opts: { logDir?: string; settingsPath?: string; retentionDays?: number; store?: () => TelemetryDayStore } = {}
): Promise<void> {
  if (!(await getUiEnabled(opts.settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  const retentionDays = opts.retentionDays ?? resolveRetentionDays();
  const days = parseDays(url, retentionDays);
  const logDir = opts.logDir ?? logDirFor();
  const thresholds = reportThresholds();
  const now = Date.now();
  const key = JSON.stringify([logDir, days, retentionDays, thresholds]);
  // Taken before reading: a file that changes during the read no longer
  // matches next time, so the newer data is never hidden behind the cache.
  const fingerprint = await logFingerprint(logDir, days, now);
  const hit = reportCache.get(key);
  if (hit && fingerprint !== null && hit.fingerprint === fingerprint && now <= hit.validUntil) {
    sendJsonPlain(res, 200, hit.report);
    return;
  }
  const store = openStore(opts.store ?? telemetryDayStore);
  const window = await readEventWindow(logDir, days, now, false, store ?? undefined);
  if (store) await pruneStore(store, logDir);
  const report = buildTelemetryReport(window, days, thresholds, retentionDays);
  if (fingerprint !== null) {
    reportCache.delete(key);
    reportCache.set(key, {
      fingerprint,
      // The report depends on `now` only through the rolling cutoff. It stays
      // the same until the cutoff passes the earliest row inside the window
      // (a row is dropped once cutoff > its time); files entering or leaving
      // the window change the fingerprint (its cutoff day and file list).
      validUntil: window.earliestMs == null ? Infinity : window.earliestMs + days * DAY_MS,
      report,
    });
    if (reportCache.size > REPORT_CACHE_MAX) reportCache.delete(reportCache.keys().next().value!);
  }
  sendJsonPlain(res, 200, report);
}

/**
 * #1438: the finished report per window, kept in memory while the data under
 * it is unchanged — the Telemetry page polls every 30 s, and an unchanged poll
 * then costs one directory listing and a stat per day file. The result is the
 * one a fresh computation would return at that moment.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_CACHE_MAX = 8;
const EVENT_FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const reportCache = new Map<string, { fingerprint: string; validUntil: number; report: TelemetryReport }>();

/** Cutoff day plus name, size and mtime of every day file the window reads; null if unreadable. */
async function logFingerprint(logDir: string, days: number, now: number): Promise<string | null> {
  const cutoffDay = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  let names: string[];
  try {
    names = (await readdir(logDir)).filter((f) => (EVENT_FILE.exec(f)?.[1] ?? "") >= cutoffDay).sort();
  } catch {
    return null;
  }
  const parts = [cutoffDay];
  for (const f of names) {
    try {
      const st = await stat(join(logDir, f));
      parts.push(`${f}:${st.size}:${st.mtimeMs}`);
    } catch {
      return null;
    }
  }
  return parts.join("|");
}

/** The day store, or null when the app database cannot be opened (e.g. a newer schema). */
function openStore(open: () => TelemetryDayStore): TelemetryDayStore | null {
  try {
    return open();
  } catch {
    return null;
  }
}

/** Drops stored days whose log file retention has deleted. Best effort. */
async function pruneStore(store: TelemetryDayStore, logDir: string): Promise<void> {
  try {
    const days = new Set((await readdir(logDir)).map((f) => EVENT_FILE.exec(f)?.[1]).filter((d): d is string => !!d));
    store.prune(logDir, days);
  } catch {
    /* next request tries again */
  }
}
