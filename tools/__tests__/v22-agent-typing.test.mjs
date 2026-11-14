import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function fixture() {
  const source = await readFile(new URL("../../packages/daemon/webui/v22/js/agent.js", import.meta.url), "utf8");
  const timers = new Map(), replies = []; let next = 1;
  const ctx = vm.createContext({
    setInterval: (fn) => { const id = next++; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    chat: () => new Promise((resolve) => replies.push(resolve)),
    setState: () => {}, render: () => {}, storeConv: () => {}, t: (s) => s, state: { view: "mindspace" }, LANG: "de",
  });
  const functions = source.slice(source.indexOf("export function ask("), source.indexOf("/** Answer text as safe DOM"));
  vm.runInContext(`let typeTimer = 0, convs; const chatState = { msgs: [], history: [], seq: 0 }; ${functions.replace("export ", "")} globalThis.api = { ask, typeOut, chatState };`, ctx);
  return { ...ctx.api, timers, replies, tick: () => { for (const fn of [...timers.values()]) fn(); } };
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
