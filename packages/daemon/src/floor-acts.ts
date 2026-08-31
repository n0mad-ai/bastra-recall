/**
 * Append-only affirm log for the floor registry (#198).
 *
 * Why a log and not a field: `affirm()` used to stamp `last_affirmed = now()`
 * in place, which made a queued-then-replayed affirm indistinguishable from a
 * fresh one and let a stale replay drag the clock forward over newer state. It
 * also overwrote `affirmed_by` and `why`, destroying the re-justification the
 * dedup rule below treats as identity-bearing. One mutable field cannot carry
 * two clocks, and one row cannot carry a history.
 *
 * The two clocks:
 * - `occurred_at` — SURFACE-supplied intent time, carried engine-opaque. Only
 *   the queuing surface knows when the affirm was meant. The engine stores it
 *   verbatim, may test it for byte-equality (dedup), and must never compare it
 *   for ordering on the write path. Store, never reject: at the write gate a
 *   legitimate out-of-order drain and a stale replay are the same event, and
 *   only the read side — holding every act — can tell them apart.
 * - `recorded` — ENGINE-stamped write time. The one clock the engine owns,
 *   monotonic by construction because a replay is a physical write happening
 *   now.
 *
 * Omitting `occurred_at` is honest, not a gap: a surface that affirms inline
 * has no intent time distinct from the write. The field then stays absent
 * rather than being back-filled from `recorded`, so a reader can always tell a
 * carried intent time from an inline one. The projection orders such an act by
 * `recorded`.
 *
 * Retention is unbounded, deliberately. A cap would evict by insertion order
 * while live-intent is max-by-`occurred_at`; where those orders disagree — the
 * out-of-order drain this module exists for — eviction would drop the row
 * holding the newest intent and silently promote a superseded affirm back to
 * live. `MAX_FLOORS` rations the context window because the floor block is
 * injected; this log never is.
 *
 * Storage: `~/.bastra/floor-acts.jsonl`, beside the registry it anchors to and
 * on the same machine-global side — a floor is machine state, not vault state.
 * A separate file so unbounded growth never enlarges the blob `listFloors`
 * reads on every session start.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { appendJsonl, readJsonl } from "./jsonl-store.js";

/** One affirm, as it happened. Flat — no envelope, no kind, no version. */
export interface FloorAct {
  /** The floored memory this act anchors to. */
  memory_id: string;
  /**
   * Surface-supplied intent time, stored verbatim. ISO-8601 UTC by convention;
   * the engine does not enforce the format, because validating it would mean
   * interpreting a field it has agreed to carry opaquely. Absent when the
   * surface affirmed inline.
   */
  occurred_at?: string;
  /** Who affirmed — verbatim, never interpreted. */
  affirmed_by: string;
  /** The re-justification — verbatim, never interpreted, identity-bearing. */
  why: string;
  /** Engine-stamped write time. */
  recorded: string;
}

export interface LiveIntent {
  /** The winning act's intent time, or null when it was affirmed inline. */
  occurred_at: string | null;
  /** The winning act's write time; the registry row's `last_affirmed` in fallback. */
  recorded: string;
  affirmed_by?: string;
  why?: string;
  /**
   * `recorded - occurred_at` in ms. A large gap means the act was queued and
   * replayed later — the Decision Radar's "floored for weeks, never truly
   * re-affirmed" row. Null when there is no carried intent time.
   */
  replay_gap_ms: number | null;
  /** No affirm since the floor was placed. */
  never_reaffirmed: boolean;
  /** Where the answer came from — `registry_fallback` means the log is empty for this floor. */
  source: "log" | "registry_fallback";
}

export function floorActsPath(): string {
  return process.env.BASTRA_FLOOR_ACTS_PATH ?? join(homedir(), ".bastra", "floor-acts.jsonl");
}

function isFloorAct(v: unknown): v is FloorAct {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.memory_id === "string" && a.memory_id.length > 0 &&
    typeof a.affirmed_by === "string" &&
    typeof a.why === "string" &&
    typeof a.recorded === "string" &&
    (a.occurred_at === undefined || typeof a.occurred_at === "string")
  );
}

/** The dedup key: the whole event minus the engine's own clock. */
function identity(a: Pick<FloorAct, "memory_id" | "occurred_at" | "affirmed_by" | "why">): string {
  return JSON.stringify([a.memory_id, a.occurred_at ?? null, a.affirmed_by, a.why]);
}

export async function readActs(path: string = floorActsPath()): Promise<FloorAct[]> {
  return await readJsonl(path, isFloorAct);
}

