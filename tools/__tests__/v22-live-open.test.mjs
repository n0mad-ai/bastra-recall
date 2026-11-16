import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// A click in the Live list opens the memory in the vault view AND in the memory
// browser (js/views/live-tab.js openEvent, Daniel 16.11.2026); the browser
// switches in place when it already stands (js/views/memory-browser.js).
const src = (p) => readFile(new URL(`../../packages/daemon/webui/v22/js/${p}`, import.meta.url), "utf8");
const strip = (s) => s.replace(/^import [\s\S]*?;\n/gm, "").replaceAll("export ", "");

async function liveTab({ known = [], afterReload = [] } = {}) {
  const calls = [];
  let ids = new Set(known);
  const byId = () => new Map([...ids].map((id) => [id, { id, area: `area-${id}` }]));
  const context = vm.createContext({
    window: {},
    state: { live: true },
    addStrings() {},
    en: {},
    de: {},
    createFeed: () => ({ events: [] }),
    onUpdates() {},
    t: (k) => k,
    vault: () => ({ byId: byId() }),
    loadGraph: async () => {
      calls.push(["loadGraph"]);
      ids = new Set([...ids, ...afterReload]);
    },
    showInView: (id) => calls.push(["showInView", id]),
    openMemoryBrowser: (...a) => calls.push(["openMemoryBrowser", ...a]),
    setState: (p) => calls.push(["setState", p]),
  });
  vm.runInContext(strip(await src("views/live-tab.js")) + ";globalThis.openEvent = openEvent;", context);
  const rect = { left: 1, top: 2, right: 3, bottom: 4 };
  const click = (e) => context.openEvent(e, { currentTarget: { getBoundingClientRect: () => rect } });
  return { calls, click, rect };
}

test("a known memory focuses in the vault view and opens in the browser from the clicked row", async () => {
  const { calls, click, rect } = await liveTab({ known: ["b"] });
  await click({ id: "b", kind: "read" });
  assert.deepEqual(calls, [
    ["showInView", "b"],
    ["openMemoryBrowser", "area-b", "b", rect],
  ]);
});

test("a memory the graph does not know yet waits for the fresh graph", async () => {
  const { calls, click } = await liveTab({ afterReload: ["n"] });
  await click({ id: "n", kind: "add" });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["loadGraph", "showInView", "openMemoryBrowser"]
  );
});

test("a memory that is gone gives a notice, no empty browser", async () => {
  const { calls, click } = await liveTab();
  await click({ id: "x", kind: "change" });
  // the patch object comes from the vm realm: compare its plain shape
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["loadGraph"], ["setState", { toast: "live.gone" }]]);
});

test("a delete entry opens nothing", async () => {
  const { calls, click } = await liveTab({ known: ["d"] });
  await click({ id: "d", kind: "delete" });
  assert.deepEqual(calls, []);
});

async function browser(start) {
  const shows = [];
  const context = vm.createContext({
    state: { browser: start.browser },
    setState(p) {
      Object.assign(context.state, p);
    },
    addStrings() {},
    en: {},
    de: {},
    detailCache: () => ({}),
    viewLocked: () => false,
    lastVaultView: () => "ring",
    lastPress: () => null,
  });
  vm.runInContext(
    strip(await src("views/memory-browser.js")) +
      ";globalThis.api = { openMemoryBrowser, M, setInst: (x) => (inst = x) };",
    context
  );
  Object.assign(context.api.M, start.M);
  context.api.setInst({ view: "ring", show: (anim) => shows.push(anim) });
  return { api: context.api, state: context.state, shows };
}
const rect = { left: 10, top: 20, right: 30, bottom: 40 };

test("closed: the browser grows as a vault layer out of the given rect", async () => {
  const { api, state, shows } = await browser({ browser: null, M: { open: false } });
  api.openMemoryBrowser("work", "b", rect);
  assert.deepEqual(shows, [true]);
  assert.equal(state.browser, "vault");
  assert.deepEqual({ ...api.M.from }, rect);
  assert.equal(api.M.sel, "b");
});

for (const mode of ["vault", "nav"]) {
  test(`open as ${mode}: it keeps its mode, selects in place and drops the filters`, async () => {
    const old = { left: 0, top: 0, right: 1, bottom: 1 };
    const { api, state, shows } = await browser({
      browser: mode,
      M: { open: true, nav: mode === "nav", sel: "a", q: "foo", type: "rule", scope: "other", from: old },
    });
    api.openMemoryBrowser("work", "b", rect);
    assert.deepEqual(shows, [false]);
    assert.equal(state.browser, mode);
    assert.equal(api.M.nav, mode === "nav");
    assert.equal(api.M.sel, "b");
    assert.equal(api.M.reader, true);
    assert.deepEqual([api.M.q, api.M.type, api.M.scope], ["", "all", "work"]);
    assert.equal(api.M.from, old);
    assert.equal(api.M.grow, false);
  });
}

test("a browser still shrinking away grows again", async () => {
  const { api, state, shows } = await browser({ browser: null, M: { open: true } });
  api.openMemoryBrowser("work", "b", rect);
  assert.deepEqual(shows, [true]);
  assert.equal(state.browser, "vault");
});
