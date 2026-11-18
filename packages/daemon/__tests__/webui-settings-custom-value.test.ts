// The "Custom value …" field of a settings pick list: the real settings-model.js
// and the select control of settings.js run together in one VM context with a fake h().
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { h, Node_ } from "./webui-report-dom.js";

const strip = (src: string) =>
  src
    .replace(/^import [\s\S]*?;$/gm, "")
    .replace(/^export \{[^}]*\};$/gm, "")
    .replace(/^export /gm, "");

async function field() {
  const dir = new URL("../webui/app/js/sections/", import.meta.url);
  const model = await readFile(new URL("settings-model.js", dir), "utf8");
  const view = await readFile(new URL("settings.js", dir), "utf8");
  const panel = await readFile(new URL("settings-panel.js", dir), "utf8");
  const writes: unknown[] = [];
  const events: string[] = [];
  const document = { activeElement: null as unknown };
  const guide = { key: "size.guide", kind: "number", default: 500, value: 500, isSet: false, envOverride: [] };
  const ctx = runInNewContext(
    `${strip(model)}\n${strip(view)}\n${strip(panel)}\n({ store, onStore, apply, restart, selectCtl, changeList, invalidText: typeof invalidText === "undefined" ? undefined : invalidText })`,
    {
      document,
      h,
      clear: (el: Node_) => (el.replaceChildren(), el),
      data: { clusters: [] },
      hud: () => h("div", null),
      hudRow() {},
      hudChip() {},
      hudButton() {},
      hudTiles: () => h("div", null),
      onData: () => () => {},
      loadingBlock() {},
      loadingInline() {},
      t: (key: string) => key,
      state: {},
      setState() {},
      setBackdrop() {},
      addStrings() {},
      registerArea() {},
      ICON: {},
      en: {},
      de: {},
      fetch: async (path: string, options: any = {}) => {
        if (path.endsWith("/session")) return { ok: true, json: async () => ({ csrf: "fixture" }) };
        if (options.body) writes.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ entries: [guide] }) };
      },
    }
  );
  ctx.store.model = { entries: [guide], restartAvailable: true };
  ctx.onStore((what: string) => events.push(what));
  const mount = () => {
    const ctl = ctx.selectCtl(guide);
    const sel = ctl.nodes[0].children[0];
    const input = ctl.nodes[1];
    input.focus = () => (document.activeElement = input);
    const pick = (value: string) => {
      sel.value = value;
      for (const fn of sel.listeners.change) fn();
      ctl.sync();
    };
    const type = (text: string) => {
      input.value = text;
      for (const fn of input.listeners.input) fn();
      ctl.sync();
    };
    ctl.sync();
    return { ctl, sel, input, pick, type };
  };
  return { ...ctx, writes, events, document, mount };
}

test("web UI settings: an invalid custom number blocks Apply and restart instead of saving the earlier value", async () => {
  const f = await field();
  let { ctl, input, pick, type } = f.mount();
  pick("custom");
  type("700");
  type("abc");
  assert.ok(input.classList.contains("is-bad"));
  await f.apply();
  assert.deepEqual(f.writes, [], "the earlier valid custom value must not be saved behind the visible text");
  assert.equal(f.store.error, "st.value.invalid");
  assert.equal(f.events.at(-1), "invalid");
  await f.restart();
  assert.deepEqual(f.writes, [], "restart stays blocked as well");
  assert.equal(f.store.restarting, false);
  assert.equal(f.changeList()[0].invalid, true, "the Changes tab lists the field as not saved");
  assert.equal(f.invalidText("size.guide", true), "st.value.invalidShort");
  ctl.focus();
  assert.equal(f.document.activeElement, input, "the field can take the focus the view gives it");
  // A rebuild of the rows (any full refresh) keeps the invalid text in the custom field.
  f.document.activeElement = null;
  ({ ctl, input, pick, type } = f.mount());
  assert.equal(input.hidden, false);
  assert.equal(input.value, "abc");
  assert.ok(input.classList.contains("is-bad"));
  type("50");
  assert.ok(input.classList.contains("is-bad"), "a number below the minimum is invalid too");
  type("800");
  assert.ok(!input.classList.contains("is-bad"));
  await f.apply();
  assert.deepEqual(f.writes, [{ changes: { "size.guide": 800 } }]);
  assert.equal(f.store.error, "");
});

test("web UI settings: picking a list value or clearing the field drops an invalid custom draft", async () => {
  const f = await field();
  const { pick, type } = f.mount();
  pick("custom");
  type("x");
  assert.equal(f.store.invalid.size, 1);
  type("");
  assert.equal(f.store.invalid.size, 0);
  type("y");
  assert.equal(f.store.invalid.size, 1);
  pick("0");
  assert.equal(f.store.invalid.size, 0);
  assert.equal(f.store.changes.get("size.guide"), 200);
});
