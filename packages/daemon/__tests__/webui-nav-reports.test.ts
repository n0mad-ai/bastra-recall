// UI v2 rail — "Reports" right below "Tasks" (Daniel 17.11.2026: "a button that
// looks exactly the same"): the real rail (js/nav.js), area registry
// (js/areas.js) and reading view (js/sections/tasks-reports.js) run together in
// a VM context with a small fake DOM. Order, the lit entry in both states (and
// the redraw when the reading view opens or closes inside the Tasks area), the
// unread badge in place of the old dot, and the texts in both languages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Node_, h } from "./webui-report-dom.js";

const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
const strings = async (path: string): Promise<Record<string, string>> =>
  runInNewContext(`(${(await read(path)).replace(/^export default\s*/m, "").replace(/;\s*$/, "")})`, {});
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

async function rail() {
  const listeners: Record<string, Array<() => void>> = {};
  const state: Record<string, unknown> = { view: "tasks", browser: null, lensOpen: false };
  const context: Record<string, unknown> = {
    h,
    icon: (d: string) => h("svg", { d }),
    clear: (el: Node_) => (el.replaceChildren(), el),
    setVars() {},
    searchIcon: () => h("svg", null),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    data: { reports: [], dueTasks: [{}, {}, {}] },
    onData() {},
    loadReports: async () => {},
    lastVaultView: () => "ring",
    rememberVaultView() {},
    openMemoryBrowserArea() {},
    closeMemoryBrowser() {},
    markdown: (text: string) => [h("p", null, text)],
    openMemoryBrowser() {},
    ago: () => "",
    S: {},
    emit() {},
    say() {},
    act: (fn: () => unknown) => fn(),
    api: async () => ({ body: "", notes: [] }),
    fmtAt: () => "",
    annotateReport: (nodes: Node_[]) => ({ nodes, focus: null, toc: { heads: [], asks: [] } }),
    requestAnimationFrame() {},
    window: {},
    document: {
      activeElement: null,
      addEventListener: (type: string, fn: () => void) => (listeners[type] ||= []).push(fn),
      dispatchEvent: (e: { type: string }) => (listeners[e.type] ?? []).forEach((fn) => fn()),
    },
    CustomEvent: class {
      constructor(public type: string) {}
    },
    JSON,
  };
  const source = [
    strip(await read("areas.js")),
    strip(await read("nav.js")),
    strip(await read("views/code-lines.js")),
    strip(await read("sections/tasks-reports-model.js")),
    strip(await read("sections/tasks-reports-state.js")),
    strip(await read("sections/tasks-reports-search.js")),
    strip(await read("sections/tasks-reports-undo.js")),
    strip(await read("sections/tasks-reports-size.js")),
    strip(await read("sections/tasks-reports-toc.js")),
    strip(await read("sections/tasks-reports-status.js")),
    strip(await read("sections/tasks-reports-filter.js")),
    strip(await read("sections/tasks-reports.js")),
  ].join("\n");
  const v = runInNewContext(
    source +
      "\n({ mountNav, registerArea, ICON, reportsArea, tasksLit, showCalendar, reportsOpen, reportRows, scroll: () => scrollEl })",
    context
  );
  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: [
      { id: ID(1), title: "A", origin: { client: "codex" }, created_at: 3 },
      { id: ID(2), title: "B", origin: { client: "codex" }, created_at: 2, notes_open: 1, notes_draft: 1 },
      { id: ID(3), title: "C", origin: { client: "codex" }, created_at: 1, read_at: 4 },
    ],
  });
  // tasks.js registers these two; its other imports are not needed for the rail
  v.registerArea({
    id: "tasks",
    group: "work",
    order: 1,
    labelKey: "nav.tasks",
    icon: v.ICON.tasks,
    lit: v.tasksLit,
    enter: v.showCalendar,
  });
  v.registerArea(v.reportsArea);
  const app = h("div", null);
  v.mountNav(app, { runAction: (a: { onAction: () => unknown }) => a.onAction() });
  const buttons = () => v.scroll().children.filter((n: Node_) => n.classList.contains("nav__btn"));
  const button = (id: string) => buttons().find((b: Node_) => b.attrs["data-nav"] === id) ?? assert.fail(id);
  return { v, state, buttons, button, context };
}

