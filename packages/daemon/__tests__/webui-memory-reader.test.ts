// The memory browser's reader (#1662): the real browser modules mounted on a small fake DOM with a
// stand-in daemon, a fixed corpus of memories walked through the reader's paths (no selection, full
// detail, summary only, no body, failed detail, rule proposal, narrow layout with "back", a followed
// link, an area switch, a refresh at the same scroll position) and the whole browser frozen as HTML
// with the calls it made. Moving or reshaping the reader cannot change what it shows unnoticed.
// The opening paths (Daniel 25.11.2026) run on the same stand-ins: the rail's Browser stands and
// leaves at once, a memory link from outside the vault views grows only after the view's glide.
//
// The browser modules are copied into a temporary folder; the shell modules around them (state,
// daemon data, agent, cover, vault data, Pro views) are replaced there by small stand-ins.
// Update the frozen state only for an intended change:
//   node --import tsx --import ./scripts/test-env.mjs --test --test-update-snapshots \
//     packages/daemon/__tests__/webui-memory-reader.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const DAY = 864e5;

// ── fake DOM ────────────────────────────────────────────────────────────────
class FakeNode {
  parent: FakeEl | null = null;
  get parentNode() {
    return this.parent;
  }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n) {
      if (n instanceof FakeEl && n.connected) return true;
      n = n.parent;
    }
    return false;
  }
  remove() {
    if (!this.parent) return;
    this.parent.nodes.splice(this.parent.nodes.indexOf(this), 1);
    this.parent = null;
  }
  after(...items: Array<FakeNode | string>) {
    const p = this.parent!;
    const at = p.nodes.indexOf(this) + 1;
    p.nodes.splice(at, 0, ...items.map((x) => p.adopt(x)));
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
  }
  get nodeType() {
    return 3;
  }
  get textContent() {
    return this.data;
  }
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const REFLECTED = ["hidden", "disabled", "title", "type", "role", "placeholder", "spellcheck"];

