// Task reports — "Löschen" and the way back (#1559, like archiving in the memory browser). Right after
// a delete a notice above the next report offers "Rückgängig"; for the whole undo window
// (tasks.reportUndo, default 10 minutes) the deleted report also stays in the list, struck through,
// with its time left counting down and "Wiederherstellen" (Daniel 18.11.2026: moving on to another
// report must not take the undo away). `open` is the view's openReport: it shows the report that
// comes next or comes back.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { data, loadReports } from "../data.js";
import { emit, act } from "./tasks-store.js";
import { api, fmtAt } from "./tasks-api.js";
import { leftParts } from "./tasks-reports-model.js";
import { R, write } from "./tasks-reports-state.js";
import { shown } from "./tasks-reports-search.js";

/** Deletes the report and moves on to the row below it (or above, at the end of the list). While that
 *  one is on screen, a notice offers to undo the delete (the daemon keeps it for a while). */
export function remove(id, open) {
  const rows = shown(),
    at = rows.findIndex((r) => r.id === id),
    next = rows[at + 1] ?? rows[at - 1],
    title = data.reports.find((r) => r.id === id)?.title ?? "";
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

/** "Rückgängig" / "Wiederherstellen": the report comes back with text, read state and notes and is
 *  shown again. */
function undoDelete(id, open) {
  return act(async () => {
    try {
      await write("report_restore", { id });
    } catch (e) {
      if (e.code !== "not_found") throw e;
      if (R.undo?.id === id) R.undo = null;
      await loadReports();
      emit("reports");
      throw new Error(t("tk.rep.undoGone"));
    }
    if (R.undo?.id === id) R.undo = null;
    await loadReports();
    open(id);
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
    h("button.mb-btn.is-quiet", {
      type: "button",
      text: t("tk.rep.undo"),
      on: { click: () => undoDelete(u.id, open) },
    }),
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

// ── deleted reports in the list, with their time left
/** The deleted reports whose undo still runs. */
export const undoable = () => data.deletedReports.filter((r) => r.until > Date.now());

const pad = (n) => String(n).padStart(2, "0");
/** "9:05" below an hour, then hours and minutes, then days and hours. */
function leftText(until) {
  const p = leftParts(until - Date.now());
  if (p.d) return t("tk.rep.del.dh", { d: p.d, h: p.h });
  if (p.h) return t("tk.rep.del.hm", { h: p.h, m: p.m });
  return `${p.m}:${pad(p.s)}`;
}

/** The countdowns in the list now: [element, until]. One tick a second rewrites their text in
 *  place, so the list is not rebuilt under the pointer; when one runs out the list reloads. */
let clocks = [],
  ticker = 0;
function tick() {
  let over = false;
  for (const [el, until] of clocks) {
    if (until <= Date.now()) over = true;
    else el.textContent = t("tk.rep.del.left", { time: leftText(until) });
  }
  if (over) {
    emit("reports");
    loadReports();
  }
}
/** Before a list rebuild: the countdowns of the old rows go. */
export function resetClocks() {
  clocks = [];
}
/** After a list rebuild: the tick runs while a countdown is shown. */
export function runClocks() {
  if (clocks.length && !ticker) ticker = setInterval(tick, 1000);
  if (!clocks.length && ticker) {
    clearInterval(ticker);
    ticker = 0;
  }
}

/** A deleted report's row: struck through, its time left and "Wiederherstellen". Not a button, as it
 *  holds one; the report itself can no longer be opened. */
export function deletedRow(r, open) {
  const left = h("span.tk-rv__left", { text: t("tk.rep.del.left", { time: leftText(r.until) }) });
  clocks.push([left, r.until]);
  return h(
    "div.mb-row.is-deleted",
    { title: t("tk.rep.del.tip", { at: fmtAt(r.until) }) },
    h("span.mb-row__sq", { vars: { "--tc": "var(--line-45)" } }),
    h("span.mb-row__t", { text: r.title }),
    h("button.mb-btn.is-quiet.tk-rv__restore", {
      type: "button",
      text: t("tk.rep.del.restore"),
      "aria-label": t("tk.rep.del.restoreAt", { title: r.title }),
      on: { click: () => undoDelete(r.id, open) },
    }),
    h("span.mb-row__meta", null, left, r.project ? h("span", { text: r.project }) : null)
  );
}
