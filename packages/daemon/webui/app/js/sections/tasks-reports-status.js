// Task reports — the one state a report shows in the list and in the reader's head (Daniel
// 18.11.2026, colours 26.11.2026): New (cyan), Question (amber, filled; on the report that asks), In progress (amber, dashed like the owner's drafts), Handed over (the quiet light grey of the
// text: with an agent now), Done (green), Outdated (muted, #1678). A follow-up's head names the report it asks about and leads
// back. The daemon derives the state (task-report-status.ts); this only shows it. `open` is the
// view's openReport, passed in so this module needs nothing from tasks-reports.js.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { stateOf } from "./tasks-reports-model.js";

/** Label key, tooltip key and look of each state; "read" shows nothing. */
const MARKS = {
  new: { text: "tk.rep.new", cls: "" },
  in_progress: { text: "tk.rep.inWork", tip: "tk.rep.inWorkTip", cls: ".tk-rv__work.tk-rv__draft" },
  handed: { text: "tk.rep.handedState", tip: "tk.rep.handedStateTip", cls: ".tk-rv__handed" },
  done: { text: "tk.rep.doneState", tip: "tk.rep.doneStateTip", cls: ".tk-rv__done" },
  question: { text: "tk.rep.question", cls: ".tk-rv__work" },
  // #1678: muted, so outdated reports step back
  outdated: { text: "tk.rep.outdated", tip: "tk.rep.outdatedTip", cls: ".tk-rv__old" },
};

/** The head leaves out "New": its "Read" button already leads there. */
export function stateMark(r, inHead) {
  const mark = MARKS[stateOf(r)];
  if (!mark || (inHead && stateOf(r) === "new")) return null;
  return h(`span.mb-row__ai${mark.cls}${inHead ? ".tk-rep__state" : ""}`, {
    text: t(mark.text),
    title: mark.tip ? t(mark.tip) : null,
  });
}

export function followUpLink(r, open) {
  if (!r.followUp) return null;
  return h("button.tk-rep__about", {
    text: t("tk.rep.followUp", { t: r.followUp.title }),
    title: r.followUp.title,
    on: { click: () => open(r.followUp.id) },
  });
}

/** In a follow-up's head: "Follow-up to: <title>", a button back to that report. */
export function askedAbout(r, open) {
  if (!r.followUpOf) return null;
  return h("button.tk-rep__about", {
    text: t("tk.rep.askedAbout", { t: r.followUpOf.title }),
    title: r.followUpOf.title,
    on: { click: () => open(r.followUpOf.id) },
  });
}

/** Visible reader navigation for linked reports, even when a list filter hides one. */
export function reportLinks(r, open) {
  return r.followUpOf || r.followUp ? h("div.tk-rep__links", null, askedAbout(r, open), followUpLink(r, open)) : null;
}