/**
 * Appends one affirm and returns it, or returns null when the identical event
 * is already in the log.
 *
 * Dedup is whole-event byte identity over `memory_id`, `occurred_at`,
 * `affirmed_by` and `why` — `recorded` is excluded, because a true redelivery
 * is a physical write at a new time. It exists for exactly one thing,
 * at-least-once delivery, where a redelivery replays verbatim. A differing
 * `why` is therefore a DISTINCT event, not a duplicate: collapsing it would be
 * the engine ruling that a rewording did not count, an adjudication over a
 * field it carries opaquely, executed by discarding. Two acts at one
 * `occurred_at` with two `why`s are the record's rewording history.
 *
 * Only equality is used, never an ordering comparison — the latter would break
 * the opacity the two-clock split rests on.
 */
export async function appendAct(
  act: Omit<FloorAct, "recorded">,
  path: string = floorActsPath(),
): Promise<FloorAct | null> {
  const key = identity(act);
  const existing = await readActs(path);
  if (existing.some((a) => identity(a) === key)) return null;

  const full: FloorAct = {
    memory_id: act.memory_id,
    ...(act.occurred_at !== undefined ? { occurred_at: act.occurred_at } : {}),
    affirmed_by: act.affirmed_by,
    why: act.why,
    recorded: new Date().toISOString(),
  };
  await appendJsonl(path, full);
  return full;
}

/** Ordering key: the carried intent time when there is one, else the write time. */
function orderKey(a: FloorAct): string {
  return a.occurred_at ?? a.recorded;
}

/**
 * The live intent for one floor: the act with the greatest `occurred_at`, ties
 * broken on `recorded`.
 *
 * Filtered to acts at or after `flooredAt` — on the OCCURRED clock, not the
 * recorded one. Filtering on the engine clock would let a replay that lands
 * after a re-floor while carrying a pre-release intent time pass the filter and
 * then win the maximum, resurrecting a dead affirm from the previous floor
 * lifetime. `release()` still only drops the registry row; no act is ever
 * erased, and a re-floored memory does not inherit the old handle's affirms.
 *
 * With no act for this floor, falls back to the registry row so no floor that
 * exists today regresses to "never re-affirmed" on the day this ships. Nothing
 * is back-filled into the log.
 */
export function liveIntent(
  memoryId: string,
  flooredAt: string,
  acts: FloorAct[],
  fallback: { last_affirmed: string; affirmed_by?: string; why?: string },
): LiveIntent {
  const mine = acts.filter((a) => a.memory_id === memoryId && orderKey(a) >= flooredAt);

  if (mine.length === 0) {
    return {
      occurred_at: null,
      recorded: fallback.last_affirmed,
      ...(fallback.affirmed_by !== undefined ? { affirmed_by: fallback.affirmed_by } : {}),
      ...(fallback.why !== undefined ? { why: fallback.why } : {}),
      replay_gap_ms: null,
      // Pre-log behaviour, unchanged: addFloor stamps both clocks equal, only
      // an affirm moves last_affirmed.
      never_reaffirmed: fallback.last_affirmed === flooredAt,
      source: "registry_fallback",
    };
  }

  const win = mine.reduce((best, a) => {
    const ka = orderKey(a);
    const kb = orderKey(best);
    if (ka !== kb) return ka > kb ? a : best;
    // `>=`, nicht `>`. `recorded` hat Millisekunden-Auflösung, und zwei Acts,
    // die dicht aufeinander geschrieben werden, tragen denselben Wert — dann
    // war `>` falsch und die FRÜHERE Fassung gewann. Aufgefallen als
    // Node-22-Testfehler: derselbe Test entschied unter Node 24 richtig, weil
    // der Lauf dort langsam genug war, dass die Millisekunde wechselte. Das
    // war Glück, kein Verhalten.
    //
    // Der Log ist append-only und `readActs` liest ihn in Zeilenreihenfolge,
    // also ist bei gleicher Millisekunde die SPÄTERE ZEILE die spätere Tat —
    // eine Ordnung, die die Uhr in dieser Auflösung nicht mehr hergibt. Da
    // `reduce` in Array-Reihenfolge läuft, wählt `>=` genau sie.
    return a.recorded >= best.recorded ? a : best;
  });

  const gap = win.occurred_at !== undefined
    ? Date.parse(win.recorded) - Date.parse(win.occurred_at)
    : null;

  return {
    occurred_at: win.occurred_at ?? null,
    recorded: win.recorded,
    affirmed_by: win.affirmed_by,
    why: win.why,
    replay_gap_ms: Number.isFinite(gap as number) ? (gap as number) : null,
    never_reaffirmed: false,
    source: "log",
  };
}
