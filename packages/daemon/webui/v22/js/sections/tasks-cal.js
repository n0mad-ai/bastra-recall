// Tasks calendar — shared pieces of the calendar styles (ledger here, Pro
// styles through tasks-styles.js › env.cal): status keys, date helpers, weather marks, item cards and the
// HTML5 drag & drop with visible drop zones (prototype STAGE › isTasks).
// The calendar shows browser-local time; a drop is converted to the task's
// own time zone by the store (tasks-store.js › moveDue).
import { h, s, setVars } from "../dom.js";
import { t } from "../i18n.js";
import { S, emit, select, moveDue } from "./tasks-store.js";
import { weatherDays, fmtAt } from "./tasks-api.js";

/** Status keys in legend order; colours and fills live in css/tasks.css (.tk-k-<key>). */
export const KEYS = ["planned", "await", "due", "snoozed", "done", "failed"];
export const ICON = { planned: "○", await: "◇", due: "●", snoozed: "◐", done: "✓", failed: "✕" };
export const H0 = 7,
  H1 = 22;
export const label = (k) => t(`tk.k.${k}`);
export const pad = (n) => String(n).padStart(2, "0");
export const hm = (hh) => `${pad(Math.floor(hh))}:${pad(Math.round((hh % 1) * 60) % 60)}`;
export const d0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const mon0 = (d) => addDays(d0(d), -((d.getDay() + 6) % 7));
export const dayIx = (d, ref) => Math.round((d0(d) - d0(ref)) / 864e5);
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function isoWeek(dt) {
  const d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}
const list = (key) => t(key).split(",");
export const WD = () => list("tk.wd"); // SO,MO,… (Date.getDay order)
export const WD_MON = () => list("tk.wdMon"); // MO … SO (grid order)
export const MONTHS = () => list("tk.months");
export const nowH = () => {
  const n = new Date();
  return n.getHours() + n.getMinutes() / 60;
};
export const nowLabel = () => hm(nowH());
export const tzShort = (() => {
  try {
    return (
      new Intl.DateTimeFormat("en", { timeZoneName: "short" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value || ""
    );
  } catch {
    return "";
  }
})();

export const visible = (x) => !S.hide[x.k];
export const dayItems = (d) =>
  S.items.filter((x) => x.date && sameDay(x.date, d) && visible(x)).sort((a, b) => a.h - b.h);
export const dated = () => S.items.filter((x) => x.date && visible(x));

/** "Status · due" tooltip (prototype mkItem tip). */
export const tip = (x) => `${label(x.k)} · ${x.at ? fmtAt(x.at, x.t.timezone) : t("tk.onEvent")}`;
export const kcls = (x) =>
  `tk-k-${x.k}${S.sel === x.id ? " is-sel" : ""}${x.k === "done" || x.k === "failed" ? " is-past" : ""}${x.k === "due" ? " is-due" : ""}`;
/** Only open, dated, non-archived tasks can be moved in time. */
export const movable = (x) =>
  !!x.at && !x.t.archived && !["resolved", "cancelled", "expired"].includes(x.t.state) && x.t.schedule.kind !== "event";

// ── weather ──────────────────────────────────────────────────────────────
const SUN = () =>
  s(
    "svg.tk-wx__i",
    { viewBox: "0 0 24 24" },
    s("circle.tk-wx__sun", { cx: 12, cy: 12, r: 4.2 }),
    s("path.tk-wx__rays", {
      d: "M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8",
    })
  );
const CLOUD = () =>
  s(
    "svg.tk-wx__i.tk-wx__i--c",
    { viewBox: "0 0 24 24" },
    s("path.tk-wx__cloud", { d: "M7 18h10a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.6A3.3 3.3 0 0 0 7 18Z" })
  );
const RAIN = () =>
  s(
    "svg.tk-wx__i.tk-wx__i--c",
    { viewBox: "0 0 24 24" },
    s("path.tk-wx__cloud", { d: "M7 14h10a3.6 3.6 0 0 0 .4-7.2 5 5 0 0 0-9.6 1.4A3 3 0 0 0 7 14Z" }),
    s("path.tk-wx__drops", { d: "M9 17l-1 3M13 17l-1 3M17 17l-1 3" })
  );
export const wxOf = (d) => weatherDays()[iso(d)] || null;
export const wxIcon = (w) => (w.kind === "sun" ? SUN() : w.kind === "rain" ? RAIN() : CLOUD());
/** "14° 9° ☀" — empty when no forecast exists for that day. */
export function wxMark(d, { lo = true } = {}) {
  const w = wxOf(d);
  if (!w) return null;
  return h(
    "span.tk-wx",
    null,
    h("span", { text: `${w.hi}°` }),
    lo ? h("span.tk-wx__lo", { text: `${w.lo}°` }) : null,
    wxIcon(w)
  );
}

/** Day head "MO | 28 | 14° 9° ☀" (row) or stacked (narrow columns). */
export function dayHead(d, { stack = false, today = false } = {}) {
  const wd = WD()[d.getDay()],
    wx = wxMark(d);
  if (stack)
    return [
      h("span.tk-dh__num.is-lg", { text: String(d.getDate()) }),
      h("span.tk-dh__stack", null, h("span.tk-dh__wd", { text: wd }), wx || h("span.tk-wx")),
    ];
  return h(
    "span.tk-dh__row",
    { cls: today ? "is-today" : "" },
    h("span.tk-dh__wd", { text: wd }),
    h("span.tk-dh__sep"),
    h("span.tk-dh__num", { text: String(d.getDate()) }),
    wx ? [h("span.tk-dh__sep"), wx] : null
  );
}

// ── drag & drop (ledger) ──────────────────────────────────────────────────
// Nothing re-renders during a drag (a replaced source element ends the drag);
// the drop zones and the ghost are switched by classes and custom properties.
let root = null,
  ghost = null;
export function dndRoot(el) {
  root = el;
  ghost = null;
}

export function draggable(el, x) {
  if (!movable(x)) return el;
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    S.drag = x.id;
    if (e.dataTransfer) {
      e.dataTransfer.setData("text/plain", x.id);
      e.dataTransfer.effectAllowed = "move";
    }
    el.classList.add("is-dragging");
    root?.classList.add("is-drag");
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("is-dragging");
    endDrag();
  });
  return el;
}

