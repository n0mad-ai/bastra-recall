// Task reports — the reading view's shared state and the report store's writes. The view
// (tasks-reports.js), its search (tasks-reports-search.js) and delete with Undo
// (tasks-reports-undo.js) all read and change this one object.
import { t } from "../i18n.js";
import { api } from "./tasks-api.js";

// open: reading view replaces the calendar · sel: report shown · body: its text (null = loading)
// notes: the shown report's notes · edit: the open note field { anchor, noteId (null = new), draft }
// order: row order frozen while the view is open, so a row marked there does not jump away under the pointer
// list: narrow view shows the list instead of the reader (memory browser: "← LISTE")
// q: the search over the list; the shown report stays open even when the search hides its row
// hits: { q, ids } the daemon's text search found for q · undo: { id, title, next } the last delete, undoable
// while `next` (the report shown after it, null for none) is on screen
// project: the project filter in the head (null = all projects) · menu: its pick list is open
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
};

/** A change the report store can refuse when it is full (#1609): then the message says so and how to
 *  make room, instead of the generic one. */
export async function write(name, input) {
  try {
    return await api(name, input);
  } catch (e) {
    throw e.code === "capacity" ? Object.assign(new Error(t("tk.rep.full")), { code: e.code }) : e;
  }
}