class FakeEl extends FakeNode {
  nodes: FakeNode[] = [];
  attrs = new Map<string, string>();
  classes = new Set<string>();
  vars = new Map<string, string>();
  events: string[] = [];
  handlers = new Map<string, Array<(e: unknown) => unknown>>();
  connected = false;
  value = "";
  readOnly = false;
  scrollTop = 0;
  clientWidth = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  scrollHeight = 0;
  clientHeight = 0;
  style: Record<string, unknown>;
  dataset: Record<string, string>;
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
    toggle: (c: string, on?: boolean) => {
      const want = on === undefined ? !this.classes.has(c) : !!on;
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    },
    contains: (c: string) => this.classes.has(c),
  };
  constructor(public tagName: string) {
    super();
    const vars = this.vars;
    this.style = { setProperty: (k: string, v: string) => vars.set(k, v), height: "" };
    const attrs = this.attrs;
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_, k) => attrs.get(`data-${kebab(String(k))}`),
      set: (_, k, v) => (attrs.set(`data-${kebab(String(k))}`, String(v)), true),
    });
    for (const name of REFLECTED)
      Object.defineProperty(this, name, {
        get: () => (name === "hidden" || name === "disabled" ? this.attrs.has(name) : (this.attrs.get(name) ?? "")),
        set: (v: unknown) => {
          if (name === "hidden" || name === "disabled") {
            if (v) this.attrs.set(name, "");
            else this.attrs.delete(name);
          } else this.attrs.set(name, String(v));
        },
      });
  }
  get nodeType() {
    return 1;
  }
  get children() {
    return this.nodes.filter((n): n is FakeEl => n instanceof FakeEl);
  }
  get firstChild() {
    return this.nodes[0] ?? null;
  }
  get className() {
    return [...this.classes].join(" ");
  }
  set className(v: string) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get textContent(): string {
    return this.nodes.map((n) => (n as FakeEl | FakeText).textContent).join("");
  }
  set textContent(v: string) {
    this.nodes.forEach((n) => (n.parent = null));
    this.nodes = [];
    if (String(v)) this.append(String(v));
  }
  adopt(x: FakeNode | string) {
    const n = typeof x === "string" ? new FakeText(x) : x;
    n.remove();
    n.parent = this;
    return n;
  }
  append(...items: Array<FakeNode | string>) {
    for (const x of items) this.nodes.push(this.adopt(x));
  }
  replaceChildren(...items: Array<FakeNode | string>) {
    this.nodes.forEach((n) => (n.parent = null));
    this.nodes = [];
    this.append(...items);
  }
  insertBefore(n: FakeNode, ref: FakeNode | null) {
    const node = this.adopt(n);
    const at = ref ? this.nodes.indexOf(ref) : -1;
    if (at < 0) this.nodes.push(node);
    else this.nodes.splice(at, 0, node);
    return n;
  }
  setAttribute(k: string, v: string) {
    if (k === "class") this.className = v;
    else this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  addEventListener(ev: string, fn: (e: unknown) => unknown) {
    this.events.push(ev);
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
  }
  removeEventListener() {}
  all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  contains(n: unknown): boolean {
    return n === this || this.all().includes(n as FakeEl);
  }
  /** `.a.b`, `tag`, `[data-x="y"]` and their combinations, and descendants of them. */
  matches(sel: string): boolean {
    const parts = sel.trim().split(/\s+/);
    const own = parts.pop()!;
    const m = /^([a-z0-9]*)((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/i.exec(own);
    if (!m) throw new Error(`fake DOM: unsupported selector ${sel}`);
    const [, tag, cls, attr, val] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (
      cls &&
      !cls
        .slice(1)
        .split(".")
        .every((c) => this.classes.has(c))
    )
      return false;
    if (attr && this.attrs.get(attr) !== val) return false;
    if (!parts.length) return true;
    for (let p = this.parent; p; p = p.parent) if (p.matches(parts.join(" "))) return true;
    return false;
  }
  querySelector(sel: string) {
    return this.all().find((n) => n.matches(sel)) ?? null;
  }
  querySelectorAll(sel: string) {
    return this.all().filter((n) => n.matches(sel));
  }
  closest(sel: string) {
    let n: FakeEl | null = this;
    while (n && !n.matches(sel)) n = n.parent;
    return n;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  scrollTo() {}
  scrollIntoView() {}
  focus() {}
  select() {}
  setSelectionRange() {}
  async fire(ev: string) {
    const e = { currentTarget: this, target: this, preventDefault() {}, stopImmediatePropagation() {} };
    for (const fn of this.handlers.get(ev) ?? []) await fn(e);
  }
}

/** A node as HTML: tag, class, attributes in a fixed order, custom properties, listeners, scroll. */
function html(n: FakeNode): string {
  if (n instanceof FakeText) return n.data;
  const el = n as FakeEl;
  const tag = el.tagName.toLowerCase();
  const cls = el.classes.size ? ` class="${el.className}"` : "";
  const attrs = [...el.attrs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const vars = el.vars.size ? ` style="${[...el.vars].map(([k, v]) => `${k}:${v}`).join(";")}"` : "";
  const on = el.events.length ? ` on="${[...new Set(el.events)].sort().join(",")}"` : "";
  const value = el.value ? ` value="${el.value}"` : "";
  const scroll = el.scrollTop ? ` scroll="${el.scrollTop}"` : "";
  return `<${tag}${cls}${attrs}${vars}${on}${value}${scroll}>${el.nodes.map(html).join("")}</${tag}>`;
}

// ── corpus ──────────────────────────────────────────────────────────────────
type Mem = {
  id: string;
  area: string;
  title: string;
  type: string;
  kind: string;
  cls: string;
  summary: string;
  at: number;
  created: number;
  recalled: number;
  acted: number;
  links: Array<{ id: string; rel: string }>;
};
const mem = (id: string, area: string, cls: string, extra: Partial<Mem>): Mem => ({
  id,
  area,
  title: `Title of ${id}`,
  type: cls,
  kind: "memory",
  cls,
  summary: "",
  at: NOW - 2 * DAY,
  created: NOW - 40 * DAY,
  recalled: 0,
  acted: 0,
  links: [],
  ...extra,
});

const MEMS: Mem[] = [
  mem("full", "bastra-recall", "decision", {
    title: "Reader keeps its scroll position",
    summary: "A refreshed reader stands where it stood.",
    at: NOW - 3 * 3600e3,
    created: NOW - 10 * DAY,
    recalled: 12,
    acted: 5,
    links: [
      { id: "summary-only", rel: "linked" },
      { id: "no-body", rel: "derived" },
      { id: "gone", rel: "linked" },
    ],
  }),
  mem("summary-only", "bastra-recall", "rule", {
    summary: "Only a summary and its triggers.",
    at: NOW - 5 * DAY,
    created: NOW - 80 * DAY,
    recalled: 3,
    acted: 0,
  }),
  mem("no-body", "household", "fact", { summary: "", type: "", at: NaN, created: NaN }),
  mem("failed", "household", "note", { summary: "Detail request fails.", at: NOW - 45 * DAY, recalled: 1 }),
  mem("proposal", "bastra-io", "convention", {
    summary: "Waiting for a decision.",
    at: NOW - 20 * DAY,
    created: NOW - 2 * DAY,
    recalled: 4,
    acted: 4,
  }),
];

const DETAILS: Record<string, unknown> = {
  full: {
    file: "memories/projects/bastra-recall/reader.md",
    created: "2026-11-08",
    updated: "2026-11-18",
    recall_mode: "reflex",
    scope: "bastra-recall",
    topic_path: ["bastra-recall", "webui", "reader"],
    tags: ["webui", "reader", 7],
    source: "session",
    recall_when: ["reader refreshes", "", "scroll jumps"],
    revision: "sha256:aaaa",
    body: [
      "# Rule",
      "Keep the **scroll** position, see [[summary-only]] and [[missing]].",
      "",
      "- one",
      "- two",
      "",
      "```",
      "  code stays",
      "```",
      "Done? [? Yes | No]",
    ].join("\n"),
  },
  "summary-only": {
    file: "memories/rules/summary.md",
    recall_when: ["rule applies"],
    tags: [],
    revision: "sha256:bbbb",
    body: "   ",
  },
  "no-body": { file: "memories/facts/no-body.md", tags: ["fact"], revision: "sha256:cccc" },
  proposal: {
    file: "memories/conventions/proposal.md",
    revision: "sha256:dddd",
    rule: { state: "proposal" },
    body: "Proposed convention text.",
  },
};

const CARE = [
  { id: "full", kind: "edit", note: "Tighten the wording.", date: "2026-11-17", done: false },
  { id: "full", kind: "note", note: "Done already.", date: "2026-11-10", done: true },
];

const NODES = {
  full: {
    reach: { last_at: "2026-11-17T08:00:00Z" },
    tags: ["x"],
    scope: "bastra-recall",
    recall_days: [
      [0, 2],
      [3, 9],
      [40, 1],
    ],
  },
  "summary-only": { reach: { last_at: "2026-11-01T08:00:00Z" }, tags: ["rule"], scope: "global", recall_days: [] },
  failed: { reach: { last_at: "2026-10-01T08:00:00Z" }, tags: [], scope: "home" },
  proposal: {
    recall_days: [
      [29, 1],
      [0, 0],
    ],
  },
} as Record<string, Record<string, unknown>>;

function vaultOf(mems: Mem[]) {
  const byId = new Map(mems.map((m) => [m.id, m]));
  const counts = new Map<string, number>();
  for (const m of mems) counts.set(m.area, (counts.get(m.area) ?? 0) + 1);
  return { mems, byId, total: mems.length, areas: [...counts].map(([key, count]) => ({ key, count })) };
}
const graphOf = () => ({ nodes: MEMS.map((m) => ({ id: m.id, ...(NODES[m.id] ?? {}) })), edges: [] });

// ── stand-ins for the shell modules around the browser ──────────────────────
const STUBS: Record<string, string> = {
  "state.js": `export const state = globalThis.__mb.state;
export function setState(patch) { globalThis.__mb.log.push("setState " + JSON.stringify(patch)); Object.assign(state, patch); }`,
  "data.js": `export const data = globalThis.__mb.data;
export function onData(fn) { globalThis.__mb.dataListeners.push(fn); return () => {}; }
export function loadGraph() { globalThis.__mb.log.push("loadGraph"); return Promise.resolve(); }`,
  "agent.js": `export function ask(q) { globalThis.__mb.log.push("ask " + q); }`,
  "cover.js": `export function cover(key, on) { globalThis.__mb.log.push("cover " + key + " " + on); }`,
  "views/pro-views.js": `export const viewLocked = () => false;
export const lastVaultView = () => globalThis.__mb.lastView ?? "ring";`,
  "views/vault-data.js": `export const vault = () => globalThis.__mb.vault;
export const timeWindow = () => null;
export const inWindow = () => true;
export const areaCol = (key) => "col(" + key + ")";
export const ago = (ms) => Math.round((Date.now() - ms) / 36e5) + "h";
export const recentIn = () => [];`,
};

const appJs = new URL("../webui/app/js/", import.meta.url);

async function settle(n = 6) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

const GLOBALS = [
  "document",
  "window",
  "Node",
  "CSS",
  "ResizeObserver",
  "requestAnimationFrame",
  "fetch",
  "Date",
  "setTimeout",
  "clearTimeout",
];

type Env = {
  log: string[];
  state: Record<string, unknown>;
  data: Record<string, unknown>;
  dataListeners: Array<() => void>;
  vault: unknown;
  /** lastVaultView() of the Pro views stand-in (default "ring"). */
  lastView?: string;
  /** The browser's timers (grow, reveal, close) wait for runTimers(); the test's own waits use setImmediate. */
  timers: Map<number, { fn: () => void; ms: number }>;
  resize: () => void;
  keydown: (event: Pick<KeyboardEvent, "key">) => void;
};

/** The browser's world: fake DOM, stand-in daemon, a fixed clock and held timers. */
function fakeGlobals(): Env {
  const g = globalThis as Record<string, unknown>;
  const RealDate = Date;
  const log: string[] = [];
  const htmlEl = new FakeEl("html");
  htmlEl.dataset.lang = "en";
  let timerId = 0;
  const env: Env = {
    log,
    state: { view: "ring", browser: null },
    data: { graph: graphOf(), clusters: [], health: null },
    dataListeners: [],
    vault: vaultOf(MEMS),
    timers: new Map(),
    resize: () => {},
    keydown: () => {},
  };
  g.__mb = env;
  g.Node = FakeNode;
  g.document = {
    documentElement: htmlEl,
    activeElement: new FakeEl("body"),
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_: string, tag: string) => new FakeEl(tag),
    createTextNode: (s: string) => new FakeText(s),
    addEventListener() {},
    removeEventListener() {},
  };
  g.window = {
    addEventListener(type: string, listener: Env["keydown"]) {
      if (type === "keydown") env.keydown = listener;
    },
    removeEventListener() {},
    innerWidth: 1440,
    innerHeight: 900,
  };
  g.CSS = { escape: (s: string) => s };
  g.ResizeObserver = class {
    constructor(fn: () => void) {
      env.resize = fn;
    }
    observe() {}
    disconnect() {}
  };
  g.requestAnimationFrame = () => 0;
  g.setTimeout = (fn: () => void, ms = 0) => (env.timers.set(++timerId, { fn, ms }), timerId);
  g.clearTimeout = (id: number) => env.timers.delete(id);
  g.fetch = async (url: string, init?: { method?: string }) => {
    log.push(`fetch ${init?.method ?? "GET"} ${url}`);
    const json = (b: unknown, status = 200) => ({ ok: status === 200, status, json: async () => b });
    if (url === "/ui/annotations") return json({ annotations: CARE });
    if (url === "/ui/memory/archive") return json({ archived_to: ".bastra/trash/summary.md" });
    const id = /[?&]id=([^&]+)/.exec(url)?.[1];
    if (id && decodeURIComponent(id) in DETAILS) return json(DETAILS[decodeURIComponent(id)]);
    return json(null, 500);
  };
  g.Date = class extends RealDate {
    constructor(...a: unknown[]) {
      super(...((a.length ? a : [NOW]) as []));
    }
    static now() {
      return NOW;
    }
  };
  return env;
}

type Browser = {
  openMemoryBrowser: (scope: string, sel: string | null, from: unknown) => void;
  openMemoryBrowserArea: (from: unknown) => void;
  closeMemoryBrowser: (after?: () => void) => boolean;
  mountMemoryBrowser: (
    stage: FakeEl,
    opts: { showMemory: (id: string, done?: () => void) => unknown; ready?: (cb: () => void) => void }
  ) => () => void;
};

/** Walks the reader through its paths; one frame per step. */
async function walk(mb: Browser, env: Env): Promise<string[]> {
  const stage = new FakeEl("div");
  stage.connected = true;
  const frames: string[] = [];
  const reader = () => stage.querySelector(".mb__reader")!;
  /** The whole browser once; after that its frame, the selected row and the reader. */
  const snap = (label: string, whole = false) => {
    const root = stage.children[0];
    const open = html(root).slice(0, html(root).indexOf(">") + 1);
    const sel = root.querySelector(".mb-row.is-sel");
    const parts = whole ? [html(root)] : [open, sel ? html(sel) : "(no selected row)", html(reader())];
    frames.push([`── ${label}`, ...parts, ...env.log.splice(0)].join("\n"));
  };
  /** Runs the pending timers in the order the browser would (delay, then creation). */
  const runTimers = async () => {
    const due = [...env.timers].sort(([a, x], [b, y]) => x.ms - y.ms || a - b);
    for (const [id, { fn }] of due) {
      env.timers.delete(id);
      fn();
    }
    await settle();
  };
  const click = async (sel: string, scope: FakeEl = reader()) => {
    const el = scope.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    await el.fire("click");
    await settle();
  };
  const row = (id: string) => click(`.mb-row[data-id="${id}"]`, stage);
  const acts = () => reader().querySelector(".mb-rd__acts")!.children;

  // the vault view stands, then its card opens the browser
  const unmount = mb.mountMemoryBrowser(stage, { showMemory: (id: string) => env.log.push(`showMemory ${id}`) });
  mb.openMemoryBrowser("all", null, null);
  const root = stage.children[0];
  root.clientWidth = 1200;
  await settle();
  await runTimers();
  snap("open without a selection", true);

  for (const id of ["full", "summary-only", "no-body", "failed", "proposal"]) {
    await row(id);
    snap(`select ${id}`);
  }

  await row("full");
  await click(".mb-rd__link");
  snap("follow the first link");
  await row("full");
  await click(".mb-rd__area");
  snap("switch to the memory's area");
  await click(".mb-rd__acts .mb-btn.is-primary");
  snap("ask the agent");

  // Same memory, new graph: the reader fetches again and stands where it stood.
  reader().scrollTop = 240;
  env.data.graph = graphOf();
  env.dataListeners.forEach((fn) => fn());
  await settle();
  snap("refresh after a graph change");

  root.clientWidth = 600;
  env.resize();
  await settle();
  snap("narrow layout");
  await click(".mb-rd__back");
  snap("narrow, back to the list");

  root.clientWidth = 1200;
  // Archive: the selection moves on, the reader shows the note with "undo".
  await row("summary-only");
  await acts()
    .find((b) => b.textContent === "ARCHIVE")!
    .fire("click");
  await settle();
  snap("archive a memory");

  await row("full");
  await acts()[1].fire("click");
  await settle();
  await runTimers();
  snap("show in the view");

  unmount();
  return frames;
}

/** A fresh copy of the browser modules (module-wide state) on the stand-ins. */
async function withBrowser(run: (mb: Browser, env: Env) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "webui-mb-reader-"));
  const g = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, g[k]]));
  try {
    await cp(appJs, dir, { recursive: true });
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    for (const [file, src] of Object.entries(STUBS)) await writeFile(join(dir, file), src);
    const env = fakeGlobals();
    await run((await import(pathToFileURL(join(dir, "views/memory-browser.js")).href)) as Browser, env);
  } finally {
    unmounts.splice(0).forEach((un) => un());
    await settle(); // late reads (vault care flags) land before the stand-ins go
    for (const [k, v] of Object.entries(saved)) g[k] = v;
    delete g.__mb;
    await rm(dir, { recursive: true, force: true });
  }
}

