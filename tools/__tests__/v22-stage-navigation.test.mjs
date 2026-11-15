import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function fixture() {
  const source = await readFile(new URL("../../packages/daemon/webui/v22/js/stage.js", import.meta.url), "utf8");
  const state = { view: "ring" },
    mounted = [],
    callbacks = [];
  let open = true,
    calls = 0,
    reentered = false;
  const element = () => ({ append() {} });
  const context = vm.createContext({
    state,
    VAULT_VIEWS: ["ring", "mindspace"],
    h: element,
    clear() {},
    t: (s) => s,
    viewLocked: () => false,
    getArea: (id) => ({
      mount: () => {
        mounted.push(id);
      },
    }),
    closeMemoryBrowser: (after) => {
      if (!open) return false;
      calls++;
      // cover(false) synchronously notifies main's state subscriber.
      if (!reentered) {
        reentered = true;
        context.api.render({});
      }
      callbacks.push(after);
      return true;
    },
  });
  vm.runInContext(
    source.replace(/^import .*;\n/gm, "").replaceAll("export ", "") + ";globalThis.api = { mountStage, render };",
    context
  );
  context.api.mountStage(element());
  context.api.render({});
  return {
    state,
    mounted,
    callbacks,
    render: () => context.api.render({}),
    calls: () => calls,
    setOpen: (v) => {
      open = v;
    },
  };
}

test("closing a browser guards synchronous cover notifications before hiding", async () => {
  const f = await fixture();
  f.state.view = "tasks";
  f.render();
  assert.equal(f.calls(), 1, "one hide, even if cover notifies synchronously");
  f.setOpen(false);
  f.callbacks.shift()();
  assert.deepEqual(f.mounted, ["ring", "tasks"]);
});

test("reopening the host view cancels a pending departure without blocking later navigation", async () => {
  const f = await fixture();
  f.state.view = "tasks";
  f.render();
  f.state.view = "ring";
  f.render();
  f.callbacks.length = 0; // browser show() cancelled its shrink timeout
  f.state.view = "dashboard";
  f.render();
  assert.equal(f.calls(), 2, "a new departure is allowed after reopening");
  f.setOpen(false);
  f.callbacks.shift()();
  assert.deepEqual(f.mounted, ["ring", "dashboard"]);
});

test("leaving a vault without an open browser does not leave a closing guard", async () => {
  const f = await fixture();
  f.setOpen(false);
  f.state.view = "settings";
  f.render();
  f.state.view = "dashboard";
  f.render();
  assert.deepEqual(f.mounted, ["ring", "settings", "dashboard"]);
});
