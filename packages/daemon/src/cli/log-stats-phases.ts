/**
 * #305 — the two corrections that separate a raw hook-event log from a number
 * a release gate can be decided on: one call logged twice, and the calls that
 * happened while the daemon was restarting.
 *
 * Split out of `log-stats.ts` because it is a different job: that file turns
 * events into a table, this one decides which events describe the same call,
 * and which of them describe the normal case at all.
 */
/**
 * #305 — the two corrections that stand between this readout and a number a
 * release gate can be decided on. Both were found by hand-folding the same
 * JSONL the readout reads, and both move the answer by more than a factor of
 * two, in opposite directions per lane.
 *
 * **1. One call, two rows.** The thin clients (`-thin`) and the compiled stub
 * (`-stub`) write their own telemetry row when their socket budget expires —
 * by design, because "the daemon cannot log the calls that never reached it".
 * But a client-side *timeout* is not such a call: the daemon did receive it,
 * did finish it, and did log it. Both rows then land in the same series and
 * the lane is counted twice — once as the call it was, once as a failure.
 * Measured on the reference host, 73 of 74 client rows in the prompt lane had
 * a daemon row for the same call within 500ms; the `daemon-unreachable` rows,
 * which describe calls the daemon really never saw, had 1 of 38.
 *
 * **2. The client does not know the lane.** A client row has no trigger
 * classification — it never got an answer — and used to write the literal
 * `detected_mode: "none"`. Every client-side prompt failure therefore landed
 * in the silent lane, which is how the readout came to show `none` timing out
 * at 15% behind a 69ms median: an impossible shape, and the assertion lane's
 * failures wearing another lane's name. Since #545 both clients write
 * `unknown` instead — a row the fold still pairs with its daemon row when
 * there is one, and which the prompt-total reliability lane judges when there
 * is not.
 *
 * The fold fixes both at once: pair each client row with the nearest unused
 * daemon row of the same kind, keep ONE call with the daemon's lane and
 * latency, and let the client's verdict win — because whatever the daemon
 * managed afterwards, the turn got nothing.
 *
 * **3. Nearness is not identity (#305).** The first version paired on kind and
 * time alone, and two hook calls 100ms apart are the normal case on a machine
 * that runs several sessions: a session-A daemon SUCCESS was folded with a
 * session-B client TIMEOUT and rewritten to that other session's verdict.
 * Measured on the reference host's seven-day log: 82 of 139 client rows were
 * folded, and every single one of them crossed a session — 31 of those
 * rewrote a call the daemon had actually delivered. That is exactly the fault
 * class #305 was opened for, one level down: not the wrong lane this time,
 * but the wrong CALL.
 *
 * There is no call id on these rows — none of the seven lanes stamps one that
 * both the client and the daemon would write — so `session_id` is the identity
 * we have, and every writer already stamps it from the client payload (#356).
 * A pair must now agree on it; the window only bounds how far apart the two
 * rows of one call may sit. A client row with no session is left as its own
 * call: unidentifiable is not the same as unmatched, and guessing is what this
 * paragraph is about.
 */
const CLIENT_ROW_VERSION = /-(stub|thin)$/;
export const DUPLICATE_WINDOW_MS = 500;

function isClientRow(e: Record<string, unknown>): boolean {
  return CLIENT_ROW_VERSION.test(String(e.hook_version ?? ""));
}

/** The call identity a row carries, or `null` when it carries none. */
function sessionOf(e: Record<string, unknown>): string | null {
  return typeof e.session_id === "string" && e.session_id.length > 0 ? e.session_id : null;
}

export function tsOf(e: Record<string, unknown>): number {
  const t = Date.parse(String(e.ts));
  return Number.isNaN(t) ? 0 : t;
}

/** Available daemon rows of one (session, kind), ordered by time. Removing a
 * match updates both nearest-neighbour searches; dense sessions no longer
 * rescan every already-taken row for every client timeout. */
class CandidateBucket {
  private readonly rows: Array<{ event: Record<string, unknown>; time: number; order: number }>;
  private readonly right: number[];
  private readonly left: number[];

  constructor(rows: Array<{ event: Record<string, unknown>; order: number }>) {
    this.rows = rows.map(({ event, order }) => ({ event, time: tsOf(event), order }))
      .sort((a, b) => a.time - b.time || a.order - b.order);
    this.right = Array.from({ length: rows.length + 1 }, (_, i) => i);
    this.left = Array.from({ length: rows.length + 1 }, (_, i) => i);
  }

