import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTERS } from "../src/cli/registry.js";
import { cmdStatus } from "../src/cli/status.js";
import { settingsFilePath } from "../src/settings.js";
import { writeSettingsFixture } from "./fixtures/settings-db.js";

async function statusOutput(json = false): Promise<string> {
  const write = process.stdout.write;
  let text = "";
  process.stdout.write = ((chunk: Buffer | string, ...args: unknown[]) => {
    if (typeof chunk !== "string") return Reflect.apply(write, process.stdout, [chunk, ...args]);
    text += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    await cmdStatus({ json });
    return text;
  } finally {
    process.stdout.write = write;
  }
}

test("status keeps its JSON bytes in English when the same adapter status is shown in German", async (t) => {
  // Exercise the real Cursor adapter without invoking any local assistant binary.
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (name !== "cursor")
      t.mock.method(adapter, "doctor", async () => ({ status: "missing", message: "not configured" }));
  }
  const settingsPath = settingsFilePath();
  await writeSettingsFixture(settingsPath, JSON.stringify({ language: { primary: "en" } }));
  const english = await statusOutput(true);
  assert.ok(english.endsWith("\n"));
  assert.ok(english.includes('"message": "not registered with Cursor"'));
  await writeSettingsFixture(settingsPath, JSON.stringify({ language: { primary: "de" } }));
  assert.equal(await statusOutput(true), english);
  const screen = await statusOutput();
  assert.match(screen, /cursor +[^\n]*bei Cursor nicht registriert/);
  assert.doesNotMatch(screen, /not registered with Cursor/);
});

test("the installer and remover can render adapter messages in German", async () => {
  const cursor = ADAPTERS.cursor;
  const expected = "Datei mit der Konfiguration fehlt";
  assert.equal((await cursor.uninstall({ dryRun: true }, "de")).message, expected);
  assert.equal((await cursor.uninstall({ dryRun: true })).message, "config file doesn't exist");
  const vaultPath = process.env.BASTRA_TEST_RUN_ROOT!;
  const install = await cursor.install({ dryRun: true, vaultPath }, "de");
  assert.equal(install.status, "would-install");
  assert.match(install.message, /würde 'bastra-recall' registrieren/);
});