export function endDrag() {
  S.drag = null;
  root?.classList.remove("is-drag");
  root?.querySelectorAll(".is-over").forEach((n) => n.classList.remove("is-over"));
  ghost?.remove();
  ghost = null;
}

/**
 * Drop zone. at(e) → { at: ms, label, top?: px } for the pointer position.
 * Week columns show a ghost slot at `top`; month cells light up as a whole.
 */
export function dropZone(el, at) {
  el.classList.add("tk-drop");
  el.addEventListener("dragover", (e) => {
    if (!S.drag) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!el.classList.contains("is-over")) {
      root?.querySelectorAll(".is-over").forEach((n) => n.classList.remove("is-over"));
      el.classList.add("is-over");
    }
    const tg = at(e);
    if (tg.top === undefined) {
      ghost?.remove();
      ghost = null;
      return;
    }
    if (!ghost) ghost = h("div.tk-ghost", null, h("span.tk-ghost__l"));
    if (ghost.parentNode !== el) el.append(ghost);
    setVars(ghost, { "--top": `${tg.top.toFixed(1)}px` });
    ghost.firstChild.textContent = tg.label;
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("is-over");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const id = S.drag,
      tg = at(e);
    endDrag();
    if (id) moveDue(id, tg.at);
  });
  return el;
}

/** Double-click on an empty slot opens "New task" at that local time. */
export function composeAt(d, hh) {
  S.compose = true;
  S.showDue = false;
  S.F = { ...S.F, timing: "when", when: `${iso(d)}T${pad(Math.floor(hh))}:${hh % 1 ? "30" : "00"}` };
  emit();
}

export const onSelect = (x) => (e) => {
  e.stopPropagation();
  select(x.id);
};
