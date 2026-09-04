/**
 * GET /ui/telemetry?days=N — der Telemetrie-Report für den Telemetry-Tab der
 * Vault-Map (#463).
 *
 * Loopback-only wie alles unter /ui (Host-Gate in http.ts), zusätzlich auf
 * `ui.enabled` gegated. Liest die eigenen Logdateien des Nutzers und rechnet
 * `telemetry-report.ts` darüber — nichts wird gespeichert, nichts verlässt
 * die Maschine. Das Fenster ist auf die Retention begrenzt: Ein längeres
 * Fenster anzubieten hieße, eine Serie zu versprechen, deren Anfang die
 * Retention längst gelöscht hat.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getUiEnabled } from "./settings.js";
import { sendJsonPlain } from "./webui.js";
import { logDirFor } from "./telemetry.js";
import { resolveRetentionDays } from "./log-retention.js";
import { buildTelemetryReport, readEventWindow, type ReportThresholds } from "./telemetry-report.js";

export const TELEMETRY_DEFAULT_DAYS = 7;

/** Dieselben Cut-Points wie stats.ts und telemetry.ts (bandForScore). */
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
  opts: { logDir?: string; settingsPath?: string; retentionDays?: number } = {},
): Promise<void> {
  if (!(await getUiEnabled(opts.settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  const retentionDays = opts.retentionDays ?? resolveRetentionDays();
  const days = parseDays(url, retentionDays);
  const window = await readEventWindow(opts.logDir ?? logDirFor(), days);
  sendJsonPlain(res, 200, buildTelemetryReport(window, days, reportThresholds(), retentionDays));
}