test("the memory browser's reader renders a fixed corpus unchanged", async (t) => {
  await withBrowser(async (mb, env) => t.assert.snapshot((await walk(mb, env)).join("\n\n")));
});

const RECT = { left: 10, top: 20, right: 30, bottom: 40 };
const unmounts: Array<() => void> = [];
const mounted = (mb: Browser, opts: Parameters<Browser["mountMemoryBrowser"]>[1]) => {
  const stage = new FakeEl("div");
  stage.connected = true;
  unmounts.push(mb.mountMemoryBrowser(stage, opts));
  return stage.children[0];
};
const growTimers = (env: Env) => [...env.timers.values()].map((x) => x.ms).filter((ms) => ms === 480 || ms === 520);

test("the rail's Browser stands at once and leaves at once, from any area", async () => {
  await withBrowser(async (mb, env) => {
    env.lastView = "clouds";
    env.state.view = "tasks";
    mb.openMemoryBrowserArea(RECT);
    assert.deepStrictEqual(env.state, { view: "clouds", browser: "nav" });
    // the stage mounts the last vault view; the browser stands with it, no grow from the button
    const root = mounted(mb, { showMemory: () => false });
    assert.ok(
      ["is-on", "is-grow", "is-nav"].every((c) => root.classes.has(c)),
      root.className
    );
    assert.strictEqual(root.vars.get("--ct"), undefined);
    assert.deepStrictEqual(growTimers(env), []);
    // another area: closed before the stage swaps, without the shrink
    const order: string[] = [];
    assert.strictEqual(
      mb.closeMemoryBrowser(() => order.push("after")),
      true
    );
    assert.deepStrictEqual(order, ["after"]);
    assert.ok(!root.classes.has("is-on"));
    assert.strictEqual(env.state.browser, null);
  });
  await withBrowser(async (mb, env) => {
    // already in a vault view: the same plain switch
    const root = mounted(mb, { showMemory: () => false });
    mb.openMemoryBrowserArea(RECT);
    assert.ok(root.classes.has("is-on") && root.classes.has("is-grow"));
    assert.strictEqual(env.state.browser, "nav");
  });
});