  private find(parents: number[], at: number): number {
    let root = at;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[at] !== at) {
      const next = parents[at]!;
      parents[at] = root;
      at = next;
    }
    return root;
  }

  private lowerBound(time: number): number {
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.rows[mid]!.time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  takeNearest(time: number): Record<string, unknown> | null {
    const lo = this.lowerBound(time);
    const beforeLast = this.find(this.left, lo) - 1;
    // The nearest earlier timestamp can have several rows. The reference
    // loop chooses the first row in events order on an equal gap, so take the
    // earliest AVAILABLE row of that timestamp, not its final row in sort order.
    const before = beforeLast >= 0
      ? this.find(this.right, this.lowerBound(this.rows[beforeLast]!.time))
      : -1;
    const after = this.find(this.right, lo);
    const a = before >= 0 ? this.rows[before] : undefined;
    const b = after < this.rows.length ? this.rows[after] : undefined;
    const gapA = a ? Math.abs(a.time - time) : Infinity;
    const gapB = b ? Math.abs(b.time - time) : Infinity;
    if (Math.min(gapA, gapB) > DUPLICATE_WINDOW_MS) return null;
    const chosen = gapA < gapB || (gapA === gapB && (a?.order ?? Infinity) < (b?.order ?? Infinity)) ? before : after;
    this.right[chosen] = this.find(this.right, chosen + 1);
    this.left[chosen + 1] = this.find(this.left, chosen);
    return this.rows[chosen]!.event;
  }
}

export function foldClientDuplicates(
  events: Array<Record<string, unknown>>,
): { events: Array<Record<string, unknown>>; folded: number } {
  const clients = events.filter(isClientRow);
  if (clients.length === 0) return { events, folded: 0 };
  const dropped = new Set<Record<string, unknown>>();
  // The fold mutates the daemon row's status, so work on copies: `aggregate`
  // must not rewrite the caller's events.
  const copies = new Map<Record<string, unknown>, Record<string, unknown>>();
  // #615 — the scan used to rescan the whole `events` array for every client
  // row (O(client rows × all events)). The candidates for one client are
  // always a single (session, kind) bucket, so index the daemon-side rows
  // into those buckets once. Buckets are built by walking `events` in order,
  // so the tie-break below (`gap < bestGap`, first candidate wins) still
  // resolves to the row that appears earliest in `events`.
  const bucketsBySession = new Map<string, Map<unknown, Array<{ event: Record<string, unknown>; order: number }>>>();
  for (const [order, e] of events.entries()) {
    if (isClientRow(e)) continue;
    const session = sessionOf(e);
    if (session === null) continue;
    let byKind = bucketsBySession.get(session);
    if (!byKind) {
      byKind = new Map();
      bucketsBySession.set(session, byKind);
    }
    let bucket = byKind.get(e.kind);
    if (!bucket) {
      bucket = [];
      byKind.set(e.kind, bucket);
    }
    bucket.push({ event: e, order });
  }
  const available = new Map<string, Map<unknown, CandidateBucket>>();
  for (const [session, kinds] of bucketsBySession) {
    available.set(session, new Map([...kinds].map(([kind, rows]) => [kind, new CandidateBucket(rows)])));
  }
  for (const client of clients.sort((a, b) => tsOf(a) - tsOf(b))) {
    const at = tsOf(client);
    const session = sessionOf(client);
    if (session === null) continue;
    const bucket = available.get(session)?.get(client.kind);
    if (!bucket) continue;
    const best = bucket.takeNearest(at);
    if (!best) continue;
    dropped.add(client);
    const status = String(best.status ?? "");
    if (status !== "timeout" && status !== "error" && status !== "daemon-unreachable") {
      copies.set(best, { ...best, status: client.status });
    }
  }
  if (dropped.size === 0) return { events, folded: 0 };
  return {
    events: events.filter((e) => !dropped.has(e)).map((e) => copies.get(e) ?? e),
    folded: dropped.size,
  };
}

/**
 * #305 — the restart windows in this log.
 *
 * The daemon announces its own boot in telemetry: `warmup_settle` with
 * `trigger: "boot"`, and the first `ollama_lifecycle` prewarm of a fresh
 * process (`embed_calls_since_boot: 0`). A hook that fires while the daemon is
 * down or still warming reports `daemon-unreachable` — correctly, and with
 * nothing anyone can fix inside the hook. Judging the delivery rate on a
 * window that contains a restart measures the restart.
 */
const RESTART_PRE_MS = 30_000;
const RESTART_POST_MS = 120_000;

export function restartWindows(events: Array<Record<string, unknown>>): Array<{ start: number; end: number }> {
  const boots: number[] = [];
  for (const e of events) {
    if (e.kind === "warmup_settle" && e.trigger === "boot") boots.push(tsOf(e));
    else if (e.kind === "ollama_lifecycle" && e.action === "prewarm" && e.embed_calls_since_boot === 0) {
      boots.push(tsOf(e));
    }
  }
  boots.sort((a, b) => a - b);
  const windows: Array<{ start: number; end: number }> = [];
  for (const boot of boots) {
    const last = windows[windows.length - 1];
    if (last && boot - RESTART_PRE_MS <= last.end) {
      last.end = Math.max(last.end, boot + RESTART_POST_MS);
      continue;
    }
    windows.push({ start: boot - RESTART_PRE_MS, end: boot + RESTART_POST_MS });
  }
  return windows;
}
