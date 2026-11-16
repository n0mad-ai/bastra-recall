import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { settingEntries, parseSettingValue, parseStoredSettings } from "../src/settings-registry.js";
import { readSettings, mutateSettings } from "../src/settings-file.js";
import { effectiveSetting } from "../src/settings-effective.js";
import { readSizeSettings } from "../src/file-size-check.js";

test("registry owns every CLI/UI key and validates values without secret diagnostics", () => {
  assert.ok(settingEntries().find((e) => e.key === "archive.max-item"));
  assert.ok(settingEntries().find((e) => e.key === "tasks.enabled")?.restartRequired);
  assert.equal(parseSettingValue("tasks.enabled", false), false);
  assert.throws(
    () => parseSettingValue("tasks.enabled", "secret-sentinel"),
    (error) => error instanceof Error && !error.message.includes("secret-sentinel")
  );
  assert.deepEqual(
    parseStoredSettings({ docs: { mode: "invalid", language: "DE" }, reflex: { enabled: true, maxPerTurn: 99 } }),
    { update: { mode: "notify" }, docs: { language: "de" }, reflex: { enabled: true } }
  );
});

test("settings migrate today's local JSON byte-for-byte and preserve sibling writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-db-")),
    path = join(dir, "cli-settings.json");
  const original = '{"update":{"mode":"off"},"api":{"token":"invented-token"},"docs":{"language":"de"}}\n';
  await writeFile(path, original);
  assert.equal((await readSettings(path)).api?.token, "invented-token");
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), original);
  await assert.rejects(stat(path), { code: "ENOENT" });
  await Promise.all([
    mutateSettings(path, (s) => ({ ...s, tasks: { enabled: true } })),
    mutateSettings(path, (s) => ({ ...s, telemetry: { enabled: false } })),
  ]);
  const settings = await readSettings(path);
  assert.equal(settings.tasks?.enabled, true);
  assert.equal(settings.telemetry?.enabled, false);
  assert.equal(settings.api?.token, "invented-token");
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), original);
  await mutateSettings(path, (s) => ({ ...s, size: { guide: 321 } }));
  assert.equal((await readSizeSettings(path)).guide, 321, "the stdlib hook mini-reader follows the migrated DB record");
});

test("registry presentation matches the existing defaults and special environment precedence", () => {
  const entry = (key: string) => settingEntries().find((e) => e.key === key)!;
  const settings = parseStoredSettings({ update: { mode: "auto" }, generation: { model: "stored:4b" } });
  assert.equal(entry("update.mode").env, "BASTRA_UPDATE_CHECK");
  assert.equal(entry("commons.enabled").env, undefined);
  assert.equal(effectiveSetting(entry("evidenceGate.enabled"), settings, {}).value, true);
  assert.equal(effectiveSetting(entry("update.mode"), settings, { BASTRA_UPDATE_CHECK: "on" }).value, "auto");
  assert.equal(effectiveSetting(entry("update.mode"), settings, { BASTRA_UPDATE_CHECK: "off" }).value, "off");
  assert.equal(
    effectiveSetting(entry("generation.model"), settings, {
      BASTRA_EXPAND_MODEL: "",
      BASTRA_RERANK_MODEL: "ignored:4b",
    }).value,
    "stored:4b"
  );
  assert.deepEqual(effectiveSetting(entry("tasks.enabled"), settings, { BASTRA_TASKS: "" }), {
    value: false,
    envNames: ["BASTRA_TASKS"],
  });
});

test("saving another ui.* value leaves the ui.enabled default unstored", async () => {
  const { applySettingChanges } = await import("../src/settings-registry.js");
  const current = parseStoredSettings({});
  // Runs on every platform: the getter default (webUiOnByDefault) differs by
  // platform, but in no case may it be written into the file.
  const next = applySettingChanges(current, { "ui.backdrop": "aurora" });
  assert.equal(next.ui?.backdrop, "aurora");
  assert.equal(next.ui?.enabled, undefined, "a plain default must not become a stored choice");
  // An explicit ui.enabled keeps winning over the platform default.
  const explicit = applySettingChanges(current, { "ui.enabled": true, "ui.backdrop": "aurora" });
  assert.equal(explicit.ui?.enabled, true);
  // End to end: the saved backdrop survives a read, still without ui.enabled.
  const path = join(await mkdtemp(join(tmpdir(), "settings-ui-default-")), "cli-settings.json");
  await mutateSettings(path, (s) => applySettingChanges(s, { "ui.backdrop": "aurora" }));
  const stored = await readSettings(path);
  assert.equal(stored.ui?.backdrop, "aurora");
  assert.equal(stored.ui?.enabled, undefined);
});