test("a memory link from outside shows the last vault view, glides, then grows", async () => {
  await withBrowser(async (mb, env) => {
    env.lastView = "clouds";
    env.state.view = "tasks";
    mb.openMemoryBrowser("all", "full", RECT);
    assert.deepStrictEqual(env.state, { view: "clouds", browser: null });
    const calls: string[] = [];
    let stands = () => {},
      landed = () => {};
    const root = mounted(mb, {
      showMemory: (id, done) => {
        calls.push(`show ${id}`);
        landed = done!;
        return true;
      },
      ready: (cb) => {
        calls.push("ready");
        stands = cb;
      },
    });
    await settle();
    assert.deepStrictEqual(calls, ["ready"]);
    assert.ok(!root.classes.has("is-on"), "no window while the view still enters");
    stands();
    assert.deepStrictEqual(calls, ["ready", "show full"]);
    assert.ok(!root.classes.has("is-on"), "no window while the view glides");
    assert.strictEqual(env.state.browser, null);
    landed();
    assert.strictEqual(env.state.browser, "vault");
    assert.ok(root.classes.has("is-on"));
    assert.strictEqual(root.vars.get("--op"), "1", "grows out of the clicked spot");
    assert.ok(!root.classes.has("is-grow"), "the grow runs (next frame), it does not stand at once");
  });
  await withBrowser(async (mb, env) => {
    // a memory the view cannot show: no glide, the window grows once the view stands
    env.state.view = "tasks";
    mb.openMemoryBrowser("all", "unknown-id", RECT);
    let stands = () => {};
    const calls: string[] = [];
    const root = mounted(mb, {
      showMemory: (id) => (calls.push(id), true),
      ready: (cb) => (stands = cb),
    });
    await settle();
    assert.ok(!root.classes.has("is-on"));
    stands();
    assert.deepStrictEqual(calls, []);
    assert.ok(root.classes.has("is-on"));
    assert.strictEqual(env.state.browser, "vault");
  });
});

test("Escape during a linked memory's flight cancels the browser opening", async () => {
  await withBrowser(async (mb, env) => {
    env.lastView = "mindspace";
    env.state.view = "tasks";
    mb.openMemoryBrowser("all", "full", RECT);
    let landed: (() => void) | undefined;
    const root = mounted(mb, {
      showMemory: (_id, done) => {
        landed = done;
        return true;
      },
    });
    await settle();
    assert.ok(landed, "flight has started");
    env.keydown({ key: "Escape" });
    landed();
    assert.equal(env.state.browser, null);
    assert.ok(!root.classes.has("is-on"));
  });
});