test("Reports sits right below Tasks in the same group, built like every other rail button", async () => {
  const { buttons, button, v } = await rail();
  const ids = buttons().map((b: Node_) => b.attrs["data-nav"]);
  assert.equal(ids[ids.indexOf("tasks") + 1], "reports", "directly below Tasks");
  const tasks = button("tasks"),
    reports = button("reports");
  const kids = v.scroll().children;
  assert.ok(!kids[kids.indexOf(reports) - 1].classList.contains("nav__div"), "no divider between them");
  assert.equal(reports.className, tasks.className.replace(/\s*is-on/, ""), "same button, no sub-entry look");
  assert.deepEqual(
    reports.children.map((n: Node_) => n.className),
    ["nav__icon", "nav__label"],
    "icon and label like the others"
  );
  assert.equal(reports.find("nav__label")[0].textContent, "nav.reports");
  assert.equal(reports.find("nav__icon")[0].children[0].attrs.d, v.ICON.reports, "its own icon");
  assert.notEqual(v.ICON.reports, v.ICON.tasks);
  assert.match(v.ICON.reports, /^[MLHVhvlZ0-9 .-]+$/, "lines only, like the other paths");
});

test("lit entry: Tasks on the calendar, Reports in the reading view; opening and closing redraw the rail", async () => {
  const { v, state, button } = await rail();
  const lit = () =>
    ["tasks", "reports"].filter((id) => {
      const b = button(id);
      return b.classList.contains("is-on") && b.dataset.active === "1" && b.attrs["aria-current"] === "page";
    });
  assert.deepEqual(lit(), ["tasks"]);
  await button("reports").click();
  assert.ok(v.reportsOpen());
  assert.deepEqual(lit(), ["reports"], "the rail redrew without a view change");
  await button("reports").click();
  assert.deepEqual(lit(), ["reports"], "a second click keeps it");
  await button("tasks").click();
  assert.ok(!v.reportsOpen(), "Tasks goes back to the calendar");
  assert.deepEqual(lit(), ["tasks"]);
  state.view = "ring";
  await button("reports").click();
  assert.equal(state.view, "tasks", "from elsewhere Reports opens the Tasks area on its reading view");
  assert.deepEqual(lit(), ["reports"]);
});

test("badge: the unread count in cyan on Reports; Tasks keeps its due count and has no dot any more", async () => {
  const { button } = await rail();
  const badge = button("reports").find("nav__badge");
  assert.equal(badge.length, 1);
  assert.equal(badge[0].textContent, "2");
  assert.ok(badge[0].classList.contains("nav__badge--accent"));
  const tip = 'nav.reports · nav.reportsUnread {"n":2} · nav.reportsDrafts {"n":1}';
  assert.equal(button("reports").attrs.title, tip);
  assert.equal(button("reports").attrs["aria-label"], tip);
  assert.equal(button("tasks").find("nav__badge")[0].textContent, "3", "due tasks, amber as before");
  assert.ok(!button("tasks").find("nav__badge")[0].classList.contains("nav__badge--accent"));
  assert.equal(button("tasks").find("nav__dot").length, 0, "no second signal for reports on Tasks");
});

test("no unread report: no badge", async () => {
  const { v, button, context } = await rail();
  const data = context.data as { reports: unknown };
  data.reports = v.reportRows({ reports: [{ id: ID(1), title: "A", created_at: 1, read_at: 2 }] });
  (context.document as { dispatchEvent: (e: { type: string }) => void }).dispatchEvent({ type: "recall:nav" });
  assert.equal(button("reports").find("nav__badge").length, 0);
  assert.equal(button("reports").attrs.title, "nav.reports");
});

test("rail texts exist in both languages", async () => {
  for (const lang of ["de", "en"]) {
    const table = await strings(`i18n/${lang}.js`);
    for (const key of ["nav.reports", "nav.reportsUnread", "nav.reportsDrafts"])
      assert.equal(typeof table[key], "string", `${key} in ${lang}.js`);
  }
  assert.equal((await strings("i18n/de.js"))["nav.reports"], "Berichte");
  assert.equal((await strings("i18n/en.js"))["nav.reports"], "Reports");
});
