// Tasks calendar — docking point for calendar styles (setting calStyle).
// The free build registers "ledger" (tasks-ledger.js). Pro styles (flow,
// stream, relay) live in the private recall-pulse repository and register
// through window.recallUi.registerCalendarStyle() — this file carries no Pro
// code. Until one is registered, the View tab shows it as a Pro hint.
//
//   window.recallUi.registerCalendarStyle({
//     id: "flow", pro: true,
//     strings: { en: {…}, de: {…} },          // optional, merged via addStrings()
//     render(env) { … return { body, levels, nav, prev, next, today, zoom?, range?, sub?, canAgenda }; },
//   });
//
// render(env) gets everything it needs, so a style imports nothing from here:
//   env.bw / env.bh   calendar body size in px      env.rebuild()  redraw the calendar
//   env.ctx           area ctx (ctx.ask(…))         env.S          tasks state (items, sel, view, off, …)
//   env.dom           { h, s, setVars }             env.t          i18n lookup
//   env.actions       { emit, select, review, lifecycle, moveDue, canMove,
//                       assign(x, "user"|"recall"), openSource(x, rect), holder(task, k) → { who, set } }
//   env.cal           shared calendar helpers (js/sections/tasks-cal.js)
//   env.ledger        { weekDays, monthStart }
// Returned toolbar data: levels [{ label, on, onClick }], nav (‹ TODAY ›) with
// prev/next/today, zoom { in, out, label }, range/sub (null = week/month text).
import { addStrings } from "../i18n.js";
import { extendRecallUi } from "../areas.js";

const styles = new Map();
const listeners = new Set();

export function registerCalendarStyle(style) {
  if (!style || typeof style.id !== "string" || typeof style.render !== "function")
    throw new TypeError("registerCalendarStyle({ id, render })");
  if (style.strings) addStrings(style.strings.en || {}, style.strings.de || {});
  styles.set(style.id, { pro: true, ...style });
  for (const fn of listeners) fn();
}

extendRecallUi({ registerCalendarStyle });

export const calendarStyle = (id) => styles.get(id);
export const calendarStyles = () => [...styles.values()];
export function onCalendarStyles(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Styles of Recall Pulse shown as a hint in the View tab while not registered (prototype TK_STYLES). */
export const PRO_STYLES = [
  ["flow", "M3 4h7v7H3ZM14 4h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z"],
  ["stream", "M3 7h12M7 12h14M3 17h9"],
  ["relay", "M3 12h18M7 12V5M12 12V8M17 12v7M9 12v5"],
];
