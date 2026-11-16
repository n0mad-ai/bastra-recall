// Area registry — the one place that decides what the navigation shows.
//
// The free build registers its own areas below. Pro areas (mail, terminal,
// documents, images, links, full dashboard, live voice) live in the private
// recall-pro repository and are added through registerArea() — this file is
// the docking point, it carries no Pro code.
//
// ── Adding an area (Dashboard, Telemetry, Tasks, Settings, …) ─────────────
// Files: js/sections/<name>.js (code), css/<name>.css (linked in index.html),
// js/i18n/<name>-en.js + <name>-de.js (strings, merged via addStrings()).
// Import js/sections/<name>.js from js/sections/index.js. Then in <name>.js:
//
//   addStrings(en, de);
//   registerArea({ id: "settings", ...,                 // existing entry: same id replaces it
//     section: { frame: true },                          // stage frame (see stage.js)
//     greetingKey: "agent.greeting.settings",            // agent greeting in this area
//     presetKeys: ["agent.sug.settings"],                // agent suggestions
//     tabs: [{ id: "areas", labelKey: "lens.find", render: (body, ctx) => {…} }],
//     mount: (el, ctx) => { el.append(hud({ kicker, title, text, side, tiles })); return () => {}; } });
//
// HUD head box, tiles, chips and buttons: js/sections/hud.js.
export const ICON = {
  dashboard: "M4 4h7v9H4ZM13 4h7v5h-7ZM13 11h7v9h-7ZM4 15h7v5H4Z",
  mindspace:
    "M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4M4 12a8 8 0 0 1 13.7-5.6M20 12a8 8 0 0 1-13.7 5.6M7 9.5a5.5 5.5 0 0 1 8.5-1.7M17 14.5a5.5 5.5 0 0 1-8.5 1.7",
  clouds: "M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.1A4.5 4.5 0 0 0 7 18Z",
  ring: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 3v5M21 12h-5",
  semantic: "M6 6l6 12l6-12ZM6 6a1 1 0 1 0 0 .01M18 6a1 1 0 1 0 0 .01M12 18a1 1 0 1 0 0 .01",
  chronos: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2M12 3v2M21 12h-2M12 21v-2M3 12h2",
  radiant:
    "M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M18.4 5.6l-3.2 3.2M8.8 15.2l-3.2 3.2",
  spiral: "M12 12a1 1 0 0 1 2 0a2 2 0 0 1-4 0a3 3 0 0 1 6 0a4 4 0 0 1-8 0a5 5 0 0 1 10 0a6 6 0 0 1-12 0",
  halflife:
    "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 12l7-5",
  weave: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M5 8c5 2 9 2 14 0M5 16c4-4 10-4 14 0M8 4.5c2 5 2 10 0 15",
  browser: "M4 4h16v16H4ZM10 4v16M13 8h4M13 12h4M13 16h3",
  telemetry: "M3 12h4l3-7l4 14l3-7h4",
  tasks: "M4 5h16v15H4ZM4 9h16M9 3v4M15 3v4M8 14l2.5 2.5L16 12",
  areas: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM12 11v6M9 14h6",
  import: "M12 3v10M8 9l4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  settings: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6",
};

/** Vault views in pop-over order (prototype VIEWS without telemetry). */
export const VAULT_VIEWS = [
  "mindspace",
  "clouds",
  "ring",
  "semantic",
  "chronos",
  "radiant",
  "spiral",
  "halflife",
  "weave",
];

/** Navigation groups, top to bottom; a divider precedes every non-empty group. */
export const GROUPS = ["home", "vault", "work", "library", "manage", "system"];

/** Views that keep the agent pinned open (prototype `pinAgent`). */
const PINNED = new Set(["dashboard", "settings", "tasks"]);

const registry = new Map();

