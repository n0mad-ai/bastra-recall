// Task reports — the status filter above the list (Daniel 26.11.2026: "a filter for this list, by
// handed over, question, new and so on … by default only those that need my attention"). One switch per
// state in the memory browser's chip row (css/membrowser.css: mb__bar, mb__chip), each with the dot of
// its state's colour (css/tasks-reports.css: st-…) and its count. New, Question, In progress and Handed
// over are on by default (tasks-reports-model.js ATTENTION); Read, Done and Outdated are switched on
// by hand and then stand as groups of their own below the open reports. The search and the project
// filter narrow first; the counts are what they leave.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { emit } from "./tasks-store.js";
import { FILTER_STATES, ATTENTION } from "./tasks-reports-model.js";
import { R } from "./tasks-reports-state.js";

/** The label and tooltip of each state's switch, the words the rows use. */
const FILTER_LABELS = {
  new: ["tk.rep.new", "tk.rep.filter.newTip"],
  question: ["tk.rep.question", "tk.rep.filter.questionTip"],
  in_progress: ["tk.rep.inWork", "tk.rep.inWorkTip"],
  handed: ["tk.rep.handedState", "tk.rep.handedStateTip"],
  read: ["tk.rep.readState", "tk.rep.filter.readTip"],
  done: ["tk.rep.doneState", "tk.rep.doneStateTip"],
  outdated: ["tk.rep.outdated", "tk.rep.outdatedTip"],
};

function toggleState(state) {
  if (R.states.has(state)) R.states.delete(state);
  else R.states.add(state);
  emit("reports");
}

/** The chip row; `paint(counts)` brings switches and counts up to date. The buttons are built once, so
 *  a switch keeps the keyboard focus while the list changes under it (Tab reaches each, Enter or Space
 *  presses it, aria-pressed tells a screen reader whether it is on). */
export function statusFilter() {
  const chips = Object.fromEntries(
    FILTER_STATES.map((s) => {
      const count = h("span.mb__mut"),
        btn = h(
          `button.mb__chip.tk-rv__chip.st-${s}`,
          { type: "button", title: t(FILTER_LABELS[s][1]), on: { click: () => toggleState(s) } },
          h("span.mb__chipdot", { "aria-hidden": "true" }),
          h("span", { text: t(FILTER_LABELS[s][0]) }),
          count
        );
      return [s, { btn, count }];
    })
  );
  // the open states first, then the filed-away ones behind a thin divider
  const group = (states) =>
    h(
      "div.tk-rv__fgrp",
      null,
      states.map((s) => chips[s].btn)
    );
  const el = h(
    "div.mb__bar.tk-rv__filter",
    { role: "group", "aria-label": t("tk.rep.filter.label") },
    group(ATTENTION),
    h("span.tk-rv__fsep", { "aria-hidden": "true" }),
    group(FILTER_STATES.filter((s) => !ATTENTION.includes(s)))
  );
  function paint(counts) {
    for (const s of FILTER_STATES) {
      const on = R.states.has(s);
      chips[s].btn.classList.toggle("is-on", on);
      chips[s].btn.setAttribute("aria-pressed", String(on));
      chips[s].count.textContent = String(counts[s] ?? 0);
    }
  }
  return { el, paint };
}

/** The label above a group of the list (read, done, outdated, and the open ones when another group is
 *  shown), in the memory browser's group head (css/membrowser.css: mb__gh). */
const GROUP_LABELS = {
  open: "tk.rep.group.open",
  read: "tk.rep.group.read",
  done: "tk.rep.group.done",
  outdated: "tk.rep.group.outdated",
};
export const groupHead = (group, n) =>
  h("div.mb__gh.tk-rv__gh", null, h("span", { text: t(GROUP_LABELS[group]) }), h("span", { text: String(n) }));
