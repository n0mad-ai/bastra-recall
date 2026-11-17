// UI v2 address hash (#1560): `bastra tasks` opens /ui/#tasks. The real rail
// (js/nav.js), area registry (js/areas.js) and the Reports view
// (js/sections/tasks-reports.js) run together in a VM context with a small
// fake DOM, a fake location/history and a hashchange listener.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { h } from "./v22-report-dom.js";

const read = (path: string) => readFile(new URL(`../webui/v22/js/${path}`, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");

async function shell(hash: string, view = "chronos") {
  const listeners: Record<string, Array<() => void>> = {};
  const windowListeners: Record<string, Array<() => void>> = {};
  const location = { hash };
  const replaced: string[] = [];
  const document = {
    activeElement: null,
    addEventListener: (type: string, fn: () => void) => (listeners[type] ||= []).push(fn),
    dispatchEvent: (e: { type: string }) => (listeners[e.type] ?? []).forEach((fn) => fn()),
  };
  const state: Record<string, unknown> = { view, browser: null, lensOpen: false };
  const context: Record<string, unknown> = {
    h,
    icon: (d: string) => h("svg", { d }),
    clear: (el: { replaceChildren: () => void }) => (el.replaceChildren(), el),
    setVars() {},
    searchIcon: () => h("svg", null),
    t: (key: string) => key,
    state,
    // the shell's render loop: a state change redraws the rail (main.js › updateNav)
    setState: (patch: Record<string, unknown>) => {
      Object.assign(state, patch);
      document.dispatchEvent({ type: "recall:nav" });
    },
    data: { reports: [], dueTasks: [] },
    onData() {},
    loadReports: async () => {},
    lastVaultView: () => "ring",
    rememberVaultView() {},
    openMemoryBrowserArea() {},
    closeMemoryBrowser() {},
    markdown: () => [],
    openMemoryBrowser() {},
    ago: () => "",
    S: {},
    emit() {},
    say() {},
    act: (fn: () => unknown) => fn(),
    api: async () => ({ body: "", notes: [] }),
    fmtAt: () => "",
    annotateReport: (nodes: unknown) => ({ nodes, focus: null }),
    requestAnimationFrame() {},
    location,
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => {
        replaced.push(url);
        location.hash = url;
      },
    },
    window: { addEventListener: (type: string, fn: () => void) => (windowListeners[type] ||= []).push(fn) },
    document,
    CustomEvent: class {
      constructor(public type: string) {}
    },
    JSON,
    decodeURIComponent,
  };
  const source = [
    strip(await read("areas.js")),
    strip(await read("nav.js")),
    strip(await read("sections/tasks-reports-model.js")),
    strip(await read("sections/tasks-reports.js")),
  ].join("\n");
  const v = runInNewContext(
    source + "\n({ mountNav, followHash, registerArea, ICON, reportsArea, tasksLit, showCalendar, reportsOpen })",
    context
  );
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
  const ctx = { runAction: (a: { onAction: () => unknown }) => a.onAction() };
  v.mountNav(h("div", null), ctx);
  const start = () => v.followHash(ctx);
  const navigate = (next: string) => {
    location.hash = next;
    (windowListeners.hashchange ?? []).forEach((fn) => fn());
  };
  return { v, state, location, replaced, start, navigate };
}

test("/ui/#tasks opens the Tasks area on its calendar", async () => {
  const s = await shell("#tasks");
  s.start();
  assert.equal(s.state.view, "tasks");
  assert.equal(s.v.reportsOpen(), false);
  assert.equal(s.location.hash, "#tasks");
});

test("the hash uses the rail's names: a vault view and the Reports entry", async () => {
  const halflife = await shell("#halflife");
  halflife.start();
  assert.equal(halflife.state.view, "halflife");
  const reports = await shell("#reports");
  reports.start();
  assert.equal(reports.state.view, "tasks");
  assert.equal(reports.v.reportsOpen(), true);
});

test("without a hash the shell starts where it would today", async () => {
  const s = await shell("", "ring");
  s.start();
  assert.equal(s.state.view, "ring");
});

test("unknown names and plain actions are ignored", async () => {
  for (const hash of ["#nonsense", "#import", "#%E0%A4%A", "#__proto__"]) {
    const s = await shell(hash, "ring");
    s.start();
    assert.equal(s.state.view, "ring", hash);
  }
});

test("a hash change opens the named area; an unknown one changes nothing", async () => {
  const s = await shell("", "ring");
  s.start();
  s.navigate("#tasks");
  assert.equal(s.state.view, "tasks");
  s.navigate("#weave");
  assert.equal(s.state.view, "weave");
  s.navigate("#nowhere");
  assert.equal(s.state.view, "weave");
});

test("the hash follows the lit place without new history entries", async () => {
  const s = await shell("#tasks");
  s.start();
  s.v.reportsArea.onAction(); // Reports opens inside the Tasks view
  assert.equal(s.location.hash, "#reports");
  s.v.showCalendar();
  assert.equal(s.location.hash, "#tasks");
  s.navigate("#ring");
  assert.equal(s.location.hash, "#ring");
  assert.ok(s.replaced.every((url) => url.startsWith("#")));
});

test("an area that registers after the start (Pro) still opens from the load hash", async () => {
  const s = await shell("#mail", "ring");
  s.start();
  assert.equal(s.state.view, "ring");
  assert.equal(s.location.hash, "#mail", "kept while the area is not there yet");
  s.v.registerArea({ id: "mail", group: "work", order: 5, labelKey: "nav.mail", icon: "" });
  assert.equal(s.state.view, "mail");
});

test("a name kept for a later area is dropped once the user goes elsewhere", async () => {
  const s = await shell("#mail", "ring");
  s.start();
  s.v.showCalendar();
  assert.equal(s.location.hash, "#tasks");
  s.v.registerArea({ id: "mail", group: "work", order: 5, labelKey: "nav.mail", icon: "" });
  assert.equal(s.state.view, "tasks");
});
