/**
 * Gemeinsame Hilfen des Telemetrie-Reports (#463) — aus `telemetry-report.ts`
 * herausgelöst (#680), damit die Abschnitts-Module dieselben Regeln teilen.
 */
import type { AnyEventLike } from "./stats-governor.js";

export type ReportEvent = AnyEventLike;

// ─── Hilfen ──────────────────────────────────────────────────────

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const p95 = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const day = (e: ReportEvent): string => String(e.ts).slice(0, 10);
export const bump = (m: Map<string, number>, key: string, n = 1): void => {
  m.set(key, (m.get(key) ?? 0) + n);
};

export interface ReportThresholds {
  mustLoadScore: number;
  scoreFloor: number;
}

export const isSurfaced = (e: ReportEvent): boolean =>
  typeof e.surfaced === "boolean" ? Boolean(e.surfaced) : e.surfaced_score != null;
