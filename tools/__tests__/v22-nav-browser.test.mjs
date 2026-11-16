import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The rail marks for Vault and Browser (js/nav.js railMarks, Daniel 16.11.2026).
async function railMarks() {
  const source = await readFile(new URL("../../packages/daemon/webui/v22/js/nav.js", import.meta.url), "utf8");
  const context = vm.createContext({ VAULT_VIEWS: ["ring", "mindspace"], document: { addEventListener() {} } });
  vm.runInContext(
    source.replace(/^import [\s\S]*?;\n/gm, "").replaceAll("export ", "") + ";globalThis.railMarks = railMarks;",
    context
  );
  return (view, browser) => ({ ...context.railMarks(view, browser) });
}

test("opened from the rail, only Browser is lit", async () => {
  const marks = await railMarks();
  assert.deepEqual(marks("ring", "nav"), { vault: false, browser: "on" });
  // the mark is right at the click, before the vault view underneath is mounted
  assert.deepEqual(marks("dashboard", "nav"), { vault: false, browser: "on" });
});

test("opened from a vault view, Vault stays lit and Browser gets the second mark", async () => {
  const marks = await railMarks();
  assert.deepEqual(marks("mindspace", "vault"), { vault: true, browser: "sub" });
});

test("without an open browser only the area is lit", async () => {
  const marks = await railMarks();
  assert.deepEqual(marks("ring", null), { vault: true, browser: null });
  assert.deepEqual(marks("tasks", null), { vault: false, browser: null });
  // a layer whose vault view is being left does not keep a mark on another area
  assert.deepEqual(marks("tasks", "vault"), { vault: false, browser: null });
});
