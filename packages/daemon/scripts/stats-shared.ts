/**
 * Shared helpers of the stats readout (split out of stats.ts, #680): the raw
 * event shape, the percent/median/p95 formatters and the dimension lookup.
 * A leaf module — stats.ts runs main() on import, so the section modules
 * must never import it.
 */
export interface AnyEvent {
  kind: string;
  ts: string;
  [k: string]: unknown;
}

export function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${((n / total) * 100).toFixed(1)}%`;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

/** Vor #263 geschriebene Ereignisse haben die Spalte nicht. Das ist etwas
 *  anderes als `unknown` („Oberfläche hat sich nicht ausgewiesen") und wird
 *  deshalb auch anders benannt — sonst liest man Altbestand als Messwert. */
const PRE_DIMENSIONS = "(pre-#263)";

/** Loads and document reads do not stamp dimensions today. `recall` does,
 *  so a recall without them is genuinely historical. */
const NO_LANE_KINDS = new Set(["load_memory", "read_document"]);
const NO_LANE_DIMENSIONS = "(tool call — not stamped)";

/** A missing hook_recall can be outside the window or absent by design, as
 *  with a reflex hint. The label names only what the report can prove. */
const UNMATCHED_DIMENSIONS = "(unmatched — no hook_recall row)";

export function dimensionValue(event: AnyEvent | undefined, field: "client" | "hook_source" | "arm"): string {
  if (!event) return UNMATCHED_DIMENSIONS;
  const dims = event.dimensions as Record<string, unknown> | undefined;
  if (!dims) return NO_LANE_KINDS.has(String(event.kind)) ? NO_LANE_DIMENSIONS : PRE_DIMENSIONS;
  const raw = dims[field];
  return typeof raw === "string" ? raw : "unknown";
}
