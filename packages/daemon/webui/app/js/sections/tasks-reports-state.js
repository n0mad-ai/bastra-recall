// Task reports — the reading view's shared state and the report store's writes. The view
// (tasks-reports.js), its search (tasks-reports-search.js) and delete with Undo
// (tasks-reports-undo.js) all read and change this one object.
import { t } from "../i18n.js";
import { api } from "./tasks-api.js";
import { ATTENTION, FILTER_STATES } from "./tasks-reports-model.js";

const STATES_KEY = "recall-reports-filter-states";

function loadStates() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATES_KEY));
    if (Array.isArray(saved) && saved.every((state) => FILTER_STATES.includes(state))) return new Set(saved);
  } catch {
    // Storage may be unavailable or the saved value may be invalid.
  }
  return new Set(ATTENTION);
}

// open: reading view replaces the calendar · sel: report shown · body: its text (null = loading)
// notes: the shown report's notes · edit: the open note field { anchor, noteId (null = new), draft }
// order: row order frozen while the view is open, so a row marked there does not jump away under the pointer
// list: narrow view shows the list instead of the reader (memory browser: "← LISTE")
// q: the search over the list; the shown report stays open even when the search hides its row
// hits: { q, ids } the daemon's text search found for q · undo: { id, title, next } the last delete, undoable
// while `next` (the report shown after it, null for none) is on screen
// project: the project filter in the head (null = all projects) · menu: its pick list is open
// states: the states the status filter shows (tasks-reports-filter.js), kept in this browser
// smenu: the status filter's pick list is open
export const R = {
  open: false,
  sel: null,
  body: null,
  notes: [],
  edit: null,
  order: [],
  list: false,
  q: "",
  hits: null,
  undo: null,
  project: null,
  menu: false,
  states: loadStates(),
  smenu: false,
};

export function toggleReportState(state) {
  if (R.states.has(state)) R.states.delete(state);
  else R.states.add(state);
  try {
    localStorage.setItem(STATES_KEY, JSON.stringify([...R.states]));
  } catch {
    // The current page still uses the new choice if storage is unavailable.
  }
}

/** A change the report store can refuse when it is full (#1609): then the message says so and how to
 *  make room, instead of the generic one. */
export async function write(name, input) {
  try {
    return await api(name, input);
  } catch (e) {
    throw e.code === "capacity" ? Object.assign(new Error(t("tk.rep.full")), { code: e.code }) : e;
  }
}
