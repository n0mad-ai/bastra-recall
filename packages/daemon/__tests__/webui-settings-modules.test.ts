// Characterize the real browser module graph, including both directions of the settings cycle.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const lang of ["en", "de"]) {
  test(`web UI settings real module initialization and display (${lang})`, () => {
    const settings = new URL("../webui/app/js/sections/settings.js", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      globalThis.document = { dispatchEvent() {}, addEventListener() {}, documentElement: { dataset: { lang: ${JSON.stringify(lang)} } } };
      globalThis.window = { innerWidth: 1440, innerHeight: 900 };
      globalThis.requestAnimationFrame = () => 1;
      globalThis.localStorage = { getItem: () => null };
      globalThis.fetch = () => { throw new Error("module initialization must not request data"); };
      const settings = await import(${JSON.stringify(settings)});
      const panel = await import(new URL("settings-panel.js", ${JSON.stringify(settings)}));
      const { getArea } = await import(new URL("../areas.js", ${JSON.stringify(settings)}));
      const { t } = await import(new URL("../i18n.js", ${JSON.stringify(settings)}));
      const entry = { key: "unknown", label: "Server label" };
      assert.equal(settings.nameOf(entry), "Server label");
      assert.equal(settings.nameOf({ key: "unknown" }), "unknown");
      assert.equal(settings.descOf(entry), "");
      assert.equal(settings.tx("missing", "fallback"), "fallback");
      assert.equal(settings.nameOf({ key: "logs.retention" }), t("st.k.logs.retention"));
      assert.equal(settings.groupTitle({ id: "logs" }), t("st.g.logs"));
      for (const value of [null, undefined]) assert.equal(settings.fmt(entry, value), t("st.v.default"));
      assert.equal(settings.fmt({ secret: true }, null), t("st.v.default"));
      assert.equal(settings.fmt({ secret: true }, "secret"), "••••••••");
      assert.equal(settings.fmt(entry, true), t("st.v.on"));
      assert.equal(settings.fmt(entry, false), t("st.v.off"));
      assert.equal(settings.fmt(entry, []), t("st.v.none"));
      assert.equal(settings.fmt(entry, ["a", "b"]), "a, b");
      assert.equal(settings.fmt(entry, { a: 1 }), '{"a":1}');
      assert.equal(settings.fmt(entry, ""), "—");
      assert.equal(settings.fmt(entry, 0), "0");
      assert.equal(getArea("settings").tabs[0].render, panel.findTab);
      assert.equal(getArea("settings").tabs[1].render, panel.changesTab);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