/**
 * Register an area. Registering an id again replaces the earlier entry.
 * @param {{ id: string, group: string, order: number, labelKey?: string, label?: string,
 *           titleKey?: string, icon: string, kind?: "view"|"action", pinAgent?: boolean,
 *           mount?: (stage: HTMLElement, ctx: object) => (() => void) | void,
 *           onAction?: (ctx: object) => void, badge?: () => number,
 *           section?: { frame?: boolean, fit?: boolean },
 *           greetingKey?: string, presetKeys?: string[],
 *           tabs?: { id: string, labelKey: string, badge?: () => number,
 *                    render?: (body: HTMLElement, ctx: object) => (() => void) | void }[] }} area
 *
 * section   — stage frame for normal areas: mount() then gets the inner content
 *             element instead of the bare stage. frame: inner content frame
 *             (Telemetry, Settings) or none (Tasks, Mail, Docs, …).
 *             fit: no scrolling; the content fills the stage height exactly.
 *             Without `section`, mount() gets the bare stage (vault views).
 * greetingKey / presetKeys — agent window greeting and suggestions
 *             (prototype *_GREETING / *_PRESETS). Default: the vault greeting.
 * tabs      — right panel tabs. The first tab must have id "areas" (it is the
 *             one opened when the area is entered). A tab without render()
 *             shows the "in progress" marker. Default: Areas/Signals/View/Live.
 *             render() runs on view/tab change; ctx.refreshLens() rebuilds it.
 */
export function registerArea(area) {
  registry.set(area.id, { kind: "view", ...area });
  if (area.pinAgent) PINNED.add(area.id);
  document.dispatchEvent(new CustomEvent("recall:areas"));
}

export function areasIn(group) {
  return [...registry.values()].filter((a) => a.group === group).sort((a, b) => a.order - b.order);
}

export function getArea(id) {
  return registry.get(id);
}
export function isPinned(view) {
  return PINNED.has(view);
}

// ── free build ────────────────────────────────────────────────────────────
registerArea({
  id: "dashboard",
  group: "home",
  order: 1,
  labelKey: "nav.dashboard",
  icon: ICON.dashboard,
  pinAgent: true,
  greetingKey: "agent.greeting.dashboard",
  presetKeys: ["agent.sug.brief"],
  tabs: [
    { id: "areas", labelKey: "lens.widgets" },
    { id: "layout", labelKey: "lens.layout" },
  ],
});
// "vault" is the pop-over button itself; telemetry sits right below it.
registerArea({
  id: "telemetry",
  group: "vault",
  order: 2,
  labelKey: "nav.telemetry",
  icon: ICON.telemetry,
  tabs: [
    { id: "areas", labelKey: "lens.find" },
    { id: "view", labelKey: "lens.view" },
  ],
});
registerArea({
  id: "tasks",
  group: "work",
  order: 1,
  labelKey: "nav.tasks",
  icon: ICON.tasks,
  pinAgent: true,
  greetingKey: "agent.greeting.tasks",
  presetKeys: ["agent.sug.due", "agent.sug.remind"],
  tabs: [
    { id: "areas", labelKey: "lens.details" },
    { id: "view", labelKey: "lens.view" },
    { id: "control", labelKey: "lens.control" },
  ],
});
registerArea({
  id: "areas",
  group: "manage",
  order: 1,
  labelKey: "nav.areas",
  titleKey: "nav.areasTitle",
  icon: ICON.areas,
  kind: "action",
});
registerArea({
  id: "import",
  group: "manage",
  order: 2,
  labelKey: "nav.import",
  titleKey: "nav.importTitle",
  icon: ICON.import,
  kind: "action",
});
registerArea({
  id: "settings",
  group: "system",
  order: 1,
  labelKey: "nav.settings",
  icon: ICON.settings,
  pinAgent: true,
  greetingKey: "agent.greeting.settings",
  presetKeys: ["agent.sug.settings"],
  tabs: [
    { id: "areas", labelKey: "lens.find" },
    { id: "changes", labelKey: "lens.changes" },
  ],
});

// ── window.recallUi: the one docking point for Pro bundles ────────────────
// Only this file assigns window.recallUi. Modules that offer a further hook
// (tasks-styles.js › registerCalendarStyle, dashboard.js › registerWidget)
// add it with extendRecallUi({ name: fn }); existing names are never replaced.
const recallUi = { registerArea };
window.recallUi = Object.freeze({ ...recallUi });

export function extendRecallUi(fns) {
  for (const [name, fn] of Object.entries(fns)) {
    if (typeof fn !== "function") throw new TypeError(`extendRecallUi: ${name} is not a function`);
    if (name in recallUi) throw new Error(`extendRecallUi: ${name} is already registered`);
    recallUi[name] = fn;
  }
  window.recallUi = Object.freeze({ ...recallUi });
}
