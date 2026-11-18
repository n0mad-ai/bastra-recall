// The reading view of the task reports (js/sections/tasks-reports.js and its modules) in a VM
// context with the fake DOM (webui-report-dom.ts): view() mounts it with a stand-in daemon, data,
// storage and timers; the helpers find elements and type into the search. Shared by the view tests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Node_, h } from "./webui-report-dom.js";

const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
export const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
/** Report texts the stand-in daemon searches (task_report_list with query). */
const BODIES: Record<string, string> = { [ID(3)]: "die preise steigen weiter." };

export const REPORTS = [
  { id: ID(1), title: "Überblick: Förderung", project: "FÖRDERUNG", origin: { client: "codex" }, created_at: 30 },
  { id: ID(2), title: "Release-Prüfung", project: "bastra-recall", origin: { client: "claude-code" }, created_at: 20 },
  {
    id: ID(3),
    title: "Lint nachgezogen",
    project: "bastra-io",
    origin: { client: "codex", session: "s-1" },
    created_at: 10,
    read_at: 40,
    notes_open: 2,
  },
];

export type Entry = { text: string; el: Node_; index: number; answered?: boolean };
export type Toc = { heads: Entry[]; asks: Entry[] };

export async function view(notes: unknown[] = [], stored = new Map<string, string>()) {
  const calls: Array<[string, unknown]> = [];
  const timers = new Map<number, () => unknown>();
  let timerId = 0;
  const said: Array<[string, unknown]> = [];
  const events: string[] = [];
  const dataListeners: Array<() => void> = [];
  const docListeners: Record<string, (e: unknown) => void> = {};
  const ticks: { fn: (() => unknown) | null } = { fn: null };
  const source = (
    await Promise.all(
      [
        "sections/tasks-reports-model.js",
        "sections/tasks-reports-state.js",
        "sections/tasks-reports-search.js",
        "sections/tasks-reports-undo.js",
        "sections/tasks-reports-head.js",
        "sections/tasks-reports-size.js",
        "sections/tasks-reports-toc.js",
        "sections/tasks-reports.js",
      ].map(read)
    )
  )
    .map(strip)
    .join("");
  const context: Record<string, unknown> = {
    h,
    searchIcon: () => h("svg", null),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    state: { lensOpen: false, tab: "areas" },
    setState: (patch: Record<string, unknown>) => Object.assign(context.state as object, patch),
    // this browser's storage; knobs.blocked makes it throw like a private window with storage off
    localStorage: {
      getItem: (k: string) => {
        if (knobs.blocked) throw new Error("blocked");
        return stored.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (knobs.blocked) throw new Error("blocked");
        stored.set(k, v);
      },
    },
    data: { reports: [], deletedReports: [] },
    onData: (fn: () => void) => dataListeners.push(fn),
    loadReports: async () => {},
    markdown: (text: string) => [h("p", null, text)],
    openMemoryBrowser() {},
    ago: (at: number) => `${at}m`,
    S: {},
    emit() {},
    say: (text: string, tone: unknown) => said.push([text, tone]),
    act: async (fn: () => Promise<unknown>) => {
      try {
        const msg = await fn();
        if (msg) said.push([msg as string, undefined]);
      } catch (e) {
        said.push([(e as Error).message, "error"]);
      }
    },
    api: async (name: string, input: any) => {
      calls.push([name, input]);
      if (knobs.capacity && name !== "report_read" && name !== "report_list")
        throw Object.assign(new Error("tk.err.generic"), { code: "capacity" });
      if (name === "report_list")
        return { reports: REPORTS.filter((r) => (BODIES[r.id] ?? "").includes(input.query.toLowerCase())) };
      if (name === "report_delete") return { deleted: true, id: input.id, restorable_until: 99 };
      if (name === "report_restore" && knobs.restore)
        throw Object.assign(new Error(`tk.err.${knobs.restore}`), { code: knobs.restore });
      if (name === "report_notes_hand") {
        if (hand.fail) throw Object.assign(new Error("tk.err.not_found"), { code: "not_found" });
        return { handed: 1, notes: notes.map((n: any) => ({ ...n, handed_at: 99 })) };
      }
      return name === "report_read" ? { body: "Erster Absatz.", notes } : {};
    },
    fmtAt: (at: number) => `@${at}`,
    annotateReport: (nodes: Node_[]) => ({ nodes, focus: null, toc: knobs.toc }),
    ICON: { reports: "M0 0" },
    document: {
      activeElement: null,
      dispatchEvent: (e: { type: string }) => events.push(e.type),
      addEventListener: (type: string, fn: (e: unknown) => void) => (docListeners[type] = fn),
    },
    CustomEvent: class {
      constructor(public type: string) {}
    },
    JSON,
    // a pause (the text search waits for typing to stop) runs when the test says so, never by the clock
    setTimeout: (fn: () => unknown) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    // the countdown's one-second tick runs when the test says so
    setInterval: (fn: () => unknown) => {
      ticks.fn = fn;
      return 1;
    },
    clearInterval: () => (ticks.fn = null),
  };
  const hand = { fail: false };
  const knobs: { capacity: boolean; restore: string | null; blocked: boolean; toc: Toc } = {
    capacity: false,
    restore: null,
    blocked: false,
    toc: { heads: [], asks: [] },
  };
  const v = runInNewContext(
    source +
      "\n({ R, notesUi, reportRows, deletedRows, openReport, openReports, closeReports, reportsRenderer, escapeReports, reportsOpen, matchReports, reportsArea, tasksLit, showCalendar, outlineTab, trackOutline })",
    context
  );
  (context.data as { reports: unknown }).reports = v.reportRows({ reports: REPORTS });
  const host = h("div", null);
  host.clientWidth = 1000;
  const draw = v.reportsRenderer(host);
  context.emit = () => draw();
  const runNextTimer = async () => {
    const next = timers.entries().next().value;
    if (!next) return;
    const [id, fn] = next;
    timers.delete(id);
    await fn();
  };
  const flush = async () => {
    while (timers.size) await runNextTimer();
  };
  const updateReports = (reports: unknown[]) => {
    (context.data as { reports: unknown }).reports = v.reportRows({ reports });
    for (const notify of dataListeners) notify();
  };
  /** The daemon's list after a change: present reports and the deletes still undoable. */
  const updateAll = (reports: unknown[], deleted: unknown[]) => {
    (context.data as { deletedReports: unknown }).deletedReports = v.deletedRows({ deleted });
    updateReports(reports);
  };
  return {
    v,
    host,
    draw,
    calls,
    said,
    events,
    hand,
    knobs,
    flush,
    context,
    updateReports,
    updateAll,
    runNextTimer,
    ticks,
    docListeners,
  };
}

export const byClass = (root: Node_, cls: string) => root.find(cls);
export const one = (root: Node_, cls: string) => byClass(root, cls)[0] ?? assert.fail(`no .${cls}`);
export const input = (host: Node_) => one(host, "tk-rv__input");
export function type(host: Node_, text: string) {
  const el = input(host);
  el.value = text;
  for (const fn of el.listeners.input ?? []) fn();
}
export const listRows = (host: Node_) => one(host, "mb__list").children.filter((n) => n.classList.contains("mb-row"));
