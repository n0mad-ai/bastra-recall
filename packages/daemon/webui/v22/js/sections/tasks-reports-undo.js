// Task reports — "Löschen" and the "Rückgängig" notice after it (#1559, like archiving in the memory
// browser). `open` is the view's openReport: it shows the report that comes next or comes back.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { loadReports } from "../data.js";
import { emit, act } from "./tasks-store.js";
import { api } from "./tasks-api.js";
import { R, write } from "./tasks-reports-state.js";
import { listed, shown } from "./tasks-reports-search.js";

/** Deletes the report and moves on to the row below it (or above, at the end of the list). While that
 *  one is on screen, a notice offers to undo the delete (the daemon keeps it for a while). */
export function remove(id, open) {
  const filtered = shown(),
    rows = filtered.some((r) => r.id === id) ? filtered : listed(),
    at = rows.findIndex((r) => r.id === id),
    next = at < 0 ? null : (rows[at + 1] ?? rows[at - 1]),
    title = rows[at]?.title ?? "";
  return act(async () => {
    let r = null;
    try {
      r = await api("report_delete", { id });
    } catch (e) {
      if (e.code !== "not_found") throw e;
    }
    R.undo = Number.isFinite(r?.restorable_until) ? { id, title, next: next?.id ?? null } : null;
    if (R.sel === id) {
      R.sel = null;
      if (R.open && next) open(next.id);
    }
    emit("reports");
    await loadReports();
    return R.undo ? "" : t("tk.rep.deleted");
  });
}

/** "Rückgängig": the report comes back with text, read state and notes and is shown again. */
function undoDelete(u, open) {
  return act(async () => {
    try {
      await write("report_restore", { id: u.id });
    } catch (e) {
      if (e.code !== "not_found") throw e;
      R.undo = null;
      emit("reports");
      throw new Error(t("tk.rep.undoGone"));
    }
    R.undo = null;
    await loadReports();
    open(u.id);
    return t("tk.rep.restored");
  });
}

/** The notice after a delete, while the report shown next (or the empty reader) is on screen. */
export function undoNotice(open) {
  const u = R.undo;
  if (!u || (R.sel && u.next !== R.sel)) return null;
  return h(
    "div.mb-ed__notice.tk-rep__undo",
    { role: "status" },
    h("span.mb-ed__done", { text: t("tk.rep.deletedNamed", { title: u.title }) }),
    h("button.mb-btn.is-quiet", { type: "button", text: t("tk.rep.undo"), on: { click: () => undoDelete(u, open) } }),
    h("button.mb-ed__x", {
      type: "button",
      text: "×",
      title: t("tk.rep.undoDismiss"),
      "aria-label": t("tk.rep.undoDismiss"),
      on: {
        click: () => {
          R.undo = null;
          emit("reports");
        },
      },
    })
  );
}
