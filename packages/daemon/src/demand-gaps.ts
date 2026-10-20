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
  /** The latest phrasing as asked; formatting/redaction belong to the renderer. */
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
  // A batch's per-phrasing recall_ids cannot identify its siblings. New rows
  // carry a shared id; old multi-phrasing rows cannot safely prove a gap.
  const asks: TelemetryEvent[] = [];
  const batches = new Map<string, TelemetryEvent[]>();
  for (const e of events) {
    if (e.kind !== "recall" || typeof e.query !== "string" || typeof e.ts !== "string" || e.eval_run === true) continue;
    if (!["owner", "agent"].includes(queryOrigin(e))) continue;
    if (typeof e.query_count === "number" && e.query_count >= 2) {
      const collapsed = typeof e.batch_collapsed === "number" ? Math.max(0, e.batch_collapsed) : 0;
      if (e.query_count - collapsed > 1) {
        if (typeof e.batch_id !== "string" || !e.batch_id) continue;
        const key = JSON.stringify([e.batch_id, occasionOf(e)]);
        const batch = batches.get(key) ?? [];
        batch.push(e);
        batches.set(key, batch);
        continue;
      }
    }
    asks.push(e);
  }
  for (const batch of batches.values()) {
    const expected = Number(batch[0]!.query_count) - Number(batch[0]!.batch_collapsed ?? 0);
    // Incomplete writes cannot establish that every phrasing missed.
    if (new Set(batch.map(e => e.recall_id)).size !== expected) continue;
    const phrasings = [...new Map(batch.map(e => [normalize(e.query as string), e.query as string])).entries()]
      .sort(([a], [b]) => a.localeCompare(b)).map(([, query]) => query);
    const latest = batch.reduce((a, b) => a.ts > b.ts ? a : b);
    const missed = batch.every(e => e.hit_count === 0 || e.weak_result === true);
    asks.push({ ...latest, query: phrasings.join(" | "), hit_count: missed ? 0 : 1, weak_result: missed });
  }
  const groups = new Map<string, { query: string; occasions: Set<string>; lastSeen: string; lastMissed: boolean }>();
  for (const e of asks) {
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
    out.push({ query: g.query, occasions: g.occasions.size, lastSeen: g.lastSeen });
  }
  out.sort((a, b) => b.occasions - a.occasions || (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
  return out.slice(0, limit);
}
