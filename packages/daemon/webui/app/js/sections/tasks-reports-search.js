// Task reports — the list's order, the search in the view's head (#1597) and the project filter beside
// it: title and project filter at once, the daemon's text search joins in after a short pause, the
// latest search wins.
import { data } from "../data.js";
import { emit } from "./tasks-store.js";
import { api } from "./tasks-api.js";
import { reportRows, matchReports, inProject } from "./tasks-reports-model.js";
import { R } from "./tasks-reports-state.js";

/** Rows in the order they had when the view opened; reports that arrived since go on top. */
export function listed() {
  const at = (r) => R.order.indexOf(r.id);
  return [...data.reports].sort((a, b) => at(a) - at(b));
}
/** The daemon's text hits, while they belong to the current search. */
export const hitsNow = () => (R.hits && R.hits.q === R.q.trim() ? R.hits.ids : null);
/** The rows the search and the project filter leave in the list. */
export const shown = () => inProject(matchReports(listed(), R.q, hitsNow()), R.project);

/** The daemon searches the report text too (#1597); a short pause after typing, the latest search wins.
 *  A Recall without the text search refuses the query: then title and project stay the search. */
const SEARCH_MS = 250;
const QUERY_MAX = 200;
let searchTimer = 0,
  searchSeq = 0;
export function searchText() {
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  const q = R.q.trim();
  if (!q || q.length > QUERY_MAX) return;
  searchTimer = setTimeout(async () => {
    try {
      const r = await api("report_list", { query: q });
      if (seq !== searchSeq || R.q.trim() !== q) return;
      R.hits = { q, ids: new Set(reportRows(r).map((x) => x.id)) };
      emit("reports");
    } catch {
      /* the title and project match stays */
    }
  }, SEARCH_MS);
}

export function setQuery(q) {
  if (R.q.trim() !== q.trim()) R.hits = null;
  R.q = q;
  searchText();
  emit("reports");
}
