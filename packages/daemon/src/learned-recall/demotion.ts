/**
 * #129: a way down for bridges that fire and lead nowhere.
 *
 * #672 gave unconfirmed bridges an expiry; a confirmed bridge (evidence ≥ 2)
 * stayed forever, and nothing scored a bridge after it was written. On
 * @zzallirog's install (#701) three bridges fired 577 times in September and
 * led to 0 acted-on episodes and 1 load; the top one pulled ten never-opened
 * archive notes into the top 3 of half its recalls.
 *
 * WHAT COUNTS AS AN OUTCOME. The log already has it: a recall that expanded
 * carries `bridge_expansion` and its `recall_id`; a `recall_episode` with
 * `acted_on` or a `load_memory` whose `follows_recall` / `from_hook_recall`
 * names that recall is an outcome of it. What the log cannot say is WHICH hit
 * the bridge brought in (there is no run without it), so any load after such a
 * recall counts for the bridge. That errs toward keeping a bridge, never toward
 * demoting one that helped. And `bridge_expansion` names the added terms, not
 * the bridge — bridgeFiredOn attributes a fire from the query and those terms.
 *
 * THE STEPS, per local bridge, with every mint pass:
 * 1. ≥ DEMOTION_MIN_FIRES fires in the last DEMOTION_WINDOW_DAYS and no outcome
 *    → `demoted_at` is stamped: the bridge widens a query only at unconfirmed
 *    weight (expansionsFor).
 * 2. Demoted, an outcome since the stamp → the stamp is cleared.
 * 3. Demoted for a full window, it fired again and still no outcome → moved to
 *    bridges/archive/<lang>/ (not deleted). A demoted bridge that stopped
 *    firing stays demoted: it costs nothing, and "never fired" is not evidence.
 * Contributed bridges (with `verifier`) are not ours to change.
 */
import {
  bridgeFiredOn,
  distinctiveTerms,
  type Bridge,
} from "./bridges.js";
import {
  appendBridgeLog,
  archiveBridgeFile,
  listLocalBridgeFiles,
  writeBridgeFileAtomic,
  type TelemetryEvent,
} from "./harvest.js";

/** The window fires and outcomes are counted over — the unconfirmed TTL and
 *  the log-retention floor, so the whole window is still in the log. */
export const DEMOTION_WINDOW_DAYS = 30;

/** Fires inside the window before "never led anywhere" means something. At
 *  zzallirog's volume the bridges that mattered fired 47 and 520 times; 20
 *  keeps a bridge that fired a handful of times out of it. */
export const DEMOTION_MIN_FIRES = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BridgeFireStats {
  fires: number;
  outcomes: number;
}

export interface DemotionResult {
  demoted: number;
  restored: number;
  archived: number;
}

/** The recall ids that led somewhere: an acted-on episode or a load after them. */
function outcomeRecallIds(events: TelemetryEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.kind === "recall_episode" && e.acted_on === true && typeof e.recall_id === "string") ids.add(e.recall_id);
    if (e.kind === "load_memory" && e.found !== false) {
      if (typeof e.follows_recall === "string") ids.add(e.follows_recall);
      if (typeof e.from_hook_recall === "string") ids.add(e.from_hook_recall);
    }
  }
  return ids;
}

interface Fire {
  ts: number;
  queryTerms: Set<string>;
  added: string[];
  ledSomewhere: boolean;
}

function firesFrom(events: TelemetryEvent[]): Fire[] {
  const outcomes = outcomeRecallIds(events);
  const fires: Fire[] = [];
  for (const e of events) {
    if (e.kind !== "recall" && e.kind !== "hook_recall") continue;
    const be = e.bridge_expansion as { added?: unknown } | undefined;
    if (!be || !Array.isArray(be.added) || typeof e.query !== "string") continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    fires.push({
      ts,
      queryTerms: new Set(distinctiveTerms(e.query)),
      added: be.added.filter((t): t is string => typeof t === "string"),
      ledSomewhere: typeof e.recall_id === "string" && outcomes.has(e.recall_id),
    });
  }
  return fires;
}

function statsFor(b: Bridge, fires: Fire[], since: number, until: number): BridgeFireStats {
  const stats: BridgeFireStats = { fires: 0, outcomes: 0 };
  for (const f of fires) {
    // #707: no language match — a query consults every folder, so a bridge
    // filed under "und" fires on a query logged as "en" and vice versa.
    if (f.ts < since || f.ts > until) continue;
    if (!bridgeFiredOn(b, f.queryTerms, f.added)) continue;
    stats.fires++;
    if (f.ledSomewhere) stats.outcomes++;
  }
  return stats;
}

/** Fires and outcomes per bridge id over [since, until] — for tests and doctor-style readouts. */
export function bridgeFireStats(bridges: Bridge[], events: TelemetryEvent[], since: Date, until: Date): Map<string, BridgeFireStats> {
  const fires = firesFrom(events);
  return new Map(bridges.map((b) => [b.id, statsFor(b, fires, since.getTime(), until.getTime())]));
}

function isBridge(b: Partial<Bridge>): b is Bridge {
  return (
    typeof b.id === "string" &&
    typeof b.lang === "string" &&
    typeof b.evidence === "number" &&
    Array.isArray(b.trigger_terms) &&
    Array.isArray(b.expansion_terms)
  );
}

/** Run the three steps above over every local bridge. */
export async function demoteIdleBridges(
  rootDir: string,
  events: TelemetryEvent[],
  now: Date = new Date(),
  opts: { windowDays?: number; minFires?: number } = {},
): Promise<DemotionResult> {
  const windowMs = (opts.windowDays ?? DEMOTION_WINDOW_DAYS) * DAY_MS;
  const minFires = opts.minFires ?? DEMOTION_MIN_FIRES;
  const result: DemotionResult = { demoted: 0, restored: 0, archived: 0 };
  const fires = firesFrom(events);
  const nowMs = now.getTime();
  for (const { path, bridge } of await listLocalBridgeFiles(rootDir)) {
    if (!isBridge(bridge) || bridge.verifier !== undefined) continue;
    const demotedAt = typeof bridge.demoted_at === "string" ? Date.parse(bridge.demoted_at) : NaN;
    if (!Number.isFinite(demotedAt)) {
      const s = statsFor(bridge, fires, nowMs - windowMs, nowMs);
      if (s.fires < minFires || s.outcomes > 0) continue;
      try {
        await writeBridgeFileAtomic(path, { ...bridge, demoted_at: now.toISOString() });
      } catch {
        continue;
      }
      result.demoted++;
      await appendBridgeLog(rootDir, "demote", bridge, `${s.fires} fires in ${opts.windowDays ?? DEMOTION_WINDOW_DAYS} days, no load or acted-on episode (#129)`, now);
      continue;
    }
    const s = statsFor(bridge, fires, demotedAt, nowMs);
    if (s.outcomes > 0) {
      const { demoted_at: _cleared, ...restored } = bridge;
      try {
        await writeBridgeFileAtomic(path, restored);
      } catch {
        continue;
      }
      result.restored++;
      await appendBridgeLog(rootDir, "restore", bridge, `${s.outcomes} outcome(s) since demotion (#129)`, now);
      continue;
    }
    if (nowMs - demotedAt < windowMs || s.fires === 0) continue;
    const ok = await archiveBridgeFile(
      rootDir,
      path,
      bridge,
      `demoted and ${s.fires} more fires without outcome in the next window (#129)`,
      now,
    );
    if (ok) result.archived++;
  }
  return result;
}
