/** How long a deleted task report can be brought back (Daniel 18.11.2026, #1559): the setting
 * tasks.reportUndo holds "off" or a whole number of minutes, hours or days ("10m", "2h", "3d"),
 * from one minute up to 30 days. Only the time window is set here; how many deletes the undo
 * store keeps and how many bytes it holds stay fixed (task-reports.ts). */
export const REPORT_UNDO_DEFAULT = "10m";
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const MAX_MS = 30 * UNIT_MS.d;

/** The window in milliseconds, 0 for "off", null when the value is not one of the above. */
export function parseReportUndo(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "off") return 0;
  const m = /^([1-9]\d{0,5})([mhd])$/.exec(v);
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  return ms <= MAX_MS ? ms : null;
}
