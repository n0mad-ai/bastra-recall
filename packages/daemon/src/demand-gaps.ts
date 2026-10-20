/**
 * #140 — demand gaps: questions the vault keeps being asked and keeps having
 * nothing fitting for. The REPORT.md section that answers "what is missing",
 * next to the stale list that answers "what is not earning its place".
 *
 * Read from the recall telemetry the curator already reads for reflex
 * promotion. A recall counts as a miss when it came back empty or with
 * `weak_result` (no hit matched by title or trigger — the rank-1-of-nothing
 * shape, #249). A query is a gap when it missed on at least two independent
 * occasions (session, else day — `occasionOf`, #129) and its latest ask still
 * missed: once the vault answers it, the row disappears on the next pass.
 *
 * Deliberately raw. The null-controlled near-miss-rank metric from #140 is a
 * separate measurement run; until it exists the report says that a weak
 * result is a signal, not proof.
 */
import { occasionOf, queryOrigin, type TelemetryEvent } from "./learned-recall/harvest.js";

export interface DemandGap {
  /** The latest phrasing as asked, single-line. */
  query: string;
  /** Independent occasions on which this query missed. */
  occasions: number;
  /** Timestamp of the latest ask. */
  lastSeen: string;
}

export const DEMAND_GAP_MIN_OCCASIONS = 2;
export const DEMAND_GAP_REPORT_LIMIT = 20;

function normalize(query: string): string {
  return query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function collectDemandGaps(events: readonly TelemetryEvent[], limit = DEMAND_GAP_REPORT_LIMIT): DemandGap[] {
  const groups = new Map<string, { query: string; occasions: Set<string>; lastSeen: string; lastMissed: boolean }>();
  for (const e of events) {
    // Explicit recalls only: a hook recall's empty result usually means the
    // hint gate held back, not that the vault had nothing.
    if (e.kind !== "recall" || typeof e.query !== "string" || typeof e.ts !== "string") continue;
    if (e.eval_run === true) continue;
    // Tool-lane and harness queries recur with the work, not with a question.
    const origin = queryOrigin(e);
    if (origin !== "owner" && origin !== "agent") continue;
    const key = normalize(e.query);
    if (!key) continue;
    const missed = e.hit_count === 0 || e.weak_result === true;
    let group = groups.get(key);
    if (!group) {
      group = { query: e.query, occasions: new Set(), lastSeen: e.ts, lastMissed: missed };
      groups.set(key, group);
    }
    if (e.ts >= group.lastSeen) {
      group.lastSeen = e.ts;
      group.lastMissed = missed;
      group.query = e.query;
    }
    if (missed) group.occasions.add(occasionOf(e) ?? "unknown");
  }
  const out: DemandGap[] = [];
  for (const g of groups.values()) {
    if (!g.lastMissed || g.occasions.size < DEMAND_GAP_MIN_OCCASIONS) continue;
    out.push({ query: g.query.replace(/\s+/g, " ").trim(), occasions: g.occasions.size, lastSeen: g.lastSeen });
  }
  out.sort((a, b) => b.occasions - a.occasions || (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
  return out.slice(0, limit);
}
