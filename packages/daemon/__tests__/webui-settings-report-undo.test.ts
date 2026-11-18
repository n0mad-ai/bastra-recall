// N13 (Daniel 18.11.2026): the undo window for deleted task reports is a setting of its own,
// tasks.reportUndo — in the registry (bastra config set and the web UI read it from there), in the
// Tasks group of the web UI with a pick list (off, minutes, hours, days) and a custom value, and
// worded in English and German.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { settingEntries } from "../src/settings-registry.js";

const strings = async (lang: string): Promise<Record<string, string>> =>
  runInNewContext(
    `(${(await readFile(new URL(`../webui/app/js/i18n/settings-${lang}.js`, import.meta.url), "utf8"))
      .replace(/^export default\s*/m, "")
      .replace(/;\s*$/, "")})`,
    {}
  );

async function model() {
  const source = await readFile(new URL("../webui/app/js/sections/settings-model.js", import.meta.url), "utf8");
  return runInNewContext(
    source
      .replace(/^import .*;$/gm, "")
      .replace(/^export /gm, "")
      .replace(/^\{ state \};$/gm, "") + "\n({ GROUPS, OPTIONS, store, groupKeys, cliOf })",
    { state: {}, setState() {}, setBackdrop() {}, t: (key: string) => key }
  );
}

test("N13: tasks.reportUndo is a registry setting the CLI and the web UI share", () => {
  const e = settingEntries().find((x) => x.key === "tasks.reportUndo");
  assert.ok(e, "in the registry");
  assert.equal(e.kind, "string");
  assert.equal(e.area, "tasks");
  assert.equal(e.default, "10m");
  assert.ok(!e.readonly && !e.restartRequired, "changeable, no restart needed");
});

test("N13: the Tasks group offers off, minutes, hours and days plus a custom value, in English and German", async () => {
  const m = await model();
  m.store.model = { entries: settingEntries().map((x) => ({ key: x.key })) };
  const tasks = m.GROUPS.find((g: { id: string }) => g.id === "tasks");
  assert.ok(m.groupKeys(tasks).includes("tasks.reportUndo"));
  const opts = m.OPTIONS["tasks.reportUndo"];
  assert.equal(opts.vals.map((o: { v: string }) => o.v).join(), "off,10m,1h,1d,7d,30d");
  assert.equal(opts.custom, true);
  const [en, de] = await Promise.all([strings("en"), strings("de")]);
  for (const dict of [en, de]) {
    assert.ok(dict["st.k.tasks.reportUndo"] && dict["st.k.tasks.reportUndo.d"]);
    for (const { v } of opts.vals) assert.ok(dict[`st.o.tasks.reportUndo.${v}`], `label for ${v}`);
  }
  assert.notEqual(en["st.k.tasks.reportUndo"], de["st.k.tasks.reportUndo"]);
  assert.equal(m.cliOf({ key: "tasks.reportUndo" }, "2h"), "bastra config set tasks.reportUndo 2h");
});
