// Task reports — the status filter in the view's head, between the project pick list and the search
// (Daniel 26.11.2026). New, Question, In progress and Handed over are switches of their own, on by
// default (tasks-reports-model.js ATTENTION), each with the dot of its state's colour
// (css/tasks-reports.css: st-…) and its count, in the memory browser's chip look (css/membrowser.css:
// mb__chip). Read, Done and Outdated sit in one pick list after them, built and used like the project
// pick list (mb__scope, mb__scopebtn, mb__menu, mb__opt): several at once, each with its dot and count;
// switched on, they stand as groups of their own below the open reports. The search and the project
// filter narrow first; the counts are what they leave. The list opens, closes, takes Escape and a click
// outside as the project pick list (tasks-reports.js).
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { emit } from "./tasks-store.js";
import { FILTER_STATES, ATTENTION } from "./tasks-reports-model.js";
import { R, toggleReportState } from "./tasks-reports-state.js";

/** The label and tooltip of each state: the switches use the rows' words, the pick list's entries the
 *  plain spelling of the project names beside them. */
const FILTER_LABELS = {
  new: ["tk.rep.new", "tk.rep.filter.newTip"],
  question: ["tk.rep.question", "tk.rep.filter.questionTip"],
  in_progress: ["tk.rep.inWork", "tk.rep.inWorkTip"],
  handed: ["tk.rep.handedState", "tk.rep.handedStateTip"],
  read: ["tk.rep.st.read", "tk.rep.filter.readTip"],
  done: ["tk.rep.st.done", "tk.rep.doneStateTip"],
  outdated: ["tk.rep.st.outdated", "tk.rep.outdatedTip"],
};
/** The filed-away states, in the pick list. */
const FILED = FILTER_STATES.filter((s) => !ATTENTION.includes(s));

function toggleState(state) {
  toggleReportState(state);
  emit("reports");
}

/** The four switches and the pick list; `paint(counts)` brings both up to date. Switches and entries
 *  are built once (the entries are only put into the list while it is open), so each keeps the
 *  keyboard focus while the list changes under it: Tab reaches it, Enter or Space presses it,
 *  aria-pressed tells a screen reader whether it is on. */
export function statusFilter() {
  const chip = (s) => {
    const count = h("span.mb__mut"),
      btn = h(
        `button.mb__chip.tk-rv__chip.st-${s}`,
        { type: "button", title: t(FILTER_LABELS[s][1]), on: { click: () => toggleState(s) } },
        h("span.mb__chipdot", { "aria-hidden": "true" }),
        h("span", { text: t(FILTER_LABELS[s][0]) }),
        count
      );
    return { btn, count };
  };
  const entry = (s) => {
    const count = h("span.mb__mut"),
      btn = h(
        `button.mb__opt.tk-rv__sopt.st-${s}`,
        { type: "button", title: t(FILTER_LABELS[s][1]), on: { click: () => toggleState(s) } },
        h("span.mb__optdot", { "aria-hidden": "true" }),
        h("span.mb__optname", { text: t(FILTER_LABELS[s][0]) }),
        count
      );
    return { btn, count };
  };
  const items = Object.fromEntries([...ATTENTION.map((s) => [s, chip(s)]), ...FILED.map((s) => [s, entry(s)])]);
  const chips = h(
    "div.tk-rv__fgrp",
    { role: "group", "aria-label": t("tk.rep.filter.label") },
    ATTENTION.map((s) => items[s].btn)
  );
  const btn = h("button.mb__scopebtn.tk-rv__statebtn", {
      type: "button",
      title: t("tk.rep.filter.filedTip"),
      "aria-haspopup": "true",
      on: {
        click: () => {
          R.smenu = !R.smenu;
          R.menu = false;
          emit("reports");
        },
      },
    }),
    on = h("span.mb__mut"),
    menu = h("div.mb__menu.tk-rv__smenu", { hidden: true, role: "group", "aria-label": t("tk.rep.filter.filedTip") });
  btn.append(
    h("span.mb__scopesq"),
    h("span.mb__scopename", { text: t("tk.rep.filter.filed") }),
    on,
    h("span.mb__mut", { text: "▾" })
  );
  const more = h("div.mb__scope.tk-rv__state", null, btn, menu);
  function paint(counts) {
    for (const s of FILTER_STATES) {
      const lit = R.states.has(s);
      items[s].btn.classList.toggle("is-on", lit);
      items[s].btn.setAttribute("aria-pressed", String(lit));
      items[s].count.textContent = String(counts[s] ?? 0);
    }
    // how many of the three are switched on, none: no number
    const n = FILED.filter((s) => R.states.has(s)).length;
    on.textContent = n ? String(n) : "";
    on.hidden = !n;
    btn.classList.toggle("is-open", R.smenu);
    btn.setAttribute("aria-expanded", String(R.smenu));
    if (menu.hidden === R.smenu) {
      menu.hidden = !R.smenu;
      menu.replaceChildren(...(R.smenu ? FILED.map((s) => items[s].btn) : []));
      // at the end of the head the list would reach past the view: then it opens towards the left
      menu.classList.remove("is-end");
      if (R.smenu)
        menu.classList.toggle(
          "is-end",
          menu.getBoundingClientRect().right > more.parentElement.getBoundingClientRect().right
        );
    }
  }
  return { chips, more, paint };
}

/** The label above a group of the list (read, done, outdated, and the open ones when another group is
 *  shown), in the memory browser's group head (css/membrowser.css: mb__gh). A heading for screen readers
 *  on the level of the reader's report title (h2); a div with the role, so the look stays the same. */
const GROUP_LABELS = {
  open: "tk.rep.group.open",
  read: "tk.rep.group.read",
  done: "tk.rep.group.done",
  outdated: "tk.rep.group.outdated",
};
export const groupHead = (group, n) =>
  h(
    "div.mb__gh.tk-rv__gh",
    { role: "heading", "aria-level": "2" },
    h("span", { text: t(GROUP_LABELS[group]) }),
    h("span", { text: String(n) })
  );
