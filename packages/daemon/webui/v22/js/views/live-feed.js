// Session feed of the Live tab (js/views/live-tab.js): the vault events of
// GET /ui/updates (add | change | delete | read) since the page was loaded,
// newest first. DOM-free, so it is tested in node (tools/__tests__).
// Every entry is external input: unknown kinds and entries without an id are
// dropped, text fields fall back to "".

export const KINDS = ["add", "change", "delete", "read"];
const str = (v) => (typeof v === "string" ? v : "");

/** createFeed({ max }) → { events, ingest(list, now), counts(), onAdd(fn) } */
export function createFeed({ max = 300 } = {}) {
  const events = [];
  const listeners = new Set();
  let n = 0;
  return {
    events,
    /** Adds the valid entries of one delivery; returns the new entries (newest first). */
    ingest(list, now = Date.now()) {
      if (!Array.isArray(list)) return [];
      const fresh = [];
      for (const u of list) {
        if (!u || typeof u !== "object" || typeof u.id !== "string" || !u.id || !KINDS.includes(u.kind)) continue;
        fresh.unshift({
          key: `e${++n}`,
          id: u.id,
          kind: u.kind,
          title: str(u.title) || u.id,
          type: str(u.type),
          cluster: str(u.cluster),
          summary: str(u.summary),
          count: Number.isInteger(u.count) && u.count > 1 ? u.count : 1,
          // A read carries the recall band (#221); load_memory reads carry none.
          via: u.kind === "read" ? (u.band === "required" || u.band === "optional" ? "recall" : "load_memory") : "",
          at: now,
        });
      }
      if (!fresh.length) return fresh;
      events.unshift(...fresh);
      if (events.length > max) events.length = max;
      for (const fn of listeners) fn(fresh);
      return fresh;
    },
    counts() {
      const c = { add: 0, change: 0, delete: 0, read: 0 };
      for (const e of events) c[e.kind]++;
      return c;
    },
    onAdd(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Short age for a row: "12s" under a minute, then "3m", "2h", "1d". */
export function shortAge(ms, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86400
        ? `${Math.floor(s / 3600)}h`
        : `${Math.floor(s / 86400)}d`;
}
