// The daemon.env field of the settings area: the real settings-model.js and the
// secret control of settings.js run together in one VM context with a fake h().
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
  const session = await readFile(new URL("../session-client.js", dir), "utf8");
  const model = await readFile(new URL("settings-model.js", dir), "utf8");
  const view = await readFile(new URL("settings.js", dir), "utf8");
  const panel = await readFile(new URL("settings-panel.js", dir), "utf8");
  const writes: unknown[] = [];
  const events: string[] = [];
  const document = { activeElement: null as unknown };
  const env = { key: "daemon.env", kind: "json", secret: true, isSet: true, envOverride: [], restartRequired: true };
  const ctx = runInNewContext(
    `${strip(session)}\n${strip(model)}\n${strip(view)}\n${strip(panel)}\n({ store, onStore, apply, secretCtl, mount, changesTab })`,
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
        return { ok: true, json: async () => ({ entries: [env] }) };
      },
    }
  );
  ctx.store.model = { entries: [env] };
  ctx.onStore((what: string) => events.push(what));
  const mount = () => {
    const ctl = ctx.secretCtl(env);
    const input = ctl.nodes[1];
    input.focus = () => (document.activeElement = input);
    const type = (text: string) => {
      input.value = text;
      for (const fn of input.listeners.input) fn();
      ctl.sync();
    };
    return { ctl, input, type };
  };
  return { ...ctx, writes, events, document, mount, mountArea: ctx.mount };
}

test("web UI settings: invalid daemon.env JSON blocks Apply, keeps the visible text and saves only the corrected value", async () => {
  const f = await field();
  let { ctl, input, type } = f.mount();
  type('{"A":"earlier"}');
  type('{"A":"visible"');
  assert.ok(input.classList.contains("is-bad"));
  await f.apply();
  assert.deepEqual(f.writes, [], "the earlier valid draft must not be saved behind the visible text");
  assert.equal(f.store.error, "st.json.invalid");
  assert.equal(f.events.at(-1), "invalid");
  ctl.focus();
  assert.equal(f.document.activeElement, input, "the field can take the focus the view gives it");
  // A rebuild of the rows (any full refresh) keeps the invalid text in the field.
  f.document.activeElement = null;
  ({ ctl, input, type } = f.mount());
  ctl.sync();
  assert.equal(input.value, '{"A":"visible"');
  assert.ok(input.classList.contains("is-bad"));
  type('{"A":"visible"}');
  assert.ok(!input.classList.contains("is-bad"));
  await f.apply();
  assert.deepEqual(f.writes, [{ changes: { "daemon.env": { A: "visible" } } }]);
  assert.equal(f.store.error, "");
});

test("web UI settings: clearing an invalid daemon.env draft drops it and unblocks Apply", async () => {
  const f = await field();
  const { type } = f.mount();
  type("{");
  assert.equal(f.store.invalid.size, 1);
  type("");
  assert.equal(f.store.invalid.size, 0);
  assert.equal(f.store.changes.size, 0);
});

test("web UI settings: an invalid-only JSON draft is visible and discardable from Changes", async () => {
  const f = await field();
  const frame = h("main", null);
  const section = Object.assign(h("div", null), { closest: () => frame, parentElement: frame });
  f.mountArea(section, { refreshLens() {} });
  const panel = h("aside", null);
  f.changesTab(panel);
  f.store.savedRestart = true;
  f.store.model.restartAvailable = true;
  const input = section.find("st-text--secret")[0];
  input.focus = () => (f.document.activeElement = input);
  input.value = "{invalid-secret";
  f.document.activeElement = input;
  input.listeners.input[0]();

  const bar = frame.find("st-bar")[0];

  assert.equal(bar.hidden, false);
  assert.equal(bar.find("st-btn--go")[0].textContent, "st.apply");
  assert.match(panel.textContent, /st\.ch\.unsaved/);
  assert.doesNotMatch(panel.textContent, /invalid-secret/);
  f.document.activeElement = null;
  await bar.find("st-btn--go")[0].click();
  assert.equal(f.document.activeElement, input);
  assert.match(bar.textContent, /st\.saveErr/);
  assert.deepEqual(f.writes, []);
  const discardButton = panel.find("st-btn--mute").find((node) => node.textContent === "st.discard")!;
  await discardButton.click();
  assert.equal(f.store.invalid.size, 0);
  assert.equal(f.store.error, "");
  assert.match(panel.textContent, /st\.ch\.allSaved/);
});
