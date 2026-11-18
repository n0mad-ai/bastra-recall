// Memory-browser recall heat: the graph-node fields vault() does not keep
// (last recall, tags, scope, the 30-day load series) and the heat bars drawn
// from them. Shared by the list rows (memory-browser.js) and the reader
// (membrowser-reader.js).
import { h } from "../dom.js";
import { data } from "../data.js";

const DAY = 864e5;

let extraFor = null,
  extra = new Map();
/** Graph-node fields vault() does not keep (reach.last_at, tags, scope). */
export function extras() {
  const g = data.graph;
  if (g && g !== extraFor) {
    extra = new Map();
    for (const n of g.nodes)
      if (n && typeof n.id === "string")
        extra.set(n.id, {
          lastAt: Date.parse(typeof n.reach?.last_at === "string" ? n.reach.last_at : ""),
          tags: Array.isArray(n.tags) ? n.tags.filter((x) => typeof x === "string") : [],
          scope: typeof n.scope === "string" ? n.scope : "",
          days: days30(n.recall_days),
        });
    extraFor = g;
  }
  return extra;
}

/** `recall_days` ([daysAgo, loads] pairs from the daemon) → 30 bins, oldest first, today last. */
function days30(list) {
  const out = new Array(30).fill(0);
  if (Array.isArray(list))
    for (const x of list)
      if (Array.isArray(x) && Number.isInteger(x[0]) && x[0] >= 0 && x[0] < 30 && Number.isFinite(x[1]))
        out[29 - x[0]] += Math.max(0, x[1]);
  return out;
}
/** Heat bars (prototype heatRow): scale 4 loads per bar, more fill the bar. */
export function heat(el, days, hot) {
  const mx = Math.max(4, ...days);
  el.append(
    ...days.map((v) =>
      h("span.mb-heat__b", {
        cls: v ? "is-v" : "",
        vars: { "--h": v ? `${Math.max(15, (v / mx) * 100).toFixed(0)}%` : "1px", "--c": hot },
      })
    )
  );
  return el;
}
export const NO_DAYS = new Array(30).fill(0);

const todayStart = () => {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
};
/** Whole days from `ms` to the start of today (UTC); Infinity without a time. */
export const daysAgo = (ms) => (Number.isFinite(ms) ? Math.floor((todayStart() - ms) / DAY) : Infinity);
