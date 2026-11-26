// Task reports — the view's head, built like the memory browser's head and with its classes
// (css/membrowser.css: mb__head, mb__scope, mb__menu, mb__search; Daniel 18.11.2026): title, the
// project pick list (the memory browser's area pick list), the status filter
// (tasks-reports-filter.js: four switches and a pick list like the project's), the search field (#1597) with its count and the
// unread count. A project filter and the search narrow the list together. No ESC:
// reports are an area of their own, left through the rail (Daniel 18.11.2026).
import { h, searchIcon } from "../dom.js";
import { t } from "../i18n.js";
import { emit } from "./tasks-store.js";
import { projectsOf } from "./tasks-reports-model.js";
import { R } from "./tasks-reports-state.js";
import { setQuery } from "./tasks-reports-search.js";

/** Picks a project (null: all) and closes the pick list. */
function pick(project) {
  R.project = project;
  R.menu = false;
  emit("reports");
}

function option(id, name, n) {
  return h(
    "button.mb__opt",
    { type: "button", cls: id === R.project ? "is-on" : "", on: { click: () => pick(id) } },
    h("span.mb__optdot", { vars: { "--c": id === null ? "var(--accent)" : "var(--ink-soft)" } }),
    h("span.mb__optname", { text: name }),
    h("span.mb__mut", { text: String(n) })
  );
}

/** The head: project pick list, the status filter's switches and pick list (`filter`), search, count.
 *  No title: the breadcrumb and the rail name the area, and the head needs the room to stay one line
 *  (Daniel 26.11.2026). `paint(rows, shownCount, unread, live, tight)` brings it up to date: rows =
 *  every report in the list (deleted ones still undoable included), shownCount = how many search and
 *  filter leave, unread and live = the unread and the present (not deleted) reports, tight = the view
 *  is narrow enough that the search field gets the short hint. */
export function reportsHead(filter) {
  const input = h("input.mb__input.tk-rv__input", {
      type: "text",
      spellcheck: "false",
      placeholder: t("tk.rep.find.ph"),
      "aria-label": t("tk.rep.find.label"),
      on: { input: () => setQuery(input.value) },
    }),
    found = h("span.mb__hits"),
    count = h("span.mb__hits.tk-rv__hits"),
    btn = h("button.mb__scopebtn.tk-rv__projbtn", {
      type: "button",
      title: t("tk.rep.proj.tip"),
      "aria-haspopup": "true",
      on: {
        click: () => {
          R.menu = !R.menu;
          R.smenu = false;
          emit("reports");
        },
      },
    }),
    menu = h("div.mb__menu", { hidden: true }),
    el = h(
      "div.mb__head",
      null,
      h("div.mb__scope.tk-rv__proj", null, btn, menu),
      ...filter,
      h("label.mb__search", null, searchIcon(), input, found),
      count
    );
  let seen = "";
  function paint(rows, shownCount, unread, live, tight) {
    const projects = projectsOf(rows),
      n = R.project === null ? rows.length : (projects.find((p) => p.name === R.project)?.count ?? 0),
      key = JSON.stringify([projects, R.project, R.menu, rows.length]);
    if (input.value !== R.q) input.value = R.q;
    input.placeholder = t(tight ? "tk.rep.find.phShort" : "tk.rep.find.ph");
    found.textContent = R.q.trim() ? t("tk.rep.find.count", { n: shownCount, m: rows.length }) : "";
    count.textContent = t("tk.rep.count", { u: unread, n: live });
    if (key === seen) return;
    seen = key;
    btn.replaceChildren(
      h("span.mb__scopesq"),
      h("span.mb__scopename", { text: R.project ?? t("tk.rep.proj.all") }),
      h("span.mb__mut", { text: String(n) }),
      h("span.mb__mut", { text: "▾" })
    );
    btn.classList.toggle("is-open", R.menu);
    btn.setAttribute("aria-expanded", String(R.menu));
    menu.hidden = !R.menu;
    menu.replaceChildren(
      ...(R.menu
        ? [option(null, t("tk.rep.proj.all"), rows.length), ...projects.map((p) => option(p.name, p.name, p.count))]
        : [])
    );
  }
  return { el, input, paint };
}
