// Task reports — the one state a report shows in the list and in the reader's head (Daniel
// 18.11.2026): New (cyan), In progress and Handed over (amber), Done (muted green), Question (amber,
// jumps to the follow-up that asks). A follow-up's head names the report it asks about and leads
// back. The daemon derives the state (task-report-status.ts); this only shows it. `open` is the
// view's openReport, passed in so this module needs nothing from tasks-reports.js.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { stateOf } from "./tasks-reports-model.js";

/** Label key, tooltip key and look of each state; "read" shows nothing. */
const MARKS = {
  new: { text: "tk.rep.new", cls: "" },
  in_progress: { text: "tk.rep.inWork", tip: "tk.rep.inWorkTip", cls: ".tk-rv__work" },
  handed: { text: "tk.rep.handedState", tip: "tk.rep.handedStateTip", cls: ".tk-rv__work" },
  done: { text: "tk.rep.doneState", tip: "tk.rep.doneStateTip", cls: ".tk-rv__done" },
  // its tooltip names the follow-up (below)
  question: { text: "tk.rep.question", cls: ".tk-rv__work.tk-rv__ask" },
};

/** The state label. A question jumps to its follow-up: in the head as a button; in the list as a
 *  click on the label (the row itself is a button, so no second button inside it). The head leaves
 *  out "New": its "Read" button already leads there. */
export function stateMark(r, inHead, open) {
  const mark = MARKS[stateOf(r)];
  if (!mark || (inHead && stateOf(r) === "new")) return null;
  const jump = stateOf(r) === "question" && r.followUp;
  const props = {
    text: t(mark.text),
    title: jump ? t("tk.rep.questionTip", { t: r.followUp.title }) : mark.tip ? t(mark.tip) : null,
    on: jump
      ? {
          click: (e) => {
            e?.stopPropagation?.();
            return open(r.followUp.id);
          },
        }
      : undefined,
  };
  return h(`${jump && inHead ? "button" : "span"}.mb-row__ai${mark.cls}${inHead ? ".tk-rep__state" : ""}`, props);
}

/** In a follow-up's head: "Question about: <title>", a button back to that report. */
export function askedAbout(r, open) {
  if (!r.followUpOf) return null;
  return h("button.tk-rep__about", {
    text: t("tk.rep.askedAbout", { t: r.followUpOf.title }),
    title: r.followUpOf.title,
    on: { click: () => open(r.followUpOf.id) },
  });
}
