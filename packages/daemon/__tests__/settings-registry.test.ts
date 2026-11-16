import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  settingEntries,
  parseSettingValue,
  parseStoredSettings,
  applySettingChanges,
} from "../src/settings-registry.js";
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

test("resetting one field keeps the other stored settings of its group, including consent (#1582)", () => {
  const current = parseStoredSettings({
    ui: { enabled: true, backdrop: "aurora", backdropDim: 60 },
    tasks: { enabled: false, notifications: false, chatActiveMinutes: 45, chatConsent: "accepted" },
    sharedRecall: { enabled: true, language: "de", live: true },
  });
  const next = applySettingChanges(current, {
    "ui.enabled": null,
    "tasks.enabled": null,
    "sharedRecall.enabled": null,
  });
  assert.deepEqual(next.ui, { backdrop: "aurora", backdropDim: 60 });
  assert.deepEqual(next.tasks, { notifications: false, chatActiveMinutes: 45, chatConsent: "accepted" });
  assert.deepEqual(next.sharedRecall, { language: "de", live: true });
  // What is stored this way also survives the next read.
  assert.deepEqual(parseStoredSettings(JSON.parse(JSON.stringify(next))), next);
});

test("a stored block without its switch keeps its other settings on read (#1582)", () => {
  const settings = parseStoredSettings({
    ui: { backdrop: "aurora" },
    tasks: { chatConsent: "declined" },
    sharedRecall: { language: "de" },
  });
  assert.deepEqual(settings.ui, { backdrop: "aurora" });
  assert.deepEqual(settings.tasks, { chatConsent: "declined" });
  assert.deepEqual(settings.sharedRecall, { language: "de" });
});

test("no reset silently drops other stored settings of the group (#1582)", () => {
  const experiment = { name: "x", arms: ["a", "b"], registration: "r", registration_version: 1 };
  const current = parseStoredSettings({ experiment });
  // An atomic block cannot lose one of its parts: the reset is refused instead of dropping the rest.
  assert.throws(() => applySettingChanges(current, { "experiment.name": null }), /Incomplete settings block/);
  // Resetting all of its parts together still clears it.
  const cleared = applySettingChanges(current, {
    "experiment.name": null,
    "experiment.arms": null,
    "experiment.registration": null,
    "experiment.registration_version": null,
  });
  assert.equal(cleared.experiment, undefined);
});

test("a required field only makes sense without a usable default or as the only field of its group", () => {
  for (const entry of settingEntries().filter((e) => e.required)) {
    const siblings = settingEntries().filter((e) => e.path[0] === entry.path[0]).length;
    const usableDefault = entry.schema.safeParse(entry.default).success;
    assert.ok(siblings === 1 || !usableDefault, `${entry.key} has a usable default and must not be required`);
  }
});

test("saving another value of a group does not store the default of its switch (#1576)", async () => {
  const current = parseStoredSettings({});
  // Runs on every platform: the getter default of ui.enabled (webUiOnByDefault) differs by platform,
  // but in no case may it be written into the file.
  const next = applySettingChanges(current, {
    "ui.backdrop": "aurora",
    "tasks.notifications": false,
    "sharedRecall.live": true,
  });
  assert.deepEqual(next.ui, { backdrop: "aurora" });
  assert.deepEqual(next.tasks, { notifications: false });
  assert.deepEqual(next.sharedRecall, { live: true });
  // An explicit value keeps winning over the default.
  const explicit = applySettingChanges(current, { "ui.enabled": true, "ui.backdrop": "aurora" });
  assert.equal(explicit.ui?.enabled, true);
  // End to end: the saved backdrop survives a read, still without ui.enabled.
  const path = join(await mkdtemp(join(tmpdir(), "settings-ui-default-")), "cli-settings.json");
  await mutateSettings(path, (s) => applySettingChanges(s, { "ui.backdrop": "aurora" }));
  const stored = await readSettings(path);
  assert.equal(stored.ui?.backdrop, "aurora");
  assert.equal(stored.ui?.enabled, undefined);
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
