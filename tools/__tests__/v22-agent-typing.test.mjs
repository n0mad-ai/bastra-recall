import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function fixture() {
  const source = await readFile(new URL("../../packages/daemon/webui/v22/js/agent.js", import.meta.url), "utf8");
  const timers = new Map(), replies = [], navigation = []; let next = 1;
  const ctx = vm.createContext({
    setInterval: (fn) => { const id = next++; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    chat: () => new Promise((resolve) => replies.push(resolve)),
    VAULT_VIEWS: ["mindspace", "chronos"], pickVaultView: (id) => navigation.push(id), getArea: (id) => id === "tasks" ? { kind: "view" } : null,
    setState: (patch) => { if (patch.view) navigation.push(patch.view); }, render: () => {}, storeConv: () => {}, t: (s) => s, state: { view: "mindspace" }, LANG: "de",
  });
  const functions = source.slice(source.indexOf("export function ask("), source.indexOf("/** Answer text as safe DOM"));
  vm.runInContext(`let typeTimer = 0, convs; const chatState = { msgs: [], history: [], seq: 0 }; ${functions.replace("export ", "")} globalThis.api = { ask, typeOut, chatState };`, ctx);
  return { ...ctx.api, timers, replies, navigation, tick: () => { for (const fn of [...timers.values()]) fn(); } };
}

test("typing replaces prior animation and every timer terminates", async () => {
  const f = await fixture();
  f.typeOut({ a: "long first answer", sources: [] }); f.typeOut({ a: "B", sources: [] });
  assert.equal(f.timers.size, 1); f.tick();
  assert.equal(f.timers.size, 0); assert.equal(f.chatState.shown.a, "B");
});

test("overlapping replies cannot start stale animations in either response order", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const f = await fixture(); f.ask("first"); f.ask("second");
    for (const i of order) { f.replies[i]({ ok: true, body: { reply: i ? "B" : "A" } }); await new Promise((r) => setImmediate(r)); }
    assert.equal(f.timers.size, 1); f.tick();
    assert.equal(f.timers.size, 0); assert.equal(f.chatState.shown.a, "B");
  }
});

test("agent wikilinks without a source element can fall back to the browser", async () => {
  const source = await readFile(new URL("../../packages/daemon/webui/v22/js/agent.js", import.meta.url), "utf8");
  const memory = { id: "linked", area: "test" }, opened = [];
  const ctx = vm.createContext({ vault: () => ({ byId: new Map([[memory.id, memory]]) }), inWindow: () => false, timeWindow: () => ({}), showInView: () => false, openMemoryBrowser: (...args) => opened.push(args) });
  const fn = source.slice(source.indexOf("function openSource("), source.indexOf("function send("));
  vm.runInContext(fn + ';openSource("linked", null);', ctx);
  assert.deepEqual(opened, [["test", "linked", undefined]]);
});


test("agent navigation uses the gated vault picker and ignores unknown area IDs", async () => {
  for (const [id, expected] of [["chronos", ["chronos"]], ["tasks", ["tasks"]], ["unknown", []]]) {
    const f = await fixture();
    f.ask("Open view");
    f.replies[0]({ ok: true, body: { reply: "Opening", navigate: id } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(f.navigation, expected);
  }
});

test("the agent's real vault picker keeps locked Pro views closed and shows the existing hint", async () => {
  const source = await readFile(new URL("../../packages/daemon/webui/v22/js/views/pro-views.js", import.meta.url), "utf8");
  const state = { view: "mindspace" }, data = { health: { pro_preview: false } };
  const context = vm.createContext({ state, data, VAULT_VIEWS: ["mindspace", "clouds", "semantic", "ring", "chronos"], t: (key) => key, setState: (patch) => Object.assign(state, patch) });
  vm.runInContext(source.replace(/^import .*;\n/gm, "").replaceAll("export ", "") + ';globalThis.pick = pickVaultView;', context);
  assert.equal(context.pick("chronos"), false);
  assert.equal(state.view, "mindspace");
  assert.equal(state.toast, "vv.proHint");
  data.health.pro_preview = true;
  assert.equal(context.pick("chronos"), true);
  assert.equal(state.view, "chronos");
});
