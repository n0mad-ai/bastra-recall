/**
 * Context rot: a model attends worse the fuller its window is. Research describes a gradient, not an edge,
 * and measures it in tokens rather than in a share of the window, so these stops are a working convention
 * (set by the owner on 2026-10-05 from experience with long sessions), not measured thresholds.
 */
export const CONTEXT_STOPS = { caution: 40, warning: 60, critical: 70 } as const;

/** 0 calm, 1 from 40 %, 2 from 60 %, 3 from 70 %. Unknown stays calm: no warning without a measurement. */
export function contextLevel(percent: number | null | undefined): 0 | 1 | 2 | 3 {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0;
  return percent >= CONTEXT_STOPS.critical ? 3 : percent >= CONTEXT_STOPS.warning ? 2 : percent >= CONTEXT_STOPS.caution ? 1 : 0;
}

/** The line a panel shows under the context readout; null while there is nothing to act on. */
export function contextWarning(percent: number | null | undefined): string | null {
  return [null, 'Qualität lässt nach', 'Bald neue Sitzung starten', 'Context Rot: neu starten'][contextLevel(percent)]!;
}
