/**
 * Shared helpers of the stats readout (split out of stats.ts, #680): the raw
 * event shape, the percent/median/p95 formatters and the dimension lookup.
 * A leaf module — stats.ts runs main() on import, so the section modules
 * must never import it.
 */
import { TOOL_PAYLOAD_KINDS } from "../src/context-ledger.js";

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

/** `recall`/`load_memory`/`read_document` never carry `dimensions` —
 *  they are direct tool payloads, not a hook lane's own event. A CURRENT
 *  instance of one of these looks identical, on this field, to a genuinely
 *  legacy pre-#263 row; labelling both "(pre-#263)" reads today's traffic as
 *  old data. */
const NO_LANE_KINDS = new Set<string>(TOOL_PAYLOAD_KINDS);
const NO_LANE_DIMENSIONS = "(tool call — no lane)";

/** A `recall_id` with no matching `hook_recall` inside the window: not a
 *  missing field on an existing event, but no event to look the field up on
 *  at all. */
const UNMATCHED_DIMENSIONS = "(unmatched — no hook_recall in window)";

export function dimensionValue(event: AnyEvent | undefined, field: "client" | "hook_source" | "arm"): string {
  if (!event) return UNMATCHED_DIMENSIONS;
  const dims = event.dimensions as Record<string, unknown> | undefined;
  if (!dims) return NO_LANE_KINDS.has(String(event.kind)) ? NO_LANE_DIMENSIONS : PRE_DIMENSIONS;
  const raw = dims[field];
  return typeof raw === "string" ? raw : "unknown";
}
